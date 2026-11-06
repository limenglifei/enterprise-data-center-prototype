import {DICTIONARY_FIELDS,getDictionaryField} from './enterprise-dictionary.mjs';
import {syntheticIndustryRecord,industryPathFromFlat,matchesIndustryPath,normalizeIndustryPath} from './industry-classification.mjs';
import {LEGACY_ALIAS_MAP,canonicalField,mapDomainRows,mergeTableRows,materializeTables,getTableRows,getTableRecords} from './enterprise-domain.mjs';
export {LEGACY_ALIAS_MAP,getTableRows,getTableRecords};
export const FIELD_DEFS=DICTIONARY_FIELDS;
import { DEMO_METADATA, DEMO_SNAPSHOTS, DEMO_COMPANIES, DEFAULT_FILTERS } from './demo-data.mjs';
export { DEFAULT_FILTERS } from './demo-data.mjs';

export const LEGACY_FIELD_DEFS = [
  ['enterpriseName','企业全称','string','工商信息',true], ['creditCode','统一社会信用代码','string','工商信息',true],
  ['legalPerson','法定代表人','string','工商信息'], ['registrationStatus','经营状态','string','工商信息'],
  ['establishedAt','成立日期','date','工商信息'], ['registeredCapitalWan','注册资本（万元）','number','工商信息'],
  ['regionProvince','省份','string','工商信息'], ['regionCity','城市','string','工商信息'], ['regionDistrict','区县','string','工商信息'],
  ['industry','行业','string','工商信息'], ['businessScope','经营范围','string','工商信息'], ['registeredAddress','注册地址','string','工商信息'],
  ['qualifications','企业资质','array','专题补充'], ['scale','企业规模','string','专题补充'], ['chainNodes','产业链节点','array','专题补充'],
].map(([key,label,type,group,required=false]) => ({key,label,type,group,required}));
const FIELD_KEYS = new Set([...LEGACY_FIELD_DEFS,...DICTIONARY_FIELDS].map(f => f.key));
const CORE_KEYS = LEGACY_FIELD_DEFS.map(f => f.key);
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const empty = v => v == null || v === '' || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
const validDateMs = v => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null; };
const isoTime = v => { const n = validDateMs(v); return n === null ? null : new Date(n).toISOString(); };
const nowIso = v => isoTime(v ?? new Date().toISOString()) ?? new Date().toISOString();
const normalizeCode = v => String(v ?? '').trim().toUpperCase();
const valuesOnly = record => ({...Object.fromEntries(CORE_KEYS.map(k => [k,record?.[k] ?? null])),tables:record?.tables?Object.fromEntries(Object.entries(record.tables).map(([key,rows])=>[key,rows.map(row=>({rowKey:row.rowKey,values:Object.fromEntries(Object.entries(row.values).filter(([field])=>!getDictionaryField(field)?.technical))}))])):null});
const getByPath = (obj,path) => String(path).split('.').reduce((v,k) => v?.[k],obj);

export function getRecordId(codeOrRecord) {
  const code = normalizeCode(typeof codeOrRecord === 'object' ? codeOrRecord.creditCode : codeOrRecord);
  let hash = 2166136261;
  for (const c of code) { hash ^= c.charCodeAt(0); hash = Math.imul(hash,16777619); }
  return `ent_${(hash >>> 0).toString(16).padStart(8,'0')}`;
}

const map = (sourceField,targetField,scriptId='') => ({sourceField,targetField,scriptId,enabled:true});
// Self-contained so the separately managed script uses exactly this parser too.
function capitalToWan(value,defaultFactor) {
  if(value == null || value === '' || typeof value === 'string' && !value.trim()) return null;
  let amount, factor=defaultFactor;
  if(typeof value === 'number') amount=value;
  else if(typeof value === 'string') {
    const text=value.trim().replace(/\s+/g,'');
    const number='(?:\\d+(?:\\.\\d+)?|\\d{1,3}(?:[,，]\\d{3})+(?:\\.\\d+)?)';
    const match=text.match(new RegExp('^(?:(人民币|CNY|RMB))?('+number+')(亿元|万元|元|亿|万)?(?:(人民币|CNY|RMB))?$','i'));
    if(!match) throw new Error('金额格式或币种不支持：仅处理人民币，不自动换汇');
    if(!match[3] && (match[1] || match[4])) throw new Error('金额字符串缺少明确的元、万或亿单位');
    amount=Number(match[2].replace(/[,，]/g,''));
    if(match[3]) factor=match[3].startsWith('亿')?10000:match[3].startsWith('万')?1:0.0001;
  } else throw new Error('金额必须为数值或带明确单位的字符串');
  if(!Number.isFinite(amount) || amount<0) throw new Error('金额须为有限的非负数值');
  const result=amount*factor;
  if(!Number.isFinite(result)) throw new Error('金额超出可处理范围');
  return Math.round(result*10000)/10000;
}
const capitalScriptCode=defaultFactor=>`return (${capitalToWan.toString()})(value, ${defaultFactor});`;
function defaultMappings() {
  return {
    qcc: [map('Name','enterpriseName'),map('CreditCode','creditCode'),map('OperName','legalPerson'),map('Status','registrationStatus'),map('StartDate','establishedAt','date_iso'),map('RegistCapi','registeredCapitalWan','yuan_to_wan'),map('Province','regionProvince'),map('City','regionCity'),map('District','regionDistrict'),map('Industry','industry'),map('Scope','businessScope'),map('Address','registeredAddress')],
    tyc: [map('name','enterpriseName'),map('creditCode','creditCode'),map('legalPersonName','legalPerson'),map('regStatus','registrationStatus'),map('estiblishTime','establishedAt','date_iso'),map('regCapital','registeredCapitalWan','capital_to_wan'),map('province','regionProvince'),map('city','regionCity'),map('district','regionDistrict'),map('industry','industry'),map('businessScope','businessScope'),map('regLocation','registeredAddress')],
    file: [map('企业全称','enterpriseName'),map('统一社会信用代码','creditCode'),map('企业资质','qualifications','split_values'),map('企业规模','scale'),map('产业链节点','chainNodes','split_values')],
  };
}

