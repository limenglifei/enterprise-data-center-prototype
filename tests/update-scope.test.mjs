import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../public/prototype/core.mjs';
import {normalizeUpdateScope,previewUpdateScope,validateUpdateScope,parseScopeRows,freezeUpdateScope} from '../public/prototype/update-scope.mjs';

test('filters use OR within each dimension, AND across dimensions, and region ancestry',()=>{
  const state=createInitialState();
  const result=previewUpdateScope(state,{type:'filters',filters:{regions:['安徽省/合肥市','江苏省/苏州市'],industries:['电子信息','装备制造'],qualifications:['高新技术企业','专精特新中小企业']}});
  assert.ok(result.targets.length>1);
  for(const target of result.targets){const record=state.records.find(item=>item.id===target.enterpriseId);assert.ok((record.regionProvince==='安徽省'&&record.regionCity==='合肥市')||(record.regionProvince==='江苏省'&&record.regionCity==='苏州市'));assert.ok(['电子信息','装备制造'].includes(record.industry));assert.ok(record.qualifications.some(value=>['高新技术企业','专精特新中小企业'].includes(value)));}
  const child=previewUpdateScope(state,{type:'filters',filters:{regions:[{province:'安徽省',city:'合肥市',district:'蜀山区'}]}});assert.ok(child.targets.every(target=>state.records.find(record=>record.id===target.enterpriseId).regionDistrict==='蜀山区'));
  assert.equal(validateUpdateScope(state,{type:'filters'}).valid,false);
  assert.equal(validateUpdateScope(state,{type:'filters',filters:{regions:[{city:'合肥市'}]}}).valid,false);
});

test('identity upload normalizes, resolves aliases, deduplicates and reports invalid rows',()=>{
  const state=createInitialState(),known=state.records[0];
  const {scope,preview}=parseScopeRows(state,[{'信用代码':` ${known.creditCode.toLowerCase()} `,'企业全称':known.enterpriseName},{'信用代码':'','企业全称':known.enterpriseName},{'信用代码':'91340100123456789X','企业全称':'尚未入库企业有限公司'},{'信用代码':'','企业全称':''},{'信用代码':'bad','企业全称':'错误主体'}],{fileName:'名单.csv'});
  assert.equal(scope.fileName,'名单.csv');assert.equal(preview.targets.length,2);assert.equal(preview.duplicates,1);assert.equal(preview.blankRows,1);assert.equal(preview.errors[0].row,6);assert.equal(preview.targets[1].known,false);
  assert.equal(validateUpdateScope(state,scope).valid,false);
  assert.equal(state.records.some(record=>record.enterpriseName==='尚未入库企业有限公司'),false);
  assert.throws(()=>parseScopeRows(state,[{'企业全称':'甲公司','注册资本':100}]),/仅支持/);
});

test('ambiguous exact names and code/name conflicts are errors; unknown name-only target is requestable',()=>{
  const state=createInitialState(),known=state.records[0];
  state.records.push({...known,id:'different',creditCode:'91340100123456789X'});
  const preview=previewUpdateScope(state,{type:'list',entries:[{enterpriseName:known.enterpriseName},{creditCode:known.creditCode,enterpriseName:'另一家有限公司'},{enterpriseName:'尚未入库全称有限公司'}]});
  assert.equal(preview.errors.length,2);assert.equal(preview.targets.length,1);assert.equal(preview.targets[0].creditCode,'');assert.equal(preview.targets[0].known,false);
});

test('execution snapshot is detached and frozen; old scope defaults all; list interface rejects precise ranges',()=>{
  const state=createInitialState(),job={sourceId:'qcc',scope:{type:'filters',filters:{regions:['安徽省']}}},snapshot=freezeUpdateScope(state,job,'2026-11-02T00:00:00Z'),count=snapshot.total;
  state.records.length=0;job.scope.filters.regions[0]='江苏省';assert.equal(snapshot.total,count);assert.equal(snapshot.filters.regions[0],'安徽省');assert.throws(()=>snapshot.targets.push({}),TypeError);
  assert.equal(normalizeUpdateScope().type,'all');
  assert.equal(validateUpdateScope(state,{type:'all'},{type:'api',requestScope:'single'}).valid,false);
  assert.equal(validateUpdateScope(state,{type:'filters',filters:{industries:['电子信息']}},{type:'api',requestScope:'single'}).valid,false);
});
