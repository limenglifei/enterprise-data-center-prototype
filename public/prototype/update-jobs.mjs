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
  const job={id:randomId(),name:String(input.name??'').trim(),sourceId:input.sourceId,mode:input.mode,frequency:input.frequency,time:String(input.time??'').trim(),weekday:input.weekday??1,intervalHours:input.intervalHours??1,enabled:input.enabled??true,lastCursor:null,nextRunAt:null,lastRunAt:null,lastTaskId:null,lastRunStatus:null,lastError:'',runCount:0,createdAt:iso(now),updatedAt:iso(now)};
  const validation=validateUpdateJob(state,job);if(!validation.valid)throw new Error(validation.errors.join('；'));
  while(state.updateJobs.some(j=>j.id===job.id))job.id=randomId();
  job.nextRunAt=nextJobRun(job,now);state.updateJobs.push(job);return job;
}

/** Returns the earliest enabled due task whose source is enabled. Manual tasks never become due. */
export function dueUpdateJob(state,now=Date.now()){
  const at=new Date(now).getTime();if(!Number.isFinite(at))return null;
  return (state.updateJobs??[]).filter(job=>job.enabled&&job.frequency!=='manual'&&job.nextRunAt&&Date.parse(job.nextRunAt)<=at&&sources(state).some(p=>p.id===job.sourceId&&p.enabled!==false)).sort((a,b)=>Date.parse(a.nextRunAt)-Date.parse(b.nextRunAt))[0]||null;
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

function jobForm(state,job){
  return `<form id="update-job-form" class="form-grid"><div class="form-field full"><label for="update-job-name">任务名称</label><input id="update-job-name" name="name" value="${esc(job.name)}" maxlength="60" placeholder="例如：企查查工商信息每日增量"></div><div class="form-field"><label for="update-job-source">数据来源</label><select id="update-job-source" name="sourceId">${options(sources(state).map(p=>[p.id,`${p.name}（${p.type==='ftp'?'FTP':'API'}）`]),job.sourceId)}</select></div><div class="form-field"><label for="update-job-mode">更新机制</label><select id="update-job-mode" name="mode">${options([['full','全量更新'],['incremental','增量更新']],job.mode)}</select></div><div class="form-field"><label for="update-job-frequency">更新频率</label><select id="update-job-frequency" name="frequency">${options(Object.entries(FREQUENCIES),job.frequency)}</select></div><div class="form-field"><label for="update-job-time">执行时间（北京时间）</label><input id="update-job-time" name="time" type="time" value="${esc(job.time||'02:00')}"><small>每天、每周必填；手动及按小时间隔时不使用。</small></div><div class="form-field"><label for="update-job-interval">间隔小时数</label><input id="update-job-interval" name="intervalHours" type="number" min="1" max="720" value="${esc(job.intervalHours||1)}"><small>仅按小时间隔时生效，范围 1–720。</small></div><div class="form-field"><label for="update-job-weekday">每周执行日</label><select id="update-job-weekday" name="weekday">${options(weekdays.slice(1).map((label,i)=>[i+1,label]),job.weekday||1)}</select><small>仅每周频率生效。</small></div><div class="form-field full"><label class="checkbox-label"><input name="enabled" type="checkbox" ${job.enabled?'checked':''}>启用任务</label></div></form><p class="subtle section-gap">全量按企业信用代码新增或更新，缺失行不删除；增量使用本任务独立检查点，失败不推进。本地文件通过上传手动接入，不参与定时任务。演示定时仅在页面打开时执行；真实 API、FTP 调度及传输需服务端支持。</p>`;
}

function frequencyText(job){return job.frequency==='hourly'?`每 ${job.intervalHours} 小时`:job.frequency==='weekly'?`每周 ${weekdays[job.weekday]}`:FREQUENCIES[job.frequency]||'—';}

export function renderUpdateJobs(state){
  return `<section class="card"><div class="card-header"><div><h2>更新任务配置</h2><p class="subtle">统一配置 API / FTP 的更新机制、频率和执行时间</p></div>${button('新增任务','create','','primary')}</div><div class="card-body"><div class="inline-notice"><span class="badge blue">统一调度</span><span>启用的演示任务在页面打开时按计划执行。正式定时及 FTP 传输由服务端执行；本地文件通过模板上传。</span></div><div class="table-wrap"><table><thead><tr><th>任务名称</th><th>数据来源 / 方式</th><th>更新机制</th><th>频率 / 时间</th><th>下一次执行</th><th>状态 / 最近结果</th><th>操作</th></tr></thead><tbody>${(state.updateJobs??[]).map(job=>{const p=state.providers.find(p=>p.id===job.sourceId);return `<tr><td><strong>${esc(job.name)}</strong><p class="subtle">${esc(job.id)}</p></td><td>${esc(p?.name||'来源已移除')}<p class="subtle">${p?.type==='ftp'?'FTP 文件接入':'API 对接'}</p></td><td>${job.mode==='full'?'全量更新':'增量更新'}</td><td>${esc(frequencyText(job))}<p class="subtle">${['daily','weekly'].includes(job.frequency)?`${esc(job.time)}（北京时间）`:job.frequency==='manual'?'立即运行触发':'距上次运行按间隔推进'}</p></td><td>${job.frequency==='manual'?'手动触发':job.enabled?time(job.nextRunAt):'已暂停'}</td><td><span class="badge ${job.enabled?'success':'neutral'}">${job.enabled?'已启用':'已暂停'}</span>${job.lastRunStatus?`<p class="subtle">${{success:'最近成功',partial:'部分成功',failed:'最近失败'}[job.lastRunStatus]||esc(job.lastRunStatus)} · ${time(job.lastRunAt)}</p>`:''}${job.lastError?`<p class="subtle text-danger">${esc(job.lastError)}</p>`:''}</td><td><div class="actions">${button('编辑','edit',job.id,'ghost small')}${button(job.enabled?'暂停':'启用','toggle',job.id,'ghost small')}${button('立即运行','run',job.id,'primary small',job.enabled?'':'disabled')}</div></td></tr>`;}).join('')||'<tr><td colspan="7" class="empty">暂无更新任务，点击新增任务选择 API 或 FTP 信源。</td></tr>'}</tbody></table></div></div></section>`;
}

function readForm(){const form=new FormData(document.querySelector('#update-job-form'));return {name:String(form.get('name')||'').trim(),sourceId:String(form.get('sourceId')||''),mode:form.get('mode'),frequency:form.get('frequency'),time:String(form.get('time')||''),weekday:Number(form.get('weekday')),intervalHours:Number(form.get('intervalHours')),enabled:form.has('enabled')};}

export async function handleUpdateJobAction(action,element,ctx){
  const {getState,mutate,toast,showModal,closeModal}=ctx,op=action.replace(/^update-job-/,''),state=getState(),id=element.dataset.id,job=state.updateJobs?.find(j=>j.id===id);
  if(op==='create'||op==='edit'){
    if(op==='edit'&&!job){toast('更新任务不存在','error');return;}
    if(!sources(state).length){toast('请先新增 API 或 FTP 信源','error');return;}
    const draft=job||{name:'',sourceId:sources(state)[0].id,mode:'incremental',frequency:'manual',time:'02:00',weekday:1,intervalHours:1,enabled:true};
    showModal(job?'编辑更新任务':'新增更新任务',jobForm(state,draft),button('保存任务',job?'save-edit':'save-new',id,'primary'),true);return;
  }
  if(op==='save-new'||op==='save-edit'){
    const input=readForm(),valid=validateUpdateJob(state,input);if(!valid.valid){toast(valid.errors.join('；'),'error');return;}
    const ok=await mutate(()=>{
      const current=getState();if(op==='save-new'){createUpdateJob(current,input);return;}
      const target=current.updateJobs.find(j=>j.id===id);if(!target)throw new Error('更新任务不存在');
      const resetCursor=target.sourceId!==input.sourceId||target.mode!==input.mode;Object.assign(target,input,{updatedAt:iso()});if(resetCursor){target.lastCursor=null;target.lastTaskId=null;target.lastRunStatus=null;target.lastError='';target.lastRunAt=null;}
      target.nextRunAt=nextJobRun(target);
    },'更新任务已保存');if(ok)closeModal();return;
  }
  if(!job){toast('更新任务不存在','error');return;}
  if(op==='toggle'){await mutate(()=>{const target=getState().updateJobs.find(j=>j.id===id);target.enabled=!target.enabled;target.nextRunAt=nextJobRun(target);target.updatedAt=iso();},job.enabled?'任务已暂停':'任务已启用');return;}
  if(op==='run'){if(!job.enabled){toast('任务已暂停，请先启用','error');return;}if(typeof ctx.runJob!=='function'){toast('运行引擎暂不可用','error');return;}await ctx.runJob(id);}
}
