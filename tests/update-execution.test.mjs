import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../public/prototype/core.mjs';
import {DEMO_SNAPSHOTS} from '../public/prototype/demo-data.mjs';
import {upgradeSourceState,getRequestContext} from '../public/prototype/source-config.mjs';
import {upgradeFtpSources} from '../public/prototype/ftp-sources.mjs';
import {upgradeUpdateJobs,createUpdateJob} from '../public/prototype/update-jobs.mjs';
import {executeUpdateJob} from '../public/prototype/update-execution.mjs';

const NOW='2026-10-29T08:00:00.000Z';
function workspace(){const state=upgradeSourceState(createInitialState());upgradeFtpSources(state);upgradeUpdateJobs(state,NOW);return state;}
function job(state,sourceId='qcc',extra={}){return createUpdateJob(state,{name:'更新执行验证',sourceId,mode:'incremental',frequency:'manual',time:'02:00',intervalHours:1,weekday:1,enabled:true,...extra},{now:NOW});}
const input=version=>async(_provider,_job,context)=>({rows:structuredClone(DEMO_SNAPSHOTS.qcc[version].filter(row=>!context||row.CreditCode===context.creditCode)),errors:[],live:false});

test('two jobs for one API keep independent cursors and never overwrite legacy source scheduling',async()=>{
  const state=workspace(),first=job(state),second=job(state),legacy=JSON.stringify(state.schedules.qcc);
  await executeUpdateJob(state,first.id,{loadInput:input('v2'),now:NOW});
  const firstCursor=first.lastCursor;
  const result=await executeUpdateJob(state,second.id,{loadInput:input('v1'),now:NOW});
  assert.equal(result.task.status,'success');assert.equal(result.task.skipped,0);
  assert.ok(Date.parse(second.lastCursor)<Date.parse(firstCursor));assert.equal(first.lastCursor,firstCursor);
  assert.equal(JSON.stringify(state.schedules.qcc),legacy);
});

test('API context receives this job cursor and full mode clears updatedAfter',async()=>{
  const state=workspace(),incremental=job(state),full=job(state,'qcc',{mode:'full'}),seen=[];
  const target=state.records[0];
  for(const current of [incremental,full]){current.scope={type:'list',entries:[{creditCode:target.creditCode}]};current.scopeBaselines=[`code:${target.creditCode}`];current.lastScopeTargetKeys=[`code:${target.creditCode}`];}
  incremental.lastCursor='2026-10-26T00:00:00.000Z';full.lastCursor='2026-10-27T00:00:00.000Z';
  incremental.scopeTargetCursors={[`code:${target.creditCode}`]:incremental.lastCursor};
  const loadInput=async(provider,_job,context)=>{seen.push(getRequestContext(state,provider).updatedAfter);return input('v1')(provider,_job,context);};
  await executeUpdateJob(state,incremental.id,{loadInput,now:NOW});await executeUpdateJob(state,full.id,{loadInput,now:NOW});
  assert.deepEqual(seen,['2026-10-26T00:00:00.000Z','']);
  assert.ok(Date.parse(incremental.lastCursor)>=Date.parse('2026-10-26T00:00:00.000Z'));assert.equal(full.lastCursor,'2026-10-27T00:00:00.000Z');
});

test('partial API fetch failure preserves job checkpoint while retaining successfully processed rows',async()=>{
  const state=workspace(),taskJob=job(state),legacy=JSON.stringify(state.schedules.qcc);
  const added=DEMO_SNAPSHOTS.qcc.v2.at(-1),failed=state.records[0];taskJob.scope={type:'list',entries:[{creditCode:added.CreditCode},{creditCode:failed.creditCode}]};
  taskJob.lastCursor='2026-10-26T00:00:00.000Z';const count=state.records.length;
  const result=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async(_provider,_job,context)=>context.creditCode===failed.creditCode?{rows:[],errors:[{row:99,stage:'fetch',message:'模拟部分请求失败'}],live:true}:{rows:[structuredClone(added)],errors:[],live:true}});
  assert.equal(result.task.status,'partial');assert.equal(result.task.failed,1);assert.ok(state.records.length>count);
  assert.equal(taskJob.lastCursor,'2026-10-26T00:00:00.000Z');assert.equal(JSON.stringify(state.schedules.qcc),legacy);
});

