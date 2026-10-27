import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,applyBatch,recomputeRecords,filterEnterprises,exactQuery,getLineage,validateMappings,recordServiceCall,runBuiltinScript} from '../public/prototype/core.mjs';
import {DEMO_SNAPSHOTS,DEMO_METADATA} from '../public/prototype/demo-data.mjs';
const copy=v=>JSON.parse(JSON.stringify(v));
const now='2026-10-27T10:00:00+08:00';

test('seed creates stable synthetic enterprise identities and separates file tags from API data',()=>{
  const state=createInitialState();
  assert.equal(state.records.length,24); assert.equal(state.rawRecords.length,72);
  assert.ok(state.records.every(r=>r.creditCode.startsWith('DEMO-')&&r.enterpriseName.startsWith('演示')));
  const api=createInitialState({seed:false});
  applyBatch(api,{sourceId:'qcc',rows:copy(DEMO_SNAPSHOTS.qcc.v1),mode:'full',now});
  assert.equal(api.records[0].registeredCapitalWan,26000);
  assert.deepEqual(api.records[0].qualifications,[]);
  assert.equal(api.records[0].scale,null);
});

test('identical full snapshot is idempotent and does not fabricate changes',()=>{
  const state=createInitialState(),ids=state.records.map(r=>r.id);
  const {task}=applyBatch(state,{sourceId:'qcc',rows:copy(DEMO_SNAPSHOTS.qcc.v1),mode:'full',now});
  assert.deepEqual([task.added,task.updated,task.unchanged,task.failed],[0,0,24,0]);
  assert.equal(task.newEnterprises,0); assert.equal(task.changedEnterprises,0);
  assert.deepEqual(state.records.map(r=>r.id),ids); assert.equal(state.rawRecords.length,72);
});

test('v2 full snapshot has exactly two source changes and one new enterprise; repeat changes nothing',()=>{
  const state=createInitialState();
  const first=applyBatch(state,{sourceId:'qcc',rows:copy(DEMO_SNAPSHOTS.qcc.v2),mode:'full',now}).task;
  assert.deepEqual([first.added,first.updated,first.unchanged,first.newEnterprises,first.changedEnterprises],[1,2,22,1,2]);
  assert.equal(state.records.length,25); assert.equal(state.records[0].registeredCapitalWan,28000);
  const repeat=applyBatch(state,{sourceId:'qcc',rows:copy(DEMO_SNAPSHOTS.qcc.v2),mode:'full',now}).task;
  assert.deepEqual([repeat.added,repeat.updated,repeat.unchanged,repeat.changedEnterprises],[0,0,25,0]);
});

test('incremental uses (windowStart, windowEnd] and leaves absent rows intact',()=>{
  const state=createInitialState();
  const {task}=applyBatch(state,{sourceId:'qcc',rows:copy(DEMO_SNAPSHOTS.qcc.v2),mode:'incremental',windowStart:DEMO_METADATA.baselineAt,windowEnd:DEMO_METADATA.changedAt,now});
  assert.equal(task.processed,3); assert.equal(task.skipped,22); assert.equal(task.updated,2); assert.equal(task.added,1);
  assert.equal(state.records.length,25); assert.equal(state.rawRecords.filter(r=>r.sourceId==='tyc').length,24);
});

test('same-source old facts cannot overwrite newer values or regress cursor',()=>{
  const state=createInitialState();
  applyBatch(state,{sourceId:'qcc',rows:copy(DEMO_SNAPSHOTS.qcc.v2),mode:'full',now});
  const cursor=state.schedules.qcc.lastCursor;
  const {task}=applyBatch(state,{sourceId:'qcc',rows:copy(DEMO_SNAPSHOTS.qcc.v1),mode:'full',now});
  assert.equal(task.ignoredStale,2); assert.equal(state.records[0].registeredCapitalWan,28000);
  assert.equal(state.schedules.qcc.lastCursor,cursor);
});

