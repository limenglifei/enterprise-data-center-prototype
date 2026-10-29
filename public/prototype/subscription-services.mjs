import {publicEnterprise} from './api-services.mjs';

export const SUBSCRIPTION_LIMITS=Object.freeze({services:20,records:100,deliveries:20,attempts:10,batchBytes:64*1024});
const FREQUENCIES={manual:'手动',hourly:'每小时',daily:'每天',weekly:'每周'};
const STATUSES={draft:'草稿',published:'已发布',paused:'已暂停'};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=()=>new Date().toISOString();
const uid=()=>globalThis.crypto?.randomUUID?.()||`sub_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const when=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
const clone=value=>JSON.parse(JSON.stringify(value));
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const button=(label,action,id='',kind='ghost',extra='')=>`<button class="btn ${kind}" data-action="subscription-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
const json=value=>`<pre class="code-editor" style="max-height:360px;overflow:auto">${esc(JSON.stringify(value,null,2))}</pre>`;
const regionLabel=value=>[value.province,value.city,value.district].filter(Boolean).join(' / ');
const regionKey=value=>JSON.stringify([value.province||'',value.city||'',value.district||'']);
const regionFromKey=value=>{const [province,city,district]=JSON.parse(value);return {province,city,district};};

export function upgradeSubscriptions(state){
  if(!Array.isArray(state.subscriptions))state.subscriptions=[];
  if(!Array.isArray(state.subscriptionDeliveries))state.subscriptionDeliveries=[];
  return state;
}

export function validateSubscriptionConfig(config){
  const errors=[];
  if(!config||typeof config!=='object'||Array.isArray(config))return {valid:false,errors:['订阅配置不能为空']};
  if(typeof config.name!=='string'||!config.name.trim()||config.name.length>60)errors.push('订阅名称须为 1–60 个字符');
  if(typeof config.description!=='string'||config.description.length>500)errors.push('说明不能超过 500 个字符');
  try{const url=new URL(config.webhookUrl);if(typeof config.webhookUrl!=='string'||config.webhookUrl.length>1000||url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash)throw new Error();}catch{errors.push('Webhook 需为有效 HTTPS 地址，不能包含账号密码或锚点');}
  if(!Object.hasOwn(FREQUENCIES,config.frequency))errors.push('请选择有效推送频率');
  if(!['full','incremental'].includes(config.mode))errors.push('请选择全量或增量推送');
  if(!config.filters||typeof config.filters!=='object'||Array.isArray(config.filters))errors.push('订阅条件格式无效');
  else{
    for(const [key,label] of [['industries','行业'],['qualifications','荣誉资质']]){
      const values=config.filters[key];
      if(!Array.isArray(values)||values.length>50||values.some(value=>typeof value!=='string'||!value.trim()||value.length>100))errors.push(`${label}最多选择 50 个有效值，每项不超过 100 个字符`);
    }
    const regions=config.filters.regions;
    if(!Array.isArray(regions)||regions.length>50||regions.some(region=>!region||typeof region!=='object'||Array.isArray(region)||!['province','city','district'].every(key=>typeof region[key]==='string'&&region[key].length<=100)||!region.province.trim()||(region.district&&!region.city)))errors.push('注册地区最多选择 50 项，需使用完整省、市、区路径');
    if(Object.keys(config.filters).some(key=>!['industries','regions','qualifications'].includes(key)))errors.push('包含不支持的订阅条件');
  }
  return {valid:errors.length===0,errors};
}

function normalizedConfig(input){
  const candidate={name:input?.name,description:input?.description??'',webhookUrl:input?.webhookUrl,frequency:input?.frequency,mode:input?.mode,filters:input?.filters};
  const validation=validateSubscriptionConfig(candidate);
  if(!validation.valid)throw new Error(validation.errors.join('；'));
  return {...candidate,name:candidate.name.trim(),description:candidate.description.trim(),webhookUrl:candidate.webhookUrl.trim(),filters:{industries:[...new Set(candidate.filters.industries.map(value=>value.trim()))],regions:[...new Map(candidate.filters.regions.map(region=>{const value=Object.fromEntries(['province','city','district'].map(key=>[key,region[key].trim()]));return [regionKey(value),value];})).values()],qualifications:[...new Set(candidate.filters.qualifications.map(value=>value.trim()))]}};
}

