import { test, expect } from '@playwright/test';
import { createApp } from '../server.mjs';
async function setup(page){
  const app=createApp({dbPath:':memory:',clock:()=>Date.parse('2026-11-09T08:00:00+09:00')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  await page.goto(base);await page.locator('#auth-form [name=name]').fill('편성 관리자');await page.locator('#auth-form [name=login]').fill('manager');await page.locator('#auth-form [name=password]').fill('planner-password-123');await page.locator('#auth-submit').click();await expect(page.locator('.schedule-table')).toBeVisible();
  return {app,base,close:async()=>{await new Promise(r=>app.server.close(r));app.store.db.close();}};
}
test('separate planner persists inputs, previews consecutive hours and registers one editable test',async({page})=>{
  const f=await setup(page);try{
    await page.locator('[data-page=monthly-planner]').click();await page.locator('[name=planningMonth]').fill('2026-11');
    const row=page.locator('[data-planner-row]').first();await row.locator('[data-field=project]').fill('연속 15시간');await row.locator('[data-field=hours]').fill('15');
    await page.locator('[data-page=tests]').click();await page.locator('[data-page=monthly-planner]').click();await expect(row.locator('[data-field=hours]')).toHaveValue('15');
    await page.getByRole('button',{name:'편성안 만들기',exact:true}).click();await expect(page.locator('#monthly-preview')).toContainText('2026-11-10 14:00');
    expect(f.app.store.reservations()).toHaveLength(0);
    await page.getByRole('button',{name:'일괄 확정 · 캘린더에 등록',exact:true}).click();await expect(page.locator('[data-page=schedule]')).toHaveClass(/active/);expect(f.app.store.reservations()).toHaveLength(1);
    const r=f.app.store.reservations()[0];await page.locator(`[data-detail="${r.id}"]`).first().click();await expect(page.locator('#modal-body')).toContainText('계획 가동시간 15시간');
    await page.locator('[data-edit]').click();await page.locator('#reservation-form [name=end]').fill('2026-11-10T15:00');await page.locator('#reservation-form [name=reason]').fill('한 시간 연장');await page.locator('#reservation-form [type=submit]').click();await expect(page.locator('#modal')).not.toBeVisible();
    await page.locator(`[data-detail="${r.id}"]`).first().click();await expect(page.locator('#modal-body')).toContainText('계획 가동시간 16시간');await expect(page.locator('#modal-body')).toContainText('자동 편성 당시 요구시간 15시간');await expect(page.locator('#modal-body')).toContainText('한 시간 연장');
    await page.locator('#close-modal').click();await page.locator('[data-page=monthly-planner]').click();await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:'test-results/monthly-planner-mobile.png',fullPage:true});
  }finally{await f.close();}
});
test('admin standards, modes, supported types, failed plans and input invalidation are visible',async({page})=>{
  const f=await setup(page);try{
    await page.locator('[data-page=settings]').click();const standard=page.locator('[data-standard-row]').first();await expect(standard.locator('[data-standard-hours]')).toHaveValue('');await standard.locator('[data-standard-hours]').fill('15');await page.getByRole('button',{name:'기준시간 저장',exact:true}).click();await expect(page.locator('#standard-message')).toContainText('저장');
    await page.locator('[data-page=monthly-planner]').click();await page.locator('[name=planningMonth]').fill('2026-11');const row=page.locator('[data-planner-row]').first();await row.locator('[data-field=project]').fill('기준시간');await expect(row.locator('[data-field=hours]')).toHaveValue('15');
    await page.locator('[name=planningMode]').selectOption('deadline');await expect(row.locator('[data-field=deadline]')).toBeVisible();await row.locator('[data-field=deadline]').fill('2026-11-09');await page.getByRole('button',{name:'편성안 만들기',exact:true}).click();await expect(page.locator('#monthly-preview')).toContainText('부족');await expect(page.getByRole('button',{name:'일괄 확정 · 캘린더에 등록',exact:true})).toBeDisabled();
    await row.locator('[data-field=deadline]').fill('2026-11-20');await page.getByRole('button',{name:'편성안 만들기',exact:true}).click();await expect(page.getByRole('button',{name:'일괄 확정 · 캘린더에 등록',exact:true})).toBeEnabled();await row.locator('[data-field=hours]').fill('16');await expect(page.getByRole('button',{name:'일괄 확정 · 캘린더에 등록',exact:true})).toHaveCount(0);
    await row.locator('[data-field=equipmentId]').selectOption('endurance');await expect(row.locator('[data-field=testType]')).not.toContainText('Glass Wool');await expect(row.locator('[data-field=includeWeekend]')).toBeDisabled();
    for(let i=1;i<30;i++)await page.getByRole('button',{name:'시험 추가',exact:true}).click();await expect(page.locator('[data-planner-row]')).toHaveCount(30);await expect(page.getByRole('button',{name:'시험 추가',exact:true})).toBeDisabled();
  }finally{await f.close();}
});
test('delayed previews do not overwrite changed input or a different page',async({page})=>{
  const f=await setup(page);try{
    await page.locator('[data-page=monthly-planner]').click();await page.locator('[name=planningMonth]').fill('2026-11');const row=page.locator('[data-planner-row]').first();await row.locator('[data-field=project]').fill('원래 입력');await row.locator('[data-field=hours]').fill('15');
    let release,entered;const started=new Promise(r=>entered=r);await page.route('**/api/monthly-schedules/preview',async route=>{entered();await new Promise(r=>release=r);await route.continue();});
    await page.getByRole('button',{name:'편성안 만들기',exact:true}).click();await started;await row.locator('[data-field=project]').fill('새 입력');await page.locator('[data-page=tests]').click();release();await page.waitForResponse('**/api/monthly-schedules/preview');await expect(page.locator('#page-title')).toHaveText('시험 계획 수립');await page.locator('[data-page=monthly-planner]').click();await expect(row.locator('[data-field=project]')).toHaveValue('새 입력');await expect(page.getByRole('button',{name:'일괄 확정 · 캘린더에 등록',exact:true})).toHaveCount(0);
  }finally{await f.close();}
});
test('ordinary team members can read standards but cannot edit the table',async({page,browser})=>{
  const f=await setup(page);const context=await browser.newContext();try{
    const account=await(await page.request.get(f.base+'/api/me')).json();
    await page.request.post(f.base+'/api/users',{headers:{'x-csrf-token':account.csrf},data:{login:'member',name:'팀원',password:'member-password-123'}});
    const member=await context.newPage();await member.goto(f.base);await member.locator('#auth-form [name=login]').fill('member');await member.locator('#auth-form [name=password]').fill('member-password-123');await member.locator('#auth-submit').click();await expect(member.locator('.schedule-table')).toBeVisible();await member.locator('[data-page=settings]').click();await expect(member.locator('[data-standard-hours]').first()).toBeDisabled();await expect(member.getByRole('button',{name:'기준시간 저장',exact:true})).toHaveCount(0);await member.locator('[data-page=monthly-planner]').click();await expect(member.locator('[data-planner-row]')).toHaveCount(1);
  }finally{await context.close();await f.close();}
});
