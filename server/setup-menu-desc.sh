#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# 메뉴 설명 기능 — GCP 자동 설정 스크립트 (Google Cloud Shell에서 실행)
#
# 하는 일:
#   1. Sheets/Drive/IAM Credentials API 활성화
#   2. 서비스 계정 생성 (키 파일 없이 — 조직 정책과 무관하게 동작)
#   3. 데이터 저장용 구글 시트 생성 + 내 개인 계정에 편집자로 자동 공유
#   4. Cloud Run(menu-check)을 이 서비스 계정으로 실행 + 환경변수 설정
#   5. 동작 확인 (ping / data)
#
# 실행 방법:
#   https://shell.cloud.google.com 접속 → menu-check가 있는 프로젝트 선택 →
#   bash <(curl -fsSL https://raw.githubusercontent.com/shatdown5170/menu-check/main/server/setup-menu-desc.sh)
#
# 재실행 시 시트를 새로 만들지 않고 기존 시트를 유지하려면:
#   SHEET_ID=기존시트ID bash <(curl -fsSL ...)
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

SERVICE="${SERVICE:-menu-check}"
REGION="${REGION:-asia-northeast3}"
SA_NAME="${SA_NAME:-menu-desc-sheets}"
SHEET_TITLE="쿠팡이츠 메뉴설명 DB"
SHEET_TAB="메뉴설명"

PROJECT=$(gcloud config get-value project 2>/dev/null)
if [[ -z "$PROJECT" ]]; then
  echo "❌ 프로젝트가 선택되지 않았습니다. 먼저: gcloud config set project 프로젝트ID"
  exit 1
fi
if ! gcloud run services describe "$SERVICE" --region "$REGION" >/dev/null 2>&1; then
  echo "❌ 이 프로젝트($PROJECT)에 Cloud Run 서비스 '$SERVICE'($REGION)가 없습니다."
  echo "   현재 프로젝트의 서비스 목록:"
  gcloud run services list 2>/dev/null || true
  echo "   menu-check가 있는 프로젝트를 선택한 뒤 다시 실행해주세요."
  exit 1
fi

echo "══════════════════════════════════════════"
echo " 프로젝트: $PROJECT / 서비스: $SERVICE ($REGION)"
echo "══════════════════════════════════════════"

# 붙여넣기로 딸려온 줄바꿈 등 대기 중인 입력을 버림 (질문이 건너뛰어지는 것 방지)
while read -r -t 0.3 _leftover; do :; done || true

# 영문/숫자 4자 이상만 허용 — 잘못 입력하면 종료하지 않고 다시 물어봄
ask_key() { # $1=변수명  $2=프롬프트
  local _v=""
  while true; do
    read -rp "$2" _v || true
    if [[ "$_v" =~ ^[A-Za-z0-9]{4,}$ ]]; then break; fi
    echo "   ⚠️ 영문/숫자 4자 이상으로만 입력해주세요 (한글·공백·특수문자 불가). 다시:"
  done
  printf -v "$1" '%s' "$_v"
}

ask_key VIEW_KEY  "① 세일즈 열람용 비밀번호 (영문/숫자 4자 이상): "
while true; do
  ask_key ADMIN_KEY "② 관리자(업로드용) 비밀번호 (열람용과 다르게): "
  [[ "$ADMIN_KEY" != "$VIEW_KEY" ]] && break
  echo "   ⚠️ 열람용과 같은 비밀번호는 안 됩니다. 다시:"
done
read -rp "③ 시트를 공유받을 개인 구글 이메일 [shatdown112@gmail.com]: " SHARE_EMAIL || true
SHARE_EMAIL=${SHARE_EMAIL:-shatdown112@gmail.com}

echo ""
echo "▶ 1/5 API 활성화 (Sheets, Drive, IAM Credentials)…"
gcloud services enable sheets.googleapis.com drive.googleapis.com iamcredentials.googleapis.com --quiet

echo "▶ 2/5 서비스 계정 준비 (키 파일 없는 방식)…"
# 구글 보안 정책(iam.disableServiceAccountKeyCreation)이 키 발급을 막는 환경이 많아
# 키 파일을 만들지 않는다. 대신:
#   · 시트 생성(1회)  → 일시적 가장(impersonation) 토큰 사용
#   · 서버 운영(상시) → Cloud Run 런타임 서비스 계정 신원 사용
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name="menu-desc 시트 접근용" --quiet
  sleep 3
fi
USER_EMAIL=$(gcloud config get-value account 2>/dev/null)
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --member="user:${USER_EMAIL}" --role="roles/iam.serviceAccountTokenCreator" --quiet >/dev/null

get_sa_token() {
  curl -sf -X POST "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA_EMAIL}:generateAccessToken" \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "Content-Type: application/json" \
    -d '{"scope":["https://www.googleapis.com/auth/spreadsheets","https://www.googleapis.com/auth/drive"],"lifetime":"600s"}' \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['accessToken'])"
}
echo "   권한 전파 대기 중 (보통 10~60초)…"
TOKEN=""
for i in $(seq 1 12); do
  if TOKEN=$(get_sa_token 2>/dev/null) && [[ -n "$TOKEN" ]]; then break; fi
  echo "   … 재시도 ($i/12)"
  sleep 10
done
if [[ -z "$TOKEN" ]]; then
  echo "❌ 서비스 계정 토큰 발급이 계속 실패합니다. 1~2분 뒤 스크립트를 다시 실행해보세요."
  exit 1
