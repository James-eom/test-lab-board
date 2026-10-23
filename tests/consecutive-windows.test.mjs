import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, operatingMinutes, expandReservation } from '../src/schedule.mjs';
import * as consecutive from '../src/consecutive-windows.mjs';
const iso = s => new Date(s + '+09:00').toISOString();
const win = (s,e) => ({ start: iso(s), end: iso(e) });
const base = { equipmentId:'engine-1', testType:'배압 시험', includeWeekend:false };
function fit(r, rules=DEFAULT_RULES) { return consecutive.fitConsecutiveHours(r,rules,iso('2026-12-01T00:00')); }
test('15 hours uses the full first operating day and only the next day remainder', () => {
  const r={...base,start:iso('2026-11-09T08:30'),requiredMinutes:900};
  const plannedWindows=fit(r);
  assert.deepEqual(plannedWindows,[win('2026-11-09T08:30','2026-11-09T20:30'),win('2026-11-10T08:30','2026-11-10T14:00')]);
  assert.equal(operatingMinutes({...r,end:plannedWindows.at(-1).end,plannedWindows}),900);
});
test('late first-day start can end at an earlier clock on the final day', () => {
  const r={...base,start:iso('2026-11-09T16:00'),requiredMinutes:900};
  const plannedWindows=fit(r);
  assert.equal(plannedWindows.at(-1).end,iso('2026-11-11T09:00'));
  assert.equal(operatingMinutes({...r,end:plannedWindows.at(-1).end,plannedWindows}),900);
});
test('excluded weekends and holidays are skipped but missing operating windows are rejected', () => {
  const rules={...DEFAULT_RULES,holidays:[{date:'2026-11-09'}]};
  const r={...base,start:iso('2026-11-06T08:30'),requiredMinutes:900};
  const plannedWindows=fit(r,rules), booking={...r,end:plannedWindows.at(-1).end,plannedWindows};
  assert.equal(booking.end,iso('2026-11-10T14:00'));
  assert.deepEqual(expandReservation(booking,rules),plannedWindows);
  for(const bad of [[plannedWindows[0]], [...plannedWindows].reverse(), [plannedWindows[0],plannedWindows[0]], [win('2026-11-06T08:31','2026-11-06T20:30'),plannedWindows[1]]])
    assert.throws(()=>consecutive.validatePlannedWindows({...booking,plannedWindows:bad},rules));
  const holidayRules={...rules,holidays:[...rules.holidays,{date:'2026-11-10'}]};
  assert.equal(expandReservation(booking,holidayRules,{validateOperatingDays:false}).length,1);
  assert.equal(booking.plannedWindows.length,2);
});
test('24-hour, thermal break and ordinary performance rules stay distinct',()=>{
  for(const [equipmentId,testType,end] of [['endurance','SN 커브 추출시험','2026-11-10T07:00'],['thermal-1','열피로 시험','2026-11-10T19:00'],['thermal-1','Glass Wool 내구','2026-11-11T09:00'],['endurance','성능시험','2026-11-11T09:00']]) {
    const r={equipmentId,testType,start:iso('2026-11-09T16:00'),requiredMinutes:900};
    const plannedWindows=fit(r);
    assert.equal(plannedWindows.at(-1).end,iso(end));
    assert.equal(operatingMinutes({...r,end:iso(end),plannedWindows}),900);
  }
  assert.equal(fit({...base,start:iso('2026-11-09T12:30'),requiredMinutes:30}),null);
});
