import {readFile,writeFile} from 'node:fs/promises';
const file=new URL('../public/prototype/app.js',import.meta.url);let code=await readFile(file,'utf8');
const marker='<div class="form-field full"><label class="checkbox-label"><input type="checkbox" name="enabled" ${p.enabled?';
const replacement='<div class="form-field full"><label>纳管企业清单（真实模式使用）</label><textarea name="managedKeywords" rows="4" placeholder="每行一个企业全称或统一社会信用代码">${esc(p.managedKeywords||\'\')}</textarea><small>全量逐家刷新清单；增量可填写新增或待刷新企业。本原型不假定厂商提供全国企业目录。</small></div>'+marker;
if(!code.includes('纳管企业清单（真实模式使用）')){if(!code.includes(marker))throw new Error('connection marker absent');code=code.replace(marker,replacement);}
code=code.replaceAll('buildRunner(rows,state.mappings[id])','buildRunner(rows,state.mappings[id],id)').replaceAll('buildRunner(rows,state.mappings.file)','buildRunner(rows,state.mappings.file,\'file\')').replaceAll('buildRunner(rows,state.mappings[due.id])','buildRunner(rows,state.mappings[due.id],due.id)');
code=code.replace("if(p.connectionMode==='live'){const keys=", "if(p.connectionMode==='live'){const keys=");
code=code.replace("windowStart:mode==='incremental'?start:undefined", "windowStart:mode==='incremental'&&p.connectionMode!=='live'?start:undefined");
if(!code.includes('function associateLabels(')){
 code=code.replace('function heading(){',`function associateLabels(){document.querySelectorAll('.form-field').forEach((field,i)=>{const l=field.querySelector('label'),control=field.querySelector('input,select,textarea,output');if(l&&control&&!l.contains(control)){control.id ||= 'control-'+(control.name||i)+'-'+i;l.htmlFor=control.id;}});}\nfunction heading(){`);
 code=code.replace("$('#page-content').innerHTML=(renders[page]||renderOverview)();}","$('#page-content').innerHTML=(renders[page]||renderOverview)();associateLabels();}");
 code=code.replace("</section></div>`;}\nfunction closeModal()", "</section></div>`;associateLabels();}\nfunction closeModal()");
}
await writeFile(file,code);
const ignore=new URL('../.gitignore',import.meta.url);let content=await readFile(ignore,'utf8');for(const line of ['.local/','qa/','outputs/','*.tsbuildinfo'])if(!content.split(/\r?\n/).includes(line))content+='\n'+line;await writeFile(ignore,content+'\n');
console.log('UI refinements and output exclusions saved');
