import { test, expect } from '@playwright/test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

let app, base, folder;
test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'lab-delete-ui-'));
  app = createApp({ dbPath: ':memory:', backupDir: join(folder, 'backups') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.afterEach(async () => {
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve)); app.store.db.close();
  await rm(folder, { recursive: true, force: true });
});

async function openDeleteDetail(page) {
  const res = await page.request.post(base + '/api/setup', { data: { name: '삭제 검증', login: 'manager', password: 'test-only-password-123' } });
  const admin = await res.json(), headers = { 'x-csrf-token': admin.csrf };
  const booking = { equipmentId: 'engine-1', testType: '배압 시험', title: '삭제 대기', ownerId: admin.user.id, start: '2026-11-09T08:30:00+09:00', end: '2026-11-09T09:30:00+09:00', status: '계획' };
  const target = await (await page.request.post(base + '/api/reservations', { headers, data: booking })).json();
  const other = await (await page.request.post(base + '/api/reservations', { headers, data: { ...booking, title: '다른 시험', equipmentId: 'engine-2' } })).json();
  await page.goto(base); await expect(page.locator('.schedule-table')).toBeVisible();
  await page.locator('#date-picker').fill('2026-11-09'); await page.locator('#date-picker').dispatchEvent('change');
  await page.locator('[data-page=tests]').click();
  await page.locator(`[data-detail="${target.id}"]`).click();
  await expect(page.locator('[data-remove-reservation]')).toBeVisible();
  return { target, other, headers };
}

test('closing or replacing the detail during delayed preview never confirms or deletes the old test', async ({ page }) => {
  const { target, other } = await openDeleteDetail(page);
  let release, reached, dialogs = 0, deletes = 0;
  const gate = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  page.on('dialog', async d => { dialogs++; await d.dismiss(); });
  page.on('request', r => { if (r.method() === 'DELETE') deletes++; });
  await page.route(base + '/api/reservations/' + target.id + '/deletion-preview', async route => {
    const response = await route.fetch(); reached(); await gate; await route.fulfill({ response });
  });
  await page.locator('[data-remove-reservation]').click(); await arrived;
  await page.locator('#close-modal').click();
  await page.locator(`[data-detail="${other.id}"]`).click();
  await page.locator('[data-edit]').click();
  await page.locator('#reservation-form [name=note]').fill('작성 중인 내용 유지');
  const completed = page.waitForResponse(r => r.url().endsWith('/deletion-preview'));
  release(); await completed;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#reservation-form')).toBeVisible();
  await expect(page.locator('#reservation-form [name=note]')).toHaveValue('작성 중인 내용 유지');
  expect(dialogs).toBe(0); expect(deletes).toBe(0);
});

test('a completed deletion does not close a different edit form opened while DELETE is pending', async ({ page }) => {
  const { target, other } = await openDeleteDetail(page);
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  await page.route(base + '/api/reservations/' + target.id, async route => {
    const response = await route.fetch(); reached(); await gate; await route.fulfill({ response });
  });
  page.once('dialog', d => d.accept());
  await page.locator('[data-remove-reservation]').click(); await arrived;
  await page.locator('#close-modal').click();
  await page.locator(`[data-detail="${other.id}"]`).click();
  await page.locator('[data-edit]').click();
  await page.locator('#reservation-form [name=note]').fill('다른 편집 유지');
  const synced = page.waitForResponse(r => r.url().includes('/api/capacity?'));
  release(); await synced;
  await expect(page.locator('#reservation-form')).toBeVisible();
  await expect(page.locator('#reservation-form [name=note]')).toHaveValue('다른 편집 유지');
  expect((await (await page.request.get(base + '/api/state')).json()).reservations.map(r => r.id)).toEqual([other.id]);
});

test('a stale detail version reports an error without showing confirmation', async ({ page }) => {
  const { target, headers } = await openDeleteDetail(page);
  const edited = await page.request.put(base + '/api/reservations/' + target.id, { headers, data: { ...target, reason: '다른 팀원의 변경', note: '최신 정보' } });
  expect(edited.status()).toBe(200);
  let dialogs = 0;
  page.on('dialog', async d => { dialogs++; await d.dismiss(); });
  await page.locator('[data-remove-reservation]').click();
  await expect(page.locator('#reservation-delete-error')).toContainText('변경');
  expect(dialogs).toBe(0);
  await expect(page.locator('#modal')).toBeVisible();
});

