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
