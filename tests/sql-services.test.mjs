import test from 'node:test';
import assert from 'node:assert/strict';
import {compileSqlQuery,querySqlRecords,upgradeSqlServices,saveSqlService,executeSqlService,validateSqlService,renderSqlServices} from '../public/prototype/sql-services.mjs';

const records=[
  {id:'ent_a',enterpriseName:'合肥甲企业',creditCode:'DEMO-A',industry:'制造业',regionProvince:'安徽省',registeredCapitalWan:200,qualifications:['高新技术企业','专精特新'],updatedAt:'2026-10-29T00:00:00Z',internalCredential:'never-public'},
  {id:'ent_b',enterpriseName:'南京乙企业',creditCode:'DEMO-B',industry:'制造业',regionProvince:'江苏省',registeredCapitalWan:10,qualifications:['高新技术企业']},
  {id:'ent_c',enterpriseName:'合肥丙企业',creditCode:'DEMO-C',industry:'服务业',regionProvince:'安徽省',registeredCapitalWan:0,qualifications:[]},
  {id:'ent_d',enterpriseName:"O'Reilly",creditCode:'DEMO-D',industry:null,regionProvince:'安徽省',registeredCapitalWan:null,qualifications:null},
];
const initial=()=>upgradeSqlServices({records:structuredClone(records)});
const input=(sql='SELECT enterpriseName, creditCode FROM enterprises WHERE regionProvince = :province LIMIT 100',params={province:'安徽省'})=>({name:'区域企业查询',description:'查询标准企业数据',sql,params});

test('SQL catalog upgrades idempotently and preserves persisted templates and publication',()=>{
  const state=initial();assert.equal(state.sqlServices.length,1);assert.equal(state.sqlServices[0].status,'draft');
  state.sqlServices[0].name='我的查询';state.sqlServices[0].status='published';
  const loaded=JSON.parse(JSON.stringify(state));upgradeSqlServices(loaded);upgradeSqlServices(loaded);
  assert.equal(loaded.sqlServices.length,1);assert.equal(loaded.sqlServices[0].name,'我的查询');assert.equal(loaded.sqlServices[0].status,'published');
  assert.equal(querySqlRecords(records,loaded.sqlServices[0].sql,loaded.sqlServices[0].params).total,2);
});

test('SQL allowlist exposes only selected public fields and preserves source data',()=>{
  const before=JSON.stringify(records),result=querySqlRecords(records,'select ENTERPRISENAME, creditcode from ENTERPRISES order by registeredCapitalWan asc limit 2');
  assert.deepEqual(result.columns,['enterpriseName','creditCode']);assert.equal(result.total,4);assert.equal(result.count,2);assert.equal(result.truncated,true);
  assert.deepEqual(result.rows.map(row=>row.creditCode),['DEMO-C','DEMO-B']);assert.equal(JSON.stringify(records),before);
  const all=querySqlRecords(records,'SELECT * FROM enterprises LIMIT 1').rows[0];
  assert.equal(all.enterpriseId,'ent_a');assert.equal(all.dataUpdatedAt,'2026-10-29T00:00:00Z');assert.equal('internalCredential' in all,false);assert.equal('id' in all,false);
  all.qualifications.push('caller mutation');assert.equal(records[0].qualifications.length,2);
});

test('SQL equality, AND, IN arrays, LIKE wildcards and escaped quotes query correctly',()=>{
  const sql='SELECT creditCode FROM enterprises WHERE regionProvince = :province AND qualifications IN (:honors) ORDER BY creditCode DESC LIMIT 500';
  assert.deepEqual(querySqlRecords(records,sql,{province:'安徽省',honors:['专精特新','不存在']}).rows,[{creditCode:'DEMO-A'}]);
  assert.equal(querySqlRecords(records,"SELECT creditCode FROM enterprises WHERE enterpriseName LIKE '合肥_企业'").total,2);
  assert.equal(querySqlRecords(records,"SELECT creditCode FROM enterprises WHERE enterpriseName LIKE '%乙%'").rows[0].creditCode,'DEMO-B');
  assert.equal(querySqlRecords(records,"SELECT creditCode FROM enterprises WHERE enterpriseName = 'O''Reilly'").rows[0].creditCode,'DEMO-D');
  assert.equal(querySqlRecords(records,'SELECT creditCode FROM enterprises WHERE registeredCapitalWan = 0').rows[0].creditCode,'DEMO-C');
  assert.equal(querySqlRecords(records,'SELECT creditCode FROM enterprises WHERE industry = :industry',{industry:null}).total,0);
  assert.equal(querySqlRecords(records,"SELECT creditCode FROM enterprises WHERE creditCode IN ('DEMO-B', 'DEMO-C')").total,2);
  assert.equal(querySqlRecords([{enterpriseName:'%企业'}],"SELECT enterpriseName FROM enterprises WHERE enterpriseName LIKE '%'").total,1);
  assert.equal(querySqlRecords([{enterpriseName:'甲%企业'}],"SELECT enterpriseName FROM enterprises WHERE enterpriseName LIKE '%企业'").total,1);
});

test('bound parameters stay values even if they contain SQL syntax',()=>{
  for(const value of ["安徽省' OR 1=1 --",'安徽省; DROP TABLE enterprises',"' UNION SELECT * FROM secrets",'安徽省/*comment*/']){
    assert.equal(querySqlRecords(records,'SELECT creditCode FROM enterprises WHERE regionProvince = :province',{province:value}).total,0);
  }
  const state=initial(),sql="SELECT creditCode FROM enterprises WHERE enterpriseName = :name";
  const service=saveSqlService(state,input(sql,{name:"O'Reilly"}));service.status='published';
  assert.equal(executeSqlService(state,service.id,sql,{name:"O'Reilly"}).result.rows[0].creditCode,'DEMO-D');
});

