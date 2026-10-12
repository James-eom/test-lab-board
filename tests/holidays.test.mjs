import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { NATIONAL_HOLIDAYS } from '../src/holidays.mjs';
import { capacity, expandReservation } from '../src/schedule.mjs';

test('national holidays reduce October working days; weekend opt-in cannot include holidays', () => {
  const s = new Store(':memory:');
  try {
    const rules = s.rules(), span = { start: '2026-10-01T00:00:00+09:00', end: '2026-11-01T00:00:00+09:00' };
    assert.equal(capacity({ equipmentId: 'engine-1', ...span, rules }).availableMinutes, 20 * 630);
    assert.equal(capacity({ equipmentId: 'endurance', ...span, rules }).availableMinutes, 31 * 1440);
    const r = { equipmentId: 'engine-1', includeWeekend: true, start: '2026-10-08T08:30:00+09:00', end: '2026-10-12T20:30:00+09:00' };
    assert.equal(expandReservation(r, rules).length, 4);
    assert.throws(() => expandReservation({ ...r, start: '2026-10-09T08:30:00+09:00' }, rules), /공휴일/);
    for (const equipmentId of ['engine-1', 'thermal-1']) assert.equal(capacity({ equipmentId, start: '2026-10-09T00:00:00+09:00', end: '2026-10-10T00:00:00+09:00', rules }).availableMinutes, 0);
    assert.ok(NATIONAL_HOLIDAYS.some(h => h.date === '2026-05-01'));
    assert.ok(NATIONAL_HOLIDAYS.some(h => h.date === '2026-07-17'));
    assert.ok(NATIONAL_HOLIDAYS.some(h => h.date === '2027-02-09'));
    assert.ok(!NATIONAL_HOLIDAYS.some(h => h.date === '2026-09-28'));
    assert.equal(new Set(NATIONAL_HOLIDAYS.map(h => h.date)).size, NATIONAL_HOLIDAYS.length);
  } finally { s.db.close(); }
});

test('adding a holiday preserves records, snapshots and actuals, and removing restores conflicts', () => {
  const s = new Store(':memory:'); const u = s.addUser('tester', '담당자', 'hash', 'admin');
  try {
    const r = s.saveReservation({ equipmentId: 'engine-1', testType: '배압 시험', title: '보존 시험', ownerId: u.id, start: '2026-10-12T08:30:00+09:00', end: '2026-10-12T09:30:00+09:00', status: '계획' }, u.id);
    const original = s.originalPlans()[0];
    s.saveActual({ reservationId: r.id, start: r.start, end: r.end }, u.id);
    s.saveHoliday({ date: '2026-10-12', name: '임시공휴일' });
    assert.deepEqual(expandReservation(r, s.rules(), { validateOperatingDays: false }), []);
    assert.equal(s.actuals().length, 1);
    assert.deepEqual(s.originalPlans()[0], original);
    assert.throws(() => s.saveReservation({ ...r }, u.id), /공휴일/);
    assert.equal(s.saveReservation({ ...r, reason: '명칭 변경', title: '변경' }, u.id, r.id).title, '변경');
    s.saveRules({ ...s.rules() });
    assert.ok(s.rules().holidays.some(h => h.date === '2026-10-12'));
    s.removeHoliday('2026-10-12');
    assert.throws(() => s.saveReservation({ ...r }, u.id), /중복/);
    assert.throws(() => s.removeHoliday('2026-10-09'), /추가 등록/);
    assert.throws(() => s.saveHoliday({ date: '2026-02-30', name: '오류' }), /날짜/);
    assert.throws(() => s.saveHoliday({ date: '2026-10-09', name: '중복' }), /이미/);
  } finally { s.db.close(); }
});
