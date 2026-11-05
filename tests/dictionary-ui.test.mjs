import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createInitialState,FIELD_DEFS,getTableRecords} from '../public/prototype/core.mjs';
import {DICTIONARY_TABLES,getTableFields} from '../public/prototype/enterprise-dictionary.mjs';
import {upgradeFtpSources,renderFtpSources,handleFtpAction,handleFtpFormEvent,selectFtpSource,getFtpFiles,importFtpFile,createFtpSource} from '../public/prototype/ftp-sources.mjs';

function context(state){const ctx={toasts:[],html:'',renders:0,getState:()=>state,render:()=>{ctx.renders++;ctx.html=renderFtpSources(state);},mutate:async fn=>{await fn();ctx.render();return true;},toast:(...args)=>ctx.toasts.push(args),showModal(){},closeModal(){}};return ctx;}
const event=(index,prop,value,type='change')=>({type,target:{dataset:{mappingProp:prop},value,checked:Boolean(value),matches:()=>false,closest:()=>({dataset:{ftpMappingIndex:String(index)}})}});
const op=(ctx,action,id,extra={})=>handleFtpAction(`ftp-${action}`,{dataset:{id,...extra}},ctx);

test('FTP field mapping chooses a child table before its fields and can append or remove a draft row',async()=>{
 const state=upgradeFtpSources(createInitialState({seed:false})),id='ftp_qcc',ctx=context(state);selectFtpSource(id);await op(ctx,'tab',id,{tab:'mappings'});
 assert.match(ctx.html,/先选目标子表/);assert.match(ctx.html,/全部13个模块/);assert.match(ctx.html,/data-mapping-prop="targetTable"/);assert.ok((ctx.html.match(/data-ftp-mapping-index=/g)||[]).length<257);
 for(const field of FIELD_DEFS.filter(f=>f.technical))assert.ok(!ctx.html.includes(`<option value="${field.key}"`),`${field.key} must not be vendor mappable`);
 await op(ctx,'mapping-add',id);const index=state.mappings[id].length;
 let row=ctx.html.split(`data-ftp-mapping-index="${index}"`)[1].split('</tr>')[0];assert.match(row,/data-mapping-prop="targetField" disabled/);
 handleFtpFormEvent(event(index,'targetTable','enterprise_contact'),ctx);handleFtpFormEvent(event(index,'targetField','enterprise_contact.contact_phone'),ctx);
 handleFtpFormEvent(event(index,'targetTable','enterprise_patent'),ctx);
 row=ctx.html.split(`data-ftp-mapping-index="${index}"`)[1].split('</tr>')[0];assert.match(row,/请选择目标字段/);assert.ok(!row.includes('<option value="enterprise_contact.contact_phone" selected>'));
 await op(ctx,'mapping-remove',id,{index});assert.equal((ctx.html.match(/data-ftp-mapping-index=/g)||[]).length,index);
});

test('FTP virtual files contain true nested collections and each source uses the standard dictionary',()=>{
 const state=upgradeFtpSources(createInitialState({seed:false}));
 for(const provider of state.providers.filter(p=>p.type==='ftp'&&!p.retired)){
  const mappings=state.mappings[provider.id];assert.ok(mappings.every(m=>FIELD_DEFS.some(f=>f.key===m.targetField&&f.mappable)));
  const files=getFtpFiles(state,provider.id),row=files[0].rows[0];assert.equal(row.contacts.length,2);assert.equal(row.annual_operations.length,2);assert.equal(row.patents.length,2);assert.ok(row._synthetic);assert.match(row.credit_code,/^DEMO-/);
  assert.deepEqual(JSON.parse(files[0].text)[0].contacts,row.contacts);
 }
});

