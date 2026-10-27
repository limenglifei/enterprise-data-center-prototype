import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../public/prototype/core.mjs';
import {getApiCallHistory,renderApiCallHistory,renderApiServices,upgradeApiServices} from '../public/prototype/api-services.mjs';

const NOW=Date.parse('2026-10-27T10:00:00Z');
const DAY=24*60*60*1000;
const at=offset=>new Date(NOW+offset).toISOString();
const log=(id,serviceId,createdAt,changes={})=>({id,serviceId,serviceName:'调用时接口名称',version:'1.0.0',createdAt,httpStatus:200,code:'SUCCESS',resultCount:1,mode:'browser_debug',...changes});
const ready=logs=>{
  const state=createInitialState();
  upgradeApiServices(state);
  state.apiCallLogs=logs;
  return state;
};
const ids=entries=>entries.map(entry=>entry.id);

test('call history is isolated by service ID, sorted by time and independent of a later service rename',()=>{
  const state=ready([
    log('search-old','search',at(-DAY-1)),
    log('query-now','query',at(0)),
    log('search-first','search',at(-60000)),
    log('search-last','search',at(-1000)),
  ]);
  state.apiServices.find(service=>service.id==='search').name='后来改名的 API';
  const before=JSON.stringify(state.apiCallLogs);
  const history=getApiCallHistory(state,'search',{now:NOW});
  assert.deepEqual(ids(history.logs),['search-last','search-first','search-old']);
  assert.deepEqual(ids(history.recentLogs),['search-last','search-first']);
  assert.equal(history.logs[0].serviceName,'调用时接口名称');
  assert.equal(JSON.stringify(state.apiCallLogs),before,'rendering history must not reorder persisted logs');
});

test('24-hour statistics include both exact boundaries and executed failures, excluding old, future and invalid times',()=>{
  const state=ready([
    log('before-window','search',at(-DAY-1)),
    log('window-start','search',at(-DAY)),
    log('failure','search',at(-1),{httpStatus:400,code:'INVALID_PARAMETER',resultCount:0}),
    log('window-end','search',at(0)),
    log('future','search',at(1)),
    log('invalid','search','not-a-timestamp'),
    log('missing','search',undefined),
    log('other-api','query',at(-1)),
  ]);
  const history=getApiCallHistory(state,'search',{now:NOW});
  assert.deepEqual(ids(history.recentLogs),['window-end','failure','window-start']);
  assert.equal(history.logs.length,7,'all retained logs for this service remain available as detail');
  assert.ok(history.logs.some(entry=>entry.id==='invalid'));
  assert.ok(history.logs.some(entry=>entry.id==='missing'));
});

test('an API without calls has an empty history and a clickable zero-count entry',()=>{
  const state=ready([log('query-only','query',at(0))]);
  assert.deepEqual(getApiCallHistory(state,'search',{now:NOW}),{logs:[],recentLogs:[]});
  assert.deepEqual(getApiCallHistory(state,'not-an-api',{now:NOW}),{logs:[],recentLogs:[]});
  const html=renderApiServices(state,{now:NOW});
  const entry=html.match(/<button\b(?=[^>]*data-action="api-service-history")(?=[^>]*data-id="search")[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(entry,'zero calls should still open the per-API empty history');
  assert.match(entry[1],/0\s*次/);
  const service=state.apiServices.find(entry=>entry.id==='search');
  const empty=renderApiCallHistory(state,service,{now:NOW});
  assert.match(empty,/近 24 小时暂无调用记录/);
  assert.doesNotMatch(empty,/<table\b/);
  assert.match(renderApiCallHistory(state,service,{now:NOW,range:'all'}),/暂无调用记录/);
});

test('catalog counts use the same fixed 24-hour clock and disclose the retained 100-call scope',()=>{
  const state=ready([
    log('search-now','search',at(0)),
    log('search-boundary','search',at(-DAY)),
    log('search-old','search',at(-DAY-1)),
    log('query-now','query',at(0)),
  ]);
  const html=renderApiServices(state,{now:NOW});
  assert.match(html,/<th[^>]*>最近调用次数/);
  const entry=html.match(/<button\b(?=[^>]*data-action="api-service-history")(?=[^>]*data-id="search")[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(entry);
  assert.match(entry[1],/2\s*次/);
  assert.match(html,/24\s*小时/);
  assert.match(html,/(?:最近|最多)[^<。]*100/,'limited retained records must not be presented as full 24-hour traffic');
});

test('catalog no longer exposes a separate recent-debug-calls section',()=>{
  const html=renderApiServices(ready([log('search-now','search',at(0))]),{now:NOW});
  assert.doesNotMatch(html,/<h[1-6][^>]*>\s*最近调试调用\s*<\/h[1-6]>/);
  assert.match(html,/data-action="api-service-history"/);
});

test('history detail uses the count window by default and can show all retained records for only that API',()=>{
  const state=ready([
    log('search-recent-marker','search',at(-1)),
    log('search-old-marker','search',at(-DAY-1)),
    log('query-secret-marker','query',at(0)),
  ]);
  const service=state.apiServices.find(entry=>entry.id==='search');
  const recent=renderApiCallHistory(state,service,{now:NOW});
  assert.match(recent,/search-recent-marker/);
  assert.doesNotMatch(recent,/search-old-marker|query-secret-marker/);
  assert.match(recent,/data-range="recent" aria-pressed="true"/);
  assert.match(recent,/data-range="all" aria-pressed="false"/);
  const all=renderApiCallHistory(state,service,{now:NOW,range:'all'});
  assert.match(all,/search-recent-marker/);
  assert.match(all,/search-old-marker/);
  assert.doesNotMatch(all,/query-secret-marker/);
  assert.match(all,/data-range="all" aria-pressed="true"/);
  assert.match(all,/不包含真实服务端请求/);
});

test('history detail escapes stored log fields rather than executing markup',()=>{
  const attack='<img src=x onerror="alert(1)">';
  const state=ready([log(attack,'search',at(0),{
    serviceName:attack,version:attack,httpStatus:attack,code:attack,resultCount:attack,mode:attack,
  })]);
  const service={...state.apiServices.find(entry=>entry.id==='search'),path:attack};
  const html=renderApiCallHistory(state,service,{now:NOW});
  assert.doesNotMatch(html,/<img\b/);
  assert.match(html,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});
