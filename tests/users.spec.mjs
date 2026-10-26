import { test, expect } from '@playwright/test';
import { createApp } from '../server.mjs';

let app, base;
const password = 'ui-only-password-123';
test.beforeAll(async () => {
  app = createApp({ dbPath: ':memory:' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.db.close(); });

test('admin manages IDs/passwords and deletion at capacity while five browser sessions stay independent', async ({ page, browser }) => {
  const contexts = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(base);
    await page.locator('#auth-form [name=name]').fill('계정 관리 검증');
    await page.locator('#auth-form [name=login]').fill('manager');
    await page.locator('#auth-form [name=password]').fill(password);
    await page.locator('#auth-submit').click();
    await expect(page.locator('.schedule-table')).toBeVisible();
    await page.locator('[data-page=settings]').click();
    await page.locator('#add-user').click();
    await page.locator('#user-form [name=name]').fill('팀원 1');
    await page.locator('#user-form [name=login]').fill('member1');
    await page.locator('#user-form [name=password]').fill(password);
    await page.locator('#user-form [type=submit]').click();
    await expect(page.locator('#modal')).not.toBeVisible();
    const row = page.locator('[data-user-id]').filter({ hasText: 'member1' });
    await expect(row.locator('[data-edit-user]')).toBeVisible({ timeout: 2000 });
    const account = await (await page.request.get(base + '/api/me')).json();
    for (let i = 2; i <= 5; i++) {
      const res = await page.request.post(base + '/api/users', { headers: { 'x-csrf-token': account.csrf }, data: { name: '팀원 ' + i, login: 'member' + i, password } });
      expect(res.status()).toBe(201);
    }
    await page.locator('#refresh').click();
    await expect(page.locator('#add-user')).toBeVisible();
    await expect(page.locator('#add-user')).toBeDisabled();
    await expect(page.locator('#content')).toContainText('6명');
    const peers = await Promise.all([1, 2, 3, 4, 5].map(async i => {
      const context = await browser.newContext({ timezoneId: 'Asia/Seoul' }); contexts.push(context);
      const peer = await context.newPage();
      await peer.goto(base);
      await peer.locator('#auth-form [name=login]').fill('member' + i);
      await peer.locator('#auth-form [name=password]').fill(password);
      await peer.locator('#auth-submit').click();
      await expect(peer.locator('.schedule-table')).toBeVisible();
      return peer;
    }));
    await peers[1].locator('[data-page=settings]').click();
    await expect(peers[1].locator('[data-edit-user], [data-remove-user], #add-user')).toHaveCount(0);
    await row.locator('[data-edit-user]').click();
    await expect(page.locator('#user-form [name=password]')).toHaveValue('');
    await page.locator('#user-form [name=login]').fill('changed.member');
    await page.locator('#user-form [name=password]').fill('new-ui-password-123');
    await page.locator('#user-form [type=submit]').click();
    await expect(page.locator('#modal')).not.toBeVisible();
    await expect(row).toHaveCount(0);
    expect((await peers[0].request.get(base + '/api/me')).status()).toBe(401);
    for (const peer of peers.slice(1)) expect((await peer.request.get(base + '/api/me')).status()).toBe(200);
    await peers[0].reload();
    await peers[0].locator('#auth-form [name=login]').fill('changed.member');
    await peers[0].locator('#auth-form [name=password]').fill('new-ui-password-123');
    await peers[0].locator('#auth-submit').click();
    await expect(peers[0].locator('.schedule-table')).toBeVisible();
    const changedRow = page.locator('[data-user-id]').filter({ hasText: 'changed.member' });
    page.once('dialog', dialog => dialog.dismiss());
    await changedRow.locator('[data-remove-user]').click();
    await expect(changedRow).not.toContainText('삭제됨');
    page.once('dialog', dialog => dialog.accept());
    await changedRow.locator('[data-remove-user]').click();
    await expect(changedRow).toContainText('삭제됨');
    await expect(changedRow.locator('[data-edit-user], [data-remove-user]')).toHaveCount(0);
    expect((await peers[0].request.get(base + '/api/me')).status()).toBe(401);
    await expect(page.locator('#add-user')).toBeEnabled();
    await page.locator('#add-user').click();
    await page.locator('#user-form [name=name]').fill('대체 팀원');
    await page.locator('#user-form [name=login]').fill('replacement');
    await page.locator('#user-form [name=password]').fill(password);
    await page.locator('#user-form [type=submit]').click();
    await expect(page.locator('#modal')).not.toBeVisible();
    await expect(page.locator('[data-user-id]').filter({ hasText: 'replacement' })).toBeVisible();
    const self = page.locator('[data-user-id]').filter({ hasText: 'manager' });
    await expect(self.locator('[data-remove-user]')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await changedRow.scrollIntoViewIfNeeded();
    expect(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await Promise.all(contexts.map(c => c.close())); }
});
