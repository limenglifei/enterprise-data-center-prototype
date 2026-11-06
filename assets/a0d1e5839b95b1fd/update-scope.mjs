const copy=value=>JSON.parse(JSON.stringify(value));
const text=value=>String(value??'').trim();
const code=value=>text(value).toUpperCase();
const list=value=>[...new Set((Array.isArray(value)?value:[]).map(text).filter(Boolean))];
const validCode=value=>/^[0-9A-Z]{18}$/.test(value)||/^DEMO-[0-9A-Z-]+$/.test(value);
const regionPath=value=>typeof value==='string'?value.split('/').map(text).filter(Boolean).join('/'):[value?.province,value?.city,value?.district].map(text).filter(Boolean).join('/');
const keyOf=entry=>entry.creditCode?`code:${entry.creditCode}`:`name:${entry.enterpriseName}`;

/** Scope is independent from the update mode and the connection method. */
export function normalizeUpdateScope(scope){
  const source=scope&&typeof scope==='object'?scope:{};
  return {type:source.type||'all',filters:{regions:[...new Set((Array.isArray(source.filters?.regions)?source.filters.regions:[]).map(regionPath).filter(Boolean))],industries:list(source.filters?.industries),qualifications:list(source.filters?.qualifications)},entries:(Array.isArray(source.entries)?source.entries:[]).map((entry,index)=>({creditCode:code(entry?.creditCode),enterpriseName:text(entry?.enterpriseName),row:entry?.row??index+2})),fileName:text(source.fileName),uploadedAt:source.uploadedAt||null};
}

function matches(record,filters){
  return (!filters.regions.length||filters.regions.some(path=>{const parts=path.split('/');return parts.every((part,index)=>part===[record.regionProvince,record.regionCity,record.regionDistrict][index]);}))&&(!filters.industries.length||filters.industries.includes(record.industry))&&(!filters.qualifications.length||filters.qualifications.some(value=>(record.qualifications||[]).includes(value)));
}

/** Pure preview. Lists determine requests only and never import business values. */
export function previewUpdateScope(state,scope){
  const normalized=normalizeUpdateScope(scope),records=state.records||[],errors=[],targets=[],seen=new Set();let duplicates=0,blankRows=0;
  const append=(entry,record)=>{const target={key:keyOf(entry),creditCode:entry.creditCode,enterpriseName:entry.enterpriseName,enterpriseId:record?.id||null,known:Boolean(record),row:entry.row??null};if(seen.has(target.key)){duplicates++;return;}seen.add(target.key);targets.push(target);};
  if(['all','filters'].includes(normalized.type)){
    for(const record of records)if(normalized.type==='all'||matches(record,normalized.filters))append({creditCode:code(record.creditCode),enterpriseName:text(record.enterpriseName)},record);
  }else if(normalized.type==='list'){
    for(const entry of normalized.entries){
      if(!entry.creditCode&&!entry.enterpriseName){blankRows++;continue;}
      if(entry.creditCode&&!validCode(entry.creditCode)){errors.push({row:entry.row,message:'统一社会信用代码须为 18 位字母数字'});continue;}
      if(entry.enterpriseName.length>200){errors.push({row:entry.row,message:'企业全称不得超过 200 个字符'});continue;}
      const codeMatch=entry.creditCode?records.find(record=>code(record.creditCode)===entry.creditCode):null;
      if(codeMatch&&entry.enterpriseName&&entry.enterpriseName!==text(codeMatch.enterpriseName)){errors.push({row:entry.row,message:'信用代码与库内企业全称不一致，请核对名单'});continue;}
      const nameMatches=!entry.creditCode?records.filter(record=>text(record.enterpriseName)===entry.enterpriseName):[];
      if(nameMatches.length>1){errors.push({row:entry.row,message:'企业全称匹配到多家企业，请补充统一社会信用代码'});continue;}
      const known=codeMatch||nameMatches[0];
      append(known?{...entry,creditCode:code(known.creditCode),enterpriseName:text(known.enterpriseName)}:entry,known);
    }
  }else errors.push({row:0,message:'更新企业范围类型无效'});
  const summary=normalized.type==='all'?'全部库内企业':normalized.type==='filters'?'按地区、行业、荣誉资质筛选':`上传名单${normalized.fileName?` · ${normalized.fileName}`:''}`;
  return {type:normalized.type,summary,targets,errors,duplicates,blankRows,totalRows:normalized.type==='list'?normalized.entries.length:records.length,total:targets.length};
}