export function createDefaultFtpMappings(){
  const base=['company_name','credit_code','legal_person','registration_status','established_at','capital_wan','province','city','district','industry','business_scope','registered_address','qualifications','scale','chain_nodes'];
  const mappings=LEGACY_FIELD_DEFS.filter(field=>!['qualifications','chainNodes','industry'].includes(field.key)).map(field=>map(base[LEGACY_FIELD_DEFS.indexOf(field)],LEGACY_ALIAS_MAP[field.key],field.key==='registeredCapitalWan'?'wan_to_yuan':''));
  const modules={contacts:['enterprise_contact','contact_phone','contact_email'],annual_operations:['enterprise_annual_operation','fiscal_year','annual_revenue','employee_count'],listings:['enterprise_listing','exchange_code','stock_code','stock_name'],shareholders:['enterprise_shareholder','subject_type','subject_name','direct_ownership_percent'],qualification_records:['enterprise_qualification','qualification_type','qualification_name','certificate_no'],patents:['enterprise_patent','patent_type','patent_name','application_no'],ip_summaries:['enterprise_intellectual_property_summary','statistics_date','patent_count'],risk_events:['enterprise_risk_event','risk_type','event_title','published_date','publishing_authority'],risk_summaries:['enterprise_risk_summary','statistics_date','tax_credit_rating','litigation_count'],tags:['enterprise_tag','tag_type','tag_name','tag_code','tag_version']};
  for(const [path,[table,...fields]]of Object.entries(modules))for(const field of fields)mappings.push(map(`${path}[].${field}`,`${table}.${field}`));
  for(const field of ['standard_version','is_primary','classification_method',...[1,2,3,4].flatMap(n=>[`industry_code_l${n}`,`industry_name_l${n}`])])mappings.push(map(`industry_records[].${field}`,`enterprise_industry.${field}`));
  return mappings;
}
export function createDefaultFtpProvider(id,name){return {id,name,type:'ftp',enabled:true,connectionMode:'demo',status:'demo_ready',description:'FTP / FTPS 文件接入演示；文件与企业均为虚构样例，未建立真实网络连接。',ftpConfig:{protocol:'ftps',host:'ftp.example.invalid',port:21,directory:'/enterprise',filePattern:'enterprise_*.json',username:'demo_reader',format:'json'}};}

