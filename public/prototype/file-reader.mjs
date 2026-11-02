function parseCSV(text,{preserveBlankRows=false}={}) {
  const rows=[];let row=[],cell='',quoted=false,sourceRow=1,rowStart=1;
  const append=()=>{row.push(cell);if(preserveBlankRows||row.some(value=>value.trim())){Object.defineProperty(row,'__sourceRowNumber',{value:rowStart});rows.push(row);}row=[];cell='';};
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(ch===','&&!quoted){row.push(cell);cell='';}
    else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;append();sourceRow++;rowStart=sourceRow;}
    else{cell+=ch;if(ch==='\n'||ch==='\r'&&text[i+1]!=='\n')sourceRow++;}
  }
  if(quoted)throw new Error('CSV引号未闭合');if(cell||row.length)append();return rows;
}
async function readXlsx(buffer,{preserveBlankRows=false}={}){
  const data=new Uint8Array(buffer),view=new DataView(buffer),files=new Map();let eocd=-1;
  for(let p=data.length-22;p>=Math.max(0,data.length-65557);p--)if(view.getUint32(p,true)===0x06054b50){eocd=p;break;}
  if(eocd<0)throw new Error('无法读取xlsx压缩目录');let p=view.getUint32(eocd+16,true);const count=view.getUint16(eocd+10,true),decode=new TextDecoder();
  for(let i=0;i<count;i++){if(view.getUint32(p,true)!==0x02014b50)throw new Error('xlsx目录损坏');const method=view.getUint16(p+10,true),size=view.getUint32(p+20,true),nameLen=view.getUint16(p+28,true),extra=view.getUint16(p+30,true),comment=view.getUint16(p+32,true),offset=view.getUint32(p+42,true);const name=decode.decode(data.slice(p+46,p+46+nameLen));const start=offset+30+view.getUint16(offset+26,true)+view.getUint16(offset+28,true);files.set(name,{method,data:data.slice(start,start+size)});p+=46+nameLen+extra+comment;}
  async function xml(name){const f=files.get(name);if(!f)return null;let content=f.data;if(f.method===8){try{content=new Uint8Array(await new Response(new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());}catch{throw new Error('当前浏览器无法解压xlsx，请另存为UTF-8 CSV后导入');}}else if(f.method!==0)throw new Error('不支持该xlsx压缩方式');const doc=new DOMParser().parseFromString(decode.decode(content),'text/xml');if(doc.querySelector('parsererror'))throw new Error('xlsx内的XML损坏');return doc;}
  const shared=await xml('xl/sharedStrings.xml');const strings=shared?[...shared.getElementsByTagName('si')].map(si=>[...si.getElementsByTagName('t')].map(t=>t.textContent).join('')):[];
  const workbook=await xml('xl/workbook.xml'),rels=await xml('xl/_rels/workbook.xml.rels');const first=workbook?.getElementsByTagName('sheet')[0];const relId=first?.getAttribute('r:id');const rel=rels?[...rels.getElementsByTagName('Relationship')].find(r=>r.getAttribute('Id')===relId):null;
  let target=rel?.getAttribute('Target')||'worksheets/sheet1.xml';target=target.startsWith('/')?target.slice(1):`xl/${target}`;const sheet=await xml(target);if(!sheet)throw new Error('xlsx中没有可读工作表');
  const rows=[];let previousRow=0;
  for(const r of sheet.getElementsByTagName('row')){
    const rowNumber=Number(r.getAttribute('r'))||previousRow+1;
    if(preserveBlankRows&&rowNumber>50001)throw new Error('单次最多导入5万行');
    if(preserveBlankRows)for(let number=previousRow+1;number<rowNumber;number++){const blank=[];Object.defineProperty(blank,'__sourceRowNumber',{value:number});rows.push(blank);}
    const values=[];for(const c of r.getElementsByTagName('c')){const ref=c.getAttribute('r')||'A1';let col=0;for(const ch of ref.replace(/\d/g,''))col=col*26+ch.charCodeAt(0)-64;const type=c.getAttribute('t'),v=c.getElementsByTagName('v')[0]?.textContent??'';values[col-1]=type==='s'?strings[Number(v)]??'':type==='inlineStr'?[...c.getElementsByTagName('t')].map(t=>t.textContent).join(''):v;}
    Object.defineProperty(values,'__sourceRowNumber',{value:rowNumber});if(preserveBlankRows||values.some(value=>String(value??'').trim()))rows.push(values);previousRow=rowNumber;
    if(rows.length>50001)throw new Error('单次最多导入5万行');
  }
  return rows;
}
export async function readTableFile(file,{preserveBlankRows=false,includeRowNumbers=false}={}){
  if(file.size>20*1024*1024)throw new Error('文件超过20MB限制');let matrix;
  if(/\.csv$/i.test(file.name))matrix=parseCSV((await file.text()).replace(/^\uFEFF/,''),{preserveBlankRows});
  else if(/\.xlsx$/i.test(file.name))matrix=await readXlsx(await file.arrayBuffer(),{preserveBlankRows});
  else throw new Error('请选择xlsx或UTF-8 CSV文件');
  const headerIndex=matrix.findIndex(row=>row.some(value=>String(value??'').trim())),data=matrix.slice(headerIndex+1);
  if(headerIndex<0||!data.some(row=>row.some(value=>String(value??'').trim())))throw new Error('表格没有企业数据行');
  if(data.length>50000)throw new Error('单次最多导入5万行');
  const headers=Array.from(matrix[headerIndex],value=>String(value??'').trim());
  if(headers.includes('字段名')&&headers.includes('类型'))throw new Error('这是字段目录表。企业数据导入需要“一行一家企业”，请下载专题数据模板。');
  if(headers.some(header=>!header)||new Set(headers).size!==headers.length)throw new Error('表头不能为空或重复');
  return data.map((values,index)=>{const sourceRow=values.__sourceRowNumber??headerIndex+index+2;if(values.slice(headers.length).some(value=>String(value??'').trim()))throw new Error(`第 ${sourceRow} 行包含超出表头定义的数据列`);const row=Object.fromEntries(headers.map((header,column)=>[header,values[column]??'']));if(includeRowNumbers)Object.defineProperty(row,'__sourceRowNumber',{value:sourceRow});return row;});
}
export function downloadCSV(filename,headers,rows){const escape=v=>'"'+String(Array.isArray(v)?v.join('；'):v??'').replaceAll('"','""')+'"';const text='\uFEFF'+[headers,...rows].map(row=>row.map(escape).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
