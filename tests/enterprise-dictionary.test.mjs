import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,applyBatch,recomputeRecords,validateMappings,getTableRecords,getLineage,setFieldSourceOverride,clearFieldSourceOverride,FIELD_DEFS} from '../public/prototype/core.mjs';
import {DICTIONARY_META,DICTIONARY_TABLES,getDictionaryField} from '../public/prototype/enterprise-dictionary.mjs';
import {upgradeSourceState} from '../public/prototype/source-config.mjs';
import {importFtpFile,getFtpFiles,upgradeFtpSources} from '../public/prototype/ftp-sources.mjs';
const NOW='2026-11-05T01:00:00Z',CODE='DEMO-V25-001';
const row=(changes={})=>({company_name:'演示字典测试企业',credit_code:CODE,sourceUpdatedAt:NOW,_synthetic:true,...changes});
const base=()=>createInitialState({seed:false});
const records=(state,table)=>getTableRecords(state,state.records[0].id,table);
const value=(record,key)=>record.values[key];

test('approved dictionary retains 257 source fields plus two V2.6 extensions in 13 tables',()=>{
 assert.equal(DICTIONARY_TABLES.length,13);assert.equal(FIELD_DEFS.length,259);assert.equal(new Set(FIELD_DEFS.map(f=>f.key)).size,259);
 assert.equal(DICTIONARY_META.version,'2.6');assert.equal(DICTIONARY_META.sourceFieldCount,257);assert.equal(DICTIONARY_META.extensionFieldCount,2);
 assert.equal(FIELD_DEFS.filter(f=>f.mappable).length,159);assert.equal(FIELD_DEFS.filter(f=>f.technical).length,100);
 assert.equal(DICTIONARY_TABLES.reduce((n,t)=>n+t.fieldCount,0),259);assert.equal(DICTIONARY_TABLES.find(t=>t.key==='enterprise_risk_event').fieldCount,16);
 assert.equal(FIELD_DEFS.filter(f=>f.sourceRow!==null).length,257);
 for(const name of ['published_date','publishing_authority']){const f=getDictionaryField(`enterprise_risk_event.${name}`);assert.equal(f.origin,'本轮需求 V2.6');assert.equal(f.sourceRow,null);assert.equal(f.dictionaryRow,null);assert.equal(f.required,false);assert.equal(f.default,null);assert.equal(f.mappable,true);assert.equal(f.technical,false);}
 assert.equal(DICTIONARY_META.sourceSha256,'4309F7C234B57D8348CF84D196905AA0B57BBE71F647226A6513F32C7667C130');
 for(const level of [1,2,3,4]){const f=getDictionaryField(`enterprise_industry.industry_code_l${level}`);assert.equal(f.originalKey,'enterprise_industry.industry_code');assert.ok(f.sourceRow>1);assert.ok(f.normalizationNote);}
 for(const name of ['invention_patent_count','utility_model_patent_count','design_patent_count','software_copyright_count'])assert.equal(getDictionaryField(`enterprise_intellectual_property_summary.${name}`).default,null);
 assert.equal(getDictionaryField('enterprise_shareholder.subject_name').label,'股东名称');assert.equal(getDictionaryField('enterprise_shareholder.effective_ownership_percent').label,'间接持股比例');
 assert.ok(!JSON.stringify(FIELD_DEFS).includes('91340100MADBFGGT5A'));
});

test('new workspace starts with three FTP sources, four ranks, synthetic identities and zero fabricated detail',()=>{
 const state=createInitialState();assert.deepEqual(state.providers.map(p=>p.id),['ftp_qcc','ftp_qxb','ftp_tyc','file']);assert.equal(state.records.length,24);
 assert.deepEqual(state.priorities['enterprise.enterprise_name'],['ftp_qcc','ftp_qxb','ftp_tyc','file']);
 assert.ok(state.records.every(record=>record.creditCode.startsWith('DEMO-')));
 assert.equal(records(state,'enterprise_patent').length,0);assert.equal(records(state,'enterprise_annual_operation').length,0);
});

