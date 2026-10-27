import {FIELD_DEFS,filterEnterprises,exactQuery} from './core.mjs';

const DEFINITIONS=[
  {id:'search',name:'企业批量筛选',method:'POST',path:'/api/v1/enterprises/search',version:'1.0.0',description:'按地区、行业、资质、规模、产业链节点组合条件，分页返回统一企业库数据。'},
  {id:'query',name:'单企业精准查询',method:'GET',path:'/api/v1/enterprises/query',version:'1.0.0',description:'使用统一社会信用代码或企业全称完全匹配，返回该企业工商详细信息。'},
];
const FILTER_KEYS=['regionProvince','regionCity','regionDistrict','industry','qualifications','scale','chainNodes','keyword'];
const LABELS={regionProvince:'省份',regionCity:'城市',regionDistrict:'区县',industry:'行业',qualifications:'企业资质',scale:'企业规模',chainNodes:'产业链节点',keyword:'企业名称关键词'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const timestamp=()=>new Date().toISOString();
const requestId=()=>globalThis.crypto?.randomUUID?.()||`req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const when=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—';
const button=(title,action,id,kind='secondary')=>`<button class="btn ${kind}" data-action="api-service-${action}" data-id="${esc(id)}">${title}</button>`;
const jsonCode=v=>`<pre class="code-editor" style="max-height:360px;overflow:auto">${esc(JSON.stringify(v,null,2))}</pre>`;

/** Add the service catalog without replacing user configuration or publication status. */
export function upgradeApiServices(state){
  if(!Array.isArray(state.apiServices))state.apiServices=[];
  for(const definition of DEFINITIONS){
    const existing=state.apiServices.find(s=>s.id===definition.id);
    if(!existing)state.apiServices.push({...definition,status:'draft',updatedAt:null,publishedAt:null});
    else{for(const [key,value] of Object.entries(definition))if(existing[key]==null)existing[key]=value;existing.method=definition.method;existing.path=definition.path;}
  }
  if(!Array.isArray(state.apiCallLogs))state.apiCallLogs=[];
  return state;
}

export function validateApiServiceConfig(service){
  const errors=[];
  if(!service||!DEFINITIONS.some(d=>d.id===service.id))return {valid:false,errors:['未知 API 接口']};
  if(!String(service.name??'').trim()||String(service.name).length>60)errors.push('服务名称须为 1–60 个字符');
  if(!/^\d+\.\d+\.\d+$/.test(String(service.version??'')))errors.push('版本号需使用 1.0.0 格式');
  if(!String(service.description??'').trim()||String(service.description).length>500)errors.push('接口描述须为 1–500 个字符');
  const definition=DEFINITIONS.find(d=>d.id===service.id);
  if(service.method!==definition.method||service.path!==definition.path)errors.push('接口方法或路径不匹配');
  return {valid:errors.length===0,errors};
}

/** Validate before filtering. Reject unknown keys and ambiguous arrays rather than silently ignoring them. */
export function normalizeApiServiceInput(id,input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('入参必须是 JSON 对象');
  if(id==='query'){
    if(Object.keys(input).some(k=>k!=='keyword'))throw new Error('精准查询仅支持 keyword 参数');
    if(typeof input.keyword!=='string'||!input.keyword.trim()||input.keyword.trim().length>200)throw new Error('keyword 须为 1–200 个字符的企业全称或信用代码');
    return {keyword:input.keyword.trim()};
  }
  if(id!=='search')throw new Error('未知 API 接口');
  if(Object.keys(input).some(k=>![...FILTER_KEYS,'page','pageSize'].includes(k)))throw new Error('包含不支持的筛选参数');
  const output={};
  for(const key of FILTER_KEYS){
    const value=input[key];
    if(value==null||value==='')continue;
    if(typeof value!=='string'||value.trim().length>200)throw new Error(`${key} 须为不超过 200 个字符的字符串`);
    if(value.trim())output[key]=value.trim();
  }
  for(const [key,fallback,max] of [['page',1,100000],['pageSize',20,100]]){
    const value=input[key]??fallback;
    if(!Number.isSafeInteger(value)||value<1||value>max)throw new Error(`${key} 须为 1–${max} 的整数`);
    output[key]=value;
  }
  return output;
}

export function publicEnterprise(record){
  if(!record)return null;
  return {enterpriseId:record.enterpriseId||record.id,...Object.fromEntries(FIELD_DEFS.map(f=>[f.key,record[f.key]??(f.type==='array'?[]:null)])),dataUpdatedAt:record.updatedAt??null};
}

/** Shared by browser debugging and deployed routes; only exposes the public field allowlist. */
export function runApiService(state,id,input,{now=timestamp(),id:callId=requestId(),recordLog=true}={}){
  upgradeApiServices(state);
  const service=state.apiServices.find(s=>s.id===id);
  let httpStatus=200,code='SUCCESS',message='成功',data=null;
  if(!service){httpStatus=404;code='API_NOT_FOUND';message='API 接口不存在';}
  else if(service.status!=='published'){httpStatus=403;code='API_NOT_PUBLISHED';message=service.status==='disabled'?'API 已停用':'API 尚未发布';}
  else{
    try{
      const params=normalizeApiServiceInput(id,input);
      if(id==='search'){
        const {page,pageSize,...filters}=params;
        const matches=filterEnterprises(state,filters);
        data={count:matches.length,page,pageSize,records:matches.slice((page-1)*pageSize,page*pageSize).map(publicEnterprise)};
      }else{
        const result=exactQuery(state,params.keyword);
        if(result.status!=='found'){httpStatus=404;code='ENTERPRISE_NOT_FOUND';message='未找到完全匹配的企业';}
        else data={count:1,record:publicEnterprise(result.record)};
      }
    }catch(error){httpStatus=400;code='INVALID_PARAMETER';message=error.message;}
  }
  const body={requestId:callId,code,message,data};
  if(recordLog){
    state.apiCallLogs.unshift({id:callId,serviceId:id,serviceName:service?.name||id,version:service?.version||'',createdAt:now,httpStatus,code,resultCount:data?.count||0,mode:'browser_debug'});
    state.apiCallLogs=state.apiCallLogs.slice(0,100);
  }
  return {httpStatus,body};
}

function paramTable(service){
  const rows=service.id==='query'?[['keyword','string','是','统一社会信用代码或完整企业名称，完全匹配']]:[
    ...FILTER_KEYS.map(key=>[key,'string','否',LABELS[key]+(key==='keyword'?'，按名称包含匹配':'，精确匹配；多条件之间为 AND')]),
    ['page','integer','否','页码，默认 1，最大 100000'],['pageSize','integer','否','每页数量，默认 20，最大 100'],
  ];
  return `<div class="table-wrap"><table><thead><tr><th>参数名</th><th>类型</th><th>必填</th><th>说明</th></tr></thead><tbody>${rows.map(row=>`<tr>${row.map((v,i)=>`<td${i===0?' class="mono"':''}>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function renderApiServices(state){
  upgradeApiServices(state);
  const published=state.apiServices.filter(s=>s.status==='published').length;
  const logs=state.apiCallLogs;
  return `<div class="inline-notice"><span class="badge blue">API 服务目录</span><span>封装统一企业库，配置接口并发布给下游调用。GitHub Pages 演示调试在当前浏览器执行；真实对外服务需部署服务端并配置 ENTERPRISE_API_KEY。</span></div>
    <div class="stats-grid"><div class="stat-card"><div class="stat-label">已封装接口</div><div class="stat-value">${state.apiServices.length}<span>个 API</span></div><div class="stat-footer">批量筛选 / 精准查询</div></div><div class="stat-card"><div class="stat-label">已发布</div><div class="stat-value">${published}<span>个 API</span></div><div class="stat-footer">发布状态将实际保存</div></div><div class="stat-card"><div class="stat-label">待发布 / 已停用</div><div class="stat-value">${state.apiServices.length-published}<span>个 API</span></div><div class="stat-footer">调用返回 403</div></div><div class="stat-card"><div class="stat-label">调试调用记录</div><div class="stat-value">${logs.length}<span>次</span></div><div class="stat-footer">保留最近 100 次</div></div></div>
    <section class="card section-gap"><div class="card-header"><div><h2>对外 API 接口</h2><p class="subtle">统一响应结构 · Bearer 鉴权 · 只返回公开标准字段</p></div><span class="badge neutral">2 类核心数据服务</span></div><div class="table-wrap"><table><thead><tr><th>API 名称</th><th>请求方法 / 路径</th><th>版本</th><th>发布状态</th><th>最近发布</th><th>操作</th></tr></thead><tbody>${state.apiServices.map(s=>`<tr><td><strong>${esc(s.name)}</strong><p class="subtle" style="max-width:260px">${esc(s.description)}</p></td><td><span class="badge ${s.method==='POST'?'blue':'success'}">${s.method}</span><p class="mono" style="font-size:12px;margin-top:8px">${esc(s.path)}</p></td><td class="mono">v${esc(s.version)}</td><td><span class="badge ${s.status==='published'?'success':s.status==='disabled'?'neutral':'warning'}">${s.status==='published'?'已发布':s.status==='disabled'?'已停用':'草稿'}</span></td><td>${when(s.publishedAt)}</td><td><div class="button-group" style="display:flex;flex-wrap:wrap;gap:6px;min-width:190px">${button('配置','configure',s.id,'ghost')}${button('接口文档','docs',s.id,'ghost')}${button('在线调试','debug',s.id,'ghost')}${s.status==='published'?button('停用','disable',s.id,'ghost'):button('发布','publish',s.id,'primary')}</div></td></tr>`).join('')}</tbody></table></div></section>
    <section class="card section-gap"><div class="card-header"><div><h2>最近调试调用</h2><p class="subtle">展示调用状态、返回数量和请求 ID，可据此核对发布与参数配置。</p></div></div>${logs.length?`<div class="table-wrap"><table><thead><tr><th>调用时间</th><th>API</th><th>请求 ID</th><th>状态码</th><th>返回企业数</th><th>执行方式</th></tr></thead><tbody>${logs.slice(0,10).map(log=>`<tr><td>${when(log.createdAt)}</td><td>${esc(log.serviceName)}<p class="subtle">v${esc(log.version)}</p></td><td class="mono" style="max-width:210px;overflow-wrap:anywhere">${esc(log.id)}</td><td><span class="badge ${log.httpStatus===200?'success':'warning'}">${log.httpStatus} · ${esc(log.code)}</span></td><td>${log.resultCount}</td><td>浏览器演示调试</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-state"><h3>暂无调试调用</h3><p>配置并发布接口，再通过在线调试验证返回结果。</p></div>'}</section>`;
}

function sampleInput(state,id){return id==='query'?{keyword:state.records?.[0]?.creditCode||'请输入企业全称或信用代码'}:{regionProvince:'安徽省',industry:'电子信息',page:1,pageSize:20};}
function debugDialog(state,service,showModal){
  showModal(`${service.name} · 在线调试`,`<div class="inline-notice"><span class="badge blue">演示调试</span><span>直接使用当前统一企业库执行，与服务端复用同一套筛选逻辑。发布状态与入参校验均生效。</span></div><p class="mono section-gap">${service.method} ${esc(service.path)}</p><form id="api-service-debug-form"><div class="form-field section-gap"><label>请求参数（JSON）</label><textarea name="input" class="code-editor" rows="9" spellcheck="false">${esc(JSON.stringify(sampleInput(state,service.id),null,2))}</textarea></div></form><div id="api-service-debug-output" class="section-gap"></div>`,button('执行调试','execute-debug',service.id,'primary'),true);
}

export async function handleApiServiceAction(action,buttonElement,{getState,mutate,toast,showModal,closeModal}){
  const operation=action.replace(/^api-service-/,'');
  const state=upgradeApiServices(getState()),id=buttonElement.dataset.id,service=state.apiServices.find(s=>s.id===id);
  if(!service){toast('API 接口不存在','error');return;}
  if(operation==='configure'){
    showModal('配置 API 封装',`<form id="api-service-config-form" class="form-grid"><div class="form-field full"><label>服务名称</label><input name="name" maxlength="60" value="${esc(service.name)}"></div><div class="form-field"><label>版本号</label><input name="version" value="${esc(service.version)}" placeholder="1.0.0"></div><div class="form-field"><label>请求方法</label><input value="${service.method}" readonly></div><div class="form-field full"><label>接口路径</label><input value="${esc(service.path)}" readonly></div><div class="form-field full"><label>接口描述</label><textarea name="description" rows="3" maxlength="500">${esc(service.description)}</textarea></div><div class="form-field full"><label>鉴权方式</label><input value="Authorization: Bearer &lt;API_KEY&gt;" readonly><small>服务端通过环境变量 ENTERPRISE_API_KEY 配置，密钥不写入浏览器或源码。</small></div></form><p class="subtle section-gap">保存配置后状态变为草稿，校验并发布后方可调用。接口路径由服务端实现固定。</p>`,button('保存配置','save-config',id,'primary'),true);return;
  }
  if(operation==='save-config'){
    const form=new FormData(document.querySelector('#api-service-config-form'));
    const candidate={...service,name:String(form.get('name')||'').trim(),version:String(form.get('version')||'').trim(),description:String(form.get('description')||'').trim()};
    const validation=validateApiServiceConfig(candidate);if(!validation.valid){toast(validation.errors.join('；'),'error');return;}
    const ok=await mutate(()=>{const current=getState().apiServices.find(s=>s.id===id);Object.assign(current,candidate,{status:'draft',updatedAt:timestamp()});},'接口配置已保存为草稿');if(ok)closeModal();return;
  }
  if(operation==='publish'){
    const validation=validateApiServiceConfig(service);if(!validation.valid){toast(validation.errors.join('；'),'error');return;}
    await mutate(()=>{const current=getState().apiServices.find(s=>s.id===id);Object.assign(current,{status:'published',publishedAt:timestamp(),updatedAt:timestamp()});},'API 已发布，演示调试已开放；公网调用需部署服务端');return;
  }
  if(operation==='disable'){
    await mutate(()=>{Object.assign(getState().apiServices.find(s=>s.id===id),{status:'disabled',updatedAt:timestamp()});},'API 已停用，后续调用将返回 403');return;
  }
  if(operation==='docs'){
    const example=sampleInput(state,id),first=publicEnterprise(state.records?.[0]);
    const response={requestId:'req_example',code:'SUCCESS',message:'成功',data:id==='search'?{count:1,page:1,pageSize:20,records:first?[first]:[]}:{count:first?1:0,record:first}};
    showModal(`${service.name} · 接口文档`,`<p class="mono">${service.method} ${esc(service.path)}${id==='query'?'?keyword={企业全称或信用代码}':''}</p><p class="subtle">版本 v${esc(service.version)} · ${esc(service.description)}</p><div class="inline-notice section-gap"><span>鉴权：Authorization: Bearer &lt;API_KEY&gt;。请求 Header：Content-Type: application/json。部署地址由服务端域名 + 下列路径组成，GitHub Pages 域名不承载 API。</span></div><h3 class="section-gap">请求参数</h3>${paramTable(service)}<h3 class="section-gap">请求示例${id==='query'?'（查询参数）':''}</h3>${jsonCode(example)}<h3 class="section-gap">返回参数</h3><p class="subtle">外层：requestId / code / message / data。${id==='search'?'data.count 为满足条件的总数，records 为当前页企业数组。':'data.record 为精确匹配的企业，未匹配返回 404。'}企业字段仅返回下表，不包含原始来源记录和内部血缘。</p><div class="table-wrap"><table><thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead><tbody><tr><td class="mono">enterpriseId</td><td>string</td><td>中心企业 ID</td></tr>${FIELD_DEFS.map(f=>`<tr><td class="mono">${f.key}</td><td>${f.type}</td><td>${f.label}</td></tr>`).join('')}<tr><td class="mono">dataUpdatedAt</td><td>string | null</td><td>中心数据更新时间，ISO 8601</td></tr></tbody></table></div><h3 class="section-gap">返回示例</h3>${jsonCode(response)}<h3 class="section-gap">状态码</h3><p class="subtle">200 成功 · 400 参数错误 · 401 鉴权失败 · 403 未发布或已停用 · 404 企业不存在 · 413 请求体过大 · 503 密钥或存储未配置。服务端不会因查询触发付费厂商接口。</p>`,button('在线调试','debug',id,'primary'),true);return;
  }
  if(operation==='debug'){debugDialog(state,service,showModal);return;}
  if(operation==='execute-debug'){
    let input;try{input=JSON.parse(new FormData(document.querySelector('#api-service-debug-form')).get('input'));}catch{toast('请求参数必须是有效的 JSON 对象','error');return;}
    let result;
    const ok=await mutate(()=>{result=runApiService(getState(),id,input);});
    const output=document.querySelector('#api-service-debug-output');
    if(ok&&output&&result)output.innerHTML=`<h3>HTTP ${result.httpStatus} <span class="badge ${result.httpStatus===200?'success':'warning'}">${esc(result.body.code)}</span></h3>${jsonCode(result.body)}`;
  }
}
