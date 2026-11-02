import {normalizeUpdateScope,validateUpdateScope,previewUpdateScope,parseScopeRows,scopeSummary} from './update-scope.mjs';
import {readTableFile,downloadCSV} from './file-reader.mjs';

const FREQUENCIES={manual:'手动',hourly:'按小时间隔',daily:'每天',weekly:'每周'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iso=now=>new Date(now??Date.now()).toISOString();
const time=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'—';
const button=(title,action,id='',kind='secondary',extra='')=>`<button class="btn ${kind}" data-action="update-job-${action}" data-id="${esc(id)}" ${extra}>${title}</button>`;
const options=(items,value)=>items.map(([key,label])=>`<option value="${esc(key)}" ${String(value)===String(key)?'selected':''}>${esc(label)}</option>`).join('');
const sources=state=>(state.providers??[]).filter(p=>['api','ftp'].includes(p.type));
const weekdays=['','周一','周二','周三','周四','周五','周六','周日'];
const randomId=()=>`job_${globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)}`;

export function validateUpdateJob(state,job){
  const errors=[];
  if(!job||typeof job!=='object')return {valid:false,errors:['更新任务不能为空']};
  if(!String(job.name??'').trim()||String(job.name).length>60)errors.push('任务名称须为 1–60 个字符');
  if(!sources(state).some(p=>p.id===job.sourceId))errors.push('请选择有效的 API 或 FTP 信源');
  if(!['full','incremental'].includes(job.mode))errors.push('更新机制须为全量或增量');
  if(!Object.hasOwn(FREQUENCIES,job.frequency))errors.push('请选择有效的更新频率');
  if(typeof job.enabled!=='boolean')errors.push('任务启用状态须为布尔值');
  if(job.time&&!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(job.time))errors.push('执行时间须使用有效的 HH:mm 格式');
  if(['daily','weekly'].includes(job.frequency)&&!job.time)errors.push('每日或每周任务必须填写执行时间');
  if(job.frequency==='hourly'&&(!Number.isInteger(job.intervalHours)||job.intervalHours<1||job.intervalHours>720))errors.push('间隔小时数须为 1–720 的整数');
  if(job.frequency==='weekly'&&(!Number.isInteger(job.weekday)||job.weekday<1||job.weekday>7))errors.push('每周执行日须为周一至周日');
  const source=sources(state).find(p=>p.id===job.sourceId);
  if(source?.type==='api')errors.push(...validateUpdateScope(state,job.scope,source).errors);
  return {valid:errors.length===0,errors};
}

/** Next strictly future occurrence; daily and weekly use fixed Beijing time (UTC+8). */
export function nextJobRun(job,now=Date.now()){
  if(!job.enabled||job.frequency==='manual')return null;
  const ms=new Date(now).getTime();if(!Number.isFinite(ms))throw new Error('任务计算时间无效');
  if(job.frequency==='hourly'){
    if(!Number.isInteger(job.intervalHours)||job.intervalHours<1||job.intervalHours>720)throw new Error('间隔小时数须为 1–720 的整数');
    return new Date(ms+job.intervalHours*3600000).toISOString();
  }
  if(!['daily','weekly'].includes(job.frequency)||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(job.time??'')))throw new Error('执行频率或执行时间无效');
  const day=86400000,offset=8*3600000,local=new Date(ms+offset),[hour,minute]=job.time.split(':').map(Number);
  let target=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),hour,minute)-offset;
  if(job.frequency==='weekly'){
    if(!Number.isInteger(job.weekday)||job.weekday<1||job.weekday>7)throw new Error('每周执行日无效');
    target+=((job.weekday-(local.getUTCDay()||7)+7)%7)*day;
    if(target<=ms)target+=7*day;
  }else if(target<=ms)target+=day;
  return new Date(target).toISOString();
}