test('FTP standard mapped collections land as multiple independent detail records',()=>{
 const state=upgradeFtpSources(createInitialState({seed:false})),sourceId='ftp_qcc';const result=importFtpFile(state,sourceId,'full-v1',{mode:'full',now:'2026-11-05T00:00:00Z'});
 assert.equal(result.task.failed,0);const record=state.records[0];assert.ok(record.chainNodes.length>0,'standard tag collection keeps the legacy chain-node service projection');
 for(const key of ['enterprise_contact','enterprise_annual_operation','enterprise_patent'])assert.equal(getTableRecords(state,record.id,key).length,2,key);
 for(const table of DICTIONARY_TABLES){const rows=getTableRecords(state,record.id,table.key);assert.ok(Array.isArray(rows));for(const row of rows)assert.ok(getTableFields(table.key).some(f=>Object.hasOwn(row.values,f.key)));}
});

test('new FTP source keeps all active sources before retired provenance sources in every priority',()=>{
 const state=upgradeFtpSources(createInitialState({seed:false}));state.providers.push({id:'retired_vendor',name:'历史来源',type:'api',retired:true});for(const field of FIELD_DEFS)state.priorities[field.key]=['ftp_qcc','file','retired_vendor'];
 createFtpSource(state,{id:'ftp_extra',name:'新增FTP'});assert.ok(Object.values(state.priorities).filter(order=>order.includes('retired_vendor')).every(order=>order.indexOf('ftp_extra')<order.indexOf('retired_vendor')));
});

test('enterprise and priority UI retain all thirteen modules, row scoped lineage and third/fourth ranks',async()=>{
 const app=await readFile(new URL('../public/prototype/app.js',import.meta.url),'utf8');
 assert.match(app,/getTableRecords\(state,r.id,table.key\)/);assert.match(app,/data-action="detail-module"/);assert.match(app,/data-row="\$\{esc\(row.id\)\}"/);assert.match(app,/getLineage\(state,id,field,\{rowId\}\)/);assert.match(app,/仅当前企业当前明细当前字段/);assert.match(app,/lineage-row-location/);assert.match(app,/横向滚动查看完整字段/);assert.match(app,/\['一','二','三','四'\]/);assert.match(app,/rules=\{\.\.\.state.priorities\}/);assert.doesNotMatch(app,/card\('专题补充'/);assert.match(app,/批量订阅推送/);assert.match(app,/标准 API 服务/);
});


test('retired FTP sources cannot be selected, configured or imported',async()=>{
 const state=upgradeFtpSources(createInitialState({seed:false})),ctx=context(state),provider=state.providers.find(p=>p.id==='ftp_qcc');provider.retired=true;selectFtpSource('ftp_qcc');
 const html=renderFtpSources(state);assert.ok(!html.includes('data-action="ftp-select" data-id="ftp_qcc"'));
 assert.throws(()=>getFtpFiles(state,'ftp_qcc'),/不存在/);assert.throws(()=>importFtpFile(state,'ftp_qcc','full-v1'),/不存在/);
 for(const action of ['select','tab','preview','save-config','save-mappings'])await op(ctx,action,'ftp_qcc',{tab:'mappings',file:'full-v1'});
 assert.equal(ctx.toasts.length,5);assert.ok(ctx.toasts.every(([message])=>message.includes('停用')));
});

test('historical mapping displays its standard table and preserves original units until edited',async()=>{
 const state=upgradeFtpSources(createInitialState({seed:false})),provider=createFtpSource(state,{id:'legacy_custom',name:'历史自定义FTP'}),ctx=context(state);
 const mappings=[{sourceField:'company_name',targetField:'enterpriseName',scriptId:'',enabled:true},{sourceField:'credit_code',targetField:'creditCode',scriptId:'',enabled:true},{sourceField:'capital_wan',targetField:'registeredCapitalWan',scriptId:'',enabled:true}];
 state.mappings[provider.id]=structuredClone(mappings);selectFtpSource(provider.id);await op(ctx,'tab',provider.id,{tab:'mappings'});
 assert.match(ctx.html,/历史映射：保留原字段及加工规则/);assert.match(ctx.html,/<option value="enterprise.registered_capital" selected>/);await op(ctx,'save-mappings',provider.id);assert.deepEqual(state.mappings[provider.id],mappings);
});
