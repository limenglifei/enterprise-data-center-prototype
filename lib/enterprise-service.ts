import {env} from 'cloudflare:workers';
import {runApiService,upgradeApiServices,validateApiServiceConfig} from '../public/prototype/api-services.mjs';

type Row={payload:string};
const MAX_BODY=16*1024;
const headers={'Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8'};
const reply=(requestId:string,code:string,message:string,status:number)=>Response.json({requestId,code,message,data:null},{status,headers});

async function bearerMatches(actual:string,expected:string){
  // Hash both values before comparison to avoid comparing secret-dependent string prefixes.
  const encode=new TextEncoder();
  const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',encode.encode(actual)),crypto.subtle.digest('SHA-256',encode.encode(expected))]);
  const first=new Uint8Array(a),second=new Uint8Array(b);let difference=0;
  for(let i=0;i<first.length;i++)difference|=first[i]^second[i];
  return difference===0;
}

export async function handleEnterpriseService(request:Request,id:string){
  const requestId=crypto.randomUUID();
  const runtime=env as Cloudflare.Env & {ENTERPRISE_API_KEY?:string};
  const key=runtime.ENTERPRISE_API_KEY;
  if(!key)return reply(requestId,'SERVICE_NOT_CONFIGURED','对外 API 尚未配置服务端密钥',503);
  const authorization=request.headers.get('authorization')||'';
  const match=authorization.match(/^Bearer ([^\s]+)$/i);
  if(!match||match[1].length>512||!await bearerMatches(match[1],key))return reply(requestId,'UNAUTHORIZED','Bearer API 密钥无效或缺失',401);
  if(!runtime.DB)return reply(requestId,'STORAGE_UNAVAILABLE','统一企业库暂不可用',503);
  let state;
  try{
    const row=await runtime.DB.prepare('SELECT payload FROM prototype_state WHERE id = ?').bind('shared').first<Row>();
    if(!row?.payload||row.payload==='null')return reply(requestId,'STORAGE_UNAVAILABLE','统一企业库尚未初始化',503);
    state=upgradeApiServices(JSON.parse(row.payload));
  }catch{return reply(requestId,'STORAGE_UNAVAILABLE','统一企业库读取失败，请稍后重试',503);}
  const service=state.apiServices.find((entry:{id:string})=>entry.id===id);
  if(!service)return reply(requestId,'API_NOT_FOUND','API 接口不存在',404);
  if(service.status!=='published')return reply(requestId,'API_NOT_PUBLISHED',service.status==='disabled'?'API 已停用':'API 尚未发布',403);
  if(!validateApiServiceConfig(service).valid)return reply(requestId,'SERVICE_CONFIGURATION_INVALID','API 服务配置无效，请检查并重新发布',503);
  if(request.method!==service.method)return Response.json({requestId,code:'METHOD_NOT_ALLOWED',message:`此 API 仅支持 ${service.method}`,data:null},{status:405,headers:{...headers,Allow:service.method}});
  let input:Record<string,unknown>;
  if(service.kind==='query'){
    const parameters=new URL(request.url).searchParams;
    const entries=[...parameters.entries()];
    if(entries.length!==1||entries[0][0]!=='keyword')return reply(requestId,'INVALID_PARAMETER','请仅提供一个 keyword 查询参数',400);
    input={keyword:parameters.get('keyword')};
  }else{
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(requestId,'INVALID_PARAMETER','Content-Type 需为 application/json',400);
    if(Number(request.headers.get('content-length')||0)>MAX_BODY)return reply(requestId,'REQUEST_TOO_LARGE','请求体不能超过 16 KB',413);
    if(!request.body)return reply(requestId,'INVALID_PARAMETER','请求体不能为空',400);
    const reader=request.body.getReader();const chunks:Uint8Array[]=[];let total=0;
    try{
      while(true){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.byteLength;if(total>MAX_BODY){await reader.cancel();return reply(requestId,'REQUEST_TOO_LARGE','请求体不能超过 16 KB',413);}chunks.push(chunk.value);}
      const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      input=JSON.parse(new TextDecoder().decode(bytes));
    }catch{return reply(requestId,'INVALID_PARAMETER','请求体必须是有效的 JSON 对象',400);}finally{reader.releaseLock();}
  }
  try{
    const result=runApiService(state,id,input,{id:requestId,recordLog:false});
    // Queries are read-only: do not overwrite shared configuration or increment its CAS revision.
    return Response.json(result.body,{status:result.httpStatus,headers});
  }catch{return reply(requestId,'STORAGE_UNAVAILABLE','统一企业库读取失败，请稍后重试',503);}
}