test('field priority really changes materialized values and lineage; empty values fall back',()=>{
  const state=createInitialState(),first=state.records[0];
  assert.equal(first.registeredCapitalWan,26000);
  state.priorities.registeredCapitalWan=['tyc','qcc','file']; recomputeRecords(state,{now});
  assert.equal(state.records[0].registeredCapitalWan,25500);
  assert.equal(getLineage(state,first.id,'registeredCapitalWan').selected.sourceId,'tyc');
  const row=copy(DEMO_SNAPSHOTS.tyc.v1[0]); row.regCapital=null; row.updateTime=DEMO_METADATA.changedAt;
  applyBatch(state,{sourceId:'tyc',rows:[row],mode:'incremental',now});
  assert.equal(state.records[0].registeredCapitalWan,26000);
  const lineage=getLineage(state,first.id,'registeredCapitalWan');
  assert.equal(lineage.candidates[0].empty,true); assert.equal(lineage.selected.sourceId,'qcc');
});

test('full update with a shorter returned list does not delete another source or unreturned enterprise',()=>{
  const state=createInitialState();
  applyBatch(state,{sourceId:'qcc',rows:[copy(DEMO_SNAPSHOTS.qcc.v1[0])],mode:'full',now});
  assert.equal(state.records.length,24); assert.equal(state.rawRecords.length,72);
});

test('duplicates dedupe by source/code and retain latest timestamp',()=>{
  const state=createInitialState({seed:false}),old=copy(DEMO_SNAPSHOTS.qcc.v1[0]),fresh=copy(DEMO_SNAPSHOTS.qcc.v2[0]);
  const {task}=applyBatch(state,{sourceId:'qcc',rows:[fresh,old,fresh],mode:'full',now});
  assert.equal(task.duplicates,2); assert.equal(task.processed,1); assert.equal(task.added,1);
  assert.equal(state.records[0].registeredCapitalWan,28000);
});

test('malformed row is isolated, logged and prevents advancing source cursor past errors',()=>{
  const state=createInitialState({seed:false}),bad=copy(DEMO_SNAPSHOTS.qcc.v1[1]); bad.CreditCode='';
  const {task}=applyBatch(state,{sourceId:'qcc',rows:[copy(DEMO_SNAPSHOTS.qcc.v1[0]),bad],mode:'full',now});
  assert.equal(task.status,'partial'); assert.equal(task.failed,1); assert.equal(task.added,1);
  assert.equal(state.records.length,1); assert.equal(task.errors[0].row,2); assert.equal(state.schedules.qcc.lastCursor,null);
});

test('unpublished conversion script blocks the batch before any data writes',()=>{
  const state=createInitialState({seed:false}); state.scripts[0].status='draft';
  assert.equal(validateMappings(state,'qcc').valid,false);
  assert.throws(()=>applyBatch(state,{sourceId:'qcc',rows:copy(DEMO_SNAPSHOTS.qcc.v1),mode:'full',now}),/未发布/);
  assert.equal(state.records.length,0); assert.equal(state.tasks.length,0);
});

test('custom script runner receives script and context, and published version is traceable',()=>{
  const state=createInitialState({seed:false});
  state.scripts.push({id:'custom_capital',name:'自定义金额',version:2,status:'published',code:'return Number(value)/10000;'});
  state.mappings.qcc.find(m=>m.targetField==='registeredCapitalWan').scriptId='custom_capital';
  const runScript=(script,value,context)=>script.id==='custom_capital'?(assert.equal(context.targetField,'registeredCapitalWan'),Number(value)/10000):runBuiltinScript(script,value);
  applyBatch(state,{sourceId:'qcc',rows:[copy(DEMO_SNAPSHOTS.qcc.v1[0])],runScript,now});
  assert.equal(state.records[0].registeredCapitalWan,26000);
  assert.deepEqual(getLineage(state,state.records[0].id,'registeredCapitalWan').selected.script,{id:'custom_capital',version:2});
});

