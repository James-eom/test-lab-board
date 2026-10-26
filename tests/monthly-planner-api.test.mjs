import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { createApp } from '../server.mjs';
import { MonthlyPlanService } from '../src/monthly-plan-service.mjs';
const iso=s=>new Date(s+'+09:00').toISOString();
async function fixture(){
  let now=Date.parse(iso('2026-11-09T08:00'));
  const app=createApp({dbPath:':memory:',clock:()=>now});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=(headers,path,method='GET',data)=>fetch(base+path,{method,headers:{...headers,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  const response=await request({},'/api/setup','POST',{login:'manager',name:'관리자',password:'test-password-123'}),account=await response.json();
  const headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-csrf-token':account.csrf};
  const input={month:'2026-11',mode:'earliest',items:[{key:'a',project:'차종',equipmentId:'engine-1',testType:'배압 시험',ownerId:account.user.id,requiredMinutes:900,includeWeekend:false,deadline:null}]};
  return {app,headers,input,request,account,setNow:value=>{now=Date.parse(iso(value));},close:async()=>{await new Promise(r=>app.server.close(r));app.store.db.close();}};
}
test('authenticated preview is read-only, confirm is atomic/idempotent and reporting uses daily windows',async()=>{
  const f=await fixture();const {request,headers,input,app}=f;
  try{
    assert.equal((await request({},'/api/monthly-schedules/preview','POST',input)).status,401);
    assert.equal((await request({cookie:headers.cookie},'/api/monthly-schedules/preview','POST',input)).status,403);
    let res=await request(headers,'/api/test-time-standards');assert.equal(res.status,200);assert.equal((await res.json()).entries.length,28);
    res=await request(headers,'/api/monthly-schedules/preview','POST',input);assert.equal(res.status,200);
    const preview=await res.json(); assert.equal(app.store.reservations().length,0);assert.equal(preview.result.assignments[0].end,iso('2026-11-10T14:00'));
    res=await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:preview.previewId,assignments:[]});assert.equal(res.status,400);
    res=await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:preview.previewId});assert.equal(res.status,200);const saved=await res.json();
    assert.deepEqual(await (await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:preview.previewId})).json(),saved);
    const r=app.store.reservation(saved.reservationIds[0]);app.store.saveActual({reservationId:r.id,start:iso('2026-11-09T16:00'),end:iso('2026-11-10T12:00')},f.account.user.id);
    const state=await (await request(headers,'/api/state')).json();assert.equal(state.reservations[0].plannedMinutes,900);assert.equal(state.actuals[0].intervals[0].start,iso('2026-11-09T16:00'));
    const query=new URLSearchParams({start:iso('2026-11-01T00:00'),end:iso('2026-12-01T00:00')});
    const cap=(await (await request(headers,'/api/capacity?'+query)).json()).find(x=>x.id==='engine-1');assert.equal(cap.plannedMinutes,900);assert.equal(cap.actualMinutes,450);assert.equal(cap.originalPlanMinutes,900);
    const book=XLSX.read(Buffer.from(await (await request(headers,'/api/export?'+query)).arrayBuffer()),{type:'buffer'});assert.equal(XLSX.utils.sheet_to_json(book.Sheets['시험계획'])[0].계획가동시간,15);
    const service=new MonthlyPlanService(app.store,app.holidaySync);assert.deepEqual(await service.confirm(f.account.user.id,preview.previewId),saved);
  }finally{await f.close();}
});
test('independent previews conflict safely and expired, stale or consumed plans cannot register',async()=>{
  const f=await fixture(),{request,headers,input,app}=f;
  try{
    await request(headers,'/api/users','POST',{login:'second',name:'두 번째 사용자',password:'second-password-123'});
    const login=await request({},'/api/login','POST',{login:'second',password:'second-password-123'}),second=await login.json(),secondHeaders={cookie:login.headers.get('set-cookie').split(';')[0],'x-csrf-token':second.csrf};
    const preview=async()=>await (await request(headers,'/api/monthly-schedules/preview','POST',input)).json();
    f.setNow('2026-11-09T08:15');const a=await preview();f.setNow('2026-11-09T08:31');assert.equal((await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:a.previewId})).status,409);
    f.setNow('2026-11-09T08:00');const b=await preview(),c=await (await request(secondHeaders,'/api/monthly-schedules/preview','POST',input)).json();
    const results=await Promise.all([[b,headers],[c,secondHeaders]].map(([p,h])=>request(h,'/api/monthly-schedules/confirm','POST',{previewId:p.previewId})));assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(app.store.reservations().length,1);
    app.store.deleteAllSchedules(app.store.scheduleDeletionPreview().revision);
    const won=results[0].status===200,id=won?b.previewId:c.previewId;assert.equal((await request(won?headers:secondHeaders,'/api/monthly-schedules/confirm','POST',{previewId:id})).status,410);assert.equal(app.store.reservations().length,0);
    const d=await preview();app.store.saveHoliday({date:'2026-11-11',name:'추가'});assert.equal((await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:d.previewId})).status,409);
  }finally{await f.close();}
});
test('preview expiry, bounded retention, disabled owners and incomplete plans reject confirmation',async()=>{
  const f=await fixture(),{request,headers,input,app}=f;try{
    const preview=async body=>await(await request(headers,'/api/monthly-schedules/preview','POST',body||input)).json();
    const expired=await preview();f.setNow('2026-11-09T08:30');assert.equal((await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:expired.previewId})).status,410);
    f.setNow('2026-11-09T08:00');const oldest=await preview();for(let i=0;i<5;i++)await preview();assert.equal((await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:oldest.previewId})).status,410);
    const incomplete=await preview({...input,items:[{...input.items[0],requiredMinutes:999990}]});assert.equal(incomplete.result.unplaced.length,1);assert.equal((await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:incomplete.previewId})).status,409);
    const standards=app.store.testTimeStandards(),p=await preview();app.store.saveTestTimeStandards({...standards,entries:standards.entries.map((e,i)=>i?e:{...e,requiredMinutes:30})});assert.equal((await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:p.previewId})).status,409);
    const owner=app.store.addUser('newowner','새 담당자','hash'),owned=await preview({...input,items:[{...input.items[0],ownerId:owner.id}]});app.store.removeUser(owner.id,f.account.user.id);assert.equal((await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:owned.previewId})).status,409);
  }finally{await f.close();}
});
test('member cannot change standards or confirm another user plan; delayed revoked sessions are rejected',async()=>{
  const f=await fixture(),{request,headers,input,app}=f;
  try{
    await request(headers,'/api/users','POST',{login:'member',name:'팀원',password:'member-password'});
    const login=await request({},'/api/login','POST',{login:'member',password:'member-password'}),member=await login.json();const mh={cookie:login.headers.get('set-cookie').split(';')[0],'x-csrf-token':member.csrf};
    assert.equal((await request(mh,'/api/test-time-standards','PUT',app.store.testTimeStandards())).status,403);
    const p=await (await request(headers,'/api/monthly-schedules/preview','POST',input)).json();assert.equal((await request(mh,'/api/monthly-schedules/confirm','POST',{previewId:p.previewId})).status,403);
    let resume,entered;const started=new Promise(r=>entered=r);const original=app.holidaySync.refresh.bind(app.holidaySync);
    app.holidaySync.refresh=async()=>{entered();await new Promise(r=>resume=r);};
    const pending=request(mh,'/api/monthly-schedules/preview','POST',input);await started;
    app.store.db.prepare('DELETE FROM sessions WHERE userId=?').run(member.user.id);resume();assert.equal((await pending).status,401);app.holidaySync.refresh=original;
    const service=new MonthlyPlanService(app.store,app.holidaySync,{clock:()=>Date.parse(iso('2026-11-09T08:00'))});
    await assert.rejects(service.confirm(f.account.user.id,p.previewId),e=>e.status===410);
  }finally{await f.close();}
});
test('bulk deletion invalidates rejected unconfirmed previews even when bookings return to empty',async()=>{
  const f=await fixture(),{request,headers,input,app}=f;try{
    const preview=async()=>await(await request(headers,'/api/monthly-schedules/preview','POST',input)).json();
    const a=await preview(),b=await preview();
    assert.equal((await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:a.previewId})).status,200);
    assert.equal((await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:b.previewId})).status,409);
    app.store.deleteAllSchedules(app.store.scheduleDeletionPreview().revision);
    assert.equal((await request(headers,'/api/monthly-schedules/confirm','POST',{previewId:b.previewId})).status,409);
    assert.equal(app.store.reservations().length,0);
  }finally{await f.close();}
});
test('cancelled bookings remain queryable after operating hours change and export with zero occupancy',async()=>{
  const f=await fixture(),{request,headers,app,account}=f;try{
    app.store.saveReservation({title:'취소 시험',project:'보존',equipmentId:'engine-1',testType:'배압 시험',ownerId:account.user.id,start:iso('2026-11-09T08:30'),end:iso('2026-11-09T09:30'),status:'취소'},account.user.id);
    app.store.saveRules({...app.store.rules(),open:600});
    const state=await request(headers,'/api/state');assert.equal(state.status,200);const r=(await state.json()).reservations[0];assert.equal(r.plannedMinutes,0);assert.deepEqual(r.intervals,[]);
    const query=new URLSearchParams({start:iso('2026-11-01T00:00'),end:iso('2026-12-01T00:00')});
    const res=await request(headers,'/api/export?'+query);assert.equal(res.status,200);const book=XLSX.read(Buffer.from(await res.arrayBuffer()),{type:'buffer'});assert.equal(XLSX.utils.sheet_to_json(book.Sheets['시험계획'])[0].계획가동시간,0);
  }finally{await f.close();}
});
