import {FIELD_DEFS,applyBatch,validateMappings} from './core.mjs';
import {DEMO_COMPANIES,DEMO_METADATA} from './demo-data.mjs';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy=v=>JSON.parse(JSON.stringify(v));
const SOURCE_FIELDS=['company_name','credit_code','legal_person','registration_status','established_at','capital_wan','province','city','district','industry','business_scope','registered_address','qualifications','scale','chain_nodes'];
const stamp=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—';
const button=(label,action,id='',kind='secondary',extra='')=>`<button class="btn ${kind}" data-action="ftp-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
const options=(entries,value)=>entries.map(([key,label])=>`<option value="${esc(key)}" ${value===key?'selected':''}>${esc(label)}</option>`).join('');
let selectedId='',selectedTab='connection';

export function selectFtpSource(id){selectedId=id;selectedTab='connection';}

export function validateFtpConfig(config){
  const errors=[];
  if(!config||typeof config!=='object')return {valid:false,errors:['FTP 配置不能为空']};
  if(!['ftp','ftps'].includes(config.protocol))errors.push('协议仅支持 FTP 或 FTPS');
  if(typeof config.host!=='string'||config.host.length>253||!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(config.host)||config.host.includes('..'))errors.push('主机须填写域名或 IPv4 地址，不含协议、路径及凭证');
  if(!Number.isInteger(config.port)||config.port<1||config.port>65535)errors.push('端口须为 1–65535 的整数');
  if(typeof config.directory!=='string'||config.directory.length>300||!config.directory.startsWith('/')||/[\\\x00-\x1f]/.test(config.directory)||config.directory.split('/').includes('..'))errors.push('目录须为绝对路径，不能包含上级目录或控制字符');
  if(typeof config.username!=='string'||!config.username.trim()||config.username.length>80||/[\x00-\x1f]/.test(config.username))errors.push('用户名须为 1–80 个字符');
  if(!['csv','json'].includes(config.format))errors.push('文件格式仅支持 CSV 或 JSON');
  if(typeof config.filePattern!=='string'||config.filePattern.length>128||!config.filePattern||/[\\/\x00-\x1f]/.test(config.filePattern)||!config.filePattern.endsWith(`.${config.format}`))errors.push('文件名规则仅用于文件名，支持 * 和 ?，扩展名须与格式一致');


  return {valid:errors.length===0,errors};
}

export function createFtpSource(state,{id,name,...input}={}){
  const sourceId=String(id??'').trim(),sourceName=String(name??'').trim();
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(sourceId))throw new Error('信源标识须以小写字母开头，包含字母、数字、下划线或短横线，最多 64 位');
  if(state.providers.some(p=>p.id===sourceId))throw new Error('信源标识已存在');
  if(!sourceName||sourceName.length>60)throw new Error('信源名称须为 1–60 个字符');
  const config={protocol:'ftps',host:'ftp.example.invalid',port:21,directory:'/enterprise',filePattern:'enterprise_*.json',username:'demo_reader',format:'json'};
  for(const key of Object.keys(config))if(Object.hasOwn(input,key))config[key]=input[key];
  const valid=validateFtpConfig(config);if(!valid.valid)throw new Error(valid.errors.join('；'));
  const provider={id:sourceId,name:sourceName,type:'ftp',enabled:true,connectionMode:'demo',status:'demo_ready',description:'FTP / FTPS 文件接入演示；目录和文件为虚构样例，未建立真实网络连接。',ftpConfig:config};
  state.providers.push(provider);
  state.mappings[sourceId]=FIELD_DEFS.map((f,i)=>({sourceField:SOURCE_FIELDS[i],targetField:f.key,scriptId:f.type==='array'?'split_values':'',enabled:true}));
  state.schedules[sourceId]={enabled:false,mode:'incremental',frequency:'manual',intervalHours:0,time:'02:00',lastCursor:null,nextRunAt:null,description:'FTP 调度配置已保存；真实轮询及传输由服务端执行，本原型支持手动模拟接入。'};
  for(const field of FIELD_DEFS){state.priorities[field.key]??=[];if(!state.priorities[field.key].includes(sourceId))state.priorities[field.key].push(sourceId);}
  return provider;
}

/** Add one demonstration connector without resetting source configuration or imports. */
export function upgradeFtpSources(state){
  state.ftpImports??=[];
  state.ftpFileReceipts??=state.ftpImports.filter(e=>e.status==='success').map(e=>({sourceId:e.sourceId,fileKey:e.fileKey,importedAt:e.importedAt}));
  if(!state.providers.some(p=>p.type==='ftp')){let id='ftp_demo',suffix=1;while(state.providers.some(p=>p.id===id))id=`ftp_demo_${suffix++}`;createFtpSource(state,{id,name:'企业数据 FTP 信源'});}
  for(const p of state.providers.filter(p=>p.type==='ftp')){delete p.ftpConfig.mode;delete p.ftpConfig.frequency;}
  return state;
}

function demoRow(company,updatedAt){
  const values=FIELD_DEFS.map(f=>f.type==='array'?company[f.key].join('；'):company[f.key]);
  return {...Object.fromEntries(SOURCE_FIELDS.map((field,i)=>[field,values[i]])),sourceUpdatedAt:updatedAt,_synthetic:true};
}

/** Simulated remote directory, never a network request; all files and enterprises are synthetic. */
export function getFtpFiles(state,sourceId){
  const p=state.providers.find(p=>p.id===sourceId&&p.type==='ftp');if(!p)throw new Error('FTP 信源不存在');
  const config=p.ftpConfig,valid=validateFtpConfig(config);if(!valid.valid)throw new Error(valid.errors.join('；'));
  const baseline=DEMO_COMPANIES.slice(0,24).map(c=>demoRow(c,DEMO_METADATA.baselineAt));
  const changed=[...DEMO_COMPANIES.slice(0,2).map((c,i)=>demoRow({...c,legalPerson:`演示 FTP 法人${i+1}`,registeredCapitalWan:c.registeredCapitalWan+100},DEMO_METADATA.changedAt)),...DEMO_COMPANIES.slice(24).map(c=>demoRow(c,DEMO_METADATA.changedAt))];
  const expression=new RegExp('^'+config.filePattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$');
  return [{id:'full-v1',name:`enterprise_full_20261026.${config.format}`,mode:'full',modifiedAt:DEMO_METADATA.baselineAt,rows:baseline},{id:'delta-v2',name:`enterprise_incremental_20261027.${config.format}`,mode:'incremental',modifiedAt:DEMO_METADATA.changedAt,rows:changed}].map(file=>{
    const text=config.format==='json'?JSON.stringify(file.rows,null,2):[Object.keys(file.rows[0]),...file.rows.map(row=>Object.values(row))].map(row=>row.map(value=>'"'+String(value??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
    const key=`${config.protocol}://${config.host}:${config.port}${config.directory.replace(/\/$/,'')}/${file.name}@${file.modifiedAt}`;
    return {...file,key,text,bytes:new TextEncoder().encode(text).length,path:`${config.directory.replace(/\/$/,'')}/${file.name}`};
  }).filter(file=>expression.test(file.name));
}