test('preparation failure records an attempt and schedules the next time without cursor advancement',async()=>{
  const state=workspace(),taskJob=job(state,'qcc',{frequency:'daily',time:'02:15'}),legacy=JSON.stringify(state.schedules.qcc);
  const result=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async()=>{throw new Error('接口配置校验失败');}});
  assert.equal(result.task.status,'failed');assert.equal(taskJob.lastRunStatus,'failed');assert.equal(taskJob.runCount,1);
  assert.equal(taskJob.lastCursor,null);assert.ok(Date.parse(taskJob.nextRunAt)>Date.parse(NOW));
  assert.equal(state.tasks[0].jobId,taskJob.id);assert.equal(JSON.stringify(state.schedules.qcc),legacy);
});

test('FTP jobs process their own directory window despite source-level successful file receipts',async()=>{
  const state=workspace(),source=state.providers.find(p=>p.type==='ftp'),first=job(state,source.id),second=job(state,source.id);
  const one=await executeUpdateJob(state,first.id,{now:NOW});const firstCursor=first.lastCursor;
  assert.equal(one.task.failed,0);assert.ok(state.ftpFileReceipts.length);
  const two=await executeUpdateJob(state,second.id,{now:NOW});assert.equal(two.task.failed,0);assert.equal(two.task.received,one.task.received);
  const again=await executeUpdateJob(state,first.id,{now:NOW});assert.equal(again.task.received,0);assert.equal(first.lastCursor,firstCursor);
  assert.equal(state.ftpImports[0].jobId,second.id);
});

test('paused task refuses execution without generating an attempt',async()=>{
  const state=workspace(),taskJob=job(state,'qcc',{enabled:false}),before=JSON.stringify(state);
  await assert.rejects(executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:input('v2')}),/暂停/);
  assert.equal(JSON.stringify(state),before);
});

test('all scope only requests existing enterprises, freezes identities before fetch, and does not expand to vendor catalog',async()=>{
  const state=workspace(),taskJob=job(state),original=state.records.map(record=>record.creditCode),seen=[];
  taskJob.scope={type:'all'};
  const result=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async(provider,current,context)=>{
    seen.push(context.creditCode);
    if(seen.length===1){current.scope={type:'list',entries:[]};state.records.push({...state.records[0],id:'outside',creditCode:'91340100123456789X'});}
    return input('v2')(provider,current,context);
  }});
  assert.deepEqual(seen,original);assert.equal(result.task.scopeSnapshot.total,original.length);assert.equal(result.task.requested,original.length);
  assert.equal(result.task.targetResults.length,original.length);assert.equal(result.task.status,'success');assert.equal(state.records.some(record=>record.creditCode===DEMO_SNAPSHOTS.qcc.v2.at(-1).CreditCode),false);
});

test('new list targets are fetched in full despite an advanced job cursor, then use their own successful cursor',async()=>{
  const state=workspace(),taskJob=job(state),unknown=structuredClone(DEMO_SNAPSHOTS.qcc.v1[0]),seen=[];
  unknown.CreditCode='91340100123456789X';unknown.Name='新纳入企业有限公司';taskJob.lastCursor='2026-10-28T00:00:00.000Z';
  taskJob.scope={type:'list',entries:[{creditCode:unknown.CreditCode,enterpriseName:unknown.Name}]};
  const loadInput=async(_provider,_job,context)=>{seen.push({...context});assert.equal(context.keyword,unknown.CreditCode);return {rows:[unknown],errors:[],live:false};};
  const first=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput});
  assert.equal(first.task.status,'success');assert.equal(seen[0].updatedAfter,'');assert.equal(seen[0].baseline,true);assert.ok(state.records.some(record=>record.creditCode===unknown.CreditCode));
  assert.equal(taskJob.lastCursor,'2026-10-28T00:00:00.000Z');
  const second=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput});
  assert.equal(seen[1].baseline,false);assert.equal(seen[1].updatedAfter,new Date(unknown.UpdatedAt).toISOString());assert.equal(second.task.skipped,1);
});

