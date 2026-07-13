// Coupang Eats 메뉴 검수 백엔드 (Cloud Run, asia-northeast3)
// 기존 Cloudflare Worker를 대체. 프론트(menu-check.html)와의 계약:
//   요청  POST /  JSON { mode:'vision', images:[base64...], mediaTypes:['image/jpeg'...] }
//   응답  200    JSON { menu: { groups:[ { name, note, dishes:[ { name, price, priceNote, amount, serves, components[], category } ] } ] } }
//   오류         JSON { error: "..." }
//
// ── 메뉴 설명 열람/업로드 API (menu-desc.html / menu-desc-admin.html) ──
//   GET  /menu-desc/ping    헤더 x-access-key             → { ok, role:'view'|'admin' }
//   GET  /menu-desc/data    헤더 x-access-key             → { stores:[{id,name,updatedAt,menus:[{name,desc}]}] }
//   POST /menu-desc/upload  헤더 x-access-key(관리자만)    → body { rows:[{storeId,storeName,menuName,desc}] }
//                           업로드에 포함된 스토어는 통째로 교체, 나머지는 유지.
//   저장소: Google Sheet (서비스 계정으로 읽기/쓰기)
import express from "express";
import crypto from "node:crypto";

const app = express();

// 사진 여러 장(2000px JPEG)을 base64로 받으므로 본문 한도를 넉넉히.
app.use(express.json({ limit: "30mb" }));

