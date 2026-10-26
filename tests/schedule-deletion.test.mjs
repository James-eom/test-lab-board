import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';

test('bulk deletion requires admin, CSRF, phrase, fresh review and verified backup; preserves configuration', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'lab-delete-'));
  const backupDir = join(folder, 'backups');
  const app = createApp({ dbPath: join(folder, 'test.sqlite'), backupDir, holidayFetch: async () => { throw new Error('offline test'); } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '', csrf = '';
  const call = async (path, method = 'GET', data, useCsrf = true) => {
    const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json', ...(useCsrf ? { 'x-csrf-token': csrf } : {}) }, body: data ? JSON.stringify(data) : undefined });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  try {
    assert.equal((await call('/api/schedules/deletion-preview')).status, 401);
    const account = await (await call('/api/setup', 'POST', { login: 'manager', name: '관리자', password: 'test-password-123' })).json(); csrf = account.csrf;
    await call('/api/users', 'POST', { login: 'member', name: '팀원', password: 'test-member-password' });
    const r = app.store.saveReservation({ equipmentId: 'engine-1', testType: '배압 시험', title: '삭제 검증', ownerId: account.user.id, start: '2026-10-12T09:00:00+09:00', end: '2026-10-12T12:00:00+09:00', status: '계획' }, account.user.id);
    app.store.saveActual({ reservationId: r.id, zero: true, note: '검증' }, account.user.id);
    app.store.saveBaseline('2026-10', account.user.id);
    app.store.db.prepare('INSERT INTO automatic_plans VALUES(?,?)').run('test-plan', JSON.stringify({ at: new Date().toISOString() }));
    app.store.saveHoliday({ date: '2026-10-15', name: '보존할 휴일' });
    app.store.saveHolidayApiKey('test-key-not-a-real-secret-123456789');
    app.store.saveDowntime({ equipmentId: 'engine-2', start: '2026-10-12T09:00:00+09:00', end: '2026-10-12T12:00:00+09:00', reason: '보존' }, account.user.id);
    const retained = ['users', 'sessions', 'settings', 'downtimes'].map(table => app.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const preview = await (await call('/api/schedules/deletion-preview')).json();
    const input = { revision: preview.revision, confirmation: '전체 시험 일정 삭제' };
    assert.equal(preview.counts.reservations, 1);
    assert.equal((await call('/api/schedules', 'DELETE', input, false)).status, 403);
    assert.equal((await call('/api/schedules', 'DELETE', { ...input, confirmation: '삭제' })).status, 400);
    app.store.saveActual({ reservationId: r.id, zero: true, note: '변경' }, account.user.id);
    assert.equal((await call('/api/schedules', 'DELETE', input)).status, 409);
    const fresh = await (await call('/api/schedules/deletion-preview')).json(); input.revision = fresh.revision;
    // A backup-path failure must leave every test record intact.
    await writeFile(backupDir, 'not a directory');
    assert.equal((await call('/api/schedules', 'DELETE', input)).status, 500);
    assert.deepEqual(app.store.scheduleDeletionPreview(), fresh);
    await rm(backupDir);
    const member = await (await call('/api/login', 'POST', { login: 'member', password: 'test-member-password' })).json(); csrf = member.csrf;
    assert.equal((await call('/api/schedules/deletion-preview')).status, 403);
    assert.equal((await call('/api/schedules', 'DELETE', input)).status, 403);
    const manager = await (await call('/api/login', 'POST', { login: 'manager', password: 'test-password-123' })).json(); csrf = manager.csrf;
    const response = await call('/api/schedules', 'DELETE', input); assert.equal(response.status, 200);
    const result = await response.json(); assert.deepEqual(result.deleted, fresh.counts);
    assert.ok(Object.values(app.store.scheduleDeletionPreview().counts).every(n => n === 0));
    for (const [i, table] of ['users', 'sessions', 'settings', 'downtimes'].entries()) {
      if (table !== 'sessions') assert.deepEqual(app.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), retained[i]);
    }
    assert.equal((await call('/api/me')).status, 200);
    assert.deepEqual(await readdir(backupDir), [result.backupFile]);
    const backup = new DatabaseSync(join(backupDir, result.backupFile), { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      for (const [table, count] of Object.entries(fresh.counts)) assert.equal(backup.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, count);
      assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
    } finally { backup.close(); }
  } finally { await new Promise(resolve => app.server.close(resolve)); app.store.db.close(); await rm(folder, { recursive: true, force: true }); }
});

test('transaction rejects changes after backup and rolls all deletions back on error', async () => {
  const app = createApp({ dbPath: ':memory:' });
  try {
    app.store.db.prepare('INSERT INTO reservations VALUES(?,?)').run('test', '{}');
    app.store.db.prepare('INSERT INTO history(reservationId,payload) VALUES(?,?)').run('test', '{}');
    const preview = app.store.scheduleDeletionPreview();
    app.store.db.prepare('INSERT INTO actuals VALUES(?,?)').run('test', '{}');
    assert.throws(() => app.store.deleteAllSchedules(preview.revision), e => e.code === 'STALE_DELETION');
    const fresh = app.store.scheduleDeletionPreview();
    app.store.db.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON reservations BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    assert.throws(() => app.store.deleteAllSchedules(fresh.revision));
    assert.deepEqual(app.store.scheduleDeletionPreview(), fresh);
  } finally { app.store.db.close(); }
});
test('administrator revoked while bulk-deletion backup is pending cannot delete schedules',async()=>{
  let resume,entered;const started=new Promise(r=>entered=r);
  const app=createApp({dbPath:':memory:',backupDb:async()=>{entered();await new Promise(r=>resume=r);return 'test-only-backup.sqlite';}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  try{
    const response=await fetch(base+'/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'manager',name:'관리자',password:'test-password-123'})}),account=await response.json();
    const headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-csrf-token':account.csrf,'content-type':'application/json'};
    app.store.addUser('otheradmin','다른 관리자','hash','admin');
    app.store.saveReservation({title:'보존',equipmentId:'engine-1',testType:'배압 시험',ownerId:account.user.id,start:'2026-11-09T08:30:00+09:00',end:'2026-11-09T09:30:00+09:00',status:'계획'},account.user.id);
    const pending=fetch(base+'/api/schedules',{method:'DELETE',headers,body:JSON.stringify({confirmation:'전체 시험 일정 삭제',revision:app.store.scheduleDeletionPreview().revision})});await started;
    app.store.updateUser(account.user.id,{...account.user,role:'member'});resume();assert.equal((await pending).status,401);assert.equal(app.store.reservations().length,1);
  }finally{await new Promise(r=>app.server.close(r));app.store.db.close();}
});
