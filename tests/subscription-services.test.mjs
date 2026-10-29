import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../public/prototype/core.mjs';
import {SUBSCRIPTION_LIMITS,upgradeSubscriptions,validateSubscriptionConfig,createSubscription,saveSubscription,publishSubscription,pauseSubscription,previewSubscription,simulateSubscriptionDelivery,retrySubscriptionDelivery,renderSubscriptions} from '../public/prototype/subscription-services.mjs';

const config=(extra={})=>({name:'产业企业变更订阅',description:'供下游系统接收企业变更',webhookUrl:'https://example.com/webhooks/enterprise',frequency:'daily',mode:'incremental',filters:{industries:[],regions:[],qualifications:[]},...extra});
const ready=()=>{const state=createInitialState();const service=createSubscription(state,config(),{id:'subscription-test',now:'2026-10-29T00:00:00Z'});publishSubscription(state,service.id);return {state,service};};
const deliver=(state,id='subscription-test',options={})=>simulateSubscriptionDelivery(state,id,{id:`delivery-${state.subscriptionDeliveries?.length||0}`,now:'2026-10-29T01:00:00Z',...options});

test('subscription migration is idempotent and preserves saved configurations and status',()=>{
  const state=createInitialState();upgradeSubscriptions(state);upgradeSubscriptions(state);assert.deepEqual(state.subscriptions,[]);assert.deepEqual(state.subscriptionDeliveries,[]);
  const service=createSubscription(state,config(),{id:'keep-me'});publishSubscription(state,service.id);const loaded=JSON.parse(JSON.stringify(state));upgradeSubscriptions(loaded);
  assert.equal(loaded.subscriptions.length,1);assert.equal(loaded.subscriptions[0].status,'published');assert.equal(loaded.subscriptions[0].name,service.name);
});

test('subscription configuration rejects unsafe endpoints and malformed conditions without partial creation',()=>{
  const state=createInitialState();
  for(const change of [{name:''},{name:'x'.repeat(61)},{description:'x'.repeat(501)},{webhookUrl:'ftp://example.com/path'},{webhookUrl:'https://user:password@example.com/hook'},{webhookUrl:'https://example.com/hook#token'},{webhookUrl:'javascript:alert(1)'},{webhookUrl:12},{frequency:'secondly'},{mode:'custom'},{filters:{industries:'电子信息',regions:[],qualifications:[]}},{filters:{industries:[],regions:[{province:'',city:'合肥市',district:''}],qualifications:[]}},{filters:{industries:[],regions:[{province:'安徽省',city:'',district:'蜀山区'}],qualifications:[]}},{filters:{industries:[],regions:[],qualifications:['x'.repeat(101)]}},{filters:{industries:[],regions:[],qualifications:[],arbitrary:true}}]){
    assert.equal(validateSubscriptionConfig(config(change)).valid,false);assert.throws(()=>createSubscription(state,config(change)));assert.equal(state.subscriptions.length,0);
  }
  assert.equal(validateSubscriptionConfig(config()).valid,true);
});

test('conditions use exact industry and qualification values with OR within a dimension and AND across dimensions',()=>{
  const state=createInitialState(),first=state.records[0],second=state.records.find(record=>record.creditCode!==first.creditCode);
  const filters={industries:[first.industry,second.industry],regions:[{province:first.regionProvince,city:first.regionCity,district:''}],qualifications:[first.qualifications[0],'不存在资质'].filter(Boolean)};
  const service=createSubscription(state,config({filters}));
  const expected=state.records.filter(record=>filters.industries.includes(record.industry)&&record.regionProvince===first.regionProvince&&record.regionCity===first.regionCity&&filters.qualifications.some(value=>record.qualifications.includes(value)));
  assert.deepEqual(previewSubscription(state,service).map(record=>record.creditCode),expected.map(record=>record.creditCode));
  assert.ok(expected.length);service.filters.industries=[first.industry.slice(0,1)];assert.equal(previewSubscription(state,service).length,0);
});

