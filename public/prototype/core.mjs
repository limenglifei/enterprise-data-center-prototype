import { DEMO_METADATA, DEMO_SNAPSHOTS, DEFAULT_FILTERS } from './demo-data.mjs';
export { DEFAULT_FILTERS } from './demo-data.mjs';

export const FIELD_DEFS = [
  ['enterpriseName','企业全称','string','工商信息',true], ['creditCode','统一社会信用代码','string','工商信息',true],
  ['legalPerson','法定代表人','string','工商信息'], ['registrationStatus','经营状态','string','工商信息'],
  ['establishedAt','成立日期','date','工商信息'], ['registeredCapitalWan','注册资本（万元）','number','工商信息'],
  ['regionProvince','省份','string','工商信息'], ['regionCity','城市','string','工商信息'], ['regionDistrict','区县','string','工商信息'],
  ['industry','行业','string','工商信息'], ['businessScope','经营范围','string','工商信息'], ['registeredAddress','注册地址','string','工商信息'],
  ['qualifications','企业资质','array','专题补充'], ['scale','企业规模','string','专题补充'], ['chainNodes','产业链节点','array','专题补充'],
].map(([key,label,type,group,required=false]) => ({key,label,type,group,required}));
const FIELD_KEYS = new Set(FIELD_DEFS.map(f => f.key));
const CORE_KEYS = FIELD_DEFS.map(f => f.key);
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const empty = v => v == null || v === '' || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
const validDateMs = v => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null; };
const isoTime = v => { const n = validDateMs(v); return n === null ? null : new Date(n).toISOString(); };
const nowIso = v => isoTime(v ?? new Date().toISOString()) ?? new Date().toISOString();
const normalizeCode = v => String(v ?? '').trim().toUpperCase();
const valuesOnly = record => Object.fromEntries(CORE_KEYS.map(k => [k,record?.[k] ?? null]));
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

export function createInitialState({seed=true}={}) {
  const state = {
    schemaVersion: 1, sequence: 1, dataVersion: 1, metadata: clone(DEMO_METADATA),
    providers: [
      {id:'qcc',name:'企查查',type:'api',enabled:true,baseUrl:'',authType:'待按厂商文档配置',connectionMode:'demo',status:'demo_ready',description:'工商基础信息 API 演示适配器；真实接入待提供 API 文档及授权。'},
      {id:'tyc',name:'天眼查',type:'api',enabled:true,baseUrl:'',authType:'待按厂商文档配置',connectionMode:'demo',status:'demo_ready',description:'第二厂商可切换模板；未发送真实网络请求。'},
      {id:'file',name:'本地专题文件',type:'file',enabled:true,baseUrl:'',authType:'无需鉴权',connectionMode:'file',status:'ready',description:'补充资质、规模、产业链节点；用户自行提供授权数据。'},
    ],
    mappings: defaultMappings(),
    scripts: [
      {id:'yuan_to_wan',name:'金额转换：元 → 万元',version:2,status:'published',description:'无单位数值按元；带元、万、亿单位的人民币字符串按显式单位解析。拒绝未知币种，不自动换汇。',code:capitalScriptCode(0.0001)},
      {id:'capital_to_wan',name:'注册资本标准化：万元',version:1,status:'published',description:'无单位数值按万元；带元、万、亿单位的人民币字符串按显式单位解析。拒绝未知币种，不自动换汇。',code:capitalScriptCode(1)},
      {id:'date_iso',name:'日期标准化',version:1,status:'published',description:'接受 YYYY/MM/DD、YYYY-MM-DD 或毫秒时间戳；时间戳按北京时间输出 YYYY-MM-DD。',code:'if (value == null || value === "") return null; if (typeof value === "string" && /^\\d{4}[-/]\\d{2}[-/]\\d{2}/.test(value)) { const s = value.slice(0, 10).replaceAll("/", "-"); const d = new Date(s + "T00:00:00Z"); if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error("日期格式不正确"); return s; } const d = new Date(Number(value) + 8 * 3600000); if (Number.isNaN(d.getTime())) throw new Error("日期格式不正确"); return d.toISOString().slice(0, 10);'},
      {id:'split_values',name:'多值拆分与去重',version:1,status:'published',description:'按中文分号、分号、中文逗号或英文逗号拆分，清除空项。',code:'return [...new Set((Array.isArray(value) ? value : String(value ?? "").split(/[；;，,]/)).map(x => String(x).trim()).filter(Boolean))];'},
    ],
    priorities: Object.fromEntries(FIELD_DEFS.map(f => [f.key,f.group === '专题补充' ? ['file','qcc','tyc'] : ['qcc','tyc','file']])),
    schedules: {
      qcc:{enabled:true,mode:'incremental',frequency:'daily',intervalHours:24,time:'02:00',lastCursor:null,nextRunAt:null,description:'全量按中心企业清单逐企刷新；增量使用变更窗口。'},
      tyc:{enabled:false,mode:'incremental',frequency:'weekly',intervalHours:168,time:'03:00',lastCursor:null,nextRunAt:null},
      file:{enabled:false,mode:'full',frequency:'manual',intervalHours:0,time:'',lastCursor:null,nextRunAt:null},
    },
    rawRecords:[],records:[],tasks:[],serviceLogs:[],
  };
  if(seed) for(const sourceId of ['qcc','tyc','file']) applyBatch(state,{sourceId,rows:clone(DEMO_SNAPSHOTS[sourceId].v1),mode:'full',now:'2026-10-27T09:00:00+08:00'});
  return state;
}

