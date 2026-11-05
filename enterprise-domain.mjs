import {DICTIONARY_TABLES,DICTIONARY_FIELDS,getDictionaryField,getTableFields} from './enterprise-dictionary.mjs';

const copy=value=>JSON.parse(JSON.stringify(value));
export const isEmpty=value=>value==null||value===''||typeof value==='string'&&!value.trim()||Array.isArray(value)&&!value.length;
const pathValue=(row,path)=>Object.hasOwn(row??{},path)?row[path]:String(path).split('.').reduce((v,k)=>v?.[k],row);
const hash=value=>{let n=2166136261;for(const c of String(value)){n^=c.charCodeAt(0);n=Math.imul(n,16777619);}return (n>>>0).toString(16).padStart(8,'0');};
const unsignedBigint=value=>{const text=String(value??'');return /^\d+$/.test(text)&&BigInt(text)<=18446744073709551615n?BigInt(text).toString():null;};
const numericInternalId=value=>{const match=String(value??'').match(/^(?:ent|row)_([0-9a-f]{8})$/i);return match?BigInt(`0x${match[1]}`).toString():null;};

/** Numeric dictionary-column projection; internal/public enterprise and row IDs stay unchanged. */
export function normalizeTechnicalIds(state){
  for(const record of state.records??[]){
    const enterpriseId=numericInternalId(record.id);
    if(Object.hasOwn(record,'enterprise.id'))record['enterprise.id']=enterpriseId;
    if(Object.hasOwn(record,'enterprise.tenant_id'))record['enterprise.tenant_id']=unsignedBigint(state.tenantId);
    for(const rows of Object.values(record.tables??{}))for(const row of rows){
      if(Object.hasOwn(row.values,`${row.table}.id`))row.values[`${row.table}.id`]=numericInternalId(row.id);
      if(Object.hasOwn(row.values,`${row.table}.enterprise_id`))row.values[`${row.table}.enterprise_id`]=enterpriseId;
      if(Object.hasOwn(row.values,`${row.table}.tenant_id`))row.values[`${row.table}.tenant_id`]=unsignedBigint(state.tenantId);
    }
  }
  return state;
}
export const LEGACY_ALIAS_MAP=Object.freeze({enterpriseName:'enterprise.enterprise_name',creditCode:'enterprise.unified_social_credit_code',legalPerson:'enterprise.legal_representative',registrationStatus:'enterprise.business_status',establishedAt:'enterprise.established_date',registeredCapitalWan:'enterprise.registered_capital',regionProvince:'enterprise_address.province_name',regionCity:'enterprise_address.city_name',regionDistrict:'enterprise_address.division_name',industry:'enterprise_industry.industry_name_l1',businessScope:'enterprise.business_scope',registeredAddress:'enterprise_address.detail_address',qualifications:'enterprise_qualification.qualification_name',scale:'enterprise.enterprise_size',chainNodes:'enterprise_tag.tag_name'});
export const canonicalField=key=>LEGACY_ALIAS_MAP[key]??key;
const identityFields={enterprise_contact:['contact_phone','contact_email'],enterprise_address:['detail_address'],enterprise_industry:['standard_version','industry_code_l1','industry_code_l2','industry_code_l3','industry_code_l4','industry_name_l1'],enterprise_annual_operation:['fiscal_year'],enterprise_listing:['exchange_code','stock_code'],enterprise_shareholder:['subject_type','subject_credit_code','subject_name'],enterprise_qualification:['certificate_no','qualification_type','qualification_name','qualification_level'],enterprise_patent:['application_no','publication_no','grant_no','patent_type','patent_name'],enterprise_intellectual_property_summary:['statistics_date'],enterprise_risk_event:['risk_type','event_title'],enterprise_risk_summary:['statistics_date'],enterprise_tag:['tag_type','tag_code','tag_name','tag_version']};

