/**
 * 팀 R&R · 업무량 · 긴급배분 관리 시트  — Google Sheets 생성 스크립트
 *
 * 사용법
 *  1) Google Sheets 새 문서 열기 → 메뉴 [확장 프로그램] → [Apps Script]
 *  2) 기존 코드 모두 지우고 이 파일 전체를 붙여넣기 → 저장(💾)
 *  3) 함수 목록에서 buildRnRSheet 선택 → [실행] → 최초 1회 권한 승인
 *  4) 시트로 돌아오면 5개 탭이 자동 생성되어 있습니다.
 *
 * 영역: 기획/PM/운영 팀(5인 이하) · 가용 주 32시간 기준 · 회당시간×주기 자동 월환산
 */

// ----------------------------------------------------------------- 색상 상수
var NAVY = '#1F3864', BLUE = '#2E5496', LBLUE = '#D9E1F2', LLBLUE = '#EAF0FA';
var GREY = '#808080', LGREY = '#F2F2F2', WHITE = '#FFFFFF';
var GREEN = '#C6EFCE', GREEN_T = '#006100';
var YELLOW = '#FFEB9C', YELLOW_T = '#9C6500';
var RED = '#FFC7CE', RED_T = '#9C0006', INPUT_BG = '#FFF2CC';

var WEEKLY_CAP = 32;       // 팀원 1인당 주당 업무 가능시간
var MONTH_FACTOR = 4.33;   // 주 → 월 환산
var DATA_END = 60;         // 업무마스터 데이터 참조 한계 행(여유 있게)

// 주기 → 월 발생횟수 (영업일 21일/월 기준)
var FREQ = [
  ['매일', 21], ['주3회', 13], ['주2회', 8.67], ['주간(주1회)', 4.33],
  ['격주', 2.17], ['월간', 1], ['분기', 0.33], ['반기', 0.17],
  ['연간', 0.083], ['수시', 0]
];

// 드롭다운 목록
var CATS = ['기획', '운영', '데이터/지표', '유관협업', 'QA/품질', '관리/지원'];
var DIFF = ['낮음(누구나 가능)', '중간(인수인계 필요)', '높음(전담 필수)'];
var AUTO = ['가능', '일부 가능', '불가'];
var PRIO = ['상', '중', '하'];
var MEMBERS = ['김지원(팀장/PM)', '이서연(서비스기획)', '박민준(운영매니저)',
               '최유나(데이터/지표)', '정현우(QA/지원)'];
var ROLES = ['팀장 / PM', '서비스 기획', '운영 매니저', '데이터 / 지표', 'QA / 지원'];
var FREQ_LIST = FREQ.map(function (f) { return f[0]; });

// 업무마스터 컬럼 (헤더, 너비)
var COLS = [
  ['No', 45], ['업무명', 200], ['업무분류', 95], ['업무 설명', 260],
  ['주담당', 130], ['백업담당', 130], ['주기', 95], ['회당\n소요시간(h)', 80],
  ['월 발생횟수\n(직접·수시용)', 90], ['월 환산\n시간(h)', 75], ['필요 역량/스킬', 180],
  ['대체 난이도', 130], ['자동화\n가능성', 80], ['우선\n순위', 55], ['비고', 170]
];