export function importFtpFile(state,sourceId,fileId,{mode,runScript,preparedRows,now=new Date().toISOString()}={}){
  const provider=state.providers.find(p=>p.id===sourceId&&p.type==='ftp');if(!provider)throw new Error('FTP 信源不存在');
  const file=getFtpFiles(state,sourceId).find(f=>f.id===fileId);if(!file)throw new Error('文件不存在或不符合已保存的文件名规则');
  if((state.ftpFileReceipts??state.ftpImports.filter(e=>e.status==='success')).some(entry=>entry.sourceId===sourceId&&entry.fileKey===file.key))throw new Error('该文件版本已成功接入，无需重复导入');
  if(!Number.isFinite(Date.parse(now))||Date.parse(file.modifiedAt)>Date.parse(now))throw new Error('文件修改时间晚于本次执行时间，请稍后重试');
  const mappings=validateFtpMappings(state,sourceId);if(!mappings.valid)throw new Error(mappings.errors.join('；'));
  mode??=state.schedules[sourceId]?.mode||'incremental';
  const schedule=state.schedules[sourceId],result=applyBatch(state,{sourceId,rows:preparedRows??file.rows,mode,runScript,now,windowStart:mode==='incremental'?schedule.lastCursor:undefined,windowEnd:mode==='incremental'?now:undefined});
  result.task.scope=`FTP 演示文件 ${file.path}；${mode==='full'?'全量按信用代码新增或更新，文件缺失行不删除':'增量按 (上次成功检查点, 本次执行时间] 处理，旧版本不覆盖新数据'}`;
  result.task.fileName=file.name;
  state.ftpImports.unshift({id:`ftp_import_${state.sequence++}`,sourceId,fileId,fileKey:file.key,fileName:file.name,path:file.path,bytes:file.bytes,mode,status:result.task.status,taskId:result.task.id,importedAt:now,received:result.task.received,processed:result.task.processed,failed:result.task.failed,skipped:result.task.skipped,message:result.task.message});
  if(result.task.status==='success'){state.ftpFileReceipts??=[];state.ftpFileReceipts.push({sourceId,fileKey:file.key,importedAt:now});}
  state.ftpImports=state.ftpImports.slice(0,200);
  return result;
}