export function normalizeDomainValue(def,value){
  if(isEmpty(value))return null;
  if(def.type==='number'){
    if(typeof value==='boolean'||typeof value==='object'||typeof value==='string'&&!value.trim())throw new Error(`${def.label}必须为数值`);
    const n=Number(value);if(!Number.isFinite(n)||def.sqlType.includes('unsigned')&&n<0||def.sqlType.includes('int')&&!Number.isInteger(n))throw new Error(`${def.label}数值格式无效`);return n;
  }
  if(def.type==='json'){
    if(typeof value==='string'){try{return JSON.parse(value);}catch{throw new Error(`${def.label}必须为有效JSON`);}}
    return copy(value);
  }
  if(typeof value==='object')throw new Error(`${def.label}必须为单值；明细数组请按 [].字段 映射`);
  const text=String(value).trim();
  if(def.maxLength&&[...text].length>def.maxLength)throw new Error(`${def.label}最多${def.maxLength}个字符`);
  if(def.sqlType==='date'&&!/^\d{4}-\d{2}-\d{2}$/.test(text))throw new Error(`${def.label}日期须为YYYY-MM-DD`);
  if(def.type==='date'&&(!Number.isFinite(Date.parse(text))||def.sqlType==='date'&&new Date(text).toISOString().slice(0,10)!==text))throw new Error(`${def.label}日期无效`);
  return text;
}

function naturalKey(table,values,context,sourceId){
  const v=name=>values[`${table}.${name}`];
  if(table==='enterprise')return 'singleton';

  if(table==='enterprise_annual_operation'&&isEmpty(v('fiscal_year')))throw new Error('年度经营与财务缺少会计年度，已隔离该行');
  if(['enterprise_intellectual_property_summary','enterprise_risk_summary'].includes(table)&&isEmpty(v('statistics_date')))throw new Error('汇总记录缺少统计日期，已隔离该行');
  let entries=(identityFields[table]??[]).map(name=>[name,v(name)]).filter(([,value])=>!isEmpty(value));
  // Strong identifiers take precedence. Names remain fallbacks, never array positions.
  for(const name of ['application_no','publication_no','grant_no','certificate_no','subject_credit_code'])if(!isEmpty(v(name))){entries=[[name,v(name)]];break;}
  if(!entries.length&&context?._rowId!=null&&!isEmpty(context._rowId))return `external:${sourceId}:${String(context._rowId)}`;
  if(!entries.length)throw new Error(`${table}缺少可识别的业务行标识，已隔离该行`);
  return JSON.stringify(entries);
}