// 샘플 업무 데이터 (각 dict: 업무명,분류,설명,주담당,백업,주기,회당,[월횟수직접],역량,난이도,자동화,우선순위,비고)
var SAMPLE = [
  ['주간 팀 회의 준비·진행','운영','아젠다 취합, 회의록 작성·공유','김지원(팀장/PM)','이서연(서비스기획)','주간(주1회)',1.5,'','퍼실리테이션, 문서화','낮음(누구나 가능)','일부 가능','중','회의록 템플릿화로 단축 여지'],
  ['월간 사업보고서 작성','기획','실적·지표 종합, 경영진 보고자료 작성','김지원(팀장/PM)','최유나(데이터/지표)','월간',6,'','데이터 해석, 스토리텔링','높음(전담 필수)','일부 가능','상','지표는 최유나 협조'],
  ['분기 OKR 수립·리뷰','기획','목표 설정, 핵심지표 정의, 회고','김지원(팀장/PM)','이서연(서비스기획)','분기',8,'','전략기획','높음(전담 필수)','불가','상',''],
  ['유관부서 협업 미팅','유관협업','개발·디자인·마케팅 정례 싱크','김지원(팀장/PM)','박민준(운영매니저)','주간(주1회)',2,'','커뮤니케이션, 조율','중간(인수인계 필요)','불가','중',''],
  ['서비스 기능 기획서 작성','기획','요구사항 정의, 기획서·스펙 문서화','이서연(서비스기획)','김지원(팀장/PM)','격주',8,'','서비스기획, UX','높음(전담 필수)','불가','상',''],
  ['사용자 피드백 정리·분석','기획','VOC·설문 취합, 인사이트 도출','이서연(서비스기획)','박민준(운영매니저)','주간(주1회)',3,'','리서치, 정성분석','중간(인수인계 필요)','일부 가능','중',''],
  ['화면 정책·플로우 정의','기획','정책 정의, 화면 플로우/예외처리 정리','이서연(서비스기획)','정현우(QA/지원)','격주',5,'','기획, 논리설계','높음(전담 필수)','불가','중',''],
  ['릴리즈 노트 작성','운영','배포 내역 정리, 사내 공지','이서연(서비스기획)','정현우(QA/지원)','월간',2,'','문서화','낮음(누구나 가능)','가능','하','자동화 1순위 후보'],
  ['일일 운영 모니터링','운영','대시보드·알람 점검, 이상징후 확인','박민준(운영매니저)','최유나(데이터/지표)','매일',0.5,'','운영, 모니터링','중간(인수인계 필요)','일부 가능','상',''],
  ['CS 이슈 대응·에스컬레이션','운영','문의 분류, 처리·유관부서 전달','박민준(운영매니저)','정현우(QA/지원)','매일',1,'','CS, 문제해결','중간(인수인계 필요)','불가','상','피크시 변동 큼'],
  ['운영 프로세스 문서 업데이트','관리/지원','매뉴얼·플레이북 현행화','박민준(운영매니저)','이서연(서비스기획)','월간',3,'','문서화, 프로세스설계','낮음(누구나 가능)','불가','하',''],
  ['외부 벤더 커뮤니케이션','유관협업','제휴사·외주 일정·이슈 조율','박민준(운영매니저)','김지원(팀장/PM)','주간(주1회)',1.5,'','협상, 커뮤니케이션','중간(인수인계 필요)','불가','중',''],
  ['주간 지표 대시보드 업데이트','데이터/지표','핵심지표 집계·갱신, 코멘트','최유나(데이터/지표)','박민준(운영매니저)','주간(주1회)',2,'','SQL, 데이터시각화','중간(인수인계 필요)','가능','중','쿼리 자동화 가능'],
  ['월간 성과 데이터 분석 리포트','데이터/지표','성과 심층분석, 개선 제언','최유나(데이터/지표)','김지원(팀장/PM)','월간',8,'','데이터분석, 통계','높음(전담 필수)','일부 가능','상',''],
  ['A/B 테스트 설계·분석','데이터/지표','실험 설계, 결과 해석·의사결정 지원','최유나(데이터/지표)','이서연(서비스기획)','격주',5,'','실험설계, 통계','높음(전담 필수)','불가','중',''],
  ['데이터 추출 Ad-hoc 요청 대응','데이터/지표','비정기 데이터 추출·가공 요청 처리','최유나(데이터/지표)','박민준(운영매니저)','수시',1,6,'SQL','중간(인수인계 필요)','일부 가능','중','월 평균 6건 가정(직접입력 예시)'],
  ['QA 테스트 케이스 작성','QA/품질','기능별 테스트 시나리오 설계','정현우(QA/지원)','이서연(서비스기획)','격주',4,'','QA, 테스트설계','중간(인수인계 필요)','일부 가능','중',''],
  ['배포 전 QA 검증','QA/품질','릴리즈 전 회귀·시나리오 검증','정현우(QA/지원)','박민준(운영매니저)','격주',3,'','QA, 꼼꼼함','중간(인수인계 필요)','일부 가능','상','배포 주기 연동'],
  ['버그 트래킹·리포팅','QA/품질','이슈 등록·우선순위화, 처리현황 공유','정현우(QA/지원)','박민준(운영매니저)','주간(주1회)',2,'','이슈관리','낮음(누구나 가능)','일부 가능','중',''],
  ['내부 위키·문서 정리','관리/지원','팀 지식베이스 구조화·정리','정현우(QA/지원)','이서연(서비스기획)','월간',3,'','문서화, 정리','낮음(누구나 가능)','불가','하',''],
  ['경영진 주간 실적 보고','기획','주요 지표·이슈 요약 보고','김지원(팀장/PM)','최유나(데이터/지표)','주간(주1회)',2,'','요약, 보고','중간(인수인계 필요)','일부 가능','상',''],
  ['채용·면접 진행','관리/지원','서류검토·면접·피드백','김지원(팀장/PM)','이서연(서비스기획)','수시',2,3,'평가, 커뮤니케이션','중간(인수인계 필요)','불가','중','채용시즌 변동 큼'],
  ['디자인 QA·리뷰','기획','산출물 디자인 검수·피드백','이서연(서비스기획)','정현우(QA/지원)','주간(주1회)',2,'','UX, 디테일','중간(인수인계 필요)','불가','중',''],
  ['스프린트 백로그 관리','기획','이슈 정리·우선순위화·그루밍','이서연(서비스기획)','김지원(팀장/PM)','주간(주1회)',1.5,'','기획, 일정관리','중간(인수인계 필요)','일부 가능','중',''],
  ['경쟁사·시장 리서치','기획','동향 모니터링·벤치마킹 정리','이서연(서비스기획)','최유나(데이터/지표)','월간',4,'','리서치','낮음(누구나 가능)','불가','하',''],
  ['주간 운영 현황 리포트','데이터/지표','운영 지표 집계·공유','박민준(운영매니저)','최유나(데이터/지표)','주간(주1회)',2,'','데이터 정리','중간(인수인계 필요)','가능','중','자동화 후보'],
  ['정산·매출 데이터 점검','운영','정산 데이터 검증·이상 확인','박민준(운영매니저)','최유나(데이터/지표)','주간(주1회)',1.5,'','꼼꼼함, 숫자감각','중간(인수인계 필요)','일부 가능','상',''],
  ['신규 입점·온보딩 처리','운영','신규 건 검수·등록·안내','박민준(운영매니저)','정현우(QA/지원)','수시',0.75,8,'운영, 꼼꼼함','낮음(누구나 가능)','일부 가능','중',''],
  ['장애·인시던트 대응','운영','긴급 이슈 처리·사후 리포트','박민준(운영매니저)','정현우(QA/지원)','수시',2,4,'문제해결, 침착함','높음(전담 필수)','불가','상','발생 예측 어려움'],
  ['일일 정산 마감 확인','운영','마감 배치·수치 확인','박민준(운영매니저)','최유나(데이터/지표)','매일',0.5,'','운영','중간(인수인계 필요)','가능','상','자동화 후보'],
  ['고객 문의 2차 대응','운영','에스컬레이션 건 심층 처리','박민준(운영매니저)','정현우(QA/지원)','매일',0.5,'','CS, 문제해결','중간(인수인계 필요)','불가','중',''],
  ['주간 운영 회의 주재','운영','운영 이슈 점검 회의 진행','박민준(운영매니저)','김지원(팀장/PM)','주간(주1회)',1.5,'','퍼실리테이션','낮음(누구나 가능)','불가','중',''],
  ['데이터 거버넌스·지표 정의','데이터/지표','지표 표준·정의 관리','최유나(데이터/지표)','이서연(서비스기획)','월간',4,'','데이터 모델링','높음(전담 필수)','불가','중',''],
  ['정기 코호트 분석','데이터/지표','리텐션·코호트 추이 분석','최유나(데이터/지표)','김지원(팀장/PM)','격주',4,'','데이터분석','높음(전담 필수)','일부 가능','중',''],
  ['일일 스모크 테스트','QA/품질','핵심 플로우 일일 점검','정현우(QA/지원)','박민준(운영매니저)','매일',0.5,'','QA','낮음(누구나 가능)','가능','중','자동화 후보'],
  ['QA 자동화 스크립트 유지보수','QA/품질','테스트 자동화 코드 관리','정현우(QA/지원)','최유나(데이터/지표)','주간(주1회)',2,'','테스트 자동화, 코드','높음(전담 필수)','일부 가능','중','']
];

