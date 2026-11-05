import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,createDefaultFtpMappings,applyBatch,getTableRecords,getLineage,recomputeRecords,setFieldSourceOverride,clearFieldSourceOverride,LEGACY_FIELD_DEFS} from '../public/prototype/core.mjs';
import {getDictionaryField} from '../public/prototype/enterprise-dictionary.mjs';
import {upgradeSourceState} from '../public/prototype/source-config.mjs';
import {getFtpFiles,importFtpFile,upgradeFtpSources,renderFtpSources,selectFtpSource,handleFtpAction} from '../public/prototype/ftp-sources.mjs';
import {publicEnterprise,upgradeApiServices,runApiService} from '../public/prototype/api-services.mjs';
import {querySqlRecords} from '../public/prototype/sql-services.mjs';
import {createSubscription,previewSubscription} from '../public/prototype/subscription-services.mjs';

const NOW='2026-11-05T01:00:00Z',DATE='enterprise_risk_event.published_date',AUTHORITY='enterprise_risk_event.publishing_authority';
const keys=[DATE,AUTHORITY],base=()=>createInitialState({seed:false});
const event=(title,date='2026-10-10',authority='演示发布机构甲（虚构）')=>({risk_type:'演示风险',event_title:title,published_date:date,publishing_authority:authority});
const input=(risk_events,sourceUpdatedAt=NOW)=>({company_name:'演示风险字段测试企业（虚构）',credit_code:'DEMO-V26-RISK-001',risk_events,sourceUpdatedAt,_synthetic:true});
const rows=state=>getTableRecords(state,state.records[0].id,'enterprise_risk_event');
const byTitle=(state,title)=>rows(state).find(row=>row.values['enterprise_risk_event.event_title']===title);

test('V2.6 risk mappings save, import two synthetic events, persist and retain field and row evidence',async()=>{
  const state=upgradeFtpSources(base());selectFtpSource('ftp_qcc');
  const ctx={getState:()=>state,render(){},toast(){},mutate:async fn=>{await fn();return true;}};
  await handleFtpAction('ftp-tab',{dataset:{id:'ftp_qcc',tab:'mappings'}},ctx);
  const html=renderFtpSources(state);for(const key of keys)assert.ok(html.includes(`value="${key}"`));
  await handleFtpAction('ftp-save-mappings',{dataset:{id:'ftp_qcc'}},ctx);
  for(const key of keys)assert.ok(state.mappings.ftp_qcc.some(m=>m.targetField===key&&m.sourceField===`risk_events[].${getDictionaryField(key).name}`));
  const file=getFtpFiles(state,'ftp_qcc')[0],sample=file.rows[0];
  assert.match(sample.credit_code,/^DEMO-/);assert.equal(sample._synthetic,true);assert.equal(sample.risk_events.length,2);
  assert.equal(new Set(sample.risk_events.map(event=>event.event_title)).size,2);
  assert.ok(sample.risk_events.every(event=>/^\d{4}-\d{2}-\d{2}$/.test(event.published_date)&&event.publishing_authority.includes('虚构')));
  assert.equal(importFtpFile(state,'ftp_qcc',file.id,{mode:'full',now:NOW}).task.failed,0);
  assert.equal(rows(state).length,2);
  for(const [index,row] of rows(state).entries()){
    assert.equal(row.values[DATE],sample.risk_events[index].published_date);assert.equal(row.values[AUTHORITY],sample.risk_events[index].publishing_authority);
    assert.equal(row.values['enterprise_risk_event.severity'],null);
    for(const key of keys){const lineage=getLineage(state,state.records[0].id,key,{rowId:row.id});assert.equal(lineage.selected.rawField,`risk_events[].${getDictionaryField(key).name}`);assert.equal(lineage.selected.sourceId,'ftp_qcc');assert.equal(lineage.selected.rowId,row.id);}
  }
  const raw=state.rawRecords.find(raw=>raw.recordId===state.records[0].id);
  for(const mapped of raw.tableRows.filter(row=>row.table==='enterprise_risk_event')){assert.match(mapped.rawPath,/^risk_events\[\d\]$/);assert.ok(mapped.raw.publishing_authority.includes('虚构'));}
  const saved=JSON.parse(JSON.stringify(state)),before=JSON.stringify(rows(saved));upgradeSourceState(saved);recomputeRecords(saved,{now:NOW});assert.equal(JSON.stringify(rows(saved)),before);
});