test('read-only parser rejects write, joins, unbounded grammar and internal fields',()=>{
  for(const sql of [
    'DELETE FROM enterprises','UPDATE enterprises SET industry = 1','INSERT INTO enterprises VALUES (1)',
    'SELECT * FROM enterprises; SELECT * FROM enterprises','SELECT * FROM enterprises -- comment','SELECT * FROM enterprises /* comment */',
    'SELECT * FROM secrets','SELECT internalCredential FROM enterprises','SELECT constructor FROM enterprises','SELECT * FROM enterprises JOIN secrets ON 1=1',
    'SELECT COUNT(*) FROM enterprises','SELECT * FROM enterprises UNION SELECT * FROM secrets',"SELECT * FROM enterprises WHERE industry = 'a' OR industry = 'b'",
    'SELECT * FROM enterprises LIMIT 0','SELECT * FROM enterprises LIMIT 501','SELECT * FROM enterprises LIMIT 1.5',"SELECT * FROM enterprises LIMIT '10'",
    'SELECT enterpriseName, enterpriseName FROM enterprises','SELECT * FROM enterprises ORDER BY internalCredential',"SELECT * FROM enterprises WHERE industry = 'unterminated",
    'SELECT * FROM enterprises WHERE industry IN ()','SELECT * FROM enterprises WHERE industry = :__proto__',
  ])assert.throws(()=>compileSqlQuery(sql),undefined,sql);
});

test('parameter validation rejects missing/unused keys, nested values, invalid arrays and ambiguous scalar comparisons',()=>{
  const sql='SELECT creditCode FROM enterprises WHERE regionProvince = :province';
  for(const params of [null,[],{}, {province:'安徽省',unused:1},{province:{nested:'value'}},{province:['安徽省']},{province:'a'.repeat(501)},{province:Infinity}])assert.throws(()=>querySqlRecords(records,sql,params));
  for(const values of [[],Array(51).fill('x'),[{x:1}],[undefined]])assert.throws(()=>querySqlRecords(records,'SELECT creditCode FROM enterprises WHERE industry IN (:values)',{values}));
  assert.throws(()=>querySqlRecords(records,'SELECT creditCode FROM enterprises WHERE industry LIKE :pattern',{pattern:123}));
  assert.throws(()=>querySqlRecords(records,'SELECT creditCode FROM enterprises WHERE industry LIKE :pattern',{pattern:'%'.repeat(201)}));
  assert.throws(()=>querySqlRecords(records,'SELECT creditCode FROM enterprises WHERE industry IN (:a, :b)',{a:Array(30).fill('a'),b:Array(30).fill('b')}));
});

test('SQL limits protect configuration and execution before persistence',()=>{
  assert.throws(()=>compileSqlQuery(' '.repeat(5001)));assert.throws(()=>compileSqlQuery('SELECT * FROM enterprises WHERE '+Array(21).fill("industry = 'x'").join(' AND ')));
  const state=initial(),count=state.sqlServices.length;
  for(const candidate of [{...input(),name:''},{...input(),name:'a'.repeat(61)},{...input(),description:'a'.repeat(501)},input('DELETE FROM enterprises',{})]){
    assert.throws(()=>saveSqlService(state,candidate));assert.equal(state.sqlServices.length,count);
  }
  const service=saveSqlService(state,input());service.status='published';service.publishedAt='2026-10-28T00:00:00Z';
  const changed=saveSqlService(state,{...input(),name:'已编辑查询'},service.id);
  assert.equal(changed.status,'draft');assert.equal(changed.revision,2);assert.equal(state.sqlServices.length,count+1);assert.equal(validateSqlService(changed),changed);
  assert.throws(()=>saveSqlService(state,input(),'missing'));
});

test('published query execution records success, empty results and errors; disabled service cannot execute',()=>{
  const state=initial(),service=saveSqlService(state,input());
  assert.equal(executeSqlService(state,service.id,service.sql,service.params).success,false);
  service.status='published';const success=executeSqlService(state,service.id,service.sql,service.params);assert.equal(success.success,true);assert.equal(success.result.total,3);
  const empty=executeSqlService(state,service.id,service.sql,{province:'不存在'});assert.equal(empty.success,true);assert.equal(empty.result.total,0);
  const bad=executeSqlService(state,service.id,'DELETE FROM enterprises',{});assert.equal(bad.success,false);assert.equal(bad.log.count,0);
  service.status='disabled';assert.equal(executeSqlService(state,service.id,service.sql,service.params).success,false);
  assert.equal(state.sqlRuns.length,5);assert.equal(state.sqlRuns[1].mode,'browser_preview');assert.equal('rows' in state.sqlRuns[1],false);
  const loaded=JSON.parse(JSON.stringify(state));upgradeSqlServices(loaded);assert.equal(loaded.sqlRuns[1].params.province,'安徽省');
});

test('execution history remains bounded globally and newest records survive reload',()=>{
  const state=initial(),service=state.sqlServices[0];service.status='published';
  for(let i=0;i<65;i++)executeSqlService(state,service.id,service.sql,service.params,{now:`2026-10-29T00:00:${String(i%60).padStart(2,'0')}Z`});
  assert.equal(state.sqlRuns.length,50);assert.equal(upgradeSqlServices(JSON.parse(JSON.stringify(state))).sqlRuns.length,50);
  assert.match(renderSqlServices(state),/动态 SQL 查询/);assert.match(renderSqlServices(state),/字段字典与语法/);assert.match(renderSqlServices(state),/真实下游连接/);
});
