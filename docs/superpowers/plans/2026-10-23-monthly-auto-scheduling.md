# 월별 자동 시험 일정 편성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 기존 수동 기능을 보존하면서 총 필요 가동시간·지정 시험실·두 배치 모드로 월별 시험을 현재 시점 이후의 연속 운영일에 편성하고 검토 후 일괄 등록한다.

**Architecture:** 기존 가동 규칙에 자동 예약용 일별 구간 해석을 추가하고, 순수 편성 계산과 서버 미리보기/확정을 분리한다. 기준시간은 버전 있는 설정으로 저장하고 확정 결과는 별도 SQLite 테이블에 저장하여 원자성과 재확정 중복 방지를 제공한다. 기존 캘린더·실적·CAPA는 공통 구간 해석을 사용한다.

**Tech Stack:** 기존 Node.js >=24, ESM, node:sqlite, node:test, Playwright, HTML/CSS/JavaScript. 새 런타임 의존성·외부 AI 서비스 없음. Windows/PowerShell 호환.

**Spec:** `docs/superpowers/specs/2026-10-23-monthly-auto-scheduling-design.md` (사용자 승인 2026-10-23).

## Global Constraints

- 독립 메뉴 `자동 시험 일정 편성`; 기존 `시험 계획 수립`과 수동 등록·수정·실적·캘린더·CAPA·계정 기능 유지.
- 시간은 양수의 0.5시간 단위, 내부 저장은 정수 분. 실제 기준시간을 추측하거나 기존 실적으로 자동 변경하지 않음.
- 입력 행은 최대 30개. 지정 시험실을 자동 변경하지 않으며 기존 예약은 자동 이동·수정·삭제하지 않음.
- 한국시간(UTC+9), 서버 현재 시각 이후의 30분 경계부터 선택 월 안에서만 배치.
- `빠른 배치`는 입력 순서, `완료 희망일 기준`은 희망일 오름차순/같으면 입력 순서.
- 일반 시험도 이어지는 운영일에 배치. 야간·휴식·휴일은 기존 규칙대로 처리하며 중간 점유 충돌을 건너뛰어 분할하지 않음.
- 기존 24시간 시험·열가진 휴식 예외·성능시험·Glass Wool·주말 적용 범위·엔진 동시 가동 예외 유지.
- 1회 탐색 최대 3초 또는 후보 100,000개. 이벤트 루프 양보. 전역 최적 배치 보장 없음.
- 미리보기 사용자별 30분 유효, DB에 시험 비저장. 전체 성공만 일괄 확정, 단일 트랜잭션 및 재확정 중복 방지.
- 최초 등록자는 확정한 계정. 개별 시험 삭제는 관리자/최초 등록자만 허용하며 확인·백업·현재 안전 장치 유지.
- 운영 DB·계정·인증키로 테스트하지 않음. 기존 미커밋 변경 보존, 삭제된 구형 `/api/autoplans/*` API 비활성 유지.

## Review Focus

1. 첫날 시작 시각이 마지막 날 종료 시각보다 늦은 15시간 시험도 올바르게 계산되어야 함 → Task 1의 16:00 시작/다음 운영일 종료 테스트.
2. 시간이 정확히 30분 경계일 때 이미 시작한 슬롯을 쓰거나 미리보기보다 늦은 확정으로 과거를 등록하면 안 됨 → Tasks 3, 5.
3. 계획 구간을 실제 가동시간으로 잘못 복사하거나 공휴일 추가로 과거 실적/최초 계획을 줄이면 안 됨 → Tasks 1, 4.
4. 두 사용자의 동시 확정·서버 재시작·일정 전체 삭제 이후 재시도로 같은 시험을 되살리거나 중복 생성하면 안 됨 → Tasks 4, 5.
5. 관리자 권한 취소/담당자 비활성화/모달 교체 중 비동기 요청이 오래된 권한·입력으로 확정되면 안 됨 → Tasks 5, 6.

## 파일 구조와 실행 전 주의

기존 파일을 대규모 재구성하지 않는다. 신규 파일의 책임:

