import {createInitialState as createProductState,applyBatch,FIELD_DEFS} from '../../public/prototype/core.mjs';
import {DEMO_SNAPSHOTS} from '../../public/prototype/demo-data.mjs';

// Transport-independent fusion tests retain the two historical field schemas as
// offline file fixtures. These are not executable upstream API connectors.
export function createInitialState({seed=true}={}) {
  const state=createProductState({seed:false});
  state.providers=[
    {id:'qcc',name:'厂商甲离线文件测试夹具',type:'file',enabled:true},
    {id:'tyc',name:'厂商乙离线文件测试夹具',type:'file',enabled:true},
    state.providers.find(p=>p.id==='file'),
  ];
  delete state.mappings.ftp_demo;
  state.priorities=Object.fromEntries(FIELD_DEFS.map(f=>[f.key,f.group==='专题补充'?['file','qcc','tyc']:['qcc','tyc','file']]));
  state.schedules={qcc:{enabled:true,mode:'incremental',frequency:'daily',time:'02:00',lastCursor:null},tyc:{enabled:false,mode:'incremental',frequency:'weekly',time:'03:00',lastCursor:null},file:state.schedules.file};
  if(seed) for(const sourceId of ['qcc','tyc','file'])applyBatch(state,{sourceId,rows:structuredClone(DEMO_SNAPSHOTS[sourceId].v1),mode:'full',now:'2026-10-27T09:00:00+08:00'});
  return state;
}