export function createInitialState({seed=true}={}) {
  const state = {
    schemaVersion: 2.6, industryConfigVersion:1, sequence: 1, dataVersion: 1, metadata: clone(DEMO_METADATA),
    providers: [
      ...[['ftp_qcc','企查查 FTP'],['ftp_qxb','启信宝 FTP'],['ftp_tyc','天眼查 FTP']].map(([id,name])=>createDefaultFtpProvider(id,name)),
      {id:'file',name:'离线文件本地上传',type:'file',enabled:true,baseUrl:'',authType:'无需鉴权',connectionMode:'file',status:'ready',description:'补充资质、规模、产业链节点；用户自行提供授权数据。'},
    ],
    mappings: {...defaultMappings(),...Object.fromEntries(['ftp_qcc','ftp_qxb','ftp_tyc'].map(id=>[id,createDefaultFtpMappings()]))},
    scripts: [
      {id:'yuan_to_wan',name:'金额转换：元 → 万元',version:2,status:'published',description:'无单位数值按元；带元、万、亿单位的人民币字符串按显式单位解析。拒绝未知币种，不自动换汇。',code:capitalScriptCode(0.0001)},
      {id:'capital_to_wan',name:'注册资本标准化：万元',version:1,status:'published',description:'无单位数值按万元；带元、万、亿单位的人民币字符串按显式单位解析。拒绝未知币种，不自动换汇。',code:capitalScriptCode(1)},
      {id:'date_iso',name:'日期标准化',version:1,status:'published',description:'接受 YYYY/MM/DD、YYYY-MM-DD 或毫秒时间戳；时间戳按北京时间输出 YYYY-MM-DD。',code:'if (value == null || value === "") return null; if (typeof value === "string" && /^\\d{4}[-/]\\d{2}[-/]\\d{2}/.test(value)) { const s = value.slice(0, 10).replaceAll("/", "-"); const d = new Date(s + "T00:00:00Z"); if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error("日期格式不正确"); return s; } const d = new Date(Number(value) + 8 * 3600000); if (Number.isNaN(d.getTime())) throw new Error("日期格式不正确"); return d.toISOString().slice(0, 10);'},
      {id:'split_values',name:'多值拆分与去重',version:1,status:'published',description:'按中文分号、分号、中文逗号或英文逗号拆分，清除空项。',code:'return [...new Set((Array.isArray(value) ? value : String(value ?? "").split(/[；;，,]/)).map(x => String(x).trim()).filter(Boolean))];'},
      {id:'wan_to_yuan',name:'金额转换：万元 → 元',version:1,status:'published',description:'旧万元输入转换成字典中的元；不自动换汇。',code:'if(value == null || value === \"\") return null; const n=Number(value); if(!Number.isFinite(n)||n<0) throw new Error(\"金额须为非负有限数值\"); return n*10000;'},
    ],
    priorities: Object.fromEntries(DICTIONARY_FIELDS.map(f=>[f.key,['ftp_qcc','ftp_qxb','ftp_tyc','file']])),
    schedules: {
      ...Object.fromEntries(['ftp_qcc','ftp_qxb','ftp_tyc'].map(id=>[id,{enabled:false,mode:'incremental',frequency:'manual',intervalHours:1,time:'02:00',lastCursor:null,nextRunAt:null}])),
      file:{enabled:false,mode:'full',frequency:'manual',intervalHours:0,time:'',lastCursor:null,nextRunAt:null},
    },
    rawRecords:[],records:[],tasks:[],serviceLogs:[],fieldSourceOverrides:{},
  };
  if(seed) {
    const canonicalMappings=state.mappings.ftp_qcc;
    state.mappings.ftp_qcc=LEGACY_FIELD_DEFS.map((field,index)=>map(['company_name','credit_code','legal_person','registration_status','established_at','capital_wan','province','city','district','industry','business_scope','registered_address','qualifications','scale','chain_nodes'][index],field.key,field.type==='array'?'split_values':''));
    const rows=DEMO_COMPANIES.slice(0,24).map(company=>({...Object.fromEntries(state.mappings.ftp_qcc.map(mapping=>[mapping.sourceField,company[mapping.targetField]])),sourceUpdatedAt:DEMO_METADATA.baselineAt,_synthetic:true}));
    applyBatch(state,{sourceId:'ftp_qcc',rows,mode:'full',now:'2026-10-27T09:00:00+08:00'});
    state.mappings.ftp_qcc=canonicalMappings;
    applyBatch(state,{sourceId:'file',rows:clone(DEMO_SNAPSHOTS.file.v1),mode:'full',now:'2026-10-27T09:00:00+08:00'});
    // Explicit fixture facts, not a migration from historical industry themes.
    const industryRows=DEMO_COMPANIES.slice(0,24).map((company,i)=>({company_name:company.enterpriseName,credit_code:company.creditCode,industry_records:[syntheticIndustryRecord(i+1)].filter(Boolean),sourceUpdatedAt:DEMO_METADATA.baselineAt,_synthetic:true})).filter(row=>row.industry_records.length);
    applyBatch(state,{sourceId:'ftp_qcc',rows:industryRows,mode:'full',now:'2026-10-27T09:00:00+08:00'});
  }
  return state;
}

export function validateMappings(state,sourceId) {
  const errors = [], mappings = state.mappings[sourceId] ?? [], targets = new Set();
  for(const m of mappings.filter(m => m.enabled !== false)) {
    if(!m.sourceField?.trim()) errors.push('来源字段不能为空');
    if(!FIELD_KEYS.has(m.targetField)) errors.push(`未知标准字段：${m.targetField}`);
    if(getDictionaryField(m.targetField)?.technical) errors.push(`中心生成/关联字段不可映射：${m.targetField}`);
    if(targets.has(canonicalField(m.targetField))) errors.push(`标准字段重复映射：${m.targetField}`);
    targets.add(canonicalField(m.targetField));
    if(m.scriptId) {
      const script = state.scripts.find(s => s.id === m.scriptId);
      if(!script) errors.push(`转换脚本不存在：${m.scriptId}`);
      else if(script.status !== 'published') errors.push(`转换脚本未发布：${script.name}`);
    }
  }
  for(const key of ['enterprise.enterprise_name','enterprise.unified_social_credit_code']) if(!targets.has(key)) errors.push(`缺少必填字段映射：${key}`);
  for(const table of new Set(mappings.filter(m=>m.enabled!==false).map(m=>canonicalField(m.targetField).split('.')[0]))){const roots=new Set(mappings.filter(m=>m.enabled!==false&&canonicalField(m.targetField).startsWith(`${table}.`)).map(m=>m.sourceField?.match(/^(.*?)\[\]\./)?.[1]??''));if(roots.size>1)errors.push(`${table}字段须来自同一明细数组；不能拼接不同记录`);}
  return {valid:errors.length===0,errors:[...new Set(errors)]};
}