/** Migrate source schedules once. Job checkpoints remain independent after migration. */
export function upgradeUpdateJobs(state,now=Date.now()){
  state.updateJobs??=[];
  if(state.updateJobsVersion===1)return state;
  for(const provider of sources(state)){
    if(state.updateJobs.some(job=>job.migratedSourceId===provider.id))continue;
    const schedule=state.schedules?.[provider.id]||{},frequency=Object.hasOwn(FREQUENCIES,schedule.frequency)?schedule.frequency:'manual';
    const job={id:randomId(),name:`${provider.name}更新任务`,sourceId:provider.id,mode:schedule.mode==='full'?'full':'incremental',frequency,time:typeof schedule.time==='string'&&(!['daily','weekly'].includes(frequency)||/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))?schedule.time:'02:00',weekday:Number.isInteger(schedule.weekday)&&schedule.weekday>=1&&schedule.weekday<=7?schedule.weekday:1,intervalHours:Number.isInteger(schedule.intervalHours)&&(frequency!=='hourly'||schedule.intervalHours>=1&&schedule.intervalHours<=720)?schedule.intervalHours:1,enabled:Boolean(schedule.enabled),lastCursor:schedule.lastCursor??null,nextRunAt:null,lastRunAt:schedule.lastRunAt??null,lastTaskId:null,lastRunStatus:null,lastError:'',runCount:0,createdAt:iso(now),updatedAt:iso(now),migratedSourceId:provider.id};
    job.nextRunAt=!job.enabled||frequency==='manual'?null:Number.isFinite(Date.parse(schedule.nextRunAt))?schedule.nextRunAt:nextJobRun(job,now);
    state.updateJobs.push(job);
  }
  state.updateJobsVersion=1;
  return state;
}

export function createUpdateJob(state,input,{now=Date.now()}={}){
  const source=sources(state).find(p=>p.id===input.sourceId);
  const job={id:randomId(),name:String(input.name??'').trim(),sourceId:input.sourceId,mode:input.mode,frequency:input.frequency,time:String(input.time??'').trim(),weekday:input.weekday??1,intervalHours:input.intervalHours??1,enabled:input.enabled??true,...(source?.type==='api'?{scope:normalizeUpdateScope(input.scope),scopeBaselines:[],scopeTargetCursors:{},lastScopeTargetKeys:[]}:{}),lastCursor:null,nextRunAt:null,lastRunAt:null,lastTaskId:null,lastRunStatus:null,lastError:'',runCount:0,createdAt:iso(now),updatedAt:iso(now)};
  const validation=validateUpdateJob(state,job);if(!validation.valid)throw new Error(validation.errors.join('；'));
  while(state.updateJobs.some(j=>j.id===job.id))job.id=randomId();
  job.nextRunAt=nextJobRun(job,now);state.updateJobs.push(job);return job;
}

/** Returns the earliest enabled due task whose source is enabled. Manual tasks never become due. */
export function dueUpdateJob(state,now=Date.now()){
  const at=new Date(now).getTime();if(!Number.isFinite(at))return null;
  return (state.updateJobs??[]).filter(job=>job.enabled&&job.frequency!=='manual'&&job.nextRunAt&&Date.parse(job.nextRunAt)<=at&&sources(state).some(p=>p.id===job.sourceId&&p.enabled!==false&&!(p.type==='api'&&p.requestScope==='single'))).sort((a,b)=>Date.parse(a.nextRunAt)-Date.parse(b.nextRunAt))[0]||null;
}

/** Finish one attempt. Only a completely successful run can advance the task checkpoint. */
export function finishUpdateJob(state,jobId,options={}){
  const {task,now=Date.now(),error}=options;
  const job=state.updateJobs?.find(j=>j.id===jobId);if(!job)throw new Error('更新任务不存在');
  const at=iso(now),success=!error&&task?.status==='success'&&!(task.failed>0);
  job.lastRunAt=at;job.lastTaskId=task?.id??null;job.lastRunStatus=success?'success':task?.status==='partial'?'partial':'failed';
  job.lastError=error?String(error.message??error):success?'':String(task?.message??'任务执行失败');job.runCount=(job.runCount??0)+1;job.updatedAt=at;
  if(success){const candidate=Object.hasOwn(options,'cursor')?options.cursor:state.schedules?.[job.sourceId]?.lastCursor;if(Number.isFinite(Date.parse(candidate))&&(!job.lastCursor||Date.parse(candidate)>Date.parse(job.lastCursor)))job.lastCursor=candidate;}
  job.nextRunAt=nextJobRun(job,at);return job;
}

