import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../public/prototype/core.mjs';
import {upgradeApiServices,createApiService,validateApiServiceConfig,normalizeApiServiceInput,runApiService,renderApiServices} from '../public/prototype/api-services.mjs';

const ready=()=>{const state=createInitialState();upgradeApiServices(state);for(const service of state.apiServices)service.status='published';return state;};

test('service upgrade is idempotent and preserves configured publication across JSON persistence',()=>{
  const state=createInitialState();upgradeApiServices(state);assert.equal(state.apiServices.length,2);assert.equal(state.apiServices[0].status,'draft');
  state.apiServices[0].name='自定义批量接口';state.apiServices[0].status='published';
  const loaded=JSON.parse(JSON.stringify(state));upgradeApiServices(loaded);upgradeApiServices(loaded);
  assert.equal(loaded.apiServices.length,2);assert.equal(loaded.apiServices[0].name,'自定义批量接口');assert.equal(loaded.apiServices[0].status,'published');
  assert.equal(loaded.apiServices[0].kind,'search');assert.equal(loaded.apiServices[1].kind,'query');
});
const newService=(id='industry-search',kind='search')=>({id,kind,name:'产业招商企业接口',version:'1.0.0',description:'供产业招商系统调用统一企业库'});
test('new API services have immutable derived routes, start as drafts and survive catalog upgrades',()=>{
  const state=ready(),created=createApiService(state,newService());
  assert.equal(created.status,'draft');assert.equal(created.method,'POST');assert.equal(created.path,'/api/v1/services/industry-search');assert.equal(created.publishedAt,null);
  created.name='已修改接口名称';created.status='published';
  const loaded=JSON.parse(JSON.stringify(state));upgradeApiServices(loaded);upgradeApiServices(loaded);
  assert.equal(loaded.apiServices.length,3);assert.equal(loaded.apiServices[2].name,'已修改接口名称');assert.equal(loaded.apiServices[2].status,'published');
  assert.equal(validateApiServiceConfig(loaded.apiServices[2]).valid,true);
  for(const change of [{path:'/arbitrary'},{method:'GET'},{kind:'script'}])assert.equal(validateApiServiceConfig({...created,...change}).valid,false);
});
test('new API validates required fields, unique slug, kind and semantic version without partial creation',()=>{
  const state=ready();createApiService(state,newService());
  for(const change of [{id:'industry-search'},{id:'search'},{id:''},{id:'Bad_Slug'},{id:'1bad'},{id:'bad--slug'},{id:'a'.repeat(61)},{id:'../unsafe'},{name:' '},{description:''},{kind:'arbitrary'},{version:'v1'}]){
    assert.throws(()=>createApiService(state,{...newService('another-search'),...change}));assert.equal(state.apiServices.length,3);
  }
});
test('multiple custom APIs of each type use the selected capability after publication and honor disabled state',()=>{
  const state=ready(),first=state.records[0];
  const searches=['industry-search','regional-search'].map(id=>createApiService(state,newService(id)));
  const queries=['customer-query','supplier-query'].map(id=>createApiService(state,newService(id,'query')));
  for(const service of [...searches,...queries]){
    assert.equal(runApiService(state,service.id,{}).httpStatus,403);
    service.status='published';
    const result=runApiService(state,service.id,service.kind==='search'?{regionProvince:first.regionProvince,pageSize:1}:{keyword:first.creditCode});
    assert.equal(result.httpStatus,200);
    const record=service.kind==='search'?result.body.data.records[0]:result.body.data.record;
    assert.equal(record.creditCode,first.creditCode);assert.equal('lineage' in record,false);
    service.status='disabled';assert.equal(runApiService(state,service.id,{}).httpStatus,403);
  }
  assert.equal(state.apiServices.length,6);assert.equal(queries[0].method,'GET');
});
test('draft and disabled services reject invocation, published service works',()=>{
  const state=createInitialState();upgradeApiServices(state);
  assert.equal(runApiService(state,'search',{}).httpStatus,403);
  state.apiServices[0].status='published';assert.equal(runApiService(state,'search',{}).httpStatus,200);
  state.apiServices[0].status='disabled';assert.equal(runApiService(state,'search',{}).body.code,'API_NOT_PUBLISHED');
  assert.equal(state.apiCallLogs.length,3);
});
test('configuration publication validation rejects missing names, malformed versions and paths',()=>{
  const state=ready(),service=state.apiServices[0];assert.equal(validateApiServiceConfig(service).valid,true);
  for(const change of [{name:' '},{version:'v1'},{description:''},{path:'/arbitrary'}])assert.equal(validateApiServiceConfig({...service,...change}).valid,false);
});
test('batch search applies AND conditions and paginates actual stored enterprises',()=>{
  const state=ready(),first=state.records[0];
  const conditions={regionProvince:first.regionProvince,industry:first.industry,qualifications:first.qualifications[0],scale:first.scale,chainNodes:first.chainNodes[0],page:1,pageSize:1};
  const expected=state.records.filter(r=>r.regionProvince===first.regionProvince&&r.industry===first.industry&&r.qualifications.includes(first.qualifications[0])&&r.scale===first.scale&&r.chainNodes.includes(first.chainNodes[0]));
  const result=runApiService(state,'search',conditions);assert.equal(result.httpStatus,200);assert.equal(result.body.data.count,expected.length);assert.equal(result.body.data.records.length,1);assert.equal(result.body.data.records[0].creditCode,expected[0].creditCode);
  assert.equal(runApiService(state,'search',{page:2,pageSize:1}).body.data.records[0].creditCode,state.records[1].creditCode);
});
test('exact query accepts full name or code and rejects partial company names',()=>{
  const state=ready(),first=state.records[0];
  for(const keyword of [first.enterpriseName,first.creditCode.toLowerCase()])assert.equal(runApiService(state,'query',{keyword}).body.data.record.creditCode,first.creditCode);
  const partial=runApiService(state,'query',{keyword:first.enterpriseName.slice(0,4)});assert.equal(partial.httpStatus,404);assert.equal(partial.body.data,null);
});
test('public API never exposes raw source payloads, lineage or configuration',()=>{
  const state=ready();const record=runApiService(state,'search',{pageSize:1}).body.data.records[0];
  assert.equal('lineage' in record,false);assert.equal('raw' in record,false);assert.equal('sources' in record,false);assert.ok(record.enterpriseId);assert.ok('dataUpdatedAt' in record);
});
test('invalid and unbounded inputs are rejected rather than ignored',()=>{
  const state=ready();
  for(const input of [{pageSize:101},{page:'1'},{industry:['电子信息']},{keyword:'x'.repeat(201)},{unexpected:'x'},null])assert.equal(runApiService(state,'search',input).httpStatus,400);
  for(const input of [{keyword:''},{keyword:'x'.repeat(201)},{keyword:'x',extra:'x'},[]])assert.throws(()=>normalizeApiServiceInput('query',input));
});
test('call logs retain latest 100 and server read-only execution avoids writes',()=>{
  const state=ready();for(let i=0;i<105;i++)runApiService(state,'search',{}, {id:`req_${i}`,now:'2026-10-27T00:00:00Z'});
  assert.equal(state.apiCallLogs.length,100);assert.equal(state.apiCallLogs[0].id,'req_104');assert.equal(state.apiCallLogs.at(-1).id,'req_5');
  runApiService(state,'search',{}, {recordLog:false});assert.equal(state.apiCallLogs.length,100);
});
test('catalog discloses browser-only demo execution and both real interface paths',()=>{
  const html=renderApiServices(ready());assert.match(html,/GitHub Pages/);assert.match(html,/当前浏览器执行/);assert.match(html,/\/api\/v1\/enterprises\/search/);assert.match(html,/\/api\/v1\/enterprises\/query/);
  assert.match(html,/data-action="api-service-create"/);assert.match(html,/新增 API 服务/);
});
