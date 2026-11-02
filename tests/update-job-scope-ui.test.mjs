import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../public/prototype/core.mjs';
import {upgradeFtpSources} from '../public/prototype/ftp-sources.mjs';
import {normalizeUpdateScope,previewUpdateScope} from '../public/prototype/update-scope.mjs';
import {upgradeUpdateJobs,createUpdateJob,saveUpdateJob,validateUpdateJob,renderUpdateJobForm,renderUpdateJobs,renderUpdateScopePreview,updateScopeOptions,updateScopeFingerprint,updateJobScopeText,dueUpdateJob,handleUpdateJobAction} from '../public/prototype/update-jobs.mjs';

const NOW='2026-11-02T01:00:00.000Z';
const input={name:'安徽企业定时更新',sourceId:'qcc',mode:'incremental',frequency:'daily',time:'02:00',weekday:1,intervalHours:1,enabled:true};
function workspace(){
  const state=upgradeUpdateJobs(upgradeFtpSources(createInitialState({seed:false})),NOW);
  state.providers.find(source=>source.id==='qcc').requestScope='enterprise';
  state.records=[{id:'ent_a',enterpriseName:'甲科技有限公司',creditCode:'91340100123456789A',regionProvince:'安徽省',regionCity:'合肥市',regionDistrict:'蜀山区',industry:'软件和信息技术服务业',qualifications:['高新技术企业']},{id:'ent_b',enterpriseName:'乙制造有限公司',creditCode:'91320100123456789B',regionProvince:'江苏省',regionCity:'南京市',regionDistrict:'建邺区',industry:'制造业',qualifications:['专精特新企业']}];
  return state;
}

test('new API jobs store an independent normalized scope and new-target progress',()=>{
  const state=workspace(),scope={type:'list',entries:[{creditCode:' 91340100123456789a ',enterpriseName:'甲科技有限公司'}],fileName:'名单.xlsx'};
  const job=createUpdateJob(state,{...input,scope},{now:NOW});
  assert.equal(job.scope.entries[0].creditCode,'91340100123456789A');assert.equal(job.scope.fileName,'名单.xlsx');
  assert.deepEqual(job.scopeBaselines,[]);assert.deepEqual(job.scopeTargetCursors,{});assert.deepEqual(job.lastScopeTargetKeys,[]);
  scope.entries[0].enterpriseName='外部修改';assert.equal(job.scope.entries[0].enterpriseName,'甲科技有限公司');
});

test('editing enterprise range preserves existing progress and leaves other jobs untouched',()=>{
  const state=workspace(),job=createUpdateJob(state,input,{now:NOW}),other=createUpdateJob(state,input,{now:NOW});
  job.lastCursor='2026-11-01T00:00:00.000Z';job.scopeBaselines=['code:91340100123456789A'];job.scopeTargetCursors={'code:91340100123456789A':job.lastCursor};job.lastScopeTargetKeys=['code:91340100123456789A'];
  const before=JSON.stringify(other),scope={type:'filters',filters:{regions:['安徽省'],industries:[],qualifications:[]}};
  saveUpdateJob(state,job.id,{...input,scope},{now:NOW});
  assert.equal(job.lastCursor,'2026-11-01T00:00:00.000Z');assert.deepEqual(job.scopeBaselines,['code:91340100123456789A']);assert.equal(job.scopeTargetCursors['code:91340100123456789A'],job.lastCursor);assert.equal(JSON.stringify(other),before);
});

test('source or mode changes reset target baselines while FTP discards API-only range state',()=>{
  const state=workspace(),job=createUpdateJob(state,input,{now:NOW});
  Object.assign(job,{lastCursor:'2026-11-01T00:00:00.000Z',scopeBaselines:['old'],scopeTargetCursors:{old:'cursor'},lastScopeTargetKeys:['old']});
  saveUpdateJob(state,job.id,{...input,mode:'full',scope:{type:'all'}},{now:NOW});
  assert.equal(job.lastCursor,null);assert.deepEqual(job.scopeBaselines,[]);assert.deepEqual(job.scopeTargetCursors,{});assert.deepEqual(job.lastScopeTargetKeys,[]);
  saveUpdateJob(state,job.id,{...input,sourceId:'ftp_demo',scope:{type:'list',entries:[{enterpriseName:'不应导入'}]}},{now:NOW});
  for(const key of ['scope','scopeBaselines','scopeTargetCursors','lastScopeTargetKeys'])assert.equal(Object.hasOwn(job,key),false);
  const ftp=createUpdateJob(state,{...input,sourceId:'ftp_demo',scope:{type:'filters'}},{now:NOW});assert.equal(Object.hasOwn(ftp,'scope'),false);
});

