import { FIELD_DEFS, createInitialState } from './core.mjs';
import { DEMO_COMPANIES, DEMO_METADATA, DEMO_SNAPSHOTS } from './demo-data.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
const contextKeys = new Set(['keyword', 'creditCode', 'enterpriseName', 'updatedAfter', 'page', 'pageSize']);
const locations = new Set(['query', 'header', 'body']);
const standardMappings = () => FIELD_DEFS.map(field => ({ sourceField: field.key, targetField: field.key, scriptId: '', enabled: true }));
const standardFields = () => FIELD_DEFS.map(field => ({ path: field.key, type: field.type, description: field.label, required: field.required, enabled: true }));

function pathSegments(path, label = '返回记录根路径') {
  if (typeof path !== 'string') throw new Error(`${label}须为字符串`);
  let normalized = path.trim();
  if (normalized === '' || normalized === '$') return [];
  if (normalized.startsWith('$.')) normalized = normalized.slice(2);
  const parts = normalized.split('.');
  if (parts.some(part => !part || /[\[\]{}*\s]/u.test(part) || dangerousKeys.has(part))) {
    throw new Error(`${label}须使用点路径，例如 data.items；不支持表达式、通配符或危险属性`);
  }
  return parts;
}

/** Extract the configured records container; mappings use paths relative to each record. */
export function extractResponseRows(response, path = '') {
  let value = response;
  for (const segment of pathSegments(path)) {
    if (value == null || typeof value !== 'object' || !own(value, segment)) {
      throw new Error(`返回记录根路径不存在：${path || '$'}`);
    }
    value = value[segment];
  }
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : null;
  if (!rows || rows.some(row => row == null || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('返回记录根路径须指向对象或对象数组，不能指向空值、文本或数值');
  }
  return copy(rows);
}

function providerFields(template, mappings) {
  if (template === 'qxb' || template === 'custom') return standardFields();
  return mappings.map(mapping => {
    const field = FIELD_DEFS.find(item => item.key === mapping.targetField);
    return { path: mapping.sourceField, type: mapping.targetField === 'establishedAt' && template === 'tyc' ? 'number' : field?.type || 'string', description: field?.label || mapping.sourceField, required: !!field?.required, enabled: true };
  });
}

/** Factory for a new connector. QXB/custom are deliberately neutral demo schemas. */
export function makeApiSource({ id, name, template = 'custom' } = {}) {
  template = ['qcc', 'tyc', 'qxb', 'custom'].includes(template) ? template : 'custom';
  const sourceId = String(id || template).trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(sourceId)) throw new Error('信源标识须以小写字母开头，包含字母、数字、下划线或短横线，最多64位');
  const names = { qcc: '企查查', tyc: '天眼查', qxb: '启信宝', custom: '自定义 API 信源' };
  const mappings = ['qcc', 'tyc'].includes(template) ? copy(createInitialState({ seed: false }).mappings[template]) : standardMappings();
  const config = {
    method: 'GET',
    baseUrl: template === 'qcc' ? 'https://api.qichacha.com/ECIV4/GetBasicDetailsByName' : template === 'tyc' ? 'https://open.api.tianyancha.com/services/v4/open/baseinfoV3' : '',
    authReference: template === 'qcc' ? 'QCC_APP_KEY / QCC_SECRET_KEY' : template === 'tyc' ? 'TYC_TOKEN' : '',
    responsePath: template === 'qcc' ? 'Result' : template === 'tyc' ? 'result' : 'data.items',
    requestParams: [{ name: 'keyword', location: 'query', value: '{{keyword}}', required: true, enabled: true }],
    responseFields: providerFields(template, mappings),
    demoResponse: '',
  };
  const provider = {
    id: sourceId, name: String(name || names[template]).trim(), template, type: 'api', enabled: true,
    connectionMode: 'demo', status: 'demo_ready', authType: '服务端凭证引用', sourceConfigVersion: 2,
    description: template === 'qxb' ? '启信宝接入配置示例；演示响应使用本产品标准字段，非启信宝官方响应结构，正式接入须按授权文档配置。' : template === 'custom' ? '可配置第三方厂商或内部系统；演示响应为虚构标准字段样例，真实接入须配置接口文档及授权。' : '字段结构演示模板；真实调用须配置服务端凭证，未调用真实接口。',
    ...copy(config),
  };
  const schedule = { enabled: false, mode: 'incremental', frequency: 'manual', intervalHours: 0, time: '', lastCursor: null, nextRunAt: null, description: '全量刷新中心已有企业；增量依据时间窗口刷新。' };
  return { provider, config: copy(config), mappings, schedule };
}

