import http from 'node:http';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
const root=path.dirname(fileURLToPath(import.meta.url)),publicRoot=path.join(root,'public'),local=path.join(root,'.local');await mkdir(local,{recursive:true});
const file=path.join(local,'state.json');let stored={state:null,revision:0},queue=Promise.resolve();try{stored=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const source=(await readFile(path.join(root,'app/api/vendor/route.ts'),'utf8')).replace('import { env } from "cloudflare:workers";','const env = {};');
const vendor=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
const types={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.mjs':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.json':'application/json;charset=utf-8','.svg':'image/svg+xml','.csv':'text/csv;charset=utf-8','.png':'image/png'};
async function body(req,max=5*1024*1024+65536){let bytes=0,parts=[];for await(const p of req){bytes+=p.length;if(bytes>max)throw new Error('请求内容超过大小限制');parts.push(p);}return Buffer.concat(parts);}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');if(url.pathname==='/api/state'){
 if(req.method==='GET')return json(res,200,stored);
 if(req.method!=='PUT')return json(res,405,{message:'方法不支持'});
 const input=JSON.parse((await body(req)).toString());const operation=queue.then(async()=>{if(!Number.isSafeInteger(input.baseRevision)||!input.state||typeof input.state!=='object')return json(res,400,{message:'状态或版本参数不正确'});if(input.baseRevision!==stored.revision)return json(res,409,{...stored,error:'REVISION_CONFLICT',message:'状态已被其他窗口更新，请重试'});if(Buffer.byteLength(JSON.stringify(input.state))>5*1024*1024)return json(res,413,{message:'状态超过5MB限制'});const next={state:input.state,revision:stored.revision+1,updatedAt:new Date().toISOString()};await writeFile(file+'.tmp',JSON.stringify(next),'utf8');await rename(file+'.tmp',file);stored=next;return json(res,200,next);});queue=operation.catch(()=>{});return await operation;
 }
 if(url.pathname==='/api/vendor'){const headers=new Headers({'content-type':'application/json'});const request=new Request(url,{method:req.method,headers,...(req.method==='POST'?{body:await body(req,8192)}:{})});const result=req.method==='GET'?await vendor.GET():await vendor.POST(request);res.writeHead(result.status,Object.fromEntries(result.headers));return res.end(await result.text());}
 if(url.pathname==='/'){res.writeHead(302,{Location:'/prototype/index.html'});return res.end();}
 let requested=path.resolve(publicRoot,'.'+decodeURIComponent(url.pathname));if(requested!==publicRoot&&!requested.startsWith(publicRoot+path.sep))return json(res,403,{message:'禁止访问'});try{const bytes=await readFile(requested);res.writeHead(200,{'Content-Type':types[path.extname(requested)]||'application/octet-stream','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:bytes);}catch(e){if(e.code==='ENOENT')return json(res,404,{message:'文件不存在'});throw e;}
 }catch(e){json(res,400,{message:e.message});}});
server.listen(4317,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4317/prototype/index.html'));
