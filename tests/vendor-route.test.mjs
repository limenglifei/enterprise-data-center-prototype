import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';

// Import the exact Worker route under Node with an empty binding shim; all network calls are mocked.
const routeSource = (await readFile(new URL('../app/api/vendor/route.ts', import.meta.url), 'utf8'))
  .replace('import { env } from "cloudflare:workers";', 'const env = {};');
const route = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(routeSource)).toString('base64'));
const originalFetch = globalThis.fetch;
const secretNames = ['QCC_APP_KEY', 'QCC_SECRET_KEY', 'TYC_TOKEN'];
const originalSecrets = Object.fromEntries(secretNames.map(key => [key, process.env[key]]));
const endpoint = { qcc: 'https://api.qichacha.com/ECIV4/GetBasicDetailsByName', tyc: 'https://open.api.tianyancha.com/services/v4/open/baseinfoV3' };
const request = body => new Request('https://prototype.example/api/vendor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const payload = (extra = {}) => ({ providerId: 'qcc', keyword: 'DEMO-CN-000001', ...extra });
const setSecrets = () => { process.env.QCC_APP_KEY = 'test-server-app-key'; process.env.QCC_SECRET_KEY = 'test-server-secret'; process.env.TYC_TOKEN = 'test-server-tyc-token'; };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of secretNames) if (originalSecrets[key] === undefined) delete process.env[key]; else process.env[key] = originalSecrets[key];
});

test('missing credentials return 412 and never call the vendor', async () => {
  for (const key of secretNames) delete process.env[key];
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
  for (const providerId of ['qcc', 'tyc']) {
    const response = await route.POST(request(payload({ providerId, config: { baseUrl: endpoint[providerId], method: 'GET' }, parameters: { query: { page: 1 }, headers: {}, body: {} } })));
    assert.equal(response.status, 412); assert.equal((await response.json()).error, 'CREDENTIALS_NOT_CONFIGURED');
  }
  assert.equal(calls, 0);
});

test('QXB and custom sources explicitly require a server adapter instead of opening a proxy', async () => {
  setSecrets(); let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
  for (const providerId of ['qxb', 'custom', 'internal_erp']) {
    const response = await route.POST(request(payload({ providerId, config: { baseUrl: 'https://example.com/' } })));
    assert.equal(response.status, 501); assert.match((await response.json()).message, /服务端适配器/);
  }
  assert.equal(calls, 0);
});

test('unimplemented endpoint, method and invalid response paths are rejected before any network call', async () => {
  setSecrets(); let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
  for (const config of [
    { baseUrl: 'https://example.com/' }, { baseUrl: endpoint.qcc + '?override=1' }, { baseUrl: endpoint.qcc.replace('https:', 'http:') },
    { baseUrl: endpoint.qcc + '/other' }, { method: 'POST' }, { method: 'DELETE' },
    { responsePath: 'Result[0]' }, { responsePath: '__proto__.items' }, { responsePath: 1 },
  ]) {
    const response = await route.POST(request(payload({ config })));
    assert.equal(response.status, 400, JSON.stringify(config)); assert.equal((await response.json()).error, 'INVALID_REQUEST_CONFIG');
  }
  assert.equal(calls, 0);
});

test('reserved authentication and transport names cannot override server-generated fields', async () => {
  setSecrets(); let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
  for (const [location, name] of [['query', 'key'], ['query', 'Token'], ['query', 'api_key'], ['headers', 'AUTHORIZATION'], ['headers', 'Host'], ['headers', 'Timespan'], ['headers', 'X-Api-Key'], ['headers', 'Content-Length'], ['headers', 'Cookie']]) {
    const response = await route.POST(request(payload({ parameters: { [location]: { [name]: 'page-supplied-value' } } })));
    assert.equal(response.status, 400, location + '.' + name); assert.match((await response.json()).message, /服务端保留/);
  }
  assert.equal(calls, 0);
});

test('parameters require scalar bounded values, unique case-insensitive headers, and an empty GET body', async () => {
  setSecrets(); let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
  for (const parameters of [
    { query: { page: {} } }, { query: { page: [] } }, { query: { extra: 'a'.repeat(2049) } }, { query: { extra: 'bad\r\nheader' } },
    { body: { page: 1 } }, { headers: { 'X-Field': 'one', 'x-field': 'two' } }, { headers: { 'Invalid Field': 'one' } },
    { query: { keyword: '' } }, { query: { keyword: 1 } }, { extra: { page: 1 } },
  ]) {
    const response = await route.POST(request(payload({ parameters })));
    assert.equal(response.status, 400, JSON.stringify(parameters));
  }
  assert.equal(calls, 0);
});

