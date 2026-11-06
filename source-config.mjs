import {FIELD_DEFS,LEGACY_ALIAS_MAP,createInitialState,createDefaultFtpMappings} from './core.mjs';
import {normalizeTechnicalIds,upgradeRiskEventSchema} from './enterprise-domain.mjs';

const copy=value=>JSON.parse(JSON.stringify(value));

function unchangedLegacyDemo(state,provider){
  if(provider.id!=='ftp_demo'||provider.name!=='企业数据 FTP 信源'||provider.type!=='ftp')return false;
  const expected={protocol:'ftps',host:'ftp.example.invalid',port:21,directory:'/enterprise',filePattern:'enterprise_*.json',username:'demo_reader',format:'json'};
  if(!Object.entries(expected).every(([key,value])=>provider.ftpConfig?.[key]===value))return false;
  const pairs=[['company_name','enterpriseName'],['credit_code','creditCode'],['legal_person','legalPerson'],['registration_status','registrationStatus'],['established_at','establishedAt'],['capital_wan','registeredCapitalWan'],['province','regionProvince'],['city','regionCity'],['district','regionDistrict'],['industry','industry'],['business_scope','businessScope'],['registered_address','registeredAddress'],['qualifications','qualifications'],['scale','scale'],['chain_nodes','chainNodes']];
  const mappings=state.mappings[provider.id]??[];
  return mappings.length===pairs.length&&pairs.every(([sourceField,targetField])=>mappings.some(m=>m.sourceField===sourceField&&m.targetField===targetField&&m.enabled!==false&&(m.scriptId??'')===(['qualifications','chainNodes'].includes(targetField)?'split_values':'')));
}

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
  const needsRiskExtension=Number(state.schemaVersion??0)<2.6;
  const needsIndustryExtension=!state.industryConfigVersion;
  const defaults = createInitialState({seed:false});
  for(const provider of defaults.providers){
    if(state.providers.some(item=>item.id===provider.id))continue;
    state.providers.push(copy(provider));
    state.mappings[provider.id] ??= copy(defaults.mappings[provider.id]);
    state.schedules[provider.id] ??= copy(defaults.schedules[provider.id]);
  }
  state.scripts??=[];
  for(const script of defaults.scripts)if(!state.scripts.some(item=>item.id===script.id))state.scripts.push(copy(script));
  // Retain historical identity, source records, mappings, rankings and pins. Never
  // relabel a vendor's old values as FTP or a local upload, or recompute on upgrade.
  for (const provider of state.providers) {
    delete provider.managedKeywords;
    const legacyDemo=unchangedLegacyDemo(state,provider);
    if (provider.type !== 'api'&&!legacyDemo) continue;
    provider.enabled = false;
    provider.retired = true;
    provider.status = 'retired';
    if(legacyDemo)provider.legacyDemo=true;
    if (state.schedules[provider.id]) Object.assign(state.schedules[provider.id], {enabled:false, nextRunAt:null});
    for(const job of state.updateJobs??[])if(job.sourceId===provider.id)Object.assign(job,{retired:true,enabled:false,nextRunAt:null});
  }
  const currentIds = state.providers.filter(isConfigurableSource).map(provider => provider.id);
  if(needsRiskExtension){
    const extensions=createDefaultFtpMappings().filter(m=>['enterprise_risk_event.published_date','enterprise_risk_event.publishing_authority'].includes(m.targetField));
    const previousDefaults=createDefaultFtpMappings().filter(m=>!extensions.some(e=>e.targetField===m.targetField));
    const olderDefaults=[...previousDefaults.filter(m=>!m.sourceField.startsWith('industry_records[].')),{enabled:true,sourceField:'industry',targetField:LEGACY_ALIAS_MAP.industry,scriptId:''}];
    for(const provider of state.providers.filter(p=>p.type==='ftp'&&!p.retired)){
      const mappings=state.mappings[provider.id]??[];
      // Only untouched V2.5 defaults receive additional mappings. Keep every custom rule.
      if([previousDefaults,olderDefaults].some(defaults=>mappings.length===defaults.length&&defaults.every(d=>mappings.some(m=>m.sourceField===d.sourceField&&m.targetField===d.targetField&&(m.scriptId??'')===d.scriptId&&m.enabled!==false))))mappings.push(...copy(extensions));
    }
  }
  if(needsIndustryExtension){
    const next=createDefaultFtpMappings(),previous=[...next.filter(m=>!m.sourceField.startsWith('industry_records[].')),{enabled:true,sourceField:'industry',targetField:LEGACY_ALIAS_MAP.industry,scriptId:''}];
    for(const provider of state.providers.filter(p=>p.type==='ftp'&&!p.retired)){
      const current=state.mappings[provider.id]??[];
      if(current.length===previous.length&&previous.every(d=>current.some(m=>m.sourceField===d.sourceField&&m.targetField===d.targetField&&(m.scriptId??'')===d.scriptId&&m.enabled!==false)))state.mappings[provider.id]=copy(next);
    }
    state.industryConfigVersion=1;
  }
  for (const field of [...FIELD_DEFS,...Object.keys(state.priorities).filter(key=>!FIELD_DEFS.some(f=>f.key===key)).map(key=>({key}))]) {
    const alias=Object.entries(LEGACY_ALIAS_MAP).find(([,key])=>key===field.key)?.[0];
    const existing = Array.isArray(state.priorities[field.key]) ? state.priorities[field.key] : Array.isArray(state.priorities[alias])?state.priorities[alias]:[];
    state.priorities[field.key] = [...new Set([...existing.filter(id => currentIds.includes(id)), ...currentIds, ...existing.filter(id => !currentIds.includes(id))])];
  }
  state.sourceConfigVersion = 5;
  state.schemaVersion = 2.6;
  return upgradeRiskEventSchema(normalizeTechnicalIds(state));
}