- `src/operating-rules.mjs`: 기존 순수 가동 규칙과 시간/구간 유틸만 이동하는 공통 하위 모듈. schedule/consecutive-windows를 import하지 않음.
- `src/consecutive-windows.mjs`: 시작~종료 사이 이어지는 운영일의 점유 구간 생성/검증 및 요구시간 충족 구간 계산. operating-rules만 의존.
- `src/monthly-planner.mjs`: DB와 무관한 두 모드 편성 계산.
- `src/monthly-plan-service.mjs`: 사용자별 미리보기 수명, 스냅샷, 확정 및 멱등성 조정.
- `public/monthly-planner.js`: 별도 메뉴와 기준시간 표 UI. 브라우저용 전역 모듈 하나로 기존 app.js와 명시적 콜백만 연결.
- 신규 테스트는 각 Task의 `tests/*.test.mjs` 및 `tests/monthly-planner.spec.mjs`에 분리.

현재 HEAD `b47d49e`에는 설계서만 추가되어 있고, 이미 운영에 적용한 계정/삭제/화면 변경은 미커밋 상태다. HEAD만 체크아웃한 작업 공간을 최신 앱이라고 간주하지 않는다. 실행 시작 시 using-git-worktrees 스킬을 적용하고 현재 소스의 허용 목록 스냅샷을 보존한다. 격리 작업 공간은 현재 작업 파일의 추적/미추적 앱 소스를 모두 포함하는 기준점으로 만들고, 원래 체크아웃과 운영 DB는 그대로 둔다. `data/`, 인증키, 세션, node_modules, 백업, 테스트 산출물은 Git 기준점에 넣지 않는다. 첫 기준점과 이후 기능 커밋을 구분하며 푸시는 별도 요청 없이는 하지 않는다.

테스트의 기존 기준은 서버/로직 43개, 브라우저 14개다. 실행 직전 `npm.cmd test`와 `npm.cmd run test:ui`로 다시 확인하고 다르면 원인을 기록한다. 이 문서를 작성한 단계에서는 테스트나 구현을 실행 완료했다고 간주하지 않는다.

공통 타입(모든 시간 문자열은 ISO 8601 UTC, UI만 한국시간):

```js
// Window = { start: string, end: string }  // 점유 구간; 휴식 차감 전
// Standard = { equipmentId, testType, requiredMinutes: number|null, enabled: boolean }
// Standards = { version: number, entries: Standard[] }
// Item = { key, project, equipmentId, testType, ownerId, requiredMinutes: number|null,
//          includeWeekend: boolean, deadline: 'YYYY-MM-DD'|null }
// Assignment = { key, title, project, equipmentId, testType, ownerId, includeWeekend,
//                requiredMinutes, start, end, plannedWindows: Window[] }
// PlanInput = { month: 'YYYY-MM', mode: 'earliest'|'deadline', items: Item[] }
// PlanResult = { assignments: Assignment[], unplaced: {key,code,message}[], limited: boolean }
```

## Task 1: 연속 운영일 구간과 기존 계산 호환

**Files:** Create `src/operating-rules.mjs`, `src/consecutive-windows.mjs`, `tests/consecutive-windows.test.mjs`; Modify `src/schedule.mjs`의 expandReservation/activeIntervals, `tests/schedule.test.mjs`.

**Interfaces:**

- `operating-rules.mjs`는 현재 schedule의 `EQUIPMENT`, `DEFAULT_RULES`, `supportsWeekend`, `canRunTogether`, `reservationRules`, `MIN`, `DAY`, `OFFSET`, `isAroundClock`, `isContinuous`, `ms`, `dayStart`, `clock`, `isHoliday`, `isOperatingDay`, `validateInterval`, `merge`, `intersect`, `subtract`, `minutes`, `windows`를 같은 시그니처/동작으로 export한다. schedule은 기존 public export를 그대로 재export하고 공통 모듈과 consecutive-windows를 import한다. 이 일방향 의존으로 순환 import와 규칙 복제를 피한다.
- `consecutiveWindowsBetween(r, rules, { validateOperatingDays = true } = {}) -> Window[]`: 명시한 시작/종료 사이 첫날·마지막 날을 자르고 중간 운영일을 채운 점유 구간. r은 equipmentId/testType/start/end/includeWeekend를 포함.
- `fitConsecutiveHours({ equipmentId, testType, start, requiredMinutes, includeWeekend }, rules, limitEnd) -> Window[] | null`: 지정 시작 후보에서 요구시간을 정확히 채울 수 있으면 구간 반환, 종료 상한 초과면 null.
- `validatePlannedWindows(r, rules, { validateOperatingDays = true } = {}) -> Window[]`: 구간 정렬·30분 경계·전체 시작/종료 일치·운영일 연속성을 검증. 신규 저장은 canonical 연속 구간과 일치해야 함.
- 기존 `expandReservation(r, rules, options)`, `activeIntervals(r, rules)`, `operatingMinutes(r, rules)` 시그니처 유지. plannedWindows 없는 예약은 기존 분기 그대로 사용.

