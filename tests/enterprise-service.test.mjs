import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {createInitialState} from '../public/prototype/core.mjs';
import {upgradeApiServices} from '../public/prototype/api-services.mjs';

// Exercise the real route helper with an in-memory, read-only D1 double.
const state=createInitialState();upgradeApiServices(state);for(const s of state.apiServices)s.status='published';
const environment={ENTERPRISE_API_KEY:'test-only-key',DB:{prepare(sql){assert.match(sql,/^SELECT payload/);return {bind(id){assert.equal(id,'shared');return {async first(){return {payload:JSON.stringify(state)};}};}};}}};
globalThis.__enterpriseServiceTestEnv=environment;
const filename=new URL('../lib/enterprise-service.ts',import.meta.url);
let source=await readFile(filename,'utf8');
source=source.replace("import {env} from 'cloudflare:workers';",'const env=globalThis.__enterpriseServiceTestEnv;').replace("'../public/prototype/api-services.mjs'",JSON.stringify(new URL('../public/prototype/api-services.mjs',import.meta.url).href));
const {handleEnterpriseService}=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const request=(path,options={})=>new Request('https://service.example'+path,{...options,headers:{Authorization:'Bearer test-only-key',...(options.headers||{})}});

test('external API fails closed without server key and rejects invalid Bearer keys',async()=>{
  const saved=environment.ENTERPRISE_API_KEY;delete environment.ENTERPRISE_API_KEY;
  assert.equal((await handleEnterpriseService(request('/api/v1/enterprises/query?keyword=x'),'query')).status,503);
  environment.ENTERPRISE_API_KEY=saved;
  for(const Authorization of ['','Bearer wrong','Basic test-only-key','Bearer test-only-key extra']){
    const result=await handleEnterpriseService(request('/api/v1/enterprises/query?keyword=x',{headers:{Authorization}}),'query');
    assert.equal(result.status,401);assert.equal((await result.json()).code,'UNAUTHORIZED');
  }
});
test('authenticated query reads D1, returns public fields and is exact',async()=>{
  const first=state.records[0];
  const success=await handleEnterpriseService(request('/api/v1/enterprises/query?keyword='+encodeURIComponent(first.creditCode)),'query');
  const body=await success.json();assert.equal(success.status,200);assert.equal(body.data.record.creditCode,first.creditCode);assert.ok(body.requestId);assert.equal('lineage' in body.data.record,false);
  const missing=await handleEnterpriseService(request('/api/v1/enterprises/query?keyword='+encodeURIComponent(first.enterpriseName.slice(0,4))),'query');assert.equal(missing.status,404);
});
test('external service enforces configured publication and strict request parameters',async()=>{
  state.apiServices[1].status='disabled';
  assert.equal((await handleEnterpriseService(request('/api/v1/enterprises/query?keyword=x'),'query')).status,403);
  state.apiServices[1].status='published';
  for(const path of ['/api/v1/enterprises/query','/api/v1/enterprises/query?keyword=x&keyword=y','/api/v1/enterprises/query?keyword=x&extra=y'])assert.equal((await handleEnterpriseService(request(path),'query')).status,400);
});
test('external search validates JSON type, body bound and returns paginated matching rows',async()=>{
  const path='/api/v1/enterprises/search';
  const valid=await handleEnterpriseService(request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({regionProvince:state.records[0].regionProvince,pageSize:1})}),'search');
  const body=await valid.json();assert.equal(valid.status,200);assert.equal(body.data.records.length,1);assert.ok(body.data.count>=1);
  for(const options of [
    {headers:{'Content-Type':'application/jsonp'},body:'{}'},
    {headers:{'Content-Type':'application/json'},body:'[]'},
    {headers:{'Content-Type':'application/json'},body:'{"pageSize":101}'},
  ])assert.equal((await handleEnterpriseService(request(path,{method:'POST',...options}),'search')).status,400);
  assert.equal((await handleEnterpriseService(request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(16385)}),'search')).status,413);
});
