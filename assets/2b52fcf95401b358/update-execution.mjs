import {applyBatch} from './core.mjs';
import {getFtpFiles,validateFtpMappings} from './ftp-sources.mjs';
import {finishUpdateJob} from './update-jobs.mjs';

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
    let input;
    if(source.type==='ftp'){
      const validation=validateFtpMappings(state,source.id);if(!validation.valid)throw new Error(validation.errors.join('；'));
      files=getFtpFiles(state,source.id).filter(file=>Date.parse(file.modifiedAt)<=Date.parse(now)&&(job.mode==='full'||!job.lastCursor||Date.parse(file.modifiedAt)>Date.parse(job.lastCursor))).sort((a,b)=>Date.parse(a.modifiedAt)-Date.parse(b.modifiedAt));
      input={rows:files.flatMap(file=>file.rows),errors:[],live:false};
    }else{
      if(typeof loadInput!=='function')throw new Error('API 请求执行器未配置');
      input=await loadInput(source,job);
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
    }else task.scope+=`；任务「${job.name}」独立检查点，${input.live?'真实接口返回记录':'演示 API 快照'}。`;
  }catch(error){task=failedTask(state,job,source,now,error);}
  finally{if(previous)state.schedules[source.id]=previous;else delete state.schedules[source.id];}
  finishUpdateJob(state,job.id,{task,now,cursor});
  return {task,job};
}
