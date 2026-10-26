import { EQUIPMENT, DEFAULT_RULES, supportsWeekend, canRunTogether, reservationRules, MIN, DAY, OFFSET, isAroundClock, isContinuous, ms, dayStart, clock, isHoliday, isOperatingDay, validateInterval, merge, intersect, subtract, minutes, windows } from './operating-rules.mjs';
export { EQUIPMENT, DEFAULT_RULES, supportsWeekend, canRunTogether, isAroundClock, isContinuous, validateInterval, merge };
import { validatePlannedWindows } from './consecutive-windows.mjs';
export function expandReservation(r, rules = DEFAULT_RULES, { validateOperatingDays = true } = {}) {
  if(r.plannedWindows !== undefined) return validatePlannedWindows(r,rules,{validateOperatingDays});
  rules = reservationRules(r, rules);
  const [a, b] = validateInterval(r.start, r.end);
  if (!EQUIPMENT.some(e => e.id === r.equipmentId)) throw new Error('시험실을 선택해 주세요.');
  if (isAroundClock(r)) return [{ start: new Date(a).toISOString(), end: new Date(b).toISOString() }];
  const from = clock(a), to = clock(b) === 0 && rules.close === 1440 ? 1440 : clock(b);
  const finalDay = to === 1440 ? dayStart(b) - DAY : dayStart(b);
  if (from < rules.open || to > rules.close || to <= from) throw new Error('일반 설비는 매일 운영시간 안에서 시작·종료 시간을 지정해 주세요.');
  if (!rules.days.includes(new Date(a + OFFSET).getUTCDay()) || !rules.days.includes(new Date(finalDay + OFFSET).getUTCDay())) throw new Error('시작일과 종료일은 운영일이어야 합니다.');
  if (validateOperatingDays && (isHoliday(a, rules) || isHoliday(finalDay, rules))) throw new Error('시작일과 종료일은 공휴일이 아닌 운영일이어야 합니다.');
  const list = [];
  for (let d = dayStart(a); d <= finalDay; d += DAY) {
    if (isOperatingDay(d, rules)) list.push({ start: new Date(d + from * MIN).toISOString(), end: new Date(d + to * MIN).toISOString() });
  }
  if (!list.length && validateOperatingDays) throw new Error('예약 기간에 운영일이 없습니다.');
  return list;
}
export function activeIntervals(r, rules = DEFAULT_RULES) {
  const operatingRules = reservationRules(r, rules);
  return expandReservation(r, rules, { validateOperatingDays: false }).flatMap(i => windows(i.start, i.end, r.equipmentId, isContinuous(r), operatingRules));
}
export const operatingMinutes = (r, rules) => minutes(activeIntervals(r, rules));
export function capacity({ equipmentId, start, end, reservations = [], downtimes = [], rules = DEFAULT_RULES }) {
  const [a, b] = validateInterval(start, end, { maxDays: 3660 });
  const span = [[a, b]];
  const bookings = reservations.filter(r => r.equipmentId === equipmentId && r.status !== '취소');
  const base = equipmentId === 'endurance' ? [[a, b]] : windows(start, end, equipmentId, false, rules);
  const extra = bookings.filter(r => isContinuous(r) || (supportsWeekend(r.equipmentId) && r.includeWeekend === true)).flatMap(r => activeIntervals(r, rules));
  const stops = downtimes.map(d => [ms(d.start), ms(d.end)]);
  const available = subtract(intersect(merge([...base, ...extra]), span), stops);
  const planned = intersect(bookings.flatMap(r => activeIntervals(r, rules)), available);
  return { availableMinutes: minutes(available), plannedMinutes: minutes(planned) };
}