export function createSubscription(state,input,{id=uid(),now=stamp()}={}){
  upgradeSubscriptions(state);
  const config=normalizedConfig(input);
  if(state.subscriptions.length>=SUBSCRIPTION_LIMITS.services)throw new Error(`原型最多保留 ${SUBSCRIPTION_LIMITS.services} 个批量订阅推送服务`);
  if(typeof id!=='string'||!id||id.length>100||state.subscriptions.some(service=>service.id===id))throw new Error('订阅标识无效或已存在');
  const service={id,...config,status:'draft',revision:1,createdAt:now,updatedAt:now,publishedAt:null,cursorVersion:0,snapshot:{},lastSuccessfulDeliveryId:null,lastSuccessAt:null};
  state.subscriptions.push(service);
  return service;
}

function findSubscription(state,id){upgradeSubscriptions(state);const service=state.subscriptions.find(value=>value.id===id);if(!service)throw new Error('批量订阅推送服务不存在');return service;}

export function saveSubscription(state,id,input,{now=stamp()}={}){
  const service=findSubscription(state,id),config=normalizedConfig(input);
  Object.assign(service,config,{status:'draft',revision:(service.revision||1)+1,updatedAt:now,cursorVersion:0,snapshot:{},lastSuccessfulDeliveryId:null,lastSuccessAt:null});
  return service;
}

export function publishSubscription(state,id,{now=stamp()}={}){
  const service=findSubscription(state,id),validation=validateSubscriptionConfig(service);
  if(!validation.valid)throw new Error(validation.errors.join('；'));
  Object.assign(service,{status:'published',publishedAt:now,updatedAt:now});return service;
}

export function pauseSubscription(state,id,{now=stamp()}={}){
  const service=findSubscription(state,id);Object.assign(service,{status:'paused',updatedAt:now});return service;
}

function matches(record,filters){
  return (!filters.industries.length||filters.industries.includes(record.industry))&&(!filters.regions.length||filters.regions.some(region=>record.regionProvince===region.province&&(!region.city||record.regionCity===region.city)&&(!region.district||record.regionDistrict===region.district)))&&(!filters.qualifications.length||filters.qualifications.some(value=>(record.qualifications||[]).includes(value)));
}

export function previewSubscription(state,serviceOrId){
  const service=typeof serviceOrId==='string'?findSubscription(state,serviceOrId):serviceOrId;
  const validation=validateSubscriptionConfig(service);if(!validation.valid)throw new Error(validation.errors.join('；'));
  return (state.records||[]).filter(record=>matches(record,service.filters)).map(publicEnterprise);
}

function recordSignature(record){
  // Ignore refresh timestamps and ordering within set-valued fields: push only substantive field changes.
  const {dataUpdatedAt,...fields}=record;
  for(const key of ['qualifications','chainNodes'])if(Array.isArray(fields[key]))fields[key]=[...new Set(fields[key])].sort();
  return JSON.stringify(fields);
}

