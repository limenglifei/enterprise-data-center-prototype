import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {normalizeInventoryFilters,changeInventoryDraft,inventoryOptions,filterInventory} from '../public/prototype/inventory-filters.mjs';
import {INDUSTRY_STANDARD_VERSION,INDUSTRY_LEVEL_LABELS,formatIndustryPaths,industryChildren} from '../public/prototype/industry-classification.mjs';

const records=[
  {id:'a',enterpriseName:'甲方设备企业',creditCode:'CODE-A',regionProvince:'甲省',regionCity:'中心市',regionDistrict:'东区',industry:'制造业',qualifications:[],chainNodes:[]},
  {id:'b',enterpriseName:'乙方服务企业',creditCode:'CODE-B',regionProvince:'甲省',regionCity:'中心市',regionDistrict:'西区',industry:'软件业',qualifications:[],chainNodes:[]},
  {id:'c',enterpriseName:'甲方分支企业',creditCode:'CODE-C',regionProvince:'乙省',regionCity:'中心市',regionDistrict:'东区',industry:'制造业',qualifications:[],chainNodes:[]},
  {id:'unknown',enterpriseName:'待采集企业',creditCode:'CODE-U',regionProvince:null,regionCity:null,regionDistrict:null,industry:null,qualifications:[],chainNodes:[]},
];
const ids=rows=>rows.map(row=>row.id);

test('inventory search combines keyword, full region path and industry with AND without changing stored records',()=>{
  const before=JSON.stringify(records);
  assert.deepEqual(ids(filterInventory(records)),['a','b','c','unknown']);
  assert.deepEqual(ids(filterInventory(records,{keyword:' 甲方 ',province:' 甲省 ',city:'中心市',district:'东区',industry:'制造业'})),['a']);
  assert.deepEqual(ids(filterInventory(records,{keyword:'CODE-B'})),['b']);
  assert.deepEqual(ids(filterInventory(records,{province:'甲省',city:'中心市',district:'东区',industry:'软件业'})),[]);
  assert.deepEqual(ids(filterInventory(records,{industry:'制造业'})),['a','c']);
  assert.equal(JSON.stringify(records),before);
});

test('unconstrained missing fields stay visible, while a selected known dimension excludes unknowns',()=>{
  assert.deepEqual(ids(filterInventory(records,{keyword:'待采集'})),['unknown']);
  assert.deepEqual(ids(filterInventory(records,{province:'甲省'})),['a','b']);
  assert.deepEqual(ids(filterInventory(records,{province:'乙省',city:'中心市',district:'东区'})),['c']);
  assert.deepEqual(normalizeInventoryFilters({keyword:' x ',city:'孤立市',district:'孤立区'}),{keyword:'x',province:'',city:'',district:'',industry:''});
});

test('cascading candidates use full-library values and the complete selected parent path',()=>{
  assert.deepEqual(inventoryOptions(records).cities,[]);
  assert.deepEqual(inventoryOptions(records).districts,[]);
  const options=inventoryOptions(records,{keyword:'不匹配',province:'甲省',city:'中心市',industry:'制造业'});
  assert.deepEqual(options.provinces,['甲省','乙省']);
  assert.deepEqual(options.cities,['中心市']);
  assert.deepEqual(new Set(options.districts),new Set(['东区','西区']));
  assert.deepEqual(new Set(options.industries),new Set(['制造业','软件业']));
  assert.deepEqual(inventoryOptions(records,{province:'乙省',city:'中心市'}).districts,['东区']);
  assert.ok(Object.values(options).every(values=>!values.includes('null')&&!values.includes('未知')));
});

test('editing a parent clears descendants but preserves keyword, industry and the applied criteria object',()=>{
  const applied={keyword:'甲方',province:'甲省',city:'中心市',district:'东区',industry:'制造业'},before=structuredClone(applied);
  assert.deepEqual(changeInventoryDraft(applied,'province','乙省'),{...applied,province:'乙省',city:'',district:''});
  assert.deepEqual(changeInventoryDraft(applied,'city','另一市'),{...applied,city:'另一市',district:''});
  assert.deepEqual(changeInventoryDraft(applied,'province','甲省'),applied);
  assert.deepEqual(applied,before);
  assert.deepEqual(ids(filterInventory(records,applied)),['a']);
  assert.deepEqual(normalizeInventoryFilters(),{keyword:'',province:'',city:'',district:'',industry:''});
});

const app=await readFile(new URL('../public/prototype/app.js',import.meta.url),'utf8');
const renderHelpers=app.slice(app.indexOf('function enterpriseTable('),app.indexOf('\nconst filterFields='));
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const button=(text,action,extra='')=>`<button data-action="${action}" ${extra}>${text}</button>`;
const options=(values,current='',blank='请选择')=>`<option value="">${blank}</option>`+values.map(item=>{const value=typeof item==='object'?item.value:item,label=typeof item==='object'?item.label:item;return `<option value="${esc(value)}" ${value===current?'selected':''}>${esc(label)}</option>`;}).join('');
function uiContext(extra={}){return {state:{records},inventoryDraft:normalizeInventoryFilters(),inventoryApplied:normalizeInventoryFilters(),selected:new Set(),normalizeInventoryFilters,changeInventoryDraft,inventoryOptions,filterInventory,INDUSTRY_STANDARD_VERSION,INDUSTRY_LEVEL_LABELS,formatIndustryPaths,industryChildren,esc,opts:options,btn:button,card:(_,body)=>body,notice:()=>'',empty:heading=>heading,...extra};}

