import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { EQUIPMENT, expandReservation, operatingMinutes, capacity } from '../src/schedule.mjs';

const performance = { equipmentId: 'endurance', testType: '성능시험', title: '성능시험', status: '계획', start: '2026-10-02T08:30:00+09:00', end: '2026-10-06T20:30:00+09:00' };

test('new types are room-specific; performance uses operating days and breaks while SN remains continuous', () => {
  const store = new Store(':memory:');
  try {
    const rules = store.rules();
    assert.deepEqual(EQUIPMENT.filter(e => e.types.includes('성능시험')).map(e => e.id), ['endurance']);
    assert.deepEqual(EQUIPMENT.filter(e => e.types.includes('Glass Wool 내구')).map(e => e.id), ['thermal-1', 'thermal-2']);
    assert.equal(expandReservation(performance, rules).length, 2);
    assert.equal(operatingMinutes(performance, rules), 1260);
    for (const equipmentId of ['thermal-1', 'thermal-2']) assert.equal(operatingMinutes({ ...performance, equipmentId, testType: 'Glass Wool 내구' }, rules), 1260);
    const sn = { ...performance, testType: 'SN 커브 추출시험', start: '2026-10-03T00:00:00+09:00', end: '2026-10-05T00:00:00+09:00' };
    assert.equal(operatingMinutes(sn, rules), 2880);
    assert.throws(() => expandReservation({ ...sn, testType: '성능시험' }, rules), /운영시간|운영일/);
    assert.throws(() => expandReservation({ ...performance, start: '2026-10-05T08:30:00+09:00' }, rules), /공휴일/);
    const cap = capacity({ equipmentId: 'endurance', start: '2026-10-02T00:00:00+09:00', end: '2026-10-07T00:00:00+09:00', reservations: [performance], rules });
    assert.equal(cap.availableMinutes, 5 * 1440); // Room availability stays 24h; performance occupation does not.
    assert.equal(cap.plannedMinutes, 1260);
  } finally { store.db.close(); }
});

test('new types save, enforce room/time/conflicts, and cannot bypass rules by editing continuous bookings', () => {
  const store = new Store(':memory:');
  const user = store.addUser('manager', '관리자', 'hash', 'admin');
  try {
    const input = { ...performance, ownerId: user.id };
    assert.throws(() => store.saveReservation({ ...input, equipmentId: 'thermal-1' }, user.id), /설비와 시험 종류/);
    const saved = store.saveReservation(input, user.id);
    assert.throws(() => store.saveReservation({ ...input, testType: 'SN 커브 추출시험' }, user.id), e => e.code === 'DUPLICATE_BOOKING');
    const sn = store.saveReservation({ ...input, testType: 'SN 커브 추출시험', start: '2026-10-09T08:30:00+09:00', end: '2026-10-09T20:30:00+09:00' }, user.id);
    assert.throws(() => store.saveReservation({ ...sn, testType: '성능시험', version: sn.version, reason: '종류 변경' }, user.id, sn.id), /공휴일/);
    store.saveActual({ reservationId: saved.id, start: input.start, end: input.end }, user.id);
    assert.equal(store.actuals().length, 1);
  } finally { store.db.close(); }
});