test('dictionary bigint IDs use stable decimal strings and keep internal identities and unknown tenant separate',()=>{
 const state=createInitialState(),record=state.records[0],enterprise=records(state,'enterprise')[0],address=records(state,'enterprise_address')[0];
 assert.match(record.id,/^ent_/);assert.match(address.id,/^row_/);
 assert.match(value(enterprise,'enterprise.id'),/^\d+$/);assert.match(value(address,'enterprise_address.id'),/^\d+$/);
 assert.equal(value(address,'enterprise_address.enterprise_id'),value(enterprise,'enterprise.id'));assert.equal(value(enterprise,'enterprise.tenant_id'),null);
 const oldIds=[record.id,address.id],numericId=value(enterprise,'enterprise.id');
 record['enterprise.id']=record.id;enterprise.values['enterprise.id']=record.id;enterprise.values['enterprise.tenant_id']='local';address.values['enterprise_address.enterprise_id']=record.id;
 upgradeSourceState(state);assert.equal(value(enterprise,'enterprise.id'),numericId);assert.equal(value(address,'enterprise_address.enterprise_id'),numericId);assert.equal(value(enterprise,'enterprise.tenant_id'),null);assert.deepEqual([record.id,address.id],oldIds);
 state.tenantId='123';upgradeSourceState(state);assert.equal(value(enterprise,'enterprise.tenant_id'),'123');const once=JSON.stringify(state);upgradeSourceState(state);assert.equal(JSON.stringify(state),once);
});

test('saved FTP standard mappings write all 13 modules and retain distinct 1:N records and row provenance',()=>{
 const state=base();upgradeFtpSources(state);const file=getFtpFiles(state,'ftp_qcc')[0];const result=importFtpFile(state,'ftp_qcc',file.id,{mode:'full',now:NOW});assert.equal(result.task.failed,0);
 const record=state.records[0];assert.equal(records(state,'enterprise_contact').length,2);assert.equal(records(state,'enterprise_annual_operation').length,2);assert.equal(records(state,'enterprise_patent').length,2);assert.equal(records(state,'enterprise_shareholder').length,2);
 for(const table of DICTIONARY_TABLES){assert.ok(Array.isArray(record.tables[table.key]));for(const detail of record.tables[table.key]){assert.ok(detail.id);assert.ok(detail.rowKey);assert.equal(detail.enterpriseId,record.id);assert.deepEqual(detail.sources,['ftp_qcc']);}}
 assert.equal(record.registeredCapitalWan,26000);assert.equal(records(state,'enterprise')[0].values['enterprise.registered_capital'],260000000);
 const summary=records(state,'enterprise_intellectual_property_summary')[0];assert.equal(value(summary,'enterprise_intellectual_property_summary.invention_patent_count'),null);
});

test('flat repeated rows for the same enterprise retain separate business rows, and missing arrays do not delete facts',()=>{
 const state=base();state.mappings.ftp_qcc=[{sourceField:'company_name',targetField:'enterprise.enterprise_name'},{sourceField:'credit_code',targetField:'enterprise.unified_social_credit_code'},{sourceField:'year',targetField:'enterprise_annual_operation.fiscal_year'},{sourceField:'revenue',targetField:'enterprise_annual_operation.annual_revenue'}];
 applyBatch(state,{sourceId:'ftp_qcc',rows:[row({year:2024,revenue:100}),row({year:2025,revenue:200})],mode:'full',now:NOW});assert.equal(state.records.length,1);assert.equal(records(state,'enterprise_annual_operation').length,2);
 const ids=records(state,'enterprise_annual_operation').map(r=>r.id);
 applyBatch(state,{sourceId:'ftp_qcc',rows:[row({year:2025,revenue:300,sourceUpdatedAt:'2026-11-06T00:00:00Z'})],mode:'full',now:'2026-11-06T01:00:00Z'});
 assert.deepEqual(records(state,'enterprise_annual_operation').map(r=>r.id),ids);assert.deepEqual(records(state,'enterprise_annual_operation').map(r=>value(r,'enterprise_annual_operation.annual_revenue')),[100,300]);
});

test('same-source row updates merge by business identity, reject stale rows independently, and preserve absent fields',()=>{
 const state=base();applyBatch(state,{sourceId:'ftp_qcc',rows:[row({annual_operations:[{fiscal_year:2024,annual_revenue:100,employee_count:8},{fiscal_year:2025,annual_revenue:200}]})],now:NOW});
 applyBatch(state,{sourceId:'ftp_qcc',rows:[row({annual_operations:[{fiscal_year:2024,annual_revenue:500}],sourceUpdatedAt:'2026-11-06T00:00:00Z'})],now:'2026-11-06T01:00:00Z'});
 const detail=records(state,'enterprise_annual_operation').find(r=>value(r,'enterprise_annual_operation.fiscal_year')===2024);assert.equal(value(detail,'enterprise_annual_operation.employee_count'),8);assert.equal(value(detail,'enterprise_annual_operation.annual_revenue'),500);
 applyBatch(state,{sourceId:'ftp_qcc',rows:[row({annual_operations:[{fiscal_year:2024,annual_revenue:1}],sourceUpdatedAt:'2026-11-04T00:00:00Z'})],now:NOW});
 assert.equal(value(records(state,'enterprise_annual_operation').find(r=>r.id===detail.id),'enterprise_annual_operation.annual_revenue'),500);assert.equal(records(state,'enterprise_annual_operation').length,2);
});

