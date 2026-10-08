import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import XLSX from 'xlsx';
test('setup, authentication, csrf, reservation validation, and export', async () => {
  const { server, store } = createApp({ dbPath: ':memory:' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '', csrf = '';
  const request = async (path, method = 'GET', body, useCsrf = true) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: base, cookie, ...(useCsrf ? { 'x-csrf-token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return res;
  };
  try {
    assert.equal((await request('/api/reservations', 'POST', {})).status, 401);
    let res = await request('/api/setup', 'POST', { login: 'manager', name: '관리자', password: 'test-password-123' });
    assert.equal(res.status, 201);
    const account = await res.json(); csrf = account.csrf;
    assert.equal((await request('/api/users', 'POST', { login: 'member', name: '담당자', password: 'another-password' }, false)).status, 403);
    const booking = { title: '검증 예약', equipmentId: 'engine-1', testType: '엔진 시험', ownerId: account.user.id, start: '2026-10-12T08:30:00+09:00', end: '2026-10-12T09:30:00+09:00', status: '계획' };
    assert.equal((await request('/api/reservations', 'POST', booking)).status, 201);
    assert.equal((await request('/api/reservations', 'POST', booking)).status, 409);
    assert.equal((await request('/api/reservations', 'POST', { ...booking, equipmentId: 'wrong' })).status, 400);
    const exported = await request('/api/export?start=2026-10-01T00:00:00%2B09:00&end=2026-11-01T00:00:00%2B09:00');
    assert.equal(exported.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const workbook = XLSX.read(Buffer.from(await exported.arrayBuffer()), { type: 'buffer' });
    const values = XLSX.utils.sheet_to_json(workbook.Sheets['시험계획']);
    assert.equal(values[0].시험명, '검증 예약');
    const dt = XLSX.SSF.parse_date_code(values[0].시작);
    assert.equal(dt.H, 8); assert.equal(dt.M, 30); assert.equal(dt.d, 12);
    assert.equal((await request('/api/setup', 'POST', {})).status, 409);
    assert.equal((await request('/api/state')).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); store.db.close(); }
});
