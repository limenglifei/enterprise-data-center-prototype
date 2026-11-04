import {FIELD_DEFS} from './core.mjs';

const COLUMNS=[{key:'enterpriseId',label:'中心企业 ID',type:'string'},...FIELD_DEFS,{key:'dataUpdatedAt',label:'中心更新时间',type:'date'}];
const FIELD_MAP=new Map(COLUMNS.map(field=>[field.key.toLowerCase(),field.key]));
const MAX_SERVICES=30,MAX_RUNS=50;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=()=>new Date().toISOString();
const uid=()=>globalThis.crypto?.randomUUID?.()||`sql_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const when=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
const actionButton=(label,operation,id='',kind='secondary')=>`<button class="btn ${kind}" data-action="sql-${operation}" data-id="${esc(id)}">${label}</button>`;
const DEFAULT_SQL='SELECT enterpriseName, creditCode, industry, regionProvince, qualifications\nFROM enterprises\nWHERE industry = :industry\nORDER BY enterpriseName ASC\nLIMIT 100';

function tokensFor(sql){
  if(typeof sql!=='string'||!sql.trim()||sql.length>5000)throw new Error('SQL 需为 1–5000 个字符');
  const tokens=[];let index=0;
  while(index<sql.length){
    const tail=sql.slice(index),char=sql[index];
    if(/\s/.test(char)){index++;continue;}
    if(tail.startsWith('--')||tail.startsWith('/*')||char===';'||char==='#')throw new Error('仅支持一条只读 SELECT；禁止注释和分号');
    if(char==="'"){
      let value='',closed=false;index++;
      while(index<sql.length){if(sql[index]==="'"){if(sql[index+1]==="'"){value+="'";index+=2;}else{index++;closed=true;break;}}else value+=sql[index++];}
      if(!closed)throw new Error('字符串缺少结束单引号');
      if(value.length>500)throw new Error('字符串条件不能超过 500 个字符');
      tokens.push({type:'value',value});
    }else if(char===':'){
      const match=tail.match(/^:([A-Za-z][A-Za-z0-9_]{0,59})\b/);if(!match)throw new Error('命名参数格式为 :parameterName');
      tokens.push({type:'param',value:match[1]});index+=match[0].length;
    }else if(/[A-Za-z_]/.test(char)){
      const match=tail.match(/^[A-Za-z_][A-Za-z0-9_]*/);tokens.push({type:'word',value:match[0]});index+=match[0].length;
    }else if(/[\d-]/.test(char)){
      const match=tail.match(/^-?\d+(?:\.\d+)?\b/);if(!match)throw new Error('数字格式不合法');
      const value=Number(match[0]);if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)throw new Error('数字超出安全范围');
      tokens.push({type:'value',value});index+=match[0].length;
    }else if('*,()='.includes(char)){tokens.push({type:char,value:char});index++;}
    else throw new Error(`不支持 SQL 字符：${char}`);
    if(tokens.length>512)throw new Error('SQL 表达式过长');
  }
  return tokens;
}

/** Small, explicit read-only grammar. Bound values are never parsed back into SQL. */
export function compileSqlQuery(sql){
  const tokens=tokensFor(sql);let pos=0;const parameters=new Set();
  const peek=word=>tokens[pos]?.type==='word'&&tokens[pos].value.toUpperCase()===word;
  const take=(type,value)=>{const token=tokens[pos];if(!token||token.type!==type||(value&&token.value.toUpperCase()!==value))throw new Error(`SQL 语法错误：此处需要 ${value||type}`);pos++;return token;};
  const field=()=>{const word=take('word').value,key=FIELD_MAP.get(word.toLowerCase());if(!key)throw new Error(`不支持的字段：${word}；请查看字段字典`);return key;};
  const value=()=>{const token=tokens[pos++];if(!token||!['value','param'].includes(token.type))throw new Error('条件值请使用单引号字符串、数字或 :命名参数');if(token.type==='param')parameters.add(token.value);return token;};
  take('word','SELECT');const columns=[];
  if(tokens[pos]?.type==='*'){pos++;columns.push(...COLUMNS.map(f=>f.key));}
  else {columns.push(field());while(tokens[pos]?.type===','){pos++;columns.push(field());}if(new Set(columns).size!==columns.length)throw new Error('返回字段不能重复');}
  take('word','FROM');take('word','ENTERPRISES');
  const conditions=[];
  if(peek('WHERE')){
    pos++;
    while(true){
      const key=field();let operator,values;
      if(tokens[pos]?.type==='='){pos++;operator='=';values=[value()];}
      else if(peek('LIKE')){pos++;operator='LIKE';values=[value()];}
      else if(peek('IN')){pos++;operator='IN';take('(');values=[value()];while(tokens[pos]?.type===','){pos++;values.push(value());if(values.length>50)throw new Error('IN 条件最多包含 50 个值');}take(')');}
      else throw new Error('WHERE 仅支持 =、LIKE、IN 及 AND');
      conditions.push({key,operator,values});if(conditions.length>20)throw new Error('最多允许 20 个筛选条件');
      if(peek('AND')){pos++;continue;}break;
    }
  }
  let orderBy=null,direction='ASC',limit=100;
  if(peek('ORDER')){pos++;take('word','BY');orderBy=field();if(peek('ASC')||peek('DESC'))direction=tokens[pos++].value.toUpperCase();}
  if(peek('LIMIT')){pos++;limit=take('value').value;if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw new Error('LIMIT 必须为 1–500 的整数');}
  if(pos!==tokens.length)throw new Error('仅支持 SELECT 字段 FROM enterprises [WHERE 条件 AND 条件] [ORDER BY 字段 ASC/DESC] [LIMIT 1–500]');
  return {columns,conditions,orderBy,direction,limit,parameters:[...parameters]};
}

function normalizedParams(params,expected){
  if(!params||typeof params!=='object'||Array.isArray(params))throw new Error('查询参数必须是 JSON 对象');
  if(JSON.stringify(params).length>12000)throw new Error('查询参数不能超过 12000 个字符');
  if(Object.keys(params).some(key=>!expected.includes(key)))throw new Error('参数中包含 SQL 未使用的字段');
  for(const key of expected)if(!Object.hasOwn(params,key))throw new Error(`缺少命名参数：${key}`);
  const scalar=value=>value===null||typeof value==='string'&&value.length<=500||typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER||typeof value==='boolean';
  for(const key of expected){const value=params[key];if(Array.isArray(value)){if(!value.length||value.length>50||value.some(item=>!scalar(item)))throw new Error(`参数 ${key} 的数组须含 1–50 个简单值`);}else if(!scalar(value))throw new Error(`参数 ${key} 仅支持字符串、数字、布尔值、null 或 IN 数组`);}
  return params;
}

function resolveConditions(plan,params){
  return plan.conditions.map(condition=>{
    const values=condition.values.flatMap(token=>{const value=token.type==='param'?params[token.value]:token.value;if(Array.isArray(value)&&condition.operator!=='IN')throw new Error('数组参数仅能用于 IN (:parameterName)');return Array.isArray(value)?value:[value];});
    if(values.length>50&&condition.operator==='IN')throw new Error('IN 展开后最多包含 50 个值');
    if(condition.operator==='LIKE'&&(typeof values[0]!=='string'||values[0].length>200))throw new Error('LIKE 条件须为不超过 200 字符的字符串');
    return {...condition,values};
  });
}

// Wildcards are interpreted as data; this matcher never builds a regex or code string.
function like(text,pattern){
  let input=0,token=0,star=-1,checkpoint=0;
  while(input<text.length){if(pattern[token]==='_'||pattern[token]!=='%'&&pattern[token]===text[input]){input++;token++;}else if(pattern[token]==='%'){star=token++;checkpoint=input;}else if(star!==-1){token=star+1;input=++checkpoint;}else return false;}
  while(pattern[token]==='%')token++;
  return token===pattern.length;
}

const publicRecord=record=>Object.fromEntries(COLUMNS.map(field=>[field.key,field.key==='enterpriseId'?(record.enterpriseId||record.id||null):field.key==='dataUpdatedAt'?(record.updatedAt||null):(record[field.key]??null)]));

export function querySqlRecords(records,sql,params={}){
  const plan=compileSqlQuery(sql),conditions=resolveConditions(plan,normalizedParams(params,plan.parameters));
  const matched=(Array.isArray(records)?records:[]).map(publicRecord).filter(record=>conditions.every(condition=>{
    const candidates=Array.isArray(record[condition.key])?record[condition.key]:[record[condition.key]];
    return candidates.some(candidate=>candidate!==null&&candidate!==undefined&&(condition.operator==='LIKE'?like(String(candidate),condition.values[0]):condition.values.some(value=>value!==null&&candidate===value)));
  }));
  if(plan.orderBy)matched.sort((a,b)=>{const first=a[plan.orderBy],second=b[plan.orderBy];if(first==null||second==null)return first==null?(second==null?0:1):-1;const result=typeof first==='number'&&typeof second==='number'?first-second:String(first).localeCompare(String(second),'zh-CN');return plan.direction==='DESC'?-result:result;});
  const rows=matched.slice(0,plan.limit).map(record=>Object.fromEntries(plan.columns.map(key=>[key,Array.isArray(record[key])?[...record[key]]:record[key]])));
  return {columns:plan.columns,total:matched.length,count:rows.length,limit:plan.limit,truncated:matched.length>plan.limit,rows};
}

export function upgradeSqlServices(state){
  if(!Array.isArray(state.sqlServices))state.sqlServices=[{id:'sql-industry',name:'行业企业动态查询',description:'按行业参数查询统一企业库，返回指定企业字段。',sql:DEFAULT_SQL,params:{industry:state.records?.find(record=>record.industry)?.industry||'电子信息'},status:'draft',revision:1,updatedAt:null,publishedAt:null}];
  if(!Array.isArray(state.sqlRuns))state.sqlRuns=[];
  state.sqlRuns=state.sqlRuns.slice(-MAX_RUNS);
  return state;
}

export function validateSqlService(input){
  if(!input||typeof input!=='object')throw new Error('查询配置不能为空');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>60)throw new Error('服务名称须为 1–60 个字符');
  if(typeof input.description!=='string'||input.description.length>500)throw new Error('服务说明不能超过 500 个字符');
  const plan=compileSqlQuery(input.sql);resolveConditions(plan,normalizedParams(input.params,plan.parameters));
  return input;
}

export function saveSqlService(state,input,id=null){
  upgradeSqlServices(state);validateSqlService(input);
  const existing=id?state.sqlServices.find(service=>service.id===id):null;
  if(id&&!existing)throw new Error('SQL 服务不存在');
  if(!existing&&state.sqlServices.length>=MAX_SERVICES)throw new Error(`最多配置 ${MAX_SERVICES} 个 SQL 服务`);
  const data={name:input.name.trim(),description:input.description.trim(),sql:input.sql.trim(),params:JSON.parse(JSON.stringify(input.params)),status:'draft',revision:(existing?.revision||0)+1,updatedAt:stamp()};
  if(existing){Object.assign(existing,data);return existing;}
  const created={id:uid(),publishedAt:null,...data};state.sqlServices.push(created);return created;
}

export function executeSqlService(state,id,sql,params,{now=stamp()}={}){
  upgradeSqlServices(state);const service=state.sqlServices.find(item=>item.id===id);
  if(!service)throw new Error('SQL 服务不存在');
  const log={id:uid(),serviceId:id,serviceName:service.name,revision:service.revision,createdAt:now,mode:'browser_preview',success:false,count:0,total:0,sql:typeof sql==='string'?sql.slice(0,5000):'',params:null};
  let result=null,error=null;
  try{if(service.status!=='published')throw new Error(service.status==='disabled'?'SQL 服务已停用':'请先发布 SQL 服务');result=querySqlRecords(state.records,sql,params);Object.assign(log,{success:true,count:result.count,total:result.total,params:JSON.parse(JSON.stringify(params))});}
  catch(cause){error=cause.message;log.error=error;}
  state.sqlRuns.push(log);state.sqlRuns=state.sqlRuns.slice(-MAX_RUNS);
  return {success:!error,result,error,log};
}

export function renderSqlServices(state){
  upgradeSqlServices(state);
  return `<div class="inline-notice"><span class="badge blue">动态 SQL 查询</span><span>面向下游应用，使用标准企业字段和命名参数执行只读查询。当前为浏览器模拟查询；真实下游连接、鉴权和 SQL 执行需部署服务端。</span></div><section class="card"><div class="card-header"><div><h2>SQL 查询服务</h2><p>保存查询模板 → 发布 → 绑定参数查询；最多返回 500 行。所有配置与最近执行记录保存于当前浏览器。</p></div><div class="button-group">${actionButton('字段字典与语法','dictionary')}${actionButton('新增 SQL 服务','create','','primary')}</div></div>${state.sqlServices.length?`<div class="table-wrap"><table><thead><tr><th>服务名称</th><th>查询模板</th><th>发布状态</th><th>最近执行</th><th>操作</th></tr></thead><tbody>${state.sqlServices.map(service=>{const last=state.sqlRuns.filter(run=>run.serviceId===service.id).at(-1);return `<tr><td><strong>${esc(service.name)}</strong><p class="subtle">${esc(service.description)}</p><p class="subtle">配置版本 ${service.revision}</p></td><td><code style="display:block;max-width:330px;white-space:pre-wrap;overflow-wrap:anywhere">${esc(service.sql)}</code></td><td><span class="badge ${service.status==='published'?'success':service.status==='disabled'?'neutral':'warning'}">${service.status==='published'?'已发布':service.status==='disabled'?'已停用':'草稿'}</span></td><td>${when(last?.createdAt)}${last?`<p class="subtle">${last.success?`成功 · ${last.count} 行`:'执行失败'}</p>`:''}</td><td><div class="button-group" style="min-width:210px">${actionButton('配置','edit',service.id,'ghost')}${actionButton('执行查询','query',service.id,'ghost')}${actionButton('执行记录','history',service.id,'ghost')}${service.status==='published'?actionButton('停用','disable',service.id,'ghost'):actionButton('发布','publish',service.id,'primary')}</div></td></tr>`;}).join('')}</tbody></table></div>`:'<div class="empty-state"><h3>暂无 SQL 服务</h3><p>新增查询模板，发布后可绑定参数执行查询。</p></div>'}</section>`;
}

function dictionary(){
  return `<div class="inline-notice"><span>只读表名固定为 enterprises。支持 SELECT 字段列表或 *、WHERE 的 = / LIKE / IN 与 AND、单字段 ORDER BY ASC/DESC、LIMIT 1–500（默认 100）。不支持 JOIN、聚合、OR、注释、多语句与写入。字段可按下表选择，缺失值显示为 —。</span></div><p class="subtle">条件值可写单引号字符串、数字或 :命名参数；单引号用两个单引号转义。LIKE 中 % 匹配任意字符、_ 匹配单个字符。字符串比较区分大小写；数组字段任一元素命中即满足条件，IN 可绑定数组（最多 50 项）。多个条件用 AND 连接；空值不会命中上述比较。</p><pre class="code-block section-gap">SELECT enterpriseName, creditCode, industry, qualifications\nFROM enterprises\nWHERE regionProvince = :province AND qualifications IN (:honors)\nORDER BY enterpriseName ASC\nLIMIT 100\n\n参数：{"province":"安徽省","honors":["高新技术企业"]}</pre><div class="table-wrap section-gap"><table><thead><tr><th>标准字段</th><th>字段含义</th><th>类型</th></tr></thead><tbody>${COLUMNS.map(field=>`<tr><td class="mono">${field.key}</td><td>${field.label}</td><td>${field.type}</td></tr>`).join('')}</tbody></table></div>`;
}

function configDialog(service,showModal,state){
  const initial=service||{name:'',description:'',sql:DEFAULT_SQL,params:{industry:state.records?.find(record=>record.industry)?.industry||'电子信息'}};
  showModal(service?'配置 SQL 查询服务':'新增 SQL 查询服务',`<form id="sql-service-config-form" class="form-grid"><div class="form-field full"><label>服务名称</label><input name="name" maxlength="60" placeholder="例如：行业企业动态查询" value="${esc(initial.name)}" required></div><div class="form-field full"><label>服务说明</label><textarea name="description" rows="2" maxlength="500">${esc(initial.description)}</textarea></div><div class="form-field full"><label>查询 SQL</label><textarea name="sql" class="code-editor" rows="8" maxlength="5000" spellcheck="false">${esc(initial.sql)}</textarea><small>仅查询 enterprises 标准字段，支持 = / LIKE / IN / AND、ORDER BY、LIMIT。参数使用 :industry 等命名占位符。</small></div><div class="form-field full"><label>默认参数（JSON）</label><textarea name="params" class="code-editor" rows="4" style="min-height:110px" maxlength="12000" spellcheck="false">${esc(JSON.stringify(initial.params,null,2))}</textarea><small>不含参数时填写 {}。参数名称与 SQL 完全一致，数组仅用于 IN 条件。</small></div></form><p class="subtle section-gap">保存后为草稿，需要重新发布。查询只读取当前统一企业库，返回所选字段；不支持执行数据库写入命令。</p>`,`${actionButton('字段字典与语法','dictionary')}${actionButton('保存配置','save',service?.id||'','primary')}`,true);
}

function resultTable(result){
  if(!result.rows.length)return '<div class="empty-state compact"><h3>未找到匹配企业</h3><p>查询执行成功，可调整条件或检查统一企业库中是否已有对应数据。</p></div>';
  return `<p class="subtle">共匹配 ${result.total} 家，返回 ${result.count} 行${result.truncated?'（已达到 LIMIT 上限）':''}。</p><div class="table-wrap section-gap" style="max-height:420px"><table><thead><tr>${result.columns.map(key=>`<th>${esc(COLUMNS.find(field=>field.key===key)?.label||key)}</th>`).join('')}</tr></thead><tbody>${result.rows.map(row=>`<tr>${result.columns.map(key=>`<td style="max-width:300px;overflow-wrap:anywhere">${esc(Array.isArray(row[key])?row[key].join('、')||'—':row[key]??'—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export async function handleSqlAction(action,element,{getState,mutate,toast,showModal,closeModal}){
  const operation=action.replace(/^sql-/,''),state=upgradeSqlServices(getState()),id=element.dataset.id,service=state.sqlServices.find(item=>item.id===id);
  if(operation==='dictionary'){showModal('SQL 字段字典与语法',dictionary(),'',true);return;}
  if(operation==='create'){configDialog(null,showModal,state);return;}
  if(operation==='save'){
    const form=new FormData(document.querySelector('#sql-service-config-form'));let input;
    try{input={name:String(form.get('name')||''),description:String(form.get('description')||''),sql:String(form.get('sql')||''),params:JSON.parse(String(form.get('params')||''))};validateSqlService(input);}catch(error){toast(error instanceof SyntaxError?'默认参数必须为合法 JSON 对象':error.message,'error');return;}
    const ok=await mutate(()=>saveSqlService(getState(),input,id||null),'SQL 查询配置已保存为草稿');if(ok)closeModal();return;
  }
  if(!service){toast('SQL 服务不存在','error');return;}
  if(operation==='edit'){configDialog(service,showModal,state);return;}
  if(operation==='publish'){
    try{validateSqlService(service);}catch(error){toast(error.message,'error');return;}
    await mutate(()=>Object.assign(getState().sqlServices.find(item=>item.id===id),{status:'published',publishedAt:stamp(),updatedAt:stamp()}),'SQL 服务已发布，可执行浏览器查询预览');return;
  }
  if(operation==='disable'){await mutate(()=>Object.assign(getState().sqlServices.find(item=>item.id===id),{status:'disabled',updatedAt:stamp()}),'SQL 服务已停用');return;}
  if(operation==='query'){
    if(service.status!=='published'){toast('请先发布 SQL 服务，再执行查询','error');return;}
    showModal(`${service.name} · 动态 SQL 查询`,`<div class="inline-notice"><span class="badge blue">浏览器模拟查询</span><span>查询当前统一企业库；不连接真实数据库。可修改本次 SQL 与参数，执行不会改变已保存模板。</span></div><form id="sql-query-form" class="form-grid"><div class="form-field full"><label>查询 SQL</label><textarea name="sql" class="code-editor" rows="7" maxlength="5000" spellcheck="false">${esc(service.sql)}</textarea></div><div class="form-field full"><label>绑定参数（JSON）</label><textarea name="params" class="code-editor" rows="4" style="min-height:110px" maxlength="12000" spellcheck="false">${esc(JSON.stringify(service.params,null,2))}</textarea></div></form><div id="sql-query-output" class="section-gap" role="status" aria-live="polite"></div>`,actionButton('执行查询','execute',id,'primary'),true);return;
  }
  if(operation==='execute'){
    const form=new FormData(document.querySelector('#sql-query-form'));let params;
    try{params=JSON.parse(String(form.get('params')||''));}catch{toast('绑定参数必须为合法 JSON 对象','error');return;}
    const sql=String(form.get('sql')||'');let outcome;
    const ok=await mutate(()=>{outcome=executeSqlService(getState(),id,sql,params);});
    const output=document.querySelector('#sql-query-output');if(ok&&output&&outcome)output.innerHTML=outcome.success?`<h3>查询成功</h3>${resultTable(outcome.result)}`:`<div class="notice danger"><span>查询失败：${esc(outcome.error)}</span></div>`;return;
  }
  if(operation==='history'){
    const runs=state.sqlRuns.filter(run=>run.serviceId===id).slice().reverse();
    showModal(`${service.name} · 执行记录`,`<p class="subtle">保留当前浏览器最近 ${MAX_RUNS} 条 SQL 执行记录，包含失败记录；仅为浏览器查询预览，不代表真实数据库调用。结果数据不持久化，后续查询读取最新统一企业库。</p>${runs.length?`<div class="table-wrap section-gap"><table><thead><tr><th>执行时间</th><th>配置版本</th><th>状态 / 返回行数</th><th>SQL 与参数</th></tr></thead><tbody>${runs.map(run=>`<tr><td>${when(run.createdAt)}</td><td>${esc(run.revision)}</td><td><span class="badge ${run.success?'success':'danger'}">${run.success?'成功':'失败'}</span><p class="subtle">${run.success?`${run.count} / ${run.total} 行`:esc(run.error)}</p></td><td><details><summary>查看执行内容</summary><pre class="code-block" style="max-width:500px">${esc(run.sql)}\n\n${esc(JSON.stringify(run.params,null,2))}</pre></details></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-state"><h3>暂无执行记录</h3><p>发布服务并执行查询后，可在这里查看明细。</p></div>'}`,service.status==='published'?actionButton('执行查询','query',id,'primary'):'',true);
  }
}