export function validateUpdateScope(state,scope,source){
  const normalized=normalizeUpdateScope(scope),preview=previewUpdateScope(state,normalized),errors=preview.errors.map(item=>`第 ${item.row} 行：${item.message}`);
  if(!['all','filters','list'].includes(normalized.type))errors.push('请选择有效的更新企业范围');
  if(source?.type==='api'&&source.requestScope==='single')errors.push('该信源为列表接口，请改用支持逐企查询的 API 信源');
  if(normalized.type==='filters'){
    if(!Object.values(normalized.filters).some(values=>values.length))errors.push('请至少选择一项地区、行业或荣誉资质条件');
    if(normalized.filters.regions.some(path=>path.split('/').length>3))errors.push('地区路径最多包含省、市、区县三级');
    const rawRegions=Array.isArray(scope?.filters?.regions)?scope.filters.regions:[];
    const missingParent=rawRegions.some(region=>{if(!region||typeof region!=='object')return false;return Boolean(text(region.city)&&!text(region.province)||text(region.district)&&(!text(region.province)||!text(region.city)));});
    if(missingParent)errors.push('选择城市或区县时必须同时指定上级地区');
    if((Array.isArray(scope?.filters?.regions)?scope.filters.regions:[]).some(region=>typeof region==='string'&&region.split('/').some(part=>!part.trim())))errors.push('地区层级路径不能包含空级别');
  }
  if(normalized.type==='list'&&!preview.targets.length)errors.push('名单中没有可执行的有效企业');
  if(normalized.entries.length>50000)errors.push('企业名单最多支持 50000 行');
  return {valid:errors.length===0,errors:[...new Set(errors)]};
}

/** Input rows come from the existing CSV / XLSX reader. Only identity columns are accepted. */
export function parseScopeRows(state,rows,{fileName='',uploadedAt=new Date().toISOString()}={}){
  if(!Array.isArray(rows)||!rows.length)throw new Error('企业名单没有数据行');
  const aliases={creditCode:['统一社会信用代码','信用代码','creditCode'],enterpriseName:['企业全称','企业名称','enterpriseName']};
  const headers=[...new Set(rows.flatMap(row=>Object.keys(row)))];
  if(headers.some(header=>!Object.values(aliases).flat().includes(header)))throw new Error('企业名单仅支持统一社会信用代码、企业全称两列，不接收业务字段');
  for(const options of Object.values(aliases))if(headers.filter(header=>options.includes(header)).length>1)throw new Error('同一身份字段不能使用多个表头');
  if(!headers.length)throw new Error('企业名单至少提供统一社会信用代码或企业全称一列');
  const entries=rows.map((row,index)=>({creditCode:code(row[aliases.creditCode.find(header=>Object.hasOwn(row,header))]),enterpriseName:text(row[aliases.enterpriseName.find(header=>Object.hasOwn(row,header))]),row:row.__sourceRowNumber??index+2}));
  const scope=normalizeUpdateScope({type:'list',entries,fileName,uploadedAt});return {scope,preview:previewUpdateScope(state,scope)};
}

function deepFreeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const nested of Object.values(value))deepFreeze(nested);}return value;}
export function freezeUpdateScope(state,job,now=new Date().toISOString()){
  const source=state.providers?.find(provider=>provider.id===job.sourceId),validation=validateUpdateScope(state,job.scope,source);
  if(!validation.valid)throw new Error(validation.errors.join('；'));
  const scope=normalizeUpdateScope(job.scope),preview=previewUpdateScope(state,scope);
  return deepFreeze(copy({type:preview.type,summary:preview.summary,frozenAt:now,total:preview.total,filters:scope.filters,fileName:scope.fileName,targets:preview.targets}));
}

export function scopeSummary(scope){const normalized=normalizeUpdateScope(scope);return normalized.type==='all'?'全部库内企业':normalized.type==='filters'?'按条件筛选':`上传名单${normalized.fileName?` · ${normalized.fileName}`:''}`;}
