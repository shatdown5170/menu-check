// Coupang Eats 메뉴 검수 백엔드 (Cloud Run, asia-northeast3)
// 기존 Cloudflare Worker를 대체. 프론트(menu-check.html)와의 계약:
//   요청  POST /  JSON { mode:'vision', images:[base64...], mediaTypes:['image/jpeg'...] }
//   응답  200    JSON { text: "메뉴명|가격|카테고리\n..." }
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

const PROMPT = `너는 한국 식당 메뉴판 사진을 읽어 메뉴를 정리하는 OCR·분류 도우미야.
주어진 사진(들)에서 판매 메뉴 항목을 모두 추출해.

출력은 메뉴 한 개당 정확히 한 줄, 아래 형식으로만 출력해. 다른 설명·번호·머리말·코드블록 없이 줄들만 출력해:
메뉴명|가격|카테고리

규칙:
- 가격은 숫자만 적어 (쉼표·"원" 제거). 예: 12,000원 → 12000
- 싯가/시가/당일시가/시세/변동/문의/당일가 처럼 고정 가격이 없으면 가격 칸은 비워: 메뉴명||카테고리
- 카테고리는 반드시 다음 중 하나만 사용: ${CATEGORIES.join(", ")}
  · 밥류: 덮밥·비빔밥·볶음밥·공깃밥 등
  · 면류: 국수·냉면·파스타·우동·라면 등 (물회·막국수는 면류)
  · 탕찜전골: 탕·찌개·전골·찜·국 등 국물/찜 요리
  · 정육구이: 삼겹살·소고기·돼지고기 구이류
  · 해산물: 회·조개·새우·게·해물 요리 (초밥은 제외)
  · 세트코스: 세트·코스·정식·모둠·한상·스페셜
  · 초밥: 초밥·스시·오마카세
  · 주류: 소주·맥주·막걸리·와인·사케·하이볼 등 술
  · 음료: 콜라·사이다·주스·커피·에이드·생수 등
  · 일반: 위에 해당 없는 사이드/기타
- 메뉴가 아닌 텍스트(가게 이름, 주소, 전화번호, 영업시간, 안내 문구)는 제외해.
- 같은 메뉴가 여러 사진에 중복되면 한 번만 출력해.`;

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
          generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
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

    return res.json({ text });
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
