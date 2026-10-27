import {cp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'public','prototype');
const output=path.join(root,'pages-dist');
const digest=createHash('sha256');
async function hashDirectory(directory){
  const entries=await readdir(directory,{withFileTypes:true});
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name,'en'))){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())await hashDirectory(file);
    else{digest.update(path.relative(source,file).replaceAll('\\','/'));digest.update('\0');digest.update(await readFile(file));digest.update('\0');}
  }
}
await hashDirectory(source);
digest.update(await readFile(fileURLToPath(import.meta.url)));
const assetVersion=digest.digest('hex').slice(0,16),assetPath=`assets/${assetVersion}`;
// A fixed generated output keeps recursive removal confined to this project.
if(path.dirname(output)!==root || path.basename(output)!=='pages-dist')throw new Error('Unexpected output directory');
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
await cp(source,output,{recursive:true});
const assetOutput=path.join(output,assetPath);
await mkdir(assetOutput,{recursive:true});
await cp(source,assetOutput,{recursive:true,filter:file=>file!==path.join(source,'index.html')});
let html=await readFile(path.join(source,'index.html'),'utf8');
html=html.replace('<title>企业数据中心 · DataHub</title>','<title>企业数据中心 · 公开演示版</title>')
  .replace('src="./app.js"',`src="./${assetPath}/pages-bootstrap.mjs"`)
  .replace('href="./styles.css"',`href="./${assetPath}/styles.css"`)
  .replace('<main class="main-content">','<main class="main-content"><div class="public-demo-notice" role="note"><strong>公开演示版 · 数据仅保存在当前浏览器</strong><span>真实厂商 API 需服务端部署；配置、企业、脚本及任务使用本机 IndexedDB 保存，不同浏览器之间不共享。请仅导入演示数据。清理站点数据会删除本机工作空间。</span></div>')
  .replace('</head>','<style>.public-demo-notice{display:flex;flex-direction:column;gap:6px;margin-bottom:20px;padding:14px 18px;border:1px solid #f0c36c;border-radius:10px;background:#fff8e7;color:#684612;font-size:13px;line-height:1.7}.public-demo-notice strong{font-size:14px}.public-demo-notice span{display:block}</style></head>');
await writeFile(path.join(output,'index.html'),html);
const bootstrap=`import {createPublicDemoTransport} from './pages-adapter.mjs';\nwindow.DATAHUB_TRANSPORT=createPublicDemoTransport();\nawait import('./app.js');\n`;
await writeFile(path.join(output,'pages-bootstrap.mjs'),bootstrap);
await writeFile(path.join(assetOutput,'pages-bootstrap.mjs'),bootstrap);
await writeFile(path.join(output,'.nojekyll'),'');
await writeFile(path.join(output,'BUILD_INFO.json'),JSON.stringify({target:'github-pages',assetVersion,storage:'IndexedDB',serverApi:false,source:'public/prototype',builtAt:new Date().toISOString()},null,2)+'\n');
console.log('GitHub Pages static build: '+output);