test('script row errors are reported without corrupting existing data',()=>{
  const state=createInitialState(),before=state.records[0].registeredCapitalWan;
  const row=copy(DEMO_SNAPSHOTS.qcc.v2[0]); row.RegistCapi='不是金额';
  const {task}=applyBatch(state,{sourceId:'qcc',rows:[row],now});
  assert.equal(task.failed,1); assert.equal(task.status,'failed'); assert.equal(state.records[0].registeredCapitalWan,before);
});

test('all five filter dimensions are combined with AND, and same dimension supports OR',()=>{
  const state=createInitialState();
  const rows=filterEnterprises(state,{regionProvince:'安徽省',industry:'电子信息',qualification:'高新技术企业',scale:'中型',chainNode:'显示模组'});
  assert.equal(rows.length,2);
  assert.ok(rows.every(r=>r.regionProvince==='安徽省'&&r.industry==='电子信息'&&r.qualifications.includes('高新技术企业')&&r.scale==='中型'&&r.chainNodes.includes('显示模组')));
  assert.equal(filterEnterprises(state,{regionProvince:'安徽省',industry:'生物医药'}).length,0);
  assert.ok(filterEnterprises(state,{regionProvince:['安徽省','江苏省']}).length>filterEnterprises(state,{regionProvince:'安徽省'}).length);
});

test('exact query accepts full name or code and rejects partial-name matches',()=>{
  const state=createInitialState(),record=state.records[0];
  assert.equal(exactQuery(state,record.enterpriseName).record.id,record.id);
  assert.equal(exactQuery(state,` ${record.creditCode.toLowerCase()} `).record.id,record.id);
  assert.equal(exactQuery(state,'星澜').status,'not_found'); assert.equal(exactQuery(state,'').status,'invalid');
});

test('service log persists actual criteria and result counts without mutating queries automatically',()=>{
  const state=createInitialState(); filterEnterprises(state,{}); exactQuery(state,state.records[0].creditCode);
  assert.equal(state.serviceLogs.length,0);
  const log=recordServiceCall(state,{type:'batch_filter',filters:{regionProvince:'安徽省'},resultCount:8,now});
  assert.equal(state.serviceLogs[0].id,log.id); assert.equal(log.resultCount,8);
});

test('JSON persistence can restore all data, settings, logs and recompute consistently',()=>{
  const state=createInitialState(); state.priorities.legalPerson=['tyc','qcc','file']; recomputeRecords(state,{now});
  const restored=JSON.parse(JSON.stringify(state)); recomputeRecords(restored,{now});
  assert.equal(restored.records[0].legalPerson,'演示法人01乙'); assert.equal(restored.records.length,24);
  assert.equal(getLineage(restored,restored.records[0].id,'legalPerson').selected.sourceId,'tyc');
});

test('date conversion validates calendar days and normalizes timestamps using China business date',()=>{
  const script={id:'date_iso'};
  assert.equal(runBuiltinScript(script,'2021/03/15'),'2021-03-15');
  assert.equal(runBuiltinScript(script,Date.parse('2021-03-15T00:00:00+08:00')),'2021-03-15');
  assert.throws(()=>runBuiltinScript(script,'2021/02/31'),/日期/);
});

test('lineage retains the mapping actually applied instead of displaying unsynchronized configuration',()=>{
  const state=createInitialState();
  state.mappings.qcc.find(m=>m.targetField==='legalPerson').sourceField='futureOperName';
  recomputeRecords(state,{now});
  assert.equal(getLineage(state,state.records[0].id,'legalPerson').selected.rawField,'OperName');
});

test('QCC amount strings honor explicit yuan/wan/yi units while unitless numbers retain yuan semantics',()=>{
  const script={id:'yuan_to_wan'};
  assert.equal(runBuiltinScript(script,1000000),100);
  assert.equal(runBuiltinScript(script,'1000000'),100);
  assert.equal(runBuiltinScript(script,'100万元人民币'),100);
  assert.equal(runBuiltinScript(script,'人民币1.25亿元'),12500);
  assert.equal(runBuiltinScript(script,'1,000万元'),1000);
  assert.equal(runBuiltinScript(script,'50000元'),5);
});

