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
const userName = id => data.users.find(u => u.id === id)?.name || '미지정';
const equipmentName = id => data.equipment.find(e => e.id === id)?.name || id;
function period() {
  let start = date, n = 1;
  if (mode === 'week') { start = addDays(date, -((weekday(date) + 6) % 7)); n = 7; }
  if (mode === 'month') { start = date.slice(0, 7) + '-01'; const d = new Date(start + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); n = Math.round((d.getTime() - new Date(start + 'T00:00:00Z').getTime()) / 86400000); }
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
function showAuth() { $('#auth-screen').classList.remove('hidden'); $('#app-screen').classList.add('hidden'); $('#logout').classList.add('hidden'); $('#user-name').textContent = ''; $('#sync-status').textContent = '로그인 대기'; }
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
  $('#auth-screen').classList.add('hidden'); $('#app-screen').classList.remove('hidden'); $('#logout').classList.remove('hidden'); $('#user-name').textContent = me.name;
  $('#auth-form').reset(); await refresh();
}
async function refresh() {
  if (!me || refreshBusy) return;
  refreshBusy = true;
  try { data = await api('/api/state'); const p = period(); capa = await api(`/api/capacity?start=${encodeURIComponent(midnight(p.start))}&end=${encodeURIComponent(midnight(p.end))}`); $('#sync-status').textContent = '서버 연결됨'; $('#error-banner').classList.add('hidden'); render(); }
  catch (e) { error(e.message); $('#sync-status').textContent = '연결 확인 필요'; }
  finally { refreshBusy = false; }
}
function render() {
  if (!data || !me) return;
  const titles = { schedule: ['가동계획', '장비별 시험 일정과 가동 시간을 확인합니다.'], tests: ['시험계획', '시험별 일정, 담당자와 진행 상태를 관리합니다.'], capacity: ['설비 CAPA', '선택 기간의 가용 시간과 계획·실적을 비교합니다.'], history: ['기준계획 · 이력', '월간 기준계획과 현재 일정의 차이를 확인합니다.'], settings: ['운영 설정', '팀 계정과 설비 운영 기준을 관리합니다.'] };
  $('#page-title').textContent = titles[page][0]; $('#page-description').textContent = titles[page][1];
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('selected', b.dataset.mode === mode));
  $('#date-picker').value = date;
  const p = period(); $('#period-title').textContent = mode === 'month' ? `${date.slice(0, 4)}년 ${Number(date.slice(5, 7))}월` : mode === 'day' ? `${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일 (${daysLabel[weekday(date)]})` : `${Number(p.start.slice(5, 7))}월 ${Number(p.start.slice(8))}일 – ${Number(addDays(p.end, -1).slice(5, 7))}월 ${Number(addDays(p.end, -1).slice(8))}일`;
  $('#owner-filter').innerHTML = '<option value="">모든 담당자</option>' + data.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join(''); $('#owner-filter').value = owner;
  const selected = filtered().filter(r => r.status !== '취소');
  const available = capa.reduce((sum, c) => sum + c.availableMinutes, 0), planned = capa.reduce((sum, c) => sum + c.plannedMinutes, 0);
  const running = selected.filter(r => r.status === '진행').length, missing = capa.reduce((sum, c) => sum + c.missingActuals, 0);
  $('#summary-strip').innerHTML = [
    ['관리 설비', '6', '대', '시험실 운영 기준 적용', 'boxes', false], ['등록된 시험', selected.length, '건', `진행 ${running}건 · 선택 기간`, 'clipboard-list', false],
    ['계획 점유율', available ? (planned / available * 100).toFixed(1) : '—', available ? '%' : '', `${hours(planned)} / ${hours(available)}시간 · 전체 설비`, 'gauge', true], ['실적 미입력', missing, '건', '계획 시간을 실적으로 대체하지 않음', 'clock-3', false]
  ].map(([label, v, unit, note, i, emphasis], index) => `<button class="metric" data-summary="${['equipment', 'tests', 'occupancy', 'missing'][index]}" type="button"><span class="metric-label">${icon(i)}${label}</span><span class="metric-value ${emphasis ? 'emphasis' : ''}">${v}<span>${unit}</span></span><span class="metric-note">${note}</span></button>`).join('');
  $('#new-test').classList.toggle('hidden', ['history', 'settings'].includes(page));
  $('.filter-bar').classList.toggle('hidden', ['capacity', 'history', 'settings'].includes(page));
  $('#content').innerHTML = page === 'schedule' ? scheduleView() : page === 'tests' ? testsView() : page === 'capacity' ? capacityView() : page === 'history' ? historyView() : settingsView();
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
  return `<div class="booking-entry" data-detail="${r.id}"><button class="booking ${statusClass(r.status)}" data-detail="${r.id}"><span class="time"><span class="plan-caption">계획</span> ${clockRange(timeText(interval.start), timeText(interval.end))}</span><strong>${esc(r.title)}</strong><small>${esc(userName(r.ownerId))}${r.project ? ' · ' + esc(r.project) : ''}</small></button><div class="booking-actual ${!actual ? 'pending' : actual.zero ? 'zero' : ''}" title="${esc(actual ? (r.project || r.title) + ' · ' + label : label)}">${projectLabel}<span class="actual-value">${actualContent}</span></div></div>`;
}
function dayEntries(e, day) {
  const a = new Date(midnight(day)).getTime(), b = a + 86400000;
  return filtered().filter(r => r.equipmentId === e.id && (status === '취소' || r.status !== '취소')).flatMap(r => r.intervals.filter(i => new Date(i.start).getTime() < b && new Date(i.end).getTime() > a).map(i => ({ r, i: { start: new Date(Math.max(a, new Date(i.start).getTime())).toISOString(), end: new Date(Math.min(b, new Date(i.end).getTime())).toISOString() } })));
}
function equipmentComparison(id) {
  const c = capa.find(c => c.id === id); if (!c) return '';
  const percent = c.originalAchievementPercent === null ? '—' : c.originalAchievementPercent.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + '%';
  return `<div class="equipment-comparison"><dl><div><dt>최초 계획</dt><dd>${c.originalPlanMinutes === null ? '—' : hours(c.originalPlanMinutes) + ' h'}</dd></div><div><dt>실적${c.originalMissingActuals ? ' (입력분)' : ''}</dt><dd>${hours(c.actualMinutes)} h</dd></div><div><dt>달성률${c.originalMissingActuals ? ' (잠정)' : ''}</dt><dd>${percent}</dd></div></dl>${c.originalMissingActuals ? `<span class="comparison-pending">미입력 ${c.originalMissingActuals}건</span>` : ''}${c.unknownOriginalPlans ? `<span class="comparison-pending">최초 계획 확인 필요 ${c.unknownOriginalPlans}건</span>` : ''}</div>`;
}
function scheduleView() {
  const p = period(), daily = mode === 'day';
  const columns = daily ? Array.from({ length: 48 }, (_, i) => i * 30) : p.days;
  const head = columns.map(c => daily ? `<th><strong>${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}</strong></th>` : `<th class="${c === today() ? 'current' : ''}">${daysLabel[weekday(c)]}<strong>${Number(c.slice(8))}</strong></th>`).join('');
  const rows = data.equipment.map(e => {
    const cells = columns.map(c => {
      const day = daily ? date : c, entries = dayEntries(e, day);
      const off = e.id !== 'endurance' && (!data.rules.days.includes(weekday(day)) || (daily && (c < data.rules.open || c >= data.rules.close || data.rules.breaks.some(([a, b]) => c >= a && c < b))));
      let contents;
      if (daily) {
        const start = new Date(midnight(day)).getTime() + c * 60000, end = start + 1800000;
        contents = entries.filter(({ i }) => new Date(i.start).getTime() < end && new Date(i.end).getTime() > start).map(({ r, i }) => booking(r, i, day)).join('');
      } else contents = entries.map(({ r, i }) => booking(r, i, day)).join('');
      const stop = data.downtimes.find(d => d.equipmentId === e.id && d.start < new Date(midnight(addDays(day, 1))).toISOString() && d.end > new Date(midnight(day)).toISOString());
      return `<td class="day-cell ${off ? 'off' : ''} ${day === today() ? 'current' : ''}" data-slot="${e.id}" data-day="${day}" ${daily ? `data-minute="${c}"` : ''}>${contents || (stop ? `<span class="off-label">${esc(stop.reason)}</span>` : `<span class="${off ? 'off-label' : 'empty-slot'}">${off ? '비가동' : daily ? '' : '—'}</span>`)}</td>`;
    }).join('');
    return `<tr><td class="equipment-cell"><span class="equipment-mark">${icon(e.id.startsWith('engine') ? 'settings' : e.id.startsWith('thermal') ? 'thermometer' : e.id === 'endurance' ? 'infinity' : 'wind')}</span><strong>${esc(e.name)}</strong><small>${e.id === 'endurance' ? '24시간 · 주말 연속' : e.id.startsWith('thermal') ? '시험 종류별 휴식 적용' : '평일 기준 · 주말 예약 가능'}</small>${equipmentComparison(e.id)}</td>${cells}</tr>`;
  }).join('');
  return `<div class="schedule-scroll"><table class="schedule-table ${daily ? 'day-table' : mode === 'month' ? 'month-table' : ''}"><thead><tr><th class="equipment-cell">시험실 / 설비</th>${head}</tr></thead><tbody>${rows}</tbody></table></div><div class="grid-caption"><span>기본 가동 08:30~20:30 · 휴식 12:30~13:30 / 17:30~18:00</span><span>단품 대상내구: 야간·주말 포함 · 열가진: 시험별 기준</span></div>`;
}
function testsView() {
  const rows = filtered();
  if (!rows.length) return empty('등록된 시험이 없습니다.', '선택 기간과 검색 조건을 확인해 주세요.', true);
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>시험명 / 프로젝트</th><th>시험실</th><th>담당자</th><th>예약 기간</th><th>상태</th><th>실적</th><th></th></tr></thead><tbody>${rows.map(r => `<tr><td class="title-cell"><strong>${esc(r.title)}</strong><small>${esc(r.project || r.testType)}</small></td><td>${esc(equipmentName(r.equipmentId))}</td><td>${esc(userName(r.ownerId))}</td><td>${dateText(r.start)}<br><span class="muted">${dateText(r.end)}</span></td><td><span class="tag ${statusClass(r.status)}">${r.status}</span></td><td>${data.actuals.some(a => a.reservationId === r.id) ? '입력' : '<span class="muted">미입력</span>'}</td><td><button class="icon-button" data-detail="${r.id}" title="시험 상세" aria-label="시험 상세">${icon('arrow-up-right')}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function capacityView() {
  return `<div class="table-wrap"><table class="data-table capacity-table"><thead><tr><th>시험실</th><th>가용 시간</th><th>계획 가동</th><th>계획 점유율</th><th>실적 가동</th><th>실적 가동률</th></tr></thead><tbody>${capa.map(c => {
    const percent = c.availableMinutes ? c.plannedMinutes / c.availableMinutes * 100 : null;
    return `<tr><td><b>${esc(c.name)}</b><small>${c.id === 'endurance' ? '24시간 × 운영일 · 정지시간 제외' : c.id.startsWith('thermal') ? '기본 가용 + 연속시험 휴식 가동 · 정지 제외' : '평일 가용 + 주말 예약 가동 · 정지 제외'}</small></td><td><strong>${hours(c.availableMinutes)}</strong> h</td><td><strong>${hours(c.plannedMinutes)}</strong> h</td><td>${percent === null ? '—' : percent.toFixed(1) + '%'}<div class="bar"><span style="width:${Math.min(percent || 0, 100)}%"></span></div></td><td><strong>${hours(c.actualMinutes)}</strong> h<small>${c.missingActuals ? `미입력 ${c.missingActuals}건` : '입력 완료'}</small></td><td>${c.missingActuals ? '<span class="muted">미입력 포함 · 미확정</span>' : c.availableMinutes ? (c.actualMinutes / c.availableMinutes * 100).toFixed(1) + '%' : '—'}</td></tr>`;
  }).join('')}</tbody></table></div><div class="grid-caption"><span>시간 단위: h · 예약 점유와 실제 가동 시간은 구분됩니다.</span><span>가동실적은 입력된 시험 기준이며, 미입력은 자동 추정하지 않습니다.</span></div>`;
}
function historyView() {
  const month = date.slice(0, 7), baselines = data.baselines.filter(b => b.month === month).reverse();
  return `<div class="section-heading"><h2>${month.replace('-', '년 ')}월 기준계획</h2>${me.role === 'admin' ? `<button class="quiet" id="save-baseline">${icon('bookmark-plus')}현재 계획 확정</button>` : ''}</div>${baselines.length ? `<div class="baseline-list">${baselines.map(b => `<div class="baseline-item"><div><strong>${dateText(b.at)} 기준계획</strong><small>${esc(userName(b.userId))} · 시험 ${b.reservations.length}건</small></div><button class="quiet" data-baseline="${b.id}">변경 비교${icon('arrow-right')}</button></div>`).join('')}</div>` : empty('저장된 기준계획이 없습니다.', '관리자가 월간 계획 확정 시점에 기준계획을 저장할 수 있습니다.')}<div class="section-heading"><h2>시험별 변경 이력</h2></div>${testsView()}`;
}
function settingsView() {
  const r = data.rules;
  const clock = v => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  return `<section class="setting-band"><h3>기본 운영 기준</h3><p>${r.days.map(d => daysLabel[d]).join(' · ')}요일 / ${clock(r.open)}~${clock(r.close)}<br>휴식 ${r.breaks.map(([a, b]) => `${clock(a)}~${clock(b)}`).join(' / ')}<br>열가진 연속시험과 단품 대상내구는 별도 기준 적용</p>${me.role === 'admin' ? `<div class="inline-actions"><button class="quiet" id="edit-rules">${icon('sliders-horizontal')}운영 기준 수정</button><button class="quiet" id="add-downtime">${icon('wrench')}설비 정지 등록</button></div>` : ''}</section><div class="section-heading"><h2>팀 계정 <span class="muted">${data.users.length}/6</span></h2>${me.role === 'admin' && data.users.length < 6 ? `<button class="quiet" id="add-user">${icon('user-plus')}팀원 등록</button>` : ''}</div><div class="table-wrap"><table class="data-table"><thead><tr><th>이름</th><th>아이디</th><th>권한</th></tr></thead><tbody>${data.users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.login)}</td><td>${u.role === 'admin' ? '관리자' : '팀원'}</td></tr>`).join('')}</tbody></table></div><div class="section-heading"><h2>설비 정지 일정</h2></div>${data.downtimes.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>시험실</th><th>기간</th><th>사유</th><th></th></tr></thead><tbody>${data.downtimes.map(d => `<tr><td>${esc(equipmentName(d.equipmentId))}</td><td>${dateText(d.start)}~${dateText(d.end)}</td><td>${esc(d.reason)}</td><td>${me.role === 'admin' ? `<button class="icon-button" data-remove-downtime="${d.id}" title="정지 일정 삭제" aria-label="정지 일정 삭제">${icon('trash-2')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('설비 정지 일정이 없습니다.', '')}`;
}
function empty(title, subtitle, add = false) { return `<div class="empty-state">${icon('calendar-days')}<h3>${title}</h3><p>${subtitle}</p>${add ? `<button class="quiet" data-add>${icon('plus')}시험 등록</button>` : ''}</div>`; }
function modal(title, html) { $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; if (!$('#modal').open) $('#modal').showModal(); icons(); }
function option(value, label, selected) { return `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`; }
function reservationForm(r, equipmentId, day, minute) {
  const eq = equipmentId || r?.equipmentId || data.equipment[0].id;
  let d = day || date;
  if (!r && eq !== 'endurance') while (!data.rules.days.includes(weekday(d)) && !(supportsWeekend(eq) && [0, 6].includes(weekday(d)))) d = addDays(d, 1);
  const at = minute !== undefined ? Math.min(Math.max(Number(minute), data.rules.open), data.rules.close - 60) : data.rules.open;
  const start = r ? local(r.start) : local(new Date(new Date(midnight(d)).getTime() + (eq === 'endurance' && minute !== undefined ? Number(minute) : at) * 60000));
  const end = r ? local(r.end) : local(new Date(new Date(start + ':00+09:00').getTime() + 3600000));
  modal(r ? '시험계획 수정' : '시험 등록', `<form id="reservation-form" data-id="${r?.id || ''}"><div class="form-grid"><label class="full">차종 / 프로젝트<input name="project" value="${esc(r?.project || '')}" maxlength="100"></label><label>시험실<select name="equipmentId">${data.equipment.map(e => option(e.id, e.name, eq)).join('')}</select></label><label>시험 종류<select name="testType"></select></label><label class="full">담당자<select name="ownerId">${data.users.map(u => option(u.id, u.name, r?.ownerId || me.id)).join('')}</select></label><label>시작 일시<input name="start" type="datetime-local" step="1800" value="${start}" required></label><label>종료 일시<input name="end" type="datetime-local" step="1800" value="${end}" required></label><label class="full checkbox-label"><input type="checkbox" name="includeWeekend" ${r?.includeWeekend ? 'checked' : ''}>주말 포함</label><label>상태<select name="status">${['계획', '진행', '완료', '취소'].map(s => option(s, s, r?.status || '계획')).join('')}</select></label>${r ? '<label>변경 사유<input name="reason" required maxlength="500"></label>' : ''}<label class="full">비고<textarea name="note" maxlength="2000">${esc(r?.note || '')}</textarea></label></div><p class="error" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-close>닫기</button><button type="submit" class="primary">${icon('check')}저장</button></div></form>`);
  const form = $('#reservation-form'), typeSelect = form.elements.testType;
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
  setTypes(); syncWeekend(); form.elements.equipmentId.onchange = () => { setTypes(); syncWeekend(); };
  form.elements.start.onchange = syncWeekend; form.elements.end.onchange = syncWeekend;
  form.onsubmit = async event => { event.preventDefault(); syncWeekend(); const values = Object.fromEntries(new FormData(form)); values.title = values.testType; values.includeWeekend = !form.elements.includeWeekend.disabled && form.elements.includeWeekend.checked; values.start = iso(values.start); values.end = iso(values.end); if (r) values.version = r.version;
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
  modal('시험 상세', `<dl class="detail-grid"><div class="full"><dt>시험명</dt><dd><strong>${esc(r.title)}</strong></dd></div><div><dt>시험실</dt><dd>${esc(equipmentName(r.equipmentId))}</dd></div><div><dt>시험 종류</dt><dd>${esc(r.testType)}</dd></div><div><dt>담당자</dt><dd>${esc(userName(r.ownerId))}</dd></div><div><dt>상태</dt><dd><span class="tag ${statusClass(r.status)}">${r.status}</span></dd></div><div class="full"><dt>예약 기간</dt><dd>${dateText(r.start)} ~ ${dateText(r.end)}</dd></div><div class="full"><dt>주말 포함</dt><dd>${r.includeWeekend ? '포함' : r.equipmentId === 'endurance' ? '연속 가동' : '기본 운영일'}</dd></div><div class="full"><dt>가동실적</dt><dd>${!a ? '미입력' : a.zero ? '0시간 · ' + esc(a.note) : dateText(a.start) + ' ~ ' + dateText(a.end)}</dd></div>${r.note ? `<div class="full"><dt>비고</dt><dd>${esc(r.note)}</dd></div>` : ''}</dl><div class="inline-actions"><button class="quiet" data-edit="${r.id}">${icon('pencil')}계획 수정</button>${r.status !== '취소' ? `<button class="primary" data-actual="${r.id}">${icon('timer')}실적 입력</button>` : ''}${a ? `<button class="quiet danger" data-remove-actual="${r.id}">${icon('trash-2')}실적 삭제</button>` : ''}</div><div class="section-heading"><h2>변경 이력</h2></div>${hist.reverse().map(h => `<div class="history-item"><strong>${esc(h.reason)}</strong><small>${dateText(h.at)} · ${esc(userName(h.userId))}</small><p>${h.before ? `${dateText(h.before.start)} ~ ${dateText(h.before.end)} / ${esc(h.before.status)} →<br>` : '최초 계획: '}${dateText(h.after.start)} ~ ${dateText(h.after.end)} / ${esc(h.after.status)}</p></div>`).join('')}`);
}
function actualForm(id) {
  const r = data.reservations.find(r => r.id === id), a = data.actuals.find(a => a.reservationId === id);
  modal('가동실적 입력', `<form id="actual-form"><p class="muted">${esc(r.title)}</p><div class="form-grid" style="margin-top:20px"><label>실제 시작<input name="start" type="datetime-local" step="1800" value="${local(a?.start || r.start)}" required></label><label>실제 종료<input name="end" type="datetime-local" step="1800" value="${local(a?.end || r.end)}" required></label><label class="checkbox-label full"><input name="zero" type="checkbox" ${a?.zero ? 'checked' : ''}>가동하지 않음 (0시간)</label><label class="full">실적 비고 / 비가동 사유<textarea name="note" maxlength="1000">${esc(a?.note || '')}</textarea></label></div><p class="error" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-close>닫기</button><button type="submit" class="primary">실적 저장</button></div></form>`);
  const form = $('#actual-form'); form.onsubmit = event => { event.preventDefault(); const v = Object.fromEntries(new FormData(form)); const zero = form.elements.zero.checked;
    saveForm(form, () => api('/api/actuals', 'POST', { reservationId: id, zero, note: v.note, ...(!zero ? { start: iso(v.start), end: iso(v.end) } : {}) }), '실적을 저장했습니다.'); };
}
function userForm() {
  modal('팀원 등록', `<form id="user-form"><div class="form-grid"><label>이름<input name="name" required maxlength="40"></label><label>아이디<input name="login" required pattern="[a-zA-Z0-9._-]{3,40}"></label><label class="full">초기 비밀번호<input name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="200"></label><label>권한<select name="role"><option value="member">팀원</option><option value="admin">관리자</option></select></label></div><p class="error" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-close>닫기</button><button class="primary" type="submit">팀원 등록</button></div></form>`);
  const form = $('#user-form'); form.onsubmit = event => { event.preventDefault(); saveForm(form, () => api('/api/users', 'POST', Object.fromEntries(new FormData(form))), '팀원을 등록했습니다.'); };
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
$('.sidebar nav').onclick = event => { const button = event.target.closest('[data-page]'); if (button && me) { page = button.dataset.page; actualState = ''; render(); } };
document.addEventListener('click', event => {
  const card = event.target.closest('[data-summary]'); if (!card || !me) return;
  page = ['equipment', 'occupancy'].includes(card.dataset.summary) ? 'capacity' : 'tests';
  actualState = card.dataset.summary === 'missing' ? 'missing' : '';
  search = ''; owner = ''; status = ''; render();
});
$('#view-modes').onclick = event => { const button = event.target.closest('[data-mode]'); if (button) { mode = button.dataset.mode; refresh(); } };
$('#previous').onclick = () => move(-1); $('#next').onclick = () => move(1);
function move(direction) { if (mode === 'month') { const d = new Date(date.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + direction); date = d.toISOString().slice(0, 10); } else date = addDays(date, direction * (mode === 'week' ? 7 : 1)); refresh(); }
$('#today').onclick = () => { date = today(); refresh(); };
$('#date-picker').onchange = event => { if (event.target.value) { date = event.target.value; refresh(); } };
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
    if (b?.dataset.detail) await detail(b.dataset.detail);
    else if (b?.dataset.edit) reservationForm(data.reservations.find(r => r.id === b.dataset.edit));
    else if (b?.dataset.actual) actualForm(b.dataset.actual);
    else if (b?.dataset.removeActual && confirm('이 시험의 실적을 삭제할까요? 계획은 유지되고 실적은 미입력으로 돌아갑니다.')) {
      b.disabled = true;
      try { await api('/api/actuals/' + b.dataset.removeActual, 'DELETE'); $('#modal').close(); toast('실적을 삭제했습니다.'); await refresh(); }
      finally { b.disabled = false; }
    }
    else if (b?.hasAttribute('data-add')) reservationForm();
    else if (b?.id === 'add-user') userForm();
    else if (b?.id === 'add-downtime') downtimeForm();
    else if (b?.id === 'edit-rules') rulesForm();
    else if (b?.id === 'save-baseline') { await api('/api/baselines', 'POST', { month: date.slice(0, 7) }); toast('월간 기준계획을 저장했습니다.'); await refresh(); }
    else if (b?.dataset.baseline) baselineDetail(b.dataset.baseline);
    else if (b?.dataset.removeDowntime && confirm('이 설비 정지 일정을 삭제할까요?')) { await api('/api/downtimes/' + b.dataset.removeDowntime, 'DELETE'); await refresh(); }
    else { const slot = event.target.closest('[data-slot]'); if (slot && !b) reservationForm(null, slot.dataset.slot, slot.dataset.day, slot.dataset.minute); }
  } catch (e) { error(e.message); }
});
setInterval(() => { if (me && !$('#modal').open && !document.hidden) refresh(); }, 15000);
window.addEventListener('focus', () => { if (me && !$('#modal').open) refresh(); });
init();