test('task validation blocks empty filters and invalid lists before mutation',()=>{
  const state=workspace(),before=JSON.stringify(state.updateJobs);
  assert.equal(validateUpdateJob(state,{...input,scope:{type:'filters'}}).valid,false);
  assert.throws(()=>createUpdateJob(state,{...input,scope:{type:'list',entries:[{creditCode:'not-code'}]}},{now:NOW}),/18 位/);
  assert.equal(JSON.stringify(state.updateJobs),before);
});

test('scope choices expose province city district paths and retain saved dictionary values',()=>{
  const state=workspace(),choices=updateScopeOptions(state,{type:'filters',filters:{regions:['浙江省/杭州市'],industries:['已保存行业'],qualifications:['已保存资质']}});
  for(const path of ['安徽省','安徽省/合肥市','安徽省/合肥市/蜀山区','浙江省/杭州市'])assert.ok(choices.regions.includes(path));
  assert.ok(choices.industries.includes('已保存行业'));assert.ok(choices.qualifications.includes('已保存资质'));
});

test('scope preview reconciles total known new and duplicate rows without exposing markup',()=>{
  const state=workspace(),preview=previewUpdateScope(state,{type:'list',entries:[{creditCode:'91340100123456789A'},{enterpriseName:'甲科技有限公司'},{enterpriseName:'<script>待新增</script>'}]});
  const html=renderUpdateScopePreview(preview,{confirmed:true});
  assert.equal(preview.targets.length,2);assert.equal(preview.duplicates,1);assert.equal(preview.targets.filter(target=>target.known).length,1);
  for(const label of ['去重目标企业','库内企业','待新增企业','预计请求次数','已确认当前配置范围'])assert.ok(html.includes(label));
  assert.ok(html.includes('&lt;script&gt;待新增&lt;/script&gt;'));assert.ok(!html.includes('<script>'));
});

test('scope form restores uploaded file entries, explains purpose and hides scope for FTP',()=>{
  const state=workspace(),job={...input,scope:{type:'list',fileName:'<名单>.xlsx',entries:[{enterpriseName:'待新增公司'}]}};
  const html=renderUpdateJobForm(state,job,{token:'one'});
  for(const label of ['更新企业范围','全部企业','按条件筛选','上传企业名单','校验并预览范围','不导入企业业务字段'])assert.ok(html.includes(label));
  assert.ok(html.includes('&lt;名单&gt;.xlsx · 1 行'));assert.ok(html.includes('data-scope-session="one"'));assert.ok(!html.includes('<名单>'));
  const ftp=renderUpdateJobForm(state,{...job,sourceId:'ftp_demo'});assert.ok(ftp.includes('class="form-full scope-panel" hidden'));assert.ok(!ftp.includes('name="scopeType"'));
});

test('preview confirmation fingerprints change with source filters list or file metadata',()=>{
  const scope=normalizeUpdateScope({type:'filters',filters:{regions:['安徽省']}}),key=updateScopeFingerprint('qcc',scope);
  assert.equal(key,updateScopeFingerprint('qcc',structuredClone(scope)));
  assert.notEqual(key,updateScopeFingerprint('tyc',scope));assert.notEqual(key,updateScopeFingerprint('qcc',{...scope,filters:{...scope.filters,regions:['江苏省']}}));
  const list={type:'list',entries:[{enterpriseName:'甲公司'}],fileName:'名单.csv'};
  assert.notEqual(updateScopeFingerprint('qcc',list),updateScopeFingerprint('qcc',{...list,entries:[{enterpriseName:'乙公司'}]}));
  const source={id:'qcc',type:'api',requestScope:'enterprise',method:'GET'};
  assert.notEqual(updateScopeFingerprint('qcc',scope,source),updateScopeFingerprint('qcc',scope,{...source,method:'POST'}));
  assert.notEqual(updateScopeFingerprint('qcc',scope,source),updateScopeFingerprint('qcc',scope,{...source,requestScope:'single'}));
});