test('province, city and district hierarchy matching is exact and multiple region paths use OR',()=>{
  const state=createInitialState(),first=state.records[0],service=createSubscription(state,config());
  for(const [city,district] of [['',''],[first.regionCity,''],[first.regionCity,first.regionDistrict]]){
    service.filters.regions=[{province:first.regionProvince,city,district}];
    const expected=state.records.filter(record=>record.regionProvince===first.regionProvince&&(!city||record.regionCity===city)&&(!district||record.regionDistrict===district));
    assert.equal(previewSubscription(state,service).length,expected.length);
  }
  service.filters.regions.push({province:'不存在省',city:'',district:''});assert.ok(previewSubscription(state,service).length);
  service.filters.regions=[{province:'不存在省',city:'',district:''}];assert.equal(previewSubscription(state,service).length,0);
});

test('draft and paused subscriptions cannot deliver or retry and publication validates the config',()=>{
  const state=createInitialState(),service=createSubscription(state,config());
  assert.equal(service.status,'draft');assert.throws(()=>deliver(state,service.id),/先发布/);
  publishSubscription(state,service.id);const failed=deliver(state,service.id,{fail:true});pauseSubscription(state,service.id);
  assert.equal(service.status,'paused');assert.throws(()=>deliver(state,service.id),/先发布/);assert.throws(()=>retrySubscriptionDelivery(state,failed.delivery.id),/已发布/);
  publishSubscription(state,service.id);assert.equal(retrySubscriptionDelivery(state,failed.delivery.id).status,'success');
  service.webhookUrl='http://example.com';assert.throws(()=>publishSubscription(state,service.id),/HTTPS/);
});

test('first incremental delivery creates a full baseline and unchanged repeated simulation is idempotent',()=>{
  const {state,service}=ready(),result=deliver(state);
  assert.equal(result.status,'success');assert.equal(result.delivery.mode,'baseline');assert.equal(result.delivery.changeCount,state.records.length);assert.ok(result.delivery.payload.changes.every(change=>change.operation==='upsert'));
  assert.equal(service.cursorVersion,1);assert.equal(Object.keys(service.snapshot).length,state.records.length);assert.equal(state.subscriptionDeliveries.length,1);
  const again=deliver(state);assert.equal(again.status,'unchanged');assert.equal(again.delivery,null);assert.equal(service.cursorVersion,1);assert.equal(state.subscriptionDeliveries.length,1);
  assert.equal('lineage' in result.delivery.payload.changes[0].record,false);assert.equal('raw' in result.delivery.payload.changes[0].record,false);assert.equal('nextSnapshot' in result.delivery,false);
});

test('incremental change detection ignores row order, refresh timestamps and set ordering',()=>{
  const {state,service}=ready();deliver(state);state.records.reverse();state.records[0].updatedAt='2026-11-01T00:00:00Z';
  state.records[0].qualifications.reverse();state.records[0].chainNodes.reverse();
  assert.equal(deliver(state).status,'unchanged');assert.equal(service.cursorVersion,1);
});

test('incremental pushes only actual changes, additions, and removals from the subscribed range',()=>{
  const {state,service}=ready(),first=state.records[0],removed=state.records[1];deliver(state);
  first.legalPerson='更新后的法人';state.records=state.records.filter(record=>record!==removed);state.records.push({...first,id:'added-entity',enterpriseId:'added-entity',creditCode:'DEMO_NEW_ENTERPRISE',enterpriseName:'新增企业'});
  const result=deliver(state),changes=result.delivery.payload.changes;
  assert.equal(result.delivery.mode,'incremental');assert.equal(changes.length,3);assert.equal(changes.filter(change=>change.operation==='upsert').length,2);assert.equal(changes.find(change=>change.operation==='remove').creditCode,removed.creditCode);
  assert.equal(service.cursorVersion,2);assert.equal(deliver(state).status,'unchanged');
});

