import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
const source=await readFile(new URL('../app/api/vendor/route.ts',import.meta.url),'utf8');
const route=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));

test('removed upstream GET and POST return 410 without reading credentials or making requests',async()=>{
 const original=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;throw new Error('must not request a vendor');};
 try{for(const method of ['GET','POST']){const response=await route[method](new Request('https://example.test/api/vendor',{method}));assert.equal(response.status,410);assert.equal(response.headers.get('Cache-Control'),'no-store');const body=await response.json();assert.equal(body.error,'UPSTREAM_API_REMOVED');assert.match(body.message,/FTP\/FTPS|离线文件本地上传/);}assert.equal(requests,0);assert.doesNotMatch(source,/QCC_APP_KEY|TYC_TOKEN|fetch\(/);}
 finally{globalThis.fetch=original;}
});