fi

# JSON 응답에서 필드 추출 (실패 시 빈 문자열 — 스크립트가 죽지 않게)
json_get() { # $1=파이썬 표현식 (변수 d 사용)
  python3 -c "import json,sys
try:
    d = json.load(sys.stdin)
    print($1)
except Exception:
    print('')"
}

if [[ -z "${SHEET_ID:-}" ]]; then
  echo "▶ 3/5 구글 시트 생성 + ${SHARE_EMAIL} 에 편집자 공유…"
  # 방금 켠 Sheets/Drive API가 실제 사용 가능해지기까지 몇 분 걸릴 수 있어 재시도
  SHEET_ID=""
  for i in $(seq 1 10); do
    RESP=$(curl -s -X POST "https://sheets.googleapis.com/v4/spreadsheets" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "{\"properties\":{\"title\":\"${SHEET_TITLE}\"},\"sheets\":[{\"properties\":{\"title\":\"${SHEET_TAB}\"}}]}") || RESP=""
    SHEET_ID=$(printf '%s' "$RESP" | json_get "d.get('spreadsheetId','')")
    if [[ -n "$SHEET_ID" ]]; then break; fi
    ERRMSG=$(printf '%s' "$RESP" | json_get "d['error']['message'][:150]")
    echo "   … 시트 생성 재시도 ($i/10) — 사유: ${ERRMSG:-응답 없음}"
    sleep 15
    if NEW_TOKEN=$(get_sa_token 2>/dev/null) && [[ -n "$NEW_TOKEN" ]]; then TOKEN="$NEW_TOKEN"; fi
  done
  if [[ -z "$SHEET_ID" ]]; then
    echo "❌ 시트 생성이 계속 실패합니다 (위 '사유' 참고). 몇 분 뒤 스크립트를 다시 실행해보세요."
    exit 1
  fi
  echo "   시트 생성 완료: $SHEET_ID"
  # 헤더 행 기록 (첫 번째 탭 = 메뉴설명) — 실패해도 치명적이지 않음(첫 업로드 때 서버가 기록)
  curl -sf -X PUT "https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A1:E1?valueInputOption=RAW" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"values":[["스토어ID","스토어명","메뉴명","메뉴설명","업로드일시"]]}' >/dev/null \
    || echo "   ⚠️ 헤더 기록 실패 (무시해도 됨 — 첫 업로드 때 자동 기록)"
  # 개인 계정에 편집자 권한 부여 — 실패해도 서버 동작에는 지장 없음
  PERM=$(curl -s -X POST "https://www.googleapis.com/drive/v3/files/${SHEET_ID}/permissions?sendNotificationEmail=false" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"role\":\"writer\",\"type\":\"user\",\"emailAddress\":\"${SHARE_EMAIL}\"}") || PERM=""
  if [[ -z "$(printf '%s' "$PERM" | json_get "d.get('id','')")" ]]; then
    echo "   ⚠️ 개인 계정 공유 실패: $(printf '%s' "$PERM" | json_get "d['error']['message'][:150]")"
    echo "      (서버·업로드·조회는 정상 동작. 시트 열람만 안 되는 것이니 나중에 다시 시도 가능)"
  fi
else
  echo "▶ 3/5 기존 시트 사용: $SHEET_ID (서비스 계정 ${SA_EMAIL} 이 편집자로 공유돼 있어야 함)"
fi

echo "▶ 4/5 Cloud Run 설정: 런타임 서비스 계정 지정 + 환경변수 (새 리비전 배포, 1~2분)…"
gcloud run services update "$SERVICE" --region "$REGION" --quiet \
  --service-account "$SA_EMAIL" \
  --update-env-vars "^@@@^MENU_DESC_SHEET_ID=${SHEET_ID}@@@MENU_DESC_VIEW_KEY=${VIEW_KEY}@@@MENU_DESC_ADMIN_KEY=${ADMIN_KEY}"

echo "▶ 5/5 동작 확인…"
URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
sleep 3
PING=$(curl -s -H "x-access-key: ${VIEW_KEY}" "${URL}/menu-desc/ping")
DATA=$(curl -s -H "x-access-key: ${VIEW_KEY}" "${URL}/menu-desc/data")

echo ""
echo "══════════════════════════════════════════"
echo " ✅ 설정 완료!"
echo "══════════════════════════════════════════"
echo " ping 응답:  $PING"
echo " data 응답:  $DATA"
echo ""
echo " 📄 데이터 시트 (개인 계정으로 열람/수정 가능):"
echo "    https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit"
echo "    (구글 드라이브 '공유 문서함'에도 표시됩니다)"
echo ""
echo " 📱 세일즈 조회 페이지:  https://shatdown5170.github.io/menu-check/menu-desc.html"
echo "    → 열람 비밀번호: 위에서 입력한 ①"
echo " 🛠️ 관리자 업로드 페이지: https://shatdown5170.github.io/menu-check/menu-desc-admin.html"
echo "    → 관리자 비밀번호: 위에서 입력한 ②"
echo ""
if [[ "$PING" != *'"ok":true'* ]]; then
  echo " ⚠️ ping 응답이 예상과 다릅니다. 1~2분 뒤 다시 확인해보세요:"
  echo "    curl -H \"x-access-key: ${VIEW_KEY}\" ${URL}/menu-desc/ping"
fi
