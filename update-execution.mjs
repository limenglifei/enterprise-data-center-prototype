import {applyBatch,validateMappings,runBuiltinScript} from './core.mjs';
import {getFtpFiles,validateFtpMappings} from './ftp-sources.mjs';
import {finishUpdateJob} from './update-jobs.mjs';
import {freezeUpdateScope} from './update-scope.mjs';

const counters=['received','processed','added','updated','unchanged','failed','duplicates','skipped','ignoredStale','ignoredUnknownTime','newEnterprises','changedEnterprises'];
const getPath=(value,path)=>String(path||'').split('.').reduce((item,key)=>item?.[key],value);
const norm=value=>String(value??'').trim();
const code=value=>norm(value).toUpperCase();
function matchTargetRows(state,source,rows,target,runner){
  const mappings=state.mappings[source.id]||[];
  const identity=(row,key)=>{const mapping=mappings.find(item=>item.enabled!==false&&item.targetField===key);let value=getPath(row,mapping?.sourceField);if(mapping?.scriptId){const script=state.scripts.find(item=>item.id===mapping.scriptId&&item.status==='published');value=runner(script,value,{row,sourceId:source.id,targetField:key});}return key==='creditCode'?code(value):norm(value);};
  const identities=rows.map(row=>({creditCode:identity(row,'creditCode'),enterpriseName:identity(row,'enterpriseName')}));
  if(identities.some(identity=>target.creditCode?identity.creditCode!==target.creditCode:identity.enterpriseName!==target.enterpriseName))throw new Error('接口返回了任务目标之外的企业，已拒绝本次响应；请使用逐企查询接口');
  if(new Set(identities.map(identity=>identity.creditCode)).size>1)throw new Error('企业全称对应多个信用代码，请补充统一社会信用代码后重试');
  return identities[0]?.creditCode||target.creditCode;
}

function cachedRunner(runner=runBuiltinScript){
  const rows=new WeakMap();
  return (script,value,context)=>{let fields=rows.get(context.row);if(!fields){fields=new Map();rows.set(context.row,fields);}if(!fields.has(context.targetField))fields.set(context.targetField,runner(script,value,context));const result=fields.get(context.targetField);if(result&&typeof result.then==='function')throw new Error('批处理脚本须同步返回转换结果');return result;};
}