// ── CORS: 프론트(GitHub Pages 등 어디서든)에서 호출 가능하도록 허용 ──
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-access-key");
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
  ],
  "unreadable": [
    {
      "image": 사진번호(1부터),
      "where": "안 보이는 영역 설명 (예: 우측 하단 가격 열)",
      "reason": "잘림" | "빛번짐" | "흐림",
      "bbox": [x, y, w, h]
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
8. 메뉴가 아닌 텍스트(가게명·주소·전화·영업시간·안내문구)는 제외. 같은 메뉴가 여러 사진에 중복되면 한 번만.
9. ★판독 불가: '명백히 못 읽는 경우'에만 기록해. 즉 글자가 사진 밖으로 완전히 잘려나갔거나, 빛 반사·빛번짐·심한 흐림으로 글자 형태를 전혀 알아볼 수 없어 추측조차 불가능한 경우만 해당. 조금 흐릿하거나 비스듬해도 읽을 수 있으면 정상으로 보고 dishes 에 넣어 — 애매하면 '읽을 수 있다'로 판단(과탐지 금지). 이런 명백한 판독 불가만 dishes 에서 빼고 unreadable 에 기록해: 어느 사진(image, 1부터)의 어느 위치(where)인지, 사유(reason: 잘림/빛번짐/흐림), 가능하면 그 영역의 bbox 를 사진 크기 대비 0~1 비율 [x, y, w, h](좌상단 기준)로. bbox 를 모르면 그 항목에서 bbox 키를 빼. 같은 사진에서 같은 영역(예: 우측 가격 열 전체)은 행마다 쪼개지 말고 하나의 항목으로 묶고 bbox 도 그 영역 전체를 덮게 보고해. 의심스러운 정도면 unreadable 에 넣지 말고, 전부 읽을 수 있으면 빈 배열 [].`;

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
            // maxOutputTokens 는 thinking + 실제 출력 토큰의 합산 한도다.
            // 2.5-flash 는 thinking 이 출력 예산을 잠식하므로 한도를 크게 두고
            // thinkingBudget 으로 사고량을 제한해 JSON 출력 공간을 확보한다.
            maxOutputTokens: 32768,
            thinkingConfig: { thinkingBudget: 6144 },
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

    // 출력이 토큰 한도로 잘린 경우: JSON 이 불완전하므로 명확히 안내
    if (cand?.finishReason === "MAX_TOKENS") {
      console.error("MAX_TOKENS 잘림 usage=", JSON.stringify(data?.usageMetadata));
      return res.status(502).json({
        error: "메뉴 양이 많아 한 번에 처리할 수 있는 한도를 넘었어요. 사진을 더 적게(예: 3~4장씩) 나눠서 올려주세요.",
      });
    }

    if (!text) {
      return res.status(502).json({ error: "Gemini가 빈 응답을 반환했습니다." });
    }

    // responseMimeType=application/json 이므로 text 는 순수 JSON. 혹시 코드펜스가 끼면 제거.
    const jsonStr = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let menu;
    try {
      menu = JSON.parse(jsonStr);
    } catch (e) {
      console.error("JSON 파싱 실패 finishReason=", cand?.finishReason, "len=", jsonStr.length, "tail=", jsonStr.slice(-200));
      return res.status(502).json({ error: "Gemini 응답을 JSON으로 해석하지 못했습니다. 사진을 더 적게 나눠 올려주세요." });
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

// ════════════════════════════════════════════════════════════════════
// 메뉴 설명 열람/업로드 API
// ════════════════════════════════════════════════════════════════════

const MENU_DESC_SHEET_ID = process.env.MENU_DESC_SHEET_ID; // 구글 시트 URL의 /d/{이 부분}/
const MENU_DESC_SHEET_NAME = process.env.MENU_DESC_SHEET_NAME || "메뉴설명";
const MENU_DESC_VIEW_KEY = process.env.MENU_DESC_VIEW_KEY;   // 세일즈 열람용 비밀번호
const MENU_DESC_ADMIN_KEY = process.env.MENU_DESC_ADMIN_KEY; // 업로드(관리자)용 비밀번호

// 시트 컬럼: A 스토어ID | B 스토어명 | C 구분 | D 이름 | E 설명 | F 업로드일시
//   구분 = 소개(스토어 소개문) | 그룹(디쉬그룹명+설명) | 메뉴(디쉬명+설명)
//   행 순서가 곧 표시 순서. '메뉴' 행은 바로 위의 '그룹' 행에 속함.
const SHEET_HEADER = ["스토어ID", "스토어명", "구분", "이름", "설명", "업로드일시"];
const ROW_KINDS = new Set(["소개", "그룹", "메뉴"]);

// ── 서비스 계정 JWT → 액세스 토큰 (라이브러리 없이 직접 서명, 만료 전까지 캐시) ──
let cachedToken = null; // { token, exp }

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function getServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("서버에 GOOGLE_SERVICE_ACCOUNT_JSON이 설정되지 않았습니다.");
  const sa = JSON.parse(raw);
  // 환경변수에 \n 이 문자 그대로 들어간 경우 복원
  if (sa.private_key && !sa.private_key.includes("\n")) {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  }
  return sa;
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  // 키 JSON이 있으면 그걸 쓰고(로컬 실행용), 없으면 Cloud Run 런타임
  // 서비스 계정 토큰을 메타데이터 서버에서 받는다(키 파일 불필요).
  const { token, expiresIn } = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? await tokenFromKeyJson()
    : await tokenFromMetadata();
  cachedToken = { token, exp: now + (expiresIn || 3600) };
  return cachedToken.token;
}

async function tokenFromMetadata() {
  const scopes = encodeURIComponent("https://www.googleapis.com/auth/spreadsheets");
  const res = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=${scopes}`,
    { headers: { "Metadata-Flavor": "Google" } }
  ).catch((e) => { throw new Error(`메타데이터 서버 접근 실패 (${e.message}) — GCP 밖에서 실행 중이면 GOOGLE_SERVICE_ACCOUNT_JSON을 설정하세요.`); });
  if (!res.ok) throw new Error(`런타임 서비스 계정 토큰 발급 실패 (HTTP ${res.status})`);
  const data = await res.json();
  return { token: data.access_token, expiresIn: data.expires_in };
}

async function tokenFromKeyJson() {
  const now = Math.floor(Date.now() / 1000);
  const sa = getServiceAccount();
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), sa.private_key).toString("base64url");
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`구글 인증 실패: ${data.error_description || data.error || res.status}`);
  }
  return { token: data.access_token, expiresIn: data.expires_in };
}

async function sheetsApi(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${MENU_DESC_SHEET_ID}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Sheets API 오류 (${res.status}): ${data?.error?.message || "알 수 없는 오류"}`);
  }
  return data;
}

// 시트 탭이 없으면 만들고 헤더를 기록
async function ensureSheetTab() {
  const meta = await sheetsApi("?fields=sheets.properties.title");
  const titles = (meta.sheets || []).map((s) => s.properties.title);
  if (titles.includes(MENU_DESC_SHEET_NAME)) return;
  await sheetsApi(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: MENU_DESC_SHEET_NAME } } }] }),
  });
  await sheetsApi(`/values/${encodeURIComponent(MENU_DESC_SHEET_NAME)}!A1:F1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [SHEET_HEADER] }),
  });
}