/** In-place, idempotent migration. Business records, scripts, and existing source ordering are retained. */
export function upgradeSourceState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('数据中心状态须为对象');
  if (!Array.isArray(state.providers)) state.providers = [];
  state.mappings ||= {};
  state.schedules ||= {};
  state.priorities ||= {};
  if (!Array.isArray(state.uploadRecords)) state.uploadRecords = [];
  for (const id of ['qcc', 'tyc']) {
    if (!state.providers.some(provider => provider.id === id)) state.providers.push(makeApiSource({ id, template: id }).provider);
  }
  if (!state.providers.some(provider => provider.id === 'file')) {
    const defaults = createInitialState({ seed: false });
    state.providers.push(copy(defaults.providers.find(provider => provider.id === 'file')));
    if (!state.mappings.file) state.mappings.file = copy(defaults.mappings.file);
    if (!state.schedules.file) state.schedules.file = copy(defaults.schedules.file);
  }
  if (!state.providers.some(provider => provider.id === 'qxb')) state.providers.push(makeApiSource({ id: 'qxb', template: 'qxb' }).provider);
  for (const provider of state.providers) {
    delete provider.managedKeywords;
    if (provider.type === 'file' || provider.type === 'ftp' || provider.id === 'file') continue;
    const template = ['qcc', 'tyc', 'qxb'].includes(provider.template || provider.id) ? provider.template || provider.id : 'custom';
    const defaults = makeApiSource({ id: provider.id, name: provider.name, template });
    for (const [key, value] of Object.entries(defaults.config)) if (provider[key] === undefined || provider[key] === null) provider[key] = copy(value);
    // Historical connector drafts left the official QCC/TYC address blank; preserve later user edits.
    if (!provider.sourceConfigVersion && !provider.baseUrl && ['qcc', 'tyc'].includes(template)) provider.baseUrl = defaults.config.baseUrl;
    provider.template ??= template;
    provider.sourceConfigVersion = 2;
    if (!state.mappings[provider.id]) state.mappings[provider.id] = copy(defaults.mappings);
    if (!state.schedules[provider.id]) state.schedules[provider.id] = copy(defaults.schedule);
  }
  const sourceIds = [...new Set(state.providers.map(provider => provider.id))];
  for (const field of FIELD_DEFS) {
    const existing = Array.isArray(state.priorities[field.key]) ? state.priorities[field.key] : [];
    const defaults = field.group === '专题补充' ? ['file', 'qcc', 'tyc'] : ['qcc', 'tyc', 'file'];
    state.priorities[field.key] = [...new Set([...existing, ...defaults, ...sourceIds])];
  }
  state.sourceConfigVersion = 2;
  return state;
}

function validateParamConfig(provider) {
  const errors = [], seen = new Set();
  if (!Array.isArray(provider.requestParams)) return ['请求参数须为数组'];
  for (const [index, param] of provider.requestParams.entries()) {
    if (param?.enabled === false) continue;
    const name = String(param?.name ?? '').trim();
    const location = param?.location || 'query';
    if (!name || dangerousKeys.has(name)) errors.push(`第${index + 1}个参数名称为空或不安全`);
    if (!locations.has(location)) errors.push(`参数 ${name || index + 1} 的位置须为 query、header 或 body`);
    const unique = `${location}:${location === 'header' ? name.toLowerCase() : name}`;
    if (seen.has(unique)) errors.push(`参数名称重复：${location}.${name}`);
    seen.add(unique);
    if (param?.required && (param.value === null || param.value === undefined || typeof param.value === 'string' && !param.value.trim())) errors.push(`必填参数 ${name || index + 1} 未配置取值`);
    if (typeof param?.value === 'string') {
      const matches = [...param.value.matchAll(/\{\{([^{}]*)\}\}/g)];
      for (const match of matches) if (!contextKeys.has(match[1].trim())) errors.push(`参数 ${name || index + 1} 使用了不支持的占位符：${match[1].trim()}`);
      const remaining = param.value.replace(/\{\{[^{}]*\}\}/g, '');
      if (remaining.includes('{{') || remaining.includes('}}')) errors.push(`参数 ${name || index + 1} 的占位符格式不正确`);
    }
  }
  return errors;
}