export function validateMappings(state,sourceId) {
  const errors = [], mappings = state.mappings[sourceId] ?? [], targets = new Set();
  for(const m of mappings.filter(m => m.enabled !== false)) {
    if(!m.sourceField?.trim()) errors.push('来源字段不能为空');
    if(!FIELD_KEYS.has(m.targetField)) errors.push(`未知标准字段：${m.targetField}`);
    if(targets.has(m.targetField)) errors.push(`标准字段重复映射：${m.targetField}`);
    targets.add(m.targetField);
    if(m.scriptId) {
      const script = state.scripts.find(s => s.id === m.scriptId);
      if(!script) errors.push(`转换脚本不存在：${m.scriptId}`);
      else if(script.status !== 'published') errors.push(`转换脚本未发布：${script.name}`);
    }
  }
  for(const key of ['enterpriseName','creditCode']) if(!targets.has(key)) errors.push(`缺少必填字段映射：${key}`);
  return {valid:errors.length===0,errors:[...new Set(errors)]};
}

export function runBuiltinScript(script,value) {
  if(empty(value)) return script.id === 'split_values' ? [] : null;
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
  for(const m of (state.mappings[sourceId] ?? []).filter(m => m.enabled !== false)) {
    let value = getByPath(row,m.sourceField);
    if(m.scriptId) {
      const script = state.scripts.find(s => s.id === m.scriptId && s.status === 'published');
      if(!script) throw new Error(`脚本未发布或不存在：${m.scriptId}`);
      value = (runner ?? runBuiltinScript)(script,value,{row,sourceId,targetField:m.targetField});
      if(value && typeof value.then === 'function') throw new Error('批处理脚本须同步返回转换结果');
      scriptVersions[m.targetField] = {id:script.id,version:script.version};
    }
    const def = FIELD_DEFS.find(f => f.key === m.targetField);
    if(!def) continue;
    fieldMappings[m.targetField]=m.sourceField;
    if(empty(value)) value = def.type === 'array' ? [] : null;
    else if(def.type === 'number') { value=Number(value); if(!Number.isFinite(value)) throw new Error(`${def.label}必须为数值`); }
    else if(def.type === 'array') { if(!Array.isArray(value)) throw new Error(`${def.label}需通过独立脚本转换为数组`); value=[...new Set(value.map(v => String(v).trim()).filter(Boolean))]; }
    else value=String(value).trim();
    values[m.targetField]=value;
  }
  values.creditCode=normalizeCode(values.creditCode);
  if(!values.enterpriseName || !values.creditCode) throw new Error('缺少企业全称或统一社会信用代码');
  if(!values.creditCode.startsWith('DEMO-') && !/^[0-9A-Z]{18}$/.test(values.creditCode)) throw new Error('信用代码需为18位字母数字，演示标识须以 DEMO- 开头');
  return {values,scriptVersions,fieldMappings};
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
      const item={sourceId,entityKey:key,recordId:getRecordId(key),sourceUpdatedAt:stamp.time,sourceTimeAssumed:stamp.assumed,sourceTimeField:stamp.field,ingestedAt:startedAt,values:mapped.values,scriptVersions:mapped.scriptVersions,fieldMappings:mapped.fieldMappings,raw:clone(row),batchId:task.id};
      if(candidates.has(key)) {
        task.duplicates++;
        const previous=candidates.get(key);
        if(item.sourceTimeAssumed && !previous.sourceTimeAssumed) return;
        if(item.sourceTimeAssumed===previous.sourceTimeAssumed && Date.parse(item.sourceUpdatedAt)<Date.parse(previous.sourceUpdatedAt)) return;
      }
      candidates.set(key,item);
    } catch(error) {task.failed++;task.errors.push({row:index+1,message:error.message,creditCode:String(row?.CreditCode??row?.creditCode??row?.['统一社会信用代码']??'')});}
  });
  for(const [key,item] of candidates) {
    task.processed++;
    const index=state.rawRecords.findIndex(r => r.sourceId===sourceId && r.entityKey===key);
    if(index<0) {state.rawRecords.push(item);task.added++;continue;}
    const old=state.rawRecords[index];
    if(item.sourceTimeAssumed && !old.sourceTimeAssumed) {task.unchanged++;task.ignoredUnknownTime++;continue;}
    if(Boolean(item.sourceTimeAssumed)===Boolean(old.sourceTimeAssumed) && Date.parse(item.sourceUpdatedAt)<Date.parse(old.sourceUpdatedAt)) {task.unchanged++;task.ignoredStale++;continue;}
    if(equal(old.values,item.values)) task.unchanged++; else task.updated++;
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
    for(const def of FIELD_DEFS) {
      const priorities=state.priorities[def.key]??state.providers.map(p=>p.id);
      const candidates=raws.filter(r => Object.hasOwn(r.values,def.key)).map(r => ({sourceId:r.sourceId,sourceName:state.providers.find(p=>p.id===r.sourceId)?.name??r.sourceId,value:clone(r.values[def.key]),sourceUpdatedAt:r.sourceUpdatedAt,sourceTimeAssumed:Boolean(r.sourceTimeAssumed),sourceTimeField:r.sourceTimeField??null,ingestedAt:r.ingestedAt,script:r.scriptVersions?.[def.key]??null,empty:empty(r.values[def.key]),priority:priorities.indexOf(r.sourceId)>=0?priorities.indexOf(r.sourceId)+1:999,rawField:r.fieldMappings?.[def.key]??(state.mappings[r.sourceId]??[]).find(m=>m.targetField===def.key)?.sourceField??null})).sort((a,b)=>a.priority-b.priority || Date.parse(b.sourceUpdatedAt)-Date.parse(a.sourceUpdatedAt));
      const selected=candidates.find(c=>!c.empty)??null;
      record[def.key]=selected?clone(selected.value):def.type==='array'?[]:null;
      record.lineage[def.key]={selected:selected?clone(selected):null,candidates:candidates.map(c=>({...c,selected:c===selected})),rule:'按字段来源优先级选择首个非空候选值；同一来源只保留较新版本，空值回退下一来源。'};
    }
    const old=oldRecords.get(id);
    record.createdAt=old?.createdAt??at;
    record.updatedAt=old && equal(valuesOnly(old),valuesOnly(record)) ? old.updatedAt : at;
    record.sourceUpdatedAt=raws.map(r=>r.sourceUpdatedAt).sort().at(-1);
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
  const region=f.regionProvince || f.province || f.region || '';
  const qualifications=f.qualifications || f.qualification || '';
  const nodes=f.chainNodes || f.chainNode || '';
  return state.records.filter(r =>
    matchesChoice(r.regionProvince,region) && matchesChoice(r.regionCity,f.regionCity||f.city||'') && matchesChoice(r.regionDistrict,f.regionDistrict||f.district||'') &&
    matchesChoice(r.industry,f.industry) && matchesChoice(r.qualifications,qualifications) && matchesChoice(r.scale,f.scale) && matchesChoice(r.chainNodes,nodes) &&
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

export function getLineage(state,id,field) {
  const record=state.records.find(r=>r.id===id || r.creditCode===id);
  return record?.lineage?.[field]??{selected:null,candidates:[],rule:'暂无来源数据'};
}

export function recordServiceCall(state,{type,query='',filters={},resultCount=0,now}={}) {
  if(!['batch_filter','exact_query'].includes(type)) throw new Error('未知服务类型');
  const log={id:`service_${state.sequence++}`,type,query,filters:clone(filters),resultCount,createdAt:nowIso(now),status:'success'};
  state.serviceLogs.unshift(log);
  return log;
}