// 시트 전체 읽기 → 행 배열 [{storeId,storeName,kind,name,desc,updatedAt}] (시트 순서 유지)
async function readAllRows() {
  await ensureSheetTab();
  const data = await sheetsApi(`/values/${encodeURIComponent(MENU_DESC_SHEET_NAME)}!A:F`);
  const values = data.values || [];
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const [storeId, storeName, kind, name, desc, updatedAt] = values[i].map((v) => String(v ?? "").trim());
    if (!storeId || storeId === SHEET_HEADER[0]) continue; // 헤더/빈 행 제외
    if (!ROW_KINDS.has(kind)) continue; // 구형/알 수 없는 형식 행은 무시
    rows.push({ storeId, storeName: storeName || "", kind, name: name || "", desc: desc || "", updatedAt: updatedAt || "" });
  }
  return rows;
}

// 시트 전체 다시 쓰기 (헤더 + 행)
async function writeAllRows(rows) {
  await sheetsApi(`/values/${encodeURIComponent(MENU_DESC_SHEET_NAME)}!A:F:clear`, { method: "POST", body: "{}" });
  const values = [SHEET_HEADER, ...rows.map((r) => [r.storeId, r.storeName, r.kind, r.name, r.desc, r.updatedAt])];
  await sheetsApi(`/values/${encodeURIComponent(MENU_DESC_SHEET_NAME)}!A1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values }),
  });
}

// ── 조회 캐시: 행이 수만 개로 늘어도 매 조회마다 시트 전체를 읽지 않도록 ──
//    업로드/삭제 시 새 데이터로 즉시 갱신(write-through). 인스턴스가 여러 개면
//    다른 인스턴스는 최대 TTL만큼 이전 데이터를 보일 수 있음(60초, 허용 범위).
const DATA_CACHE_TTL_MS = 60 * 1000;
let dataCache = { rows: null, at: 0 };

async function readAllRowsCached() {
  if (dataCache.rows && Date.now() - dataCache.at < DATA_CACHE_TTL_MS) return dataCache.rows;
  const rows = await readAllRows();
  dataCache = { rows, at: Date.now() };
  return rows;
}
function setCache(rows) {
  dataCache = { rows, at: Date.now() };
}

// ── 접근 키 확인: 'admin' | 'view' | null ──
function roleOf(req) {
  const key = req.get("x-access-key") || "";
  if (!key) return null;
  if (MENU_DESC_ADMIN_KEY && key === MENU_DESC_ADMIN_KEY) return "admin";
  if (MENU_DESC_VIEW_KEY && key === MENU_DESC_VIEW_KEY) return "view";
  return null;
}

function requireConfig(res) {
  if (!MENU_DESC_SHEET_ID) {
    res.status(500).json({ error: "서버에 MENU_DESC_SHEET_ID가 설정되지 않았습니다." });
    return false;
  }
  if (!MENU_DESC_VIEW_KEY || !MENU_DESC_ADMIN_KEY) {
    res.status(500).json({ error: "서버에 MENU_DESC_VIEW_KEY / MENU_DESC_ADMIN_KEY가 설정되지 않았습니다." });
    return false;
  }
  return true;
}

// 비밀번호 확인 (로그인 화면용)
app.get("/menu-desc/ping", (req, res) => {
  if (!requireConfig(res)) return;
  const role = roleOf(req);
  if (!role) return res.status(401).json({ error: "비밀번호가 올바르지 않습니다." });
  res.json({ ok: true, role });
});

// 전체 데이터 조회 — 스토어별 { id, name, updatedAt, intro, groups:[{name,desc,menus:[{name,desc}]}] }
app.get("/menu-desc/data", async (req, res) => {
  try {
    if (!requireConfig(res)) return;
    if (!roleOf(req)) return res.status(401).json({ error: "비밀번호가 올바르지 않습니다." });

    const rows = await readAllRowsCached();
    const byStore = new Map();
    for (const r of rows) {
      if (!byStore.has(r.storeId)) {
        byStore.set(r.storeId, { id: r.storeId, name: r.storeName, updatedAt: r.updatedAt, intro: "", groups: [] });
      }
      const s = byStore.get(r.storeId);
      if (r.storeName) s.name = r.storeName;
      if (r.updatedAt > s.updatedAt) s.updatedAt = r.updatedAt;
      if (r.kind === "소개") {
        s.intro = r.desc;
      } else if (r.kind === "그룹") {
        s.groups.push({ name: r.name, desc: r.desc, menus: [] });
      } else { // 메뉴 — 바로 위 그룹에 소속, 그룹이 없으면 이름 없는 그룹에
        if (s.groups.length === 0) s.groups.push({ name: "", desc: "", menus: [] });
        s.groups[s.groups.length - 1].menus.push({ name: r.name, desc: r.desc });
      }
    }
    res.json({ stores: [...byStore.values()] });
  } catch (e) {
    console.error("menu-desc/data error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 데이터 업로드 — 업로드에 포함된 스토어는 교체, 나머지는 유지
// body: { rows: [{storeId, storeName, kind:'소개'|'그룹'|'메뉴', name, desc}] } (순서 = 표시 순서)
app.post("/menu-desc/upload", async (req, res) => {
  try {
    if (!requireConfig(res)) return;
    if (roleOf(req) !== "admin") return res.status(401).json({ error: "관리자 비밀번호가 올바르지 않습니다." });

    const incoming = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const cleaned = incoming
      .map((r) => ({
        storeId: String(r.storeId ?? "").trim(),
        storeName: String(r.storeName ?? "").trim(),
        kind: String(r.kind ?? "메뉴").trim(),
        name: String(r.name ?? "").trim(),
        desc: String(r.desc ?? "").trim(),
      }))
      // 소개는 설명이, 그룹/메뉴는 이름이 있어야 유효
      .filter((r) => r.storeId && ROW_KINDS.has(r.kind) && (r.kind === "소개" ? r.desc : r.name));
    if (cleaned.length === 0) {
      return res.status(400).json({ error: "업로드할 유효한 행이 없습니다. (스토어ID와 이름/설명 확인)" });
    }

    const now = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD HH:mm:ss
    const uploadedIds = new Set(cleaned.map((r) => r.storeId));

    const existing = await readAllRows();
    const kept = existing.filter((r) => !uploadedIds.has(r.storeId));
    const merged = [...kept, ...cleaned.map((r) => ({ ...r, updatedAt: now }))];
    await writeAllRows(merged);
    setCache(merged);

    res.json({
      ok: true,
      uploadedStores: uploadedIds.size,
      uploadedRows: cleaned.length,
      uploadedMenus: cleaned.filter((r) => r.kind === "메뉴").length,
      totalStores: new Set(merged.map((r) => r.storeId)).size,
      totalRows: merged.length,
    });
  } catch (e) {
    console.error("menu-desc/upload error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 스토어 삭제 — 해당 스토어ID의 모든 행 제거 (관리자만)
app.post("/menu-desc/delete", async (req, res) => {
  try {
    if (!requireConfig(res)) return;
    if (roleOf(req) !== "admin") return res.status(401).json({ error: "관리자 비밀번호가 올바르지 않습니다." });

    const storeId = String(req.body?.storeId ?? "").trim();
    if (!storeId) return res.status(400).json({ error: "storeId가 필요합니다." });

    const existing = await readAllRows();
    const kept = existing.filter((r) => r.storeId !== storeId);
    if (kept.length === existing.length) {
      return res.status(404).json({ error: "해당 스토어ID의 데이터가 없습니다." });
    }
    await writeAllRows(kept);
    setCache(kept);
    res.json({
      ok: true,
      deletedRows: existing.length - kept.length,
      totalStores: new Set(kept.map((r) => r.storeId)).size,
    });
  } catch (e) {
    console.error("menu-desc/delete error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Cloud Run은 PORT 환경변수로 포트를 주입함 (기본 8080).
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`menu-check-server listening on :${PORT} (model: ${GEMINI_MODEL})`);
});
