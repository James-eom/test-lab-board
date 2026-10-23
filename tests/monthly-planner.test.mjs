import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, operatingMinutes } from '../src/schedule.mjs';
import { planMonthlySchedule } from '../src/monthly-planner.mjs';
const iso=s=>new Date(s+'+09:00').toISOString();
const row=(key,extra={})=>({key,project:key,equipmentId:'engine-1',testType:'배압 시험',ownerId:'u',requiredMinutes:900,includeWeekend:false,deadline:null,...extra});
const ctx=(items,extra={})=>({input:{month:'2026-11',mode:'earliest',items},standards:{version:0,entries:[{equipmentId:'engine-1',testType:'배압 시험',requiredMinutes:null,enabled:true}]},rules:DEFAULT_RULES,reservations:[],downtimes:[],users:[{id:'u',active:true}],knownHolidayYears:[2026],nowMs:Date.parse(iso('2026-11-09T08:00')),...extra});
test('earliest and deadline order differ without changing designated rooms',async()=>{
  const c=ctx([row('a',{deadline:'2026-11-20'}),row('b',{deadline:'2026-11-10'})]);
  const a=await planMonthlySchedule(c), b=await planMonthlySchedule({...c,input:{...c.input,mode:'deadline'}});
  assert.deepEqual(a.assignments.map(x=>x.key),['a','b']); assert.deepEqual(b.assignments.map(x=>x.key),['b','a']);
  assert.equal(a.assignments[0].start,iso('2026-11-09T08:30')); assert.equal(a.assignments[0].end,iso('2026-11-10T14:00'));
  assert.equal(operatingMinutes(a.assignments[0],DEFAULT_RULES),900);
  assert.ok(a.assignments.every(x=>x.equipmentId==='engine-1'));
});
test('server time boundaries, future months and invalid inputs cannot backdate',async()=>{
  for(const time of ['2026-11-09T08:30','2026-11-09T08:31']) assert.equal((await planMonthlySchedule(ctx([row('a')],{nowMs:Date.parse(iso(time))}))).assignments[0].start,iso('2026-11-09T09:00'));
  const c=ctx([row('a')],{nowMs:Date.parse(iso('2026-10-23T08:00'))});
  assert.equal((await planMonthlySchedule(c)).assignments[0].start,iso('2026-11-02T08:30'));
  await assert.rejects(planMonthlySchedule({...c,input:{...c.input,month:'2026-09'}}));
  for(const items of [[],Array.from({length:31},(_,i)=>row(String(i))),[row('x',{requiredMinutes:31})],[row('x',{ownerId:'missing'})],[row('a'),row('a')]]) await assert.rejects(planMonthlySchedule(ctx(items)));
  await assert.rejects(planMonthlySchedule({...c,input:{...c.input,mode:'deadline'}}));
});
test('busy intermediate days reject the complete candidate instead of splitting',async()=>{
  const c=ctx([row('a')]); c.reservations=[{...row('existing'),id:'old',start:iso('2026-11-10T08:30'),end:iso('2026-11-10T20:30'),status:'계획'}];
  const result=await planMonthlySchedule(c);
  assert.equal(result.assignments[0].start,iso('2026-11-11T08:30'));
  c.reservations[0].testType='토출/방사음 시험';
  assert.equal((await planMonthlySchedule(c)).assignments[0].start,iso('2026-11-09T08:30'));
  c.downtimes=[{equipmentId:'engine-1',start:iso('2026-11-10T08:30'),end:iso('2026-11-10T20:30')}];
  assert.equal((await planMonthlySchedule(c)).assignments[0].start,iso('2026-11-11T08:30'));
});
test('month/deadline caps, unknown holidays and search bounds report unplaced',async()=>{
  const c=ctx([row('a')],{nowMs:Date.parse(iso('2026-11-30T08:00'))});
  assert.equal((await planMonthlySchedule(c)).unplaced.length,1);
  assert.equal((await planMonthlySchedule(ctx([row('a')],{knownHolidayYears:[]}))).unplaced[0].code,'HOLIDAYS_UNKNOWN');
  const limited=await planMonthlySchedule(ctx([row('a')]),{maxCandidates:0});
  assert.equal(limited.limited,true); assert.equal(limited.unplaced[0].code,'SEARCH_LIMIT');
  const midnight=ctx([row('a',{equipmentId:'endurance',testType:'SN 커브 추출시험',requiredMinutes:1440,deadline:'2026-11-09'})],{nowMs:Date.parse(iso('2026-11-08T23:30'))});
  midnight.standards.entries=[{equipmentId:'endurance',testType:'SN 커브 추출시험',enabled:true,requiredMinutes:1440}]; midnight.input.mode='deadline';
  assert.equal((await planMonthlySchedule(midnight)).assignments[0].end,iso('2026-11-10T00:00'));
});
test('search yields to concurrent requests and preserves holiday/weekend/test exceptions',async()=>{
  let yielded=false; setImmediate(()=>{yielded=true;});
  await planMonthlySchedule(ctx([row('a')]),{yieldEvery:1}); assert.equal(yielded,true);
  const c=ctx([row('a',{includeWeekend:true})],{nowMs:Date.parse(iso('2026-11-06T20:00')),rules:{...DEFAULT_RULES,holidays:[{date:'2026-11-07'}]}});
  const r=await planMonthlySchedule(c); assert.equal(r.assignments[0].plannedWindows[0].start,iso('2026-11-08T08:30'));
  const leap=ctx([row('a',{requiredMinutes:30})],{nowMs:Date.parse(iso('2028-02-29T08:00')),knownHolidayYears:[2028]}); leap.input.month='2028-02';
  assert.equal((await planMonthlySchedule(leap)).assignments[0].start,iso('2028-02-29T08:30'));
});