test('losing a subscribed qualification produces remove even if the enterprise remains in the center',()=>{
  const {state,service}=ready(),first=state.records[0],qualification=first.qualifications[0];assert.ok(qualification);
  saveSubscription(state,service.id,config({filters:{industries:[],regions:[],qualifications:[qualification]}}));publishSubscription(state,service.id);deliver(state);
  first.qualifications=first.qualifications.filter(value=>value!==qualification);const result=deliver(state);
  assert.equal(result.delivery.mode,'incremental');assert.ok(result.delivery.payload.changes.some(change=>change.operation==='remove'&&change.creditCode===first.creditCode));assert.ok(state.records.includes(first));
});

test('failed delivery does not advance the baseline and a retry retains the payload and eventId',()=>{
  const {state,service}=ready(),failed=deliver(state,service.id,{id:'failed-event',fail:true}),originalPayload=JSON.stringify(failed.delivery.payload);
  assert.equal(failed.status,'failed');assert.equal(service.cursorVersion,0);assert.deepEqual(service.snapshot,{});
  const duplicate=deliver(state,service.id,{id:'should-not-be-created'});assert.equal(duplicate.status,'pending_retry');assert.equal(duplicate.delivery.id,'failed-event');assert.equal(state.subscriptionDeliveries.length,1);
  const retry=retrySubscriptionDelivery(state,'failed-event',{now:'2026-10-29T02:00:00Z'});assert.equal(retry.status,'success');assert.equal(retry.delivery.id,'failed-event');assert.equal(JSON.stringify(retry.delivery.payload),originalPayload);assert.equal(retry.delivery.attempts.length,2);assert.equal(service.cursorVersion,1);
  assert.throws(()=>retrySubscriptionDelivery(state,'failed-event'),/仅失败/);assert.equal(deliver(state).status,'unchanged');
});

test('retry advances to the original failed snapshot so later source changes remain deliverable',()=>{
  const {state,service}=ready();const failed=deliver(state,service.id,{id:'baseline-failure',fail:true});const original=state.records[0].enterpriseName;
  state.records[0].enterpriseName='失败之后又变化';retrySubscriptionDelivery(state,failed.delivery.id);
  assert.notEqual(state.records[0].enterpriseName,original);const result=deliver(state);assert.equal(result.delivery.mode,'incremental');assert.equal(result.delivery.changeCount,1);assert.equal(result.delivery.payload.changes[0].record.enterpriseName,'失败之后又变化');
});

test('old failures cannot overwrite a later successful cursor or a new configuration baseline',()=>{
  const {state,service}=ready();deliver(state);state.records[0].enterpriseName='变化 A';const failed=deliver(state,service.id,{id:'failure-a',fail:true});
  state.records[0].enterpriseName='变化 B';deliver(state,service.id,{id:'success-b'});const cursor=service.cursorVersion;assert.throws(()=>retrySubscriptionDelivery(state,failed.delivery.id),/后续成功/);assert.equal(service.cursorVersion,cursor);
  saveSubscription(state,service.id,config({name:'修改后的配置'}));assert.equal(service.status,'draft');assert.equal(service.cursorVersion,0);publishSubscription(state,service.id);
  assert.throws(()=>retrySubscriptionDelivery(state,failed.delivery.id),/配置已修改/);assert.equal(deliver(state,service.id,{id:'new-baseline'}).delivery.mode,'baseline');
});

test('full mode returns all current matching enterprises after change and can explicitly deliver an empty full set',()=>{
  const {state,service}=ready();saveSubscription(state,service.id,config({mode:'full'}));publishSubscription(state,service.id);deliver(state);
  state.records[0].enterpriseName='全量更新';const result=deliver(state);assert.equal(result.delivery.mode,'full');assert.equal(result.delivery.changeCount,state.records.length);assert.equal(deliver(state).status,'unchanged');
  state.records=[];const empty=deliver(state);assert.equal(empty.status,'success');assert.equal(empty.delivery.matchedCount,0);assert.deepEqual(empty.delivery.payload.changes,[]);assert.equal(deliver(state).status,'unchanged');
});

