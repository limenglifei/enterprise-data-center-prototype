import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, applyBatch } from '../public/prototype/core.mjs';
import { upgradeSourceState, makeApiSource, extractResponseRows, resolveRequestParameters, validateApiSourceConfig, getDemoResponse, getRequestContext } from '../public/prototype/source-config.mjs';

test('migration retains enterprise records, scripts, custom priorities and mappings; removes obsolete managed lists', () => {
  const state = createInitialState();
  const records = JSON.stringify(state.records), scripts = JSON.stringify(state.scripts), mappings = JSON.stringify(state.mappings.qcc);
  state.priorities.registeredCapitalWan = ['tyc', 'file', 'qcc'];
  state.providers[0].managedKeywords = ['旧企业'];
  state.providers[2].managedKeywords = ['旧文件'];
  state.providers[1].enabled = false;
  assert.equal(upgradeSourceState(state), state);
  assert.equal(state.records.length, 24); assert.equal(state.rawRecords.length, 72);
  assert.equal(JSON.stringify(state.records), records); assert.equal(JSON.stringify(state.scripts), scripts); assert.equal(JSON.stringify(state.mappings.qcc), mappings);
  assert.deepEqual(state.priorities.registeredCapitalWan, ['tyc', 'file', 'qcc', 'qxb']);
  assert.equal(state.providers.find(provider => provider.id === 'tyc').enabled, false);
  assert.ok(state.providers.every(provider => !Object.hasOwn(provider, 'managedKeywords')));
  assert.deepEqual(state.uploadRecords, []);
  const once = JSON.stringify(state); upgradeSourceState(state); assert.equal(JSON.stringify(state), once);
});

test('additional systems retain their own config and are appended once to every field priority', () => {
  const state = createInitialState();
  const created = makeApiSource({ id: 'internal_erp', name: '内部 ERP', template: 'custom' });
  created.provider.baseUrl = 'https://example.com/custom';
  state.providers.push(created.provider);
  state.mappings.internal_erp = [{ sourceField: 'code', targetField: 'creditCode', enabled: true }];
  upgradeSourceState(state); upgradeSourceState(state);
  assert.equal(state.providers.find(provider => provider.id === 'internal_erp').baseUrl, 'https://example.com/custom');
  assert.equal(state.mappings.internal_erp.length, 1);
  assert.ok(Object.values(state.priorities).every(ids => ids.includes('internal_erp') && new Set(ids).size === ids.length));
});

test('all demo wrappers match the configured response path and QXB uses explicitly neutral synthetic fields', () => {
  const state = upgradeSourceState(createInitialState());
  for (const id of ['qcc', 'tyc', 'qxb']) {
    const provider = state.providers.find(item => item.id === id);
    const v1 = extractResponseRows(getDemoResponse(state, id, 'v1'), provider.responsePath);
    const v2 = extractResponseRows(getDemoResponse(state, id, 'v2'), provider.responsePath);
    assert.equal(v1.length, 24); assert.ok(v2.length > v1.length);
    assert.equal(validateApiSourceConfig(provider).valid, true);
  }
  const provider = state.providers.find(item => item.id === 'qxb');
  assert.match(provider.description, /非启信宝官方/);
  const task = applyBatch(state, { sourceId: 'qxb', rows: extractResponseRows(getDemoResponse(state, 'qxb'), provider.responsePath), mode: 'full' }).task;
  assert.equal(task.added, 24); assert.equal(task.newEnterprises, 0); assert.equal(state.records.length, 24);
});

test('edited demo JSON is used instead of a built-in fixture and invalid JSON is explicit', () => {
  const state = upgradeSourceState(createInitialState({ seed: false }));
  const provider = state.providers.find(item => item.id === 'qxb');
  provider.demoResponse = '{"data":{"items":[{"enterpriseName":"演示自定义有限公司","creditCode":"DEMO-CUSTOM"}]}}';
  assert.equal(extractResponseRows(getDemoResponse(state, 'qxb', 'v2'), provider.responsePath)[0].creditCode, 'DEMO-CUSTOM');
  provider.demoResponse = '{'; assert.throws(() => getDemoResponse(state, 'qxb'), /JSON/);
});

