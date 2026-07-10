# menu-check 백엔드 (Cloud Run)

기존 Cloudflare Worker를 대체하는 Gemini 기반 메뉴판 OCR·분류 서버.
프론트(`menu-check.html`)와의 계약을 그대로 유지한다.

## 계약(Contract)

```
요청  POST /
      Content-Type: application/json
      { "mode": "vision",
        "images": ["<base64>", ...],          // 데이터 URL 접두사 없는 순수 base64
        "mediaTypes": ["image/jpeg", ...] }

응답  200  { "text": "메뉴명|가격|카테고리\n..." }
오류       { "error": "메시지" }
```

`GET /` 는 헬스체크 (`{ ok: true, ... }`).

## 환경변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `GEMINI_API_KEY` | ✅ | Google AI Studio에서 발급한 Gemini API 키 |
| `GEMINI_MODEL` | ❌ | 기본 `gemini-2.5-flash` |
| `PORT` | ❌ | Cloud Run이 자동 주입 (기본 8080) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 메뉴설명 기능 사용 시 ✅ | 서비스 계정 키 JSON 전체 내용 (아래 설정 참고) |
| `MENU_DESC_SHEET_ID` | 메뉴설명 기능 사용 시 ✅ | 데이터 저장용 구글 시트 ID (시트 URL의 `/d/`와 `/edit` 사이 값) |
| `MENU_DESC_VIEW_KEY` | 메뉴설명 기능 사용 시 ✅ | 세일즈 열람용 비밀번호 (`menu-desc.html`) |
| `MENU_DESC_ADMIN_KEY` | 메뉴설명 기능 사용 시 ✅ | 업로드 관리자용 비밀번호 (`menu-desc-admin.html`) |
| `MENU_DESC_SHEET_NAME` | ❌ | 시트 탭 이름 (기본 `메뉴설명`, 없으면 자동 생성) |

---

## 메뉴 설명 열람/업로드 기능 설정 (최초 1회)

`menu-desc.html`(세일즈 열람) / `menu-desc-admin.html`(관리자 업로드)이 사용하는
데이터 저장소는 **구글 시트**이고, 서버가 **서비스 계정**으로 대신 읽고 쓴다.
업로드하는 팀원과 세일즈는 구글 로그인이 전혀 필요 없다.

### 🚀 빠른 설정 (권장): 자동 스크립트

