import test from 'node:test';
import assert from 'node:assert/strict';
import { capacity, expandReservation, operatingMinutes } from '../src/schedule.mjs';

const day = { start: '2026-10-05T00:00:00+09:00', end: '2026-10-06T00:00:00+09:00' };
test('ordinary equipment has 630 minutes per weekday and 3150 per week', () => {
  assert.equal(capacity({ equipmentId: 'engine-1', ...day }).availableMinutes, 630);
  assert.equal(capacity({ equipmentId: 'engine-1', start: day.start, end: '2026-10-12T00:00:00+09:00' }).availableMinutes, 3150);
});
test('thermal continuous tests add only the occupied break time', () => {
  const r = { equipmentId: 'thermal-1', testType: '열피로 시험', start: '2026-10-05T08:30:00+09:00', end: '2026-10-05T20:30:00+09:00' };
  assert.equal(capacity({ equipmentId: 'thermal-1', ...day, reservations: [r] }).availableMinutes, 720);
  assert.equal(operatingMinutes(r), 720);
  assert.equal(operatingMinutes({ ...r, testType: '고온가진 시험' }), 630);
  assert.equal(operatingMinutes({ ...r, testType: '기타 성능시험' }), 630);
});
test('endurance reserves nights and weekends continuously', () => {
  assert.equal(capacity({ equipmentId: 'endurance', start: day.start, end: '2026-10-12T00:00:00+09:00' }).availableMinutes, 10080);
  const r = { equipmentId: 'endurance', testType: '단품 대상내구 시험', start: '2026-10-09T20:30:00+09:00', end: '2026-10-12T08:30:00+09:00' };
  assert.equal(operatingMinutes(r), 3600);
  assert.equal(expandReservation(r).length, 1);
});
test('multiday ordinary bookings expand only on weekdays', () => {
  const r = { equipmentId: 'engine-1', testType: '엔진 시험', start: '2026-10-09T08:30:00+09:00', end: '2026-10-12T20:30:00+09:00' };
  assert.equal(expandReservation(r).length, 2);
  assert.equal(operatingMinutes(r), 1260);
});
test('weekend opt-in permits only the three ordinary rooms and preserves breaks', () => {
  for (const equipmentId of ['engine-1', 'engine-2', 'flow']) {
    const r = { equipmentId, includeWeekend: true, start: '2026-10-10T08:30:00+09:00', end: '2026-10-11T20:30:00+09:00' };
    assert.equal(expandReservation(r).length, 2);
    assert.equal(operatingMinutes(r), 1260);
    assert.throws(() => expandReservation({ ...r, includeWeekend: false }), /운영일/);
    assert.throws(() => expandReservation({ ...r, start: '2026-10-10T08:00:00+09:00' }), /운영시간/);
  }
  assert.throws(() => expandReservation({ equipmentId: 'thermal-1', includeWeekend: true, start: '2026-10-10T08:30:00+09:00', end: '2026-10-10T20:30:00+09:00' }), /운영일/);
});
test('weekend capacity adds only occupied working intervals and subtracts stops', () => {
  const span = { start: '2026-10-05T00:00:00+09:00', end: '2026-10-12T00:00:00+09:00' };
  const r = { equipmentId: 'engine-1', includeWeekend: true, start: '2026-10-10T12:00:00+09:00', end: '2026-10-10T14:00:00+09:00' };
  assert.deepEqual(capacity({ equipmentId: r.equipmentId, ...span, reservations: [r, r] }), { availableMinutes: 3210, plannedMinutes: 60 });
  assert.deepEqual(capacity({ equipmentId: r.equipmentId, ...span, reservations: [r], downtimes: [{ start: '2026-10-10T13:30:00+09:00', end: '2026-10-10T14:00:00+09:00' }] }), { availableMinutes: 3180, plannedMinutes: 30 });
  assert.equal(capacity({ equipmentId: r.equipmentId, ...span, reservations: [{ ...r, status: '취소' }] }).availableMinutes, 3150);
  const multi = { ...r, start: '2026-10-09T08:30:00+09:00', end: '2026-10-12T20:30:00+09:00' };
  assert.equal(expandReservation(multi).length, 4);
  assert.equal(operatingMinutes(multi), 2520);
});
test('overlap union, downtime, and month boundary are exact', () => {
  const r = { equipmentId: 'endurance', testType: '단품 대상내구 시험', start: '2026-10-31T23:00:00+09:00', end: '2026-11-01T01:00:00+09:00' };
  assert.equal(capacity({ equipmentId: 'endurance', start: '2026-10-31T00:00:00+09:00', end: '2026-11-01T00:00:00+09:00', reservations: [r, r] }).plannedMinutes, 60);
  assert.equal(capacity({ equipmentId: 'engine-1', ...day, downtimes: [{ start: '2026-10-05T12:00:00+09:00', end: '2026-10-05T14:00:00+09:00' }] }).availableMinutes, 570);
});
test('zero capacity and invalid intervals are handled explicitly', () => {
  assert.equal(capacity({ equipmentId: 'engine-1', start: '2026-10-10T00:00:00+09:00', end: '2026-10-11T00:00:00+09:00' }).availableMinutes, 0);
  assert.throws(() => expandReservation({ equipmentId: 'engine-1', start: day.end, end: day.start }));
  assert.throws(() => expandReservation({ equipmentId: 'engine-1', start: '2026-10-05T08:45:00+09:00', end: '2026-10-05T09:30:00+09:00' }));
});