export function validateFtpMappings(state,id){
  const result=validateMappings(state,id),errors=[...result.errors];
  for(const m of (state.mappings[id]??[]).filter(m=>m.enabled!==false))if(!/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(m.sourceField)||m.sourceField.split('.').some(p=>['__proto__','prototype','constructor'].includes(p)))errors.push('来源字段须为安全的字段名称或点路径');
  return {valid:errors.length===0,errors:[...new Set(errors)]};
}

function connectionForm(provider,newSource=false){
  const config=provider.ftpConfig;
  return `<form id="ftp-config-form" class="form-grid">${newSource?`<div class="form-field"><label for="ftp-id">信源标识</label><input id="ftp-id" name="id" value="ftp_${Date.now().toString(36)}" maxlength="64"></div>`:''}<div class="form-field ${newSource?'':'full'}"><label for="ftp-name">信源名称</label><input id="ftp-name" name="name" value="${esc(provider.name)}" maxlength="60"></div><div class="form-field"><label for="ftp-protocol">传输协议</label><select id="ftp-protocol" name="protocol">${options([['ftp','FTP'],['ftps','FTPS（显式 TLS）']],config.protocol)}</select></div><div class="form-field"><label for="ftp-host">主机</label><input id="ftp-host" name="host" value="${esc(config.host)}" placeholder="ftp.example.com"></div><div class="form-field"><label for="ftp-port">端口</label><input id="ftp-port" name="port" type="number" min="1" max="65535" value="${esc(config.port)}"></div><div class="form-field"><label for="ftp-username">用户名</label><input id="ftp-username" name="username" value="${esc(config.username)}" maxlength="80"></div><div class="form-field"><label for="ftp-directory">远端目录</label><input id="ftp-directory" name="directory" value="${esc(config.directory)}"></div><div class="form-field"><label for="ftp-format">文件格式</label><select id="ftp-format" name="format">${options([['json','JSON 对象数组'],['csv','CSV · UTF-8 / 首行为表头']],config.format)}</select></div><div class="form-field full"><label for="ftp-pattern">文件名规则</label><input id="ftp-pattern" name="filePattern" value="${esc(config.filePattern)}"><small>支持 * 和 ?，例如 enterprise_*.json；须与文件格式一致。</small></div></form><p class="subtle section-gap">演示配置仅保存到当前工作空间，不收集真实密码。更新机制、频率、执行时间统一在更新任务配置；定时轮询及 FTP / FTPS 传输需由服务端实现。</p>`;
}

function readConfig(){
  const form=new FormData(document.querySelector('#ftp-config-form'));
  return {id:String(form.get('id')??''),name:String(form.get('name')??'').trim(),protocol:form.get('protocol'),host:String(form.get('host')??'').trim(),port:Number(form.get('port')),username:String(form.get('username')??'').trim(),directory:String(form.get('directory')??'').trim(),format:form.get('format'),filePattern:String(form.get('filePattern')??'').trim()};
}

