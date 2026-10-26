const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = name => `<i data-lucide="${name}"></i>`;
const icons = () => window.lucide?.createIcons();
const local = value => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 16);
const dayOf = value => local(value).slice(0, 10);
const today = () => dayOf(new Date());
const midnight = day => `${day}T00:00:00+09:00`;
const addDays = (day, count) => dayOf(new Date(new Date(midnight(day)).getTime() + count * 86400000));
const weekday = day => new Date(midnight(day)).getUTCDay() === 6 ? 0 : (new Date(midnight(day)).getUTCDay() + 1) % 7;
const daysLabel = ['일', '월', '화', '수', '목', '금', '토'];
const supportsWeekend = id => ['engine-1', 'engine-2', 'flow'].includes(id);
const dateText = value => `${local(value).slice(5, 10).replace('-', '.')} ${local(value).slice(11)}`;
const timeText = value => local(value).slice(11);
const hours = minutes => (minutes / 60).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
const iso = value => new Date(value + ':00+09:00').toISOString();
const statusClass = value => ({ 진행: 'running', 완료: 'complete', 취소: 'cancelled' })[value] || '';
let me, csrf = '', setup = false, data, capa = [], page = 'schedule', mode = 'week', date = today(), refreshBusy = false;
let search = '', owner = '', status = '', actualState = '';
let range = null, rangeDraft = false, refreshQueued = false;
let todayPopupPending = false;
let monthlyPlanner;
const plannerUI=()=>monthlyPlanner ||= window.MonthlyPlannerUI.create({api,getUsers:()=>data.users,getEquipment:()=>data.equipment,getRole:()=>me?.role,getStandards:()=>data.testTimeStandards,redraw:()=>{if(me)render();},onRegistered:async month=>{if(month){date=month+'-01';mode='month';clearRange();page='schedule';toast('자동 편성 시험을 등록했습니다.');}await refresh();}});
const userName = id => { const u = data.users.find(u => u.id === id); return u ? u.name + (u.active === false ? ' (삭제됨)' : '') : '미지정'; };
const equipmentName = id => data.equipment.find(e => e.id === id)?.name || id;
const holidayName = day => data.rules.holidays.filter(h => h.date === day).map(h => h.name).join(' / ');
function holidaySummary() {
  const p = period(), operating = p.days.filter(d => data.rules.days.includes(weekday(d))), excluded = operating.filter(d => holidayName(d));
  const unknown = [...new Set(p.days.map(d => Number(d.slice(0, 4))))].filter(y => !data.holidayYears.includes(y));
  return `<div class="holiday-summary"><span>기본 가동일 ${operating.length - excluded.length}일 · 공휴일 제외 ${excluded.length}일 · 단품 대상내구 ${p.days.length}일</span>${p.days.length === 1 && holidayName(p.start) ? `<strong class="holiday-name">${esc(holidayName(p.start))}</strong>` : ''}${unknown.length ? `<span class="holiday-warning" role="status">${unknown.join(', ')}년 국가 공휴일 자료 미등록 — 가동일수·CAPA 확인 필요</span>` : ''}<small>국가 공휴일 자료: ${data.holidayYears.join('·')}년 · 공휴일 포함 기존 예약은 시험계획에서 확인</small></div>`;
}
function period() {
  let start = date, n = 1;
  if (range) { start = range.start; n = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86400000) + 1; }
  else if (mode === 'year') { start = date.slice(0, 4) + '-01-01'; n = (Date.UTC(Number(date.slice(0, 4)) + 1, 0, 1) - Date.parse(start)) / 86400000; }
  else if (mode === 'week') { start = addDays(date, -((weekday(date) + 6) % 7)); n = 7; }
  else if (mode === 'month') { start = date.slice(0, 7) + '-01'; const d = new Date(start + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); n = Math.round((d.getTime() - new Date(start + 'T00:00:00Z').getTime()) / 86400000); }
  const end = addDays(start, n); return { start, end, days: Array.from({ length: n }, (_, i) => addDays(start, i)) };
}
function filtered() {
  const p = period(); return data.reservations.filter(r => (!owner || r.ownerId === owner) && (!status || r.status === status) && (!actualState || (actualState === 'missing' && !data.actuals.some(a => a.reservationId === r.id))) && (!search || (r.title + ' ' + r.project).toLowerCase().includes(search.toLowerCase())) && r.start < new Date(midnight(p.end)).toISOString() && r.end > new Date(midnight(p.start)).toISOString());
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) { if (response.status === 401 && me) { me = null; showAuth(); } throw Object.assign(new Error(result.error || '요청을 처리하지 못했습니다.'), { code: result.code }); } return result;
}
function toast(message) { $('#toast').textContent = message; $('#toast').classList.remove('hidden'); setTimeout(() => $('#toast').classList.add('hidden'), 3200); }
function error(message) { $('#error-banner').textContent = message; $('#error-banner').classList.remove('hidden'); }
function showAuth() { monthlyPlanner?.invalidatePreview();monthlyPlanner=null; $('#auth-screen').classList.remove('hidden'); $('#app-screen').classList.add('hidden'); $('#logout').classList.add('hidden'); $('#user-name').textContent = ''; $('#sync-status').textContent = '로그인 대기'; }
async function init() {
  try {
    setup = (await api('/api/status')).setupRequired;
    $('#name-label').classList.toggle('hidden', !setup); $('#name-label input').required = setup;
    $('#auth-title').textContent = setup ? '첫 관리자 등록' : '연구동 시험설비 가동현황';
    $('#auth-subtitle').textContent = setup ? '운영 PC에서 관리자 계정을 등록해 주세요.' : '팀 계정으로 로그인해 주세요.';
    $('#auth-submit').innerHTML = `${setup ? '관리자 등록' : '로그인'}${icon('arrow-right')}`;
    if (!setup) { try { const account = await api('/api/me'); me = account.user; csrf = account.csrf; } catch {} }
    if (me) await enter(); else showAuth();
  } catch (e) { showAuth(); $('#auth-error').textContent = e.message; }
  icons();
}
async function enter() {
  todayPopupPending = true;
  $('#auth-screen').classList.add('hidden'); $('#app-screen').classList.remove('hidden'); $('#logout').classList.remove('hidden'); $('#user-name').textContent = me.name;
  $('#auth-form').reset(); await refresh();
}
async function refresh() {
  if (!me) return;
  if (refreshBusy) { refreshQueued = true; return; }
  refreshBusy = true;
  const p = period(), query = `start=${encodeURIComponent(midnight(p.start))}&end=${encodeURIComponent(midnight(p.end))}`;
  try {
    const nextData = await api('/api/state?' + query), nextCapa = await api('/api/capacity?' + query);
    const current = period();
    if (current.start !== p.start || current.end !== p.end) { refreshQueued = true; return; }
    data = nextData; capa = nextCapa; me = data.users.find(u => u.id === me?.id) || me; $('#user-name').textContent = me?.name || ''; $('#sync-status').textContent = '서버 연결됨'; $('#error-banner').classList.add('hidden'); render();
    showTodayTests();
  }
  catch (e) { error(e.message); $('#sync-status').textContent = '연결 확인 필요'; }
  finally { refreshBusy = false; if (refreshQueued) { refreshQueued = false; void refresh(); } }
}
function showTodayTests() {
  if (!todayPopupPending || !me || $('#modal').open || $('#conflict-popup').open) return;
  todayPopupPending = false;
  const day = today(), start = Date.parse(midnight(day)), end = start + 86400000;
  const tests = data.reservations.filter(r => ['계획', '진행'].includes(r.status)).map(r => ({ ...r,
    todayIntervals: (r.intervals || []).map(i => [Math.max(start, Date.parse(i.start)), Math.min(end, Date.parse(i.end))]).filter(([a, b]) => a < b)
  })).filter(r => r.todayIntervals.length).sort((a, b) => a.todayIntervals[0][0] - b.todayIntervals[0][0] || a.equipmentId.localeCompare(b.equipmentId));
  if (!tests.length) return;
  const planned = tests.filter(r => r.status === '계획').length;
  const clock = value => value === end ? '24:00' : timeText(value);
  modal('오늘의 시험 현황', `<section class="today-tests" aria-label="오늘의 시험 현황"><p class="today-tests-summary">${day} · 한국시간 기준<br>진행 예정 ${planned}건 · 진행 중 ${tests.length - planned}건</p><p class="muted">조회 기간·검색 조건과 관계없이 모든 시험실의 오늘 예약을 표시합니다. 상태는 등록된 값이며 실제 가동 여부를 자동 판단하지 않습니다.</p><div class="today-tests-list">${tests.map(r => `<article class="today-test"><div class="today-test-heading"><strong>${esc(equipmentName(r.equipmentId))}</strong><span class="tag ${statusClass(r.status)}">${esc(r.status)}</span></div><h3>${esc(r.title)}</h3><dl><div><dt>시험 항목</dt><dd>${esc(r.testType)}</dd></div><div><dt>프로젝트</dt><dd>${esc(r.project || '미등록')}</dd></div><div><dt>담당자</dt><dd>${esc(userName(r.ownerId))}</dd></div><div><dt>오늘 예약 시간</dt><dd>${r.todayIntervals.map(([a, b]) => `${clock(a)}~${clock(b)}`).join(' / ')}</dd></div></dl></article>`).join('')}</div><div class="form-actions"><button type="button" class="primary" data-close>확인</button></div></section>`);
}
function render() {
  if (!data || !me) return;
  const titles = { schedule: ['가동 현황', '장비별 시험 일정과 가동 시간을 확인합니다.'], tests: ['시험 계획 수립', '시험별 일정, 담당자와 진행 상태를 관리합니다.'], capacity: ['설비 CAPA 현황', '선택 기간의 가용 시간과 계획·실적을 비교합니다.'], history: ['기준계획 · 이력', '월간 기준계획과 현재 일정의 차이를 확인합니다.'], settings: ['운영 설정', '팀 계정과 설비 운영 기준을 관리합니다.'] };
  titles['monthly-planner']=['자동 시험 일정 편성','총 필요 가동시간으로 월별 일정을 검토하고 등록합니다.'];
  $('#page-title').textContent = titles[page][0]; $('#page-description').textContent = titles[page][1];
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('selected', b.dataset.mode === mode));
  $('#date-picker').value = date;
  const p = period(); $('#period-title').textContent = range ? `${p.start} ~ ${addDays(p.end, -1)}` : mode === 'year' ? `${date.slice(0, 4)}년` : mode === 'month' ? `${date.slice(0, 4)}년 ${Number(date.slice(5, 7))}월` : mode === 'day' ? `${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일 (${daysLabel[weekday(date)]})` : `${Number(p.start.slice(5, 7))}월 ${Number(p.start.slice(8))}일 – ${Number(addDays(p.end, -1).slice(5, 7))}월 ${Number(addDays(p.end, -1).slice(8))}일`;
  $('#period-title').classList.toggle('saturday', p.days.length === 1 && weekday(p.start) === 6 && !holidayName(p.start));
  $('#period-title').classList.toggle('sunday', p.days.length === 1 && (weekday(p.start) === 0 || !!holidayName(p.start)));
  if (!rangeDraft) { $('#range-start').value = p.start; $('#range-end').value = addDays(p.end, -1); }
  $('#range-status').textContent = range ? `기간 검색 적용 중 · 종료일 포함 ${p.days.length}일` : '종료일 포함 · 최대 10년 조회';
  $('#range-form').classList.toggle('applied', !!range);
  $('#search').value = search;
  $('#owner-filter').innerHTML = '<option value="">모든 담당자</option>' + data.users.map(u => `<option value="${u.id}">${esc(userName(u.id))}</option>`).join(''); $('#owner-filter').value = owner;
  const selected = filtered().filter(r => r.status !== '취소');
  const available = capa.reduce((sum, c) => sum + c.availableMinutes, 0), planned = capa.reduce((sum, c) => sum + c.plannedMinutes, 0);
  const running = selected.filter(r => r.status === '진행').length, missing = capa.reduce((sum, c) => sum + c.missingActuals, 0);
  $('#summary-strip').innerHTML = [
    ['관리 설비', '6', '대', '시험실 운영 기준 적용', 'boxes', false], ['등록된 시험', selected.length, '건', `진행 ${running}건 · 선택 기간`, 'clipboard-list', false],
    ['계획 점유율', available ? (planned / available * 100).toFixed(1) : '—', available ? '%' : '', `${hours(planned)} / ${hours(available)}시간 · 전체 설비`, 'gauge', true], ['실적 미입력', missing, '건', '계획 시간을 실적으로 대체하지 않음', 'clock-3', false]
  ].map(([label, v, unit, note, i, emphasis], index) => `<button class="metric" data-summary="${['equipment', 'tests', 'occupancy', 'missing'][index]}" type="button"><span class="metric-label">${icon(i)}${label}</span><span class="metric-value ${emphasis ? 'emphasis' : ''}">${v}<span>${unit}</span></span><span class="metric-note">${note}</span></button>`).join('');
  $('#new-test').classList.toggle('hidden', ['history', 'settings','monthly-planner'].includes(page));
  $('.filter-bar').classList.toggle('hidden', ['capacity', 'history', 'settings','monthly-planner'].includes(page));
  for(const selector of ['.toolbar','#range-form','#summary-strip'])$(selector).classList.toggle('hidden',page==='monthly-planner');
  $('#content').innerHTML = page === 'monthly-planner'?plannerUI().render():page === 'schedule' ? scheduleView() : page === 'tests' ? testsView() : page === 'capacity' ? capacityView() : page === 'history' ? historyView() : settingsView() + plannerUI().renderStandards() + holidaySettings() + scheduleDeleteSettings();
  $('#footer-status').textContent = `동기화 ${new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })}`;
  icons();
}
const clockRange = (start, end) => `<span class="clock-value">${esc(start)}</span><wbr>~<span class="clock-value">${esc(end)}</span>`;
function booking(r, interval, day) {
  const actual = data.actuals.find(a => a.reservationId === r.id);
  const a = new Date(midnight(day)).getTime(), b = a + 86400000;
  const parts = (actual?.intervals || []).filter(i => new Date(i.start).getTime() < b && new Date(i.end).getTime() > a).map(i => {
    const start = Math.max(a, new Date(i.start).getTime()), end = Math.min(b, new Date(i.end).getTime());
    return { start: timeText(start), end: end === b ? '24:00' : timeText(end) };
  });
  const label = !actual ? '실적 미입력' : actual.zero ? '실적 0시간' : parts.length ? '실적 ' + parts.map(p => `${p.start}~${p.end}`).join(' / ') : '당일 실적 없음';
  const actualContent = actual && !actual.zero && parts.length ? `<span class="actual-caption">실적</span> ${parts.map(p => clockRange(p.start, p.end)).join(' / ')}` : esc(label);
  const projectLabel = actual ? `<strong class="actual-project">${esc(r.project || r.title)}</strong>` : '';
  return `<div class="booking-entry" data-detail="${r.id}"><button class="booking ${statusClass(r.status)}" data-detail="${r.id}"><span class="time"><span class="plan-caption">${interval.excluded ? '공휴일 계획 제외' : '계획'}</span> ${clockRange(timeText(interval.start), timeText(interval.end))}</span><strong>${esc(r.title)}</strong><small>${esc(userName(r.ownerId))}${r.project ? ' · ' + esc(r.project) : ''}</small></button><div class="booking-actual ${!actual ? 'pending' : actual.zero ? 'zero' : ''}" title="${esc(actual ? (r.project || r.title) + ' · ' + label : label)}">${projectLabel}<span class="actual-value">${actualContent}</span></div></div>`;
}
function dayEntries(e, day) {
  const a = new Date(midnight(day)).getTime(), b = a + 86400000;
  const onDay = i => new Date(i.start).getTime() < b && new Date(i.end).getTime() > a;
  return filtered().filter(r => r.equipmentId === e.id && (status === '취소' || r.status !== '취소')).flatMap(r => {
    let intervals = r.intervals.filter(onDay);
    if (!intervals.length && holidayName(day)) intervals = (data.actuals.find(actual => actual.reservationId === r.id)?.intervals || []).filter(onDay).map(i => ({ ...i, excluded: true }));
    return intervals.map(i => ({ r, i: { ...i, start: new Date(Math.max(a, new Date(i.start).getTime())).toISOString(), end: new Date(Math.min(b, new Date(i.end).getTime())).toISOString() } }));
  });
}
function equipmentComparison(id) {
  const c = capa.find(c => c.id === id); if (!c) return '';
  const percent = c.originalAchievementPercent === null ? '—' : c.originalAchievementPercent.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '%';
  return `<div class="equipment-comparison"><dl><div><dt>최초 계획</dt><dd>${c.originalPlanMinutes === null ? '—' : hours(c.originalPlanMinutes) + ' h'}</dd></div><div><dt>실적${c.originalMissingActuals ? ' (입력분)' : ''}</dt><dd>${hours(c.actualMinutes)} h</dd></div><div><dt>달성률${c.originalMissingActuals ? ' (잠정)' : ''}</dt><dd>${percent}</dd></div></dl>${c.originalMissingActuals ? `<span class="comparison-pending">미입력 ${c.originalMissingActuals}건</span>` : ''}${c.unknownOriginalPlans ? `<span class="comparison-pending">최초 계획 확인 필요 ${c.unknownOriginalPlans}건</span>` : ''}</div>`;
}
function scheduleView() {
  const p = period();
  if (mode === 'year' || (range && p.days.length > 31)) return annualView();
  const daily = mode === 'day' && p.days.length === 1;
  const columns = daily ? Array.from({ length: 48 }, (_, i) => i * 30) : p.days;
  const head = columns.map(c => daily ? `<th><strong>${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}</strong></th>` : `<th class="${c === today() ? 'current' : ''} ${weekday(c) === 6 ? 'saturday' : weekday(c) === 0 ? 'sunday' : ''} ${holidayName(c) ? 'holiday' : ''}" title="${esc(holidayName(c))}">${daysLabel[weekday(c)]}<strong>${Number(c.slice(8))}</strong>${holidayName(c) ? `<small class="holiday-name">${esc(holidayName(c))}</small>` : ''}</th>`).join('');
  const rows = data.equipment.map(e => {
    const cells = columns.map(c => {
      const day = daily ? p.start : c, entries = dayEntries(e, day);
      const holiday = holidayName(day);
      const off = e.id !== 'endurance' && (holiday || !data.rules.days.includes(weekday(day)) || (daily && (c < data.rules.open || c >= data.rules.close || data.rules.breaks.some(([a, b]) => c >= a && c < b))));
      let contents;
      if (daily) {
        const start = new Date(midnight(day)).getTime() + c * 60000, end = start + 1800000;
        contents = entries.filter(({ i }) => new Date(i.start).getTime() < end && new Date(i.end).getTime() > start).map(({ r, i }) => booking(r, i, day)).join('');
      } else contents = entries.map(({ r, i }) => booking(r, i, day)).join('');
      const stop = data.downtimes.find(d => d.equipmentId === e.id && d.start < new Date(midnight(addDays(day, 1))).toISOString() && d.end > new Date(midnight(day)).toISOString());
      return `<td class="day-cell ${off ? 'off' : ''} ${holiday ? 'holiday' : ''} ${day === today() ? 'current' : ''}" title="${esc(holiday)}" data-slot="${e.id}" data-day="${day}" ${daily ? `data-minute="${c}"` : ''}>${contents || (stop ? `<span class="off-label">${esc(stop.reason)}</span>` : `<span class="${off ? 'off-label' : 'empty-slot'}">${off ? holiday ? '공휴일' : '비가동' : daily ? '' : '—'}</span>`)}</td>`;
    }).join('');
    return `<tr><td class="equipment-cell"><span class="equipment-mark">${icon(e.id.startsWith('engine') ? 'settings' : e.id.startsWith('thermal') ? 'thermometer' : e.id === 'endurance' ? 'infinity' : 'wind')}</span><strong>${esc(e.name)}</strong><small>${e.id === 'endurance' ? '24시간 · 주말 연속' : e.id.startsWith('thermal') ? '시험 종류별 휴식 적용' : '평일 기준 · 주말 예약 가능'}</small>${equipmentComparison(e.id)}</td>${cells}</tr>`;
  }).join('');
  return `${holidaySummary()}<div class="schedule-scroll"><table class="schedule-table ${daily ? 'day-table' : mode === 'month' ? 'month-table' : ''}"><thead><tr><th class="equipment-cell">시험실 / 설비</th>${head}</tr></thead><tbody>${rows}</tbody></table></div><div class="grid-caption"><span>기본 가동 08:30~20:30 · 휴식 12:30~13:30 / 17:30~18:00 · 공휴일 제외</span><span>단품 대상내구·SN 커브: 24시간 연속 · 성능시험·Glass Wool 내구: 기본 운영시간</span></div>`;
}
function annualView() {
  const p = period(), selected = filtered().filter(r => r.status !== '취소'), byId = new Map(selected.map(r => [r.id, r]));
  const days = new Map(p.days.map(d => [d, { plans: new Set(), actuals: new Set() }]));
  const indexIntervals = (intervals, id, kind) => {
    for (const i of intervals) {
      const a = Math.max(Date.parse(i.start), Date.parse(midnight(p.start))), b = Math.min(Date.parse(i.end), Date.parse(midnight(p.end)));
      if (b <= a) continue;
      const last = dayOf(b - 1);
      for (let d = dayOf(a); d <= last; d = addDays(d, 1)) days.get(d)?.[kind].add(id);
    }
  };
  for (const r of selected) indexIntervals(r.intervals, r.id, 'plans');
  for (const a of data.actuals.filter(a => byId.has(a.reservationId))) indexIntervals(a.intervals, a.reservationId, 'actuals');
  const months = [...new Set(p.days.map(d => d.slice(0, 7)))];
  const cards = months.map(month => {
    const first = month + '-01', next = new Date(first + 'T00:00:00Z'); next.setUTCMonth(next.getUTCMonth() + 1);
    const n = (next.getTime() - Date.parse(first)) / 86400000, activeDays = p.days.filter(d => d.startsWith(month));
    const operating = activeDays.filter(d => data.rules.days.includes(weekday(d))), excluded = operating.filter(d => holidayName(d));
    const tests = new Set(activeDays.flatMap(d => [...days.get(d).plans]));
    const cells = Array.from({ length: 42 }, (_, position) => {
      const number = position - weekday(first) + 1;
      if (number < 1 || number > n) return '<span class="annual-blank" aria-hidden="true"></span>';
      const day = `${month}-${String(number).padStart(2, '0')}`, entry = days.get(day), holiday = holidayName(day), week = weekday(day);
      const planCount = entry?.plans.size || 0, actualCount = entry?.actuals.size || 0;
      const names = entry ? [...new Set([...entry.plans, ...entry.actuals])].map(id => { const r = byId.get(id); return `${equipmentName(r.equipmentId)} · ${r.project || r.title} · ${r.status}`; }).join('\n') : '';
      const label = `${day}, 시험 ${planCount}건, 실적 ${actualCount}건${holiday ? ', ' + holiday : ''}`;
      return `<button type="button" class="annual-day ${week === 6 ? 'saturday' : week === 0 ? 'sunday' : ''} ${holiday ? 'holiday' : ''} ${planCount ? 'has-tests' : ''} ${day === today() ? 'current' : ''}" data-open-day="${day}" ${entry ? '' : 'disabled'} aria-label="${esc(label)}" title="${esc([day, holiday, names].filter(Boolean).join('\n'))}"><span>${number}</span><small>${planCount ? planCount + '건' : '&nbsp;'}</small>${actualCount ? `<span class="annual-actual" aria-hidden="true"></span>` : ''}</button>`;
    }).join('');
    return `<section class="annual-month" data-month="${month}"><div class="annual-month-heading"><button class="quiet" data-open-month="${month}" aria-label="${month.slice(0, 4)}년 ${Number(month.slice(5))}월 월간 보기"><strong>${month.slice(0, 4)}년 ${Number(month.slice(5))}월</strong>${icon('arrow-up-right')}</button><small>시험 ${tests.size}건</small></div><p>기본 가동 ${operating.length - excluded.length}일 · 공휴일 제외 ${excluded.length}일</p><div class="annual-weekdays">${daysLabel.map((d, i) => `<span class="${i === 6 ? 'saturday' : i === 0 ? 'sunday' : ''}">${d}</span>`).join('')}</div><div class="annual-days">${cells}</div>${activeDays.some(d => holidayName(d)) ? `<div class="annual-holidays">${activeDays.filter(d => holidayName(d)).map(d => `<span>${Number(d.slice(8))}일 ${esc(holidayName(d))}</span>`).join('')}</div>` : '<div class="annual-holidays">공휴일 없음</div>'}</section>`;
  }).join('');
  return `${holidaySummary()}<p class="muted">날짜를 누르면 일간 보기, 월 제목을 누르면 월간 보기로 이동합니다. 날짜별 시험 건수 · 초록 점은 실적 입력일${range ? ' · 조회 구간 밖 날짜는 비활성화' : ''}</p><div class="annual-grid">${cards}</div><div class="section-heading"><h2>${range ? '조회 구간' : '연간'} 설비별 가동현황</h2></div>${capacityView(false)}`;
}
function testsView() {
  const rows = filtered();
  if (!rows.length) return empty('등록된 시험이 없습니다.', '선택 기간과 검색 조건을 확인해 주세요.', true);
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>시험명 / 프로젝트</th><th>시험실</th><th>담당자</th><th>예약 기간</th><th>상태</th><th>실적</th><th></th></tr></thead><tbody>${rows.map(r => `<tr><td class="title-cell"><strong>${esc(r.title)}</strong><small>${esc(r.project || r.testType)}</small></td><td>${esc(equipmentName(r.equipmentId))}</td><td>${esc(userName(r.ownerId))}</td><td>${dateText(r.start)}<br><span class="muted">${dateText(r.end)}</span></td><td><span class="tag ${statusClass(r.status)}">${r.status}</span></td><td>${data.actuals.some(a => a.reservationId === r.id) ? '입력' : '<span class="muted">미입력</span>'}</td><td><button class="icon-button" data-detail="${r.id}" title="시험 상세" aria-label="시험 상세">${icon('arrow-up-right')}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function capacityView(showSummary = true) {
  return `${showSummary ? holidaySummary() : ''}<div class="table-wrap"><table class="data-table capacity-table"><thead><tr><th>시험실</th><th>가용 시간</th><th>계획 가동</th><th>계획 점유율</th><th>실적 가동</th><th>실적 가동률</th></tr></thead><tbody>${capa.map(c => {
    const percent = c.availableMinutes ? c.plannedMinutes / c.availableMinutes * 100 : null;
    return `<tr><td><b>${esc(c.name)}</b><small>${c.id === 'endurance' ? '24시간 × 운영일 · 정지시간 제외' : c.id.startsWith('thermal') ? '기본 가용 + 연속시험 휴식 가동 · 정지 제외' : '평일 가용 + 주말 예약 가동 · 정지 제외'}</small></td><td><strong>${hours(c.availableMinutes)}</strong> h</td><td><strong>${hours(c.plannedMinutes)}</strong> h</td><td>${percent === null ? '—' : percent.toFixed(1) + '%'}<div class="bar"><span style="width:${Math.min(percent || 0, 100)}%"></span></div></td><td><strong>${hours(c.actualMinutes)}</strong> h<small>${c.missingActuals ? `미입력 ${c.missingActuals}건` : '입력 완료'}</small></td><td>${c.missingActuals ? '<span class="muted">미입력 포함 · 미확정</span>' : c.availableMinutes ? (c.actualMinutes / c.availableMinutes * 100).toFixed(1) + '%' : '—'}</td></tr>`;
  }).join('')}</tbody></table></div><div class="grid-caption"><span>시간 단위: h · 예약 점유와 실제 가동 시간은 구분됩니다.</span><span>가동실적은 입력된 시험 기준이며, 미입력은 자동 추정하지 않습니다.</span></div>`;
}
function historyView() {
  const p = period(), month = p.start.slice(0, 7), last = addDays(p.end, -1).slice(0, 7), singleMonth = month === last;
  const baselines = data.baselines.filter(b => b.month >= month && b.month <= last).reverse();
  return `<div class="section-heading"><h2>${singleMonth ? month.replace('-', '년 ') + '월' : '조회 구간'} 기준계획</h2>${me.role === 'admin' && singleMonth ? `<button class="quiet" id="save-baseline">${icon('bookmark-plus')}현재 월 계획 확정</button>` : ''}</div>${!singleMonth ? '<p class="muted">기준계획 확정은 월간 보기에서 해당 월을 선택해 주세요.</p>' : ''}${baselines.length ? `<div class="baseline-list">${baselines.map(b => `<div class="baseline-item"><div><strong>${b.month} · ${dateText(b.at)} 기준계획</strong><small>${esc(userName(b.userId))} · 시험 ${b.reservations.length}건</small></div><button class="quiet" data-baseline="${b.id}">변경 비교${icon('arrow-right')}</button></div>`).join('')}</div>` : empty('저장된 기준계획이 없습니다.', '관리자가 월간 계획 확정 시점에 기준계획을 저장할 수 있습니다.')}<div class="section-heading"><h2>시험별 변경 이력</h2></div>${testsView()}`;
}
function settingsView() {
  const r = data.rules, p = period(), start = new Date(midnight(p.start)).toISOString(), end = new Date(midnight(p.end)).toISOString();
  const stops = data.downtimes.filter(d => !range || (d.start < end && d.end > start));
  const clock = v => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  return `<section class="setting-band"><h3>기본 운영 기준</h3><p>${r.days.map(d => daysLabel[d]).join(' · ')}요일 / ${clock(r.open)}~${clock(r.close)}<br>휴식 ${r.breaks.map(([a, b]) => `${clock(a)}~${clock(b)}`).join(' / ')}<br>열가진 연속시험과 단품 대상내구는 별도 기준 적용</p>${me.role === 'admin' ? `<div class="inline-actions"><button class="quiet" id="edit-rules">${icon('sliders-horizontal')}운영 기준 수정</button><button class="quiet" id="add-downtime">${icon('wrench')}설비 정지 등록</button></div>` : ''}</section>${userSettings()}<div class="section-heading"><h2>${range ? '조회 구간 ' : ''}설비 정지 일정</h2></div>${stops.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>시험실</th><th>기간</th><th>사유</th><th></th></tr></thead><tbody>${stops.map(d => `<tr><td>${esc(equipmentName(d.equipmentId))}</td><td>${dateText(d.start)}~${dateText(d.end)}</td><td>${esc(d.reason)}</td><td>${me.role === 'admin' ? `<button class="icon-button" data-remove-downtime="${d.id}" title="정지 일정 삭제" aria-label="정지 일정 삭제">${icon('trash-2')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('설비 정지 일정이 없습니다.', '')}`;
}
function userSettings() {
  const count = data.users.filter(u => u.active).length, admin = me.role === 'admin';
  return `<div class="section-heading"><h2>팀 계정 <span class="muted">사용 중 ${count}/6</span></h2>${admin ? `<button class="quiet" id="add-user" ${count >= 6 ? 'disabled' : ''}>${icon('user-plus')}팀원 등록</button>` : ''}</div><p class="muted">관리자 포함 최대 6명입니다. ${count >= 6 ? '정원에 도달했습니다. 불필요한 계정을 삭제하면 새 팀원을 등록할 수 있습니다. ' : ''}삭제는 로그인 차단이며 시험 일정과 변경 이력은 보존됩니다.</p><div class="table-wrap"><table class="data-table"><thead><tr><th>이름</th><th>아이디</th><th>권한</th><th>상태</th>${admin ? '<th>계정 관리</th>' : ''}</tr></thead><tbody>${data.users.map(u => `<tr data-user-id="${u.id}"><td>${esc(u.name)}</td><td>${esc(u.login)}</td><td>${u.role === 'admin' ? '관리자' : '팀원'}</td><td>${u.active ? '사용 중' : '삭제됨'}</td>${admin ? `<td>${u.active ? `<button class="quiet" data-edit-user="${u.id}">${icon('pencil')}ID·비밀번호 설정</button>${u.id !== me.id ? ` <button class="quiet danger" data-remove-user="${u.id}">${icon('trash-2')}삭제</button>` : ''}` : '<span class="muted">이력 보존</span>'}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}
function empty(title, subtitle, add = false) { return `<div class="empty-state">${icon('calendar-days')}<h3>${title}</h3><p>${subtitle}</p>${add ? `<button class="quiet" data-add>${icon('plus')}시험 등록</button>` : ''}</div>`; }
function holidaySettings() {
  const year = date.slice(0, 4), p = period(), holidays = data.rules.holidays.filter(h => range ? h.date >= p.start && h.date < p.end : h.date.startsWith(year)).sort((a, b) => a.date.localeCompare(b.date));
  const sync = data.holidaySync;
  const unknown = [...new Set((range ? p.days : [date]).map(d => Number(d.slice(0, 4))))].filter(y => !data.holidayYears.includes(y));
  return `<section class="setting-band" id="holiday-sync-status"><h3>공휴일 자동 갱신</h3><p>${sync.configured ? '인증키 등록됨 · 자동 갱신 설정됨' : '인증키 미등록 · 내장 공휴일 자료 사용'}<br>서버 시작 시 확인 · 이후 6시간마다 확인하여 24시간 지난 자료 갱신 · 조회 실패 시 기존 자료 유지</p>${sync.years.map(y => `<p>${y.year}년 공식 자료 ${y.count}일 · 마지막 갱신 ${esc(new Date(y.updatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))}</p>`).join('')}${sync.errors.map(e => `<p class="holiday-warning" role="status">${e.year}년: ${esc(e.message)}</p>`).join('')}${me.role === 'admin' ? `<div class="inline-actions"><button class="quiet" id="holiday-api-key">${sync.configured ? '인증키 변경' : '인증키 등록'}</button><button class="quiet" id="sync-holidays" ${sync.configured ? '' : 'disabled'}>지금 갱신</button></div>` : ''}</section>
    <div class="section-heading"><h2>${range ? '조회 구간' : year + '년'} 공휴일</h2>${me.role === 'admin' ? '<button class="quiet" id="add-holiday">공휴일 추가</button>' : ''}</div>
    <p class="muted">공휴일 자료 적용 연도: ${data.holidayYears.join('·')}년. 임시공휴일은 관리자가 추가할 수 있습니다. 일반 설비의 계획·CAPA에서 제외하며 주말 포함을 선택해도 공휴일은 제외합니다. 기존 실적과 최초 계획은 보존합니다.</p>
    ${unknown.length ? `<p class="holiday-warning">${unknown.join(', ')}년 국가 공휴일 자료가 없습니다. 추가 등록한 날짜만 적용됩니다.</p>` : ''}
    <div class="table-wrap"><table class="data-table"><thead><tr><th>날짜</th><th>공휴일</th><th>자료</th><th></th></tr></thead><tbody>${holidays.map(h => `<tr><td>${h.date}</td><td>${esc(h.name)}</td><td>${h.source === 'api' ? '한국천문연구원 API' : h.source === 'national' ? '내장 국가 공휴일' : '추가 등록'}</td><td>${me.role === 'admin' && data.customHolidays.some(c => c.date === h.date) ? `<button class="quiet" data-remove-holiday="${h.date}">추가 등록 삭제</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}
function scheduleDeleteSettings() {
  return me.role === 'admin' ? `<section class="setting-band"><h3>전체 시험 일정 일괄 삭제</h3><p>조회 기간·검색 조건과 관계없이 모든 시험 예약(취소 포함), 실적, 변경 이력, 기준계획, 과거 자동 배치 내역을 삭제합니다.<br>계정·운영 설정·공휴일·설비 정지 일정은 유지됩니다. 삭제 전 서버에 전체 DB 백업을 저장합니다.</p><button class="quiet" id="delete-all-schedules">${icon('trash-2')}전체 시험 일정 삭제…</button></section>` : '';
}
async function scheduleDeleteForm() {
  const preview = await api('/api/schedules/deletion-preview'), c = preview.counts;
  modal('전체 시험 일정 삭제', `<form id="delete-schedules-form"><p class="warning-note">모든 기간·모든 시험실이 대상입니다. 예약 ${c.reservations}건 · 실적 ${c.actuals}건 · 변경 이력 ${c.history}건 · 기준계획 ${c.baselines}건 · 과거 자동 배치 ${c.automatic_plans}건을 삭제합니다.</p><p>계정·운영 설정·공휴일·설비 정지 일정은 유지됩니다. 백업 실패 시 삭제하지 않습니다. 복구하려면 서버 관리자가 백업 DB를 복원해야 합니다.</p><label>확인 문구: 전체 시험 일정 삭제<input name="confirmation" autocomplete="off" required></label><p class="error" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-close>취소</button><button type="submit" class="primary" disabled>백업 후 전체 삭제</button></div></form>`);
  const form = $('#delete-schedules-form'), submit = form.querySelector('[type=submit]');
  form.elements.confirmation.oninput = () => { submit.disabled = form.elements.confirmation.value !== '전체 시험 일정 삭제'; };
  form.onsubmit = async event => {
    event.preventDefault(); submit.disabled = true;
    try {
      const result = await api('/api/schedules', 'DELETE', { confirmation: form.elements.confirmation.value, revision: preview.revision });
      $('#modal').close(); await refresh();
      modal('전체 시험 일정 삭제 완료', `<p>시험 예약 ${result.deleted.reservations}건과 연결된 데이터를 삭제했습니다.</p><p>서버 백업 파일: <strong>${esc(result.backupFile)}</strong></p><p>백업에는 계정과 API 인증키가 포함되어 있으므로 외부에 공유하지 마세요. 복구는 서버에서 DB 복원으로 진행합니다.</p><button class="quiet" data-close>닫기</button>`);
    } catch (e) { form.querySelector('.error').textContent = e.message; }
    finally { submit.disabled = form.elements.confirmation.value !== '전체 시험 일정 삭제'; }
  };
}
function holidayKeyForm() {
  modal('공휴일 API 인증키 등록', `<form id="holiday-key-form"><p class="warning-note">공공데이터포털의 한국천문연구원 특일 정보 인증키를 입력합니다. 서버 데이터베이스에 저장하며 화면에 다시 표시하지 않습니다.</p><div class="form-grid"><label class="full">인증키<input name="key" type="password" autocomplete="off" minlength="20" maxlength="512" required></label></div><p class="error" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-close>닫기</button><button type="submit" class="primary">인증키 저장</button></div></form>`);
  const form = $('#holiday-key-form'); form.onsubmit = event => { event.preventDefault(); const key = form.elements.key.value; saveForm(form, () => api('/api/holidays/key', 'POST', { key }), '인증키를 저장했습니다. 갱신 상태를 확인해 주세요.'); };
}
function holidayForm() {
  modal('공휴일 추가', `<form id="holiday-form"><p class="warning-note">일반 설비의 해당 날짜 계획과 CAPA에서 제외됩니다. 기존 예약·실적·최초 계획 이력은 보존됩니다.</p><div class="form-grid"><label>날짜<input name="date" type="date" value="${date}" required></label><label>공휴일 이름<input name="name" maxlength="80" required placeholder="임시공휴일"></label></div><p class="error" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-close>닫기</button><button type="submit" class="primary">공휴일 저장</button></div></form>`);
  const form = $('#holiday-form'); form.onsubmit = event => { event.preventDefault(); saveForm(form, () => api('/api/holidays', 'POST', Object.fromEntries(new FormData(form))), '공휴일을 추가했습니다.'); };
}
function modal(title, html) { $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; if (!$('#modal').open) $('#modal').showModal(); icons(); }
function option(value, label, selected) { return `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`; }
function reservationForm(r, equipmentId, day, minute) {
  const eq = equipmentId || r?.equipmentId || data.equipment[0].id;
  let d = day || date;
  if (!r && eq !== 'endurance') while (!data.rules.days.includes(weekday(d)) && !(supportsWeekend(eq) && [0, 6].includes(weekday(d)))) d = addDays(d, 1);
  const at = minute !== undefined ? Math.min(Math.max(Number(minute), data.rules.open), data.rules.close - 60) : data.rules.open;
  const start = r ? local(r.start) : local(new Date(new Date(midnight(d)).getTime() + (eq === 'endurance' && minute !== undefined ? Number(minute) : at) * 60000));
  const end = r ? local(r.end) : local(new Date(new Date(start + ':00+09:00').getTime() + 3600000));
  modal(r ? '시험계획 수정' : '시험 등록', `<form id="reservation-form" data-id="${r?.id || ''}"><div class="form-grid"><label class="full">차종 / 프로젝트<input name="project" value="${esc(r?.project || '')}" maxlength="100"></label><label>시험실<select name="equipmentId">${data.equipment.map(e => option(e.id, e.name, eq)).join('')}</select></label><label>시험 종류<select name="testType"></select></label><label class="full">담당자<select name="ownerId">${data.users.filter(u => u.active || u.id === r?.ownerId).map(u => option(u.id, userName(u.id), r?.ownerId || me.id)).join('')}</select></label><label>시작 일시<input name="start" type="datetime-local" step="1800" value="${start}" required></label><label>종료 일시<input name="end" type="datetime-local" step="1800" value="${end}" required></label><label class="full checkbox-label"><input type="checkbox" name="includeWeekend" ${r?.includeWeekend ? 'checked' : ''}>주말 포함</label>${r ? '<label>변경 사유<input name="reason" required maxlength="500"></label>' : ''}<label class="full">비고<textarea name="note" maxlength="2000">${esc(r?.note || '')}</textarea></label></div><p class="error" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-close>닫기</button><button type="submit" class="primary">${icon('check')}저장</button></div></form>`);
  const form = $('#reservation-form'), typeSelect = form.elements.testType;
  if(r?.monthlySchedule)form.insertAdjacentHTML('afterbegin',`<p class="warning-note">자동 편성 당시 요구시간 ${hours(r.monthlySchedule.requiredMinutes)}시간 · 현재 계획 가동시간 ${hours(r.plannedMinutes)}시간. 기간·시험실·종류 변경 시 연속 운영일 구간을 재계산합니다. 저장 후 상세에서 변경된 시간을 확인해 주세요.</p>`);
  form.querySelector('.error').insertAdjacentHTML('beforebegin', '<p class="muted" id="reservation-operating-rule"></p>');
  const syncOperatingRule = () => {
    const continuous = form.elements.equipmentId.value === 'endurance' && typeSelect.value !== '성능시험';
    $('#reservation-operating-rule').textContent = continuous ? '연속 24시간 가동: 야간·주말·공휴일 포함' : `기본 운영시간 적용 · 운영일만 예약 · 공휴일 제외${['열피로 시험', '열충격 시험', '열피로/열충격 시험'].includes(typeSelect.value) ? ' · 휴식시간 연속 가동' : ' · 휴식시간 제외'}`;
  };
  const weekendLabel = form.elements.includeWeekend.closest('label');
  const syncWeekend = () => {
    const supported = supportsWeekend(form.elements.equipmentId.value), checkbox = form.elements.includeWeekend;
    weekendLabel.classList.toggle('hidden', !supported); checkbox.disabled = !supported;
    if (!supported) checkbox.checked = false;
    else if ([form.elements.start.value, form.elements.end.value].some(v => v && [0, 6].includes(weekday(v.slice(0, 10))))) checkbox.checked = true;
  };
  const setTypes = () => {
    const equipment = data.equipment.find(e => e.id === form.elements.equipmentId.value), types = [...equipment.types];
    if (r?.equipmentId === equipment.id && !types.includes(r.testType)) types.push(r.testType);
    typeSelect.innerHTML = types.map(t => option(t, equipment.types.includes(t) ? t : t + ' (기존 예약)', r?.testType)).join('');
  };
  setTypes(); syncWeekend(); syncOperatingRule(); typeSelect.onchange = syncOperatingRule;
  form.elements.equipmentId.onchange = () => { setTypes(); syncWeekend(); syncOperatingRule(); };
  form.elements.start.onchange = syncWeekend; form.elements.end.onchange = syncWeekend;
  form.onsubmit = async event => { event.preventDefault(); syncWeekend(); const values = Object.fromEntries(new FormData(form)); values.title = values.testType; values.status = r?.status || '계획'; values.includeWeekend = !form.elements.includeWeekend.disabled && form.elements.includeWeekend.checked; values.start = iso(values.start); values.end = iso(values.end); if (r) values.version = r.version;
    await saveForm(form, () => api('/api/reservations' + (r ? '/' + r.id : ''), r ? 'PUT' : 'POST', values), '시험계획을 저장했습니다.'); };
}
async function saveForm(form, operation, message) {
  const button = form.querySelector('[type=submit]'); button.disabled = true;
  try { await operation(); $('#modal').close(); toast(message); await refresh(); }
  catch (e) { form.querySelector('.error').textContent = e.message; if (e.code === 'DUPLICATE_BOOKING') { $('#conflict-message').textContent = e.message; $('#conflict-popup').showModal(); } }
  finally { button.disabled = false; }
}
async function detail(id) {
  const r = data.reservations.find(r => r.id === id); if (!r) return;
  const hist = await api(`/api/reservations/${r.id}/history`), a = data.actuals.find(a => a.reservationId === r.id);
  const canDelete = me.role === 'admin' || (hist[0]?.before === null && hist[0].userId === me.id);
  const durationInfo=r.monthlySchedule?`<p class="warning-note">계획 가동시간 ${hours(r.plannedMinutes)}시간 · 자동 편성 당시 요구시간 ${hours(r.monthlySchedule.requiredMinutes)}시간</p>`:'';
  modal('시험 상세', `<dl class="detail-grid"><div class="full"><dt>시험명</dt><dd><strong>${esc(r.title)}</strong></dd></div><div><dt>시험실</dt><dd>${esc(equipmentName(r.equipmentId))}</dd></div><div><dt>시험 종류</dt><dd>${esc(r.testType)}</dd></div><div><dt>담당자</dt><dd>${esc(userName(r.ownerId))}</dd></div><div><dt>상태</dt><dd><span class="tag ${statusClass(r.status)}">${r.status}</span></dd></div><div class="full"><dt>예약 기간</dt><dd>${dateText(r.start)} ~ ${dateText(r.end)}</dd></div><div class="full"><dt>주말 포함</dt><dd>${r.includeWeekend ? '포함' : r.equipmentId === 'endurance' && r.testType !== '성능시험' ? '연속 가동' : '기본 운영일'}</dd></div><div class="full"><dt>가동실적</dt><dd>${!a ? '미입력' : a.zero ? '0시간 · ' + esc(a.note) : dateText(a.start) + ' ~ ' + dateText(a.end)}</dd></div>${r.note ? `<div class="full"><dt>비고</dt><dd>${esc(r.note)}</dd></div>` : ''}</dl><div class="inline-actions"><button class="quiet" data-edit="${r.id}">${icon('pencil')}계획 수정</button>${r.status !== '취소' ? `<button class="primary" data-actual="${r.id}">${icon('timer')}실적 입력</button>` : ''}${a ? `<button class="quiet danger" data-remove-actual="${r.id}">${icon('trash-2')}실적 삭제</button>` : ''}${canDelete ? `<button class="quiet danger" data-remove-reservation="${r.id}" data-version="${r.version}" title="시험·실적·변경 이력 삭제">${icon('trash-2')}시험 삭제</button>` : ''}</div><p id="reservation-delete-error" class="error" role="alert"></p><div class="section-heading"><h2>변경 이력</h2></div>${hist.reverse().map(h => `<div class="history-item"><strong>${esc(h.reason)}</strong><small>${dateText(h.at)} · ${esc(userName(h.userId))}</small><p>${h.before ? `${dateText(h.before.start)} ~ ${dateText(h.before.end)} / ${esc(h.before.status)} →<br>` : '최초 계획: '}${dateText(h.after.start)} ~ ${dateText(h.after.end)} / ${esc(h.after.status)}</p></div>`).join('')}`);
  if(durationInfo)$('#modal-body').insertAdjacentHTML('afterbegin',durationInfo);
}
function actualForm(id) {
  const r = data.reservations.find(r => r.id === id), a = data.actuals.find(a => a.reservationId === id);
  modal('가동실적 입력', `<form id="actual-form"><p class="muted">${esc(r.title)}</p><div class="form-grid" style="margin-top:20px"><label>실제 시작<input name="start" type="datetime-local" step="1800" value="${local(a?.start || r.start)}" required></label><label>실제 종료<input name="end" type="datetime-local" step="1800" value="${local(a?.end || r.end)}" required></label><label class="checkbox-label full"><input name="zero" type="checkbox" ${a?.zero ? 'checked' : ''}>가동하지 않음 (0시간)</label><label class="full">실적 비고 / 비가동 사유<textarea name="note" maxlength="1000">${esc(a?.note || '')}</textarea></label></div><p class="error" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-close>닫기</button><button type="submit" class="primary">실적 저장</button></div></form>`);
  const form = $('#actual-form'); form.onsubmit = event => { event.preventDefault(); const v = Object.fromEntries(new FormData(form)); const zero = form.elements.zero.checked;
    saveForm(form, () => api('/api/actuals', 'POST', { reservationId: id, zero, note: v.note, ...(!zero ? { start: iso(v.start), end: iso(v.end) } : {}) }), '실적을 저장했습니다.'); };
}
function userForm(u) {
  modal(u ? '팀원 계정 설정' : '팀원 등록', `<form id="user-form"><p class="muted">${u ? '새 비밀번호를 비워 두면 기존 비밀번호를 유지합니다. ID·비밀번호·권한을 바꾸면 해당 계정은 다시 로그인해야 합니다. 기존 비밀번호는 조회할 수 없습니다.' : '관리자가 초기 아이디와 비밀번호를 지정합니다. 아이디는 영문·숫자 및 . _ -를 사용해 3~40자로 입력해 주세요.'}</p><div class="form-grid"><label>이름<input name="name" value="${esc(u?.name || '')}" required maxlength="40"></label><label>아이디<input name="login" value="${esc(u?.login || '')}" autocomplete="off" required pattern="[a-zA-Z0-9._-]{3,40}" maxlength="40"></label><label class="full">${u ? '새 비밀번호 (변경할 때만 입력)' : '초기 비밀번호'}<input name="password" type="password" autocomplete="new-password" ${u ? '' : 'required'} minlength="10" maxlength="200"><small>10~200자 · 다른 사이트와 다른 비밀번호를 사용해 주세요.</small></label><label>권한<select name="role">${option('member', '팀원', u?.role || 'member')}${option('admin', '관리자', u?.role || 'member')}</select></label></div><p class="error" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-close>닫기</button><button class="primary" type="submit">${u ? '설정 저장' : '팀원 등록'}</button></div></form>`);
  const form = $('#user-form'); form.onsubmit = event => { event.preventDefault(); saveForm(form, () => api('/api/users' + (u ? '/' + u.id : ''), u ? 'PUT' : 'POST', { ...Object.fromEntries(new FormData(form)), ...(u ? { version: u.version } : {}) }), u ? '계정 설정을 저장했습니다.' : '팀원을 등록했습니다.'); };
}
function downtimeForm() {
  modal('설비 정지 등록', `<form id="downtime-form"><div class="warning-note">예약과 겹치는 정지시간은 CAPA에서 제외되며 기존 예약은 보존됩니다.</div><div class="form-grid"><label class="full">시험실<select name="equipmentId">${data.equipment.map(e => option(e.id, e.name)).join('')}</select></label><label>정지 시작<input name="start" type="datetime-local" step="1800" value="${date}T08:30" required></label><label>정지 종료<input name="end" type="datetime-local" step="1800" value="${date}T20:30" required></label><label class="full">사유<input name="reason" required maxlength="500"></label></div><p class="error" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-close>닫기</button><button class="primary" type="submit">정지 등록</button></div></form>`);
  const form = $('#downtime-form'); form.onsubmit = event => { event.preventDefault(); const v = Object.fromEntries(new FormData(form)); saveForm(form, () => api('/api/downtimes', 'POST', { ...v, start: iso(v.start), end: iso(v.end) }), '정지 일정을 등록했습니다.'); };
}
function rulesForm() {
  const r = data.rules, clock = v => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  modal('운영 기준 수정', `<form id="rules-form"><div class="warning-note">새 기준과 충돌하는 기존 예약이 있으면 변경을 저장하지 않습니다. CAPA는 현재 운영 기준으로 계산됩니다.</div><div class="form-grid"><div class="full rules-days">${daysLabel.map((d, i) => `<label class="checkbox-label"><input type="checkbox" name="days" value="${i}" ${r.days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div><label>가동 시작<input name="open" type="time" step="1800" value="${clock(r.open)}" required></label><label>가동 종료<input name="close" type="time" step="1800" value="${clock(r.close)}" required></label><label>점심 휴식 시작<input name="b1s" type="time" step="1800" value="${clock(r.breaks[0]?.[0] ?? 750)}" required></label><label>점심 휴식 종료<input name="b1e" type="time" step="1800" value="${clock(r.breaks[0]?.[1] ?? 810)}" required></label><label>저녁 휴식 시작<input name="b2s" type="time" step="1800" value="${clock(r.breaks[1]?.[0] ?? 1050)}" required></label><label>저녁 휴식 종료<input name="b2e" type="time" step="1800" value="${clock(r.breaks[1]?.[1] ?? 1080)}" required></label></div><p class="error" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-close>닫기</button><button class="primary" type="submit">운영 기준 저장</button></div></form>`);
  const form = $('#rules-form'); form.onsubmit = event => { event.preventDefault(); const v = Object.fromEntries(new FormData(form)), min = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    saveForm(form, () => api('/api/settings', 'PUT', { days: new FormData(form).getAll('days').map(Number), open: min(v.open), close: min(v.close), breaks: [[min(v.b1s), min(v.b1e)], [min(v.b2s), min(v.b2e)]] }), '운영 기준을 저장했습니다.'); };
}
function baselineDetail(id) {
  const b = data.baselines.find(b => b.id === id), current = data.reservations;
  const differences = b.reservations.filter(old => { const r = current.find(r => r.id === old.id); return !r || ['title', 'equipmentId', 'start', 'end', 'status', 'ownerId'].some(k => old[k] !== r[k]) || (old.includeWeekend === true) !== (r.includeWeekend === true); });
  const added = current.filter(r => !b.reservations.some(old => old.id === r.id) && dayOf(r.start).slice(0, 7) <= b.month && dayOf(r.end).slice(0, 7) >= b.month);
  modal('월간 기준계획 비교', `<p class="muted">${dateText(b.at)} 저장 · 변경 ${differences.length}건 · 추가 ${added.length}건</p><div class="section-heading"><h2>변경된 시험</h2></div>${differences.map(old => { const r = current.find(r => r.id === old.id); return `<div class="history-item"><strong>${esc(old.title)}</strong><small>기준: ${dateText(old.start)}~${dateText(old.end)} / ${esc(old.status)}</small><small>현재: ${r ? `${dateText(r.start)}~${dateText(r.end)} / ${esc(r.status)}` : '없음'}</small></div>`; }).join('') || '<p class="muted">변경 내역 없음</p>'}<div class="section-heading"><h2>추가된 시험</h2></div>${added.map(r => `<p class="history-item">${esc(r.title)}<small>${dateText(r.start)}~${dateText(r.end)}</small></p>`).join('') || '<p class="muted">추가 내역 없음</p>'}`);
}
$('#auth-form').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget, button = $('#auth-submit'); button.disabled = true; $('#auth-error').textContent = '';
  try { const account = await api(setup ? '/api/setup' : '/api/login', 'POST', Object.fromEntries(new FormData(form))); me = account.user; csrf = account.csrf; setup = false; await enter(); }
  catch (e) { $('#auth-error').textContent = e.message; } finally { button.disabled = false; } };
$('#logout').onclick = async () => { try { await api('/api/logout', 'POST'); me = null; csrf = ''; await init(); } catch (e) { error(e.message); } };
$('.sidebar nav').onclick = event => { const button = event.target.closest('[data-page]'); if (button && me) { monthlyPlanner?.invalidatePreview();page = button.dataset.page; actualState = ''; render(); } };
$('#content').addEventListener('input',event=>monthlyPlanner?.handleChange(event));
$('#content').addEventListener('change',event=>{if(event.target.tagName==='SELECT')monthlyPlanner?.handleChange(event);});
document.addEventListener('click', event => {
  const card = event.target.closest('[data-summary]'); if (!card || !me) return;
  page = ['equipment', 'occupancy'].includes(card.dataset.summary) ? 'capacity' : 'tests';
  actualState = card.dataset.summary === 'missing' ? 'missing' : '';
  search = ''; owner = ''; status = ''; render();
});
$('#view-modes').onclick = event => { const button = event.target.closest('[data-mode]'); if (button) { mode = button.dataset.mode; rangeDraft = false; refresh(); } };
$('#previous').onclick = () => move(-1); $('#next').onclick = () => move(1);
function move(direction) {
  rangeDraft = false;
  if (range) { const shift = direction * period().days.length; range = { start: addDays(range.start, shift), end: addDays(range.end, shift) }; date = range.start; }
  else if (mode === 'year') date = `${Number(date.slice(0, 4)) + direction}-01-01`;
  else if (mode === 'month') { const d = new Date(date.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + direction); date = d.toISOString().slice(0, 10); }
  else date = addDays(date, direction * (mode === 'week' ? 7 : 1));
  refresh();
}
function clearRange() { range = null; rangeDraft = false; $('#range-error').textContent = ''; }
$('#today').onclick = () => { clearRange(); date = today(); refresh(); };
$('#date-picker').onchange = event => { if (event.target.value) { clearRange(); date = event.target.value; refresh(); } };
$('#range-form').oninput = () => { rangeDraft = true; $('#range-error').textContent = ''; };
$('#range-form').onsubmit = event => {
  event.preventDefault(); const start = $('#range-start').value, end = $('#range-end').value;
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(start) || !valid(end) || start < '2000-01-01' || end > '2100-12-31') { $('#range-error').textContent = '검색 시작일과 종료일을 2000~2100년 안에서 입력해 주세요.'; return; }
  if (end < start) { $('#range-error').textContent = '종료일은 시작일과 같거나 이후여야 합니다.'; return; }
  if ((Date.parse(end) - Date.parse(start)) / 86400000 + 1 > 3660) { $('#range-error').textContent = '조회 구간은 최대 10년까지 가능합니다.'; return; }
  range = { start, end }; rangeDraft = false; date = start; $('#range-error').textContent = ''; refresh();
};
$('#clear-range').onclick = () => { clearRange(); refresh(); };
$('#search').oninput = event => { search = event.target.value; render(); };
$('#owner-filter').onchange = event => { owner = event.target.value; render(); };
$('#status-filter').onchange = event => { status = event.target.value; render(); };
$('#refresh').onclick = refresh;
$('#new-test').onclick = () => reservationForm();
$('#close-modal').onclick = () => $('#modal').close();
$('#modal').addEventListener('click', event => { if (event.target.closest('[data-close]')) $('#modal').close(); });
$('#export').onclick = () => { const p = period(); window.location.href = `/api/export?start=${encodeURIComponent(midnight(p.start))}&end=${encodeURIComponent(midnight(p.end))}`; };
document.addEventListener('click', async event => {
  if (!me) return; const b = event.target.closest('button, .booking-entry');
  try {
    if(b?.hasAttribute('data-monthly-action')){await plannerUI().handleClick(event);return;}
    if (b?.dataset.openDay) { clearRange(); date = b.dataset.openDay; mode = 'day'; await refresh(); }
    else if (b?.dataset.openMonth) { clearRange(); date = b.dataset.openMonth + '-01'; mode = 'month'; await refresh(); }
    else if (b?.dataset.detail) await detail(b.dataset.detail);
    else if (b?.dataset.edit) reservationForm(data.reservations.find(r => r.id === b.dataset.edit));
    else if (b?.dataset.actual) actualForm(b.dataset.actual);
    else if (b?.dataset.removeReservation) {
      b.disabled = true;
      const message = $('#reservation-delete-error'); message.textContent = '';
      const origin = $('#modal'), sameDetail = () => origin.open && b.isConnected && message.isConnected;
      try {
        const path = '/api/reservations/' + b.dataset.removeReservation;
        const preview = await api(path + '/deletion-preview');
        if (!sameDetail()) return;
        if (preview.version !== Number(b.dataset.version)) throw new Error('시험 정보가 변경되었습니다. 상세 창을 다시 열고 삭제해 주세요.');
        if (!confirm('정말로 삭제하시겠습니까?')) return;
        await api(path, 'DELETE', { confirmation: '시험 삭제', revision: preview.revision });
        if (sameDetail()) origin.close();
        toast('시험을 삭제했습니다. 삭제 전 백업이 저장되었습니다.'); await refresh();
      } catch (e) { if (sameDetail()) message.textContent = e.message; else error(e.message); }
      finally { b.disabled = false; }
    }
    else if (b?.dataset.removeActual && confirm('이 시험의 실적을 삭제할까요? 계획은 유지되고 실적은 미입력으로 돌아갑니다.')) {
      b.disabled = true;
      try { await api('/api/actuals/' + b.dataset.removeActual, 'DELETE'); $('#modal').close(); toast('실적을 삭제했습니다.'); await refresh(); }
      finally { b.disabled = false; }
    }
    else if (b?.hasAttribute('data-add')) reservationForm();
    else if (b?.id === 'add-user') userForm();
    else if (b?.dataset.editUser) userForm(data.users.find(u => u.id === b.dataset.editUser));
    else if (b?.dataset.removeUser && confirm('이 계정의 로그인을 차단하고 기존 접속을 해제할까요? 시험 일정과 변경 이력은 삭제하지 않습니다. 삭제된 아이디는 재사용할 수 없습니다.')) { await api('/api/users/' + b.dataset.removeUser, 'DELETE'); toast('계정을 삭제했습니다. 시험 이력은 보존됩니다.'); await refresh(); }
    else if (b?.id === 'add-downtime') downtimeForm();
    else if (b?.id === 'edit-rules') rulesForm();
    else if (b?.id === 'delete-all-schedules') await scheduleDeleteForm();
    else if (b?.id === 'add-holiday') holidayForm();
    else if (b?.id === 'holiday-api-key') holidayKeyForm();
    else if (b?.id === 'sync-holidays') { b.disabled = true; b.textContent = '갱신 중…'; try { const p = period(), result = await api('/api/holidays/sync', 'POST', { start: midnight(p.start), end: midnight(p.end) }); toast(result.errors.length ? '일부 조회가 실패했습니다. 갱신 상태를 확인해 주세요.' : '공식 공휴일을 갱신했습니다.'); await refresh(); } finally { b.disabled = false; } }
    else if (b?.dataset.removeHoliday && confirm('추가 등록한 공휴일을 삭제하고 운영일 계산에 다시 포함할까요?')) { await api('/api/holidays/' + b.dataset.removeHoliday, 'DELETE'); await refresh(); }
    else if (b?.id === 'save-baseline') { await api('/api/baselines', 'POST', { month: period().start.slice(0, 7) }); toast('월간 기준계획을 저장했습니다.'); await refresh(); }
    else if (b?.dataset.baseline) baselineDetail(b.dataset.baseline);
    else if (b?.dataset.removeDowntime && confirm('이 설비 정지 일정을 삭제할까요?')) { await api('/api/downtimes/' + b.dataset.removeDowntime, 'DELETE'); await refresh(); }
    else { const slot = event.target.closest('[data-slot]'); if (slot && !b) reservationForm(null, slot.dataset.slot, slot.dataset.day, slot.dataset.minute); }
  } catch (e) { error(e.message); }
});
setInterval(() => { if (me && !$('#modal').open && !document.hidden) refresh(); }, 15000);
window.addEventListener('focus', () => { if (me && !$('#modal').open) refresh(); });
init();