test('TYC registered capital has its own published script and imports actual string-shaped amounts',()=>{
  const state=createInitialState({seed:false});
  const mapping=state.mappings.tyc.find(m=>m.targetField==='registeredCapitalWan');
  assert.equal(mapping.scriptId,'capital_to_wan');
  assert.equal(state.scripts.find(s=>s.id===mapping.scriptId).status,'published');
  const rows=copy(DEMO_SNAPSHOTS.tyc.v1.slice(0,2));
  rows[0].regCapital='100万元人民币'; rows[1].regCapital='0.5亿元';
  const {task}=applyBatch(state,{sourceId:'tyc',rows,now});
  assert.equal(task.failed,0); assert.equal(state.records[0].registeredCapitalWan,100); assert.equal(state.records[1].registeredCapitalWan,5000);
  assert.equal(runBuiltinScript({id:'capital_to_wan'},1200),1200);
});

test('unknown currencies and ambiguous text fail without automatic exchange conversion',()=>{
  for(const id of ['yuan_to_wan','capital_to_wan']) {
    for(const value of ['100万美元','100万港元','USD100万','约100万元','100人民币','待定',-1,Infinity]) assert.throws(()=>runBuiltinScript({id},value),/金额/);
    assert.equal(runBuiltinScript({id},null),null);
    assert.equal(runBuiltinScript({id},'100万RMB'),100);
  }
});

test('published amount script code matches built-in parsing for all supported shapes',()=>{
  const state=createInitialState({seed:false});
  for(const id of ['yuan_to_wan','capital_to_wan']) {
    const script=state.scripts.find(s=>s.id===id);
    const managedScript=new Function('value',script.code);
    for(const value of [0,1200000,'100万元人民币','人民币1.2亿元','50000元','1,000.25万元','100万RMB','1200000',null,'']) assert.equal(managedScript(value),runBuiltinScript(script,value));
    assert.throws(()=>managedScript('100万美元'),/币种/);
  }
});

test('official QCC/TYC update fields normalize seconds, milliseconds and China-local date strings',()=>{
  const expected='2026-10-27T01:30:00.000Z',epoch=Date.parse(expected);
  const variants=[
    ['qcc','UpdatedDate','2026-10-27 09:30:00'],
    ['qcc','UpdatedDate',epoch/1000],
    ['tyc','updateTimes',String(epoch)],
    ['tyc','updateTimes',epoch/1000],
    ['tyc','updatetime',String(epoch/1000)],
    ['tyc','updatetime','2026/10/27 09:30:00'],
  ];
  for(const [sourceId,field,time] of variants) {
    const state=createInitialState({seed:false}),row=copy(DEMO_SNAPSHOTS[sourceId].v1[0]);
    delete row.UpdatedAt; delete row.updateTime;
    row[field]=time; row._updatedAt='2026-10-28T09:00:00+08:00';
    const {task}=applyBatch(state,{sourceId,rows:[row],now:'2026-10-28T10:00:00+08:00'});
    assert.equal(task.failed,0,`${sourceId}.${field}`);
    assert.equal(state.rawRecords[0].sourceUpdatedAt,expected);
    assert.equal(state.rawRecords[0].sourceTimeAssumed,false);
    assert.equal(state.rawRecords[0].sourceTimeField,field);
    assert.equal(state.rawRecords[0].ingestedAt,'2026-10-28T02:00:00.000Z');
    assert.equal(state.schedules[sourceId].lastCursor,expected);
  }
});