function makeBatch(state,service){
  const records=previewSubscription(state,service).sort((a,b)=>String(a.creditCode||a.enterpriseId).localeCompare(String(b.creditCode||b.enterpriseId)));
  if(records.length>SUBSCRIPTION_LIMITS.records)throw new Error(`原型单次最多匹配 ${SUBSCRIPTION_LIMITS.records} 家企业，请缩小订阅条件；生产服务需分页分批投递`);
  const nextSnapshot=Object.create(null);
  for(const record of records){
    const key=String(record.creditCode||record.enterpriseId||'');
    if(!key||Object.hasOwn(nextSnapshot,key))throw new Error('企业标识缺失或重复，无法建立增量快照');
    nextSnapshot[key]={enterpriseId:record.enterpriseId,creditCode:record.creditCode,signature:recordSignature(record)};
  }
  const previous=service.snapshot||{},first=!service.cursorVersion;
  const unchanged=!first&&JSON.stringify(previous)===JSON.stringify(nextSnapshot);
  let changes=records.map(record=>({operation:'upsert',record}));
  if(service.mode==='incremental'&&!first){
    changes=changes.filter(change=>previous[change.record.creditCode||change.record.enterpriseId]?.signature!==recordSignature(change.record));
    for(const [key,value] of Object.entries(previous))if(!Object.hasOwn(nextSnapshot,key))changes.push({operation:'remove',enterpriseId:value.enterpriseId,creditCode:value.creditCode,reason:'no_longer_matches_or_removed'});
  }
  if(changes.length>SUBSCRIPTION_LIMITS.records)throw new Error(`本次变更超过 ${SUBSCRIPTION_LIMITS.records} 条，请缩小订阅条件；生产服务需分批投递`);
  return {records,nextSnapshot,changes,first,unchanged,mode:first?'baseline':service.mode};
}

function commitSuccess(service,delivery,now){
  service.snapshot=clone(delivery.nextSnapshot);
  service.cursorVersion=(service.cursorVersion||0)+1;
  service.lastSuccessfulDeliveryId=delivery.id;service.lastSuccessAt=now;
  delivery.status='success';delivery.httpStatus=200;delivery.completedAt=now;
  delete delivery.nextSnapshot;
}

function attempt(delivery,fail,now){
  delivery.attempts.push({attempt:delivery.attempts.length+1,createdAt:now,httpStatus:fail?503:200,status:fail?'failed':'success',message:fail?'演示接收端暂不可用；未发送网络请求':'模拟接收成功；未发送网络请求'});
  delivery.status=fail?'failed':'success';delivery.httpStatus=fail?503:200;delivery.updatedAt=now;
}

/** Browser-only delivery simulation. Never performs fetch, XHR, scheduling or webhook transmission. */
export function simulateSubscriptionDelivery(state,id,{now=stamp(),id:deliveryId=uid(),fail=false}={}){
  const service=findSubscription(state,id);
  if(service.status!=='published')throw new Error('订阅需先发布；草稿或已暂停服务不能推送');
  const batch=makeBatch(state,service);
  if(batch.unchanged)return {status:'unchanged',delivery:null,message:'数据未变化，已跳过重复模拟；未新增投递记录'};
  if(!batch.records.length&&batch.first)return {status:'empty',delivery:null,message:'暂无匹配企业，未生成投递；后续有匹配企业时再建立全量基线'};
  const pending=state.subscriptionDeliveries.find(delivery=>delivery.subscriptionId===id&&delivery.status==='failed'&&delivery.revision===service.revision&&delivery.expectedCursorVersion===(service.cursorVersion||0)&&JSON.stringify(delivery.nextSnapshot)===JSON.stringify(batch.nextSnapshot));
  if(pending)return {status:'pending_retry',delivery:pending,message:'相同批次已有失败记录，请使用原批次重试，避免重复生成事件'};
  if(typeof deliveryId!=='string'||!deliveryId||deliveryId.length>100||state.subscriptionDeliveries.some(delivery=>delivery.id===deliveryId))throw new Error('投递事件标识无效或重复');
  const payload={eventId:deliveryId,subscriptionId:id,subscriptionName:service.name,configRevision:service.revision,mode:batch.mode,createdAt:now,matchedCount:batch.records.length,changeCount:batch.changes.length,changes:batch.changes};
  if(bytes({payload,nextSnapshot:batch.nextSnapshot})>SUBSCRIPTION_LIMITS.batchBytes)throw new Error('模拟批次超过 64 KiB，请缩小订阅条件；生产服务需分批投递');
  const delivery={id:deliveryId,subscriptionId:id,subscriptionName:service.name,revision:service.revision,webhookUrl:service.webhookUrl,frequency:service.frequency,expectedCursorVersion:service.cursorVersion||0,createdAt:now,updatedAt:now,status:'failed',httpStatus:null,mode:batch.mode,matchedCount:batch.records.length,changeCount:batch.changes.length,attempts:[],payload,nextSnapshot:batch.nextSnapshot};
  attempt(delivery,fail,now);
  if(!fail)commitSuccess(service,delivery,now);
  state.subscriptionDeliveries.unshift(delivery);
  state.subscriptionDeliveries=state.subscriptionDeliveries.slice(0,SUBSCRIPTION_LIMITS.deliveries);
  return {status:delivery.status,delivery,message:fail?'模拟投递失败，增量基线保持不变，可重试原事件':'模拟投递成功，已保存成功快照；未发送真实网络请求'};
}