test('QCC transmits configured safe parameters and returns full vendor JSON; auth stays server-generated', async () => {
  setSecrets(); let called = false;
  const vendorResponse = { Status: '200', Message: 'OK', Result: { Name: '演示企业有限公司', CreditCode: 'DEMO-CN-000001' }, extra: { marker: 'complete-response' } };
  globalThis.fetch = async (url, options) => {
    called = true; const target = new URL(url); assert.equal(target.origin + target.pathname, endpoint.qcc);
    assert.equal(target.searchParams.get('keyword'), '演示企业有限公司'); assert.equal(target.searchParams.get('page'), '2');
    assert.equal(target.searchParams.get('flag'), 'false'); assert.equal(target.searchParams.get('key'), process.env.QCC_APP_KEY);
    assert.equal(options.headers.get('X-Trace-Label'), 'prototype-test');
    const span = options.headers.get('Timespan'); assert.match(span, /^\d+$/);
    assert.equal(options.headers.get('Token'), createHash('md5').update(process.env.QCC_APP_KEY + span + process.env.QCC_SECRET_KEY).digest('hex').toUpperCase());
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'GET');
    return Response.json(vendorResponse);
  };
  const response = await route.POST(request(payload({ config: { baseUrl: endpoint.qcc, method: 'GET', responsePath: 'Result' }, parameters: { query: { keyword: '演示企业有限公司', page: 2, flag: false }, headers: { 'X-Trace-Label': 'prototype-test' }, body: {} } })));
  assert.equal(response.status, 200); assert.equal(called, true);
  const result = await response.json(); assert.deepEqual(result.vendorResponse, vendorResponse); assert.deepEqual(result.record, vendorResponse.Result);
  assert.equal(result.providerId, 'qcc'); assert.ok(Number.isFinite(Date.parse(result.collectedAt)));
  assert.equal(JSON.stringify(result).includes(process.env.QCC_SECRET_KEY), false);
});

test('TYC retains server Authorization while passing configured query and non-auth headers', async () => {
  setSecrets();
  const vendorResponse = { error_code: 0, reason: 'ok', result: { name: '演示天眼数据有限公司', creditCode: 'DEMO-CN-000002' } };
  globalThis.fetch = async (url, options) => {
    const target = new URL(url); assert.equal(target.origin + target.pathname, endpoint.tyc);
    assert.equal(target.searchParams.get('keyword'), 'DEMO-CN-000001'); assert.equal(target.searchParams.get('pageSize'), '20');
    assert.equal(options.headers.get('Authorization'), process.env.TYC_TOKEN); assert.equal(options.headers.get('X-Trace'), 'tyc-test');
    return Response.json(vendorResponse);
  };
  const response = await route.POST(request(payload({ providerId: 'tyc', config: { baseUrl: endpoint.tyc, method: 'GET', responsePath: '$.result' }, parameters: { query: { pageSize: 20 }, headers: { 'X-Trace': 'tyc-test' } } })));
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).vendorResponse, vendorResponse);
});

test('configured response root never bypasses official business success checks', async () => {
  setSecrets();
  globalThis.fetch = async () => Response.json({ Status: '201', Message: '查询无结果', other: [{ Name: '演示' }] });
  let response = await route.POST(request(payload({ config: { responsePath: 'other' } })));
  assert.equal(response.status, 404); assert.equal((await response.json()).error, 'VENDOR_NOT_FOUND');
  globalThis.fetch = async () => Response.json({ Status: '500', Message: '余额不足', other: [{ Name: '演示' }] });
  response = await route.POST(request(payload({ config: { responsePath: 'other' } })));
  assert.equal(response.status, 502); assert.equal((await response.json()).error, 'VENDOR_BUSINESS_ERROR');
});

test('legacy requests remain compatible without page-provided config or parameters', async () => {
  setSecrets();
  globalThis.fetch = async () => Response.json({ Status: '200', Result: { Name: '演示旧调用有限公司' } });
  const response = await route.POST(request(payload()));
  assert.equal(response.status, 200); assert.equal((await response.json()).record.Name, '演示旧调用有限公司');
});