test('inventory renders inline filters and one operation column without the removed module/statistic controls',()=>{
  const context=uiContext();runInNewContext(renderHelpers+';html=renderInventory();',context);const html=context.html;
  for(const id of ['inventory-filter-form','inventory-search','inventory-province','inventory-city','inventory-district','inventory-industry-l1','inventory-industry-l2','inventory-industry-l3','inventory-industry-l4'])assert.ok(html.includes(`id="${id}"`));
  assert.match(html,/一级门类/);assert.match(html,/二级大类/);assert.match(html,/三级中类/);assert.match(html,/四级小类/);assert.match(html,/未采集国民经济行业/);
  assert.match(html,/<th>操作<\/th>/);assert.equal((html.match(/>详情<\/button>/g)||[]).length,records.length);
  assert.doesNotMatch(html,/inventory-module|企业数据字典|标准字段|当前定位|查看13模块/);
  assert.match(html,/id="inventory-city"[^>]*disabled/);assert.match(html,/id="inventory-district"[^>]*disabled/);
});

test('draft region changes do not submit and empty search results keep draft controls usable for reset',()=>{
  const applied=normalizeInventoryFilters({keyword:'',province:'甲省',city:'中心市',district:'东区',industry:'制造业'}),draft={...applied,keyword:'不存在的企业'},context=uiContext({inventoryApplied:applied,inventoryDraft:draft});
  runInNewContext(renderHelpers+';html=renderInventory();',context);
  assert.match(context.html,/data-id="a"/);assert.doesNotMatch(context.html,/data-id="b"/);
  context.inventoryApplied={...draft};runInNewContext('html=renderInventory();',context);
  assert.match(context.html,/没有符合条件的企业/);assert.match(context.html,/value="不存在的企业"/);assert.match(context.html,/data-action="inventory-reset"/);
  assert.match(app,/e.target.id==='inventory-filter-form'.*handleAction\('inventory-search'\)/);
});

test('changing a parent through the actual form handler clears only descendants and preserves applied rows',()=>{
  const initial={keyword:'甲方',province:'甲省',city:'中心市',district:'东区',industry:'制造业'},draft=structuredClone(initial),form={values:{...initial,province:'乙省'}},calls=[];
  const context=uiContext({inventoryApplied:structuredClone(initial),inventoryDraft:draft,$:selector=>selector==='#inventory-filter-form'?form:{focus:()=>calls.push('focus')},FormData:class{constructor(current){return Object.entries(current.values);}},render:()=>calls.push('render')});
  runInNewContext(renderHelpers+';inventoryFormEvent({type:"change",target:{id:"inventory-province",dataset:{inventoryFilter:"province"},value:"乙省"}});',context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.inventoryDraft)),normalizeInventoryFilters({...initial,province:'乙省',city:'',district:''}));
  assert.deepEqual(context.inventoryApplied,initial);assert.deepEqual(calls,['render','focus']);
});

for(const [title,key,nextValue,cleared] of [
  ['changing division 39 to 34','industryL2','34',['industryL3','industryL4']],
  ['changing category C to I','industryL1','I',['industryL2','industryL3','industryL4']],
  ['clearing category C','industryL1','',['industryL2','industryL3','industryL4']],
])test(`actual industry form handler tolerates stale child controls when ${title}`,()=>{
  const initial=normalizeInventoryFilters({keyword:'甲方',province:'甲省',city:'中心市',district:'东区',industryL1:'C',industryL2:'39',industryL3:'397',industryL4:'3974'});
  const applied=structuredClone(initial),before=structuredClone(applied),form={values:{...initial,[key]:nextValue}},calls=[];
  const context=uiContext({inventoryApplied:applied,inventoryDraft:structuredClone(initial),event:{type:'change',target:{id:`inventory-industry-l${key.at(-1)}`,dataset:{inventoryFilter:key},value:nextValue}},$:selector=>selector==='#inventory-filter-form'?form:{focus:()=>calls.push('focus')},FormData:class{constructor(current){return Object.entries(current.values);}},render:()=>calls.push('render')});
  assert.doesNotThrow(()=>runInNewContext(renderHelpers+';inventoryFormEvent(event);',context));
  const expected={...initial,[key]:nextValue};for(const child of cleared)expected[child]='';
  assert.deepEqual(JSON.parse(JSON.stringify(context.inventoryDraft)),expected);
  assert.equal(context.inventoryApplied,applied);assert.deepEqual(context.inventoryApplied,before);
  assert.deepEqual(calls,['render','focus']);
});