let scopeSession=null;
const formScopeType=form=>form.querySelector('[name="scopeType"]:checked')?.value||'all';
const readSelected=(form,name)=>[...form.querySelectorAll(`[name="${name}"]:checked`)].map(input=>input.value);

/** A preview belongs to one source and exact scope content; changing either invalidates confirmation. */
export function updateScopeFingerprint(sourceId,scope,source=null){return JSON.stringify([String(sourceId),normalizeUpdateScope(scope),source]);}

export function updateScopeOptions(state,scope){
  const normalized=normalizeUpdateScope(scope),regions=new Set(normalized.filters.regions),industries=new Set(normalized.filters.industries),qualifications=new Set(normalized.filters.qualifications);
  for(const record of state.records||[]){
    const parts=[];for(const field of ['regionProvince','regionCity','regionDistrict']){if(!record[field])break;parts.push(record[field]);regions.add(parts.join('/'));}
    if(record.industry)industries.add(record.industry);
    for(const value of Array.isArray(record.qualifications)?record.qualifications:[])if(value)qualifications.add(value);
  }
  const sorted=values=>[...values].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  return {regions:sorted(regions),industries:sorted(industries),qualifications:sorted(qualifications)};
}

export function renderUpdateScopePreview(preview,{single=false,confirmed=false}={}){
  if(single)return '<div class="inline-notice scope-preview-note"><span class="badge warning">需使用逐企接口</span><span>本信源不支持逐企更新任务，请选择逐企 API 信源。列表接口可在数据接入中执行接入。</span></div>';
  if(!preview)return '<p class="subtle scope-preview-empty">配置范围后点击“校验并预览范围”，确认更新对象。</p>';
  const targets=preview.targets||[],errors=preview.errors||[],known=targets.filter(target=>target.known).length;
  return `<div class="scope-preview-stats">${[['去重目标企业',targets.length],['库内企业',known],['待新增企业',targets.length-known],['预计请求次数',targets.length]].map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div><p class="subtle">${confirmed?'已确认当前配置范围。':'预览尚未确认，请点击校验。'} 去重 ${preview.duplicates||0} 行，异常 ${errors.length} 行。实际调用与计费以信源接口规则为准。</p>${errors.length?`<div class="scope-errors" role="alert"><strong>请修正名单中的异常行后重新上传</strong><ul>${errors.slice(0,20).map(error=>`<li>第 ${esc(error.row)} 行：${esc(error.message)}</li>`).join('')}</ul>${errors.length>20?`<p>另有 ${errors.length-20} 条异常。</p>`:''}</div>`:''}<div class="table-wrap scope-preview-table"><table><thead><tr><th>企业全称</th><th>统一社会信用代码</th><th>对象状态</th></tr></thead><tbody>${targets.slice(0,25).map(target=>`<tr><td>${esc(target.enterpriseName||'待厂商返回')}</td><td>${esc(target.creditCode||'待厂商确认')}</td><td><span class="badge ${target.known?'blue':'warning'}">${target.known?'库内企业':'待新增'}</span></td></tr>`).join('')||'<tr><td colspan="3" class="empty">当前没有匹配企业。条件范围将在每次执行前重新计算。</td></tr>'}</tbody></table></div>${targets.length>25?`<p class="subtle">展示前 25 家，共 ${targets.length} 家企业；执行时按完整去重名单处理。</p>`:''}`;
}