test('malformed nested rows are isolated, leave valid sibling records intact and do not advance cursor',()=>{
 const state=base();const task=applyBatch(state,{sourceId:'ftp_qcc',rows:[row({annual_operations:[{fiscal_year:2024,annual_revenue:100},{annual_revenue:200},{fiscal_year:2025,annual_revenue:'bad'}]})],now:NOW}).task;
 assert.equal(task.status,'partial');assert.equal(task.failed,2);assert.equal(records(state,'enterprise_annual_operation').length,1);assert.equal(state.schedules.ftp_qcc.lastCursor,null);assert.match(task.errors[0].message,/会计年度/);
});

test('different arrays cannot be joined into one table; generated IDs and provenance cannot be vendor mappings',()=>{
 const state=base();state.mappings.ftp_qcc.push({sourceField:'alt[].employee_count',targetField:'enterprise_annual_operation.employee_count'});assert.equal(validateMappings(state,'ftp_qcc').valid,false);
 for(const key of ['enterprise.id','enterprise.tenant_id','enterprise_contact.enterprise_id','enterprise_patent.provenance_id']){const current=base();current.mappings.ftp_qcc.push({sourceField:'evil',targetField:key});assert.match(validateMappings(current,'ftp_qcc').errors.join(';'),/中心生成/);assert.throws(()=>applyBatch(current,{sourceId:'ftp_qcc',rows:[row({evil:99})],now:NOW}),/中心生成/);assert.equal(current.records.length,0);}
});

test('row-scoped manual source follows only matching identity, falls back on null, and restores without affecting other rows',()=>{
 const state=base(),key='enterprise_annual_operation.annual_revenue';
 for(const [sourceId,amount]of [['ftp_qcc',100],['ftp_qxb',200]])applyBatch(state,{sourceId,rows:[row({annual_operations:[{fiscal_year:2024,annual_revenue:amount},{fiscal_year:2025,annual_revenue:amount+1}]})],now:NOW});
 const [first,second]=records(state,'enterprise_annual_operation'),id=state.records[0].id;setFieldSourceOverride(state,id,key,'ftp_qxb',{rowId:first.id,now:NOW});
 assert.equal(value(records(state,'enterprise_annual_operation')[0],key),200);assert.equal(value(records(state,'enterprise_annual_operation')[1],key),101);assert.equal(getLineage(state,id,key,{rowId:first.id}).manualApplied,true);
 state.priorities[key]=['ftp_qcc','file','ftp_tyc','ftp_qxb'];recomputeRecords(state,{now:NOW});assert.equal(value(records(state,'enterprise_annual_operation')[0],key),200);
 applyBatch(state,{sourceId:'ftp_qxb',rows:[row({sourceUpdatedAt:'2026-11-06T00:00:00Z',annual_operations:[{fiscal_year:2024,annual_revenue:null}]})],now:'2026-11-06T01:00:00Z'});assert.equal(value(records(state,'enterprise_annual_operation')[0],key),100);assert.equal(getLineage(state,id,key,{rowId:first.id}).fallback,true);
 applyBatch(state,{sourceId:'ftp_qxb',rows:[row({sourceUpdatedAt:'2026-11-07T00:00:00Z',annual_operations:[{fiscal_year:2024,annual_revenue:300}]})],now:'2026-11-07T01:00:00Z'});assert.equal(value(records(state,'enterprise_annual_operation')[0],key),300);assert.equal(records(state,'enterprise_annual_operation')[1].id,second.id);
 clearFieldSourceOverride(state,id,key,{rowId:first.id,now:NOW});assert.equal(value(records(state,'enterprise_annual_operation')[0],key),100);
});

test('unrelated patents and shareholder rows never fuse by array position; source-local row IDs cannot merge sources',()=>{
 const state=base();applyBatch(state,{sourceId:'ftp_qcc',rows:[row({patents:[{application_no:'A-1',patent_name:'演示A',patent_type:'发明'}],shareholders:[{subject_name:'演示股东甲',subject_type:'自然人',direct_ownership_percent:60}]})],now:NOW});
 applyBatch(state,{sourceId:'ftp_qxb',rows:[row({patents:[{application_no:'B-1',patent_name:'演示B',patent_type:'实用新型'}],shareholders:[{subject_name:'演示股东乙',subject_type:'自然人',direct_ownership_percent:40}]})],now:NOW});
 assert.equal(records(state,'enterprise_patent').length,2);assert.equal(records(state,'enterprise_shareholder').length,2);
 for(const patent of records(state,'enterprise_patent'))assert.equal(patent.sources.length,1);
});

