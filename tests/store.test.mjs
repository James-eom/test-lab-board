import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
const sample = { equipmentId: 'engine-1', testType: '엔진 시험', title: '시험 예약', project: '', start: '2026-10-12T08:30:00+09:00', end: '2026-10-12T10:30:00+09:00', status: '계획', note: '' };
test('booking overlaps and stale updates are rejected, adjacent bookings allowed', () => {
  const s = new Store(':memory:');
  const u = s.addUser('tester', '시험 담당자', 'password-hash', 'admin');
  const a = s.saveReservation({ ...sample, ownerId: u.id }, u.id);
  assert.throws(() => s.saveReservation({ ...sample, ownerId: u.id }, u.id), /중복/);
  s.saveReservation({ ...sample, ownerId: u.id, start: sample.end, end: '2026-10-12T11:30:00+09:00' }, u.id);
  assert.throws(() => s.saveReservation({ ...a, version: 0, reason: '변경' }, u.id, a.id), /다른/);
  const updated = s.saveReservation({ ...a, title: '시험명 수정', reason: '명칭 변경' }, u.id, a.id);
  assert.equal(updated.version, 2);
  assert.equal(s.history(a.id).length, 2);
  assert.equal(s.history(a.id)[1].before.title, '시험 예약');
  s.db.close();
});
test('explicit zero actual is not missing and baseline is immutable', () => {
  const s = new Store(':memory:');
  const u = s.addUser('tester', '시험 담당자', 'hash', 'admin');
  const r = s.saveReservation({ ...sample, ownerId: u.id }, u.id);
  assert.equal(s.actuals().length, 0);
  s.saveActual({ reservationId: r.id, zero: true, note: '설비 정지' }, u.id);
  assert.equal(s.actuals()[0].zero, true);
  const b = s.saveBaseline('2026-10', u.id);
  s.saveReservation({ ...r, title: '변경', reason: '시험명 변경' }, u.id, r.id);
  assert.equal(s.baselines()[0].reservations[0].title, b.reservations[0].title);
  s.db.close();
});
test('monthly baseline includes the last day and excludes next month', () => {
  const s = new Store(':memory:'); const u = s.addUser('tester', '담당자', 'hash', 'admin');
  s.saveReservation({ equipmentId: 'endurance', testType: '단품 대상내구 시험', title: '월말', ownerId: u.id, start: '2026-10-31T20:30:00+09:00', end: '2026-11-01T08:30:00+09:00', status: '계획' }, u.id);
  s.saveReservation({ equipmentId: 'endurance', testType: '단품 대상내구 시험', title: '다음달', ownerId: u.id, start: '2026-11-01T09:30:00+09:00', end: '2026-11-01T10:30:00+09:00', status: '계획' }, u.id);
  assert.deepEqual(s.saveBaseline('2026-10', u.id).reservations.map(r => r.title), ['월말']); s.db.close();
});