/** Expand only within one collection. Different arrays can never be zipped into invented rows. */
export function mapDomainRows(state,sourceId,row,runner){
  const mappings=(state.mappings[sourceId]??[]).filter(m=>m.enabled!==false),groups=new Map(),tableRows=[],values={},scriptVersions={},fieldMappings={},errors=[];
  for(const m of mappings){
    const key=canonicalField(m.targetField),def=getDictionaryField(key);if(!def||def.technical)continue;
    const match=String(m.sourceField).match(/^(.*?)\[\]\.(.+)$/),root=match?.[1]??'',groupKey=`${def.table}|${root}`;
    if(!groups.has(groupKey))groups.set(groupKey,{table:def.table,root,mappings:[]});groups.get(groupKey).mappings.push({...m,key,def,relative:match?.[2]??m.sourceField});
  }
  for(const {table,root,mappings:items} of groups.values()){
    const collection=root?pathValue(row,root):[row];
    if(collection==null)continue;
    if(!Array.isArray(collection))throw new Error(`${root}需为明细数组`);
    for(const [collectionIndex,context] of collection.entries()){
      try {
      if(!context||typeof context!=='object'||Array.isArray(context))throw new Error(`${table}明细行必须为对象`);
      const data={},versions={},fields={};let legacyArray=null;
      for(const m of items){
        let value=pathValue(context,m.relative);
        if(value===undefined)continue;
        if(m.scriptId){const script=state.scripts.find(s=>s.id===m.scriptId&&s.status==='published');if(!script)throw new Error(`脚本未发布或不存在：${m.scriptId}`);value=runner(script,value,{row,item:context,collectionIndex:root?collectionIndex:undefined,sourceId,targetField:m.targetField});if(value&&typeof value.then==='function')throw new Error('批处理脚本须同步返回转换结果');versions[m.key]={id:script.id,version:script.version};}
        if(m.targetField==='registeredCapitalWan'&&!isEmpty(value))value=Number(value)*10000;
        if(['qualifications','chainNodes'].includes(m.targetField)&&Array.isArray(value)){legacyArray={key:m.key,items:value};continue;}
        data[m.key]=normalizeDomainValue(m.def,value);fields[m.key]=m.sourceField;
      }
      const add=dataRow=>{
        if(!Object.values(dataRow).some(v=>!isEmpty(v)))return;
        const rowKey=naturalKey(table,dataRow,context,sourceId);
        // Parent raw.raw already retains the entire root document. Only child
        // contexts need another small evidence fragment and a collection pointer.
        tableRows.push({table,rowKey,values:dataRow,scriptVersions:versions,fieldMappings:fields,rawPath:root?`${root}[${collectionIndex}]`:null,...(root?{raw:copy(context)}:{})});
        if(table==='enterprise'){Object.assign(values,dataRow);Object.assign(scriptVersions,versions);Object.assign(fieldMappings,fields);}
      };
      if(legacyArray)for(const value of legacyArray.items)add({...data,[legacyArray.key]:String(value),...(table==='enterprise_tag'?{'enterprise_tag.tag_type':'CHAIN_NODE'}:{})});
      else add(data);
      }catch(error){if(table==='enterprise')throw error;errors.push({table,collectionIndex:root?collectionIndex:null,message:error.message});}
    }
  }
  return {tableRows,values,scriptVersions,fieldMappings,errors};
}

export function mergeTableRows(previous=[],incoming=[]){
  const merged=new Map(previous.map(row=>[`${row.table}|${row.rowKey}`,copy(row)]));
  for(const row of incoming){
    const key=`${row.table}|${row.rowKey}`,old=merged.get(key);
    if(old&&((row.sourceTimeAssumed&&!old.sourceTimeAssumed)||Boolean(row.sourceTimeAssumed)===Boolean(old.sourceTimeAssumed)&&Date.parse(row.sourceUpdatedAt)<Date.parse(old.sourceUpdatedAt)))continue;
    // A partial row refresh cannot erase fields absent from the payload.
    merged.set(key,{...old,...copy(row),values:{...old?.values,...copy(row.values)},fieldMappings:{...old?.fieldMappings,...row.fieldMappings},scriptVersions:{...old?.scriptVersions,...row.scriptVersions}});
  }
  return [...merged.values()];
}

/** Project old stored evidence without changing its source, identity or original payload. */
export function legacyTableRows(raw){
  const grouped=new Map();
  for(const [old,key] of Object.entries(LEGACY_ALIAS_MAP)){
    if(!Object.hasOwn(raw.values??{},old)||isEmpty(raw.values[old]))continue;
    const table=key.split('.')[0];if(!grouped.has(table))grouped.set(table,{});
    grouped.get(table)[key]=old==='registeredCapitalWan'?Number(raw.values[old])*10000:copy(raw.values[old]);
  }
  const result=[];
  for(const [table,data]of grouped){
    const array=Object.entries(data).find(([,value])=>Array.isArray(value));
    const list=array?array[1].map(value=>({...data,[array[0]]:value,...(table==='enterprise_tag'?{'enterprise_tag.tag_type':'CHAIN_NODE'}:{})})):[data];
    for(const values of list){if(!Object.values(values).some(v=>!isEmpty(v)))continue;try{result.push({...raw,table,rowKey:naturalKey(table,values),values,fieldMappings:Object.fromEntries(Object.entries(LEGACY_ALIAS_MAP).filter(([old])=>Object.hasOwn(raw.values,old)).map(([old,key])=>[key,raw.fieldMappings?.[old]??null]))});}catch{/* Unidentifiable legacy facts remain in original raw.values. */}}
  }
  return result;
}