- [x] **1. 실패 테스트 작성:** 다음 값으로 명시적 결과를 검증한다. 기본 규칙·휴일 없는 월요일 2026-11-09 08:30의 engine-1 배압 시험 900분 → 월 08:30~20:30/화 08:30~14:00, 실가동 900분. 월 16:00 시작 900분도 다음 운영일들까지 계산 가능하며 종료 clock이 시작 clock보다 이르다고 거부하지 않는다. 토/일·공휴일은 건너뛰되 중간 운영일 누락 배열·역순·겹침·30분 미준수는 거부한다. endurance SN 900분은 야간 포함 한 구간이고, 열피로는 휴식 차감 없이 기존 운영시간만 사용한다.
- [x] **2. RED 확인:** `node --test tests/consecutive-windows.test.mjs` → 새 함수/계산이 없어 실패.
- [x] **3. 구현:** 위 공통 하위 모듈로 기존 순수 함수만 동작 변경 없이 이동하고 신규 계산에서 재사용한다. `validateOperatingDays:false` 조회에서는 새로 추가된 휴일을 현재 계획에서 제외하되 저장한 구간·최초 스냅샷을 고치지 않는다. 24시간 시험과 기존 수동 다일 동일 시간대 반복 분기는 그대로 보존한다.
- [x] **4. GREEN/회귀:** `node --test tests/consecutive-windows.test.mjs tests/schedule.test.mjs tests/holidays.test.mjs tests/store.test.mjs` → 모두 PASS. 기존 엔진 동시 가동 판정과 주말 특근 허용 범위도 기존 테스트로 확인.
- [x] **5. 커밋:** 격리 작업 공간에서 Task 1의 파일만 검토 후 `feat: support consecutive windows for automatic bookings`.

## Task 2: 시험실·시험항목별 기준시간

**Files:** Modify `src/store.mjs`; Create `tests/test-time-standards.test.mjs`.

**Interfaces:**

- `Store.testTimeStandards() -> Standards`: 현재 허용된 equipment/testType 조합을 모두 반환. 초기 version 0, 현재 28개 조합의 requiredMinutes null, enabled true.
- `Store.saveTestTimeStandards({ version, entries }) -> Standards`: 버전 일치 시 원자적으로 저장하고 version+1. `settings` 키는 `test-time-standards`.

- [x] **1. 실패 테스트 작성:** 초기 28개 조합/미등록 확인, 같은 항목의 시험실별 다른 값 저장, 30·900분 허용, 0/음수/31분/NaN/문자열/중복 조합/미허용 시험실 조합 거부, 오래된 version은 409. 설정 변경 후 기존 예약·실적·이력이 그대로임을 비교한다.
- [x] **2. RED 확인:** `node --test tests/test-time-standards.test.mjs` → 새 저장 기능이 없어 실패.
- [x] **3. 구현:** 기준표 변경은 허용된 조합의 정확한 목록을 유지한다. 관리자 화면에서 체크를 끄는 것은 자동 편성 사용 중지이며 기존 수동 시험종류를 삭제하지 않는다. 양수 30분 배수 또는 명시적 null만 저장한다. 입력 객체에 새 설정 키/인증키 등 임의 저장을 허용하지 않는다.
- [x] **4. GREEN:** 동일 명령 및 `npm.cmd test` → PASS.
- [x] **5. 커밋:** `feat: persist versioned test duration standards`.

## Task 3: 두 모드 월별 편성 계산

**Files:** Create `src/monthly-planner.mjs`, `tests/monthly-planner.test.mjs`.

**Interfaces:**

- `planMonthlySchedule({ input, standards, rules, reservations, downtimes, users, knownHolidayYears, nowMs }, { maxCandidates = 100000, maxSearchMs = 3000, yieldEvery = 128 } = {}) -> Promise<PlanResult>`.
- Consumes Task 1의 fitConsecutiveHours 및 기존 expandReservation/canRunTogether/activeIntervals, Task 2의 Standards.
- PlanInput은 위 공통 타입. requiredMinutes null이면 기준표 값 사용, 둘 다 미등록이면 오류. 행의 시간 override는 기준표에 저장하지 않음. enabled:false인 조합은 자동 편성 불가.

