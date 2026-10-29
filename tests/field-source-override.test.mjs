import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,applyBatch,recomputeRecords,getLineage,setFieldSourceOverride,clearFieldSourceOverride} from '../public/prototype/core.mjs';
import {DEMO_SNAPSHOTS} from '../public/prototype/demo-data.mjs';
import {upgradeApiServices,runApiService} from '../public/prototype/api-services.mjs';
import {querySqlRecords} from '../public/prototype/sql-services.mjs';
import {createSubscription,publishSubscription,simulateSubscriptionDelivery} from '../public/prototype/subscription-services.mjs';

const copy=value=>JSON.parse(JSON.stringify(value));
const time='2026-10-29T01:00:00.000Z';
const first=state=>state.records.find(record=>record.creditCode==='DEMO-CN-000001');
const tycRow=(change={},at=time)=>({...copy(DEMO_SNAPSHOTS.tyc.v1[0]),...change,updateTime:at});

test('manual field source overrides global ranking for one enterprise without rewriting source data',()=>{
  const state=createInitialState(),record=first(state),beforeRaw=JSON.stringify(state.rawRecords),version=state.dataVersion;
  const lineage=setFieldSourceOverride(state,record.id,'registeredCapitalWan','tyc',{now:time});
  assert.equal(first(state).registeredCapitalWan,25500);assert.equal(lineage.selected.sourceId,'tyc');assert.equal(lineage.manualRequested,true);assert.equal(lineage.manualApplied,true);assert.equal(lineage.fallback,false);assert.equal(lineage.selectionMode,'manual');
  assert.deepEqual(state.fieldSourceOverrides[record.id].registeredCapitalWan,{sourceId:'tyc',updatedAt:time});assert.equal(state.dataVersion,version+1);assert.equal(JSON.stringify(state.rawRecords),beforeRaw);
  state.priorities.registeredCapitalWan=['qcc','file','tyc'];recomputeRecords(state,{now:time});assert.equal(first(state).registeredCapitalWan,25500);assert.match(getLineage(state,record.id,'registeredCapitalWan').rule,/不受全局信源排序影响/);
  assert.ok(state.records.filter(other=>other.id!==record.id).every(other=>other.lineage.registeredCapitalWan.selected.sourceId==='qcc'));
  assert.equal(first(state).legalPerson,'演示法人01');
});

test('manual source follows its latest data, falls back on empty values and automatically recovers',()=>{
  const state=createInitialState(),id=first(state).id;setFieldSourceOverride(state,id,'registeredCapitalWan','tyc',{now:time});
  applyBatch(state,{sourceId:'tyc',rows:[tycRow({regCapital:30000})],now:time});assert.equal(first(state).registeredCapitalWan,30000);
  applyBatch(state,{sourceId:'tyc',rows:[tycRow({regCapital:null},'2026-10-29T02:00:00Z')],now:'2026-10-29T02:00:00Z'});
  const fallback=getLineage(state,id,'registeredCapitalWan');assert.equal(first(state).registeredCapitalWan,26000);assert.equal(fallback.manualRequested,true);assert.equal(fallback.manualApplied,false);assert.equal(fallback.requestedSourceId,'tyc');assert.equal(fallback.fallback,true);assert.equal(fallback.selectionMode,'auto_fallback');assert.match(fallback.fallbackReason,/为空/);assert.match(fallback.rule,/保留手动/);
  applyBatch(state,{sourceId:'tyc',rows:[tycRow({regCapital:31000},'2026-10-29T03:00:00Z')],now:'2026-10-29T03:00:00Z'});
  assert.equal(first(state).registeredCapitalWan,31000);assert.equal(getLineage(state,id,'registeredCapitalWan').manualApplied,true);assert.equal(getLineage(state,id,'registeredCapitalWan').fallback,false);
});

