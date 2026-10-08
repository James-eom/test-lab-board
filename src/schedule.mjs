export const EQUIPMENT = [
  { id: 'engine-1', name: '엔진동력계실 #1', group: '엔진 시험', types: ['배압 시험', '토출/방사음 시험'] },
  { id: 'engine-2', name: '엔진동력계실 #2', group: '엔진 시험', types: ['배압 시험', '토출/방사음 시험'] },
  { id: 'flow', name: '유동저항 시험실', group: '성능 시험', types: ['유동저항 시험'] },
  { id: 'thermal-1', name: '열가진 내구시험실 #1', group: '열·내구 시험', types: ['열피로 시험', '열충격 시험', '열피로/열충격 시험', '고온가진 시험', '이음 시험', '기류음 시험', '유동저항 시험', '결빙시험', '기타 성능시험'] },
  { id: 'thermal-2', name: '열가진 내구시험실 #2', group: '열·내구 시험', types: ['열피로 시험', '열충격 시험', '열피로/열충격 시험', '고온가진 시험', '이음 시험', '기류음 시험', '유동저항 시험', '결빙시험', '기타 성능시험'] },
  { id: 'endurance', name: '단품 대상내구 시험실', group: '연속 내구', types: ['단품 대상내구 시험'] },
];
export const DEFAULT_RULES = { days: [1, 2, 3, 4, 5], open: 510, close: 1230, breaks: [[750, 810], [1050, 1080]] };
export const supportsWeekend = id => ['engine-1', 'engine-2', 'flow'].includes(id);
export const canRunTogether = (a, b) => a.equipmentId === b.equipmentId && ['engine-1', 'engine-2'].includes(a.equipmentId) && ['배압 시험', '토출/방사음 시험'].includes(a.testType) && ['배압 시험', '토출/방사음 시험'].includes(b.testType) && a.testType !== b.testType;
const reservationRules = (r, rules) => supportsWeekend(r.equipmentId) && r.includeWeekend === true ? { ...rules, days: [...new Set([...rules.days, 0, 6])] } : rules;
const MIN = 60000, DAY = 86400000, OFFSET = 9 * 3600000;
export const isContinuous = r => r.equipmentId === 'endurance' || (r.equipmentId.startsWith('thermal') && ['열피로 시험', '열충격 시험', '열피로/열충격 시험'].includes(r.testType));
const ms = v => new Date(v).getTime();
const dayStart = t => Math.floor((t + OFFSET) / DAY) * DAY - OFFSET;
const clock = t => (t - dayStart(t)) / MIN;

export function validateInterval(start, end) {
  const a = ms(start), b = ms(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new Error('종료 일시는 시작 일시보다 뒤여야 합니다.');
  if (a % (30 * MIN) || b % (30 * MIN)) throw new Error('시간은 30분 경계로 입력해 주세요.');
  if (b - a > 366 * DAY) throw new Error('한 번의 예약은 최대 366일까지 가능합니다.');
  return [a, b];
}
export function merge(intervals) {
  const result = [];
  for (const [a, b] of intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = result.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(b, last[1]);
    else result.push([a, b]);
  }
  return result;
}
function intersect(a, b) {
  return merge(a.flatMap(([s, e]) => b.map(([x, y]) => [Math.max(s, x), Math.min(e, y)])));
}
function subtract(a, b) {
  let out = merge(a);
  for (const [x, y] of merge(b)) out = out.flatMap(([s, e]) => y <= s || x >= e ? [[s, e]] : [[s, Math.min(e, x)], [Math.max(s, y), e]].filter(([p, q]) => q > p));
  return out;
}
const minutes = list => merge(list).reduce((sum, [a, b]) => sum + (b - a) / MIN, 0);
function windows(start, end, equipmentId, continuous, rules = DEFAULT_RULES) {
  const a = ms(start), b = ms(end);
  if (equipmentId === 'endurance') return [[a, b]];
  const out = [];
  for (let d = dayStart(a); d < b; d += DAY) {
    if (!rules.days.includes(new Date(d + OFFSET).getUTCDay())) continue;
    let pieces = [[d + rules.open * MIN, d + rules.close * MIN]];
    if (!continuous) pieces = subtract(pieces, rules.breaks.map(([x, y]) => [d + x * MIN, d + y * MIN]));
    out.push(...intersect(pieces, [[a, b]]));
  }
  return out;
}
export function expandReservation(r, rules = DEFAULT_RULES) {
  rules = reservationRules(r, rules);
  const [a, b] = validateInterval(r.start, r.end);
  if (!EQUIPMENT.some(e => e.id === r.equipmentId)) throw new Error('시험실을 선택해 주세요.');
  if (r.equipmentId === 'endurance') return [{ start: new Date(a).toISOString(), end: new Date(b).toISOString() }];
  const from = clock(a), to = clock(b);
  if (from < rules.open || to > rules.close || to <= from) throw new Error('일반 설비는 매일 운영시간 안에서 시작·종료 시간을 지정해 주세요.');
  if (!rules.days.includes(new Date(a + OFFSET).getUTCDay()) || !rules.days.includes(new Date(b + OFFSET).getUTCDay())) throw new Error('시작일과 종료일은 운영일이어야 합니다.');
  const list = [];
  for (let d = dayStart(a); d <= dayStart(b); d += DAY) {
    if (rules.days.includes(new Date(d + OFFSET).getUTCDay())) list.push({ start: new Date(d + from * MIN).toISOString(), end: new Date(d + to * MIN).toISOString() });
  }
  if (!list.length) throw new Error('예약 기간에 운영일이 없습니다.');
  return list;
}
export function activeIntervals(r, rules = DEFAULT_RULES) {
  const operatingRules = reservationRules(r, rules);
  return expandReservation(r, rules).flatMap(i => windows(i.start, i.end, r.equipmentId, isContinuous(r), operatingRules));
}
export const operatingMinutes = (r, rules) => minutes(activeIntervals(r, rules));
export function capacity({ equipmentId, start, end, reservations = [], downtimes = [], rules = DEFAULT_RULES }) {
  const [a, b] = validateInterval(start, end);
  const span = [[a, b]];
  const bookings = reservations.filter(r => r.equipmentId === equipmentId && r.status !== '취소');
  const base = windows(start, end, equipmentId, false, rules);
  const extra = bookings.filter(r => isContinuous(r) || (supportsWeekend(r.equipmentId) && r.includeWeekend === true)).flatMap(r => activeIntervals(r, rules));
  const stops = downtimes.map(d => [ms(d.start), ms(d.end)]);
  const available = subtract(intersect(merge([...base, ...extra]), span), stops);
  const planned = intersect(bookings.flatMap(r => activeIntervals(r, rules)), available);
  return { availableMinutes: minutes(available), plannedMinutes: minutes(planned) };
}