- [x] **1. 실패 테스트 작성:** 고정 nowMs에 대해 입력 순서와 희망일 순서가 다른 예제의 결과가 달라지는지 확인. 정확히 08:30 현재라면 최초 후보는 09:00, 08:31도 09:00. 다음 달은 월 시작부터, 과거 월은 거부. 희망일은 한국시간 그 다음 날 00:00까지 포함한다. 1~30행만 허용하고 deadline 모드의 누락/잘못된 날짜를 거부한다.
- [x] **2. RED 확인:** `node --test tests/monthly-planner.test.mjs` → 새 모듈/편성 결과가 없어 실패.
- [x] **3. 구현:** 시작 하한은 max(월 시작, floor(nowMs/1800000)*1800000+1800000), 종료는 다음 달 한국시간 월 경계와 희망일 끝 중 이른 값. 유효 범위는 기존 2000~2100년 안의 현재/미래 월. 고정 시험실의 30분 후보를 오름차순 탐색하고 각 후보에서 필요한 연속 운영일 전체를 확보한다. 충돌하면 후보 전체를 버린다. 휴식 중 시작해 실가동이 없는 접두 구간은 사용하지 않는다. 확정된 기존 점유 구간과 앞서 배치한 새 행 모두 같은 충돌 규칙으로 검사한다. 다른 시험실로 옮기거나 기존 예약을 갱신하지 않는다.
- [x] **4. 경계 테스트/GREEN:** 일반 15시간의 다음 날 잔여, 중간 운영일 점유로 후보 전체 이동, 엔진 예외 허용/같은 종류 거부, 설비 정지, 주말 옵션, 각 시험별 휴식과 24시간 예외, 월말 초과, 윤년, 미확인 휴일 자료를 테스트한다. 성능 상한은 monotonic 시간으로 재고 업무용 nowMs와 분리한다. yieldEvery를 작은 값으로 설정해 계산 도중 다른 이벤트가 먼저 처리됨을 검증한다. 탐색 한도는 limited:true와 미배치 사유로 반환하고 허위 불가능 판정을 하지 않는다. `node --test tests/monthly-planner.test.mjs` → PASS.
- [x] **5. 커밋:** `feat: calculate monthly schedules in two ordering modes`.

## Task 4: 새 구간의 저장·수동 수정·실적·일괄 확정

**Files:** Modify `src/store.mjs`, `server.mjs`의 actual/state/export 계산; Create `tests/monthly-bookings.test.mjs`; Extend `tests/reporting.test.mjs`, `tests/reservation-deletion.test.mjs`, `tests/schedule-deletion.test.mjs`.

**Interfaces:**

- 새 테이블 `monthly_schedule_batches(id TEXT PRIMARY KEY, userId TEXT NOT NULL, payload TEXT NOT NULL)`; 구형 automatic_plans와 별개이며 이전 행 변환 없음.
- `Store.monthlyScheduleRevision() -> string`: 예약/실적/설비 정지/공휴일을 포함한 현재 rules/기준시간/안전한 사용자 정보의 정규화 스냅샷 SHA256. 세션 토큰·암호 해시·API 키는 포함하지 않음.
- `Store.monthlyScheduleBatch(previewId, userId) -> { previewId, reservationIds, confirmedAt } | null`: 다른 사용자의 식별자 접근은 403.
- `Store.saveMonthlySchedule({ previewId, userId, revision, assignments, nowMs }) -> { previewId, reservationIds, confirmedAt }`: 원자적 저장과 멱등성.
- `Store.writeReservation(input, userId, id, { trustedAutomatic = false } = {})`는 내부 저장 경로만 확장. 외부 `saveReservation(input,userId,id)`는 시그니처 유지하며 새 POST의 reserved fields(plannedWindows/monthlySchedule)는 거부한다. 외부 PUT은 이 필드를 신뢰하지 않고 기존 저장 데이터와 변경된 표준 입력으로 서버에서 재계산한다.
- 새 메타데이터 `monthlySchedule:{batchId,requiredMinutes}`와 canonical plannedWindows. 기존 automaticPlan은 그대로 유지.
- `actualReservation(r, actual, rules) -> Reservation`을 `src/consecutive-windows.mjs`에 추가: 실제 start/end를 가진 예약 모양 객체 반환. 자동 예약은 실제 기간으로 plannedWindows를 재구성하고, 수동 예약은 해당 필드 없이 기존 해석을 유지한다. 호출자는 반환값을 기존 activeIntervals/operatingMinutes에 전달한다. 계획 메타데이터를 실제 시간 계산에 적용하지 않는다.

