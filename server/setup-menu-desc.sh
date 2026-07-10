#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# 메뉴 설명 기능 — GCP 자동 설정 스크립트 (Google Cloud Shell에서 실행)
#
# 하는 일:
#   1. Sheets/Drive API 활성화
#   2. 서비스 계정 생성 + 키 발급
#   3. 데이터 저장용 구글 시트 생성 + 내 개인 계정에 편집자로 자동 공유
#   4. Cloud Run(menu-check)에 환경변수 설정 (기존 변수는 유지)
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
echo "▶ 1/5 API 활성화 (Sheets, Drive)…"
gcloud services enable sheets.googleapis.com drive.googleapis.com --quiet

echo "▶ 2/5 서비스 계정 준비…"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name="menu-desc 시트 접근용" --quiet
  sleep 3
fi
KEYFILE=$(mktemp)
trap 'rm -f "$KEYFILE"' EXIT
gcloud iam service-accounts keys create "$KEYFILE" --iam-account="$SA_EMAIL" --quiet
KEY_JSON=$(python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1])), separators=(',',':')))" "$KEYFILE")

# 서비스 계정으로 Sheets/Drive API 토큰 발급
python3 -c "import google.auth" 2>/dev/null || pip3 install --user --quiet google-auth
TOKEN=$(python3 - "$KEYFILE" <<'PYEOF'
import sys
from google.oauth2 import service_account
from google.auth.transport.requests import Request
creds = service_account.Credentials.from_service_account_file(
    sys.argv[1],
    scopes=["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
)
creds.refresh(Request())
print(creds.token)
PYEOF
)

if [[ -z "${SHEET_ID:-}" ]]; then
  echo "▶ 3/5 구글 시트 생성 + ${SHARE_EMAIL} 에 편집자 공유…"
  SHEET_ID=$(curl -sf -X POST "https://sheets.googleapis.com/v4/spreadsheets" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"properties\":{\"title\":\"${SHEET_TITLE}\"},\"sheets\":[{\"properties\":{\"title\":\"${SHEET_TAB}\"}}]}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['spreadsheetId'])")
  # 헤더 행 기록 (첫 번째 탭 = 메뉴설명)
  curl -sf -X PUT "https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A1:E1?valueInputOption=RAW" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"values":[["스토어ID","스토어명","메뉴명","메뉴설명","업로드일시"]]}' >/dev/null
  # 개인 계정에 편집자 권한 부여
  curl -sf -X POST "https://www.googleapis.com/drive/v3/files/${SHEET_ID}/permissions?sendNotificationEmail=false" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"role\":\"writer\",\"type\":\"user\",\"emailAddress\":\"${SHARE_EMAIL}\"}" >/dev/null
else
  echo "▶ 3/5 기존 시트 사용: $SHEET_ID (서비스 계정 ${SA_EMAIL} 이 편집자로 공유돼 있어야 함)"
fi

echo "▶ 4/5 Cloud Run 환경변수 설정 (새 리비전 배포, 1~2분)…"
gcloud run services update "$SERVICE" --region "$REGION" --quiet \
  --update-env-vars "^@@@^GOOGLE_SERVICE_ACCOUNT_JSON=${KEY_JSON}@@@MENU_DESC_SHEET_ID=${SHEET_ID}@@@MENU_DESC_VIEW_KEY=${VIEW_KEY}@@@MENU_DESC_ADMIN_KEY=${ADMIN_KEY}"

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
