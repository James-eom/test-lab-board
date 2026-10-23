import { randomUUID } from 'node:crypto';
import { planMonthlySchedule } from './monthly-planner.mjs';
import { fail } from './store.mjs';
export class MonthlyPlanService {
  constructor(store,holidaySync,{clock=()=>Date.now()}={}) {this.store=store;this.holidaySync=holidaySync;this.clock=clock;this.previews=new Map();}
  active(userId) {if(!this.store.users().some(u=>u.id===userId&&u.active)) fail('로그인이 필요합니다.',401);}
  async preview(userId,input) {
    this.active(userId);input=structuredClone(input);
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(input?.month)) fail('대상 월을 확인해 주세요.');
    await this.holidaySync.refresh([Number(input.month.slice(0,4))]);this.active(userId);
    const s=this.store,revision=s.monthlyScheduleRevision(),nowMs=this.clock();
    const result=await planMonthlySchedule({input,standards:s.testTimeStandards(),rules:s.rules(),reservations:s.reservations(),downtimes:s.downtimes(),users:s.users(),knownHolidayYears:s.holidayYears(),nowMs});
    this.active(userId);
    if(revision!==s.monthlyScheduleRevision()) fail('계산 도중 일정 또는 설정이 변경되었습니다. 다시 편성해 주세요.',409,'STALE_PLAN');
    for(const [id,p] of this.previews) if(p.expires<=this.clock())this.previews.delete(id);
    const mine=[...this.previews].filter(([,p])=>p.userId===userId);while(mine.length>=5)this.previews.delete(mine.shift()[0]);
    const previewId=randomUUID(),expires=this.clock()+30*60000,preview={previewId,expiresAt:new Date(expires).toISOString(),revision,result};
    this.previews.set(previewId,{...structuredClone(preview),expires,userId,input});return preview;
  }
  async confirm(userId,previewId) {
    this.active(userId);
    const existing=this.store.monthlyScheduleBatch(previewId,userId);if(existing)return existing;
    const p=this.previews.get(previewId);
    if(!p)fail('편성안이 없거나 이미 소모되었습니다. 다시 편성해 주세요.',410);
    if(p.userId!==userId)fail('다른 사용자의 편성안입니다.',403);
    if(p.expires<=this.clock()){this.previews.delete(previewId);fail('편성안이 만료되었습니다. 다시 편성해 주세요.',410);}
    if(p.result.unplaced.length||p.result.limited||p.result.assignments.length!==p.input.items.length)fail('모든 항목이 배치되어야 확정할 수 있습니다.',409);
    const result=this.store.saveMonthlySchedule({previewId,userId,revision:p.revision,assignments:p.result.assignments,nowMs:this.clock()});
    this.previews.delete(previewId);return result;
  }
}
