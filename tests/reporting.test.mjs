import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { createApp } from '../server.mjs';

test('multi-year reports refresh all holiday years, include the last date and keep booking limits', async () => {
  const fetched = [];
  const app = createApp({ dbPath: ':memory:', holidayFetch: async url => {
    const year = url.searchParams.get('solYear'); fetched.push(Number(year));
    return { ok: true, text: async () => `<response><header><resultCode>00</resultCode></header><body><items><item><locdate>${year}0101</locdate><dateName>신정</dateName><isHoliday>Y</isHoliday></item></items><totalCount>1</totalCount></body></response>` };
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'manager', name: '관리자', password: 'test-password-123' }) });
    const account = await setup.json(), headers = { cookie: setup.headers.get('set-cookie').split(';')[0], 'x-csrf-token': account.csrf, 'content-type': 'application/json' };
    app.store.saveHolidayApiKey('test-key-not-a-real-secret-123');
    const booking = { equipmentId: 'flow', testType: '유동저항 시험', title: '종료일 시험', ownerId: account.user.id, start: '2027-01-04T19:30:00+09:00', end: '2027-01-04T20:30:00+09:00', status: '계획' };
    app.store.saveReservation(booking, account.user.id);
    app.store.saveReservation({ ...booking, title: '종료일 이후', start: '2027-01-05T08:30:00+09:00', end: '2027-01-05T09:30:00+09:00' }, account.user.id);
    const query = new URLSearchParams({ start: '2026-01-01T00:00:00+09:00', end: '2027-01-05T00:00:00+09:00' });
    let response = await fetch(`${base}/api/state?${query}`, { headers }); assert.equal(response.status, 200);
    const state = await response.json(); assert.deepEqual(fetched.sort(), [2026, 2027]);
    for (const year of [2026, 2027]) assert.equal(state.rules.holidays.find(h => h.date === `${year}-01-01`).source, 'api');
    response = await fetch(`${base}/api/capacity?${query}`, { headers }); assert.equal(response.status, 200);
    assert.equal((await response.json()).find(e => e.id === 'flow').plannedMinutes, 60);
    response = await fetch(`${base}/api/export?${query}`, { headers }); assert.equal(response.status, 200);
    const book = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer' });
    assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets['시험계획']).map(r => r.시험명), ['종료일 시험']);
    assert.throws(() => app.store.saveReservation({ ...booking, equipmentId: 'endurance', testType: '단품 대상내구 시험', start: '2026-01-01T00:00:00+09:00', end: '2028-01-01T00:00:00+09:00' }, account.user.id), /366/);
    const invalid = new URLSearchParams({ start: '2027-01-05T00:00:00+09:00', end: '2027-01-04T00:00:00+09:00' });
    assert.equal((await fetch(`${base}/api/state?${invalid}`, { headers })).status, 400);
    const tooLong = new URLSearchParams({ start: '2000-01-01T00:00:00+09:00', end: '2020-01-01T00:00:00+09:00' });
    assert.equal((await fetch(`${base}/api/capacity?${tooLong}`, { headers })).status, 400);
  } finally { await new Promise(resolve => app.server.close(resolve)); app.store.db.close(); }
});