export function retrySubscriptionDelivery(state,deliveryId,{now=stamp(),fail=false}={}){
  upgradeSubscriptions(state);
  const delivery=state.subscriptionDeliveries.find(value=>value.id===deliveryId);
  if(!delivery)throw new Error('投递记录不存在或已超出保留范围');
  const service=findSubscription(state,delivery.subscriptionId);
  if(service.status!=='published')throw new Error('订阅需处于已发布状态才能重试');
  if(delivery.status!=='failed')throw new Error('仅失败批次可重试；已成功事件不会重复投递');
  if(delivery.revision!==service.revision)throw new Error('订阅配置已修改，请使用新配置生成批次');
  if(delivery.expectedCursorVersion!==(service.cursorVersion||0))throw new Error('增量基线已有后续成功批次，请重新生成当前变更，不能重放过期批次');
  if(delivery.attempts.length>=SUBSCRIPTION_LIMITS.attempts)throw new Error('原型同一事件最多模拟 10 次尝试');
  attempt(delivery,fail,now);
  if(!fail)commitSuccess(service,delivery,now);
  return {status:delivery.status,delivery,message:fail?'模拟重试失败，增量基线保持不变':'模拟重试成功，沿用原 eventId 并提交该批次快照'};
}

function conditionText(service){
  const filters=service.filters||{},parts=[];
  if(filters.industries?.length)parts.push(`行业：${filters.industries.join('、')}`);
  if(filters.regions?.length)parts.push(`地区：${filters.regions.map(regionLabel).join('；')}`);
  if(filters.qualifications?.length)parts.push(`荣誉资质：${filters.qualifications.join('、')}`);
  return parts.join('；')||'全部企业（未限制条件）';
}

