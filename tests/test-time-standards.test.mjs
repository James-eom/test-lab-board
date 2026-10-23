import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
test('standards preserve null defaults, room-specific durations and versioned atomic validation',()=>{
  const s=new Store(':memory:');
  try {
    const initial=s.testTimeStandards();
    assert.equal(initial.version,0); assert.equal(initial.entries.length,28);
    assert.ok(initial.entries.every(e=>e.requiredMinutes===null&&e.enabled));
    const entries=initial.entries.map((e,i)=>({...e,requiredMinutes:i===0?900:i===2?30:null}));
    const saved=s.saveTestTimeStandards({version:0,entries});
    assert.equal(saved.version,1); assert.equal(saved.entries[0].requiredMinutes,900); assert.equal(saved.entries[2].requiredMinutes,30);
    assert.throws(()=>s.saveTestTimeStandards({version:0,entries}),e=>e.status===409);
    for(const value of [0,-30,31,NaN,'30',Infinity]) assert.throws(()=>s.saveTestTimeStandards({version:1,entries:entries.map((e,i)=>i===0?{...e,requiredMinutes:value}:e)}));
    assert.throws(()=>s.saveTestTimeStandards({version:1,entries:[entries[0],...entries.slice(0,-1)]}));
    assert.throws(()=>s.saveTestTimeStandards({version:1,entries:entries.map((e,i)=>i===0?{...e,equipmentId:'endurance'}:e)}));
    assert.deepEqual(s.testTimeStandards(),saved);
    assert.deepEqual(s.reservations(),[]); assert.deepEqual(s.actuals(),[]);
  } finally{s.db.close();}
});