- [x] **1. 실패 테스트 작성:** 새 일반 900분 예약이 한 건으로 저장되고 최초 이력의 userId가 담당자가 아닌 확정자이며, 모든 구간 합계·CAPA·state·엑셀 계산이 900분인지 확인. 기존 같은 시간대 수동 예약은 종전 값 유지. 새 예약의 메모만 수정하면 창/기준시간 그대로, 날짜/시험실/종류 수정은 서버 재계산, 다른 소요시간이 되면 변경 후 계산을 보여줄 수 있도록 결과에 포함한다. 실적은 입력한 실제 기간을 계산하고 계획의 잔여일 구간에 묶이지 않는다.
- [x] **2. RED 확인:** `node --test tests/monthly-bookings.test.mjs` → 새 저장 경로가 없어 실패.
- [x] **3. 구현:** 새 구간이 있는 예약만 확장 분기를 사용한다. 기존 saveActual의 기간/설비 변경 보호를 유지하고 실제 가동의 휴일 제외 예외도 종전과 동일하게 적용한다. 최초 plannedIntervals 스냅샷·기준계획은 이후 공휴일/기준시간 변경에도 유지한다. 여러 예약은 transaction 안에서 writeReservation을 직접 호출하여 중첩 트랜잭션을 만들지 않는다.
- [x] **4. 원자성/GREEN:** 확정 결과 존재 여부를 먼저 조회해 재시작 이후 재확정도 같은 결과를 반환. 신규 확정은 revision/현재 사용자·담당자 활성 상태/모든 시작>=nowMs/구간·중복을 트랜잭션 안에서 검사. 두 번째 예약 저장에 SQL 실패를 주입하여 최초 이력과 배치 결과까지 모두 롤백되는지 확인. 전체 일정 삭제는 새 배치 테이블도 비우되 기준시간 설정을 유지한다. 개별 삭제 뒤 같은 확정 ID 재시도로 삭제 시험을 재생성하지 않는다. 전체 삭제 뒤 메모리에 이미 소모된 편성안도 부활시키지 않도록 Task 5와 연계한다. `npm.cmd test` → PASS.
- [x] **5. 커밋:** `feat: atomically persist automatic windows with legacy compatibility`.

## Task 5: 미리보기 수명·확정 서비스와 API

**Files:** Create `src/monthly-plan-service.mjs`, `tests/monthly-planner-api.test.mjs`; Modify `server.mjs`; Preserve `tests/planner-removal.test.mjs`의 구형 경로 비활성 계약.

**Interfaces:**

- `new MonthlyPlanService(store, holidaySync, { clock = () => Date.now() } = {})`.
- `preview(userId, input) -> Promise<{previewId,expiresAt,revision,result}>`: 서버 메모리에 사용자별 편성안 보관, 예약 DB 비저장. 동일 사용자 최대 5개 유지하며 초과 시 가장 오래된 미확정안을 제거한다.
- `confirm(userId, previewId) -> Promise<{previewId,reservationIds,confirmedAt}>`: 저장된 확정 결과가 있으면 먼저 반환; 없으면 소유자/30분 만료/모든 항목 배치/스냅샷/현재 시각 검사 후 Task 4 호출. 성공한 메모리 편성안은 제거한다.
- 새 경로: `GET /api/test-time-standards`(활성 사용자), `PUT /api/test-time-standards`(관리자), `POST /api/monthly-schedules/preview`, `POST /api/monthly-schedules/confirm`(활성 사용자, body는 {previewId}만).
- 기존 `/api/autoplans/preview`, `/api/autoplans/confirm`은 계속 404. 새 UI page key는 monthly-planner로 구형 planner와 구분.