function scopeChecks(name,values,selected,emptyText,disabled=false){return values.length?values.map(value=>`<label class="checkbox-label"><input type="checkbox" name="${name}" value="${esc(value)}" ${selected.includes(value)?'checked':''} ${disabled?'disabled':''}><span>${esc(value.replaceAll('/',' / '))}</span></label>`).join(''):`<p class="subtle">${emptyText}</p>`;}

function scopePanel(state,sourceId,scope,preview=null,confirmed=false){
  const source=sources(state).find(p=>p.id===sourceId);if(source?.type!=='api')return '';
  const current=normalizeUpdateScope(scope),single=source.requestScope==='single',choices=updateScopeOptions(state,current);
  return `<div class="scope-section-heading"><div><h3>更新企业范围</h3><p class="subtle">范围决定请求哪些企业，更新机制决定如何更新这些企业。</p></div></div><div class="scope-type-options">${[['all','全部企业','中心已有的全部企业'],['filters','按条件筛选','按地区、行业、荣誉资质圈定'],['list','上传企业名单','可包含尚未入库的企业']].map(([value,label,description])=>`<label class="scope-type-option ${current.type===value?'selected':''} ${single?'unavailable':''}"><input type="radio" name="scopeType" value="${value}" ${current.type===value?'checked':''} ${single?'disabled':''}><span><strong>${label}</strong><small>${description}</small></span></label>`).join('')}</div>${single?'<p class="subtle">当前信源为列表接口，不支持全部企业、按条件或上传名单的逐企更新任务。请改选逐企 API 信源，或在 API 对接中调整调用方式。</p>':''}${current.type==='filters'?`<div class="scope-filter-grid">${[['regions','注册地区','scope-region','暂无地区，可先接入企业数据。'],['industries','国民经济行业','scope-industry','暂无行业，可先接入企业数据。'],['qualifications','荣誉资质','scope-qualification','暂无荣誉资质，可先接入企业数据。']].map(([key,label,name,emptyText])=>`<section><h4>${label}<span>可多选</span></h4><div class="scope-check-list">${scopeChecks(name,choices[key],current.filters[key],emptyText,single)}</div></section>`).join('')}</div><p class="subtle">同一维度满足任一选项，不同维度同时满足；未选维度不限。每次运行前按中心当前数据重新筛选，并固定本次执行名单。</p>`:''}${current.type==='list'?`<div class="scope-upload"><div><strong>上传更新企业名单</strong><p class="subtle">CSV / XLSX，至少提供“统一社会信用代码”或“企业全称”一列；每行一家企业。</p><p class="subtle">名单仅用于确定请求对象，不导入企业业务字段。</p></div>${button('下载名单模板','scope-template','','secondary small')}<input id="update-job-scope-file" name="scopeFile" type="file" accept=".csv,.xlsx" aria-label="上传更新企业名单" ${single?'disabled':''}><p class="scope-file-name">${current.fileName?`已选文件：${esc(current.fileName)} · ${current.entries.length} 行`:'尚未选择文件'}</p></div>`:''}<div class="scope-preview-actions">${button('校验并预览范围','scope-preview','','secondary',single?'disabled':'')}<span id="update-job-scope-confirmation" class="subtle">${confirmed?'当前范围已校验确认':'保存前需校验并预览范围'}</span></div><div id="update-job-scope-preview">${renderUpdateScopePreview(preview,{single,confirmed})}</div><p class="subtle scope-baseline-note">全量只更新选定范围，不删除范围外企业。首次纳入本任务的企业先完整采集，后续再按增量检查点更新；修改范围保留既有进度，新增对象单独补齐。</p>`;
}