test('response root supports array or singleton objects, never silently accepts wrong paths or expressions', () => {
  assert.deepEqual(extractResponseRows({ data: { item: { creditCode: 'DEMO-1' } } }, '$.data.item'), [{ creditCode: 'DEMO-1' }]);
  assert.deepEqual(extractResponseRows([{ name: '演示' }], '$'), [{ name: '演示' }]);
  assert.deepEqual(extractResponseRows({ data: [] }, 'data'), []);
  for (const path of ['data.nope', 'data..items', 'data.items[0]', '__proto__.items', 'constructor', 'data.*']) assert.throws(() => extractResponseRows({ data: { items: [] } }, path), /根路径/);
  assert.throws(() => extractResponseRows({ data: [null] }, 'data'), /对象/);
  assert.throws(() => extractResponseRows({ data: 'x' }, 'data'), /对象/);
});

test('request parameter substitution resolves each location without evaluation, preserving scalar types', () => {
  const provider = makeApiSource({ id: 'custom' }).provider;
  provider.requestParams = [
    { name: 'keyword', location: 'query', value: '{{keyword}}', required: true },
    { name: 'page', location: 'query', value: '{{page}}' },
    { name: 'X-Company', location: 'header', value: '企业 {{enterpriseName}} / {{creditCode}}' },
    { name: 'since', location: 'body', value: '{{updatedAfter}}' },
    { name: 'size', location: 'body', value: '{{pageSize}}' },
    { name: 'disabled', location: 'query', value: '{{unknown}}', enabled: false },
  ];
  const resolved = resolveRequestParameters(provider, { keyword: 'DEMO-CN-1', enterpriseName: '演示企业', creditCode: 'DEMO-CN-1', updatedAfter: '2026-10-27', page: 2, pageSize: 50 });
  assert.deepEqual(resolved, { query: { keyword: 'DEMO-CN-1', page: 2 }, headers: { 'X-Company': '企业 演示企业 / DEMO-CN-1' }, body: { since: '2026-10-27', size: 50 } });
  assert.throws(() => resolveRequestParameters(provider, {}), /必填参数 keyword/);
  provider.requestParams[0].value = '{{process.exit()}}';
  assert.throws(() => resolveRequestParameters(provider, {}), /不支持的占位符/);
});

test('parameter and return field validation catches duplicate names, missing required values and invalid root path', () => {
  const provider = makeApiSource({ id: 'custom' }).provider;
  provider.requestParams.push({ name: 'keyword', location: 'query', value: 'other' });
  assert.throws(() => resolveRequestParameters(provider, {}), /重复/);
  provider.requestParams = [{ name: 'X-Token', location: 'header', value: 'one' }, { name: 'x-token', location: 'header', value: 'two' }];
  assert.throws(() => resolveRequestParameters(provider, {}), /重复/);
  provider.requestParams = [{ name: 'must', value: '', required: true }];
  provider.responsePath = 'data.items[]';
  const validation = validateApiSourceConfig(provider);
  assert.equal(validation.valid, false); assert.match(validation.errors.join(' '), /必填参数/); assert.match(validation.errors.join(' '), /根路径/);
  provider.requestParams = [];
  provider.responsePath = 'data.items';
  provider.demoResponse = '{"data":{"items":[{"enterpriseName":"演示缺代码有限公司"}]}}';
  assert.match(validateApiSourceConfig(provider).errors.join(' '), /必填返回字段：creditCode/);
});

test('request context uses test keywords or existing center entities without a managed enterprise list', () => {
  const state = upgradeSourceState(createInitialState());
  const provider = state.providers[0];
  let context = getRequestContext(state, provider);
  assert.equal(context.keyword, state.records[0].creditCode);
  provider.testKeyword = state.records[1].enterpriseName;
  context = getRequestContext(state, provider, { page: 3 });
  assert.equal(context.creditCode, state.records[1].creditCode); assert.equal(context.page, 3);
  context = getRequestContext(state, provider, { keyword: '完全自定义关键字' });
  assert.equal(context.keyword, '完全自定义关键字'); assert.equal(context.creditCode, '');
});
