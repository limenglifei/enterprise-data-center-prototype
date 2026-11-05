import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createInitialState} from '../public/prototype/core.mjs';
import {renderUpdateJobForm,renderUpdateJobs,upgradeUpdateJobs,createUpdateJob,saveUpdateJob} from '../public/prototype/update-jobs.mjs';

test('FTP task configuration removes upstream API enterprise range controls',()=>{
 const state=createInitialState();upgradeUpdateJobs(state);state.providers.push({id:'legacy_api',name:'旧API',type:'api',enabled:false,retired:true});
 const input={name:'FTP每日更新',sourceId:'ftp_qcc',mode:'incremental',frequency:'daily',time:'02:00',enabled:true};const job=createUpdateJob(state,{...input,scope:{type:'list',entries:[]}});
 assert.equal(job.scope,undefined);saveUpdateJob(state,job.id,{...input,scope:{type:'filters'}});assert.equal(job.scope,undefined);
 const form=renderUpdateJobForm(state,job),catalog=renderUpdateJobs(state);assert.match(form,/FTP\/FTPS/);assert.match(form,/离线文件本地上传/);assert.doesNotMatch(form+catalog,/scopeType|scopeFile|全部企业|按条件筛选|上传企业名单|legacy_api|API 对接/);
});

test('application has no upstream API creation, config, test or request action',async()=>{
 const app=await readFile(new URL('../public/prototype/app.js',import.meta.url),'utf8');assert.doesNotMatch(app,/add-api|create-api|connection-form|test-connection|save-connection|\/api\/vendor/);assert.match(app,/api-service-/);assert.match(app,/subscription-/);
});