function mappingTable(state,provider){
  return `<p class="subtle">将远端文件的来源字段映射至中心标准字段；转换逻辑在脚本管理独立维护，仅可绑定已发布脚本。sourceUpdatedAt 是增量检查点字段，样例使用 ISO 时间。</p><form id="ftp-mapping-form" class="section-gap"><div class="table-wrap"><table class="mapping-table"><thead><tr><th>启用</th><th>来源字段</th><th>中心标准字段</th><th>加工脚本</th></tr></thead><tbody>${FIELD_DEFS.map(field=>{const m=(state.mappings[provider.id]??[]).find(m=>m.targetField===field.key)||{sourceField:'',enabled:false,scriptId:''};return `<tr data-ftp-field="${field.key}"><td><input aria-label="启用${field.label}" name="${field.key}_enabled" type="checkbox" ${m.enabled!==false?'checked':''}></td><td><input aria-label="${field.label}来源字段" name="${field.key}_source" value="${esc(m.sourceField)}"></td><td>${esc(field.label)}${field.required?' *':''}<small class="subtle"> ${field.key}</small></td><td><select aria-label="${field.label}加工脚本" name="${field.key}_script">${options([['','不加工'],...state.scripts.filter(s=>s.status==='published').map(s=>[s.id,`${s.name} · v${s.version}`])],m.scriptId)}</select></td></tr>`;}).join('')}</tbody></table></div></form><div class="panel-actions">${button('保存字段映射','save-mappings',provider.id,'primary')}</div>`;
}

function remoteFiles(state,provider){
  const files=getFtpFiles(state,provider.id),history=(state.ftpFileReceipts??state.ftpImports.filter(e=>e.status==='success')).filter(e=>e.sourceId===provider.id);
  return `<div class="inline-notice"><span class="badge blue">模拟远端目录</span><span>以下文件及企业均为虚构演示数据。按已保存的目录、格式及文件名规则展示；点击接入会真实写入本原型的数据存储、任务及字段血缘。</span></div><p class="subtle">目录：${esc(provider.ftpConfig.directory)} · 文件规则：${esc(provider.ftpConfig.filePattern)} · 已接入的同一文件版本不重复处理。</p><div class="table-wrap section-gap"><table><thead><tr><th>文件名称</th><th>类型 / 记录数</th><th>大小 / 修改时间</th><th>接入状态</th><th>操作</th></tr></thead><tbody>${files.map(file=>{const imported=history.find(h=>h.fileKey===file.key);return `<tr><td><strong>${esc(file.name)}</strong><p class="subtle">${esc(file.path)}</p></td><td>${file.mode==='full'?'初始全量样例':'增量变化样例'}<p class="subtle">${file.rows.length} 条</p></td><td>${(file.bytes/1024).toFixed(1)} KB<p class="subtle">${stamp(file.modifiedAt)}</p></td><td><span class="badge ${imported?'success':'neutral'}">${imported?'已接入':'待接入'}</span></td><td><div class="actions">${button('预览','preview',provider.id,'ghost',`data-file="${file.id}"`)}${button('模拟接入','import',provider.id,'primary',`data-file="${file.id}" ${imported?'disabled':''}`)}</div></td></tr>`;}).join('')||'<tr><td colspan="5" class="empty">没有符合规则的演示文件，请修改文件名规则后保存。</td></tr>'}</tbody></table></div>`;
}

function importHistory(state,provider){
  return `<p class="subtle">当前工作空间最多保留 200 条 FTP 接入记录。成功文件版本按信源、远端路径及修改时间去重；失败和部分成功可修复后重试。</p><div class="table-wrap section-gap"><table><thead><tr><th>文件 / 任务</th><th>机制</th><th>接收 / 处理 / 跳过 / 失败</th><th>状态</th><th>接入时间</th><th>明细</th></tr></thead><tbody>${state.ftpImports.filter(e=>e.sourceId===provider.id).map(entry=>`<tr><td>${esc(entry.fileName)}<p class="subtle">${esc(entry.taskId)}</p></td><td>${entry.mode==='full'?'全量':'增量'}</td><td>${entry.received} / ${entry.processed} / ${entry.skipped} / ${entry.failed}</td><td><span class="badge ${entry.status==='success'?'success':'warning'}">${{success:'成功',partial:'部分成功',failed:'失败'}[entry.status]||esc(entry.status)}</span></td><td>${stamp(entry.importedAt)}</td><td>${button('查看','history-detail',provider.id,'ghost',`data-import="${esc(entry.id)}"`)}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">暂无接入记录，请到远端文件执行模拟接入。</td></tr>'}</tbody></table></div>`;
}

