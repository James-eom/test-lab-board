import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
const sample = { equipmentId: 'engine-1', testType: '배압 시험', title: '시험 예약', project: '', start: '2026-10-12T08:30:00+09:00', end: '2026-10-12T10:30:00+09:00', status: '계획', note: '' };
test('only opposite engine test types may overlap in either room', () => {
  const s = new Store(':memory:'); const u = s.addUser('tester', '담당자', 'hash', 'admin');
  try {
    for (const equipmentId of ['engine-1', 'engine-2']) {
      const a = s.saveReservation({ ...sample, equipmentId, ownerId: u.id }, u.id);
      const b = s.saveReservation({ ...a, testType: '토출/방사음 시험' }, u.id);
      assert.throws(() => s.saveReservation({ ...a }, u.id), /중복/);
      assert.throws(() => s.saveReservation({ ...b }, u.id), /중복/);
      assert.throws(() => s.saveReservation({ ...b, testType: '배압 시험', reason: '종류 변경' }, u.id, b.id), /중복/);
      s.saveReservation({ ...b, title: '시험명 수정', reason: '명칭 변경' }, u.id, b.id);
    }
    for (const equipmentId of ['thermal-1', 'thermal-2']) {
      s.saveReservation({ ...sample, equipmentId, testType: '기타 성능시험', ownerId: u.id }, u.id);
      assert.throws(() => s.saveReservation({ ...sample, equipmentId, testType: '고온가진 시험', ownerId: u.id }, u.id), /중복/);
    }
  } finally { s.db.close(); }
});
test('legacy engine types remain editable but cannot be used for new bookings', () => {
  const s = new Store(':memory:'); const u = s.addUser('tester', '담당자', 'hash', 'admin');
  try {
    const r = s.saveReservation({ ...sample, ownerId: u.id }, u.id);
    const legacy = { ...r, testType: '엔진 시험' };
    s.db.prepare('UPDATE reservations SET payload=? WHERE id=?').run(JSON.stringify(legacy), r.id);
    assert.equal(s.saveReservation({ ...legacy, title: '기존 예약 수정', reason: '명칭 변경' }, u.id, r.id).testType, '엔진 시험');
    assert.throws(() => s.saveReservation({ ...legacy }, u.id), /시험 종류/);
    assert.throws(() => s.saveReservation({ ...sample, testType: '토출/방사음 시험', ownerId: u.id }, u.id), /중복/);
  } finally { s.db.close(); }
});
test('original interval snapshots survive date edits and operating rule changes', () => {
  const s = new Store(':memory:'); const u = s.addUser('tester', '담당자', 'hash', 'admin');
  try {
    const r = s.saveReservation({ ...sample, ownerId: u.id }, u.id);
    const original = s.originalPlans()[0];
    s.saveReservation({ ...r, start: '2026-10-13T09:30:00+09:00', end: '2026-10-13T11:30:00+09:00', reason: '일정 이동' }, u.id, r.id);
    s.saveRules({ ...s.rules(), open: 570 });
    assert.deepEqual(s.originalPlans()[0], original);
    assert.equal((original.plannedIntervals[0][1] - original.plannedIntervals[0][0]) / 60000, 120);
    const legacy = { ...s.history(r.id)[0] }; delete legacy.plannedIntervals;
    s.db.prepare('UPDATE history SET payload=? WHERE seq=(SELECT MIN(seq) FROM history WHERE reservationId=?)').run(JSON.stringify(legacy), r.id);
    assert.deepEqual(s.originalPlans()[0].plannedIntervals, original.plannedIntervals);
  } finally { s.db.close(); }
});
test('weekend flag persists, conflicts and actual edits remain protected', () => {
  const s = new Store(':memory:'); const u = s.addUser('tester', '담당자', 'hash', 'admin');
  try {
    const booking = { ...sample, ownerId: u.id, includeWeekend: true, start: '2026-10-10T08:30:00+09:00', end: '2026-10-11T20:30:00+09:00' };
    const r = s.saveReservation(booking, u.id);
    assert.equal(s.reservation(r.id).includeWeekend, true);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM intervals').get().n, 2);
    assert.throws(() => s.saveReservation(booking, u.id), /중복/);
    assert.throws(() => s.saveReservation({ ...booking, includeWeekend: 'true' }, u.id), /주말/);
    s.saveActual({ reservationId: r.id, start: r.start, end: r.end }, u.id);
    const weekday = s.saveReservation({ ...sample, ownerId: u.id, includeWeekend: true }, u.id);
    s.saveActual({ reservationId: weekday.id, start: weekday.start, end: weekday.end }, u.id);
    assert.throws(() => s.saveReservation({ ...weekday, includeWeekend: false, reason: '주말 해제' }, u.id, weekday.id), /실적/);
    assert.equal(s.saveBaseline('2026-10', u.id).reservations.find(b => b.id === r.id).includeWeekend, true);
  } finally { s.db.close(); }
});
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
