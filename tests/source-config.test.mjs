import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,applyBatch,setFieldSourceOverride,recomputeRecords} from '../public/prototype/core.mjs';
import {createInitialState as createFileFixture} from './fixtures/file-schema-workspace.mjs';
import {upgradeSourceState,isConfigurableSource} from '../public/prototype/source-config.mjs';
import {upgradeFtpSources,createFtpSource,importFtpFile} from '../public/prototype/ftp-sources.mjs';
import {upgradeUpdateJobs,createUpdateJob,dueUpdateJob,renderUpdateJobs,handleUpdateJobAction} from '../public/prototype/update-jobs.mjs';
import {executeUpdateJob} from '../public/prototype/update-execution.mjs';
const NOW='2026-11-04T00:00:00Z';
const upgrade=state=>{upgradeSourceState(state);upgradeFtpSources(state);upgradeUpdateJobs(state,NOW);return state;};
function historical(){
 const state=createFileFixture();for(const p of state.providers)if(p.id!=='file')p.type='api';
 state.apiServices=[{id:'retained-service',status:'published'}];state.subscriptions=[{id:'retained-subscription',status:'published'}];
 state.fieldSourceOverrides={[state.records[0].id]:{registeredCapitalWan:{sourceId:'tyc',updatedAt:NOW}}};
 state.updateJobs=[{id:'old_job',name:'历史任务',sourceId:'qcc',mode:'incremental',enabled:true,frequency:'daily',time:'02:00',nextRunAt:'2026-10-29T00:00:00Z',lastCursor:'2026-10-28T00:00:00Z',scope:{type:'all'}}];state.updateJobsVersion=1;return state;
}

test('fresh workspace seeds usable file sources, enterprise data and provenance',()=>{
 const state=upgrade(createInitialState());assert.equal(state.records.length,24);assert.ok(state.providers.every(isConfigurableSource));assert.ok(state.providers.some(p=>p.type==='ftp'));assert.ok(state.providers.some(p=>p.type==='file'));
 assert.ok(state.records.every(r=>r.lineage.enterpriseName.selected.sourceId==='ftp_qcc'));assert.ok(state.rawRecords.length>24);
});

test('legacy API migration preserves stored values, identities, raw evidence, history, pins and downstream services',()=>{
 const state=historical(),keys=['records','rawRecords','tasks','scripts','fieldSourceOverrides','apiServices','subscriptions'];const before=Object.fromEntries(keys.map(key=>[key,JSON.stringify(state[key])])),oldMappings=structuredClone(state.mappings);upgrade(state);
 for(const [id,mappings] of Object.entries(oldMappings))assert.deepEqual(state.mappings[id],mappings);
 for(const key of keys)assert.equal(JSON.stringify(state[key]),before[key],key);
 for(const p of state.providers.filter(p=>p.type==='api')){assert.equal(p.enabled,false);assert.equal(p.retired,true);assert.equal(isConfigurableSource(p),false);assert.equal(state.schedules[p.id].enabled,false);}
 assert.equal(state.updateJobs[0].retired,true);assert.equal(state.updateJobs[0].lastCursor,'2026-10-28T00:00:00Z');assert.equal(dueUpdateJob(state,NOW),null);assert.doesNotMatch(renderUpdateJobs(state),/old_job|历史任务/);
 const once=JSON.stringify(state);upgrade(state);assert.equal(JSON.stringify(state),once);
});

test('retired API tasks and sources cannot execute even when enabled is manually restored',async()=>{
 const state=upgrade(historical()),job=state.updateJobs[0];job.enabled=true;state.providers.find(p=>p.id==='qcc').enabled=true;let calls=0;const before=JSON.stringify(state);
 await assert.rejects(executeUpdateJob(state,job.id,{now:NOW,loadInput:async()=>{calls++;return {rows:[]};}}),/停用/);assert.equal(calls,0);assert.equal(JSON.stringify(state),before);
 assert.throws(()=>applyBatch(state,{sourceId:'qcc',rows:[],now:NOW}),/API/);assert.throws(()=>createUpdateJob(state,{name:'不能恢复',sourceId:'qcc',mode:'full',frequency:'manual',enabled:true}),/FTP/);
 assert.throws(()=>setFieldSourceOverride(state,state.records[0].id,'legalPerson','qcc'),/停用/);
 const notices=[];await handleUpdateJobAction('update-job-toggle',{dataset:{id:job.id}},{getState:()=>state,toast:message=>notices.push(message)});assert.match(notices[0],/停用/);assert.equal(dueUpdateJob(state,NOW),null);
});

test('activity rankings stay ahead of historical fallback for initial upgrade and later new FTP sources',()=>{
 const state=upgrade(historical());createFtpSource(state,{id:'new_ftp',name:'新文件来源'});
 for(const order of Object.values(state.priorities)){assert.ok(order.indexOf('ftp_qcc')<order.indexOf('qcc'));assert.ok(order.indexOf('new_ftp')<order.indexOf('qcc'));}
 const existing=JSON.stringify(state.records);upgrade(state);assert.equal(JSON.stringify(state.records),existing);
 // Existing pins retain the old source. Other automatic fields use current sources
 // once a normal update or explicit recomputation happens.
 recomputeRecords(state,{now:NOW});assert.equal(state.records[0].lineage.registeredCapitalWan.selected.sourceId,'tyc');
 assert.equal(state.records[0].lineage.legalPerson.selected.sourceId,'qcc');
 importFtpFile(state,'ftp_qcc','full-v1',{mode:'full',now:NOW});assert.equal(state.records[0].lineage.legalPerson.selected.sourceId,'ftp_qcc');assert.equal(state.records[0].lineage.registeredCapitalWan.selected.sourceId,'tyc');
});