- [x] **1. 실패 테스트 작성:** API 인증/CSRF, 팀원의 기준시간 수정 403, 미리보기 예약 비저장, 미배치가 있으면 확정 거부, 다른 사용자 previewId 403, 만료·서버 재시작 후 미확정안 거부, 입력 배열을 confirm에 위조해도 등록 불가. 서버 테스트 clock으로 현재 경과를 제어하고 브라우저가 보낸 now는 사용하지 않는지 확인.
- [x] **2. RED 확인:** `node --test tests/monthly-planner-api.test.mjs` → 새 API 404.
- [x] **3. 구현:** 먼저 해당 월의 휴일을 기존 HolidaySync로 갱신한다. await 후 세션/CSRF/계정·권한을 재검사하고 최신 스냅샷으로 편성한다. 계산 도중 데이터가 바뀌면 재생성 오류로 처리한다. HTTP 경계의 재인증과 Store 트랜잭션의 최종 검증을 모두 유지한다. 시각 경과만으로 스냅샷이 달라지지 않게 하되 확정 전 별도로 nowMs를 검사한다.
- [x] **4. 동시성/GREEN:** 두 독립 세션이 같은 빈 슬롯을 preview한 뒤 동시에 confirm → 한 요청 성공, 나머지 stale/conflict; 중복 없음. 권한/CSRF 변경을 휴일 응답 대기 중 주입하면 쓰기 차단. 담당자 비활성화/기준시간/공휴일/설비 정지/예약/실적 변경은 재편성 요구. 같은 ID 재확정은 시각이 지나도 기존 성공 결과를 반환하며 신규 생성 안 함. 기존 `/api/autoplans/*` 비활성 테스트는 그대로 통과. `npm.cmd test` → PASS.
- [x] **5. 커밋:** `feat: expose safe monthly preview and confirmation APIs`.

## Task 6: 별도 메뉴·기준시간 표·편성 입력과 미리보기

**Files:** Create `public/monthly-planner.js`, `tests/monthly-planner.spec.mjs`; Modify `public/index.html`, `public/app.js`, `public/styles.css`.

**Interfaces:**

- index.html에서 monthly-planner.js를 app.js보다 먼저 defer 로드. `window.MonthlyPlannerUI.create({ api, onRegistered, getUsers, getEquipment, getRole })` → `{ render(), renderStandards(), handleClick(event), handleChange(event), invalidatePreview() }`.
- app.js는 데이터가 준비된 뒤 한 번 생성하며 renderSettings/render 메뉴에 반환 HTML을 연결한다. API/escape/icon 유틸은 콜백 또는 모듈 내부 최소 구현으로 제한하고 기존 앱 전체를 모듈화하지 않는다.
- 표준 UI 이름: `자동 시험 일정 편성`, `빠른 배치`, `완료 희망일 기준`, `편성안 만들기`, `일괄 확정 · 캘린더에 등록`, `시험항목별 기준시간`.

- [x] **1. 실패 테스트 작성:** 기존 메뉴가 그대로 보이면서 새 메뉴가 추가되는지, 초기 기준시간이 빈 값인지, 관리자 저장/팀원 읽기 전용인지 확인. 두 모드·시험실 제한·시간/희망일 입력·행 추가/제거·1~30 제한·미등록 및 미배치 확정 차단을 브라우저에서 검증한다.
- [x] **2. RED 확인:** `npx.cmd playwright test tests/monthly-planner.spec.mjs` → 새 UI가 없어 실패.
- [x] **3. 구현:** 입력 상태는 기존 검색 날짜·page 렌더링과 분리하여 15초 갱신/메뉴 왕복으로 사라지지 않게 한다. month 초기값은 현재 한국시간 월. 변경 시 previewId와 확정 버튼을 즉시 무효화한다. 기준표 단위는 시간, 전송 시 30분 배수 정수로 변환한다. 실시간 새 기준표가 로드돼도 사용자가 수정한 행 override를 조용히 덮어쓰지 않는다.
- [x] **4. 경계/GREEN:** 성공 후 기존 캘린더의 해당 월로 이동, 한 시험의 첫날 전체·마지막 날 잔여 구간과 가동시간 확인. 기존 reservationForm/detail에서 새 자동 시험의 수동 날짜 변경 후 서버가 계산한 가동시간과 변경 사유를 표시하고, 당시 요구시간과 구분해 브라우저 테스트한다. 기존 수정/실적/삭제 흐름, 담당자와 최초 등록자 구분, 비활성 사용자 제거, 모바일 390px 레이아웃, 오류 후 입력 유지, 더블클릭 확정 중복 방지 검증. 미리보기/확정 대기 중 입력을 변경하거나 다른 메뉴로 이동하면 오래된 응답이 새 입력/모달을 덮어쓰지 않도록 세대 번호와 previewId를 확인한다. `npm.cmd run test:ui` → 기존 14개와 신규 모두 PASS.
- [x] **5. 커밋:** `feat: add separate monthly scheduling and standards screens`.

