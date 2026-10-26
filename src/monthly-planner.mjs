import { setImmediate as yieldLoop } from 'node:timers/promises';
import { EQUIPMENT, expandReservation, canRunTogether, supportsWeekend } from './schedule.mjs';
import { MIN, DAY, OFFSET, isAroundClock } from './operating-rules.mjs';
import { fitConsecutiveHours } from './consecutive-windows.mjs';
const invalid=message=>{throw Object.assign(new Error(message),{status:400});};
const validText=(x,max)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
export async function planMonthlySchedule({input,standards,rules,reservations,downtimes,users,knownHolidayYears,nowMs},{maxCandidates=100000,maxSearchMs=3000,yieldEvery=128}={}) {
  if(!input||!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)||!['earliest','deadline'].includes(input.mode)||!Array.isArray(input.items)||input.items.length<1||input.items.length>30||!Number.isFinite(nowMs)) invalid('대상 월·방식·시험 목록(1~30개)을 확인해 주세요.');
  const [year,month]=input.month.split('-').map(Number), monthStart=Date.UTC(year,month-1,1)-OFFSET, monthEnd=Date.UTC(year,month,1)-OFFSET;
  if(year<2000||year>2100||monthEnd<=nowMs) invalid('현재 이후의 월(2000~2100년)을 선택해 주세요.');
  const keys=new Set();
  const rows=input.items.map(item=>{
    if(!item||!validText(item.key,80)||keys.has(item.key)||!validText(item.project,100)||!EQUIPMENT.some(e=>e.id===item.equipmentId&&e.types.includes(item.testType))||!users.some(u=>u.id===item.ownerId&&u.active)||typeof item.includeWeekend!=='boolean'||(item.includeWeekend&&!supportsWeekend(item.equipmentId))) invalid('시험실·항목·프로젝트·담당자를 확인해 주세요.');
    keys.add(item.key);
    const standard=standards.entries.find(s=>s.equipmentId===item.equipmentId&&s.testType===item.testType);
    const requiredMinutes=item.requiredMinutes===null?standard?.requiredMinutes:item.requiredMinutes;
    if(!standard?.enabled||!Number.isSafeInteger(requiredMinutes)||requiredMinutes<=0||requiredMinutes%30) invalid('기준시간 또는 행의 총 필요 가동시간을 양수의 0.5시간 단위로 입력해 주세요.');
    let limit=monthEnd;
    if(input.mode==='deadline') {
      if(typeof item.deadline!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(item.deadline)||!Number.isFinite(Date.parse(item.deadline))||new Date(item.deadline).toISOString().slice(0,10)!==item.deadline) invalid('완료 희망일을 입력해 주세요.');
      limit=Math.min(limit,Date.parse(item.deadline+'T00:00:00+09:00')+DAY);
    }
    return {...item,project:item.project.trim(),requiredMinutes,limit};
  });
  if(input.mode==='deadline') rows.sort((a,b)=>a.deadline.localeCompare(b.deadline));
  const assignments=[],unplaced=[], occupied=reservations.filter(r=>r.status!=='취소').map(r=>({r,parts:expandReservation(r,rules,{validateOperatingDays:false})}));
  const started=performance.now(); let count=0, limited=false;
  for(const row of rows) {
    if(!isAroundClock(row)&&!knownHolidayYears.includes(year)) { unplaced.push({key:row.key,code:'HOLIDAYS_UNKNOWN',message:`${year}년 공휴일 자료를 확인한 후 다시 편성해 주세요.`}); continue; }
    let found=false, conflict=false, downtime=false;
    for(let t=Math.max(monthStart,Math.floor(nowMs/(30*MIN))*(30*MIN)+30*MIN);t<row.limit;t+=30*MIN) {
      if(count>=maxCandidates||performance.now()-started>=maxSearchMs) {limited=true;break;}
      if(++count%yieldEvery===0) await yieldLoop();
      const plannedWindows=fitConsecutiveHours({...row,start:new Date(t).toISOString()},rules,new Date(row.limit).toISOString());
      if(!plannedWindows) continue;
      if(occupied.some(o=>o.r.equipmentId===row.equipmentId&&!canRunTogether(row,o.r)&&plannedWindows.some(w=>o.parts.some(p=>p.start<w.end&&p.end>w.start)))) {conflict=true;continue;}
      if(downtimes.some(d=>d.equipmentId===row.equipmentId&&plannedWindows.some(w=>d.start<w.end&&d.end>w.start))) {downtime=true;continue;}
      const assignment={key:row.key,title:row.testType,project:row.project,equipmentId:row.equipmentId,testType:row.testType,ownerId:row.ownerId,includeWeekend:row.includeWeekend,requiredMinutes:row.requiredMinutes,start:plannedWindows[0].start,end:plannedWindows.at(-1).end,plannedWindows};
      assignments.push(assignment);occupied.push({r:assignment,parts:plannedWindows});found=true;break;
    }
    if(!found) unplaced.push({key:row.key,code:limited?'SEARCH_LIMIT':downtime?'DOWNTIME':conflict?'CONFLICT':'PERIOD_LIMIT',message:limited?'탐색 한도 내 편성안을 찾지 못함':downtime?'설비 정지로 연속 구간을 확보하지 못했습니다.':conflict?'예약 충돌로 연속 구간을 확보하지 못했습니다.':'월 또는 완료 희망일 안의 가동시간이 부족합니다.'});
  }
  return {assignments,unplaced,limited};
}