export function sourcePriority(state,key){
  const legacy=Object.entries(LEGACY_ALIAS_MAP).find(([,value])=>value===key)?.[0];
  return state.priorities[key]??state.priorities[legacy]??state.providers.map(p=>p.id);
}
function chooseField(state,enterpriseId,key,candidates,rowId){
  const order=sourcePriority(state,key);candidates.sort((a,b)=>(order.indexOf(a.sourceId)<0?999:order.indexOf(a.sourceId))-(order.indexOf(b.sourceId)<0?999:order.indexOf(b.sourceId))||Date.parse(b.sourceUpdatedAt)-Date.parse(a.sourceUpdatedAt));
  const alias=Object.entries(LEGACY_ALIAS_MAP).find(([,value])=>value===key)?.[0];
  const overrideKey=rowId?`${rowId}|${key}`:key,override=state.fieldSourceOverrides?.[enterpriseId]?.[overrideKey]??(key.startsWith('enterprise.')?state.fieldSourceOverrides?.[enterpriseId]?.[alias]:null),requestedSourceId=override?.sourceId??null;
  const requested=candidates.find(c=>c.sourceId===requestedSourceId),sourceExists=state.providers.some(p=>p.id===requestedSourceId);
  const pinned=sourceExists&&requested&&!requested.empty&&requested.valid!==false?requested:null,selected=pinned??candidates.find(c=>!c.empty&&c.valid!==false)??null;
  const manualRequested=Boolean(requestedSourceId),manualApplied=Boolean(pinned),fallback=manualRequested&&!manualApplied;
  const fallbackReason=!fallback?null:!sourceExists?'指定信源已不存在':!requested?'指定信源尚无该行该字段候选值':requested.empty?'指定信源当前值为空':'指定信源候选值无效';
  return {selected:selected?copy(selected):null,candidates:candidates.map(c=>({...c,selected:c===selected})),rule:manualApplied?'手动指定信源，跟随该行后续有效值':fallback?`${fallbackReason}；保留选择并按优先级回退`:'仅在同一业务行内按字段来源顺序取首个非空值',override:override??null,requestedSourceId,manualRequested,manualApplied,fallback,fallbackReason,selectionMode:manualApplied?'manual':fallback?'auto_fallback':'auto'};
}

/** Add nullable V2.6 columns to saved rows without rewriting source evidence or identity. */
export function upgradeRiskEventSchema(state){
  const keys=['enterprise_risk_event.published_date','enterprise_risk_event.publishing_authority'];
  for(const record of state.records??[])for(const row of record.tables?.enterprise_risk_event??[]){
    row.values??={};row.lineage??={};
    for(const key of keys){
      if(!Object.hasOwn(row.values,key))row.values[key]=null;
      if(!Object.hasOwn(row.lineage,key))row.lineage[key]=chooseField(state,record.id,key,[],row.id);
    }
  }
  return state;
}