var MASTER_NAME = '① 업무마스터(R&R)';
var DASH_NAME = '② 팀원별 부하';
var URG_NAME = '③ 긴급배분 가이드';
var TPL_NAME = '빈 템플릿';
var GUIDE_NAME = '📖 사용안내';
var REF_NAME = '참조';

function buildRnRSheet() {
  var ss = SpreadsheetApp.create('팀 R&R·업무량·긴급배분 관리 시트');
  // 기본 시트 제거 대비
  buildRef_(ss);
  var range = buildMaster_(ss, MASTER_NAME, MASTER_NAME + '  ·  R&R 정의표  (샘플 데이터)', SAMPLE, 4);
  buildDashboard_(ss, range.first, range.last);
  buildUrgent_(ss);
  buildMaster_(ss, TPL_NAME, '업무 마스터 · R&R 정의표  (빈 템플릿 — 우리 팀 내용으로 채우세요)', [], 30);
  buildGuide_(ss);

  // 기본 'Sheet1' 제거
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('시트1');
  if (def) ss.deleteSheet(def);

  // 탭 순서 정렬
  reorder_(ss, [GUIDE_NAME, MASTER_NAME, DASH_NAME, URG_NAME, TPL_NAME, REF_NAME]);
  ss.getSheetByName(REF_NAME).hideSheet();
  ss.setActiveSheet(ss.getSheetByName(GUIDE_NAME));

  var url = ss.getUrl();
  Logger.log('✅ 생성 완료: ' + url);
  try { SpreadsheetApp.getUi().alert('✅ 시트 생성 완료!\n\n새 스프레드시트가 만들어졌습니다:\n' + url); } catch (e) {}
  return url;
}