export function renderFtpSources(state){
  const sources=state.providers.filter(p=>p.type==='ftp'),provider=sources.find(p=>p.id===selectedId)||sources[0];
  if(!provider)return `<div class="card"><div class="card-body"><h2>FTP 对接</h2><p class="subtle">通过文件传输接入企业数据。</p>${button('新增 FTP 对接','create','','primary')}</div></div>`;
  selectedId=provider.id;
  let content=selectedTab==='mappings'?mappingTable(state,provider):selectedTab==='files'?remoteFiles(state,provider):selectedTab==='history'?importHistory(state,provider):`${connectionForm(provider)}<div class="panel-actions">${button('模拟测试连接','test',provider.id)}${button('保存配置','save-config',provider.id,'primary')}</div>`;
  return `<div class="inline-notice"><span class="badge blue">FTP 接入演示</span><span>配置 → 字段映射 → 模拟文件接入 → 统一存储。浏览器不建立真实 FTP 连接，定时执行需服务端支持。</span></div><div class="source-layout"><section class="card source-catalog"><div class="source-list-toolbar"><div><h2>FTP 信源</h2><p>${sources.length} 个已配置来源</p></div>${button('新增 FTP 对接','create','','primary small')}</div><div class="source-list">${sources.map(p=>`<button class="source-list-item ${p.id===provider.id?'active':''}" data-action="ftp-select" data-id="${esc(p.id)}"><span class="source-logo custom">F</span><span class="source-list-copy"><strong>${esc(p.name)}</strong><small>${esc(p.ftpConfig.protocol.toUpperCase())} · ${esc(p.ftpConfig.host)}</small></span><span class="badge blue">演示</span></button>`).join('')}</div><div class="source-catalog-footer">FTP / FTPS 文件支持独立字段映射和脚本转换，接入后参与统一信源排序。</div></section><section class="card source-editor"><div class="card-header"><div><h2>${esc(provider.name)}</h2><p class="subtle">${esc(provider.ftpConfig.protocol.toUpperCase())} · ${esc(provider.ftpConfig.directory)}</p></div><span class="badge blue">模拟接入</span></div><div class="tabs">${[['connection','连接配置'],['mappings','字段映射'],['files','远端文件'],['history','接入记录']].map(([key,label])=>`<button class="tab ${selectedTab===key?'active':''}" data-action="ftp-tab" data-id="${esc(provider.id)}" data-tab="${key}">${label}</button>`).join('')}</div><div class="card-body">${content}</div></section></div>`;
}

