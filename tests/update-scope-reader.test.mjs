import test from 'node:test';
import assert from 'node:assert/strict';
import {readTableFile} from '../public/prototype/file-reader.mjs';
import {createInitialState} from '../public/prototype/core.mjs';
import {parseScopeRows} from '../public/prototype/update-scope.mjs';
const csv=text=>({name:'更新名单.csv',size:new TextEncoder().encode(text).length,text:async()=>text});

test('scope reader preserves blank records and physical source row numbers without adding business headers',async()=>{
  const rows=await readTableFile(csv('信用代码,企业全称\r\n91340100123456789X,有效公司\r\n,\r\nbad,无效公司\r\n'),{preserveBlankRows:true,includeRowNumbers:true});
  assert.equal(rows.length,3);assert.deepEqual(rows.map(row=>row.__sourceRowNumber),[2,3,4]);assert.deepEqual(Object.keys(rows[0]),['信用代码','企业全称']);
  const preview=parseScopeRows(createInitialState(),rows).preview;assert.equal(preview.blankRows,1);assert.equal(preview.errors[0].row,4);assert.equal(preview.targets.length,1);
});

test('default reader keeps the original business-upload shape while quoted lines retain original source positions',async()=>{
  const file=csv('信用代码,企业全称\n91340100123456789X,"第一行\n第二行"\n\nbad,错误公司\n');
  const original=await readTableFile(file);assert.equal(original.length,2);assert.equal(Object.hasOwn(original[0],'__sourceRowNumber'),false);
  const rows=await readTableFile(file,{preserveBlankRows:true,includeRowNumbers:true});assert.deepEqual(rows.map(row=>row.__sourceRowNumber),[2,4,5]);assert.equal(rows[0]['企业全称'],'第一行\n第二行');
  assert.equal(parseScopeRows(createInitialState(),rows).preview.errors[0].row,5);
});

test('reader rejects unheaded data columns and all-empty files before scope validation',async()=>{
  await assert.rejects(readTableFile(csv('信用代码\n91340100123456789X,100\n')),/超出表头/);
  await assert.rejects(readTableFile(csv('企业全称\n\n'),{preserveBlankRows:true}),/没有企业数据行/);
});