## Task 7: 전체 검증·검토·운영 반영

**Files:** Modify `README.md`, `HANDOFF.md`, `docs/auto-planner.md`의 보관/새 기능 구분 안내. 운영 코드 재구성 없음.

**Interfaces:** Tasks 1~6에서 합의한 저장/API/UI 계약과 기존 `LabPlanner-PC-Web` 운영 작업을 사용한다.

- [x] **1. 전체 회귀:** `npm.cmd test`, `npm.cmd run test:ui`, `git diff --check` → 모두 성공. 수동 및 과거 자동 메타데이터가 있는 기준 예약으로 기존 기능 회귀를 확인한다. 테스트는 고정 서버 clock과 별도 DB/임시 백업 폴더를 사용한다. 실패 테스트를 누락해서 성공으로 보고하지 않는다.
- [x] **2. 새 검토자 코드 검토:** 요청 범위·데이터 보존·현재 시각·단일 트랜잭션·멀티 세션·일별 구간의 모든 소비자를 검토하고 Critical/Important를 해결한다. 테스트 결과와 검토 승인을 구분해 기록한다.
- [x] **3. 문서/커밋:** 사용 절차·기준시간 미등록·미배치·탐색 한도·실제 시간대·수동 수정 시 계산·복구 경로를 기록한다. 기존 과거 자동 기능 문서는 보관하고 새 기능과 구분한다. 관련 문서만 `docs: document monthly scheduling operations`로 커밋한다. 운영 배포 ZIP은 이전 스냅샷이므로 별도 재생성 요청 없이는 최신이라 안내하지 않는다.
- [ ] **4. 운영 전 백업:** 실제 DB/키를 Git에 넣지 않고 `node scripts/backup.mjs`로 검증 백업한다. 앱이 실행할 소스가 검증한 작업 공간 버전과 일치하는지 확인한다. 원래 체크아웃의 사용자 변경을 덮어쓰지 않는 통합 상태가 아니면 배포를 멈추고 조정한다.
- [ ] **5. 운영 반영:** 정상 검증 후에만 `LabPlanner-PC-Web` 작업을 재시작. 기존 사용자·예약·실적·이력·기준계획·설비 정지의 행 해시, SQLite 무결성, localhost와 사내 IP HTTP 응답, 서비스 계정 실행, 새 정적 자산 제공을 확인한다. 실제 운영 시험 생성/삭제로 테스트하지 않는다.
- [ ] **6. 결과 인계:** 구현/검증 결과와 아직 확인하지 않은 다른 물리 PC 접속·실제 시험별 기준값 입력을 구분한다. 앱의 새 화면을 열고 실제 기본시간은 관리자가 등록해야 함을 안내한다.

## 검토 및 실행 방식 선택

실행 상태: 2026-10-23 사용자 승인 후 Native로 Tasks 1~6 구현. 로직 63개/브라우저 18개 통과, 별도 검토의 중요 지적 3건을 실패 재현 후 수정. Task 7의 운영 백업·통합·재시작은 브랜치 통합 방식 선택 대기이며 운영 앱/DB는 아직 변경하지 않았다. 신규 테이블은 테스트 DB에서만 생성했다.

- Native(권장): 이 세션에서 Task 순서대로 직접 구현하고 마지막에 별도 코드 검토. 공통 가동 구간/저장/API가 서로 강하게 의존하므로 인터페이스 조정을 한곳에서 관리한다.
- Subagent-driven: Task별 구현자와 검토자를 분리하고 마지막에 전체 검토. 독립 검토가 더 촘촘하지만 세션/검토 비용이 더 든다.

사용자가 이 계획을 검토하고 실행 방식을 선택하면 해당 실행 스킬을 읽고 진행한다. 설계서 승인만으로 제품 코드 구현이나 운영 반영을 완료했다고 보고하지 않는다.