test('zero and whole-array values are valid manual choices and different fields stay independent',()=>{
  const state=createInitialState(),id=first(state).id;applyBatch(state,{sourceId:'tyc',rows:[tycRow({regCapital:0})],now:time});
  setFieldSourceOverride(state,id,'registeredCapitalWan','tyc',{now:time});assert.equal(first(state).registeredCapitalWan,0);
  setFieldSourceOverride(state,id,'qualifications','file',{now:time});assert.deepEqual(first(state).qualifications,DEMO_SNAPSHOTS.file.v1[0]['企业资质'].split('；'));
  clearFieldSourceOverride(state,id,'registeredCapitalWan',{now:time});assert.equal(first(state).registeredCapitalWan,26000);assert.equal(getLineage(state,id,'qualifications').manualApplied,true);
});

test('clearing restores current global ranking and clearing an unpinned field is a complete no-op',()=>{
  const state=createInitialState(),id=first(state).id;const before=JSON.stringify(state);clearFieldSourceOverride(state,id,'legalPerson',{now:time});assert.equal(JSON.stringify(state),before);
  setFieldSourceOverride(state,id,'registeredCapitalWan','tyc',{now:time});const version=state.dataVersion;
  clearFieldSourceOverride(state,id,'registeredCapitalWan',{now:time});assert.equal(first(state).registeredCapitalWan,26000);assert.equal(state.dataVersion,version+1);assert.equal(state.fieldSourceOverrides[id],undefined);
  const lineage=getLineage(state,id,'registeredCapitalWan');assert.equal(lineage.manualRequested,false);assert.equal(lineage.override,null);assert.equal(lineage.selectionMode,'auto');
  const cleared=JSON.stringify(state);clearFieldSourceOverride(state,id,'registeredCapitalWan',{now:time});assert.equal(JSON.stringify(state),cleared);
});

test('manual selection intent and metadata survive JSON persistence and old workspaces work without migration',()=>{
  const state=createInitialState(),id=first(state).id;delete state.fieldSourceOverrides;
  assert.equal(getLineage(state,id,'registeredCapitalWan').manualRequested,false);setFieldSourceOverride(state,id,'registeredCapitalWan','tyc',{now:time});
  const loaded=JSON.parse(JSON.stringify(state));recomputeRecords(loaded,{now:time});assert.equal(first(loaded).registeredCapitalWan,25500);assert.deepEqual(getLineage(loaded,id,'registeredCapitalWan').override,{sourceId:'tyc',updatedAt:time});
  clearFieldSourceOverride(loaded,id,'registeredCapitalWan',{now:time});assert.equal(first(loaded).registeredCapitalWan,26000);
  delete loaded.fieldSourceOverrides;const before=JSON.stringify(loaded);clearFieldSourceOverride(loaded,id,'registeredCapitalWan',{now:time});assert.equal(JSON.stringify(loaded),before);
  delete loaded.records[0].lineage.legalPerson.manualRequested;assert.equal(getLineage(loaded,loaded.records[0].id,'legalPerson').manualRequested,false);
});

test('invalid enterprise, field, source, candidate or time cannot partially change state',()=>{
  const state=createInitialState(),id=first(state).id;
  for(const [recordId,field,sourceId,options] of [
    ['missing','legalPerson','tyc',{}],[id,'unknown','tyc',{}],[id,'__proto__','tyc',{}],[id,'legalPerson','missing',{}],[id,'legalPerson','file',{}],[id,'legalPerson',null,{}],[id,'legalPerson','tyc',{now:'not-a-date'}],
  ]){const before=JSON.stringify(state);assert.throws(()=>setFieldSourceOverride(state,recordId,field,sourceId,options));assert.equal(JSON.stringify(state),before);}
  applyBatch(state,{sourceId:'tyc',rows:[tycRow({legalPersonName:'   '})],now:time});const before=JSON.stringify(state);assert.throws(()=>setFieldSourceOverride(state,id,'legalPerson','tyc'),/为空/);assert.equal(JSON.stringify(state),before);
  assert.throws(()=>clearFieldSourceOverride(state,'missing','legalPerson'));assert.throws(()=>clearFieldSourceOverride(state,id,'unknown'));assert.equal(JSON.stringify(state),before);
});

