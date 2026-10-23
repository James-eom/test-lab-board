import { EQUIPMENT, DEFAULT_RULES, MIN, DAY, ms, dayStart, reservationRules, isAroundClock, isContinuous, isOperatingDay, validateInterval, windows } from './operating-rules.mjs';
const window = (a,b) => ({start:new Date(a).toISOString(),end:new Date(b).toISOString()});
export function consecutiveWindowsBetween(r, rules=DEFAULT_RULES, {validateOperatingDays=true}={}) {
  const [a,b]=validateInterval(r.start,r.end);
  if(!EQUIPMENT.some(e=>e.id===r.equipmentId)) throw new Error('시험실을 선택해 주세요.');
  if(isAroundClock(r)) return [window(a,b)];
  rules=reservationRules(r,rules);
  const first=dayStart(a), last=dayStart(b===dayStart(b)?b-1:b);
  if(a<first+rules.open*MIN || a>=first+rules.close*MIN || b<=last+rules.open*MIN || b>last+rules.close*MIN) throw new Error('운영시간 안에서 시작·종료 시간을 지정해 주세요.');
  if(validateOperatingDays && (!isOperatingDay(first,rules)||!isOperatingDay(last,rules))) throw new Error('시작일과 종료일은 공휴일이 아닌 운영일이어야 합니다.');
  const out=[];
  for(let d=first;d<=last;d+=DAY) if(isOperatingDay(d,rules)) out.push(window(Math.max(a,d+rules.open*MIN),Math.min(b,d+rules.close*MIN)));
  return out;
}
export function fitConsecutiveHours(r, rules=DEFAULT_RULES, limitEnd) {
  if(!Number.isSafeInteger(r.requiredMinutes)||r.requiredMinutes<=0||r.requiredMinutes%30) throw new Error('필요시간은 양수의 30분 단위로 입력해 주세요.');
  const a=ms(r.start), limit=ms(limitEnd);
  if(!Number.isFinite(a)||!Number.isFinite(limit)||a>=limit||a%(30*MIN)) return null;
  if(isAroundClock(r)) return a+r.requiredMinutes*MIN<=limit ? [window(a,a+r.requiredMinutes*MIN)] : null;
  rules=reservationRules(r,rules);
  if(!isOperatingDay(a,rules)) return null;
  let remaining=r.requiredMinutes, out=[];
  for(let d=dayStart(a);d<limit;d+=DAY) {
    if(!isOperatingDay(d,rules)) continue;
    const start=Math.max(a,d+rules.open*MIN), end=Math.min(limit,d+rules.close*MIN);
    if(start>=end) { if(d===dayStart(a)) return null; continue; }
    const pieces=windows(start,end,r.equipmentId,isContinuous(r),rules);
    if(!out.length && (!pieces.length||pieces[0][0]!==a)) return null;
    for(const [s,e] of pieces) {
      const usable=(e-s)/MIN;
      if(remaining<=usable) { out.push(window(start,s+remaining*MIN)); return out; }
      remaining-=usable;
    }
    out.push(window(start,end));
  }
  return null;
}
export function validatePlannedWindows(r,rules=DEFAULT_RULES,{validateOperatingDays=true}={}) {
  validateInterval(r.start,r.end);
  if(!Array.isArray(r.plannedWindows)||!r.plannedWindows.length||r.plannedWindows.length>367) throw new Error('일별 예약 구간을 확인해 주세요.');
  let previous=-Infinity;
  const normalized=r.plannedWindows.map(i=>{
    const [a,b]=validateInterval(i.start,i.end);
    if(a<previous||a<ms(r.start)||b>ms(r.end)) throw new Error('일별 구간의 순서와 범위를 확인해 주세요.');
    previous=b; return window(a,b);
  });
  if(normalized[0].start!==new Date(r.start).toISOString()||normalized.at(-1).end!==new Date(r.end).toISOString()) throw new Error('전체 예약 기간과 일별 구간이 다릅니다.');
  if(validateOperatingDays) {
    const canonical=consecutiveWindowsBetween(r,rules);
    if(JSON.stringify(canonical)!==JSON.stringify(normalized)) throw new Error('이어지는 운영일 전체를 사용해야 합니다.');
    return canonical;
  }
  // Stored occupancy stays immutable; current non-operating days are filtered at read time.
  const current=reservationRules(r,rules);
  return isAroundClock(r)?normalized:normalized.filter(i=>isOperatingDay(ms(i.start),current));
}
