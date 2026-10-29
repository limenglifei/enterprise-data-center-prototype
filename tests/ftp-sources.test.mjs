import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,recomputeRecords} from '../public/prototype/core.mjs';
import {upgradeFtpSources,createFtpSource,validateFtpConfig,getFtpFiles,importFtpFile,validateFtpMappings,renderFtpSources,selectFtpSource} from '../public/prototype/ftp-sources.mjs';

const workspace=()=>upgradeFtpSources(createInitialState({seed:false}));
const source=state=>state.providers.find(p=>p.type==='ftp');
const run=(state,file,options={})=>importFtpFile(state,source(state).id,file,{now:'2026-10-29T00:00:00Z',...options});

test('FTP migration is idempotent and retains all prior API records and configuration',()=>{
  const state=createInitialState(),before=JSON.stringify(state.records),qcc=JSON.stringify(state.providers[0]);upgradeFtpSources(state);
  assert.equal(JSON.stringify(state.records),before);assert.equal(JSON.stringify(state.providers[0]),qcc);
  assert.equal(state.providers.filter(p=>p.type==='ftp').length,1);assert.ok(Object.values(state.priorities).every(ids=>ids.at(-1)==='ftp_demo'));
  const migrated=JSON.stringify(state);upgradeFtpSources(state);assert.equal(JSON.stringify(state),migrated);
});

test('new FTP source validates duplicate IDs, name, paths and transfer settings before mutation',()=>{
  const state=workspace(),before=JSON.stringify(state);
  for(const input of [{id:'ftp_demo',name:'重复'},{id:'FTP',name:'非法标识'},{id:'bad_ftp',name:'坏配置',host:'ftp://user:pass@example.com'},{id:'bad_ftp',name:'坏目录',directory:'/enterprise/../private'},{id:'bad_ftp',name:'坏端口',port:70000}])assert.throws(()=>createFtpSource(state,input));
  assert.equal(JSON.stringify(state),before);
  const p=createFtpSource(state,{id:'vendor_ftp',name:'第三方 FTP',protocol:'ftp'});assert.equal(p.type,'ftp');assert.equal(p.ftpConfig.protocol,'ftp');assert.equal(validateFtpMappings(state,p.id).valid,true);
});

test('CSV and JSON directory views honor saved file rules and contain only synthetic records',()=>{
  const state=workspace(),p=source(state);let files=getFtpFiles(state,p.id);
  assert.equal(files.length,2);assert.equal(files[0].rows.length,24);assert.equal(files[1].rows.length,4);assert.ok(files.flatMap(f=>f.rows).every(row=>row.credit_code.startsWith('DEMO-')&&row._synthetic));
  assert.deepEqual(JSON.parse(files[0].text),files[0].rows);
  p.ftpConfig.format='csv';p.ftpConfig.filePattern='enterprise_full_*.csv';files=getFtpFiles(state,p.id);
  assert.equal(files.length,1);assert.match(files[0].text,/"company_name","credit_code"/);assert.ok(files[0].bytes>0);
  p.ftpConfig.filePattern='other_*.csv';assert.deepEqual(getFtpFiles(state,p.id),[]);
});

test('full FTP import feeds shared storage, provenance, source order and task tracking',()=>{
  const state=workspace(),p=source(state),{task}=run(state,'full-v1',{mode:'full'});
  assert.equal(task.added,24);assert.equal(task.newEnterprises,24);assert.equal(task.failed,0);assert.equal(state.records.length,24);assert.equal(state.ftpImports.length,1);
  assert.equal(state.records[0].lineage.enterpriseName.selected.sourceId,p.id);assert.equal(state.records[0].lineage.enterpriseName.selected.rawField,'company_name');
  assert.ok(state.records[0].qualifications.includes('高新技术企业'));assert.equal(task.fileName,'enterprise_full_20261026.json');assert.equal(state.ftpImports[0].taskId,task.id);
});

test('same successful file version cannot create duplicate imports or tasks',()=>{
  const state=workspace();run(state,'full-v1',{mode:'full'});const before=JSON.stringify(state);
  assert.throws(()=>run(state,'full-v1',{mode:'full'}),/无需重复导入/);assert.equal(JSON.stringify(state),before);
});

test('incremental file updates known enterprises, adds new ones and advances checkpoint',()=>{
  const state=workspace(),p=source(state);run(state,'full-v1',{mode:'full'});const prior=state.schedules[p.id].lastCursor;
  const {task}=run(state,'delta-v2');assert.equal(task.updated,2);assert.equal(task.added,2);assert.equal(task.newEnterprises,2);assert.equal(task.changedEnterprises,2);assert.equal(state.records.length,26);
  assert.equal(task.windowStart,prior);assert.ok(Date.parse(state.schedules[p.id].lastCursor)>Date.parse(prior));assert.match(state.records[0].legalPerson,/FTP/);
});

