// Coupang Eats 메뉴 검수 백엔드 (Cloud Run, asia-northeast3)
// 기존 Cloudflare Worker를 대체. 프론트(menu-check.html)와의 계약:
//   요청  POST /  JSON { mode:'vision', images:[base64...], mediaTypes:['image/jpeg'...] }
//   응답  200    JSON { menu: { groups:[ { name, note, dishes:[ { name, price, priceNote, amount, serves, components[], category } ] } ] } }
//   오류         JSON { error: "..." }
import express from "express";

const app = express();

// 사진 여러 장(2000px JPEG)을 base64로 받으므로 본문 한도를 넉넉히.
app.use(express.json({ limit: "30mb" }));

// ── CORS: 프론트(GitHub Pages 등 어디서든)에서 호출 가능하도록 허용 ──
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const CATEGORIES = [
  "밥류", "면류", "탕찜전골", "정육구이", "해산물",
  "세트코스", "초밥", "주류", "음료", "일반",
];

const PROMPT = `너는 한국 식당 메뉴판 사진을 읽어 구조화하는 OCR·분류 도우미야.
주어진 사진(들)에서 판매 메뉴를 모두 추출해서 아래 JSON 형식으로만 출력해. 코드블록·설명 없이 JSON 객체 하나만.

형식:
{
  "groups": [
    {
      "name": "디쉬그룹명 또는 null",
      "note": "그룹 안내문 또는 null",
      "dishes": [
        {
          "name": "메뉴명",
          "price": 숫자 또는 null,
          "priceNote": "시가/한정/문의 등 또는 null",
          "amount": "11P / 1kg / 6마리 / 10장 등 또는 null",
          "serves": "2인기준 / 3인이상 등 또는 null",
          "components": ["구성요소", ...],
          "category": "문제유형"
        }
      ]
    }
  ]
}

규칙:
1. 디쉬그룹: 메뉴판에 '모듬메뉴','한가지메뉴','참치메뉴'처럼 여러 메뉴를 묶는 제목/구획이 있으면 그걸 groups[].name 으로 쓰고 그 아래 메뉴들을 dishes 로 넣어. 그룹 구분이 없으면 name 을 null 로 둔 단일 그룹에 모든 메뉴를 넣어.
2. ★구성요소 vs 디쉬 구분(가장 중요): 한 메뉴 아래/옆에 작은 글씨로 나열된 재료·부위 목록은, 그 각각에 개별 가격이 없으면 그 메뉴의 components 로 넣고 절대 별도 dish 로 만들지 마. 예: "참치스페셜 (배꼽살, 도로, 각종부위)" → 참치스페셜 dish 의 components=["배꼽살","도로","각종부위"]. 반대로 개별 가격이 붙어 있으면 독립 dish 로 만들어. 예: "도로 50,000" → 별도 dish. (같은 단어가 한 메뉴의 구성요소이면서 다른 곳에선 독립 디쉬일 수 있음 — 가격 유무로 판단)
3. price: 숫자만(쉼표·"원" 제거). 싯가/시가/당일시가/시세/변동/문의/한정 처럼 고정가가 없으면 price=null 로 두고 priceNote 에 그 표현을 넣어.
4. amount: 피스(11P)·중량(1kg)·개수(6마리)·장수(10장) 등 '얼마나 주는지'. serves: '2인기준','3인이상' 등 제공 인원 기준. 둘 다 있으면 각각 채워. 메뉴명에서 분리할 수 있으면 분리해(예: "장어구이 1kg" → name="장어구이", amount="1kg").
5. components: 세트·모둠·스페셜처럼 여러 구성으로 이뤄진 메뉴의 구성요소 목록(개별가격 없는 것). 단품이면 빈 배열 [].
6. 선택형 세트(예: "3가지 요리 선택"과 그 아래 선택 가능한 요리 목록)는, 선택 목록을 그 세트 dish 의 components 에 통째로 넣어. 선택지를 개별 dish 로 빼지 마.
7. category 는 반드시 다음 중 하나: ${CATEGORIES.join(", ")}.
   · 밥류:덮밥·비빔밥·볶음밥·공깃밥 / 면류:국수·냉면·파스타·우동·라면(물회·막국수 포함) / 탕찜전골:탕·찌개·전골·찜·국 / 정육구이:삼겹살·소고기·돼지고기 구이 / 해산물:회·조개·새우·게·해물(초밥 제외) / 세트코스:세트·코스·정식·모둠·한상·스페셜 / 초밥:초밥·스시·오마카세 / 주류:술 / 음료:음료 / 일반:기타
8. 메뉴가 아닌 텍스트(가게명·주소·전화·영업시간·안내문구)는 제외. 같은 메뉴가 여러 사진에 중복되면 한 번만.`;

// 헬스체크 / 안내
app.get("/", (req, res) => {
  res.json({ ok: true, service: "menu-check-server", model: GEMINI_MODEL });
});

app.post("/", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다." });
    }

    const { mode, images, mediaTypes } = req.body || {};
    if (mode !== "vision") {
      return res.status(400).json({ error: "지원하지 않는 mode 입니다. (vision 만 지원)" });
    }
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "분석할 이미지가 없습니다." });
    }

    // 프론트는 데이터 URL 접두사를 떼고 순수 base64만 보냄. 혹시 있으면 제거.
    const parts = [{ text: PROMPT }];
    images.forEach((b64, i) => {
      const data = String(b64 || "").replace(/^data:[^;]+;base64,/, "");
      const mimeType = (mediaTypes && mediaTypes[i]) || "image/jpeg";
      parts.push({ inline_data: { mime_type: mimeType, data } });
    });

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 16384,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      const msg = data?.error?.message || `Gemini 오류 (HTTP ${geminiRes.status})`;
      return res.status(geminiRes.status).json({ error: msg });
    }

    const cand = data?.candidates?.[0];
    if (cand?.finishReason === "SAFETY") {
      return res.status(400).json({ error: "안전 필터로 인해 응답이 차단되었습니다." });
    }

    const text = (cand?.content?.parts || [])
      .map((p) => p.text || "")
      .join("")
      .trim();

    if (!text) {
      return res.status(502).json({ error: "Gemini가 빈 응답을 반환했습니다." });
    }

    // responseMimeType=application/json 이므로 text 는 순수 JSON. 혹시 코드펜스가 끼면 제거.
    const jsonStr = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let menu;
    try {
      menu = JSON.parse(jsonStr);
    } catch (e) {
      console.error("JSON 파싱 실패:", jsonStr.slice(0, 500));
      return res.status(502).json({ error: "Gemini 응답을 JSON으로 해석하지 못했습니다." });
    }
    if (!menu || !Array.isArray(menu.groups)) {
      return res.status(502).json({ error: "Gemini 응답에 groups 배열이 없습니다." });
    }

    return res.json({ menu });
  } catch (e) {
    console.error("handler error:", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Cloud Run은 PORT 환경변수로 포트를 주입함 (기본 8080).
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`menu-check-server listening on :${PORT} (model: ${GEMINI_MODEL})`);
});