export function materializeTables(state,record,raws,at){
  record.tables=Object.fromEntries(DICTIONARY_TABLES.map(table=>[table.key,[]]));
  const groups=new Map();
  for(const raw of raws){
    const rows=raw.dictionaryMapped?raw.tableRows??[]:legacyTableRows(raw);
    for(const row of rows){const key=`${row.table}|${row.rowKey}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({...raw,...row,recordId:raw.recordId,sourceId:raw.sourceId});}
  }
  for(const rows of groups.values()){
    const {table,rowKey}=rows[0],id=table==='enterprise'?record.id:`row_${hash(`${record.id}|${table}|${rowKey}`)}`;
    const output={id,table,enterpriseId:record.id,rowKey,values:{},lineage:{},sources:[...new Set(rows.map(r=>r.sourceId))],sourceId:null,sourceUpdatedAt:rows.map(r=>r.sourceUpdatedAt).filter(Boolean).sort().at(-1)??null};
    for(const def of getTableFields(table)){
      let value=null,lineage;
      if(def.technical){
        value=def.name==='id'?numericInternalId(id):def.name==='enterprise_id'?numericInternalId(record.id):def.name==='tenant_id'?unsignedBigint(state.tenantId):def.name==='created_at'?(record.createdAt??at):def.name==='updated_at'?at:['relation_key','event_key','tag_key'].includes(def.name)?rowKey:null;
        lineage={selected:null,candidates:[],rule:'中心生成或关联；不接受厂商覆盖',selectionMode:'generated',manualRequested:false,manualApplied:false,fallback:false};
      }else{
        const candidates=rows.filter(r=>Object.hasOwn(r.values,def.key)).map(r=>({sourceId:r.sourceId,sourceName:state.providers.find(p=>p.id===r.sourceId)?.name??r.sourceId,value:copy(r.values[def.key]),sourceUpdatedAt:r.sourceUpdatedAt,sourceTimeAssumed:Boolean(r.sourceTimeAssumed),sourceTimeField:r.sourceTimeField??null,ingestedAt:r.ingestedAt,rawField:r.fieldMappings?.[def.key]??null,script:r.scriptVersions?.[def.key]??null,rowId:id,rowKey,empty:isEmpty(r.values[def.key]),valid:!(def.key==='enterprise.unified_social_credit_code'&&String(r.values[def.key]).toUpperCase()!==String(record.creditCode).toUpperCase()),priority:(sourcePriority(state,def.key).indexOf(r.sourceId)+1)||999}));
        lineage=chooseField(state,record.id,def.key,candidates,table==='enterprise'?null:id);value=lineage.selected?.value??null;
        output.sourceId??=lineage.selected?.sourceId??null;
      }
      output.values[def.key]=value;output.lineage[def.key]=lineage;
      if(table==='enterprise'){record[def.key]=value;record.lineage[def.key]=lineage;}
    }
    record.tables[table].push(output);
  }
  // Compatibility projection feeds the established two downstream services only.
  for(const [old,key] of Object.entries(LEGACY_ALIAS_MAP)){
    const table=key.split('.')[0],rows=record.tables[table];
    if(['qualifications','chainNodes'].includes(old)&&record.lineage[old]?.manualApplied)continue;
    const hasStandard=raws.some(raw=>raw.dictionaryMapped&&(raw.tableRows??[]).some(row=>Object.hasOwn(row.values,key))),hasDomainPin=Object.keys(state.fieldSourceOverrides?.[record.id]??{}).some(field=>field===key||field.endsWith(`|${key}`));
    if(!hasStandard&&!hasDomainPin)continue;
    const present=rows.filter(row=>!isEmpty(row.values[key]));
    if(!present.length)continue;
    if(['qualifications','chainNodes'].includes(old))record[old]=[...new Set(present.filter(r=>old!=='chainNodes'||r.values['enterprise_tag.tag_type']==='CHAIN_NODE').map(r=>r.values[key]))];
    else {record[old]=present[0].values[key];if(old==='registeredCapitalWan')record[old]=Number(record[old])/10000;}
    if(!['qualifications','chainNodes'].includes(old)){record.lineage[old]=copy(present[0].lineage[key]);if(old==='registeredCapitalWan'){for(const c of record.lineage[old].candidates)c.value=Number(c.value)/10000;if(record.lineage[old].selected)record.lineage[old].selected.value=Number(record.lineage[old].selected.value)/10000;}}
  }
  return record.tables;
}

export const getTableRows=(record,table)=>record?.tables?.[typeof table==='string'?table:table?.key]??[];
export function getTableRecords(state,id,table){const record=state.records.find(r=>r.id===id||r.creditCode===id);if(!record)return [];if(record.tables)return getTableRows(record,table);const projected=copy(record);materializeTables(state,projected,state.rawRecords.filter(raw=>raw.recordId===record.id),record.updatedAt??new Date().toISOString());return getTableRows(projected,table);}