export async function handleFtpAction(action,element,ctx){
  const {getState,mutate,toast,showModal,closeModal}=ctx,op=action.replace(/^ftp-/,''),id=element.dataset.id,state=getState(),provider=state.providers.find(p=>p.id===id&&p.type==='ftp');
  if(op==='close'){closeModal();return;}
  if(op==='select'){selectFtpSource(id);ctx.render?.();return;}
  if(op==='tab'){selectedId=id;selectedTab=['connection','mappings','files','history'].includes(element.dataset.tab)?element.dataset.tab:'connection';ctx.render?.();return;}
  if(op==='create'){showModal('新增 FTP 对接',connectionForm({name:'新 FTP 信源',ftpConfig:{protocol:'ftps',host:'ftp.example.invalid',port:21,directory:'/enterprise',username:'demo_reader',format:'json',filePattern:'enterprise_*.json'}},true),button('创建信源','save-new','','primary'),true);return;}
  if(op==='save-new'){
    const input=readConfig();const ok=await mutate(()=>{const p=createFtpSource(getState(),input);selectFtpSource(p.id);},'FTP 信源已创建，可维护映射并模拟文件接入');if(ok)closeModal();return;
  }
  if(!provider){toast('FTP 信源不存在','error');return;}
  if(op==='save-config'||op==='test'){
    const {id:unused,name,...config}=readConfig(),valid=validateFtpConfig(config);if(!valid.valid||!name||name.length>60){toast([...valid.errors,...(!name||name.length>60?['信源名称须为 1–60 个字符']:[])].join('；'),'error');return;}
    if(op==='test'){showModal('模拟连接测试',`<div class="inline-notice"><span class="badge success">配置校验通过</span><span>已模拟建立连接及读取目录；未发送网络请求，不能证明主机、账户或权限真实可用。</span></div><div class="detail-grid section-gap"><div class="detail-item"><label>模拟目标</label><span>${esc(config.protocol)}://${esc(config.host)}:${config.port}${esc(config.directory)}</span></div><div class="detail-item"><label>文件规则</label><span>${esc(config.filePattern)}</span></div></div>`,button('关闭','close'),true);return;}
    await mutate(()=>{const p=getState().providers.find(p=>p.id===id);p.name=name;p.ftpConfig=config;},'FTP 配置已保存；定时传输由服务端执行');return;
  }
  if(op==='save-mappings'){
    const form=new FormData(document.querySelector('#ftp-mapping-form')),mappings=FIELD_DEFS.map(f=>({targetField:f.key,sourceField:String(form.get(`${f.key}_source`)??'').trim(),scriptId:String(form.get(`${f.key}_script`)??''),enabled:form.has(`${f.key}_enabled`)}));
    const validation=validateFtpMappings({...state,mappings:{...state.mappings,[id]:mappings}},id);if(!validation.valid){toast(validation.errors.join('；'),'error');return;}
    await mutate(()=>{getState().mappings[id]=mappings;},'FTP 字段映射已保存');return;
  }
  if(op==='preview'){
    const file=getFtpFiles(state,id).find(f=>f.id===element.dataset.file);if(!file){toast('文件不存在','error');return;}
    showModal(`${file.name} · 演示文件预览`,`<p class="subtle">虚构样例 · ${file.rows.length} 条记录 · 展示前 3 条。原始更新时间 sourceUpdatedAt 用于增量接入。</p><pre class="code-editor section-gap">${esc(provider.ftpConfig.format==='json'?JSON.stringify(file.rows.slice(0,3),null,2):file.text.split('\r\n').slice(0,4).join('\n'))}</pre>`,button('模拟接入','import',id,'primary',`data-file="${file.id}"`),true);return;
  }
  if(op==='import'){
    const file=getFtpFiles(state,id).find(f=>f.id===element.dataset.file);if(!file){toast('文件不存在','error');return;}
    showModal('执行 FTP 模拟接入',`<p><strong>${esc(file.name)}</strong> · ${file.rows.length} 条虚构记录</p><form id="ftp-import-form" class="form-grid section-gap"><div class="form-field full"><label for="ftp-import-mode">本次更新机制</label><select id="ftp-import-mode" name="mode">${options([['full','全量：按信用代码新增或更新，缺失行不删除'],['incremental','增量：使用来源更新时间及最近成功检查点']],state.schedules[id]?.mode||'incremental')}</select></div></form><p class="subtle section-gap">最近成功检查点：${stamp(state.schedules[id].lastCursor)}。接入后可在更新任务、数据存储和信源排序中查看。</p>`,button('执行并入库','execute-import',id,'primary',`data-file="${file.id}"`),true);return;
  }
  if(op==='execute-import'){
    const mode=new FormData(document.querySelector('#ftp-import-form')).get('mode'),file=getFtpFiles(state,id).find(f=>f.id===element.dataset.file);let result;
    const ok=await mutate(async()=>{const rows=copy(file?.rows||[]),runner=ctx.runScript?await ctx.runScript(rows,getState().mappings[id],id):undefined;result=importFtpFile(getState(),id,element.dataset.file,{mode,runScript:runner,preparedRows:rows});});
    if(ok){closeModal();selectedTab='history';toast(result.task.message,result.task.failed?'warning':'success');ctx.render?.();}return;
  }
  if(op==='history-detail'){
    const entry=state.ftpImports.find(e=>e.id===element.dataset.import&&e.sourceId===id),task=state.tasks.find(t=>t.id===entry?.taskId);if(!entry){toast('接入记录不存在','error');return;}
    showModal('FTP 接入明细',`<p><strong>${esc(entry.fileName)}</strong></p><p class="subtle">${esc(entry.path)} · ${esc(entry.taskId)} · ${stamp(entry.importedAt)}</p><p class="section-gap">${esc(entry.message)}</p>${task?`<p class="subtle section-gap">中心新增 ${task.newEnterprises} · 中心变化 ${task.changedEnterprises} · 跳过 ${task.skipped} · 拒绝旧版本 ${task.ignoredStale}</p>${task.errors.length?`<pre class="code-editor section-gap">${esc(JSON.stringify(task.errors,null,2))}</pre>`:''}`:''}`,button('关闭','close'),true);
  }
}
