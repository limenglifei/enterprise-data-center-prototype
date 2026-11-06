import test from 'node:test';import assert from 'node:assert/strict';
import {INDUSTRY_STANDARD_VERSION as V,normalizeIndustryPath,getEnterpriseIndustryPaths,industryChildren,matchesIndustryPath,syntheticIndustryRecord} from '../public/prototype/industry-classification.mjs';
import {createInitialState,createDefaultFtpMappings,applyBatch,filterEnterprises,getTableRecords,LEGACY_FIELD_DEFS} from '../public/prototype/core.mjs';
import {filterInventory,changeInventoryDraft} from '../public/prototype/inventory-filters.mjs';
import {createSubscription,previewSubscription} from '../public/prototype/subscription-services.mjs';
import {normalizeApiServiceInput,runApiService,upgradeApiServices} from '../public/prototype/api-services.mjs';
import {upgradeSourceState} from '../public/prototype/source-config.mjs';
const path=(...codes)=>({standardVersion:V,codes}),at='2026-11-06T01:00:00Z';
test('national industry validates contiguous levels and complete parent relationships',()=>{
 for(const codes of [['C'],['C','39'],['C','39','397'],['C','39','397','3974']])assert.deepEqual(normalizeIndustryPath(path(...codes)).codes,codes);
 for(const input of [path('C','','397'),path('I','39'),path('C','39','349'),path('C','39','397','6513'),path('C','39','397','3970'),{standardVersion:'other',codes:['C']},path('C','39','397','3974','x')])assert.throws(()=>normalizeIndustryPath(input));
});
test('fresh synthetic fixtures contain collected code paths, parents include children, themes never imply codes',()=>{
 const state=createInitialState(),first=state.records[0];assert.deepEqual(getEnterpriseIndustryPaths(first)[0].codes,['C','39','397','3974']);
 for(const codes of [['C'],['C','39'],['C','39','397'],['C','39','397','3974']])assert.ok(filterEnterprises(state,{industryPath:path(...codes)}).some(r=>r.id===first.id));
 assert.equal(matchesIndustryPath({industry:'电子信息'},path('C')),false);
 assert.ok(industryChildren(state.records).some(x=>x.value==='I'));assert.ok(industryChildren(state.records,['C','39','397']).some(x=>x.value==='3973'));
 assert.equal(filterInventory(state.records,{industryL1:'C',industryL2:'39',industryL3:'397',industryL4:'3974'})[0].id,first.id);
 const draft=changeInventoryDraft({industryL1:'C',industryL2:'39',industryL3:'397',industryL4:'3974',keyword:'词'},'industryL2','34');assert.equal(draft.industryL3,'');assert.equal(draft.industryL4,'');assert.equal(draft.keyword,'词');
});
test('same enterprise retains two C-branch industry rows and source array ordering does not change identities',()=>{
 const state=createInitialState({seed:false}),record=(n)=>syntheticIndustryRecord(n),row={company_name:'演示分类企业',credit_code:'DEMO-INDUSTRY-1',industry_records:[record(1),record(5)],sourceUpdatedAt:at,_synthetic:true};
 applyBatch(state,{sourceId:'ftp_qcc',rows:[row],now:at});const id=state.records[0].id,ids=getTableRecords(state,id,'enterprise_industry').map(r=>r.id);
 assert.equal(ids.length,2);assert.ok(matchesIndustryPath(state.records[0],path('C','39','397','3974')));assert.ok(matchesIndustryPath(state.records[0],path('C','34','349','3499')));
 applyBatch(state,{sourceId:'ftp_qxb',rows:[{...row,industry_records:[...row.industry_records].reverse()}],now:at});assert.deepEqual(getTableRecords(state,id,'enterprise_industry').map(r=>r.id),ids);
 const split={tables:{enterprise_industry:[{values:{'enterprise_industry.standard_version':V,'enterprise_industry.industry_code_l1':'C','enterprise_industry.industry_name_l1':'制造业','enterprise_industry.industry_code_l2':'39','enterprise_industry.industry_name_l2':'计算机、通信和其他电子设备制造业'}},{values:Object.fromEntries(Object.entries(record(5)).map(([k,v])=>['enterprise_industry.'+k,v]))}]}};
 assert.equal(matchesIndustryPath(split,path('C','39','397','3974')),false);
});
test('subscription industry paths OR with preserved legacy themes and AND with other dimensions',()=>{
 const state=createInitialState(),base={name:'国标订阅',description:'测试',webhookUrl:'https://example.invalid/hook',frequency:'manual',mode:'incremental'},service=createSubscription(state,{...base,filters:{industries:[],industryPaths:[path('C','39','397','3974'),path('I','65')],regions:[{province:'安徽省',city:'合肥市',district:''}],qualifications:[]}});
 const expected=state.records.filter(r=>r.regionProvince==='安徽省'&&r.regionCity==='合肥市'&&(matchesIndustryPath(r,path('C','39','397','3974'))||matchesIndustryPath(r,path('I','65'))));
 assert.deepEqual(previewSubscription(state,service).map(r=>r.enterpriseId),expected.map(r=>r.id));
 const legacy=JSON.stringify(service.filters.industries);upgradeSourceState(state);assert.equal(JSON.stringify(service.filters.industries),legacy);
 service.filters.industries=['装备制造'];
 const withLegacy=previewSubscription(state,service),legacyOnly=state.records.find(r=>r.industry==='装备制造'&&r.regionCity==='合肥市');
 assert.ok(legacyOnly&&!expected.some(r=>r.id===legacyOnly.id));assert.ok(withLegacy.some(r=>r.enterpriseId===legacyOnly.id),'a preserved theme may match alongside code paths');
 assert.deepEqual(withLegacy.map(r=>r.enterpriseId),state.records.filter(r=>r.regionProvince==='安徽省'&&r.regionCity==='合肥市'&&(r.industry==='装备制造'||matchesIndustryPath(r,path('C','39','397','3974'))||matchesIndustryPath(r,path('I','65')))).map(r=>r.id));
 service.filters.qualifications=['高新技术企业'];assert.deepEqual(previewSubscription(state,service).map(r=>r.enterpriseId),withLegacy.filter(r=>r.qualifications.includes('高新技术企业')).map(r=>r.enterpriseId));
 assert.throws(()=>createSubscription(state,{...base,filters:{industries:[],industryPaths:[path('C','65')],regions:[],qualifications:[]}}));
});
test('API industryPath is validated and does not expand public field responses',()=>{
 const state=createInitialState();upgradeApiServices(state);state.apiServices.find(s=>s.id==='search').status='published';
 const input={industryPath:path('C','39','397','3974'),pageSize:100};assert.deepEqual(normalizeApiServiceInput('search',input).industryPath,input.industryPath);
 const result=runApiService(state,'search',input);assert.equal(result.httpStatus,200);assert.ok(result.body.data.count>0);
 assert.deepEqual(Object.keys(result.body.data.records[0]).sort(),['enterpriseId',...LEGACY_FIELD_DEFS.map(f=>f.key),'dataUpdatedAt'].sort());
 assert.equal(runApiService(state,'search',{industryPath:path('I','39')}).httpStatus,400);
});
test('legacy upgrade preserves evidence and customized mappings; no theme-to-code migration occurs',()=>{
 const state=createInitialState(),defaults=createDefaultFtpMappings(),old=[...defaults.filter(m=>!m.sourceField.startsWith('industry_records[].')),{sourceField:'industry',targetField:'enterprise_industry.industry_name_l1',enabled:true,scriptId:''}];
 for(const r of state.records)r.tables.enterprise_industry=r.tables.enterprise_industry.filter(row=>row.values['enterprise_industry.classification_method']!=='SYNTHETIC_FIXTURE');
 for(const raw of state.rawRecords)raw.tableRows=raw.tableRows.filter(row=>row.values['enterprise_industry.classification_method']!=='SYNTHETIC_FIXTURE');
 delete state.industryConfigVersion;state.mappings.ftp_qcc=structuredClone(old);state.mappings.ftp_qxb=structuredClone(old);state.mappings.ftp_qxb[0].sourceField='custom.name';const custom=JSON.stringify(state.mappings.ftp_qxb),evidence=JSON.stringify(state.rawRecords);
 upgradeSourceState(state);assert.equal(JSON.stringify(state.rawRecords),evidence);assert.equal(JSON.stringify(state.mappings.ftp_qxb),custom);assert.ok(state.mappings.ftp_qcc.some(m=>m.sourceField==='industry_records[].industry_code_l4'));assert.equal(getEnterpriseIndustryPaths(state.records[0]).length,0);
 const once=JSON.stringify(state);upgradeSourceState(state);assert.equal(JSON.stringify(state),once);
});
