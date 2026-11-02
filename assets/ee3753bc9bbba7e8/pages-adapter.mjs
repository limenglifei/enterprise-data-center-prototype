/** Dedicated GitHub Pages persistence. The full deployment keeps its D1 transport. */
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const EMPTY = {state:null,revision:0};

function apiError(status, data) {
  const error = new Error(data.message || '公开演示工作空间请求失败');
  error.status = status;
  error.data = data;
  return error;
}

export function createPublicDemoTransport({
  indexedDB = globalThis.indexedDB,
  databaseName = 'datahub-public-demo:' + new URL('.', globalThis.location?.href || 'https://localhost/').pathname,
  fetcher = (...args) => globalThis.fetch(...args),
} = {}) {
  let connection;
  function open() {
    if (connection) return connection;
    connection = new Promise((resolve,reject) => {
      if (!indexedDB) return reject(apiError(503,{error:'BROWSER_STORAGE_UNAVAILABLE',message:'当前浏览器无法使用 IndexedDB，无法保存公开演示数据。请允许站点存储后重新加载。'}));
      const request = indexedDB.open(databaseName,1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspace');
      request.onerror = () => reject(apiError(503,{error:'BROWSER_STORAGE_UNAVAILABLE',message:'浏览器数据库无法打开，请检查站点存储权限。'}));
      request.onblocked = () => reject(apiError(503,{error:'BROWSER_STORAGE_BLOCKED',message:'浏览器数据库被旧窗口阻塞，请关闭旧窗口后重试。'}));
      request.onsuccess = () => {
        const db=request.result;
        db.onversionchange=()=>{db.close();connection=undefined;};
        resolve(db);
      };
    });
    return connection;
  }
  async function access(input) {
    const db=await open();
    return new Promise((resolve,reject) => {
      // Reading and comparing the revision inside one readwrite transaction makes
      // concurrent writers (including separate tabs) serialize against each other.
      const tx=db.transaction('workspace',input?'readwrite':'readonly');
      const store=tx.objectStore('workspace');
      const read=store.get('shared');
      let result, conflict;
      read.onsuccess=()=>{
        const current=read.result || EMPTY;
        if (!input) {result=current;return;}
        if (input.baseRevision!==current.revision) {
          conflict=apiError(409,{...current,error:'REVISION_CONFLICT',message:'数据已被同一浏览器的另一窗口更新，请加载最新内容后重试。'});
          return;
        }
        result={state:input.state,revision:current.revision+1,updatedAt:new Date().toISOString()};
        store.put(result,'shared');
      };
      tx.oncomplete=()=>conflict?reject(conflict):resolve(result);
      tx.onabort=tx.onerror=()=>reject(apiError(503,{error:'BROWSER_STORAGE_FAILED',message:'浏览器数据库保存失败，请检查存储空间和站点权限。'}));
    });
  }
  async function request(url,options={}) {
    const pathname=new URL(url,globalThis.location?.href || 'https://localhost/').pathname;
    const method=(options.method || 'GET').toUpperCase();
    if (pathname==='/api/vendor') {
      if(method==='GET')return {qcc:{configured:false},tyc:{configured:false},publicDemo:true};
      throw apiError(503,{error:'SERVER_NOT_DEPLOYED',message:'公开演示版未部署真实厂商 API 服务端。请部署完整后端并配置企查查或天眼查凭证后使用；本次未调用厂商接口。'});
    }
    if(pathname==='/api/state') {
      if(method==='GET')return access();
      if(method!=='PUT')throw apiError(405,{message:'公开演示状态仅支持 GET 和 PUT。'});
      let input;
      try{input=JSON.parse(options.body);}catch{throw apiError(400,{message:'状态内容必须是有效 JSON。'});}
      if(!input || !Number.isSafeInteger(input.baseRevision) || input.baseRevision<0)throw apiError(400,{message:'baseRevision 必须是非负整数。'});
      if(!input.state || typeof input.state!=='object' || Array.isArray(input.state))throw apiError(400,{message:'state 必须是原型状态对象。'});
      if(new TextEncoder().encode(JSON.stringify(input.state)).byteLength>MAX_STATE_BYTES)throw apiError(413,{message:'单份原型状态不能超过 5 MB。'});
      return access(input);
    }
    // Demo snapshots and assets still use real HTTP fetches, never invented responses.
    const response=await fetcher(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
    const data=await response.json().catch(()=>({message:'响应内容无法读取'}));
    if(!response.ok)throw apiError(response.status,data);
    return data;
  }
  request.close=async()=>{if(connection){(await connection).close();connection=undefined;}};
  return request;
}
