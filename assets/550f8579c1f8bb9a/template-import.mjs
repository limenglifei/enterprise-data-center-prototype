import { applyBatch } from './core.mjs';

// The downloaded file is the contract. File imports never consult editable API mappings.
export const TEMPLATE_HEADERS = Object.freeze([
  '企业全称', '统一社会信用代码', '企业资质', '企业规模', '产业链节点', '数据更新时间',
]);

const TEMPLATE_KEYS = new Set(TEMPLATE_HEADERS);
const FIXED_FIELDS = [
  ['企业全称', 'enterpriseName'],
  ['统一社会信用代码', 'creditCode'],
  ['企业资质', 'qualifications'],
  ['企业规模', 'scale'],
  ['产业链节点', 'chainNodes'],
];
const isBlank = value => value == null || String(value).trim() === '';
const splitValues = value => [...new Set((Array.isArray(value) ? value : String(value ?? '').split(/[；;，,]/))
  .map(item => String(item).trim()).filter(Boolean))];
const clone = value => JSON.parse(JSON.stringify(value));

/** Validate the six-column template before creating a task or changing any data. */
export function validateTemplateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { valid: false, errors: ['模板没有企业数据行，请按照下载模板填写后上传'] };
  }
  const errors = [];
  rows.forEach((row, index) => {
    const label = `第 ${index + 1} 行`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${label}必须为模板记录对象`);
      return;
    }
    const missing = TEMPLATE_HEADERS.filter(header => !Object.hasOwn(row, header));
    const unknown = Object.keys(row).filter(header => !TEMPLATE_KEYS.has(header));
    if (missing.length) errors.push(`${label}缺少模板列：${missing.join('、')}`);
    if (unknown.length) errors.push(`${label}包含非模板列：${unknown.join('、')}，请使用下载模板`);
    if (isBlank(row['企业全称'])) errors.push(`${label}企业全称不能为空`);
    if (isBlank(row['统一社会信用代码'])) errors.push(`${label}统一社会信用代码不能为空`);
  });
  return { valid: errors.length === 0, errors };
}

/**
 * Import the fixed file contract through the shared upsert/fusion engine.
 * The adapter exists only for this call: neither user mappings nor scripts are read or changed.
 */
export function applyTemplateBatch(state, { rows, now } = {}) {
  const validation = validateTemplateRows(rows);
  if (!validation.valid) throw new Error(validation.errors.join('；'));
  const originals = new Map();
  for (const row of rows) {
    const code = String(row['统一社会信用代码']).trim().toUpperCase();
    if (!originals.has(code)) originals.set(code, new Map());
    originals.get(code).set(JSON.stringify(row['数据更新时间']), row);
  }
  const normalizedRows = rows.map(row => ({
    ...row,
    '企业资质': splitValues(row['企业资质']),
    '产业链节点': splitValues(row['产业链节点']),
  }));
  const adapter = {
    ...state,
    mappings: {
      ...(state.mappings ?? {}),
      file: FIXED_FIELDS.map(([sourceField, targetField]) => ({ sourceField, targetField, enabled: true, scriptId: '' })),
    },
  };
  const result = applyBatch(adapter, { sourceId: 'file', rows: normalizedRows, mode: 'full', now });

  // Keep source evidence exactly as it appeared in the file, while values contain fixed normalization.
  // Resolve duplicate rows the same way as core: a candidate's source timestamp wins, then the last row.
  for (const raw of adapter.rawRecords.filter(item => item.sourceId === 'file' && item.batchId === result.task.id)) {
    // The selected normalized row preserves the literal date cell, including blank or numeric cells.
    const selected = originals.get(raw.entityKey)?.get(JSON.stringify(raw.raw['数据更新时间']));
    if (selected) raw.raw = clone(selected);
  }
  // applyBatch replaces records and scalar counters, so propagate every engine-owned result.
  for (const key of ['rawRecords', 'records', 'tasks', 'dataVersion', 'sequence', 'schedules']) state[key] = adapter[key];
  return { task: result.task, records: state.records };
}
