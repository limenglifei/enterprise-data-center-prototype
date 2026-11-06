import {INDUSTRY_STANDARD_VERSION,industryChildren,industryPathFromFlat,matchesIndustryPath} from './industry-classification.mjs';
const value=text=>typeof text==='string'?text.trim():'';

export function normalizeInventoryFilters(input={}){
  const filters=Object.fromEntries(['keyword','province','city','district','industry'].map(key=>[key,value(input[key])]));
  if(!filters.province){filters.city='';filters.district='';}
  if(!filters.city)filters.district='';
  if(['industryL1','industryL2','industryL3','industryL4','industryStandardVersion'].some(key=>Object.hasOwn(input,key))){
    for(let n=1;n<=4;n++)filters[`industryL${n}`]=value(input[`industryL${n}`]);
    filters.industryStandardVersion=value(input.industryStandardVersion)||INDUSTRY_STANDARD_VERSION;
    industryPathFromFlat(filters);
  }
  return filters;
}

export function changeInventoryDraft(input,key,nextValue){
  const draft=normalizeInventoryFilters(input),next=value(nextValue);
  if(/^industryL[1-4]$/.test(key)){
    const level=Number(key.at(-1));if(draft[key]!==next)for(let n=level+1;n<=4;n++)draft[`industryL${n}`]='';
    draft[key]=next;draft.industryStandardVersion=INDUSTRY_STANDARD_VERSION;return normalizeInventoryFilters(draft);
  }
  if(!Object.hasOwn(draft,key))return draft;
  if(draft[key]!==next){
    if(key==='province'){draft.city='';draft.district='';}
    if(key==='city')draft.district='';
  }
  draft[key]=next;
  return normalizeInventoryFilters(draft);
}

export function inventoryOptions(records,draft={}){
  const filters=normalizeInventoryFilters(draft),distinct=(rows,key)=>[...new Set(rows.map(row=>value(row[key])).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  const provinceRows=filters.province?records.filter(row=>value(row.regionProvince)===filters.province):[];
  const cityRows=filters.city?provinceRows.filter(row=>value(row.regionCity)===filters.city):[];
  const industryLevels=[0,1,2,3].map(level=>{const parents=Array.from({length:level},(_,i)=>filters[`industryL${i+1}`]||'');return parents.some(p=>!p)?[]:industryChildren(records,parents);});
  return {provinces:distinct(records,'regionProvince'),cities:distinct(provinceRows,'regionCity'),districts:distinct(cityRows,'regionDistrict'),industries:distinct(records,'industry'),industryLevels};
}

export function filterInventory(records,input={}){
  const filters=normalizeInventoryFilters(input),industryPath=industryPathFromFlat(filters);
  return records.filter(row=>(!filters.keyword||String(row.enterpriseName??'').includes(filters.keyword)||String(row.creditCode??'').includes(filters.keyword))&&
    (!filters.province||value(row.regionProvince)===filters.province)&&(!filters.city||value(row.regionCity)===filters.city)&&
    (!filters.district||value(row.regionDistrict)===filters.district)&&(!filters.industry||value(row.industry)===filters.industry)&&(!industryPath||matchesIndustryPath(row,industryPath)));
}
