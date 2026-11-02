const text=value=>String(value??'').trim();

/** A connector may use either identifier of the frozen target, never an unrelated fixed enterprise. */
export function selectUpdateRequestKeyword(context={},parameters={}){
  if(!parameters?.query||!Object.hasOwn(parameters.query,'keyword'))return text(context.keyword);
  const supplied=parameters.query.keyword;
  if(typeof supplied!=='string'||!supplied.trim())throw new Error('Query 参数 keyword 须为本次目标企业的非空全称或统一社会信用代码');
  const keyword=supplied.trim(),allowed=new Set([context.keyword,context.creditCode,context.enterpriseName].map(text).filter(Boolean));
  if(!allowed.has(keyword))throw new Error('Query 参数 keyword 与本次目标企业不一致，请使用本次企业的全称或统一社会信用代码');
  return keyword;
}
