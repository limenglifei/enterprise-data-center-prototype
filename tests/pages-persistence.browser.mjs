import {createPublicDemoTransport} from '../public/prototype/pages-adapter.mjs';

/** Run in a browser module with IndexedDB (or pass a standards-compliant IDB factory).
 * Does not touch the user's workspace. The temporary database is deleted afterward.
 */
export async function verifyPagesPersistence(indexedDB=globalThis.indexedDB) {
  const databaseName='datahub-adapter-test-'+crypto.randomUUID();
  const connections=[];
  const adapter=()=>{const a=createPublicDemoTransport({indexedDB,databaseName,fetcher:async()=>Response.json([{fixture:true}])});connections.push(a);return a;};
  const assert=(v,message)=>{if(!v)throw new Error(message);};
  const put=(a,state,baseRevision)=>a('/api/state',{method:'PUT',body:JSON.stringify({state,baseRevision})});
  try {
    const first=adapter();
    assert((await first('/api/state')).revision===0,'Fresh database must start at revision 0');
    const initial={providers:[{id:'qcc',name:'已保存配置'}],records:[{creditCode:'DEMO-CN-000001'}],tasks:[{id:'test-task'}]};
    assert((await put(first,initial,0)).revision===1,'First save must commit revision 1');
    await first.close();
    const reopened=adapter();
    const restored=await reopened('/api/state');
    assert(JSON.stringify(restored.state)===JSON.stringify(initial),'Close and reopen must restore configuration, enterprise and task data');
    const other=adapter();
    const writers=await Promise.allSettled([put(reopened,{...initial,writer:'A'},1),put(other,{...initial,writer:'B'},1)]);
    assert(writers.filter(r=>r.status==='fulfilled').length===1,'Exactly one competing writer must commit');
    const rejected=writers.find(r=>r.status==='rejected');
    assert(rejected?.reason.status===409 && rejected.reason.data.revision===2,'Stale writer must receive latest revision with 409');
    let denied=false;try{await reopened('/api/vendor',{method:'POST',body:'{}'});}catch(e){denied=e.status===503 && e.data.error==='SERVER_NOT_DEPLOYED';}
    assert(denied,'Public demo must reject real vendor calls');
    assert((await reopened('./fixtures/qcc-v1.json'))[0].fixture,'Snapshots must use the supplied real fetch transport');
    return {passed:true,checks:6,storage:'IndexedDB',conflictRevision:2};
  } finally {
    await Promise.all(connections.map(a=>a.close()));
    await new Promise((resolve,reject)=>{const req=indexedDB.deleteDatabase(databaseName);req.onsuccess=resolve;req.onerror=()=>reject(req.error);});
  }
}
