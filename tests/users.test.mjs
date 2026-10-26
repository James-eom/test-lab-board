import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { Store } from '../src/store.mjs';

const password = 'test-only-password-123';
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.db.close(); });
  const request = (path, method = 'GET', body, client = {}, csrf = true) => fetch(base + path, {
    method, headers: { origin: base, 'content-type': 'application/json', cookie: client.cookie || '', ...(csrf ? { 'x-csrf-token': client.csrf || '' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  async function signIn(login, pass = password) {
    const res = await request('/api/login', 'POST', { login, password: pass });
    assert.equal(res.status, 200, await res.clone().text());
    return { ...(await res.json()), cookie: res.headers.get('set-cookie').split(';')[0] };
  }
  const setup = await request('/api/setup', 'POST', { login: 'manager', name: '관리자', password });
  assert.equal(setup.status, 201);
  const admin = { ...(await setup.json()), cookie: setup.headers.get('set-cookie').split(';')[0] };
  async function add(login, role = 'member') {
    const res = await request('/api/users', 'POST', { login, name: login, role, password }, admin);
    assert.equal(res.status, 201, await res.clone().text());
    return res.json();
  }
  return { ...app, base, request, signIn, admin, add };
}

test('legacy five-column users migrate to active accounts without losing their records', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'lab-user-migration-'));
  try {
    const file = join(folder, 'old.sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec("CREATE TABLE users(id TEXT PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL); INSERT INTO users VALUES('old-id','olduser','이전 관리자','original-hash','admin');");
    legacy.close();
    const store = new Store(file);
    try {
      assert.equal(store.users()[0].active, true);
      assert.equal(store.users()[0].id, 'old-id');
      assert.equal(store.db.prepare('SELECT hash FROM users').get().hash, 'original-hash');
    } finally { store.db.close(); }
    const reopened = new Store(file);
    try { assert.equal(reopened.users().length, 1); } finally { reopened.db.close(); }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('admin sets IDs/passwords, edits credentials and revokes only that account sessions', async t => {
  const { request, signIn, admin, add } = await fixture(t);
  const member = await add('member1');
  const client1 = await signIn('member1'), client2 = await signIn('member1');
  const path = '/api/users/' + member.id;
  assert.equal((await request(path, 'PUT', { name: '금지' }, client1)).status, 403);
  assert.equal((await request(path, 'PUT', { name: '금지' }, admin, false)).status, 403);
  assert.equal((await request(path, 'PUT', { name: '수정 이름', login: 'changed.id', role: 'member', password: 'replacement-password-123' }, admin)).status, 200);
  for (const client of [client1, client2]) assert.equal((await request('/api/me', 'GET', undefined, client)).status, 401);
  assert.equal((await request('/api/me', 'GET', undefined, admin)).status, 200);
  assert.equal((await request('/api/login', 'POST', { login: 'member1', password })).status, 401);
  assert.equal((await request('/api/login', 'POST', { login: 'changed.id', password })).status, 401);
  const changed = await signIn('changed.id', 'replacement-password-123');
  assert.equal(changed.user.id, member.id);
  assert.equal(changed.user.name, '수정 이름');
  const state = await (await request('/api/state', 'GET', undefined, admin)).json();
  assert.ok(state.users.every(u => !('hash' in u) && !('password' in u)));
  // A blank password preserves credentials and existing sessions on a name-only edit.
  assert.equal((await request(path, 'PUT', { name: '다시 수정', login: 'changed.id', role: 'member', password: '' }, admin)).status, 200);
  assert.equal((await request('/api/me', 'GET', undefined, changed)).status, 200);
});

test('account deletion frees capacity, blocks login and preserves schedules, owners and history', async t => {
  const { request, signIn, admin, add, store } = await fixture(t);
  const member = await add('retiring');
  const client = await signIn('retiring');
  const saved = await request('/api/reservations', 'POST', { title: '보존 시험', equipmentId: 'engine-1', testType: '배압 시험', ownerId: member.id, start: '2026-11-09T08:30:00+09:00', end: '2026-11-09T09:30:00+09:00', status: '계획' }, client);
  assert.equal(saved.status, 201);
  const booking = await saved.json();
  store.saveBaseline('2026-11', admin.user.id);
  store.saveActual({ reservationId: booking.id, zero: true, note: '보존 실적' }, member.id);
  const originalHistory = store.history(booking.id), originalBaselines = store.baselines(), originalActuals = store.actuals();
  for (const login of ['team2', 'team3', 'team4', 'team5']) await add(login);
  assert.equal((await request('/api/users', 'POST', { login: 'seventh', name: '초과', password }, admin)).status, 400);
  assert.equal((await request('/api/users/' + member.id, 'DELETE', undefined, client)).status, 403);
  assert.equal((await request('/api/users/' + member.id, 'DELETE', undefined, admin, false)).status, 403);
  assert.equal((await request('/api/users/' + member.id, 'DELETE', undefined, admin)).status, 200);
  assert.equal((await request('/api/me', 'GET', undefined, client)).status, 401);
  assert.equal((await request('/api/login', 'POST', { login: 'retiring', password })).status, 401);
  assert.equal((await request('/api/users/' + member.id, 'DELETE', undefined, admin)).status, 409);
  await add('replacement');
  const state = await (await request('/api/state', 'GET', undefined, admin)).json();
  assert.equal(state.users.filter(u => u.active).length, 6);
  assert.equal(state.users.find(u => u.id === member.id).active, false);
  assert.equal(state.reservations.find(r => r.id === booking.id).ownerId, member.id);
  assert.deepEqual(store.history(booking.id), originalHistory);
  assert.deepEqual(store.baselines(), originalBaselines);
  assert.deepEqual(store.actuals(), originalActuals);
  // New assignments to removed accounts are forbidden, but existing ownership may be retained on edits.
  assert.equal((await request('/api/reservations', 'POST', { ...booking, start: '2026-11-10T08:30:00+09:00', end: '2026-11-10T09:30:00+09:00' }, admin)).status, 400);
  assert.equal((await request('/api/reservations/' + booking.id, 'PUT', { ...booking, reason: '기존 담당자 보존', note: '수정' }, admin)).status, 200);
});

test('self deletion and last-admin demotion are rejected; invalid edits are atomic', async t => {
  const { request, signIn, admin, add } = await fixture(t);
  const member = await add('member1');
  assert.equal((await request('/api/users/' + admin.user.id, 'DELETE', undefined, admin)).status, 400);
  assert.equal((await request('/api/users/' + admin.user.id, 'PUT', { name: '관리자', login: 'manager', role: 'member' }, admin)).status, 400);
  const path = '/api/users/' + member.id;
  for (const data of [
    { name: '변경 금지', login: 'manager', role: 'member' },
    { name: '변경 금지', login: 'invalid id', role: 'member' },
    { name: '변경 금지', login: 'member1', role: 'root' },
    { name: ' ', login: 'member1', role: 'member' },
    { name: '변경 금지', login: 'member1', role: 'member', password: 'short' }
  ]) assert.ok([400, 409].includes((await request(path, 'PUT', data, admin)).status));
  assert.equal((await signIn('member1')).user.name, 'member1');
  assert.equal((await request('/api/users/missing', 'PUT', { name: '없음', login: 'missing', role: 'member' }, admin)).status, 404);
  assert.equal((await request('/api/users/missing', 'DELETE', undefined, admin)).status, 404);
  const second = await add('admin2', 'admin');
  const secondSession = await signIn('admin2');
  assert.equal((await request('/api/users/' + admin.user.id, 'PUT', { name: '관리자', login: 'manager', role: 'member' }, secondSession)).status, 200);
  assert.equal((await request('/api/me', 'GET', undefined, admin)).status, 401);
  assert.equal((await request('/api/me', 'GET', undefined, secondSession)).status, 200);
  assert.equal((await request('/api/users/' + second.id, 'PUT', { name: 'admin2', login: 'admin2', role: 'member' }, secondSession)).status, 400);
});

test('a revoked administrator cannot finish a delayed account mutation', async t => {
  for (const method of ['PUT', 'POST']) {
    const { server, base, request, signIn, admin, add } = await fixture(t);
    await add('admin2', 'admin');
    const admin2 = await signIn('admin2');
    const path = method === 'PUT' ? '/api/users/' + admin.user.id : '/api/users';
    const pending = { name: '지연 요청', login: method === 'PUT' ? 'manager' : 'lateuser', role: 'admin', ...(method === 'POST' ? { password } : {}) };
    const text = JSON.stringify(pending);
    let seen;
    const received = new Promise(resolve => { seen = resolve; });
    server.once('request', seen);
    let finish;
    const result = new Promise((resolve, reject) => {
      const req = http.request(base + path, { method, headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, origin: base, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.write(text.slice(0, -1));
      finish = () => req.end(text.slice(-1));
    });
    await received;
    assert.equal((await request('/api/users/' + admin.user.id, 'PUT', { name: '관리자', login: 'manager', role: 'member' }, admin2)).status, 200);
    finish();
    assert.equal(await result, 401, method + ': revoked session must be rechecked after receiving the body');
    assert.equal((await request('/api/me', 'GET', undefined, admin2)).status, 200);
  }
});

test('stale account forms cannot overwrite a newer password, ID or role change', async t => {
  const { request, admin, add } = await fixture(t);
  const user = await add('member1'), path = '/api/users/' + user.id;
  const first = await request(path, 'PUT', { ...user, name: '最新 이름', password: 'new-account-password-123' }, admin);
  assert.equal(first.status, 200);
  const updated = await first.json();
  const stale = await request(path, 'PUT', { ...user, name: '오래된 창', password: '' }, admin);
  assert.equal(stale.status, 409);
  assert.equal((await (await request('/api/state', 'GET', undefined, admin)).json()).users.find(u => u.id === user.id).name, '最新 이름');
  assert.equal((await request(path, 'PUT', { ...updated, name: '다시 불러온 창', password: '' }, admin)).status, 200);
});

test('five independent clients share updates and logging out never disconnects another client', async t => {
  const { request, signIn, admin, add } = await fixture(t);
  for (let i = 1; i <= 5; i++) await add('member' + i);
  const clients = await Promise.all([1, 2, 3, 4, 5].map(i => signIn('member' + i)));
  const statuses = await Promise.all(clients.map((client, i) => request('/api/reservations', 'POST', { title: '동시 시험 ' + i, equipmentId: 'engine-1', testType: '배압 시험', ownerId: client.user.id, start: '2026-11-09T08:30:00+09:00', end: '2026-11-09T09:30:00+09:00', status: '계획' }, client).then(r => r.status)));
  assert.deepEqual(statuses.sort(), [201, 409, 409, 409, 409]);
  const states = await Promise.all(clients.map(async client => {
    const res = await request('/api/state', 'GET', undefined, client); assert.equal(res.status, 200); return res.json();
  }));
  assert.ok(states.every(s => s.reservations.length === 1));
  assert.equal(new Set(states.map(s => s.reservations[0].id)).size, 1);
  const sameAccount = await signIn('member1');
  assert.equal((await request('/api/logout', 'POST', {}, clients[0])).status, 200);
  for (const client of [sameAccount, ...clients.slice(1), admin]) assert.equal((await request('/api/me', 'GET', undefined, client)).status, 200);
});