test('name-only unknown targets are resolved by the API without importing list fields and ambiguity is rejected',async()=>{
  const state=workspace(),taskJob=job(state),row=structuredClone(DEMO_SNAPSHOTS.qcc.v1[0]);row.Name='全称精准查询新增有限公司';row.CreditCode='91340100123456789X';
  taskJob.scope={type:'list',entries:[{enterpriseName:row.Name}]};
  const result=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async(_provider,_job,context)=>{assert.equal(context.creditCode,'');assert.equal(context.keyword,row.Name);assert.equal(state.records.some(record=>record.creditCode===row.CreditCode),false);return {rows:[row],errors:[],live:true};}});
  assert.equal(result.task.status,'success');assert.equal(state.records.find(record=>record.creditCode===row.CreditCode).registeredCapitalWan,row.RegistCapi/10000);assert.ok(taskJob.scopeBaselines.includes(`code:${row.CreditCode}`));
  const other=job(state);other.scope={type:'list',entries:[{enterpriseName:'同名新企业有限公司'}]};const before=state.records.length;
  const rejected=await executeUpdateJob(state,other.id,{now:NOW,loadInput:async()=>({rows:[{...row,Name:'同名新企业有限公司',CreditCode:'91340100123456788X'},{...row,Name:'同名新企业有限公司',CreditCode:'91340100123456787X'}],errors:[],live:true})});
  assert.equal(rejected.task.status,'failed');assert.match(rejected.task.errors[0].message,/多个信用代码/);assert.equal(state.records.length,before);
});

test('a task rejects unselected API response identities and never advances its checkpoint',async()=>{
  const state=workspace(),taskJob=job(state);taskJob.scope={type:'list',entries:[{creditCode:state.records[0].creditCode}]};taskJob.lastCursor='2026-10-26T00:00:00.000Z';
  const before=JSON.stringify(state.rawRecords);
  const result=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async()=>({rows:structuredClone(DEMO_SNAPSHOTS.qcc.v2),errors:[],live:true})});
  assert.equal(result.task.status,'failed');assert.match(result.task.errors[0].message,/任务目标之外/);assert.equal(taskJob.lastCursor,'2026-10-26T00:00:00.000Z');assert.equal(JSON.stringify(state.rawRecords),before);assert.deepEqual(taskJob.scopeBaselines,[]);
});

test('a target that leaves and re-enters a changing filter is collected in full again',async()=>{
  const state=workspace(),taskJob=job(state),first=state.records[0],second=state.records[1],contexts=[];
  const run=async target=>{taskJob.scope={type:'list',entries:[{creditCode:target.creditCode}]};return executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async(provider,current,context)=>{contexts.push(context);return input('v2')(provider,current,context);}});};
  await run(first);await run(first);await run(second);await run(first);
  assert.equal(contexts[0].baseline,true);assert.equal(contexts[1].baseline,false);assert.equal(contexts[2].baseline,true);assert.equal(contexts[3].baseline,true);assert.equal(contexts[3].updatedAfter,'');
});

test('failed baseline stays pending while successful targets retain independent progress for retry',async()=>{
  const state=workspace(),taskJob=job(state),first=state.records[0],second=state.records[1],seen=[];taskJob.scope={type:'list',entries:[{creditCode:first.creditCode},{creditCode:second.creditCode}]};taskJob.lastCursor='2026-10-25T00:00:00.000Z';
  const initial=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async(provider,current,context)=>{if(context.creditCode===second.creditCode)throw new Error('厂商超时');return input('v2')(provider,current,context);}});
  assert.equal(initial.task.status,'partial');assert.equal(taskJob.lastCursor,'2026-10-25T00:00:00.000Z');assert.ok(taskJob.scopeBaselines.includes(`code:${first.creditCode}`));assert.ok(!taskJob.scopeBaselines.includes(`code:${second.creditCode}`));
  await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async(provider,current,context)=>{seen.push(context);return input('v2')(provider,current,context);}});
  assert.equal(seen[0].baseline,false);assert.equal(seen[1].baseline,true);assert.equal(seen[1].updatedAfter,'');assert.ok(Date.parse(taskJob.lastCursor)>Date.parse('2026-10-25T00:00:00.000Z'));
});

test('empty all/filtered scopes do not fall back to a default keyword request; subset full update does not delete others',async()=>{
  const state=workspace(),taskJob=job(state),count=state.records.length;taskJob.scope={type:'filters',filters:{industries:['不存在行业']}};
  const empty=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async()=>{throw new Error('不应请求');}});
  assert.equal(empty.task.status,'success');assert.equal(empty.task.requested,0);assert.equal(taskJob.lastCursor,null);
  const full=job(state,'qcc',{mode:'full'});full.scope={type:'list',entries:[{creditCode:state.records[0].creditCode}]};
  const result=await executeUpdateJob(state,full.id,{now:NOW,loadInput:input('v2')});assert.equal(result.task.status,'success');assert.equal(state.records.length,count);assert.equal(result.task.scopeSnapshot.total,1);
});