export function validateApiSourceConfig(provider) {
  const errors = validateParamConfig(provider);
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(provider.method || '').toUpperCase())) errors.push('请求方法须为 GET、POST、PUT、PATCH 或 DELETE');
  if (provider.baseUrl) {
    try { const url = new URL(provider.baseUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
    catch { errors.push('API 地址须为完整的 HTTP 或 HTTPS 地址'); }
  } else if (provider.connectionMode === 'live') errors.push('真实 API 模式必须配置请求地址');
  try { pathSegments(provider.responsePath); } catch (error) { errors.push(error.message); }
  if (!Array.isArray(provider.responseFields)) errors.push('返回参数须为数组');
  else {
    const fields = new Set();
    for (const [index, field] of provider.responseFields.entries()) {
      if (field?.enabled === false) continue;
      const fieldPath = typeof field?.path === 'string' ? field.path.trim() : '';
      if (!fieldPath || fieldPath === '$') errors.push(`第${index + 1}个返回参数须填写相对记录的字段路径`);
      else try { pathSegments(fieldPath, '返回字段路径'); } catch (error) { errors.push(error.message); }
      if (fields.has(fieldPath)) errors.push(`返回字段路径重复：${fieldPath}`);
      fields.add(fieldPath);
    }
  }
  if (provider.demoResponse !== '' && provider.demoResponse != null) {
    try {
      const response = typeof provider.demoResponse === 'string' ? JSON.parse(provider.demoResponse) : provider.demoResponse;
      const rows = extractResponseRows(response, provider.responsePath);
      for (const field of provider.responseFields || []) if (field.enabled !== false && field.required && rows.some(row => {
        let value = row;
        for (const segment of pathSegments(field.path, '返回字段路径')) value = value && typeof value === 'object' && own(value, segment) ? value[segment] : undefined;
        return value == null || value === '';
      })) errors.push(`演示响应缺少必填返回字段：${field.path}`);
    } catch (error) { errors.push(`演示响应不正确：${error.message}`); }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

/** Only named literal substitutions are supported; no eval, paths, expressions or secrets. */
export function resolveRequestParameters(provider, context = {}) {
  const errors = validateParamConfig(provider);
  if (errors.length) throw new Error([...new Set(errors)].join('；'));
  const result = { query: {}, headers: {}, body: {} };
  for (const param of provider.requestParams) {
    if (param.enabled === false) continue;
    const name = String(param.name).trim();
    let value = copy(param.value ?? '');
    if (typeof value === 'string') {
      const exact = value.match(/^\{\{\s*([a-zA-Z]+)\s*\}\}$/);
      if (exact) value = context[exact[1]] ?? '';
      else value = value.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, key) => String(context[key] ?? ''));
    }
    if (param.required && (value == null || value === '' || typeof value === 'string' && !value.trim())) throw new Error(`必填参数 ${name} 缺少上下文值`);
    if (value !== null && typeof value === 'object') throw new Error(`参数 ${name} 须为字符串、数值或布尔值；复杂加工请使用脚本管理`);
    const location = param.location || 'query';
    result[location === 'header' ? 'headers' : location][name] = value;
  }
  return result;
}

export function getRequestContext(state, provider, extra = {}) {
  const keyword = String(extra.keyword ?? '').trim();
  const records = Array.isArray(state.records) ? state.records : [];
  const record = keyword ? records.find(item => item.creditCode === keyword || item.enterpriseName === keyword) : records[0];
  return {
    keyword: keyword || record?.creditCode || record?.enterpriseName || '',
    creditCode: record?.creditCode || '', enterpriseName: record?.enterpriseName || '',
    updatedAfter: state.schedules?.[provider.id]?.lastCursor || '', page: 1, pageSize: 20, ...extra,
  };
}

/** An edited JSON response always wins; blank uses deterministic, entirely fictional fixtures. */
export function getDemoResponse(state, sourceId, version = 'v1') {
  const provider = state.providers?.find(item => item.id === sourceId);
  if (!provider) throw new Error(`未知信源：${sourceId}`);
  if (provider.demoResponse !== '' && provider.demoResponse != null) {
    try { return typeof provider.demoResponse === 'string' ? JSON.parse(provider.demoResponse) : copy(provider.demoResponse); }
    catch { throw new Error('演示响应 JSON 格式不正确'); }
  }
  if (!['v1', 'v2'].includes(version)) throw new Error('演示版本仅支持 v1 或 v2');
  const template = provider.template || provider.id;
  if (template === 'qcc') return { Status: '200', Message: '虚构演示数据，未调用真实 API', Result: copy(DEMO_SNAPSHOTS.qcc[version]) };
  if (template === 'tyc') return { error_code: 0, reason: '虚构演示数据，未调用真实 API', result: copy(DEMO_SNAPSHOTS.tyc[version]) };
  const rows = copy(DEMO_COMPANIES.slice(0, version === 'v2' ? 25 : 24)).map(row => ({ ...row, sourceUpdatedAt: DEMO_METADATA.baselineAt }));
  if (version === 'v2') {
    rows[0].registeredCapitalWan = 28500;
    rows[0].sourceUpdatedAt = DEMO_METADATA.changedAt;
    rows[24].sourceUpdatedAt = DEMO_METADATA.changedAt;
  }
  return { notice: '全部数据均为虚构；本产品标准字段示例，非任何厂商官方返回结构。', data: { items: rows } };
}