test('nested conversion runner receives root row, collection index and item, and lineage retains actual script',()=>{
 const state=base();state.scripts.push({id:'double',status:'published',version:3});state.mappings.ftp_qcc.find(m=>m.targetField==='enterprise_annual_operation.annual_revenue').scriptId='double';
 const input=row({annual_operations:[{fiscal_year:2024,annual_revenue:100},{fiscal_year:2025,annual_revenue:200}]});
 const task=applyBatch(state,{sourceId:'ftp_qcc',rows:[input],now:NOW,runScript:(script,value,ctx)=>{if(script.id==='double'){assert.equal(ctx.row,input);assert.equal(ctx.item,input.annual_operations[ctx.collectionIndex]);return value*2;}return value;}}).task;
 assert.equal(task.failed,0);assert.deepEqual(records(state,'enterprise_annual_operation').map(r=>value(r,'enterprise_annual_operation.annual_revenue')),[200,400]);assert.equal(records(state,'enterprise_annual_operation')[0].lineage['enterprise_annual_operation.annual_revenue'].selected.script.version,3);
});

test('old configuration and original evidence survive idempotent source upgrades',()=>{
 const state=base();state.providers=[{...state.providers[0],id:'ftp_demo',name:'我的定制数据源',ftpConfig:{...state.providers[0].ftpConfig,host:'custom.example.invalid'}},state.providers.at(-1)];state.mappings.ftp_demo=[{sourceField:'company',targetField:'enterpriseName'},{sourceField:'code',targetField:'creditCode'}];state.schedules.ftp_demo={lastCursor:'2026-10-26T00:00:00Z',enabled:false};state.priorities={enterpriseName:['file','ftp_demo']};
 applyBatch(state,{sourceId:'ftp_demo',rows:[{company:'演示旧库企业',code:CODE,sourceUpdatedAt:NOW}],now:NOW});const before=JSON.stringify(state.rawRecords),id=state.records[0].id,mappings=JSON.stringify(state.mappings.ftp_demo);
 upgradeSourceState(state);assert.equal(state.providers[0].name,'我的定制数据源');assert.equal(state.providers[0].ftpConfig.host,'custom.example.invalid');assert.equal(JSON.stringify(state.rawRecords),before);assert.equal(JSON.stringify(state.mappings.ftp_demo),mappings);assert.equal(state.records[0].id,id);assert.deepEqual(state.priorities['enterprise.enterprise_name'].slice(0,2),['file','ftp_demo']);
 const once=JSON.stringify(state);upgradeSourceState(state);assert.equal(JSON.stringify(state),once);assert.ok(state.providers.some(p=>p.id==='ftp_qxb'));
});


test('unchanged historical demo is retired while retaining facts and its jobs, leaving exactly three active vendor FTPs',()=>{
 const state=base(),defaults=state.providers[0];state.providers=[{...defaults,id:'ftp_demo',name:'企业数据 FTP 信源'},state.providers.at(-1)];
 const sources=['company_name','credit_code','legal_person','registration_status','established_at','capital_wan','province','city','district','industry','business_scope','registered_address','qualifications','scale','chain_nodes'];
 const targets=['enterpriseName','creditCode','legalPerson','registrationStatus','establishedAt','registeredCapitalWan','regionProvince','regionCity','regionDistrict','industry','businessScope','registeredAddress','qualifications','scale','chainNodes'];
 state.mappings.ftp_demo=targets.map((targetField,i)=>({sourceField:sources[i],targetField,scriptId:['qualifications','chainNodes'].includes(targetField)?'split_values':'',enabled:true}));state.schedules.ftp_demo={enabled:true,lastCursor:'2026-11-04T00:00:00Z'};
 applyBatch(state,{sourceId:'ftp_demo',rows:[row({legal_person:'演示原始法人'})],now:NOW});state.updateJobs=[{id:'historical-job',sourceId:'ftp_demo',enabled:true,nextRunAt:NOW,lastCursor:'2026-11-04T00:00:00Z'}];const before=JSON.stringify(state.rawRecords),id=state.records[0].id;
 upgradeSourceState(state);assert.deepEqual(state.providers.filter(p=>p.type==='ftp'&&!p.retired).map(p=>p.id),['ftp_qcc','ftp_qxb','ftp_tyc']);assert.equal(state.providers[0].retired,true);assert.equal(state.providers[0].enabled,false);assert.equal(state.updateJobs[0].retired,true);assert.equal(state.updateJobs[0].lastCursor,'2026-11-04T00:00:00Z');assert.equal(state.updateJobs[0].nextRunAt,null);assert.equal(JSON.stringify(state.rawRecords),before);assert.equal(state.records[0].id,id);assert.equal(state.records[0].lineage.enterpriseName.selected.sourceId,'ftp_demo');
 assert.throws(()=>applyBatch(state,{sourceId:'ftp_demo',rows:[row()],now:NOW}),/不可继续接入/);
});