test('late full snapshot cannot overwrite newer records or delete enterprises absent from the file',()=>{
  const state=workspace();run(state,'delta-v2',{mode:'incremental'});const {task}=run(state,'full-v1',{mode:'full'});
  assert.equal(task.ignoredStale,2);assert.equal(state.records.length,26);assert.match(state.records[0].legalPerson,/FTP/);assert.equal(task.failed,0);
});

test('incremental older files are skipped using the successful checkpoint',()=>{
  const state=workspace();run(state,'delta-v2');const {task}=run(state,'full-v1',{mode:'incremental'});
  assert.equal(task.skipped,24);assert.equal(task.processed,0);assert.equal(state.records.length,4);
});

test('script mapping validation rejects unpublished scripts and unsafe field access',()=>{
  const state=workspace(),id=source(state).id;state.mappings[id][0].sourceField='__proto__.constructor';assert.equal(validateFtpMappings(state,id).valid,false);
  state.mappings[id][0].sourceField='company_name';state.scripts.find(s=>s.id==='split_values').status='draft';assert.equal(validateFtpMappings(state,id).valid,false);
  assert.throws(()=>run(state,'full-v1'),/脚本未发布/);assert.equal(state.tasks.length,0);
});

test('failed mapping rows retain cursor and permit retry after script repair',()=>{
  const state=workspace(),id=source(state).id;state.mappings[id][0].sourceField='missing_name';
  const first=run(state,'full-v1');assert.equal(first.task.failed,24);assert.equal(state.schedules[id].lastCursor,null);assert.equal(state.ftpImports[0].status,'failed');
  state.mappings[id][0].sourceField='company_name';assert.equal(run(state,'full-v1').task.added,24);assert.equal(state.ftpImports.length,2);
});

test('FTP shares the existing source conflict resolution and takes effect when source order changes',()=>{
  const state=upgradeFtpSources(createInitialState());run(state,'delta-v2');const id=source(state).id,record=state.records.find(r=>r.creditCode==='DEMO-CN-000001');
  assert.equal(record.lineage.legalPerson.selected.sourceId,'qcc');state.priorities.legalPerson=[id,...state.priorities.legalPerson.filter(s=>s!==id)];recomputeRecords(state);
  assert.equal(state.records.find(r=>r.creditCode==='DEMO-CN-000001').lineage.legalPerson.selected.sourceId,id);
});

test('FTP page escapes untrusted names and clearly states simulation and server scheduling boundaries',()=>{
  const state=workspace(),p=source(state);p.name='<img src=x onerror=alert(1)>';selectFtpSource(p.id);const html=renderFtpSources(state);
  assert.ok(!html.includes('<img src=x'));assert.match(html,/&lt;img/);assert.match(html,/浏览器不建立真实 FTP 连接/);assert.match(html,/定时执行需服务端支持/);assert.ok(!html.includes('name="password"'));
});

test('validation rejects unsupported protocol and file extension mismatches',()=>{
  const config=source(workspace()).ftpConfig;
  for(const change of [{protocol:'sftp'},{format:'exe'},{filePattern:'*.csv'},{username:''},{directory:'relative'},{frequency:'secondly'}])assert.equal(validateFtpConfig({...config,...change}).valid,false);
});

test('custom script preprocessing retains the exact prepared row object throughout import',()=>{
  const state=workspace(),id=source(state).id,rows=getFtpFiles(state,id)[0].rows;
  state.scripts.push({id:'custom_name',name:'自定义名称',status:'published',version:1,code:'return value + "（FTP）";'});state.mappings[id][0].scriptId='custom_name';
  const precomputed=new Map(rows.map((row,i)=>[i,row.company_name+'（FTP）']));
  importFtpFile(state,id,'full-v1',{now:'2026-10-29T00:00:00Z',preparedRows:rows,runScript:(script,value,ctx)=>{
    const i=rows.indexOf(ctx.row);assert.ok(i>=0,'script context must use the preprocessed array');
    if(script.id==='custom_name')return precomputed.get(i);return [...new Set(String(value??'').split('；').filter(Boolean))];
  }});
  assert.match(state.records[0].enterpriseName,/（FTP）$/);assert.equal(state.records[0].lineage.enterpriseName.selected.script.id,'custom_name');
});

test('successful file deduplication outlives visible history retention',()=>{
  const state=workspace();run(state,'full-v1');state.ftpImports=[];assert.throws(()=>run(state,'full-v1'),/无需重复导入/);
});

test('future-dated files remain retryable and unknown fields cannot persist passwords',()=>{
  const state=workspace(),before=JSON.stringify(state);assert.throws(()=>run(state,'delta-v2',{now:'2026-10-26T00:00:00Z'}),/稍后重试/);assert.equal(JSON.stringify(state),before);
  const p=createFtpSource(state,{id:'safe_ftp',name:'安全配置',password:'must-not-persist',token:'must-not-persist'});assert.ok(!JSON.stringify(p).includes('must-not-persist'));
});
