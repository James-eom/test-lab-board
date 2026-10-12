import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

test('removed automatic APIs cannot generate or confirm; existing schedules/history and metadata remain editable', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const response = await fetch(base + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'manager', name: '관리자', password: 'test-password-123' }) });
    const cookie = response.headers.get('set-cookie').split(';')[0], account = await response.json();
    const call = (path, method = 'GET', data) => fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': account.csrf }, body: data ? JSON.stringify(data) : undefined });
    const r = app.store.saveReservation({ equipmentId: 'engine-1', testType: '배압 시험', title: '기존 자동 배치 시험', ownerId: account.user.id, start: '2026-10-12T08:30:00+09:00', end: '2026-10-12T20:30:00+09:00', status: '계획' }, account.user.id);
    const metadata = { planId: 'legacy-plan', requiredDays: 1, itemIndex: 0 };
    app.store.db.prepare('UPDATE reservations SET payload=? WHERE id=?').run(JSON.stringify({ ...r, automaticPlan: metadata }), r.id);
    app.store.db.prepare('INSERT INTO automatic_plans VALUES(?,?)').run('legacy-plan', JSON.stringify({ id: 'legacy-plan', assignments: [{ reservationId: r.id }] }));
    app.store.saveActual({ reservationId: r.id, zero: true, note: '실적 보존' }, account.user.id);
    app.store.saveBaseline('2026-10', account.user.id);
    const before = app.store.scheduleDeletionPreview();
    for (const path of ['/api/autoplans/preview', '/api/autoplans/confirm']) {
      assert.equal((await call(path, 'POST', { previewId: 'legacy-plan' })).status, 404);
      assert.equal((await call(path)).status, 404);
    }
    const state = await (await call('/api/state')).json();
    assert.equal(Object.hasOwn(state, 'automaticPlans'), false);
    assert.equal(state.reservations.length, 1); assert.equal(state.actuals.length, 1); assert.equal(state.baselines.length, 1);
    assert.deepEqual(state.reservations[0].automaticPlan, metadata);
    assert.equal((await (await call(`/api/reservations/${r.id}/history`)).json()).length, 1);
    assert.deepEqual(app.store.scheduleDeletionPreview(), before);
    assert.equal((await call('/api/capacity?start=2026-10-12T00:00:00%2B09:00&end=2026-10-13T00:00:00%2B09:00')).status, 200);
    assert.equal((await call('/api/export?start=2026-10-12T00:00:00%2B09:00&end=2026-10-13T00:00:00%2B09:00')).status, 200);
    assert.equal((await call(`/api/reservations/${r.id}`, 'PUT', { ...r, title: '직접 수정', reason: '수동 변경' })).status, 200);
    assert.deepEqual(app.store.reservation(r.id).automaticPlan, metadata);
    assert.equal(app.store.history(r.id).length, 2);
    assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM automatic_plans').get().n, 1);
    const invalid = await call('/api/reservations', 'POST', { ...r, equipmentId: 'endurance', testType: '성능시험', start: '2026-10-05T08:30:00+09:00', end: '2026-10-06T20:30:00+09:00' });
    assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /공휴일/);
    const html = await (await fetch(base)).text();
    assert.equal(html.includes('data-page="planner"'), false);
    const js = await (await fetch(base + '/app.js')).text();
    assert.equal(js.includes('/api/autoplans/'), false);
  } finally { await new Promise(resolve => app.server.close(resolve)); app.store.db.close(); }
});
