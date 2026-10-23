import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { fitConsecutiveHours, actualReservation } from '../src/consecutive-windows.mjs';
import { operatingMinutes, capacity } from '../src/schedule.mjs';
const iso=s=>new Date(s+'+09:00').toISOString();
function fixture(){
  const s=new Store(':memory:'),u=s.addUser('admin','관리자','hash','admin'),o=s.addUser('owner','담당자','hash');
  const row={equipmentId:'engine-1',testType:'배압 시험',title:'자동 시험',project:'차종',ownerId:o.id,includeWeekend:false,start:iso('2026-11-09T08:30'),requiredMinutes:900};
  row.plannedWindows=fitConsecutiveHours(row,s.rules(),iso('2026-12-01T00:00'));row.end=row.plannedWindows.at(-1).end;
  const save=(assignments=[row],previewId='batch')=>s.saveMonthlySchedule({previewId,userId:u.id,revision:s.monthlyScheduleRevision(),assignments,nowMs:Date.parse(iso('2026-11-09T08:00'))});
  return {s,u,o,row,save};
}
test('monthly booking is one reservation with creator history, accurate capacity and independent actual windows',()=>{
  const {s,u,o,row,save}=fixture(); try{
    const result=save(),r=s.reservation(result.reservationIds[0]);
    assert.equal(s.reservations().length,1);assert.equal(s.history(r.id)[0].userId,u.id);
    assert.equal(operatingMinutes(r,s.rules()),900);
    assert.equal(capacity({equipmentId:r.equipmentId,start:r.start,end:r.end,reservations:[r],rules:s.rules()}).plannedMinutes,900);
    assert.throws(()=>s.reservationDeletionPreview(r.id,o.id),e=>e.status===403);
    assert.ok(s.reservationDeletionPreview(r.id,u.id));
    assert.throws(()=>s.saveReservation({...row,status:'계획'},u.id),/구간/);
    const renamed=s.saveReservation({...r,title:'이름 변경',reason:'명칭'},u.id,r.id);
    assert.deepEqual(renamed.plannedWindows,r.plannedWindows);
    const changed=s.saveReservation({...renamed,end:iso('2026-11-10T15:00'),plannedWindows:[],reason:'기간 변경'},u.id,r.id);
    assert.equal(operatingMinutes(changed,s.rules()),960); assert.equal(changed.monthlySchedule.requiredMinutes,900);
    const a=s.saveActual({reservationId:r.id,start:iso('2026-11-09T16:00'),end:iso('2026-11-10T12:00')},u.id);
    assert.equal(operatingMinutes(actualReservation(changed,a,s.rules()),s.rules()),450);
    const original=s.originalPlans()[0];s.saveHoliday({date:'2026-11-10',name:'휴일'});
    assert.deepEqual(s.originalPlans()[0],original);
    assert.equal(operatingMinutes(actualReservation(changed,a,{...s.rules(),holidays:[]}),{...s.rules(),holidays:[]}),450);
    assert.throws(()=>s.saveReservation({...changed,end:iso('2026-11-10T16:00'),reason:'실적 보호'},u.id,r.id),e=>e.status===409);
    assert.deepEqual(s.saveMonthlySchedule({previewId:'batch',userId:u.id}),result);
  }finally{s.db.close();}
});
test('atomic batch rollback, stale guards and idempotency prevent partial or resurrected bookings',()=>{
  const {s,u,row,save}=fixture();try{
    const other={...row,equipmentId:'engine-2'};
    s.db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON intervals WHEN NEW.equipmentId='engine-2' BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
    assert.throws(()=>save([row,other]));
    assert.equal(s.reservations().length,0);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM history').get().n,0);assert.equal(s.monthlyScheduleBatch('batch',u.id),null);
    s.db.exec('DROP TRIGGER reject_second');
    const stale=s.monthlyScheduleRevision();s.saveHoliday({date:'2026-11-11',name:'추가'});
    assert.throws(()=>s.saveMonthlySchedule({previewId:'stale',userId:u.id,assignments:[row],revision:stale,nowMs:0}),e=>e.status===409);
    const result=save(),r=s.reservation(result.reservationIds[0]);
    s.deleteReservation(r.id,s.reservationDeletionPreview(r.id,u.id).revision,u.id);
    assert.deepEqual(s.saveMonthlySchedule({previewId:'batch',userId:u.id}),result);assert.equal(s.reservations().length,0);
    s.deleteAllSchedules(s.scheduleDeletionPreview().revision);assert.equal(s.monthlyScheduleBatch('batch',u.id),null);
    assert.equal(s.testTimeStandards().entries.length,28);
    assert.throws(()=>s.saveMonthlySchedule({previewId:'past',userId:u.id,revision:s.monthlyScheduleRevision(),assignments:[row],nowMs:Date.parse(iso('2026-11-09T09:00'))}));
  }finally{s.db.close();}
});
test('automatic bookings retain the existing protection against incompatible operating rule edits',()=>{
  const {s,save}=fixture();try{
    save();assert.throws(()=>s.saveRules({...s.rules(),open:570}),e=>e.status===409);
    assert.throws(()=>s.saveRules({...s.rules(),close:1200}),e=>e.status===409);
  }finally{s.db.close();}
});