export function renderSubscriptions(state){
  upgradeSubscriptions(state);
  const published=state.subscriptions.filter(service=>service.status==='published').length;
  return `<div class="inline-notice"><span class="badge blue">批量订阅推送</span><span>按国民经济行业、注册地区、荣誉资质组合订阅统一企业数据。同维度多选为 OR，跨维度为 AND；空维度不限。当前仅模拟 Webhook 投递，不会发送网络请求；自动定时、签名鉴权与接收端幂等需由服务端实现。</span></div><div class="stats-grid"><div class="stat-card"><div class="stat-label">批量订阅推送服务</div><div class="stat-value">${state.subscriptions.length}<span>个</span></div><div class="stat-footer">上限 ${SUBSCRIPTION_LIMITS.services} 个</div></div><div class="stat-card"><div class="stat-label">已发布</div><div class="stat-value">${published}<span>个</span></div><div class="stat-footer">支持手动模拟投递</div></div><div class="stat-card"><div class="stat-label">成功投递</div><div class="stat-value">${state.subscriptionDeliveries.filter(delivery=>delivery.status==='success').length}<span>次</span></div><div class="stat-footer">基于保留的模拟记录</div></div><div class="stat-card"><div class="stat-label">失败批次</div><div class="stat-value">${state.subscriptionDeliveries.filter(delivery=>delivery.status==='failed').length}<span>个</span></div><div class="stat-footer">失败不推进增量快照</div></div></div><section class="card section-gap"><div class="card-header"><div><h2>批量订阅推送服务</h2><p class="subtle">增量首次投递建立全量基线；之后发送新增、字段变化和移出订阅范围事件。配置修改后需重新发布并建立基线。</p></div>${button('新增批量订阅推送服务','create','','primary')}</div>${state.subscriptions.length?`<div class="table-wrap"><table><thead><tr><th>订阅名称 / 条件</th><th>Webhook 目标</th><th>方式 / 频率</th><th>状态</th><th>最近投递</th><th>操作</th></tr></thead><tbody>${state.subscriptions.map(service=>{
    const last=state.subscriptionDeliveries.find(delivery=>delivery.subscriptionId===service.id);
    return `<tr><td><strong>${esc(service.name)}</strong><p class="subtle" style="max-width:300px">${esc(conditionText(service))}</p></td><td class="mono" style="max-width:220px;overflow-wrap:anywhere">${esc(service.webhookUrl)}</td><td>${service.mode==='full'?'全量':'增量'}<p class="subtle">${esc(FREQUENCIES[service.frequency]||service.frequency)} · 自动调度待服务端</p></td><td><span class="badge ${service.status==='published'?'success':service.status==='paused'?'neutral':'warning'}">${esc(STATUSES[service.status]||service.status)}</span><p class="subtle">配置 v${esc(service.revision)}</p></td><td>${last?`<span class="badge ${last.status==='success'?'success':'warning'}">${last.status==='success'?'模拟成功':'模拟失败'}</span><p class="subtle">${when(last.updatedAt)}</p>`:'暂无投递'}</td><td><div class="button-group" style="display:flex;flex-wrap:wrap;gap:6px;min-width:200px">${button('配置','edit',service.id)}${button('预览企业','preview',service.id)}${button('投递记录','history',service.id)}${service.status==='published'?`${button('模拟推送','simulate',service.id,'primary')}${button('暂停','pause',service.id)}`:button('发布','publish',service.id,'primary')}</div></td></tr>`;
  }).join('')}</tbody></table></div>`:`<div class="empty-state"><h3>暂无批量订阅推送服务</h3><p>配置行业、注册地区和荣誉资质，发布后预览匹配企业并模拟 Webhook 推送。</p>${button('新增批量订阅推送服务','create','','primary')}</div>`}</section><p class="subtle section-gap">原型每批最多 ${SUBSCRIPTION_LIMITS.records} 条变更、64 KiB，保留最近 ${SUBSCRIPTION_LIMITS.deliveries} 个投递批次。同数据重复模拟会跳过；失败重试复用 eventId。行业值来自当前统一企业库，未接入官方国民经济行业编码字典。</p>`;
}

function availableRegions(records){
  const values=new Map();
  for(const record of records){
    if(!record.regionProvince)continue;
    for(const depth of [1,2,3]){
      if(depth>=2&&!record.regionCity||depth===3&&!record.regionDistrict)continue;
      const region={province:record.regionProvince,city:depth>=2?record.regionCity:'',district:depth===3?record.regionDistrict:''};values.set(regionKey(region),region);
    }
  }
  return values;
}

