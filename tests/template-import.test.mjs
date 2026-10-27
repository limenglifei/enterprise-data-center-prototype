import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, applyBatch, getLineage } from '../public/prototype/core.mjs';
import { DEMO_SNAPSHOTS } from '../public/prototype/demo-data.mjs';
import { TEMPLATE_HEADERS, validateTemplateRows, applyTemplateBatch } from '../public/prototype/template-import.mjs';

const now = '2026-10-27T10:00:00+08:00';
const row = (overrides = {}) => ({
  '企业全称': '演示模板科技有限公司',
  '统一社会信用代码': 'DEMO-TEMPLATE-001',
  '企业资质': '高新技术企业；专精特新；高新技术企业',
  '企业规模': '中型',
  '产业链节点': '显示模组；显示面板',
  '数据更新时间': '2026-10-27 09:30:00',
  ...overrides,
});

test('fixed template accepts reordered six columns and empty optional values', () => {
  assert.deepEqual(TEMPLATE_HEADERS, ['企业全称','统一社会信用代码','企业资质','企业规模','产业链节点','数据更新时间']);
  const reversed = Object.fromEntries(Object.entries(row({ '企业资质': '', '企业规模': '', '产业链节点': '', '数据更新时间': '' })).reverse());
  assert.deepEqual(validateTemplateRows([reversed]), { valid: true, errors: [] });
  const state = createInitialState({ seed: false });
  applyTemplateBatch(state, { rows: [reversed], now });
  assert.deepEqual(state.records[0].qualifications, []);
  assert.equal(state.records[0].scale, null);
  assert.equal(state.rawRecords[0].sourceTimeAssumed, true);
});

test('unknown or missing template columns and blank identities are rejected before state mutation', () => {
  const state = createInitialState({ seed: false }), before = JSON.stringify(state);
  const missing = row(); delete missing['企业规模'];
  for (const data of [[row({ '法定代表人': '张三' })], [missing], [row({ '企业全称': ' ', '统一社会信用代码': '' })], [], null]) {
    assert.equal(validateTemplateRows(data).valid, false);
    assert.throws(() => applyTemplateBatch(state, { rows: data, now }), /模板|不能为空/);
    assert.equal(JSON.stringify(state), before);
  }
});

test('bad editable file mapping and removed scripts cannot affect fixed template ingestion', () => {
  const state = createInitialState({ seed: false });
  state.mappings.file = [{ sourceField: '被改坏的列', targetField: 'legalPerson', scriptId: 'missing_script', enabled: true }];
  state.scripts = [];
  const mappings = JSON.stringify(state.mappings), scripts = JSON.stringify(state.scripts);
  const original = row();
  const { task, records } = applyTemplateBatch(state, { rows: [original], now });
  assert.equal(task.failed, 0); assert.equal(task.added, 1); assert.equal(task.newEnterprises, 1);
  assert.deepEqual(records[0].qualifications, ['高新技术企业', '专精特新']);
  assert.deepEqual(records[0].chainNodes, ['显示模组', '显示面板']);
  assert.equal(JSON.stringify(state.mappings), mappings); assert.equal(JSON.stringify(state.scripts), scripts);
  assert.deepEqual(state.rawRecords[0].raw, original);
  const lineage = getLineage(state, records[0].id, 'qualifications');
  assert.equal(lineage.selected.sourceId, 'file'); assert.equal(lineage.selected.rawField, '企业资质');
  assert.equal(lineage.selected.script, null);
  assert.equal(state.dataVersion, 2); assert.equal(state.sequence, 2); assert.equal(state.tasks[0].id, task.id);
  assert.equal(state.schedules.file.lastCursor, '2026-10-27T01:30:00.000Z');
});

test('same code updates without duplication and repeated files do not fabricate source changes', () => {
  const state = createInitialState({ seed: false });
  applyTemplateBatch(state, { rows: [row()], now });
  const id = state.records[0].id;
  const changed = row({ '企业全称': '演示模板更名科技有限公司', '企业规模': '大型', '数据更新时间': '2026-10-28 09:30:00' });
  const update = applyTemplateBatch(state, { rows: [changed], now: '2026-10-28T10:00:00+08:00' }).task;
  assert.equal(update.updated, 1); assert.equal(update.added, 0); assert.equal(update.changedEnterprises, 1);
  assert.equal(state.records.length, 1); assert.equal(state.rawRecords.length, 1); assert.equal(state.records[0].id, id);
  assert.equal(state.records[0].enterpriseName, changed['企业全称']);
  const repeat = applyTemplateBatch(state, { rows: [changed], now: '2026-10-28T11:00:00+08:00' }).task;
  assert.equal(repeat.unchanged, 1); assert.equal(repeat.updated, 0); assert.equal(repeat.changedEnterprises, 0);
});

test('dated source protection and duplicate resolution remain identical to the shared ingestion engine', () => {
  const state = createInitialState({ seed: false });
  const old = row({ '企业规模': '小型', '数据更新时间': '2026-10-26 09:30:00' });
  const fresh = row();
  const first = applyTemplateBatch(state, { rows: [fresh, old], now }).task;
  assert.equal(first.duplicates, 1); assert.equal(first.added, 1); assert.equal(state.records[0].scale, '中型');
  assert.deepEqual(state.rawRecords[0].raw, fresh);
  const cursor = state.schedules.file.lastCursor;
  const stale = applyTemplateBatch(state, { rows: [old], now: '2026-10-29T10:00:00+08:00' }).task;
  assert.equal(stale.ignoredStale, 1); assert.equal(state.records[0].scale, '中型'); assert.equal(state.schedules.file.lastCursor, cursor);
  const undated = applyTemplateBatch(state, { rows: [row({ '企业规模': '微型', '数据更新时间': '' })], now: '2026-10-30T10:00:00+08:00' }).task;
  assert.equal(undated.ignoredUnknownTime, 1); assert.equal(state.records[0].scale, '中型');
});

test('template values fuse by configured source priority and retain API candidates', () => {
  const state = createInitialState({ seed: false });
  applyBatch(state, { sourceId: 'qcc', rows: [structuredClone(DEMO_SNAPSHOTS.qcc.v1[0])], now });
  const apiName = state.records[0].enterpriseName, code = state.records[0].creditCode;
  state.priorities.enterpriseName = ['file', 'qcc', 'tyc'];
  const uploaded = row({ '统一社会信用代码': code });
  applyTemplateBatch(state, { rows: [uploaded], now });
  assert.equal(state.records.length, 1); assert.equal(state.records[0].enterpriseName, uploaded['企业全称']);
  const lineage = getLineage(state, state.records[0].id, 'enterpriseName');
  assert.equal(lineage.selected.sourceId, 'file'); assert.equal(lineage.candidates.find(item => item.sourceId === 'qcc').value, apiName);
  assert.equal(state.rawRecords.length, 2);
});
