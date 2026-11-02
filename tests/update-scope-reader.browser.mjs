import {readTableFile} from '../public/prototype/file-reader.mjs';
import {parseScopeRows} from '../public/prototype/update-scope.mjs';

/** Browser contract test: uses real DOMParser and the valid XLSX fixture with missing worksheet row 3. */
export async function runUpdateScopeXlsxReaderTests(fixtureBytes){
  let bytes=fixtureBytes;
  if(!bytes){const response=await fetch(new URL('./fixtures/update-scope-gap-rows.xlsx',import.meta.url));if(!response.ok)throw new Error('无法读取 XLSX 测试夹具');bytes=await response.arrayBuffer();}
  const file=new File([bytes],'企业名单.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const rows=await readTableFile(file,{preserveBlankRows:true,includeRowNumbers:true});
  if(JSON.stringify(rows.map(row=>row.__sourceRowNumber))!=='[2,3,4]')throw new Error('XLSX 来源行号或空白行不正确');
  if(rows.length!==3||Object.keys(rows[0]).join(',')!=='信用代码,企业全称')throw new Error('XLSX 名单字段被元数据污染');
  const preview=parseScopeRows({records:[]},rows).preview;
  if(preview.blankRows!==1||preview.errors.length!==1||preview.errors[0].row!==4||preview.targets.length!==1)throw new Error('XLSX 名单校验未保留真实错误行号');
  const legacy=await readTableFile(file);
  if(legacy.length!==2||Object.hasOwn(legacy[0],'__sourceRowNumber'))throw new Error('XLSX 默认业务读取行为发生变化');
  return {passed:4,worksheetRows:[2,3,4],blankRows:preview.blankRows,errorRow:preview.errors[0].row,defaultRows:legacy.length};
}
