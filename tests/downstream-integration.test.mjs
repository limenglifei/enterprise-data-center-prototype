import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createInitialState,FIELD_DEFS} from '../public/prototype/core.mjs';
import {upgradeSourceState} from '../public/prototype/source-config.mjs';
import {upgradeApiServices} from '../public/prototype/api-services.mjs';
import {upgradeFtpSources} from '../public/prototype/ftp-sources.mjs';
import {upgradeSqlServices} from '../public/prototype/sql-services.mjs';
import {upgradeSubscriptions} from '../public/prototype/subscription-services.mjs';
import {renderDownstreamServices,downstreamCounts} from '../public/prototype/downstream-services.mjs';

function upgrade(state){
  upgradeSourceState(state);upgradeApiServices(state);upgradeFtpSources(state);
  upgradeSqlServices(state);upgradeSubscriptions(state);return state;
}

test('existing workspace upgrade preserves enterprise data and is idempotent across all new modules',()=>{
  const state=createInitialState();
  const records=JSON.stringify(state.records),rawRecords=JSON.stringify(state.rawRecords);
  upgrade(state);const once=JSON.stringify(state);upgrade(state);
  assert.equal(JSON.stringify(state),once);
  assert.equal(JSON.stringify(state.records),records);
  assert.equal(JSON.stringify(state.rawRecords),rawRecords);
  const sourceIds=state.providers.map(p=>p.id);
  for(const field of FIELD_DEFS)assert.deepEqual([...state.priorities[field.key]].sort(),[...sourceIds].sort());
});

test('API source migration does not overwrite FTP configuration with API defaults',()=>{
  const state=createInitialState();
  state.providers.push({id:'ftp_custom',type:'ftp',name:'合作数据文件',ftpConfig:{host:'files.example.com',directory:'/company/'}});
  upgradeSourceState(state);
  const provider=state.providers.find(item=>item.id==='ftp_custom');
  assert.equal(provider.type,'ftp');
  assert.equal(provider.ftpConfig.host,'files.example.com');
  assert.equal(provider.requestParams,undefined);
  assert.equal(provider.baseUrl,undefined);
});

test('downstream page exposes three service channels while retaining existing API catalogue',()=>{
  const state=upgrade(createInitialState());
  for(const mode of ['api','sql','subscription']){
    const html=renderDownstreamServices(state,mode);
    assert.match(html,/API 服务/);assert.match(html,/动态 SQL 查询/);assert.match(html,/订阅推送/);
    assert.match(html,new RegExp(`aria-selected="true" data-action="downstream-mode" data-mode="${mode}"`));
  }
  assert.match(renderDownstreamServices(state,'api'),/最近调用次数/);
});

test('overview published counts exclude draft and paused services across channels',()=>{
  const counts=downstreamCounts({apiServices:[{status:'published'},{status:'draft'}],sqlServices:[{status:'published'},{status:'disabled'}],subscriptions:[{status:'published'},{status:'paused'}]});
  assert.deepEqual(counts,{api:1,sql:1,subscription:1});
});

test('navigation uses downstream label and access tabs keep API, FTP, local file order',async()=>{
  const html=await readFile(new URL('../public/prototype/index.html',import.meta.url),'utf8');
  const app=await readFile(new URL('../public/prototype/app.js',import.meta.url),'utf8');
  assert.match(html,/data-nav="services" title="下游服务"/);
  assert.ok(app.indexOf('data-mode="api">API 对接')<app.indexOf('data-mode="ftp">FTP 对接'));
  assert.ok(app.indexOf('data-mode="ftp">FTP 对接')<app.indexOf('data-mode="file">本地文件上传'));
});