function configureDialog(state,service,showModal){
  const config=service||{name:'',description:'',webhookUrl:'https://example.com/webhooks/enterprise',frequency:'daily',mode:'incremental',filters:{industries:[],regions:[],qualifications:[]}};
  const industries=[...new Set([...(state.records||[]).map(record=>record.industry).filter(Boolean),...config.filters.industries])].sort();
  const qualifications=[...new Set([...(state.records||[]).flatMap(record=>record.qualifications||[]),...config.filters.qualifications])].sort();
  const regions=availableRegions(state.records||[]);for(const region of config.filters.regions)regions.set(regionKey(region),region);
  const selectedRegions=new Set(config.filters.regions.map(regionKey));
  const options=(values,selected)=>values.map(value=>`<option value="${esc(value)}" ${selected.includes(value)?'selected':''}>${esc(value)}</option>`).join('');
  showModal(service?'配置批量订阅推送服务':'新增批量订阅推送服务',`<form id="subscription-config-form" class="form-grid"><div class="form-field full"><label for="subscription-name">订阅名称</label><input id="subscription-name" name="name" maxlength="60" value="${esc(config.name)}" placeholder="例如：合肥高新技术企业数据订阅" required></div><div class="form-field full"><label for="subscription-webhook">Webhook 目标地址</label><input id="subscription-webhook" name="webhookUrl" type="url" maxlength="1000" value="${esc(config.webhookUrl)}" required><small>仅支持 HTTPS，禁止在地址中放入账号密码。example.com 为演示占位地址，当前不会真实调用。</small></div><div class="form-field"><label for="subscription-mode">推送方式</label><select id="subscription-mode" name="mode"><option value="incremental" ${config.mode==='incremental'?'selected':''}>增量：首次全量，后续推送变更</option><option value="full" ${config.mode==='full'?'selected':''}>全量：推送全部匹配企业</option></select></div><div class="form-field"><label for="subscription-frequency">推送频率</label><select id="subscription-frequency" name="frequency">${Object.entries(FREQUENCIES).map(([value,label])=>`<option value="${value}" ${config.frequency===value?'selected':''}>${label}</option>`).join('')}</select><small>保存调度配置；原型仅通过按钮手动模拟，生产自动调度由服务端执行。</small></div><div class="form-field"><label for="subscription-industries">国民经济行业（可多选）</label><select id="subscription-industries" name="industries" multiple size="5">${options(industries,config.filters.industries)}</select><small>库内行业值精确匹配；未接入官方编码字典。</small></div><div class="form-field"><label for="subscription-regions">注册地区（可多选）</label><select id="subscription-regions" name="regions" multiple size="5">${[...regions.values()].sort((a,b)=>regionLabel(a).localeCompare(regionLabel(b),'zh-CN')).map(region=>`<option value="${esc(regionKey(region))}" ${selectedRegions.has(regionKey(region))?'selected':''}>${esc(regionLabel(region))}</option>`).join('')}</select><small>支持省、市、区层级；选择省级项覆盖该省下属市区。</small></div><div class="form-field full"><label for="subscription-qualifications">荣誉资质（可多选）</label><select id="subscription-qualifications" name="qualifications" multiple size="4">${options(qualifications,config.filters.qualifications)}</select><small>按住 Ctrl / Command 多选或取消选择。同一维度任一值满足即可，不同维度同时满足；所有维度未选表示全部企业。</small></div><div class="form-field full"><label for="subscription-description">服务说明</label><textarea id="subscription-description" name="description" maxlength="500" rows="2">${esc(config.description)}</textarea></div></form><div class="inline-notice section-gap"><span>${service?'保存修改后恢复草稿，原快照清空；重新发布后的首次投递建立新基线。':'新建后为草稿，需发布后才能模拟推送。'} 失败不推进快照；重试复用事件 ID。自动调度、签名、接收端鉴权均需服务端实现。</span></div>`,button(service?'保存配置':'创建批量订阅',service?'save':'save-new',service?.id||'','primary'),true);
}

function readForm(){
  const form=new FormData(document.querySelector('#subscription-config-form'));
  return {name:String(form.get('name')||''),description:String(form.get('description')||''),webhookUrl:String(form.get('webhookUrl')||'').trim(),mode:form.get('mode'),frequency:form.get('frequency'),filters:{industries:form.getAll('industries'),regions:form.getAll('regions').map(regionFromKey),qualifications:form.getAll('qualifications')}};
}