test('individual test deletion confirms exact message, cancels safely and refreshes the calendar only on success', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const setup = await page.request.post(base + '/api/setup', { data: { name: '삭제 검증', login: 'manager', password: 'test-only-password-123' } });
  const admin = await setup.json(), headers = { 'x-csrf-token': admin.csrf };
  const booking = { equipmentId: 'engine-1', testType: '배압 시험', title: '삭제 대상 시험', project: '삭제 UI 검증', ownerId: admin.user.id, start: '2026-11-09T08:30:00+09:00', end: '2026-11-09T09:30:00+09:00', status: '완료' };
  const target = await (await page.request.post(base + '/api/reservations', { headers, data: booking })).json();
  const other = await (await page.request.post(base + '/api/reservations', { headers, data: { ...booking, equipmentId: 'engine-2', title: '남겨 둘 시험' } })).json();
  await page.request.post(base + '/api/actuals', { headers, data: { reservationId: target.id, zero: true, note: '삭제 연계 실적' } });
  await page.request.post(base + '/api/baselines', { headers, data: { month: '2026-11' } });
  await page.goto(base);
  await expect(page.locator('.schedule-table')).toBeVisible();
  await page.locator('#date-picker').fill('2026-11-09'); await page.locator('#date-picker').dispatchEvent('change');
  await page.locator('[data-page=tests]').click();
  await page.locator(`[data-detail="${target.id}"]`).click();
  const button = page.getByRole('button', { name: '시험 삭제', exact: true });
  await expect(button).toBeVisible({ timeout: 2000 });
  let deletions = 0;
  page.on('request', req => { if (req.method() === 'DELETE' && req.url() === base + '/api/reservations/' + target.id) deletions++; });
  let firstMessage;
  page.once('dialog', async dialog => { firstMessage = dialog.message(); await dialog.dismiss(); });
  await button.click();
  await expect(button).toBeEnabled();
  expect(firstMessage).toBe('정말로 삭제하시겠습니까?');
  expect(deletions).toBe(0);
  expect((await (await page.request.get(base + '/api/state')).json()).reservations).toHaveLength(2);
  // Another teammate changes the actual while confirmation is open.
  page.once('dialog', async dialog => {
    await page.request.post(base + '/api/actuals', { headers, data: { reservationId: target.id, zero: true, note: '다른 팀원이 변경한 실적' } });
    await dialog.accept();
  });
  await button.click();
  await expect(page.locator('#reservation-delete-error')).toContainText('변경');
  await expect(page.locator('#modal')).toBeVisible();
  await expect(button).toBeEnabled();
  expect((await (await page.request.get(base + '/api/state')).json()).reservations).toHaveLength(2);
  await page.locator('#close-modal').click();
  await page.locator('#refresh').click();
  await page.locator(`[data-detail="${target.id}"]`).click();
  page.once('dialog', dialog => dialog.accept());
  await button.click();
  await expect(page.locator('#modal')).not.toBeVisible();
  await expect(page.locator(`[data-detail="${target.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-detail="${other.id}"]`)).toBeVisible();
  const state = await (await page.request.get(base + '/api/state')).json();
  expect(state.reservations.map(r => r.id)).toEqual([other.id]);
  expect(state.actuals).toHaveLength(0);
  expect(state.baselines[0].reservations).toHaveLength(2);
  expect((await readdir(join(folder, 'backups'))).length).toBe(1);
  expect(errors).toEqual([]);
});

test('only admin and original creator see delete; assigning or editing a test does not grant deletion', async ({ page, browser }) => {
  const { target, headers } = await openDeleteDetail(page);
  const member = await (await page.request.post(base + '/api/users', { headers, data: { name: '담당 팀원', login: 'member', password: 'member-password-123' } })).json();
  expect((await page.request.put(base + '/api/reservations/' + target.id, { headers, data: { ...target, ownerId: member.id, reason: '담당자 변경' } })).status()).toBe(200);
  await expect(page.locator('[data-remove-reservation]')).toBeVisible();
  const peerContext = await browser.newContext({ timezoneId: 'Asia/Seoul' });
  try {
    const peer = await peerContext.newPage();
    const signed = await peer.request.post(base + '/api/login', { data: { login: 'member', password: 'member-password-123' } });
    const account = await signed.json(), peerHeaders = { 'x-csrf-token': account.csrf };
    const latest = (await (await peer.request.get(base + '/api/state')).json()).reservations.find(r => r.id === target.id);
    expect((await peer.request.put(base + '/api/reservations/' + target.id, { headers: peerHeaders, data: { ...latest, note: '담당자가 수정', reason: '수정' } })).status()).toBe(200);
    const own = await (await peer.request.post(base + '/api/reservations', { headers: peerHeaders, data: { ...target, title: '직접 등록한 시험', equipmentId: 'flow', testType: '유동저항 시험', ownerId: (await (await page.request.get(base + '/api/me')).json()).user.id } })).json();
    await peer.goto(base); await expect(peer.locator('.schedule-table')).toBeVisible();
    await peer.locator('#date-picker').fill('2026-11-09'); await peer.locator('#date-picker').dispatchEvent('change');
    await peer.locator('[data-page=tests]').click();
    await peer.locator(`[data-detail="${target.id}"]`).click();
    await expect(peer.locator('#modal')).toBeVisible();
    await expect(peer.locator('[data-remove-reservation]')).toHaveCount(0);
    await peer.locator('#close-modal').click();
    await peer.locator(`[data-detail="${own.id}"]`).click();
    await expect(peer.locator('[data-remove-reservation]')).toBeVisible();
  } finally { await peerContext.close(); }
});
