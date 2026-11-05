const value=text=>typeof text==='string'?text.trim():'';

export function normalizeInventoryFilters(input={}){
  const filters=Object.fromEntries(['keyword','province','city','district','industry'].map(key=>[key,value(input[key])]));
  if(!filters.province){filters.city='';filters.district='';}
  if(!filters.city)filters.district='';
  return filters;
}

export function changeInventoryDraft(input,key,nextValue){
  const draft=normalizeInventoryFilters(input),next=value(nextValue);
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
  return {provinces:distinct(records,'regionProvince'),cities:distinct(provinceRows,'regionCity'),districts:distinct(cityRows,'regionDistrict'),industries:distinct(records,'industry')};
}

export function filterInventory(records,input={}){
  const filters=normalizeInventoryFilters(input);
  return records.filter(row=>(!filters.keyword||String(row.enterpriseName??'').includes(filters.keyword)||String(row.creditCode??'').includes(filters.keyword))&&
    (!filters.province||value(row.regionProvince)===filters.province)&&(!filters.city||value(row.regionCity)===filters.city)&&
    (!filters.district||value(row.regionDistrict)===filters.district)&&(!filters.industry||value(row.industry)===filters.industry));
}
