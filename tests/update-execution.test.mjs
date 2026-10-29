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
const input=version=>async()=>({rows:structuredClone(DEMO_SNAPSHOTS.qcc[version]),errors:[],live:false});

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
  incremental.lastCursor='2026-10-26T00:00:00.000Z';full.lastCursor='2026-10-27T00:00:00.000Z';
  const loadInput=async provider=>{seen.push(getRequestContext(state,provider).updatedAfter);return {rows:[],errors:[],live:false};};
  await executeUpdateJob(state,incremental.id,{loadInput,now:NOW});await executeUpdateJob(state,full.id,{loadInput,now:NOW});
  assert.deepEqual(seen,['2026-10-26T00:00:00.000Z','']);
  assert.equal(incremental.lastCursor,'2026-10-26T00:00:00.000Z');assert.equal(full.lastCursor,'2026-10-27T00:00:00.000Z');
});

test('partial API fetch failure preserves job checkpoint while retaining successfully processed rows',async()=>{
  const state=workspace(),taskJob=job(state),legacy=JSON.stringify(state.schedules.qcc);
  taskJob.lastCursor='2026-10-26T00:00:00.000Z';const count=state.records.length;
  const result=await executeUpdateJob(state,taskJob.id,{now:NOW,loadInput:async()=>({rows:structuredClone(DEMO_SNAPSHOTS.qcc.v2),errors:[{row:99,stage:'fetch',message:'模拟部分请求失败'}],requested:25,live:true})});
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
