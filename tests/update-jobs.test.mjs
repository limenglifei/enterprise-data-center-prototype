import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../public/prototype/core.mjs';
import {upgradeFtpSources,createFtpSource,renderFtpSources,selectFtpSource} from '../public/prototype/ftp-sources.mjs';
import {upgradeUpdateJobs,createUpdateJob,validateUpdateJob,nextJobRun,dueUpdateJob,finishUpdateJob,renderUpdateJobs,handleUpdateJobAction} from '../public/prototype/update-jobs.mjs';

const NOW='2026-10-29T01:00:00Z'; // Thursday, Beijing 09:00.
const workspace=()=>{const state=upgradeFtpSources(createInitialState({seed:false}));createFtpSource(state,{id:'ftp_second',name:'第二文件来源'});return upgradeUpdateJobs(state,NOW);};
const input={name:'每日企业同步',sourceId:'ftp_qcc',mode:'incremental',frequency:'daily',time:'02:00',weekday:1,intervalHours:1,enabled:true};

test('initial migration creates FTP tasks and retires API jobs without overwriting their checkpoints',()=>{
 const state=createInitialState({seed:false});state.providers.push({id:'old_api',type:'api',enabled:true});state.updateJobs=[{id:'old',sourceId:'old_api',enabled:true,nextRunAt:NOW,lastCursor:'2026-10-25T00:00:00Z'}];
 state.schedules.ftp_qcc={enabled:true,mode:'full',frequency:'weekly',time:'03:30',weekday:5,intervalHours:168,lastCursor:null,nextRunAt:null};
 upgradeUpdateJobs(state,NOW);assert.equal(state.updateJobs.length,4);const old=state.updateJobs[0],ftp=state.updateJobs.find(j=>j.sourceId==='ftp_qcc');assert.equal(old.enabled,false);assert.equal(old.retired,true);assert.equal(old.nextRunAt,null);assert.equal(old.lastCursor,'2026-10-25T00:00:00Z');assert.equal(ftp.frequency,'weekly');assert.equal(ftp.time,'03:30');assert.equal(ftp.weekday,5);
 const once=JSON.stringify(state);upgradeUpdateJobs(state,NOW);assert.equal(JSON.stringify(state),once);
});

test('multiple tasks may share a source and name but retain independent IDs and checkpoints',()=>{
  const state=workspace(),a=createUpdateJob(state,input,{now:NOW}),b=createUpdateJob(state,input,{now:NOW});assert.notEqual(a.id,b.id);a.lastCursor='2026-10-28T00:00:00Z';assert.equal(b.lastCursor,null);assert.equal(a.sourceId,b.sourceId);
});

test('manual migration creates a task with no due time',()=>{
  const state=upgradeFtpSources(createInitialState({seed:false}));state.schedules.ftp_qcc.time='';upgradeUpdateJobs(state,NOW);const ftp=state.updateJobs.find(j=>j.sourceId==='ftp_qcc');assert.equal(ftp.frequency,'manual');assert.equal(ftp.nextRunAt,null);
});

test('task creation rejects invalid name, source, execution clock, frequency and interval without mutation',()=>{
  const state=workspace(),before=JSON.stringify(state);
  for(const patch of [{name:''},{sourceId:'file'},{sourceId:'missing'},{mode:'replace'},{frequency:'secondly'},{time:''},{time:'25:00'},{frequency:'hourly',intervalHours:0},{frequency:'hourly',intervalHours:1.5},{frequency:'weekly',weekday:8},{enabled:'true'}])assert.throws(()=>createUpdateJob(state,{...input,...patch},{now:NOW}));
  assert.equal(JSON.stringify(state),before);assert.equal(validateUpdateJob(state,input).valid,true);
});

test('daily and weekly execution clocks use Beijing time across month and year boundaries',()=>{
  const daily={...input,enabled:true};assert.equal(nextJobRun(daily,NOW),'2026-10-29T18:00:00.000Z');
  assert.equal(nextJobRun({...daily,time:'09:00'},NOW),'2026-10-30T01:00:00.000Z','equal current minute advances to next day');
  assert.equal(nextJobRun({...daily,time:'00:00'},'2026-12-31T16:01:00Z'),'2027-01-01T16:00:00.000Z');
  assert.equal(nextJobRun({...daily,frequency:'weekly',weekday:5,time:'08:30'},NOW),'2026-10-30T00:30:00.000Z');
  assert.equal(nextJobRun({...daily,frequency:'weekly',weekday:4,time:'08:30'},NOW),'2026-11-05T00:30:00.000Z');
});

test('manual and paused jobs have no due time; hourly intervals advance strictly from attempt completion',()=>{
  assert.equal(nextJobRun({...input,frequency:'manual'},NOW),null);assert.equal(nextJobRun({...input,enabled:false},NOW),null);assert.equal(nextJobRun({...input,frequency:'hourly',intervalHours:3},NOW),'2026-10-29T04:00:00.000Z');
});

