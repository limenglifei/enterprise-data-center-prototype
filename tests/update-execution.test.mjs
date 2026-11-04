import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../public/prototype/core.mjs';
import {upgradeFtpSources} from '../public/prototype/ftp-sources.mjs';
import {upgradeUpdateJobs,createUpdateJob} from '../public/prototype/update-jobs.mjs';
import {executeUpdateJob} from '../public/prototype/update-execution.mjs';
const NOW='2026-11-04T08:00:00Z';
function workspace(){const state=createInitialState();upgradeFtpSources(state);upgradeUpdateJobs(state,NOW);return state;}
function job(state,extra={}){return createUpdateJob(state,{name:'文件更新执行验证',sourceId:'ftp_demo',mode:'incremental',frequency:'manual',time:'02:00',intervalHours:1,weekday:1,enabled:true,...extra},{now:NOW});}

test('FTP jobs have independent cursors and ignore another job successful file receipts',async()=>{
 const state=workspace(),first=job(state),second=job(state),legacy=JSON.stringify(state.schedules.ftp_demo);
 const one=await executeUpdateJob(state,first.id,{now:NOW});assert.equal(one.task.failed,0);assert.ok(state.ftpFileReceipts.length);const cursor=first.lastCursor;
 const two=await executeUpdateJob(state,second.id,{now:NOW});assert.equal(two.task.received,one.task.received);assert.equal(second.lastCursor,cursor);
 const again=await executeUpdateJob(state,first.id,{now:NOW});assert.equal(again.task.received,0);assert.equal(first.lastCursor,cursor);assert.equal(JSON.stringify(state.schedules.ftp_demo),legacy);
 assert.equal(state.records.length,26);assert.ok(one.task.fileNames.length);assert.equal(one.task.jobId,first.id);
});

test('full file refresh does not delete enterprises missing from its files',async()=>{
 const state=workspace(),full=job(state,{mode:'full'});const initial=state.records.map(r=>r.id);
 const result=await executeUpdateJob(state,full.id,{now:NOW});assert.equal(result.task.status,'success');assert.ok(initial.every(id=>state.records.some(r=>r.id===id)));assert.equal(result.task.scopeSnapshot,undefined);
});

test('mapping failure produces a recorded failed attempt without checkpoint advancement',async()=>{
 const state=workspace(),current=job(state,{frequency:'daily',time:'02:15'}),legacy=JSON.stringify(state.schedules.ftp_demo);state.mappings.ftp_demo.find(m=>m.targetField==='enterpriseName').sourceField='missing_name';
 const result=await executeUpdateJob(state,current.id,{now:NOW});assert.equal(result.task.status,'failed');assert.equal(current.lastRunStatus,'failed');assert.equal(current.lastCursor,null);assert.equal(current.runCount,1);assert.ok(Date.parse(current.nextRunAt)>Date.parse(NOW));assert.equal(JSON.stringify(state.schedules.ftp_demo),legacy);
});

test('partial transformation failure retains checkpoints and can retry after repair',async()=>{
 const state=workspace(),current=job(state);const result=await executeUpdateJob(state,current.id,{now:NOW,runScript:async()=> (_script,value,context)=>{if(context.row.credit_code==='DEMO-CN-000001')throw new Error('模拟加工失败');return String(value).split('；').filter(Boolean);}});
 assert.equal(result.task.status,'partial');assert.equal(current.lastCursor,null);assert.ok(result.task.failed>0);assert.equal(current.lastRunStatus,'partial');
 const retry=await executeUpdateJob(state,current.id,{now:NOW});assert.equal(retry.task.status,'success');assert.ok(current.lastCursor);
});

test('paused and non-FTP tasks cannot execute or generate an attempt',async()=>{
 const state=workspace(),paused=job(state,{enabled:false});let before=JSON.stringify(state);await assert.rejects(executeUpdateJob(state,paused.id,{now:NOW}),/暂停/);assert.equal(JSON.stringify(state),before);
 state.providers.push({id:'old_api',type:'api',enabled:true});state.updateJobs.push({...paused,id:'api_job',sourceId:'old_api',enabled:true});before=JSON.stringify(state);let calls=0;
 await assert.rejects(executeUpdateJob(state,'api_job',{now:NOW,loadInput:async()=>{calls++;return {rows:[]};}}),/FTP/);assert.equal(calls,0);assert.equal(JSON.stringify(state),before);
});