async function executeEnterpriseScope(state,job,source,{loadInput,runScript,now,isolated}){
  const mappingValidation=validateMappings(state,source.id);if(!mappingValidation.valid)throw new Error(mappingValidation.errors.join('；'));
  const snapshot=freezeUpdateScope(state,job,now),originalCursor=job.lastCursor||null,baselineKeys=new Set(Array.isArray(job.scopeBaselines)?job.scopeBaselines:[]);
  const targetCursors={...(job.scopeTargetCursors||{})},previousKeys=Array.isArray(job.lastScopeTargetKeys)?new Set(job.lastScopeTargetKeys):null;
  const activeKeys=new Set(snapshot.targets.map(target=>target.key));
  // Existing tasks with a checkpoint predate explicit scope and already include the center population.
  if(!Object.hasOwn(job,'scopeBaselines')&&!job.scope&&originalCursor)for(const target of snapshot.targets){baselineKeys.add(target.key);targetCursors[target.key]=originalCursor;}
  const task={id:`task_${state.sequence++}`,jobId:job.id,jobName:job.name,sourceId:source.id,sourceName:source.name,mode:job.mode,status:'success',startedAt:now,completedAt:now,...Object.fromEntries(counters.map(key=>[key,0])),errors:[],requested:0,windowStart:job.mode==='incremental'?originalCursor:null,windowEnd:now,scopeSnapshot:{...snapshot,requestMode:'enterprise'},targetResults:[],scope:`${snapshot.summary}，冻结 ${snapshot.total} 家企业；逐企调用，名单不直接写入业务字段`};
  state.tasks.unshift(task);let maxCursor=originalCursor;
  for(const [index,target] of snapshot.targets.entries()){
    const baseline=job.mode==='full'||!baselineKeys.has(target.key)||!targetCursors[target.key]||(previousKeys&&!previousKeys.has(target.key)),targetCursor=targetCursors[target.key]||null,updatedAfter=job.mode==='incremental'&&!baseline?targetCursor||'':'';
    const result={index:index+1,scopeRow:target.row,targetKey:target.key,creditCode:target.creditCode,enterpriseName:target.enterpriseName,keyword:target.creditCode||target.enterpriseName,baseline,updatedAfter,collectionMode:baseline?'full':'incremental',status:'pending',received:0,processed:0,failed:0,message:''};task.targetResults.push(result);
    try{
      if(typeof loadInput!=='function')throw new Error('API 请求执行器未配置');
      isolated.lastCursor=updatedAfter||null;
      const context={target,keyword:result.keyword,creditCode:target.creditCode,enterpriseName:target.enterpriseName,updatedAfter,baseline,index:index+1,scopeSnapshot:snapshot};
      task.requested++;
      const input=await loadInput(source,job,context);
      if(!input||!Array.isArray(input.rows))throw new Error('API 请求结果必须包含记录数组');
      if(baseline&&!input.rows.length&&!input.errors?.length)throw new Error('未查询到目标企业完整信息，尚未建立采集基线');
      if(input.preparedRunner!=null&&typeof input.preparedRunner!=='function')throw new Error('预处理脚本执行器须为函数');
      const runner=cachedRunner(input.preparedRunner??(runScript?await runScript(input.rows,state.mappings[source.id],source.id):undefined));
      const returnedCode=matchTargetRows(state,source,input.rows,target,runner);
      const {task:part}=applyBatch(state,{sourceId:source.id,rows:input.rows,mode:baseline?'full':job.mode,runScript:runner,now,windowStart:!baseline&&job.mode==='incremental'&&!input.live?targetCursor||undefined:undefined,windowEnd:!baseline&&job.mode==='incremental'&&!input.live?now:undefined});
      state.tasks=state.tasks.filter(item=>item.id!==part.id);
      if(input.errors?.length){part.errors.push(...input.errors);part.failed+=input.errors.length;}
      for(const counter of counters)task[counter]+=part[counter]||0;
      task.errors.push(...part.errors.map(error=>({...error,row:index+1,keyword:result.keyword,stage:error.stage||'transform'})));
      Object.assign(result,{creditCode:returnedCode||target.creditCode,status:part.failed?'failed':'success',received:part.received,processed:part.processed,failed:part.failed,message:part.failed?part.errors.map(error=>error.message).join('；'):part.processed?'采集成功':'本次无增量变化'});
      if(!part.failed){baselineKeys.add(target.key);if(returnedCode){baselineKeys.add(`code:${returnedCode}`);activeKeys.add(`code:${returnedCode}`);}if(isolated.lastCursor){targetCursors[target.key]=isolated.lastCursor;if(returnedCode)targetCursors[`code:${returnedCode}`]=isolated.lastCursor;if(!maxCursor||Date.parse(isolated.lastCursor)>Date.parse(maxCursor))maxCursor=isolated.lastCursor;}}
    }catch(error){task.failed++;task.errors.push({row:index+1,keyword:result.keyword,stage:'fetch',message:error.message||String(error)});Object.assign(result,{status:'failed',failed:1,message:error.message||String(error)});}
  }
  job.scopeBaselines=[...baselineKeys];
  job.scopeTargetCursors=targetCursors;job.lastScopeTargetKeys=[...activeKeys];
  task.status=task.failed?(task.processed?'partial':'failed'):'success';
  task.successTargets=task.targetResults.filter(result=>result.status==='success').length;task.failedTargets=task.targetResults.filter(result=>result.status==='failed').length;
  task.message=`${job.name}：范围 ${snapshot.total} 家，请求 ${task.requested} 次，接收 ${task.received} 条，新增 ${task.added}，变化 ${task.updated}，未变 ${task.unchanged}，失败 ${task.failed}`;
  if(!snapshot.total)task.message=`${job.name}：当前范围未命中企业，未发起 API 请求`;
  return {task,cursor:task.failed?null:maxCursor};
}

function failedTask(state,job,source,now,error){
  const task={id:`task_${state.sequence++}`,jobId:job.id,jobName:job.name,sourceId:source.id,sourceName:source.name,mode:job.mode,status:'failed',startedAt:now,completedAt:now,received:0,processed:0,added:0,updated:0,unchanged:0,failed:1,duplicates:0,skipped:0,ignoredStale:0,ignoredUnknownTime:0,newEnterprises:0,changedEnterprises:0,errors:[{row:0,stage:'prepare',message:error.message||String(error)}],windowStart:job.mode==='incremental'?job.lastCursor||null:null,windowEnd:now,scope:'更新任务执行失败，保留原检查点，可修复后重试',message:error.message||String(error)};
  state.tasks.unshift(task);return task;
}