test('due selection returns earliest enabled scheduled job and excludes missing/disabled sources',()=>{
  const state=workspace();state.updateJobs=[];
  const a=createUpdateJob(state,input,{now:NOW}),b=createUpdateJob(state,{...input,sourceId:'ftp_second'},{now:NOW}),manual=createUpdateJob(state,{...input,frequency:'manual'},{now:NOW});
  a.nextRunAt='2026-10-28T01:00:00Z';b.nextRunAt='2026-10-27T01:00:00Z';manual.nextRunAt='2026-10-20T00:00:00Z';assert.equal(dueUpdateJob(state,NOW).id,b.id);
  state.providers.find(p=>p.id==='ftp_second').enabled=false;assert.equal(dueUpdateJob(state,NOW).id,a.id);a.enabled=false;assert.equal(dueUpdateJob(state,NOW),null);
});

test('successful completion advances only the selected job cursor and never rolls backward',()=>{
  const state=workspace(),job=createUpdateJob(state,input,{now:NOW});job.lastCursor='2026-10-27T00:00:00Z';const schedules=JSON.stringify(state.schedules);
  finishUpdateJob(state,job.id,{task:{id:'t1',status:'success',failed:0},now:NOW,cursor:'2026-10-28T00:00:00Z'});assert.equal(job.lastCursor,'2026-10-28T00:00:00Z');assert.equal(job.lastTaskId,'t1');assert.equal(job.lastRunStatus,'success');assert.equal(job.runCount,1);assert.equal(job.nextRunAt,'2026-10-29T18:00:00.000Z');assert.equal(JSON.stringify(state.schedules),schedules);
  finishUpdateJob(state,job.id,{task:{id:'t2',status:'success'},now:NOW,cursor:'2026-10-26T00:00:00Z'});assert.equal(job.lastCursor,'2026-10-28T00:00:00Z');
});

test('explicit null cursor does not fall back to a different source job checkpoint',()=>{
  const state=workspace(),job=createUpdateJob(state,input,{now:NOW});state.schedules.ftp_qcc.lastCursor='2026-10-28T00:00:00Z';
  finishUpdateJob(state,job.id,{task:{id:'t1',status:'success'},now:NOW,cursor:null});assert.equal(job.lastCursor,null);
  finishUpdateJob(state,job.id,{task:{id:'t2',status:'success'},now:NOW});assert.equal(job.lastCursor,'2026-10-28T00:00:00Z','legacy callers without cursor can use compatibility schedule');
});

test('partial failures and transport errors retain checkpoint and record failed attempt details',()=>{
  const state=workspace(),job=createUpdateJob(state,input,{now:NOW});job.lastCursor='2026-10-27T00:00:00Z';
  finishUpdateJob(state,job.id,{task:{id:'partial',status:'partial',failed:1,message:'部分记录失败'},cursor:'2026-10-29T00:00:00Z',now:NOW});assert.equal(job.lastCursor,'2026-10-27T00:00:00Z');assert.equal(job.lastRunStatus,'partial');assert.match(job.lastError,/部分记录失败/);
  finishUpdateJob(state,job.id,{error:new Error('远端超时'),now:NOW,cursor:'2026-10-29T00:00:00Z'});assert.equal(job.lastRunStatus,'failed');assert.equal(job.lastError,'远端超时');assert.equal(job.lastTaskId,null);assert.equal(job.runCount,2);assert.equal(job.lastCursor,'2026-10-27T00:00:00Z');
});

test('manual enabled tasks call the common runner and paused tasks cannot run',async()=>{
  const state=workspace(),job=createUpdateJob(state,{...input,frequency:'manual'},{now:NOW});const calls=[],notices=[],ctx={getState:()=>state,toast:(...a)=>notices.push(a),runJob:async id=>calls.push(id)};
  await handleUpdateJobAction('update-job-run',{dataset:{id:job.id}},ctx);assert.deepEqual(calls,[job.id]);job.enabled=false;await handleUpdateJobAction('update-job-run',{dataset:{id:job.id}},ctx);assert.equal(calls.length,1);assert.match(notices.at(-1)[0],/请先启用/);
});

test('job catalog escapes user content, disables paused execution and makes local-file boundary explicit',()=>{
  const state=workspace(),job=createUpdateJob(state,{...input,name:'<img src=x>',enabled:false},{now:NOW}),html=renderUpdateJobs(state);
  assert.ok(!html.includes('<img src=x>'));assert.match(html,/&lt;img/);assert.match(html,/离线文件本地上传使用固定模板手动接入/);assert.ok(html.includes(`data-action="update-job-run" data-id="${job.id}" disabled`));
});

test('FTP connection screen no longer contains update mechanism or frequency controls',()=>{
  const state=workspace();selectFtpSource('ftp_qcc');const html=renderFtpSources(state);
  assert.ok(!html.includes('name="mode"'));assert.ok(!html.includes('name="frequency"'));assert.match(html,/连接配置/);assert.match(html,/更新机制、频率、执行时间统一在更新任务配置/);
});