[Google Cloud Shell](https://shell.cloud.google.com)에서 menu-check가 있는 프로젝트를 선택한 뒤 한 줄 실행:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/shatdown5170/menu-check/main/server/setup-menu-desc.sh)
```

비밀번호 2개(열람용/관리자용)와 시트를 공유받을 개인 이메일만 입력하면
API 활성화 → 서비스 계정 생성 → 시트 생성·공유 → Cloud Run 환경변수 설정 → 동작 확인까지 자동으로 끝난다.
아래 수동 절차는 스크립트를 쓸 수 없을 때만 참고.

### 수동 설정 절차

### 1. 서비스 계정 만들기 (Cloud Run과 같은 GCP 프로젝트)
1. https://console.cloud.google.com/iam-admin/serviceaccounts → **서비스 계정 만들기**
2. 이름 예: `menu-desc-sheets` → 역할은 부여하지 않아도 됨 → 완료
3. 만든 계정 클릭 → **키** 탭 → **키 추가 → 새 키 만들기 → JSON** → 파일 다운로드
4. 프로젝트에서 **Google Sheets API** 활성화:
   https://console.cloud.google.com/apis/library/sheets.googleapis.com → 사용 설정

### 2. 데이터 저장용 구글 시트 준비 (개인 계정)
1. 개인 구글 계정으로 새 스프레드시트 생성 (이름 자유, 예: `쿠팡이츠 메뉴설명 DB`)
2. **공유** → 1-3에서 받은 JSON 안의 `client_email` 값
   (예: `menu-desc-sheets@프로젝트.iam.gserviceaccount.com`)을 **편집자**로 추가
3. 시트 URL에서 ID 복사: `https://docs.google.com/spreadsheets/d/`**`{이부분}`**`/edit`
4. 탭(시트지)은 만들 필요 없음 — 서버가 `메뉴설명` 탭과 헤더를 자동 생성

### 3. Cloud Run 환경변수 추가
Cloud Run 콘솔 → 서비스 → **수정 및 새 버전 배포** → 변수 및 보안 비밀:
- `GOOGLE_SERVICE_ACCOUNT_JSON` = 다운로드한 JSON 파일의 **내용 전체**를 그대로 붙여넣기
- `MENU_DESC_SHEET_ID` = 2-3의 시트 ID
- `MENU_DESC_VIEW_KEY` = 세일즈에게 알려줄 열람 비밀번호
- `MENU_DESC_ADMIN_KEY` = 업로드 담당자만 아는 관리자 비밀번호 (열람용과 다르게!)

### 4. 확인
```bash
curl -H "x-access-key: 열람비밀번호" https://<Cloud Run URL>/menu-desc/ping
# → {"ok":true,"role":"view"}
curl -H "x-access-key: 열람비밀번호" https://<Cloud Run URL>/menu-desc/data
# → {"stores":[]}   (첫 실행 시 시트에 '메뉴설명' 탭이 자동 생성됨)
```

### API 계약
```
GET  /menu-desc/ping    헤더 x-access-key                → { ok, role: 'view'|'admin' }
GET  /menu-desc/data    헤더 x-access-key                → { stores:[{id,name,updatedAt,menus:[{name,desc}]}] }
POST /menu-desc/upload  헤더 x-access-key (관리자 키만)   → body { rows:[{storeId,storeName,menuName,desc}] }
                        업로드에 포함된 스토어ID는 기존 행 전체가 교체되고, 나머지 스토어는 유지.
```

시트 컬럼: `스토어ID | 스토어명 | 메뉴명 | 메뉴설명 | 업로드일시`

## 로컬 실행

```bash
cd server
npm install
GEMINI_API_KEY=발급받은키 npm start
# 다른 터미널에서:
curl -X POST http://localhost:8080/ \
  -H 'Content-Type: application/json' \
  -d '{"mode":"vision","images":["<base64>"],"mediaTypes":["image/jpeg"]}'
```

---

## Cloud Run 연속 배포 (GitHub 연동)

> 한 번만 콘솔에서 연결해두면, 이후 `main`에 push할 때마다 자동 빌드·배포된다.
> 로컬에 gcloud/docker 설치 불필요.

### 1. 사전 준비
- GCP 프로젝트 생성 (또는 기존 프로젝트 사용)
- 결제(Billing) 활성화
- 콘솔에서 다음 API 활성화: **Cloud Run**, **Cloud Build**, **Artifact Registry**

### 2. Cloud Run 서비스 생성
1. https://console.cloud.google.com/run → **서비스 만들기**
2. **소스 저장소에서 지속적으로 배포** 선택 → **Cloud Build 설정**
3. **GitHub 연결** → 저장소 `shatdown5170/menu-check` 인증·선택
4. 빌드 구성:
   - **분기(Branch):** `^main$`
   - **빌드 유형:** **Dockerfile**
   - **소스 위치 / Dockerfile 경로:** `/server/Dockerfile`
     (빌드 컨텍스트가 `server/`가 되도록 — 콘솔에 따라 "소스 위치: /server" 로 지정)
5. 서비스 설정:
   - **리전(Region):** `asia-northeast3` (서울)
   - **인증:** **인증되지 않은 호출 허용** (프론트에서 공개 호출하므로)
   - **CPU/메모리:** 기본값(512MiB)로 충분. 이미지 여러 장이면 메모리 1GiB 권장.
6. **변수 및 보안 비밀** 탭:
   - `GEMINI_API_KEY` = (발급받은 키)
   - (선택) `GEMINI_MODEL` = `gemini-2.5-flash`
7. **만들기** → 첫 빌드·배포 완료까지 대기

### 3. 배포 URL 확인 & 프론트 연결
배포되면 `https://menu-check-xxxxx-an.a.run.app` 형태의 URL이 나온다.
이 값을 `menu-check.html` 상단 `WORKER_URL` 에 넣는다:

```js
const WORKER_URL = "https://menu-check-xxxxx-an.a.run.app";
```

### 4. 확인
```bash
curl https://menu-check-xxxxx-an.a.run.app/        # {"ok":true,...}
```

이후 `git push` → 자동 재배포.

---

## (대안) gcloud로 수동 1회 배포

gcloud CLI가 있다면:

```bash
cd server
gcloud run deploy menu-check \
  --source . \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=발급받은키
```