test('risk publication fields follow source rank and row-specific pins without changing risk identities',()=>{
  const state=base();
  applyBatch(state,{sourceId:'ftp_qcc',rows:[input([event('演示事件甲'),event('演示事件乙','2026-10-11')])],now:NOW});
  // Reversing a second source array must still join by the original event identity.
  applyBatch(state,{sourceId:'ftp_qxb',rows:[input([event('演示事件乙','2026-10-21','演示机构乙二（虚构）'),event('演示事件甲','2026-10-20','演示机构乙一（虚构）')])],now:NOW});
  const ids=rows(state).map(row=>row.id),first=byTitle(state,'演示事件甲'),second=byTitle(state,'演示事件乙'),enterpriseId=state.records[0].id;
  for(const key of keys){state.priorities[key]=['ftp_qxb','ftp_qcc','ftp_tyc','file'];}recomputeRecords(state,{now:NOW});
  assert.equal(byTitle(state,'演示事件甲').values[DATE],'2026-10-20');assert.equal(byTitle(state,'演示事件乙').values[DATE],'2026-10-21');
  const rawBeforePin=JSON.stringify(state.rawRecords);setFieldSourceOverride(state,enterpriseId,AUTHORITY,'ftp_qcc',{rowId:first.id,now:NOW});
  assert.equal(byTitle(state,'演示事件甲').values[AUTHORITY],'演示发布机构甲（虚构）');assert.equal(byTitle(state,'演示事件乙').values[AUTHORITY],'演示机构乙二（虚构）');assert.equal(JSON.stringify(state.rawRecords),rawBeforePin);
  assert.equal(getLineage(state,enterpriseId,AUTHORITY,{rowId:first.id}).manualApplied,true);
  applyBatch(state,{sourceId:'ftp_qcc',rows:[input([event('演示事件甲','2026-10-22','演示更新机构（虚构）')],'2026-11-05T02:00:00Z')],now:'2026-11-05T02:00:00Z'});
  assert.equal(byTitle(state,'演示事件甲').values[AUTHORITY],'演示更新机构（虚构）');assert.deepEqual(rows(state).map(row=>row.id),ids);
  applyBatch(state,{sourceId:'ftp_qcc',rows:[input([event('演示事件甲',null,null)],'2026-11-05T03:00:00Z')],now:'2026-11-05T03:00:00Z'});
  assert.equal(getLineage(state,enterpriseId,AUTHORITY,{rowId:first.id}).fallback,true);assert.equal(byTitle(state,'演示事件甲').values[AUTHORITY],'演示机构乙一（虚构）');
  applyBatch(state,{sourceId:'ftp_qcc',rows:[input([event('演示事件甲','2026-10-23','演示恢复机构（虚构）')],'2026-11-05T04:00:00Z')],now:'2026-11-05T04:00:00Z'});
  assert.equal(byTitle(state,'演示事件甲').values[AUTHORITY],'演示恢复机构（虚构）');
  const loaded=JSON.parse(JSON.stringify(state));upgradeSourceState(loaded);recomputeRecords(loaded,{now:'2026-11-05T04:00:00Z'});
  assert.equal(byTitle(loaded,'演示事件甲').id,first.id);assert.equal(getLineage(loaded,enterpriseId,AUTHORITY,{rowId:first.id}).manualApplied,true);
  clearFieldSourceOverride(loaded,enterpriseId,AUTHORITY,{rowId:first.id,now:'2026-11-05T04:00:00Z'});
  assert.equal(byTitle(loaded,'演示事件甲').values[AUTHORITY],'演示机构乙一（虚构）');assert.equal(byTitle(loaded,'演示事件乙').id,second.id);assert.deepEqual(rows(loaded).map(row=>row.id),ids);
});

