import test from 'node:test';
import assert from 'node:assert/strict';
import {selectUpdateRequestKeyword} from '../public/prototype/update-request.mjs';

const target={keyword:'91340100123456789X',creditCode:'91340100123456789X',enterpriseName:'目标企业有限公司'};

test('a frozen target permits the configured code or exact enterprise name as its official request keyword',()=>{
  assert.equal(selectUpdateRequestKeyword(target,{query:{keyword:target.creditCode}}),target.creditCode);
  assert.equal(selectUpdateRequestKeyword(target,{query:{keyword:` ${target.enterpriseName} `}}),target.enterpriseName);
  assert.equal(selectUpdateRequestKeyword({...target,keyword:target.enterpriseName},{query:{keyword:target.creditCode}}),target.creditCode);
});

test('an unrelated fixed query keyword is rejected before the caller can send a vendor request',()=>{
  for(const keyword of ['另一家企业有限公司','91340100123456788X','目标企业'])assert.throws(()=>selectUpdateRequestKeyword(target,{query:{keyword}}),/目标企业不一致/);
  for(const keyword of ['',null,1,{},'   '])assert.throws(()=>selectUpdateRequestKeyword(target,{query:{keyword}}),/非空全称或统一社会信用代码/);
});

test('missing query keyword retains the legacy authoritative context keyword and does not mutate input',()=>{
  for(const parameters of [undefined,{},null,{query:{}},{query:{page:1}}])assert.equal(selectUpdateRequestKeyword(target,parameters),target.keyword);
  const parameters={query:{keyword:` ${target.enterpriseName} `,page:1}},before=JSON.stringify(parameters);
  selectUpdateRequestKeyword(target,parameters);assert.equal(JSON.stringify(parameters),before);
  assert.equal(selectUpdateRequestKeyword({keyword:'  91340100123456789X  '}),target.creditCode);
});

test('unknown name-only list targets remain exact and inherited query properties cannot redefine the target',()=>{
  const context={keyword:'尚未入库企业有限公司',creditCode:'',enterpriseName:'尚未入库企业有限公司'};
  assert.equal(selectUpdateRequestKeyword(context,{query:{keyword:context.enterpriseName}}),context.enterpriseName);
  assert.throws(()=>selectUpdateRequestKeyword(context,{query:{keyword:target.creditCode}}),/目标企业不一致/);
  assert.equal(selectUpdateRequestKeyword(target,{query:Object.create({keyword:'其他企业有限公司'})}),target.keyword);
});
