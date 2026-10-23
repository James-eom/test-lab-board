import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { verifiedBackup } from '../src/backup.mjs';
import { createApp } from '../server.mjs';

async function fixture(t, { afterBackup } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'lab-one-delete-')), backupDir = join(folder, 'backups');
  const app = createApp({ dbPath: join(folder, 'test.sqlite'), backupDir, ...(afterBackup ? { backupDb: async (db, folder) => { const path = await verifiedBackup(db, folder); afterBackup(); return path; } } : {}) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.db.close(); await rm(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path, method = 'GET', body, client = {}, csrf = true) => fetch(base + path, {
    method, headers: { cookie: client.cookie || '', origin: base, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': client.csrf || '' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setup = await call('/api/setup', 'POST', { login: 'manager', name: '관리자', password: 'only-test-password-123' });
  const admin = { ...(await setup.json()), cookie: setup.headers.get('set-cookie').split(';')[0] };
  const member = await (await call('/api/users', 'POST', { login: 'member', name: '팀원', password: 'only-test-password-456' }, admin)).json();
  const login = await call('/api/login', 'POST', { login: 'member', password: 'only-test-password-456' });
  const client = { ...(await login.json()), cookie: login.headers.get('set-cookie').split(';')[0] };
  const booking = { equipmentId: 'engine-1', testType: '배압 시험', ownerId: member.id, title: '선택 삭제', start: '2026-11-09T08:30:00+09:00', end: '2026-11-09T10:30:00+09:00', status: '완료' };
  const target = app.store.saveReservation(booking, member.id);
  app.store.saveActual({ reservationId: target.id, zero: true, note: '연결 실적' }, member.id);
  const other = app.store.saveReservation({ ...booking, title: '보존 시험', equipmentId: 'engine-2' }, admin.user.id);
  app.store.saveActual({ reservationId: other.id, zero: true, note: '보존 실적' }, admin.user.id);
  app.store.saveBaseline('2026-11', admin.user.id);
  return { ...app, base, folder, backupDir, call, admin, client, target, other };
}

test('single-test deletion requires authentication, CSRF, confirmation, a fresh target and a verified backup', async t => {
  const { store, call, admin, client, target, other, backupDir } = await fixture(t);
  const path = '/api/reservations/' + target.id, previewPath = path + '/deletion-preview';
  assert.equal((await call(previewPath)).status, 401);
  assert.equal((await call(path, 'DELETE', {})).status, 401);
  const previewResponse = await call(previewPath, 'GET', undefined, client);
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.version, target.version);
  const body = { revision: preview.revision, confirmation: '시험 삭제' };
  assert.equal((await call(path, 'DELETE', body, client, false)).status, 403);
  assert.equal((await call(path, 'DELETE', { ...body, confirmation: '' }, client)).status, 400);
  assert.equal((await call(path, 'DELETE', { ...body, revision: 'stale' }, client)).status, 409);
  await writeFile(backupDir, 'not a directory');
  const before = store.scheduleDeletionPreview();
  const failed = await call(path, 'DELETE', body, client);
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).code, 'BACKUP_FAILED');
  assert.deepEqual(store.scheduleDeletionPreview(), before);
  await rm(backupDir);
  const retained = Object.fromEntries(['users', 'settings', 'downtimes', 'baselines', 'automatic_plans'].map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const otherHistory = store.history(other.id), otherActual = store.actuals().find(a => a.reservationId === other.id);
  const response = await call(path, 'DELETE', body, client);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(store.reservation(target.id), undefined);
  assert.deepEqual(store.history(target.id), []);
  assert.ok(!store.actuals().some(a => a.reservationId === target.id));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM intervals WHERE reservationId=?').get(target.id).n, 0);
  assert.deepEqual(store.reservation(other.id), other);
  assert.deepEqual(store.history(other.id), otherHistory);
  assert.deepEqual(store.actuals().find(a => a.reservationId === other.id), otherActual);
  for (const [table, rows] of Object.entries(retained)) assert.deepEqual(store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows);
  assert.equal(store.originalPlans().length, 1);
  assert.equal((await call(path, 'DELETE', body, client)).status, 404);
  assert.equal((await call(previewPath, 'GET', undefined, client)).status, 404);
  assert.equal((await call('/api/me', 'GET', undefined, admin)).status, 200);
  assert.deepEqual(await readdir(backupDir), [result.backupFile]);
  const backup = new DatabaseSync(join(backupDir, result.backupFile), { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 2);
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM actuals').get().n, 2);
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM history WHERE reservationId=?').get(target.id).n, 1);
  } finally { backup.close(); }
});

test('only the first creator or an administrator may delete; owner and last editor cannot claim permission', async t => {
  const { store, call, admin, client, target, other, backupDir } = await fixture(t);
  // The member is the assignee of this administrator-created test, not its creator.
  store.saveReservation({ ...other, reason: '다른 팀원 수정', note: '최근 수정자도 등록자가 아님' }, client.user.id, other.id);
  const before = store.scheduleDeletionPreview();
  const adminPreview = await (await call('/api/reservations/' + other.id + '/deletion-preview', 'GET', undefined, admin)).json();
  assert.equal((await call('/api/reservations/' + other.id + '/deletion-preview', 'GET', undefined, client)).status, 403);
  const forged = { confirmation: '시험 삭제', revision: adminPreview.revision, userId: admin.user.id, role: 'admin', createdBy: client.user.id };
  assert.equal((await call('/api/reservations/' + other.id, 'DELETE', forged, client)).status, 403);
  assert.throws(() => store.deleteReservation(other.id, adminPreview.revision, client.user.id), e => e.status === 403);
  assert.deepEqual(store.scheduleDeletionPreview(), before);
  await assert.rejects(readdir(backupDir), { code: 'ENOENT' });
  // A later edit and a changed assignee cannot replace the true first creator.
  const changed = store.saveReservation({ ...target, ownerId: admin.user.id, reason: '관리자 수정 및 담당자 변경' }, admin.user.id, target.id);
  const creatorPreviewResponse = await call('/api/reservations/' + target.id + '/deletion-preview', 'GET', undefined, client);
  assert.equal(creatorPreviewResponse.status, 200);
  const preview = await creatorPreviewResponse.json();
  assert.equal((await call('/api/reservations/' + target.id, 'DELETE', { confirmation: '시험 삭제', revision: preview.revision }, client)).status, 200);
  assert.equal(store.reservation(changed.id), undefined);
  assert.equal((await call('/api/reservations/' + other.id, 'DELETE', { confirmation: '시험 삭제', revision: adminPreview.revision }, admin)).status, 200);
});

test('unknown or non-original history grants deletion only to administrators', async t => {
  const { store, call, admin, client, target } = await fixture(t);
  const path = '/api/reservations/' + target.id;
  store.db.prepare('DELETE FROM history WHERE reservationId=?').run(target.id);
  assert.equal((await call(path + '/deletion-preview', 'GET', undefined, client)).status, 403);
  // A remaining edit record must not be mistaken for the original registration.
  store.saveReservation({ ...target, note: '이력 없는 시험 수정', reason: '수정' }, client.user.id, target.id);
  assert.equal((await call(path + '/deletion-preview', 'GET', undefined, client)).status, 403);
  const preview = await (await call(path + '/deletion-preview', 'GET', undefined, admin)).json();
  assert.equal((await call(path, 'DELETE', { confirmation: '시험 삭제', revision: preview.revision }, admin)).status, 200);
});

test('session revocation, CSRF change and actual updates during a real backup prevent deletion', async t => {
  for (const scenario of ['session', 'csrf', 'actual']) {
    let fx;
    fx = await fixture(t, { afterBackup: () => {
      if (scenario === 'session') fx.store.db.prepare('DELETE FROM sessions WHERE userId=?').run(fx.client.user.id);
      else if (scenario === 'csrf') fx.store.db.prepare('UPDATE sessions SET csrf=? WHERE userId=?').run('changed-test-csrf', fx.client.user.id);
      else fx.store.saveActual({ reservationId: fx.target.id, zero: true, note: '백업 중 변경' }, fx.client.user.id);
    } });
    const path = '/api/reservations/' + fx.target.id;
    const preview = await (await fx.call(path + '/deletion-preview', 'GET', undefined, fx.client)).json();
    const response = await fx.call(path, 'DELETE', { confirmation: '시험 삭제', revision: preview.revision }, fx.client);
    assert.equal(response.status, { session: 401, csrf: 403, actual: 409 }[scenario], scenario);
    assert.deepEqual(fx.store.reservation(fx.target.id), fx.target);
    assert.equal(fx.store.history(fx.target.id).length, 1);
    assert.equal(fx.store.actuals().length, 2);
    assert.equal((await readdir(fx.backupDir)).length, 1);
  }
});

test('a session revoked during request-body reception cannot delete or create a backup', async t => {
  const fx = await fixture(t), path = '/api/reservations/' + fx.target.id;
  const preview = await (await fx.call(path + '/deletion-preview', 'GET', undefined, fx.client)).json();
  const body = JSON.stringify({ confirmation: '시험 삭제', revision: preview.revision });
  let received, finish;
  const arrived = new Promise(resolve => { received = resolve; });
  fx.server.once('request', received);
  const done = new Promise((resolve, reject) => {
    const req = http.request(fx.base + path, { method: 'DELETE', headers: { cookie: fx.client.cookie, 'x-csrf-token': fx.client.csrf, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(body.slice(0, -1)); finish = () => req.end(body.slice(-1));
  });
  await arrived;
  fx.store.db.prepare('DELETE FROM sessions WHERE userId=?').run(fx.client.user.id);
  finish(); assert.equal(await done, 401);
  assert.deepEqual(fx.store.reservation(fx.target.id), fx.target);
  assert.equal(fx.store.history(fx.target.id).length, 1);
  assert.deepEqual(await readdir(fx.folder), ['test.sqlite', 'test.sqlite-shm', 'test.sqlite-wal']);
});

test('target revision covers actuals and history; stale deletion and SQL failure leave everything intact', async t => {
  const { store, call, client, target, other } = await fixture(t);
  const preview = store.reservationDeletionPreview(target.id, client.user.id);
  store.saveActual({ reservationId: target.id, zero: true, note: '다른 팀원의 실적 변경' }, client.user.id);
  assert.throws(() => store.deleteReservation(target.id, preview.revision, client.user.id), e => e.code === 'STALE_DELETION');
  const fresh = store.reservationDeletionPreview(target.id, client.user.id);
  // A different test changing does not invalidate confirmation for this test.
  store.saveActual({ reservationId: other.id, zero: true, note: '다른 시험 변경' }, client.user.id);
  assert.deepEqual(store.reservationDeletionPreview(target.id, client.user.id), fresh);
  const before = store.scheduleDeletionPreview();
  store.db.exec("CREATE TRIGGER refuse_one_delete BEFORE DELETE ON reservations BEGIN SELECT RAISE(ABORT, 'test-only failure'); END;");
  assert.throws(() => store.deleteReservation(target.id, fresh.revision, client.user.id));
  assert.deepEqual(store.scheduleDeletionPreview(), before);
  assert.equal((await call('/api/reservations/missing/deletion-preview', 'GET', undefined, client)).status, 404);
});
