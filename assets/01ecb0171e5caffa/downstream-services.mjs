import {renderApiServices} from './api-services.mjs';
import {renderSubscriptions} from './subscription-services.mjs';

export const DOWNSTREAM_MODES = [
  {id:'subscription',name:'批量订阅推送',description:'按行业、地区与荣誉资质订阅企业变化'},
  {id:'api',name:'标准 API 服务',description:'封装企业筛选与精准查询接口'},
];

export function renderDownstreamServices(state,mode='subscription') {
  const current=DOWNSTREAM_MODES.some(item=>item.id===mode)?mode:'subscription';
  const tabs=`<div class="tabs access-tabs downstream-tabs" role="tablist" aria-label="下游服务类型">${DOWNSTREAM_MODES.map(item=>`<button class="tab ${current===item.id?'active':''}" role="tab" aria-selected="${current===item.id}" data-action="downstream-mode" data-mode="${item.id}">${item.name}</button>`).join('')}</div>`;
  const content=current==='subscription'?renderSubscriptions(state):renderApiServices(state);
  return tabs+`<div class="downstream-panel" role="tabpanel" aria-label="${DOWNSTREAM_MODES.find(item=>item.id===current).name}">${content}</div>`;
}

export function downstreamCounts(state) {
  return {
    api:(state.apiServices||[]).filter(item=>item.status==='published').length,
    subscription:(state.subscriptions||[]).filter(item=>item.status==='published').length,
  };
}