test('manual credit-code selection stays on the same entity and rejects inconsistent identity candidates',()=>{
  const state=createInitialState(),id=first(state).id,code=first(state).creditCode;setFieldSourceOverride(state,id,'creditCode','tyc',{now:time});assert.equal(first(state).id,id);assert.equal(first(state).creditCode,code);
  clearFieldSourceOverride(state,id,'creditCode',{now:time});const raw=state.rawRecords.find(record=>record.recordId===id&&record.sourceId==='tyc');raw.values.creditCode='DEMO-CN-999999';
  const before=JSON.stringify(state);assert.throws(()=>setFieldSourceOverride(state,id,'creditCode','tyc'),/身份不一致/);assert.equal(JSON.stringify(state),before);
  recomputeRecords(state,{now:time});assert.equal(first(state).id,id);assert.equal(getLineage(state,id,'creditCode').candidates.find(candidate=>candidate.sourceId==='tyc').valid,false);
});

test('missing candidate or provider falls back while keeping a recoverable manual preference',()=>{
  const state=createInitialState(),id=first(state).id;setFieldSourceOverride(state,id,'legalPerson','tyc',{now:time});
  const raw=state.rawRecords.find(record=>record.recordId===id&&record.sourceId==='tyc');state.rawRecords=state.rawRecords.filter(record=>record!==raw);recomputeRecords(state,{now:time});
  assert.equal(first(state).legalPerson,'演示法人01');assert.equal(getLineage(state,id,'legalPerson').fallback,true);assert.match(getLineage(state,id,'legalPerson').fallbackReason,/尚无/);
  state.rawRecords.push(raw);const provider=state.providers.find(value=>value.id==='tyc');state.providers=state.providers.filter(value=>value!==provider);recomputeRecords(state,{now:time});assert.match(getLineage(state,id,'legalPerson').fallbackReason,/不存在/);
  state.providers.push(provider);recomputeRecords(state,{now:time});assert.equal(first(state).legalPerson,'演示法人01乙');assert.equal(getLineage(state,id,'legalPerson').manualApplied,true);
});

test('a pinned field with no remaining nonempty value stays missing and keeps intent until recovery',()=>{
  const state=createInitialState(),id=first(state).id;setFieldSourceOverride(state,id,'legalPerson','tyc',{now:time});
  for(const raw of state.rawRecords.filter(record=>record.recordId===id))if(Object.hasOwn(raw.values,'legalPerson'))raw.values.legalPerson=null;
  recomputeRecords(state,{now:time});const lineage=getLineage(state,id,'legalPerson');assert.equal(first(state).legalPerson,null);assert.equal(lineage.selected,null);assert.equal(lineage.fallback,true);assert.match(lineage.rule,/无有效非空候选/);assert.equal(state.fieldSourceOverrides[id].legalPerson.sourceId,'tyc');
});

test('API, SQL and incremental subscription read the new materialized manual value',()=>{
  const state=createInitialState(),id=first(state).id,code=first(state).creditCode;upgradeApiServices(state);state.apiServices.find(service=>service.id==='query').status='published';
  const subscription=createSubscription(state,{name:'企业字段订阅',description:'',webhookUrl:'https://example.com/hook',frequency:'manual',mode:'incremental',filters:{industries:[],regions:[],qualifications:[]}});publishSubscription(state,subscription.id);simulateSubscriptionDelivery(state,subscription.id);
  setFieldSourceOverride(state,id,'legalPerson','tyc',{now:time});
  assert.equal(runApiService(state,'query',{keyword:code}).body.data.record.legalPerson,'演示法人01乙');
  assert.equal(querySqlRecords(state.records,'SELECT legalPerson FROM enterprises WHERE creditCode = :code',{code}).rows[0].legalPerson,'演示法人01乙');
  const delivery=simulateSubscriptionDelivery(state,subscription.id);assert.equal(delivery.delivery.changeCount,1);assert.equal(delivery.delivery.payload.changes[0].record.legalPerson,'演示法人01乙');
});