function previewDialog(state,service,showModal){
  const records=previewSubscription(state,service);
  showModal(`${service.name} · 匹配企业预览`,`<div class="inline-notice"><span>匹配 ${records.length} 家企业；同维 OR、跨维 AND。${esc(conditionText(service))}</span></div>${records.length?`<div class="table-wrap section-gap"><table><thead><tr><th>企业名称 / 信用代码</th><th>行业</th><th>注册地区</th><th>荣誉资质</th></tr></thead><tbody>${records.slice(0,20).map(record=>`<tr><td><strong>${esc(record.enterpriseName)}</strong><p class="mono subtle">${esc(record.creditCode)}</p></td><td>${esc(record.industry||'—')}</td><td>${esc([record.regionProvince,record.regionCity,record.regionDistrict].filter(Boolean).join(' / '))}</td><td>${esc((record.qualifications||[]).join('、')||'—')}</td></tr>`).join('')}</tbody></table></div><p class="subtle section-gap">预览最多展示前 20 家；原型单批上限 100 条变更、64 KiB。</p>`:'<div class="empty-state"><h3>暂无匹配企业</h3><p>调整订阅条件，或先在上游接入并入库数据。</p></div>'}<h3 class="section-gap">推送规则</h3><p class="subtle">${service.mode==='incremental'?'首次成功建立全量基线，后续只推送新增、实质字段变化和移出范围的企业。':'每次数据发生变化时推送当前全部匹配企业。'} 相同数据重复模拟会跳过，不新增记录；仅更新时间或多值字段顺序变化不视为数据变化。生产全量周期投递需由服务端按批次执行。</p>`,service.status==='published'?`${button('模拟失败','simulate-failure',service.id,'secondary')}${button('模拟推送','simulate',service.id,'primary')}`:button('发布批量订阅','publish',service.id,'primary'),true);
}

