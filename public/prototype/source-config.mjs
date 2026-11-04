import {FIELD_DEFS,createInitialState} from './core.mjs';

const copy=value=>JSON.parse(JSON.stringify(value));

export function isConfigurableSource(provider) {
  return !!provider && !provider.retired && ['ftp', 'file'].includes(provider.type);
}

export function upgradeSourceState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('数据中心状态须为对象');
  state.providers ??= [];
  state.mappings ??= {};
  state.schedules ??= {};
  state.priorities ??= {};
  state.uploadRecords ??= [];
  if (!state.providers.some(provider => provider.id === 'file')) {
    const defaults = createInitialState({seed:false});
    state.providers.push(copy(defaults.providers.find(provider => provider.id === 'file')));
    state.mappings.file ??= copy(defaults.mappings.file);
    state.schedules.file ??= copy(defaults.schedules.file);
  }
  // Retain historical identity, source records, mappings, rankings and pins. Never
  // relabel a vendor's old values as FTP or a local upload, or recompute on upgrade.
  for (const provider of state.providers) {
    delete provider.managedKeywords;
    if (provider.type !== 'api') continue;
    provider.enabled = false;
    provider.retired = true;
    provider.status = 'retired';
    if (state.schedules[provider.id]) Object.assign(state.schedules[provider.id], {enabled:false, nextRunAt:null});
  }
  const currentIds = state.providers.filter(isConfigurableSource).map(provider => provider.id);
  for (const field of FIELD_DEFS) {
    const existing = Array.isArray(state.priorities[field.key]) ? state.priorities[field.key] : [];
    state.priorities[field.key] = [...new Set([...existing.filter(id => currentIds.includes(id)), ...currentIds, ...existing.filter(id => !currentIds.includes(id))])];
  }
  state.sourceConfigVersion = 3;
  return state;
}