test('an empty first match does not generate a baseline and new later matches remain first-baseline data',()=>{
  const {state,service}=ready();const records=state.records;state.records=[];
  assert.equal(deliver(state).status,'empty');assert.equal(state.subscriptionDeliveries.length,0);assert.equal(service.cursorVersion,0);
  state.records=records;assert.equal(deliver(state).delivery.mode,'baseline');
});

test('record, payload and duplicate identity bounds fail without advancing the cursor',()=>{
  const {state,service}=ready(),record=state.records[0];
  state.records=Array.from({length:101},(_,index)=>({...record,creditCode:`CODE_${index}`,id:`id_${index}`}));assert.throws(()=>deliver(state),/最多匹配/);assert.equal(service.cursorVersion,0);
  state.records=[{...record,businessScope:'业务'.repeat(100000)}];assert.throws(()=>deliver(state),/64 KiB/);assert.equal(state.subscriptionDeliveries.length,0);
  state.records=[record,{...record}];assert.throws(()=>deliver(state),/标识缺失或重复/);assert.equal(service.cursorVersion,0);
});

test('retained deliveries are bounded while service snapshots keep the latest successful cursor',()=>{
  const {state,service}=ready();for(let index=0;index<25;index++){state.records[0].enterpriseName=`企业 ${index}`;deliver(state,service.id,{id:`retained-${index}`});}
  assert.equal(state.subscriptionDeliveries.length,SUBSCRIPTION_LIMITS.deliveries);assert.equal(state.subscriptionDeliveries[0].id,'retained-24');assert.equal(state.subscriptionDeliveries.at(-1).id,'retained-5');assert.equal(service.cursorVersion,25);assert.equal(deliver(state).status,'unchanged');
});

test('configuration, event ID and retry attempt limits are enforced',()=>{
  const state=createInitialState();for(let index=0;index<20;index++)createSubscription(state,config(),{id:`sub-${index}`});assert.throws(()=>createSubscription(state,config()),/最多保留/);
  const {state:retryState,service}=ready();const failed=deliver(retryState,service.id,{id:'retry-limit',fail:true});
  for(let index=1;index<10;index++)retrySubscriptionDelivery(retryState,failed.delivery.id,{fail:true});assert.equal(failed.delivery.attempts.length,10);assert.throws(()=>retrySubscriptionDelivery(retryState,failed.delivery.id),/最多模拟 10/);assert.equal(service.cursorVersion,0);
  assert.throws(()=>simulateSubscriptionDelivery(retryState,'missing'),/不存在/);assert.throws(()=>retrySubscriptionDelivery(retryState,'missing'),/不存在/);
});

test('persisted snapshots survive JSON round trip and safe record keys do not modify prototypes',()=>{
  const {state,service}=ready();state.records=[{...state.records[0],creditCode:'__proto__'}];deliver(state);assert.equal(Object.keys(service.snapshot).length,1);assert.ok(Object.hasOwn(service.snapshot,'__proto__'));
  const loaded=JSON.parse(JSON.stringify(state));upgradeSubscriptions(loaded);assert.equal(deliver(loaded).status,'unchanged');assert.equal({}.signature,undefined);
});

test('rendered subscription catalog escapes user text and explains simulated scheduling and precise matching boundaries',()=>{
  const {state,service}=ready();service.name='<img src=x onerror=alert(1)>';service.webhookUrl='https://example.com/?x="<script>';
  const html=renderSubscriptions(state);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img src=x/);assert.match(html,/不会发送网络请求/);assert.match(html,/国民经济行业/);assert.match(html,/荣誉资质/);assert.match(html,/自动调度/);assert.match(html,/data-action="subscription-create"/);assert.match(html,/data-action="subscription-simulate"/);assert.match(html,/未接入官方/);
});