test('catalog makes the saved range explicit and keeps historical jobs compatible',()=>{
  const state=workspace(),job=createUpdateJob(state,{...input,scope:{type:'filters',filters:{regions:['安徽省'],qualifications:['高新技术企业']}}},{now:NOW});
  assert.equal(updateJobScopeText(state,job),'按条件筛选 · 2 项条件');
  const html=renderUpdateJobs(state);assert.match(html,/更新企业范围/);assert.match(html,/执行前重新筛选/);assert.match(html,/按条件筛选 · 2 项条件/);
  const old=state.updateJobs.find(value=>value.migratedSourceId==='qcc');assert.equal(updateJobScopeText(state,old),'全部库内企业');
});

test('single list sources block every enterprise scope while old API sources remain compatible',()=>{
  const state=workspace(),source=state.providers.find(value=>value.id==='qcc');source.requestScope='single';
  const before=JSON.stringify(state.updateJobs);
  for(const scope of [{type:'all'},{type:'filters',filters:{regions:['安徽省']}},{type:'list',entries:[{enterpriseName:'待新增企业'}]}]){
    assert.equal(validateUpdateJob(state,{...input,scope}).valid,false);
    assert.throws(()=>createUpdateJob(state,{...input,scope},{now:NOW}),/逐企/);
  }
  assert.equal(JSON.stringify(state.updateJobs),before);
  delete source.requestScope;assert.equal(validateUpdateJob(state,input).valid,true);
  assert.equal(createUpdateJob(state,input,{now:NOW}).scope.type,'all');
});

test('single source edit preserves original range and provides no fake full-list scope',()=>{
  const state=workspace(),source=state.providers.find(value=>value.id==='qcc'),scope={type:'filters',filters:{regions:['安徽省'],qualifications:['高新技术企业']}},job=createUpdateJob(state,{...input,scope},{now:NOW});
  source.requestScope='single';const before=JSON.stringify(job),html=renderUpdateJobForm(state,job);
  assert.ok(html.includes('不支持全部企业、按条件或上传名单的逐企更新任务'));
  for(const type of ['all','filters','list'])assert.match(html,new RegExp(`name="scopeType" value="${type}"[^>]*disabled`));
  assert.match(html,/data-action="update-job-scope-preview"[^>]*disabled/);
  assert.match(html,/name="scope-region" value="安徽省" checked disabled/);
  assert.equal(JSON.stringify(job),before);assert.match(updateJobScopeText(state,job),/按条件筛选.*需改用逐企信源/);
  const preview=renderUpdateScopePreview(null,{single:true});assert.match(preview,/列表接口可在数据接入中执行接入/);assert.ok(!preview.includes('预计 1 次请求'));
});

test('single-source historical jobs stay intact but cannot run manually or through scheduling',async()=>{
  const state=workspace(),job=createUpdateJob(state,input,{now:NOW});
  state.updateJobs=[job];job.nextRunAt='2026-11-01T00:00:00.000Z';state.providers.find(source=>source.id==='qcc').requestScope='single';
  const before=JSON.stringify(job),calls=[],notices=[];
  assert.equal(dueUpdateJob(state,NOW),null);
  await handleUpdateJobAction('update-job-run',{dataset:{id:job.id}},{getState:()=>state,runJob:async id=>calls.push(id),toast:message=>notices.push(message)});
  assert.equal(calls.length,0);assert.match(notices[0],/修改任务信源后运行/);assert.equal(JSON.stringify(job),before);
  assert.match(renderUpdateJobs(state),new RegExp(`data-action="update-job-run" data-id="${job.id}" disabled`));
});