export function runBuiltinScript(script,value) {
  if(empty(value)) return script.id === 'split_values' ? [] : null;
  if(script.id === 'wan_to_yuan') {const n=Number(value);if(!Number.isFinite(n)||n<0)throw new Error('金额须为非负有限数值');return n*10000;}
  if(script.id === 'yuan_to_wan') return capitalToWan(value,0.0001);
  if(script.id === 'capital_to_wan') return capitalToWan(value,1);
  if(script.id === 'date_iso') {
    if(typeof value === 'string' && /^\d{4}[-/]\d{2}[-/]\d{2}/.test(value)) {
      const date = value.slice(0,10).replaceAll('/','-');
      const ms = Date.parse(`${date}T00:00:00Z`);
      if(!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10) !== date) throw new Error('日期格式不正确');
      return date;
    }
    const ms = typeof value === 'number' ? value : Number(value);
    if(!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) throw new Error('日期格式不正确');
    return new Date(ms + 8 * 3600000).toISOString().slice(0,10);
  }
  if(script.id === 'split_values') return [...new Set((Array.isArray(value) ? value : String(value).split(/[；;，,]/)).map(v => String(v).trim()).filter(Boolean))];
  throw new Error('自定义脚本需要在脚本沙箱内运行');
}

function mapRow(state,sourceId,row,runner) {
  if(!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('记录必须为对象');
  const values = {}, scriptVersions = {}, fieldMappings = {};
  for(const m of (state.mappings[sourceId] ?? []).filter(m => m.enabled !== false && !m.targetField.includes('.'))) {
    let value = getByPath(row,m.sourceField);
    if(m.scriptId) {
      const script = state.scripts.find(s => s.id === m.scriptId && s.status === 'published');
      if(!script) throw new Error(`脚本未发布或不存在：${m.scriptId}`);
      value = (runner ?? runBuiltinScript)(script,value,{row,sourceId,targetField:m.targetField});
      if(value && typeof value.then === 'function') throw new Error('批处理脚本须同步返回转换结果');
      scriptVersions[m.targetField] = {id:script.id,version:script.version};
    }
    const def = LEGACY_FIELD_DEFS.find(f => f.key === m.targetField);
    if(!def) continue;
    fieldMappings[m.targetField]=m.sourceField;
    if(empty(value)) value = def.type === 'array' ? [] : null;
    else if(def.type === 'number') { value=Number(value); if(!Number.isFinite(value)) throw new Error(`${def.label}必须为数值`); }
    else if(def.type === 'array') { if(!Array.isArray(value)) throw new Error(`${def.label}需通过独立脚本转换为数组`); value=[...new Set(value.map(v => String(v).trim()).filter(Boolean))]; }
    else value=String(value).trim();
    values[m.targetField]=value;
  }
  const domain=mapDomainRows(state,sourceId,row,runner??runBuiltinScript);
  Object.assign(values,domain.values);Object.assign(scriptVersions,domain.scriptVersions);Object.assign(fieldMappings,domain.fieldMappings);
  values.enterpriseName??=domain.values['enterprise.enterprise_name'];values.creditCode??=domain.values['enterprise.unified_social_credit_code'];
  values.creditCode=normalizeCode(values.creditCode);
  if(values['enterprise.unified_social_credit_code']!=null)values['enterprise.unified_social_credit_code']=values.creditCode;
  if(!values.enterpriseName || !values.creditCode) throw new Error('缺少企业全称或统一社会信用代码');
  if(!values.creditCode.startsWith('DEMO-') && !/^[0-9A-Z]{18}$/.test(values.creditCode)) throw new Error('信用代码需为18位字母数字，演示标识须以 DEMO- 开头');
  return {values,scriptVersions,fieldMappings,tableRows:domain.tableRows,mappingErrors:domain.errors,dictionaryMapped:(state.mappings[sourceId]??[]).some(m=>m.enabled!==false&&m.targetField.includes('.'))};
}

function parseSourceTime(value) {
  let ms;
  if(typeof value==='number' || typeof value==='string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric=Number(value);
    ms=Math.abs(numeric)<1e11?numeric*1000:numeric;
  } else if(typeof value==='string') {
    const text=value.trim();
    const parts=text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
    if(!parts) throw new Error('来源更新时间格式不正确');
    const [,year,month,day,hour='00',minute='00',second='00',fraction='',zone='+08:00']=parts;
    const y=Number(year),m=Number(month),d=Number(day),h=Number(hour),min=Number(minute),sec=Number(second);
    const calendar=new Date(Date.UTC(y,m-1,d));
    if(calendar.getUTCFullYear()!==y || calendar.getUTCMonth()!==m-1 || calendar.getUTCDate()!==d || h>23 || min>59 || sec>59) throw new Error('来源更新时间日期或时间无效');
    const normalizedZone=zone.toUpperCase()==='Z'?'Z':zone.includes(':')?zone:`${zone.slice(0,3)}:${zone.slice(3)}`;
    ms=Date.parse(`${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T${hour.padStart(2,'0')}:${minute}:${second}${fraction?'.'+fraction:''}${normalizedZone}`);
  }
  if(!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) throw new Error('来源更新时间格式不正确');
  return new Date(ms).toISOString();
}

function sourceTimestamp(row,now) {
  // The normalized adapter contract comes first, then vendor aliases, then demo/file aliases.
  const field=['sourceUpdatedAt','UpdatedDate','updateTimes','updatetime','UpdatedAt','updateTime','数据更新时间'].find(key=>row[key]!=null && String(row[key]).trim()!=='');
  if(field) return {time:parseSourceTime(row[field]),assumed:false,field};
  // Legacy UI used _updatedAt for collectedAt; never treat that as a vendor fact timestamp.
  if(row._updatedAt!=null && String(row._updatedAt).trim()!=='') return {time:parseSourceTime(row._updatedAt),assumed:true,field:'_updatedAt'};
  return {time:now,assumed:true,field:null};
}

/** Mutates state; every upsert is idempotent by source + normalized credit code. */
export function applyBatch(state,{sourceId,rows,mode='incremental',runScript,now,windowStart,windowEnd}={}) {
  const startedAt=nowIso(now), provider=state.providers.find(p => p.id===sourceId);
  if(provider?.type==='api'||provider?.retired)throw new Error('上游 API 对接已移除，历史信源不可继续接入');
  if(!provider) throw new Error(`未知数据源：${sourceId}`);
  if(!provider.enabled) throw new Error('数据源已停用');
  if(!['full','incremental'].includes(mode)) throw new Error('更新模式仅支持 full 或 incremental');
  if(!Array.isArray(rows)) throw new Error('接入数据必须为记录数组');
  const validation=validateMappings(state,sourceId); if(!validation.valid) throw new Error(validation.errors.join('；'));
  const startMs=windowStart ? validDateMs(windowStart) : null, endMs=windowEnd ? validDateMs(windowEnd) : null;
  if(windowStart && startMs===null || windowEnd && endMs===null || startMs!==null && endMs!==null && startMs>endMs) throw new Error('变更窗口不正确');
  const before=new Map(state.records.map(r => [r.id,valuesOnly(r)]));
  const task={id:`task_${state.sequence++}`,sourceId,sourceName:provider.name,mode,status:'success',startedAt,completedAt:startedAt,received:rows.length,processed:0,added:0,updated:0,unchanged:0,failed:0,duplicates:0,skipped:0,ignoredStale:0,ignoredUnknownTime:0,newEnterprises:0,changedEnterprises:0,errors:[],windowStart:windowStart??null,windowEnd:windowEnd??null,scope:mode==='full'?'本中心企业清单全量刷新；不按缺失行删除':'指定变更窗口或待刷新清单；缺失不代表删除'};
  const candidates=new Map();
  rows.forEach((row,index) => {
    try {
      const stamp=sourceTimestamp(row,startedAt);
      const ms=Date.parse(stamp.time);
      if(mode==='incremental' && (startMs!==null && ms<=startMs || endMs!==null && ms>endMs)) {task.skipped++;return;}
      const mapped=mapRow(state,sourceId,row,runScript), key=mapped.values.creditCode;
      for(const error of mapped.mappingErrors??[]){task.failed++;task.errors.push({row:index+1,...error,creditCode:key});}
      const item={sourceId,entityKey:key,recordId:getRecordId(key),sourceUpdatedAt:stamp.time,sourceTimeAssumed:stamp.assumed,sourceTimeField:stamp.field,ingestedAt:startedAt,values:mapped.values,scriptVersions:mapped.scriptVersions,fieldMappings:mapped.fieldMappings,raw:clone(row),batchId:task.id,dictionaryMapped:mapped.dictionaryMapped,tableRows:mapped.tableRows.map(tableRow=>({...tableRow,sourceUpdatedAt:stamp.time,sourceTimeAssumed:stamp.assumed,sourceTimeField:stamp.field,ingestedAt:startedAt,batchId:task.id}))};
      if(candidates.has(key)) {
        task.duplicates++;
        const previous=candidates.get(key);
        item.tableRows=mergeTableRows(previous.tableRows,item.tableRows);
        if(item.sourceTimeAssumed && !previous.sourceTimeAssumed) {previous.tableRows=item.tableRows;return;}
        if(item.sourceTimeAssumed===previous.sourceTimeAssumed && Date.parse(item.sourceUpdatedAt)<Date.parse(previous.sourceUpdatedAt)) {previous.tableRows=item.tableRows;return;}
      }
      candidates.set(key,item);
    } catch(error) {task.failed++;task.errors.push({row:index+1,message:error.message,creditCode:String(row?.CreditCode??row?.creditCode??row?.['统一社会信用代码']??'')});}
  });
  for(const [key,item] of candidates) {
    task.processed++;
    const index=state.rawRecords.findIndex(r => r.sourceId===sourceId && r.entityKey===key);
    if(index<0) {state.rawRecords.push(item);task.added++;continue;}
    const old=state.rawRecords[index];
    const mergedRows=mergeTableRows(old.tableRows,item.tableRows);
    if(item.sourceTimeAssumed && !old.sourceTimeAssumed || Boolean(item.sourceTimeAssumed)===Boolean(old.sourceTimeAssumed) && Date.parse(item.sourceUpdatedAt)<Date.parse(old.sourceUpdatedAt))old.tableRows=mergedRows;
    if(item.sourceTimeAssumed && !old.sourceTimeAssumed) {task.unchanged++;task.ignoredUnknownTime++;continue;}
    if(Boolean(item.sourceTimeAssumed)===Boolean(old.sourceTimeAssumed) && Date.parse(item.sourceUpdatedAt)<Date.parse(old.sourceUpdatedAt)) {task.unchanged++;task.ignoredStale++;continue;}
    item.tableRows=mergedRows;
    item.values={...old.values,...item.values};
    if(equal(old.values,item.values) && equal((old.tableRows??[]).map(r=>[r.rowKey,r.values]),item.tableRows.map(r=>[r.rowKey,r.values]))) task.unchanged++; else task.updated++;
    state.rawRecords[index]=item;
  }
  recomputeRecords(state,{now:startedAt});
  for(const record of state.records) {
    if(!before.has(record.id)) task.newEnterprises++;
    else if(!equal(before.get(record.id),valuesOnly(record))) task.changedEnterprises++;
  }
  task.status=task.failed ? (task.processed ? 'partial' : 'failed') : 'success';
  task.message=`来源记录：新增 ${task.added}，更新 ${task.updated}，未变化 ${task.unchanged}，失败 ${task.failed}；中心新增企业 ${task.newEnterprises}，字段变化企业 ${task.changedEnterprises}`;
  const maxTime=[...candidates.values()].filter(r=>!r.sourceTimeAssumed).map(r => r.sourceUpdatedAt).sort().at(-1);
  if(state.schedules[sourceId] && task.failed===0) {
    const previous=state.schedules[sourceId].lastCursor;
    if(maxTime && (!previous || Date.parse(maxTime)>Date.parse(previous))) state.schedules[sourceId].lastCursor=maxTime;
    state.schedules[sourceId].lastRunAt=startedAt;
  }
  state.tasks.unshift(task); state.dataVersion=(state.dataVersion??0)+1;
  return {task,records:state.records};
}

/** Re-resolves stored candidates without reimporting data when field priority changes. */
export function recomputeRecords(state,{now}={}) {
  const at=nowIso(now), oldRecords=new Map((state.records??[]).map(r => [r.id,r])), groups=new Map();
  for(const raw of state.rawRecords) {
    if(!groups.has(raw.recordId)) groups.set(raw.recordId,[]);
    groups.get(raw.recordId).push(raw);
  }
  state.records=[...groups].map(([id,raws]) => {
    const record={id,enterpriseId:id,lineage:{},sources:[...new Set(raws.map(r=>r.sourceId))],synthetic:raws.some(r=>r.raw?._synthetic===true)};
    const identityKey=normalizeCode(oldRecords.get(id)?.creditCode)||normalizeCode(raws[0]?.entityKey);
    for(const def of LEGACY_FIELD_DEFS) {
      const priorities=state.priorities[def.key]??state.priorities[canonicalField(def.key)]??state.providers.map(p=>p.id);
      const candidates=raws.filter(r => Object.hasOwn(r.values,def.key)).map(r => {
        const valid=def.key!=='creditCode'||normalizeCode(r.values.creditCode)===identityKey&&normalizeCode(r.entityKey)===identityKey&&getRecordId(r.values.creditCode)===id;
        return {sourceId:r.sourceId,sourceName:state.providers.find(p=>p.id===r.sourceId)?.name??r.sourceId,value:clone(r.values[def.key]),sourceUpdatedAt:r.sourceUpdatedAt,sourceTimeAssumed:Boolean(r.sourceTimeAssumed),sourceTimeField:r.sourceTimeField??null,ingestedAt:r.ingestedAt,script:r.scriptVersions?.[def.key]??null,empty:empty(r.values[def.key]),valid,invalidReason:valid?null:'信用代码与当前企业身份不一致',priority:priorities.indexOf(r.sourceId)>=0?priorities.indexOf(r.sourceId)+1:999,rawField:r.fieldMappings?.[def.key]??(state.mappings[r.sourceId]??[]).find(m=>m.targetField===def.key)?.sourceField??null};
      }).sort((a,b)=>a.priority-b.priority || Date.parse(b.sourceUpdatedAt)-Date.parse(a.sourceUpdatedAt));
      const override=state.fieldSourceOverrides?.[id]?.[def.key]??state.fieldSourceOverrides?.[id]?.[canonicalField(def.key)],manualRequested=Boolean(override&&typeof override.sourceId==='string'&&override.sourceId),requestedSourceId=manualRequested?override.sourceId:null;
      const requested=candidates.find(c=>c.sourceId===requestedSourceId),sourceExists=manualRequested&&state.providers.some(p=>p.id===requestedSourceId);
      const pinned=sourceExists&&requested&&!requested.empty&&requested.valid?requested:null;
      const selected=pinned||candidates.find(c=>!c.empty&&c.valid)||null,manualApplied=Boolean(pinned),fallback=manualRequested&&!manualApplied;
      const fallbackReason=!fallback?null:!sourceExists?'指定信源已不存在':!requested?'指定信源尚无该字段候选值':requested.empty?'指定信源当前值为空':'指定信源信用代码与当前企业身份不一致';
      const automaticRule='按字段来源优先级选择首个非空候选值；同一来源只保留较新版本，空值回退下一来源。';
      const rule=manualApplied?`手动指定信源「${requested.sourceName}」；跟随该信源后续最新非空值，不受全局信源排序影响。`:fallback?`保留手动指定信源「${state.providers.find(p=>p.id===requestedSourceId)?.name??requestedSourceId}」的选择；${fallbackReason}，${selected?'本次自动按全局信源排序回退到其他非空值':'当前无有效非空候选值'}。指定信源恢复有效值后自动恢复手动取值。`:automaticRule;
      record[def.key]=selected?clone(selected.value):def.type==='array'?[]:null;
      record.lineage[def.key]={selected:selected?clone(selected):null,candidates:candidates.map(c=>({...c,selected:c===selected})),rule,override:manualRequested?clone(override):null,requestedSourceId,manualRequested,manualApplied,fallback,fallbackReason,selectionMode:manualApplied?'manual':fallback?'auto_fallback':'auto'};
    }
    const old=oldRecords.get(id);
    record.createdAt=old?.createdAt??at;
    record.updatedAt=old && equal(valuesOnly(old),valuesOnly(record)) ? old.updatedAt : at;
    record.sourceUpdatedAt=raws.map(r=>r.sourceUpdatedAt).sort().at(-1);
    materializeTables(state,record,raws,at);
    record.updatedAt=old && equal(valuesOnly(old),valuesOnly(record)) ? old.updatedAt : at;
    return record;
  }).sort((a,b)=>String(a.creditCode).localeCompare(String(b.creditCode)));
  return state.records;
}

function matchesChoice(value,filter) {
  if(empty(filter)) return true;
  const choices=Array.isArray(filter)?filter:[filter];
  if(!choices.length) return true;
  return choices.some(choice => Array.isArray(value) ? value.includes(choice) : String(value??'')===String(choice));
}

/** AND between dimensions; OR within a multi-selected dimension. */
export function filterEnterprises(state,filters={}) {
  const f={...DEFAULT_FILTERS,...filters};
  const industryPath=f.industryPath?normalizeIndustryPath(f.industryPath):industryPathFromFlat(f);
  const region=f.regionProvince || f.province || f.region || '';
  const qualifications=f.qualifications || f.qualification || '';
  const nodes=f.chainNodes || f.chainNode || '';
  return state.records.filter(r =>
    matchesChoice(r.regionProvince,region) && matchesChoice(r.regionCity,f.regionCity||f.city||'') && matchesChoice(r.regionDistrict,f.regionDistrict||f.district||'') &&
    matchesChoice(r.industry,f.industry) && (!industryPath||matchesIndustryPath(r,industryPath)) && matchesChoice(r.qualifications,qualifications) && matchesChoice(r.scale,f.scale) && matchesChoice(r.chainNodes,nodes) &&
    (!f.keyword || String(r.enterpriseName).includes(String(f.keyword).trim()))
  );
}

/** Strict exact match; accepts a full company name or credit code, never returns fuzzy matches. */
export function exactQuery(state,query) {
  const input=String(query??'').trim();
  if(!input) return {status:'invalid',message:'请输入企业全称或统一社会信用代码'};
  const record=state.records.find(r=>r.enterpriseName===input || normalizeCode(r.creditCode)===normalizeCode(input));
  return record ? {status:'found',record,message:'已精确匹配到企业'} : {status:'not_found',message:'中心未找到完全匹配的企业，请核对企业全称或信用代码；可在接入任务中刷新已授权的数据。'};
}

export function getLineage(state,id,field,{rowId}={}) {
  const record=state.records.find(r=>r.id===id || r.creditCode===id);
  const row=rowId?Object.values(record?.tables??{}).flat().find(row=>row.id===rowId):null;
  return {selected:null,candidates:[],rule:'暂无来源数据',override:null,requestedSourceId:null,manualRequested:false,manualApplied:false,fallback:false,fallbackReason:null,selectionMode:'auto',...(row?.lineage?.[field]??record?.lineage?.[field]??{})};
}

function validateFieldOverrideTarget(state,recordId,field,now){
  const record=state.records.find(item=>item.id===recordId);
  if(!record)throw new Error('企业记录不存在，请刷新后重试');
  if(!FIELD_KEYS.has(field))throw new Error('不支持的标准字段');
  if(now!=null&&validDateMs(now)===null)throw new Error('手动选择时间无效');
  return record;
}

/** Persist one enterprise/field source preference, never a copied value or a raw-record rewrite. */
export function setFieldSourceOverride(state,recordId,field,sourceId,{now,rowId}={}){
  if(field.includes('.'))return setDomainOverride(state,recordId,field,sourceId,{now,rowId});
  const record=validateFieldOverrideTarget(state,recordId,field,now);
  if(typeof sourceId!=='string'||!state.providers.some(provider=>provider.id===sourceId))throw new Error('指定信源不存在');
  if(state.providers.some(provider=>provider.id===sourceId&&(provider.type==='api'||provider.retired)))throw new Error('历史 API 信源已停用，不可新增手动选源配置');
  const candidates=state.rawRecords.filter(raw=>raw.recordId===recordId&&raw.sourceId===sourceId&&Object.hasOwn(raw.values,field)).sort((a,b)=>Date.parse(b.sourceUpdatedAt)-Date.parse(a.sourceUpdatedAt));
  const candidate=candidates[0];
  if(!candidate)throw new Error('该信源没有当前企业此字段的候选值');
  if(empty(candidate.values[field]))throw new Error('该信源当前字段值为空，不能手动选择');
  if(field==='creditCode'&&(normalizeCode(candidate.values.creditCode)!==normalizeCode(record.creditCode)||normalizeCode(candidate.entityKey)!==normalizeCode(record.creditCode)||getRecordId(candidate.values.creditCode)!==recordId))throw new Error('信用代码与当前企业身份不一致，不能切换到其他企业');
  if(state.fieldSourceOverrides?.[recordId]?.[field]?.sourceId===sourceId)return getLineage(state,recordId,field);
  state.fieldSourceOverrides??={};state.fieldSourceOverrides[recordId]??={};
  state.fieldSourceOverrides[recordId][field]={sourceId,updatedAt:nowIso(now)};
  recomputeRecords(state,{now});state.dataVersion=(state.dataVersion??0)+1;
  return getLineage(state,recordId,field);
}

/** Restore automatic source ranking for only this enterprise/field. No-op when no pin exists. */
export function clearFieldSourceOverride(state,recordId,field,{now,rowId}={}){
  if(field.includes('.'))return clearDomainOverride(state,recordId,field,{now,rowId});
  validateFieldOverrideTarget(state,recordId,field,now);
  if(!Object.hasOwn(state.fieldSourceOverrides?.[recordId]??{},field))return getLineage(state,recordId,field);
  delete state.fieldSourceOverrides[recordId][field];
  if(!Object.keys(state.fieldSourceOverrides[recordId]).length)delete state.fieldSourceOverrides[recordId];
  recomputeRecords(state,{now});state.dataVersion=(state.dataVersion??0)+1;
  return getLineage(state,recordId,field);
}

export function recordServiceCall(state,{type,query='',filters={},resultCount=0,now}={}) {
  if(!['batch_filter','exact_query'].includes(type)) throw new Error('未知服务类型');
  const log={id:`service_${state.sequence++}`,type,query,filters:clone(filters),resultCount,createdAt:nowIso(now),status:'success'};
  state.serviceLogs.unshift(log);
  return log;
}

function domainOverrideKey(state,recordId,field,rowId){
  validateFieldOverrideTarget(state,recordId,field);
  const def=getDictionaryField(field);if(!def||def.technical)throw new Error('中心生成/关联字段不可手动选源');
  if(def.table==='enterprise')return field;
  if(!rowId||!getTableRecords(state,recordId,def.table).some(row=>row.id===rowId))throw new Error('请指定有效的明细行');
  return `${rowId}|${field}`;
}
function setDomainOverride(state,recordId,field,sourceId,{now,rowId}){
  const key=domainOverrideKey(state,recordId,field,rowId);
  const source=state.providers.find(p=>p.id===sourceId);if(!source||source.retired||source.type==='api')throw new Error('指定信源不存在或已停用');
  const candidate=getLineage(state,recordId,field,{rowId}).candidates.find(c=>c.sourceId===sourceId);
  if(!candidate||candidate.empty||candidate.valid===false)throw new Error('该信源没有此行此字段的有效非空候选值');
  if(now!=null&&validDateMs(now)===null)throw new Error('手动选择时间无效');
  if(state.fieldSourceOverrides?.[recordId]?.[key]?.sourceId===sourceId)return getLineage(state,recordId,field,{rowId});
  state.fieldSourceOverrides??={};state.fieldSourceOverrides[recordId]??={};state.fieldSourceOverrides[recordId][key]={sourceId,updatedAt:nowIso(now)};
  recomputeRecords(state,{now});state.dataVersion=(state.dataVersion??0)+1;return getLineage(state,recordId,field,{rowId});
}
function clearDomainOverride(state,recordId,field,{now,rowId}){
  const key=domainOverrideKey(state,recordId,field,rowId);if(now!=null&&validDateMs(now)===null)throw new Error('手动选择时间无效');
  if(!Object.hasOwn(state.fieldSourceOverrides?.[recordId]??{},key))return getLineage(state,recordId,field,{rowId});
  delete state.fieldSourceOverrides[recordId][key];if(!Object.keys(state.fieldSourceOverrides[recordId]).length)delete state.fieldSourceOverrides[recordId];
  recomputeRecords(state,{now});state.dataVersion=(state.dataVersion??0)+1;return getLineage(state,recordId,field,{rowId});
}