export function renderUpdateJobForm(state,job,{token=''}={}){
  const scope=normalizeUpdateScope(job.scope),api=sources(state).find(p=>p.id===job.sourceId)?.type==='api';
  return `<form id="update-job-form" class="form-grid" data-scope-session="${esc(token)}"><div class="form-field full"><label for="update-job-name">任务名称</label><input id="update-job-name" name="name" value="${esc(job.name)}" maxlength="60" placeholder="例如：企查查工商信息每日增量"></div><div class="form-field"><label for="update-job-source">数据来源</label><select id="update-job-source" name="sourceId">${options(sources(state).map(p=>[p.id,`${p.name}（${p.type==='ftp'?'FTP':'API'}）`]),job.sourceId)}</select></div><div class="form-field"><label for="update-job-mode">更新机制</label><select id="update-job-mode" name="mode">${options([['full','全量更新'],['incremental','增量更新']],job.mode)}</select></div><div id="update-job-scope-panel" class="form-full scope-panel" ${api?'':'hidden'}>${scopePanel(state,job.sourceId,scope)}</div><div class="form-field"><label for="update-job-frequency">更新频率</label><select id="update-job-frequency" name="frequency">${options(Object.entries(FREQUENCIES),job.frequency)}</select></div><div class="form-field"><label for="update-job-time">执行时间（北京时间）</label><input id="update-job-time" name="time" type="time" value="${esc(job.time||'02:00')}"><small>每天、每周必填；手动及按小时间隔时不使用。</small></div><div class="form-field"><label for="update-job-interval">间隔小时数</label><input id="update-job-interval" name="intervalHours" type="number" min="1" max="720" value="${esc(job.intervalHours||1)}"><small>仅按小时间隔时生效，范围 1–720。</small></div><div class="form-field"><label for="update-job-weekday">每周执行日</label><select id="update-job-weekday" name="weekday">${options(weekdays.slice(1).map((label,i)=>[i+1,label]),job.weekday||1)}</select><small>仅每周频率生效。</small></div><div class="form-field full"><label class="checkbox-label"><input name="enabled" type="checkbox" ${job.enabled?'checked':''}>启用任务</label></div></form><p class="subtle section-gap">增量使用本任务独立检查点，失败不推进。更换数据来源或更新机制将重新建立采集基线。本地文件通过上传手动接入，不参与定时任务。</p>`;
}

function readScopeForm(form){return normalizeUpdateScope({...(scopeSession?.scope||{}),type:formScopeType(form),filters:{regions:readSelected(form,'scope-region'),industries:readSelected(form,'scope-industry'),qualifications:readSelected(form,'scope-qualification')}});}
function activeScopeForm(){const form=document.querySelector('#update-job-form');return form&&scopeSession&&form.dataset.scopeSession===scopeSession.token?form:null;}
function invalidateScopePreview(){if(scopeSession){scopeSession.preview=null;scopeSession.previewKey=null;scopeSession.readGeneration=(scopeSession.readGeneration||0)+1;scopeSession.busy=false;}const output=document.querySelector('#update-job-scope-preview');if(output)output.innerHTML=renderUpdateScopePreview(null);const confirmation=document.querySelector('#update-job-scope-confirmation');if(confirmation)confirmation.textContent='范围已变更，请重新校验预览';}
function updateScopeSaveAvailability(state){const form=activeScopeForm();if(!form)return;const sourceId=form.querySelector('[name="sourceId"]').value,source=sources(state).find(p=>p.id===sourceId),api=source?.type==='api',confirmed=scopeSession.previewKey===updateScopeFingerprint(sourceId,readScopeForm(form),source);document.querySelectorAll('[data-action="update-job-save-new"],[data-action="update-job-save-edit"]').forEach(button=>{button.disabled=Boolean(scopeSession.busy||(api&&(!confirmed||source.requestScope==='single')));});}
function refreshScopePanel(state,form){const sourceId=form.querySelector('[name="sourceId"]').value,panel=form.querySelector('#update-job-scope-panel');panel.hidden=sources(state).find(p=>p.id===sourceId)?.type!=='api';panel.innerHTML=panel.hidden?'':scopePanel(state,sourceId,scopeSession.scope,scopeSession.preview,Boolean(scopeSession.previewKey));updateScopeSaveAvailability(state);}

