import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { HolidaySync, parseHolidays } from '../src/holiday-sync.mjs';
import { createApp } from '../server.mjs';
const xml = (year, name = '신정') => `<response><header><resultCode>00</resultCode></header><body><items><item><dateName>${name}</dateName><isHoliday>Y</isHoliday><locdate>${year}0101</locdate></item></items><totalCount>1</totalCount></body></response>`;

test('XML validates completeness, dates, year, holiday flag and escaped names', () => {
  assert.equal(parseHolidays(xml(2028, '공휴일 &amp; 기념일'), 2028)[0].name, '공휴일 & 기념일');
  for (const bad of [xml(2028).replace('00', '30'), xml(2028).replace('totalCount>1', 'totalCount>2'), xml(2027), xml(2028).replace('20280101', '20280230'), xml(2028).replace('>Y<', '>N<')]) assert.throws(() => parseHolidays(bad, 2028));
});

test('refresh caches each year, retains custom days and keeps old data on API failure', async () => {
  const store = new Store(':memory:');
  try {
    store.saveHolidayApiKey('test-key-not-a-real-secret-123'); store.saveHoliday({ date: '2028-01-03', name: '임시공휴일' });
    let calls = 0, broken = false;
    const sync = new HolidaySync(store, async url => { calls++; assert.equal(url.origin, 'https://apis.data.go.kr'); if (broken) throw new Error('공휴일 API secret=' + store.holidayApiKey()); return { ok: true, text: async () => xml(url.searchParams.get('solYear')) }; });
    await sync.refresh([2028, 2028]); assert.equal(calls, 1);
    assert.ok(store.holidayYears().includes(2028));
    assert.equal(store.rules().holidays.find(h => h.date === '2028-01-01').source, 'api');
    assert.ok(store.rules().holidays.some(h => h.date === '2028-01-03'));
    await sync.refresh([2028]); assert.equal(calls, 1);
    const cache = store.holidayCache(); broken = true;
    await sync.refresh([2028], { force: true });
    assert.deepEqual(store.holidayCache(), cache);
    assert.ok(sync.status().errors.length);
    assert.ok(!JSON.stringify(sync.status()).includes(store.holidayApiKey()));
    await sync.refresh([2029]); const before = calls;
    await sync.refresh([2029]); assert.equal(calls, before);
    assert.ok(!store.holidayYears().includes(2029));
    const restarted = new HolidaySync(store); assert.equal(restarted.status().years[0].year, 2028);
  } finally { store.db.close(); }
});

test('API key is admin-only, protected by CSRF and never included in state or responses', async () => {
  const app = createApp({ dbPath: ':memory:', holidayFetch: async url => ({ ok: true, text: async () => xml(url.searchParams.get('solYear')) }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'manager', name: '관리자', password: 'test-password-123' }) });
    const account = await setup.json(), cookie = setup.headers.get('set-cookie').split(';')[0];
    const request = (path, method = 'GET', data, csrf = account.csrf) => fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: data ? JSON.stringify(data) : undefined });
    const key = 'test-key-not-a-real-secret-123';
    assert.equal((await request('/api/holidays/key', 'POST', { key }, '')).status, 403);
    assert.equal((await request('/api/holidays/key', 'POST', { key: 'short' })).status, 400);
    const config = await request('/api/holidays/key', 'POST', { key }); assert.equal(config.status, 200);
    assert.ok(!(await config.text()).includes(key));
    const state = await (await request('/api/state?year=2028')).text();
    assert.ok(!state.includes(key)); assert.ok(JSON.parse(state).holidayYears.includes(2028));
    assert.equal((await request('/api/holidays/sync', 'POST', { year: 2028 })).status, 200);
    assert.equal((await request('/api/holidays/sync', 'POST', { year: 'bad' })).status, 400);
    assert.equal((await request('/api/users', 'POST', { login: 'member', name: '팀원', password: 'test-password-123' })).status, 201);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'member', password: 'test-password-123' }) });
    const member = await login.json();
    const forbidden = await fetch(base + '/api/holidays/key', { method: 'POST', headers: { cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json', 'x-csrf-token': member.csrf }, body: JSON.stringify({ key }) });
    assert.equal(forbidden.status, 403);
  } finally { await new Promise(resolve => app.server.close(resolve)); app.store.db.close(); }
});