/** One serialized task run. Each job owns its cursor, even when sources are shared. */
export async function executeUpdateJob(state,jobId,{loadInput,runScript,now=new Date().toISOString()}={}){
  const job=state.updateJobs.find(item=>item.id===jobId);
  if(!job)throw new Error('更新任务不存在');
  if(!job.enabled)throw new Error('任务已暂停，请先启用');
  const source=state.providers.find(item=>item.id===job.sourceId&&['api','ftp'].includes(item.type));
  if(!source)throw new Error('任务信源不存在或不支持计划更新');
  if(!Number.isFinite(Date.parse(now)))throw new Error('任务执行时间无效');
  const previous=state.schedules[source.id];
  const isolated={...previous,lastCursor:job.mode==='incremental'?job.lastCursor||null:null,lastRunAt:job.lastRunAt||null};
  state.schedules[source.id]=isolated;
  let task,cursor=null,files=[];
  try{
    if(!source.enabled)throw new Error('信源已停用，请先启用信源');
    if(source.type==='api'){
      ({task,cursor}=await executeEnterpriseScope(state,job,source,{loadInput,runScript,now,isolated}));
    }else{
    let input;
    if(source.type==='ftp'){
      const validation=validateFtpMappings(state,source.id);if(!validation.valid)throw new Error(validation.errors.join('；'));
      files=getFtpFiles(state,source.id).filter(file=>Date.parse(file.modifiedAt)<=Date.parse(now)&&(job.mode==='full'||!job.lastCursor||Date.parse(file.modifiedAt)>Date.parse(job.lastCursor))).sort((a,b)=>Date.parse(a.modifiedAt)-Date.parse(b.modifiedAt));
      input={rows:files.flatMap(file=>file.rows),errors:[],live:false};
    }
    const runner=runScript?await runScript(input.rows,state.mappings[source.id],source.id):undefined;
    ({task}=applyBatch(state,{sourceId:source.id,rows:input.rows,mode:job.mode,runScript:runner,now,windowStart:job.mode==='incremental'&&!input.live?job.lastCursor||undefined:undefined,windowEnd:job.mode==='incremental'&&!input.live?now:undefined}));
    if(input.live){
      task.requested=input.requested;
      task.errors=task.errors.map(error=>({...error,row:input.rows[error.row-1]?._requestRow??error.row,keyword:input.rows[error.row-1]?._requestKeyword||'',stage:'transform'}));
    }
    if(input.errors?.length){task.errors.push(...input.errors);task.failed+=input.errors.length;task.status=task.processed?'partial':'failed';}
    if(task.failed===0)cursor=isolated.lastCursor;
    task.jobId=job.id;task.jobName=job.name;
    task.message=`${job.name}：接收 ${task.received} 条，新增 ${task.added}，变化 ${task.updated}，未变 ${task.unchanged}，跳过 ${task.skipped}，失败 ${task.failed}`;
    if(source.type==='ftp'){
      task.fileNames=files.map(file=>file.name);
      task.scope=`FTP 演示目录按文件修改时间读取 ${files.length} 个文件；${job.mode==='full'?'全量合并匹配文件，缺失行不删除':'增量使用本任务独立检查点，不与其他任务共享进度'}；未建立真实连接。`;
      if(files.length){
        state.ftpImports??=[];
        state.ftpImports.unshift({id:`ftp_import_${state.sequence++}`,sourceId:source.id,jobId:job.id,fileId:'job-batch',fileKey:`job:${job.id}:${task.id}`,fileName:files.map(file=>file.name).join('、'),path:source.ftpConfig.directory,bytes:files.reduce((sum,file)=>sum+file.bytes,0),mode:job.mode,status:task.status,taskId:task.id,importedAt:now,received:task.received,processed:task.processed,failed:task.failed,skipped:task.skipped,message:task.message});
        state.ftpImports=state.ftpImports.slice(0,200);
        if(!task.failed){state.ftpFileReceipts??=[];for(const file of files)if(!state.ftpFileReceipts.some(entry=>entry.sourceId===source.id&&entry.fileKey===file.key))state.ftpFileReceipts.push({sourceId:source.id,fileKey:file.key,importedAt:now});}
      }
    }
    }
  }catch(error){task=failedTask(state,job,source,now,error);}
  finally{if(previous)state.schedules[source.id]=previous;else delete state.schedules[source.id];}
  finishUpdateJob(state,job.id,{task,now,cursor});
  return {task,job};
}