/** Delegated input/change handler. The application owns document listeners. */
export async function handleUpdateJobFormEvent(event,ctx){
  const form=event.target?.closest?.('#update-job-form');if(!form||form!==activeScopeForm())return;
  const field=event.target,state=ctx.getState();
  if(field.name==='sourceId'){
    scopeSession.scope=readScopeForm(form);const source=sources(state).find(p=>p.id===field.value);
    if(source?.type!=='api')scopeSession.scope=normalizeUpdateScope();
    invalidateScopePreview();refreshScopePanel(state,form);return;
  }
  if(field.name==='scopeType'){
    scopeSession.scope=readScopeForm(form);invalidateScopePreview();refreshScopePanel(state,form);return;
  }
  if(['scope-region','scope-industry','scope-qualification'].includes(field.name)){
    scopeSession.scope=readScopeForm(form);invalidateScopePreview();updateScopeSaveAvailability(state);return;
  }
  if(field.id==='update-job-scope-file'&&event.type==='change'){
    const token=scopeSession.token,file=field.files?.[0];scopeSession.scope=normalizeUpdateScope({type:'list'});invalidateScopePreview();const generation=scopeSession.readGeneration;scopeSession.busy=Boolean(file);updateScopeSaveAvailability(state);
    if(!file){refreshScopePanel(state,form);return;}
    const output=form.querySelector('#update-job-scope-preview');if(output)output.innerHTML='<p class="subtle">正在读取企业名单…</p>';
    try{
      const rows=await readTableFile(file,{preserveBlankRows:true,includeRowNumbers:true});if(scopeSession?.token!==token||scopeSession.readGeneration!==generation||form!==activeScopeForm())return;
      const result=parseScopeRows(ctx.getState(),rows,{fileName:file.name});scopeSession.scope=result.scope;scopeSession.preview=result.preview;
      ctx.toast(result.preview.errors.length?'名单存在异常行，请修正后重新上传':'名单已读取，请校验并预览范围',result.preview.errors.length?'error':'success');
    }catch(error){if(scopeSession?.token===token&&scopeSession.readGeneration===generation){scopeSession.scope=normalizeUpdateScope({type:'list'});ctx.toast(error.message,'error');}}
    finally{if(scopeSession?.token===token&&scopeSession.readGeneration===generation&&form===activeScopeForm()){scopeSession.busy=false;refreshScopePanel(ctx.getState(),form);}}
  }
}

function frequencyText(job){return job.frequency==='hourly'?`每 ${job.intervalHours} 小时`:job.frequency==='weekly'?`每周 ${weekdays[job.weekday]}`:FREQUENCIES[job.frequency]||'—';}

export function updateJobScopeText(state,job){
  const source=sources(state).find(p=>p.id===job.sourceId);if(source?.type==='ftp')return '按 FTP 文件内容';
  if(source?.requestScope==='single')return `${scopeSummary(job.scope)} · 需改用逐企信源`;
  const scope=normalizeUpdateScope(job.scope),count=Object.values(scope.filters).reduce((sum,values)=>sum+values.length,0);
  return scope.type==='filters'?`${scopeSummary(scope)} · ${count} 项条件`:scopeSummary(scope);
}

/** Editing a scope keeps progress for existing objects. New objects obtain their own first baseline. */
export function saveUpdateJob(state,id,input,{now=Date.now()}={}){
  const target=state.updateJobs?.find(j=>j.id===id);if(!target)throw new Error('更新任务不存在');
  const source=sources(state).find(p=>p.id===input.sourceId),candidate={...input,...(source?.type==='api'?{scope:normalizeUpdateScope(input.scope)}:{})},validation=validateUpdateJob(state,candidate);
  if(!validation.valid)throw new Error(validation.errors.join('；'));
  const resetCursor=target.sourceId!==candidate.sourceId||target.mode!==candidate.mode;
  Object.assign(target,candidate,{updatedAt:iso(now)});
  if(source?.type!=='api'){delete target.scope;delete target.scopeBaselines;delete target.scopeTargetCursors;delete target.lastScopeTargetKeys;}
  if(resetCursor){Object.assign(target,{lastCursor:null,lastTaskId:null,lastRunStatus:null,lastError:'',lastRunAt:null});if(source?.type==='api')Object.assign(target,{scopeBaselines:[],scopeTargetCursors:{},lastScopeTargetKeys:[]});}
  target.nextRunAt=nextJobRun(target,now);return target;
}

