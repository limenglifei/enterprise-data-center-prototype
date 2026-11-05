import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createInitialState,getTableRecords} from '../public/prototype/core.mjs';
import {DICTIONARY_TABLES,getTableFields} from '../public/prototype/enterprise-dictionary.mjs';
import {upgradeFtpSources,importFtpFile} from '../public/prototype/ftp-sources.mjs';

const app=await readFile(new URL('../public/prototype/app.js',import.meta.url),'utf8');
const helpers=app.slice(app.indexOf('function detailSectionId('),app.indexOf('\nfunction taskDetail('));
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function uiContext(state,extra={}){return {state,DICTIONARY_TABLES,getTableFields,getTableRecords,esc,format:value=>value==null||value===''?'—':Array.isArray(value)?value.join('、'):String(value),date:String,badge:(text)=>`<span class="badge">${esc(text)}</span>`,sourceName:id=>state.providers.find(provider=>provider.id===id)?.name||id,detailModule:'enterprise',...extra};}

test('enterprise dossier renders thirteen continuous modules and every independent record vertically',()=>{
 const state=upgradeFtpSources(createInitialState({seed:false}));importFtpFile(state,'ftp_qcc','full-v1',{mode:'full',now:'2026-11-05T00:00:00Z'});
 const context=uiContext(state);runInNewContext(helpers+';html=detailsPanel(state.records[0]);',context);const html=context.html,record=state.records[0];
 assert.equal((html.match(/class="module-detail"/g)||[]).length,DICTIONARY_TABLES.length);assert.doesNotMatch(html,/<table|横向滚动/);
 let previous=-1;
 for(const table of DICTIONARY_TABLES){
  const sectionId=`enterprise-module-${record.id}-${table.key}`,position=html.indexOf(`id="${sectionId}"`);assert.ok(position>previous,`${table.key} follows dictionary order`);previous=position;
  const rows=getTableRecords(state,record.id,table.key),section=html.split(`data-module-key="${table.key}"`)[1].split('</section>')[0];
  assert.equal((section.match(/class="module-record-card /g)||[]).length,rows.length||1,table.key);
  for(const field of getTableFields(table.key))assert.equal((section.match(new RegExp(`data-field-key="${field.key.replaceAll('.','\\.')}"`,'g'))||[]).length,rows.length||1,field.key);
  for(const row of rows){assert.ok(section.includes(`data-record-id="${esc(row.id)}"`));for(const field of getTableFields(table.key).filter(field=>!field.technical))assert.ok(section.includes(`data-field="${field.key}" data-row="${esc(row.id)}"`),'each source button keeps the independent record ID');}
 }
 const expected=DICTIONARY_TABLES.reduce((sum,table)=>sum+getTableFields(table.key).length,0);assert.match(html,new RegExp(`<strong>${expected}</strong> 个标准字段`));
 assert.match(html,/<details class="technical-fields"/);assert.doesNotMatch(html,/<details class="technical-fields"[^>]*\sopen/);
});

test('uncollected modules retain all field names without inventing records or source candidates',()=>{
 const state=upgradeFtpSources(createInitialState({seed:false})),context=uiContext(state,{record:{id:'uncollected',enterpriseName:'待采集企业'}});
 runInNewContext(helpers+';html=detailsPanel(record);',context);const html=context.html;
 for(const table of DICTIONARY_TABLES)for(const field of getTableFields(table.key))assert.ok(html.includes(`data-field-key="${field.key}"`),field.key);
 assert.equal((html.match(/data-record-index=/g)||[]).length,0);assert.doesNotMatch(html,/data-action="lineage"/);assert.match(html,/尚未采集/);assert.match(html,/待采集字段/);
});

test('module anchors preserve the rendered dossier and source return restores the exact record context',()=>{
 const calls=[],buttons=DICTIONARY_TABLES.map(table=>({dataset:{table:table.key},classList:{toggle:(key,on)=>calls.push(['active',table.key,on])},setAttribute(){},removeAttribute(){}})),section={dataset:{moduleKey:'enterprise_risk_event'},scrollIntoView:options=>calls.push(['scroll',options.block]),focus:options=>calls.push(['section-focus',options.preventScroll])};
 const technical=[{dataset:{technicalRecord:'risk-row-2'},open:true},{dataset:{technicalRecord:'risk-row-1'},open:false}],origin={dataset:{row:'row-2',field:'enterprise_risk_event.event_title'},focus:options=>calls.push(['source-focus',options.preventScroll])},body={scrollTop:1830},root={innerHTML:''};
 const dossier={dataset:{enterpriseId:'enterprise-1',inPage:'false'},querySelectorAll:selector=>selector==='[data-action="detail-module"]'?buttons:selector==='[data-module-key]'?[section]:selector==='.technical-fields[open]'?technical.filter(item=>item.open):selector==='.technical-fields'?technical:selector==='[data-action="lineage"]'?[origin]:[],closest:()=>body};
 const state={records:[{id:'enterprise-1'}],providers:[]},context=uiContext(state,{$:selector=>selector==='#modal-root'?{...root,querySelector:()=>dossier}:null,showModal:()=>calls.push(['show-parent']),btn:()=>'',window:{scrollY:0},detailEnterpriseId:'',detailReturnContext:null});
 runInNewContext(helpers+';focusDetailModule("enterprise-1","enterprise_risk_event");',context);assert.ok(calls.some(call=>call[0]==='scroll'));assert.equal(calls.filter(call=>call[0]==='show-parent').length,0,'an anchor never replaces the dossier');
 context.button={dataset:origin.dataset,closest:selector=>selector==='.enterprise-dossier'?dossier:section};runInNewContext('rememberEnterpriseContext(button);',context);
 assert.equal(context.detailReturnContext.rowId,'row-2');assert.equal(context.detailReturnContext.field,'enterprise_risk_event.event_title');assert.equal(context.detailReturnContext.scrollTop,1830);
 technical[0].open=false;body.scrollTop=0;context.detailsPanel=()=>'';
 runInNewContext('restoreEnterpriseContext(detailReturnContext);',context);
 assert.equal(body.scrollTop,1830);assert.equal(technical[0].open,true);assert.equal(technical[1].open,false);assert.ok(calls.some(call=>call[0]==='source-focus'&&call[1]===true));
});