// ----------------------------------------------------------------- 참조 시트
function buildRef_(ss) {
  var sh = ss.insertSheet(REF_NAME);
  sh.getRange('A1').setValue('주기'); sh.getRange('B1').setValue('월 발생횟수');
  sh.getRange(2, 1, FREQ.length, 2).setValues(FREQ);
}

// ----------------------------------------------------------------- 업무마스터 / 템플릿
function buildMaster_(ss, name, titleText, rows, nBlank) {
  var sh = ss.insertSheet(name);
  var nCol = COLS.length;
  sh.setHiddenGridlines(true);

  // 타이틀
  sh.getRange(1, 1, 1, nCol).merge().setValue(titleText)
    .setBackground(NAVY).setFontColor(WHITE).setFontSize(14).setFontWeight('bold')
    .setVerticalAlignment('middle');
  sh.setRowHeight(1, 34);
  // 가이드
  sh.getRange(2, 1, 1, nCol).merge().setValue(
    '입력 가이드  |  ① 회당 소요시간 + 주기만 넣으면 \'월 환산 시간\'이 자동 계산됩니다.  ' +
    '② \'수시\' 업무는 \'월 발생횟수(직접)\' 칸에 한 달 평균 횟수를 직접 입력하세요.  ' +
    '③ 주담당/백업담당/분류 등은 셀 클릭 시 드롭다운에서 선택.')
    .setBackground(LLBLUE).setFontColor(GREY).setFontSize(9)
    .setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(2, 30);

  // 헤더(3행)
  var hdr = COLS.map(function (c) { return c[0]; });
  sh.getRange(3, 1, 1, nCol).setValues([hdr])
    .setBackground(BLUE).setFontColor(WHITE).setFontWeight('bold').setFontSize(10)
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(3, 34);
  for (var j = 0; j < nCol; j++) sh.setColumnWidth(j + 1, COLS[j][1]);

  var first = 4;
  // 데이터 채우기
  if (rows.length) {
    var values = rows.map(function (rw) {
      // rw 인덱스: 0업무명1분류2설명3주담당4백업5주기6회당7월횟수직접8역량9난이도10자동화11우선순위12비고
      return ['', rw[0], rw[1], rw[2], rw[3], rw[4], rw[5], rw[6], rw[7],
              '', rw[8], rw[9], rw[10], rw[11], rw[12]];
    });
    sh.getRange(first, 1, values.length, nCol).setValues(values);
  }
  var last = first + Math.max(rows.length, 0) + nBlank - 1;
  if (last < first) last = first + nBlank - 1;

  // 공식: No(A), 월환산(J)  — 데이터+빈행 전체
  var noF = [], jF = [];
  for (var r = first; r <= last; r++) {
    noF.push(['=IF($B' + r + '="","",ROW()-3)']);
    jF.push(['=IF($B' + r + '="","",$H' + r + '*IF($I' + r + '<>"",$I' + r +
             ',IFERROR(VLOOKUP($G' + r + ',' + REF_NAME + '!$A$2:$B$11,2,FALSE),0)))']);
  }
  sh.getRange(first, 1, noF.length, 1).setFormulas(noF);
  sh.getRange(first, 10, jF.length, 1).setFormulas(jF);

  // 합계 행
  var totalRow = last + 1;
  sh.getRange(totalRow, 2).setValue('합계 / 월 총 투입시간').setFontWeight('bold').setFontColor(NAVY);
  sh.getRange(totalRow, 10).setFormula('=SUM(J' + first + ':J' + last + ')')
    .setNumberFormat('0.0').setFontWeight('bold').setFontColor(NAVY).setHorizontalAlignment('center');
  sh.getRange(totalRow, 1, 1, nCol).setBackground(LBLUE);

  // 서식: 본문 폰트/테두리/정렬/줄무늬
  var body = sh.getRange(first, 1, last - first + 1, nCol);
  body.setFontSize(10).setBorder(true, true, true, true, true, true, '#D9D9D9', SpreadsheetApp.BorderStyle.SOLID)
      .setVerticalAlignment('middle').setWrap(true);
  // 가운데 정렬 컬럼
  [1, 7, 8, 9, 10, 13, 14].forEach(function (c) {
    sh.getRange(first, c, last - first + 1, 1).setHorizontalAlignment('center');
  });
  sh.getRange(first, 8, last - first + 1, 1).setNumberFormat('0.0');
  sh.getRange(first, 9, last - first + 1, 1).setNumberFormat('0.0');
  sh.getRange(first, 10, last - first + 1, 1).setNumberFormat('0.0');
  // 줄무늬(은은하게)
  for (var rr = first; rr <= last; rr += 2) sh.getRange(rr, 1, 1, nCol).setBackground(LGREY);

  // 드롭다운(데이터 유효성)
  applyList_(sh, 3, first, last, CATS);     // C 분류
  applyList_(sh, 5, first, last, MEMBERS);  // E 주담당
  applyList_(sh, 6, first, last, MEMBERS);  // F 백업
  applyList_(sh, 7, first, last, FREQ_LIST);// G 주기
  applyList_(sh, 12, first, last, DIFF);    // L 난이도
  applyList_(sh, 13, first, last, AUTO);    // M 자동화
  applyList_(sh, 14, first, last, PRIO);    // N 우선순위

  // 조건부 서식: 우선순위 '상' 빨강, 대체난이도 '높음' 노랑
  var rules = sh.getConditionalFormatRules();
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('상').setBackground(RED).setFontColor(RED_T)
    .setRanges([sh.getRange(first, 14, last - first + 1, 1)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('높음(전담 필수)').setBackground(YELLOW).setFontColor(YELLOW_T)
    .setRanges([sh.getRange(first, 12, last - first + 1, 1)]).build());
  sh.setConditionalFormatRules(rules);

  sh.setFrozenRows(3);
  return { first: first, last: last, sheet: sh };
}

function applyList_(sh, col, first, last, list) {
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(list, true)
    .setAllowInvalid(false).build();
  sh.getRange(first, col, last - first + 1, 1).setDataValidation(rule);
}

// ----------------------------------------------------------------- 팀원별 부하
function buildDashboard_(ss, mFirst, mLast) {
  var sh = ss.insertSheet(DASH_NAME);
  sh.setHiddenGridlines(true);
  var headers = ['팀원', '직무/역할', '주당\n가용(h)', '월 가용\n(h)', '월 투입(h)\n(주담당)',
                 '담당\n업무수', '부하율', '여력(h)\n(월)', '상태', '백업\n지정수'];
  var nCol = headers.length;
  var widths = [170, 120, 75, 75, 95, 70, 80, 80, 95, 70];
  for (var j = 0; j < nCol; j++) sh.setColumnWidth(j + 1, widths[j]);

  sh.getRange(1, 1, 1, nCol).merge().setValue('② 팀원별 업무 부하 대시보드  (자동 계산)')
    .setBackground(NAVY).setFontColor(WHITE).setFontSize(14).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(1, 34);
  sh.getRange(2, 1, 1, nCol).merge().setValue(
    '기준: 주당 가용 ' + WEEKLY_CAP + '시간(회의·휴식 제외 실작업) × ' + MONTH_FACTOR + '주 = 월 가용시간.  ' +
    '투입시간은 ① 업무마스터의 \'주담당\' 기준으로 자동 합산됩니다.  ' +
    '부하율 70%↑ 과부하 / 40~70% 적정 / 40%↓ 여유. (정기 업무 기준 — 나머지는 회의·돌발업무 몫)')
    .setBackground(LLBLUE).setFontColor(GREY).setFontSize(9).setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(2, 32);

  sh.getRange(3, 1, 1, nCol).setValues([headers]).setBackground(BLUE).setFontColor(WHITE)
    .setFontWeight('bold').setFontSize(10).setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(3, 34);

  var first = 4;
  var M = "'" + MASTER_NAME + "'";
  var rng = '$E$' + mFirst + ':$E$' + mLast;
  var jrng = '$J$' + mFirst + ':$J$' + mLast;
  var frng = '$F$' + mFirst + ':$F$' + mLast;
  for (var i = 0; i < MEMBERS.length; i++) {
    var r = first + i;
    sh.getRange(r, 1).setValue(MEMBERS[i]);
    sh.getRange(r, 2).setValue(ROLES[i]).setHorizontalAlignment('center');
    sh.getRange(r, 3).setValue(WEEKLY_CAP).setHorizontalAlignment('center');
    sh.getRange(r, 4).setFormula('=C' + r + '*' + MONTH_FACTOR).setNumberFormat('0.0').setHorizontalAlignment('center');
    sh.getRange(r, 5).setFormula('=SUMIF(' + M + '!' + rng + ',$A' + r + ',' + M + '!' + jrng + ')')
      .setNumberFormat('0.0').setHorizontalAlignment('center');
    sh.getRange(r, 6).setFormula('=COUNTIF(' + M + '!' + rng + ',$A' + r + ')').setHorizontalAlignment('center');
    sh.getRange(r, 7).setFormula('=IFERROR(E' + r + '/D' + r + ',0)').setNumberFormat('0%').setHorizontalAlignment('center');
    sh.getRange(r, 8).setFormula('=D' + r + '-E' + r).setNumberFormat('0.0').setHorizontalAlignment('center');
    sh.getRange(r, 9).setFormula('=IF(G' + r + '>=0.7,"⚠ 과부하",IF(G' + r + '>=0.4,"적정","🟢 여유"))').setHorizontalAlignment('center');
    sh.getRange(r, 10).setFormula('=COUNTIF(' + M + '!' + frng + ',$A' + r + ')').setHorizontalAlignment('center');
  }
  var last = first + MEMBERS.length - 1;

  // 합계 행
  var tr = last + 1;
  sh.getRange(tr, 1).setValue('팀 합계 / 평균').setFontWeight('bold').setFontColor(NAVY);
  sh.getRange(tr, 4).setFormula('=SUM(D' + first + ':D' + last + ')').setNumberFormat('0.0');
  sh.getRange(tr, 5).setFormula('=SUM(E' + first + ':E' + last + ')').setNumberFormat('0.0');
  sh.getRange(tr, 6).setFormula('=SUM(F' + first + ':F' + last + ')');
  sh.getRange(tr, 7).setFormula('=IFERROR(E' + tr + '/D' + tr + ',0)').setNumberFormat('0%');
  sh.getRange(tr, 8).setFormula('=SUM(H' + first + ':H' + last + ')').setNumberFormat('0.0');
  sh.getRange(tr, 1, 1, nCol).setBackground(LBLUE).setFontWeight('bold').setFontColor(NAVY)
    .setHorizontalAlignment('center');
  sh.getRange(tr, 1).setHorizontalAlignment('left');

  sh.getRange(first, 1, last - first + 1, nCol)
    .setBorder(true, true, true, true, true, true, '#D9D9D9', SpreadsheetApp.BorderStyle.SOLID)
    .setVerticalAlignment('middle');

  // 조건부 서식: 부하율 색상 스케일 + 상태 색
  var rules = sh.getConditionalFormatRules();
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .setGradientMaxpointWithValue(RED, SpreadsheetApp.InterpolationType.NUMBER, '1')
    .setGradientMidpointWithValue(YELLOW, SpreadsheetApp.InterpolationType.NUMBER, '0.55')
    .setGradientMinpointWithValue(GREEN, SpreadsheetApp.InterpolationType.NUMBER, '0')
    .setRanges([sh.getRange(first, 7, last - first + 1, 1)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('과부하').setBackground(RED).setFontColor(RED_T).setBold(true)
    .setRanges([sh.getRange(first, 9, last - first + 1, 1)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('여유').setBackground(GREEN).setFontColor(GREEN_T).setBold(true)
    .setRanges([sh.getRange(first, 9, last - first + 1, 1)]).build());
  sh.setConditionalFormatRules(rules);

  sh.setFrozenRows(3);
}

// ----------------------------------------------------------------- 긴급배분 가이드
function buildUrgent_(ss) {
  var sh = ss.insertSheet(URG_NAME);
  sh.setHiddenGridlines(true);
  var widths = [170, 110, 90, 95, 110, 120, 230];
  for (var j = 0; j < widths.length; j++) sh.setColumnWidth(j + 1, widths[j]);

  sh.getRange(1, 1, 1, 7).merge().setValue('③ 긴급 업무 배분 가이드')
    .setBackground(NAVY).setFontColor(WHITE).setFontSize(14).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(1, 34);
  sh.getRange(2, 1, 1, 7).merge().setValue(
    '갑작스런 업무 발생 시 ① 필요 역량이 맞는 사람을 먼저 추리고 → ② 아래 표에서 \'여력(h)\'이 큰 사람에게 배정하세요.  ' +
    'B3 셀에 예상 소요시간(월,h)을 입력하면 누가 수용 가능한지 자동 표시됩니다.')
    .setBackground(LLBLUE).setFontColor(GREY).setFontSize(9).setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(2, 32);

  sh.getRange('A3').setValue('▶ 긴급업무 예상 소요시간 (월, h):').setFontWeight('bold').setFontColor(NAVY);
  sh.getRange('B3').setValue(45).setBackground(INPUT_BG).setFontWeight('bold').setHorizontalAlignment('center')
    .setBorder(true, true, true, true, false, false, YELLOW_T, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.getRange('C3').setValue('← 노란 칸에 입력').setFontColor(GREY).setFontSize(9);

  var uhdr = ['팀원', '현재 부하율', '여력(h,월)', '상태', '수용 가능?', '여유 후 부하율', '비고'];
  sh.getRange(5, 1, 1, 7).setValues([uhdr]).setBackground(BLUE).setFontColor(WHITE)
    .setFontWeight('bold').setFontSize(10).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.setRowHeight(5, 30);

  var first = 6;
  var D = "'" + DASH_NAME + "'";
  for (var i = 0; i < MEMBERS.length; i++) {
    var r = first + i;
    var dr = 4 + i; // 대시보드 데이터 행
    sh.getRange(r, 1).setFormula('=' + D + '!A' + dr);
    sh.getRange(r, 2).setFormula('=' + D + '!G' + dr).setNumberFormat('0%').setHorizontalAlignment('center');
    sh.getRange(r, 3).setFormula('=' + D + '!H' + dr).setNumberFormat('0.0').setHorizontalAlignment('center');
    sh.getRange(r, 4).setFormula('=' + D + '!I' + dr).setHorizontalAlignment('center');
    sh.getRange(r, 5).setFormula('=IF(C' + r + '>=$B$3,"✅ 가능","❌ 어려움")').setHorizontalAlignment('center');
    sh.getRange(r, 6).setFormula('=IFERROR((' + D + '!E' + dr + '+$B$3)/' + D + '!D' + dr + ',0)')
      .setNumberFormat('0%').setHorizontalAlignment('center');
  }
  var last = first + MEMBERS.length - 1;
  sh.getRange(first, 1, last - first + 1, 7)
    .setBorder(true, true, true, true, true, true, '#D9D9D9', SpreadsheetApp.BorderStyle.SOLID)
    .setVerticalAlignment('middle');

  var rules = sh.getConditionalFormatRules();
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('가능').setBackground(GREEN).setFontColor(GREEN_T).setBold(true)
    .setRanges([sh.getRange(first, 5, last - first + 1, 1)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('어려움').setBackground(RED).setFontColor(RED_T)
    .setRanges([sh.getRange(first, 5, last - first + 1, 1)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberGreaterThan(1).setBackground(RED).setFontColor(RED_T).setBold(true)
    .setRanges([sh.getRange(first, 6, last - first + 1, 1)]).build());
  sh.setConditionalFormatRules(rules);

  // 활용 팁
  var nr = last + 2;
  sh.getRange(nr, 1).setValue('💡 활용 팁').setFontWeight('bold').setFontColor(NAVY).setFontSize(11);
  var tips = [
    '• 역량 매칭: 먼저 \'① 업무마스터\'의 \'필요 역량/스킬\'·\'백업담당\'을 보고 후보를 좁히세요.',
    '• 대체 난이도가 \'높음(전담 필수)\'인 업무는 긴급 이관이 어렵습니다 — 백업담당 사전 양성이 핵심.',
    '• \'여유 후 부하율\'이 100%를 넘으면(빨강) 그 사람도 과부하가 되므로 분할 배정을 검토하세요.',
    '• 반복적으로 과부하가 잡히면 \'자동화 가능\' 업무부터 줄여 구조적으로 여력을 확보하세요.'
  ];
  for (var t = 0; t < tips.length; t++) {
    sh.getRange(nr + 1 + t, 1, 1, 7).merge().setValue(tips[t]).setFontSize(10).setVerticalAlignment('middle');
  }
}

// ----------------------------------------------------------------- 사용안내
function buildGuide_(ss) {
  var sh = ss.insertSheet(GUIDE_NAME);
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 24); sh.setColumnWidth(2, 170);
  for (var c = 3; c <= 6; c++) sh.setColumnWidth(c, 130);

  sh.getRange('B2:F2').merge().setValue('팀 R&R · 업무량 · 긴급배분 관리 시트')
    .setBackground(LLBLUE).setFontColor(NAVY).setFontSize(17).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(2, 40);
  sh.getRange('B3:F3').merge().setValue('기획/PM/운영 팀용 · 주당 가용 32시간 기준 · 회당시간×주기 자동 월환산')
    .setFontColor(GREY).setFontSize(10);

  var row = 5;
  row = guideSection_(sh, row, '이 파일의 구성', [
    '📑 ① 업무마스터(R&R) : 모든 업무를 한 줄씩 기록하는 핵심 시트(샘플 36개). 누가 주담당/백업인지, 얼마나 걸리는지, 누가 꼭 해야 하는지 정리.',
    '📊 ② 팀원별 부하 : 위 데이터를 사람별로 자동 합산 — 누가 과부하이고 누가 여유 있는지 한눈에.',
    '🚨 ③ 긴급배분 가이드 : 갑작스런 업무가 생겼을 때 \'누가 받을 수 있는지\'를 예상 소요시간 입력만으로 확인.',
    '📝 빈 템플릿 : 샘플을 지운 깨끗한 양식. 우리 팀 실제 내용으로 채우면 됩니다.'
  ]);
  row = guideSection_(sh, row, '작성 순서 (3단계)', [
    '1단계  \'빈 템플릿\' 또는 \'① 업무마스터\'에 팀의 모든 업무를 한 줄씩 적습니다.',
    '2단계  각 업무의 \'회당 소요시간\'과 \'주기\'를 입력 → \'월 환산 시간\'이 자동 계산. \'수시\'는 \'월 발생횟수(직접)\'에 평균 횟수 입력.',
    '3단계  \'주담당/백업담당/대체난이도/자동화/우선순위\'를 드롭다운에서 선택. → ②·③ 시트는 자동으로 채워집니다.'
  ]);
  row = guideSection_(sh, row, '각 항목의 의미', [
    '• 주담당 / 백업담당 : 평소 담당자와, 부재·과부하 시 대신할 사람. (백업이 비면 \'버스 팩터\' 위험!)',
    '• 주기 : 매일·주간·격주·월간·분기 등. 월 발생횟수로 환산되어 업무량 계산의 기준이 됩니다.',
    '• 대체 난이도 : \'낮음=누구나\' / \'중간=인수인계 필요\' / \'높음=전담 필수\'. 긴급 이관 가능성의 핵심 지표.',
    '• 자동화 가능성 : \'가능/일부/불가\'. 구조적으로 업무량을 줄일 후보를 찾는 데 사용.',
    '• 우선순위 : 상/중/하. 여력이 부족할 때 무엇을 먼저 지킬지 판단.'
  ]);
  row = guideSection_(sh, row, '부하율 읽는 법', [
    '부하율 = 월 투입시간 ÷ 월 가용시간(주32h×4.33).   70%↑ = ⚠ 과부하 / 40~70% = 적정 / 40% 미만 = 🟢 여유',
    '※ \'정기적으로 추적되는 업무\'만 합산한 값입니다. 나머지 시간은 회의·소통·돌발업무 몫이며, 그 자체가 긴급 업무를 받을 \'여력\'입니다.',
    '※ 가용시간(주32h)은 \'② 팀원별 부하\'의 \'주당 가용(h)\' 칸에서 사람마다 조정할 수 있습니다.'
  ]);
  sh.getRange('B' + row + ':F' + row).merge()
    .setValue('수정/추가가 필요하면 언제든 말씀해 주세요. 컬럼 추가·부서별 분리 등 자유롭게 변형 가능합니다.')
    .setFontColor(GREY).setFontWeight('bold');
}

function guideSection_(sh, row, title, lines) {
  sh.getRange('B' + row + ':F' + row).merge().setValue(title)
    .setBackground(BLUE).setFontColor(WHITE).setFontSize(12).setFontWeight('bold').setVerticalAlignment('middle');
  sh.setRowHeight(row, 26);
  var r = row + 1;
  for (var i = 0; i < lines.length; i++) {
    sh.getRange('B' + r + ':F' + r).merge().setValue(lines[i]).setFontSize(10).setWrap(true).setVerticalAlignment('middle');
    r++;
  }
  return r + 1;
}

// ----------------------------------------------------------------- 탭 순서
function reorder_(ss, order) {
  for (var i = 0; i < order.length; i++) {
    var sh = ss.getSheetByName(order[i]);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  }
}