export function renderUpdateJobs(state){
  return `<section class="card"><div class="card-header"><div><h2>更新任务配置</h2><p class="subtle">统一配置 API / FTP 的更新范围、机制、频率和执行时间</p></div>${button('新增任务','create','','primary')}</div><div class="card-body"><div class="inline-notice"><span class="badge blue">统一调度</span><span>API 可按全部企业、筛选条件或上传名单更新；每次执行固定本次范围，新增对象先完整采集。FTP 按文件内容处理；本地文件通过模板上传。</span></div><div class="table-wrap"><table><thead><tr><th>任务名称</th><th>数据来源 / 方式</th><th>更新企业范围</th><th>更新机制</th><th>频率 / 时间</th><th>下一次执行</th><th>状态 / 最近结果</th><th>操作</th></tr></thead><tbody>${(state.updateJobs??[]).map(job=>{const p=state.providers.find(p=>p.id===job.sourceId);return `<tr><td><strong>${esc(job.name)}</strong><p class="subtle">${esc(job.id)}</p></td><td>${esc(p?.name||'来源已移除')}<p class="subtle">${p?.type==='ftp'?'FTP 文件接入':'API 对接'}</p></td><td>${esc(updateJobScopeText(state,job))}${p?.type==='api'&&job.scope?.type==='filters'?'<p class="subtle">执行前重新筛选</p>':''}</td><td>${job.mode==='full'?'全量更新':'增量更新'}</td><td>${esc(frequencyText(job))}<p class="subtle">${['daily','weekly'].includes(job.frequency)?`${esc(job.time)}（北京时间）`:job.frequency==='manual'?'立即运行触发':'距上次运行按间隔推进'}</p></td><td>${job.frequency==='manual'?'手动触发':job.enabled?time(job.nextRunAt):'已暂停'}</td><td><span class="badge ${job.enabled?'success':'neutral'}">${job.enabled?'已启用':'已暂停'}</span>${job.lastRunStatus?`<p class="subtle">${{success:'最近成功',partial:'部分成功',failed:'最近失败'}[job.lastRunStatus]||esc(job.lastRunStatus)} · ${time(job.lastRunAt)}</p>`:''}${job.lastError?`<p class="subtle text-danger">${esc(job.lastError)}</p>`:''}</td><td><div class="actions">${button('编辑','edit',job.id,'ghost small')}${button(job.enabled?'暂停':'启用','toggle',job.id,'ghost small')}${button('立即运行','run',job.id,'primary small',job.enabled&&!(p?.type==='api'&&p.requestScope==='single')?'':'disabled')}</div></td></tr>`;}).join('')||'<tr><td colspan="8" class="empty">暂无更新任务，点击新增任务选择 API 或 FTP 信源。</td></tr>'}</tbody></table></div></div></section>`;
}

function readForm(){const element=document.querySelector('#update-job-form'),form=new FormData(element);return {name:String(form.get('name')||'').trim(),sourceId:String(form.get('sourceId')||''),mode:form.get('mode'),frequency:form.get('frequency'),time:String(form.get('time')||''),weekday:Number(form.get('weekday')),intervalHours:Number(form.get('intervalHours')),enabled:form.has('enabled'),scope:readScopeForm(element)};}