test('a later collection cannot make an older official source snapshot overwrite newer facts',()=>{
  for(const [sourceId,field] of [['qcc','UpdatedDate'],['tyc','updateTimes'],['tyc','updatetime']]) {
    const state=createInitialState({seed:false}),fresh=copy(DEMO_SNAPSHOTS[sourceId].v2[0]),old=copy(DEMO_SNAPSHOTS[sourceId].v1[0]);
    for(const row of [fresh,old]) {delete row.UpdatedAt;delete row.updateTime;}
    fresh[field]='2026-10-27 09:30:00'; old[field]=Date.parse('2026-10-26T09:00:00+08:00')/1000;
    applyBatch(state,{sourceId,rows:[fresh],now});
    const capital=state.records[0].registeredCapitalWan,cursor=state.schedules[sourceId].lastCursor;
    old._updatedAt='2026-10-29T10:00:00+08:00';
    const {task}=applyBatch(state,{sourceId,rows:[old],now:'2026-10-29T10:00:00+08:00'});
    assert.equal(task.ignoredStale,1); assert.equal(state.records[0].registeredCapitalWan,capital);
    assert.equal(state.schedules[sourceId].lastCursor,cursor);
  }
});

test('unknown source time stays explicitly assumed and cannot replace dated data or advance a change cursor',()=>{
  const state=createInitialState(),row=copy(DEMO_SNAPSHOTS.qcc.v2[0]); delete row.UpdatedAt;
  row._updatedAt='2026-10-29T09:00:00+08:00';
  const cursor=state.schedules.qcc.lastCursor;
  const {task}=applyBatch(state,{sourceId:'qcc',rows:[row],now:'2026-10-29T10:00:00+08:00'});
  assert.equal(task.ignoredUnknownTime,1); assert.equal(state.records[0].registeredCapitalWan,26000);
  assert.equal(state.schedules.qcc.lastCursor,cursor);
  const unknown=createInitialState({seed:false});
  applyBatch(unknown,{sourceId:'qcc',rows:[row],now:'2026-10-29T10:00:00+08:00'});
  assert.equal(unknown.rawRecords[0].sourceTimeAssumed,true); assert.equal(unknown.schedules.qcc.lastCursor,null);
  const dated=copy(DEMO_SNAPSHOTS.qcc.v1[0]); dated.UpdatedDate='2026-10-27 09:30:00'; delete dated.UpdatedAt;
  applyBatch(unknown,{sourceId:'qcc',rows:[dated],now:'2026-10-30T10:00:00+08:00'});
  assert.equal(unknown.records[0].registeredCapitalWan,26000);
  assert.equal(unknown.rawRecords[0].sourceTimeAssumed,false);
  assert.equal(unknown.rawRecords[0].sourceUpdatedAt,'2026-10-27T01:30:00.000Z');
});

test('official source times drive incremental windows and invalid dates fail instead of falling back to collection time',()=>{
  const state=createInitialState({seed:false}),old=copy(DEMO_SNAPSHOTS.tyc.v1[0]),fresh=copy(DEMO_SNAPSHOTS.tyc.v1[1]);
  delete old.updateTime; delete fresh.updateTime;
  old.updatetime=Date.parse('2026-10-26T09:00:00+08:00'); fresh.updatetime=Date.parse('2026-10-27T09:30:00+08:00')/1000;
  const {task}=applyBatch(state,{sourceId:'tyc',rows:[old,fresh],mode:'incremental',windowStart:'2026-10-27T00:00:00+08:00',windowEnd:'2026-10-28T00:00:00+08:00',now});
  assert.equal(task.skipped,1); assert.equal(task.added,1); assert.equal(state.records[0].creditCode,fresh.creditCode);
  const bad=copy(DEMO_SNAPSHOTS.qcc.v1[0]); delete bad.UpdatedAt; bad.UpdatedDate='2026-02-31'; bad._updatedAt=now;
  const result=applyBatch(state,{sourceId:'qcc',rows:[bad],now}).task;
  assert.equal(result.failed,1); assert.match(result.errors[0].message,/来源更新时间/); assert.equal(state.schedules.qcc.lastCursor,null);
});
