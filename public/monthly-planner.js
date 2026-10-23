window.MonthlyPlannerUI = (() => {
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const korean=value=>new Date(Date.parse(value)+9*3600000).toISOString().slice(0,16).replace('T',' ');
  const monthNow=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,7);
  const options=(items,value)=>items.map(([id,name])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(name)}</option>`).join('');
  function create({api,onRegistered,getUsers,getEquipment,getRole,getStandards,redraw}) {
    let month=monthNow(),mode='earliest',rows=[],sequence=0,preview=null,generation=0,busy=false,message='',draft=null,standardMessage='';
    const standardFor=r=>getStandards()?.entries.find(s=>s.equipmentId===r.equipmentId&&s.testType===r.testType);
    const hoursFor=r=>r.hours===null?(standardFor(r)?.requiredMinutes===null?'':String((standardFor(r)?.requiredMinutes||0)/60)):r.hours;
    const add=()=>{const e=getEquipment()[0];rows.push({key:String(++sequence),project:'',equipmentId:e.id,testType:e.types[0],ownerId:getUsers().find(u=>u.active)?.id||'',hours:null,includeWeekend:false,deadline:''});};
    function invalidatePreview() {generation++;preview=null;message='';const area=document.querySelector('#monthly-preview');if(area)area.innerHTML='';}
    function render() {
      if(!rows.length)add();
      return `<section id="monthly-planner" class="monthly-planner"><p class="muted">기존 예약은 변경하지 않습니다. 한국시간 현재 이후부터 월 안의 연속 운영일에 배치합니다. 공휴일·휴식·시험별 예외를 유지합니다.</p><form id="monthly-plan-form"><div class="planner-options"><label>대상 월<input name="planningMonth" type="month" min="${monthNow()}" max="2100-12" value="${month}" required></label><label>배치 순서<select name="planningMode">${options([['earliest','빠른 배치'],['deadline','완료 희망일 기준']],mode)}</select></label></div><div class="planner-rows">${rows.map((r,i)=>{
        const equipment=getEquipment().find(e=>e.id===r.equipmentId),weekend=['engine-1','engine-2','flow'].includes(r.equipmentId);
        return `<fieldset data-planner-row="${r.key}"><legend>시험 ${i+1}</legend><div class="planner-row-grid"><label>프로젝트<input data-field="project" value="${esc(r.project)}" maxlength="100" required></label><label>시험실<select data-field="equipmentId">${options(getEquipment().map(e=>[e.id,e.name]),r.equipmentId)}</select></label><label>시험항목<select data-field="testType">${options(equipment.types.map(t=>[t,t]),r.testType)}</select></label><label>담당자<select data-field="ownerId">${options(getUsers().filter(u=>u.active).map(u=>[u.id,u.name]),r.ownerId)}</select></label><label>총 필요 가동시간 (시간)<input data-field="hours" type="number" min="0.5" step="0.5" value="${esc(hoursFor(r))}" placeholder="기준시간 미등록" required></label>${mode==='deadline'?`<label>완료 희망일<input data-field="deadline" type="date" value="${esc(r.deadline)}" required></label>`:''}<label class="checkbox-label"><input data-field="includeWeekend" type="checkbox" ${r.includeWeekend?'checked':''} ${weekend?'':'disabled'}>주말 포함</label><button class="quiet danger" type="button" data-monthly-action="remove" data-key="${r.key}" ${rows.length===1?'disabled':''}>시험 제거</button></div>${standardFor(r)?.enabled===false?'<p class="error">자동 편성 사용이 중지된 시험항목입니다.</p>':''}</fieldset>`;
      }).join('')}</div><div class="inline-actions"><button type="button" class="quiet" data-monthly-action="add" ${rows.length>=30?'disabled':''}>시험 추가</button><button type="button" class="primary" data-monthly-action="preview" ${busy?'disabled':''}>${busy?'처리 중…':'편성안 만들기'}</button><small>최대 30개 · 전역 최적 배치는 보장하지 않습니다.</small></div></form><p id="monthly-message" class="error" role="alert">${esc(message)}</p><div id="monthly-preview">${previewHTML()}</div></section>`;
    }
    function previewHTML() {
      if(!preview)return '';
      const result=preview.result;
      return `<section class="monthly-preview"><h2>자동 편성 미리보기</h2><p class="muted">확정 전까지 시험은 등록되지 않습니다. 만료: ${korean(preview.expiresAt)} (한국시간)</p>${result.assignments.map(a=>`<article><h3>${esc(a.project)} · ${esc(a.testType)}</h3><p>${esc(getEquipment().find(e=>e.id===a.equipmentId)?.name)} · ${esc(getUsers().find(u=>u.id===a.ownerId)?.name)}</p><p>${korean(a.start)} ~ ${korean(a.end)}</p><p>요구 ${a.requiredMinutes/60}시간 · 계산 ${a.requiredMinutes/60}시간${mode==='deadline'?' · 완료 희망일 준수':''}</p><details><summary>운영일별 구간 ${a.plannedWindows.length}개</summary><ul>${a.plannedWindows.map(w=>`<li>${korean(w.start)} ~ ${korean(w.end)}</li>`).join('')}</ul></details></article>`).join('')}${result.unplaced.map(u=>`<p class="warning-note">${esc(rows.find(r=>r.key===u.key)?.project)}: ${esc(u.message)}</p>`).join('')}<button type="button" class="primary" data-monthly-action="confirm" ${busy||result.unplaced.length||result.limited?'disabled':''}>일괄 확정 · 캘린더에 등록</button></section>`;
    }
    function renderStandards() {
      if(!draft)draft=structuredClone(getStandards());
      if(!draft)return '';
      const admin=getRole()==='admin';
      return `<section class="time-standards"><div class="section-heading"><h2>시험항목별 기준시간</h2></div><p class="muted">총 필요 가동시간을 0.5시간 단위로 등록합니다. 빈 값은 미등록입니다. 기존 일정은 변경하지 않습니다.</p><div class="table-wrap"><table class="data-table"><thead><tr><th>시험실</th><th>시험항목</th><th>총 필요 가동시간 (시간)</th><th>자동 편성 사용</th></tr></thead><tbody>${draft.entries.map((s,i)=>`<tr data-standard-row="${i}"><td>${esc(getEquipment().find(e=>e.id===s.equipmentId)?.name)}</td><td>${esc(s.testType)}</td><td><input type="number" min="0.5" step="0.5" data-standard-hours aria-label="${esc(s.equipmentId+' '+s.testType+' 기준시간')}" value="${s.requiredMinutes===null?'':s.requiredMinutes/60}" ${admin?'':'disabled'}></td><td><input type="checkbox" data-standard-enabled aria-label="${esc(s.equipmentId+' '+s.testType+' 자동 편성 사용')}" ${s.enabled?'checked':''} ${admin?'':'disabled'}></td></tr>`).join('')}</tbody></table></div>${admin?`<button class="quiet" type="button" data-monthly-action="standards" ${busy?'disabled':''}>기준시간 저장</button>`:'<p class="muted">관리자만 기준시간을 변경할 수 있습니다.</p>'}<p id="standard-message" role="status">${esc(standardMessage)}</p></section>`;
    }
    function handleChange(event) {
      const target=event.target,standard=target.closest('[data-standard-row]');
      if(standard){const s=draft.entries[Number(standard.dataset.standardRow)];if(target.hasAttribute('data-standard-hours'))s.requiredMinutes=target.value===''?null:Number(target.value)*60;else if(target.hasAttribute('data-standard-enabled'))s.enabled=target.checked;standardMessage='';invalidatePreview();return;}
      const element=target.closest('[data-planner-row]');
      if(element){const r=rows.find(r=>r.key===element.dataset.plannerRow),field=target.dataset.field;if(!r||!field)return; r[field]=field==='includeWeekend'?target.checked:target.value;
        if(field==='equipmentId'){r.testType=getEquipment().find(e=>e.id===r.equipmentId).types[0];r.hours=null;if(!['engine-1','engine-2','flow'].includes(r.equipmentId))r.includeWeekend=false;}
        if(field==='testType')r.hours=null;
        invalidatePreview();if(target.tagName==='SELECT')redraw();return;
      }
      if(target.name==='planningMonth'||target.name==='planningMode'){if(target.name==='planningMonth')month=target.value;else mode=target.value;invalidatePreview();if(target.tagName==='SELECT')redraw();}
    }
    async function handleClick(event) {
      const button=event.target.closest('[data-monthly-action]');if(!button)return false;
      const action=button.dataset.monthlyAction;
      if(action==='add'&&rows.length<30){add();invalidatePreview();redraw();return true;}
      if(action==='remove'&&rows.length>1){rows=rows.filter(r=>r.key!==button.dataset.key);invalidatePreview();redraw();return true;}
      if(busy)return true;
      if(action==='preview'&&!document.querySelector('#monthly-plan-form').reportValidity())return true;
      if(action==='standards'&&(!getRole()||getRole()!=='admin'))return true;
      const id=preview?.previewId,token=generation,selectedMonth=month;busy=true;message='';redraw();
      try {
        if(action==='standards'){
          draft=await api('/api/test-time-standards','PUT',draft);standardMessage='기준시간을 저장했습니다.';invalidatePreview();await onRegistered(null);
        }else if(action==='preview'){
          const input={month,mode,items:rows.map(r=>({key:r.key,project:r.project,equipmentId:r.equipmentId,testType:r.testType,ownerId:r.ownerId,includeWeekend:r.includeWeekend,requiredMinutes:r.hours===null?null:Number(r.hours)*60,deadline:mode==='deadline'?r.deadline:null}))};
          const result=await api('/api/monthly-schedules/preview','POST',input);if(token===generation)preview=result;
        }else if(action==='confirm'&&id){
          await api('/api/monthly-schedules/confirm','POST',{previewId:id});if(token===generation){invalidatePreview();await onRegistered(selectedMonth);}
        }
      }catch(e){if(token===generation){if(action==='standards')standardMessage=e.message;else message=e.message;}}
      finally{busy=false;redraw();}
      return true;
    }
    return {render,renderStandards,handleClick,handleChange,invalidatePreview};
  }
  return {create};
})();