export async function handleUpdateJobAction(action,element,ctx){
  const {getState,mutate,toast,showModal,closeModal}=ctx,op=action.replace(/^update-job-/,''),state=getState(),id=element.dataset.id,job=state.updateJobs?.find(j=>j.id===id);
  if(op==='scope-template'){downloadCSV('API更新企业名单模板.csv',['统一社会信用代码','企业全称'],[['','']]);return;}
  if(op==='scope-preview'){
    const form=activeScopeForm();if(!form||scopeSession.busy)return;scopeSession.scope=readScopeForm(form);
    const sourceId=form.querySelector('[name="sourceId"]').value,source=sources(state).find(p=>p.id===sourceId);
    if(source?.requestScope==='single'){invalidateScopePreview();refreshScopePanel(state,form);toast('本信源不支持逐企更新任务，请改选逐企 API 信源','error');return;}
    const validation=validateUpdateScope(state,scopeSession.scope,source);
    scopeSession.preview=previewUpdateScope(state,scopeSession.scope);scopeSession.previewKey=validation.valid?updateScopeFingerprint(sourceId,scopeSession.scope,source):null;
    refreshScopePanel(state,form);if(!validation.valid)toast(validation.errors.join('；'),'error');else toast('更新企业范围已校验确认','success');return;
  }
  if(op==='create'||op==='edit'){
    if(op==='edit'&&!job){toast('更新任务不存在','error');return;}
    if(!sources(state).length){toast('请先新增 API 或 FTP 信源','error');return;}
    const draft=job||{name:'',sourceId:sources(state).find(p=>p.id===element.dataset.sourceId)?.id||sources(state)[0].id,mode:'incremental',frequency:'manual',time:'02:00',weekday:1,intervalHours:1,enabled:true};
    scopeSession={token:randomId(),scope:normalizeUpdateScope(draft.scope),preview:null,previewKey:null,busy:false};
    const api=sources(state).find(p=>p.id===draft.sourceId)?.type==='api';
    showModal(job?'编辑更新任务':'新增更新任务',renderUpdateJobForm(state,draft,{token:scopeSession.token}),button('取消','cancel')+button('保存任务',job?'save-edit':'save-new',id,'primary',api?'disabled':''),true);return;
  }
  if(op==='cancel'){scopeSession=null;closeModal();return;}
  if(op==='save-new'||op==='save-edit'){
    const input=readForm(),valid=validateUpdateJob(state,input);if(!valid.valid){toast(valid.errors.join('；'),'error');return;}
    const source=sources(state).find(p=>p.id===input.sourceId);
    if(source?.type==='api'&&(!scopeSession||scopeSession.busy||scopeSession.previewKey!==updateScopeFingerprint(input.sourceId,input.scope,source))){toast('请先校验并预览当前更新企业范围','error');return;}
    const ok=await mutate(()=>{
      const current=getState(),currentSource=sources(current).find(p=>p.id===input.sourceId);
      if(currentSource?.type==='api'&&scopeSession?.previewKey!==updateScopeFingerprint(input.sourceId,input.scope,currentSource))throw new Error('信源配置或更新范围已变化，请重新校验预览');
      if(op==='save-new'){createUpdateJob(current,input);return;}
      saveUpdateJob(current,id,input);
    },'更新任务已保存');if(ok){scopeSession=null;closeModal();}return;
  }
  if(!job){toast('更新任务不存在','error');return;}
  if(op==='toggle'){await mutate(()=>{const target=getState().updateJobs.find(j=>j.id===id);target.enabled=!target.enabled;target.nextRunAt=nextJobRun(target);target.updatedAt=iso();},job.enabled?'任务已暂停':'任务已启用');return;}
  if(op==='run'){if(!job.enabled){toast('任务已暂停，请先启用','error');return;}if(sources(state).some(p=>p.id===job.sourceId&&p.type==='api'&&p.requestScope==='single')){toast('当前信源不支持逐企更新，请修改任务信源后运行','error');return;}if(typeof ctx.runJob!=='function'){toast('运行引擎暂不可用','error');return;}await ctx.runJob(id);}
}