test('risk date and publisher validation isolate invalid siblings while keeping explicit unknowns null',()=>{
  const state=base(),result=applyBatch(state,{sourceId:'ftp_qcc',rows:[input([
    event('演示已知','2024-02-29'),event('演示未知',null,null),
    event('演示无效日期','2026-02-30'),event('演示无效机构','2026-10-01','字'.repeat(201))
  ])],now:NOW});
  assert.equal(result.task.status,'partial');assert.equal(result.task.failed,2);assert.equal(rows(state).length,2);
  assert.equal(byTitle(state,'演示未知').values[DATE],null);assert.equal(byTitle(state,'演示未知').values[AUTHORITY],null);
  assert.match(result.task.errors.map(error=>error.message).join(';'),/发布日期日期无效/);assert.match(result.task.errors.map(error=>error.message).join(';'),/发布机构最多200/);
});

test('V2.5 upgrade adds nullable columns and untouched defaults once, preserving original evidence and customized mappings',()=>{
  const state=base();applyBatch(state,{sourceId:'ftp_qcc',rows:[input([event('演示历史事件',null,null)])],now:NOW});
  const id=rows(state)[0].id,rowKey=rows(state)[0].rowKey;
  for(const key of keys){delete rows(state)[0].values[key];delete rows(state)[0].lineage[key];delete state.priorities[key];}
  for(const sourceId of ['ftp_qcc','ftp_qxb','ftp_tyc'])state.mappings[sourceId]=createDefaultFtpMappings().filter(mapping=>!keys.includes(mapping.targetField));
  state.mappings.ftp_qxb.find(mapping=>mapping.targetField==='enterprise_risk_event.event_title').sourceField='custom_events[].title';
  const custom=JSON.stringify(state.mappings.ftp_qxb),originalRaw=JSON.stringify(state.rawRecords);state.schemaVersion=2.5;
  upgradeSourceState(state);assert.equal(state.schemaVersion,2.6);assert.equal(rows(state)[0].id,id);assert.equal(rows(state)[0].rowKey,rowKey);assert.equal(JSON.stringify(state.rawRecords),originalRaw);assert.equal(JSON.stringify(state.mappings.ftp_qxb),custom);
  for(const key of keys){assert.equal(rows(state)[0].values[key],null);assert.equal(getLineage(state,state.records[0].id,key,{rowId:id}).selected,null);assert.ok(state.priorities[key]);assert.ok(state.mappings.ftp_qcc.some(m=>m.targetField===key));}
  const once=JSON.stringify(state);upgradeSourceState(state);assert.equal(JSON.stringify(state),once);
  state.mappings.ftp_qcc=state.mappings.ftp_qcc.filter(m=>m.targetField!==DATE);upgradeSourceState(state);assert.equal(state.mappings.ftp_qcc.some(m=>m.targetField===DATE),false);
});

test('risk extensions stay internal to the 13-table dictionary and do not expand public API, SQL or subscription fields',()=>{
  const state=base();applyBatch(state,{sourceId:'ftp_qcc',rows:[input([event('演示内部风险')])],now:NOW});
  const expected=['enterpriseId',...LEGACY_FIELD_DEFS.map(field=>field.key),'dataUpdatedAt'].sort();assert.equal(LEGACY_FIELD_DEFS.length,15);
  assert.deepEqual(Object.keys(publicEnterprise(state.records[0])).sort(),expected);
  upgradeApiServices(state);state.apiServices.find(service=>service.id==='query').status='published';
  const result=runApiService(state,'query',{keyword:state.records[0].creditCode},{now:NOW});assert.equal(result.httpStatus,200);assert.deepEqual(Object.keys(result.body.data.record).sort(),expected);
  assert.deepEqual(querySqlRecords(state.records,'SELECT * FROM enterprises LIMIT 10').columns.sort(),expected);
  const subscription=createSubscription(state,{name:'演示字段范围检查',description:'仅演示',webhookUrl:'https://example.invalid/hook',frequency:'manual',mode:'full',filters:{industries:[],regions:[],qualifications:[]}});
  assert.deepEqual(Object.keys(previewSubscription(state,subscription)[0]).sort(),expected);
  for(const key of keys)assert.ok(!JSON.stringify(result.body).includes(key));assert.ok(!JSON.stringify(result.body).includes('publishing_authority'));
});
