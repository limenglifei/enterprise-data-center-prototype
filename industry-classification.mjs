/** GB/T 4754-2017, including amendment 1 (2019). Candidate menus use collected records.
 * Official reference: https://www.stats.gov.cn/zs/tjws/tjbz/202301/t20230101_1903769.html
 * This small verified seed is not a complete national industry dictionary. */
export const INDUSTRY_STANDARD_VERSION='GB/T 4754-2017';
export const INDUSTRY_LEVEL_LABELS=Object.freeze(['一级门类','二级大类','三级中类','四级小类']);
const SEED_PATHS=[
 [['C','制造业'],['39','计算机、通信和其他电子设备制造业'],['397','电子器件制造'],['3974','显示器件制造']],
 [['C','制造业'],['39','计算机、通信和其他电子设备制造业'],['397','电子器件制造'],['3973','集成电路制造']],
 [['C','制造业'],['39','计算机、通信和其他电子设备制造业'],['397','电子器件制造'],['3976','光电子器件制造']],
 [['C','制造业'],['34','通用设备制造业'],['349','其他通用设备制造业'],['3499','其他未列明通用设备制造业']],
 [['I','信息传输、软件和信息技术服务业'],['65','软件和信息技术服务业'],['651','软件开发'],['6513','应用软件开发']],
];
const CATEGORIES=[['A',1,5],['B',6,12],['C',13,43],['D',44,46],['E',47,50],['F',51,52],['G',53,60],['H',61,62],['I',63,65],['J',66,69],['K',70,70],['L',71,72],['M',73,75],['N',76,79],['O',80,82],['P',83,83],['Q',84,85],['R',86,90],['S',91,96],['T',97,97]];
const text=v=>typeof v==='string'?v.trim():'';
function canonicalVersion(v){const normalized=text(v).replaceAll('—','-').replaceAll('－','-').replace(/\s+/g,'');return normalized==='GB/T4754-2017'?INDUSTRY_STANDARD_VERSION:null;}
export function normalizeIndustryPath(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['standardVersion','codes'].includes(k)))throw new Error('国民经济行业条件须为标准版本和完整代码路径');
 const version=canonicalVersion(input.standardVersion);if(!version)throw new Error('国民经济行业标准版本不支持');
 if(!Array.isArray(input.codes)||input.codes.length<1||input.codes.length>4||input.codes.some(c=>typeof c!=='string'))throw new Error('行业路径须包含连续1至4级代码');
 const codes=input.codes.map(text),patterns=[/^[A-T]$/,/^\d{2}$/,/^\d{3}$/,/^\d{4}$/];
 if(codes.some((c,i)=>!patterns[i].test(c)))throw new Error('行业代码格式或层级无效');
 if(codes.length>1){const category=CATEGORIES.find(([c])=>c===codes[0]),n=Number(codes[1]);if(n<category[1]||n>category[2])throw new Error('行业门类与大类不属于同一父路径');}
 if(codes.length>2&&(!codes[2].startsWith(codes[1])||codes.length>3&&!codes[3].startsWith(codes[2])))throw new Error('行业子级与父级代码不匹配');
 if(!SEED_PATHS.some(path=>codes.every((code,i)=>path[i][0]===code)))throw new Error('行业路径不在当前已核验代码目录中');
 return {standardVersion:version,codes};
}
export function industryPathFromFlat(input={}){
 const values=[1,2,3,4].map(n=>text(input[`industryL${n}`])),last=values.findLastIndex(Boolean);
 if(last<0)return null;
 return normalizeIndustryPath({standardVersion:input.industryStandardVersion||INDUSTRY_STANDARD_VERSION,codes:values.slice(0,last+1)});
}
export function getEnterpriseIndustryPaths(record){
 const result=[];
 for(const row of record?.tables?.enterprise_industry??[]){
  const v=row.values??{},status=v['enterprise_industry.status'];if(status!=null&&![1,'1','active','有效','正常'].includes(status))continue;
  const raw=[1,2,3,4].map(n=>text(v[`enterprise_industry.industry_code_l${n}`])),last=raw.findLastIndex(Boolean);if(last<0)continue;
  try{const path=normalizeIndustryPath({standardVersion:v['enterprise_industry.standard_version'],codes:raw.slice(0,last+1)}),names=path.codes.map((_,i)=>text(v[`enterprise_industry.industry_name_l${i+1}`]));if(names.some(n=>!n))continue;
   const seed=SEED_PATHS.find(p=>path.codes.every((c,i)=>p[i][0]===c));if(seed&&names.some((n,i)=>n!==seed[i][1]))continue;
   result.push({...path,names,label:path.codes.map((c,i)=>`${c} ${names[i]}`).join(' / '),rowId:row.id??null});
  }catch{/* Unknown or inconsistent source facts remain stored; never infer from legacy themes. */}
 }
 return [...new Map(result.map(p=>[JSON.stringify([p.standardVersion,p.codes]),p])).values()];
}
export function industryChildren(records,parentCodes=[]){
 if(parentCodes.length>=4)return [];
 if(parentCodes.length)normalizeIndustryPath({standardVersion:INDUSTRY_STANDARD_VERSION,codes:parentCodes});
 const level=parentCodes.length,options=new Map();for(const record of records)for(const path of getEnterpriseIndustryPaths(record))if(path.codes.length>level&&parentCodes.every((c,i)=>path.codes[i]===c)){const code=path.codes[level],name=path.names[level];options.set(code,{value:code,label:`${code} ${name}`,code,name,level:level+1,standardVersion:path.standardVersion});}
 return [...options.values()].sort((a,b)=>a.code.localeCompare(b.code));
}
export function matchesIndustryPath(record,input){const path=normalizeIndustryPath(input);return getEnterpriseIndustryPaths(record).some(p=>p.standardVersion===path.standardVersion&&path.codes.every((code,index)=>p.codes[index]===code));}
export function formatIndustryPaths(record){return getEnterpriseIndustryPaths(record).map(p=>p.label).join('；')||'未采集国民经济行业';}
/** Only called while constructing explicitly fictitious fixture records. No legacy-state inference. */
export function syntheticIndustryRecord(number=1){const index=({1:0,2:0,3:1,5:3,7:4,8:2,9:2,10:3,11:1,14:0,15:2,16:3,18:4,19:3,20:4,21:0,23:1,24:4})[number];if(index==null)return null;const selected=SEED_PATHS[index];return Object.fromEntries([['standard_version',INDUSTRY_STANDARD_VERSION],['is_primary',1],['classification_method','SYNTHETIC_FIXTURE'],...selected.flatMap(([code,name],i)=>[[`industry_code_l${i+1}`,code],[`industry_name_l${i+1}`,name]])]);}