function historyDialog(state,service,showModal){
  const deliveries=state.subscriptionDeliveries.filter(delivery=>delivery.subscriptionId===service.id);
  showModal(`${service.name} · 投递记录`,`<p class="subtle">保留所有订阅最近 20 个模拟投递批次。失败重试沿用原 eventId；记录仅表示浏览器模拟，不代表真实网络交付。</p>${deliveries.length?`<div class="table-wrap section-gap"><table><thead><tr><th>时间 / eventId</th><th>配置版本 / 方式</th><th>匹配 / 事件数</th><th>状态 / 尝试</th><th>操作</th></tr></thead><tbody>${deliveries.map(delivery=>`<tr><td>${when(delivery.createdAt)}<p class="mono subtle" style="max-width:210px;overflow-wrap:anywhere">${esc(delivery.id)}</p></td><td>v${esc(delivery.revision)} · ${delivery.mode==='baseline'?'首次全量基线':delivery.mode==='full'?'全量':'增量'}</td><td>${delivery.matchedCount} / ${delivery.changeCount}</td><td><span class="badge ${delivery.status==='success'?'success':'warning'}">${delivery.status==='success'?'模拟成功':'模拟失败'} · ${delivery.httpStatus}</span><p class="subtle">${delivery.attempts.length} 次尝试</p></td><td>${button('详情','delivery',service.id,'ghost',`data-delivery-id="${esc(delivery.id)}"`)}${delivery.status==='failed'?button('重试','retry',service.id,'ghost',`data-delivery-id="${esc(delivery.id)}"`):''}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-state"><h3>暂无投递记录</h3><p>发布订阅后，执行模拟推送即可查看批次与 Payload。</p></div>'}`,service.status==='published'?button('模拟推送','simulate',service.id,'primary'):'',true);
}

function deliveryDialog(delivery,showModal){
  showModal(`${delivery.subscriptionName} · 投递详情`,`<div class="inline-notice"><span class="badge ${delivery.status==='success'?'success':'warning'}">${delivery.status==='success'?'模拟成功':'模拟失败'}</span><span>未发送真实网络请求。重试沿用下列 eventId，接收端应按此键幂等处理。</span></div><p class="mono section-gap" style="overflow-wrap:anywhere">POST ${esc(delivery.webhookUrl)}</p><p class="subtle">配置 v${esc(delivery.revision)} · ${when(delivery.createdAt)} · 匹配 ${delivery.matchedCount} 家 · ${delivery.changeCount} 条事件</p><h3 class="section-gap">投递尝试</h3><div class="table-wrap"><table><thead><tr><th>次数</th><th>时间</th><th>模拟响应</th><th>说明</th></tr></thead><tbody>${delivery.attempts.map(value=>`<tr><td>${value.attempt}</td><td>${when(value.createdAt)}</td><td>${value.httpStatus}</td><td>${esc(value.message)}</td></tr>`).join('')}</tbody></table></div><h3 class="section-gap">请求 Payload（JSON）</h3>${json(delivery.payload)}<p class="subtle section-gap">upsert 表示新增或字段变化，record 为当前公开企业字段；remove 表示企业已删除或不再符合订阅条件，并非一定注销。失败批次不推进快照，过期批次不允许重试。</p>`,delivery.status==='failed'?button('模拟重试成功','retry',delivery.subscriptionId,'primary',`data-delivery-id="${esc(delivery.id)}"`):'',true);
}

export async function handleSubscriptionAction(action,element,{getState,mutate,toast,showModal,closeModal}){
  const operation=action.replace(/^subscription-/,''),state=upgradeSubscriptions(getState()),id=element.dataset.id;
  if(operation==='create'){configureDialog(state,null,showModal);return;}
  if(operation==='save-new'||operation==='save'){
    let input;
    try{input=readForm();normalizedConfig(input);if(operation==='save-new'&&state.subscriptions.length>=SUBSCRIPTION_LIMITS.services)throw new Error('原型最多保留 20 个批量订阅推送服务');}catch(error){toast(error.message,'error');return;}
    const ok=await mutate(()=>{if(operation==='save-new')createSubscription(getState(),input);else saveSubscription(getState(),id,input);},operation==='save-new'?'批量订阅推送已创建为草稿':'批量订阅推送配置已保存为草稿，重新发布后建立新基线');
    if(ok)closeModal();return;
  }
  let service;
  try{service=findSubscription(state,id);}catch(error){toast(error.message,'error');return;}
  if(operation==='edit'){configureDialog(state,service,showModal);return;}
  if(operation==='preview'){try{previewDialog(state,service,showModal);}catch(error){toast(error.message,'error');}return;}
  if(operation==='history'){historyDialog(state,service,showModal);return;}
  if(operation==='delivery'){
    const delivery=state.subscriptionDeliveries.find(value=>value.id===element.dataset.deliveryId&&value.subscriptionId===id);
    if(!delivery){toast('投递记录不存在或已超出保留范围','error');return;}deliveryDialog(delivery,showModal);return;
  }
  if(operation==='publish'||operation==='pause'){
    const ok=await mutate(()=>{if(operation==='publish')publishSubscription(getState(),id);else pauseSubscription(getState(),id);},operation==='publish'?'批量订阅推送已发布，可手动模拟推送；自动调度需服务端':'批量订阅推送已暂停，禁止推送与重试');
    if(ok)closeModal();return;
  }
  if(['simulate','simulate-failure','retry'].includes(operation)){
    let result;
    const ok=await mutate(()=>{result=operation==='retry'?retrySubscriptionDelivery(getState(),element.dataset.deliveryId):simulateSubscriptionDelivery(getState(),id,{fail:operation==='simulate-failure'});});
    if(ok&&result){toast(result.message,result.status==='failed'?'error':'success');if(result.delivery)deliveryDialog(result.delivery,showModal);}
  }
}