test('legacy single-list sources reject every enterprise task scope before making a request',async()=>{
  for(const scope of [{type:'all'},{type:'filters',filters:{industries:['电子信息']}},{type:'list',entries:[{creditCode:'91340100123456789X'}]}]){
    const state=workspace(),taskJob=job(state);taskJob.scope=scope;taskJob.lastCursor='2026-10-25T00:00:00.000Z';state.providers.find(provider=>provider.id==='qcc').requestScope='single';
    const before=JSON.stringify(state.rawRecords);let called=false;
    const result=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async()=>{called=true;return {rows:[],errors:[]};}});
    assert.equal(called,false);assert.equal(result.task.status,'failed');assert.match(result.task.errors[0].message,/列表接口/);assert.equal(taskJob.lastCursor,'2026-10-25T00:00:00.000Z');assert.equal(JSON.stringify(state.rawRecords),before);
  }
});

test('a successful response without a source timestamp never borrows another target cursor',async()=>{
  const state=workspace(),taskJob=job(state),row=structuredClone(DEMO_SNAPSHOTS.qcc.v1[0]);row.CreditCode='91340100123456789X';row.Name='来源时间缺失企业有限公司';delete row.UpdatedAt;
  taskJob.scope={type:'list',entries:[{creditCode:row.CreditCode}]};taskJob.lastCursor='2026-10-28T00:00:00.000Z';const contexts=[];
  const loadInput=async(_provider,_job,context)=>{contexts.push(context);return {rows:[row],errors:[],live:true};};
  await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput});await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput});
  assert.equal(contexts[0].baseline,true);assert.equal(contexts[1].baseline,true);assert.equal(contexts[1].updatedAfter,'');assert.equal(taskJob.scopeTargetCursors[`code:${row.CreditCode}`],undefined);assert.equal(taskJob.lastCursor,'2026-10-28T00:00:00.000Z');
});

test('target identity is verified after its published conversion script and executes that conversion once',async()=>{
  const state=workspace(),taskJob=job(state),target=state.records[0],row=structuredClone(DEMO_SNAPSHOTS.qcc.v1[0]);row.CreditCode={value:target.creditCode};
  state.scripts.push({id:'identity_extract',name:'身份字段提取',version:1,status:'published',code:'return value.value;'});state.mappings.qcc.find(mapping=>mapping.targetField==='creditCode').scriptId='identity_extract';taskJob.scope={type:'list',entries:[{creditCode:target.creditCode}]};let identityCalls=0;
  const {runBuiltinScript}=await import('../public/prototype/core.mjs');
  const result=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async()=>({rows:[row],errors:[],live:true}),runScript:async()=>(script,value,context)=>{if(script.id==='identity_extract'){identityCalls++;return value.value;}return runBuiltinScript(script,value,context);}});
  assert.equal(result.task.status,'success');assert.equal(identityCalls,1);assert.equal(result.task.targetResults[0].creditCode,target.creditCode);
});

test('trusted prepared identity conversions are reused without running the script preprocessing again',async()=>{
  const state=workspace(),taskJob=job(state),target=state.records[0],row=structuredClone(DEMO_SNAPSHOTS.qcc.v1[0]);row.CreditCode={value:target.creditCode};
  state.scripts.push({id:'identity_extract',name:'身份字段提取',version:1,status:'published',code:'return value.value;'});state.mappings.qcc.find(mapping=>mapping.targetField==='creditCode').scriptId='identity_extract';taskJob.scope={type:'list',entries:[{creditCode:target.creditCode}]};let preparedCalls=0,preprocessCalls=0;
  const {runBuiltinScript}=await import('../public/prototype/core.mjs');
  const preparedRunner=(script,value,context)=>{assert.equal(context.row,row);if(script.id==='identity_extract'){preparedCalls++;return target.creditCode;}return runBuiltinScript(script,value,context);};
  const result=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async()=>({rows:[row],errors:[],live:false,preparedRunner}),runScript:async()=>{preprocessCalls++;throw new Error('不得重复加工脚本');}});
  assert.equal(result.task.status,'success');assert.equal(preprocessCalls,0);assert.equal(preparedCalls,1);assert.equal(result.task.targetResults[0].creditCode,target.creditCode);
});
