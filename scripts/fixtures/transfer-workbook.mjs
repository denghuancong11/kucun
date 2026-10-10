// Deliberately includes other worksheets and the template's merged rows 2–3.
import { zip } from './generate-synthetic-workbook.mjs';
import { TRANSFER_UPGRADE_FIELDS } from '../../inventory-db.mjs';
const xml=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export const transferSample=['SYNTH-TRANSFER','第三方海外仓','TRANSFER-PLAN','2026-10-10','V01','000012中文',0,'海外仓原值','STOREUS','已在第三方海外仓','','','','',''];
export function transferWorkbook(rows=[transferSample,transferSample],sheetName='转仓升级') {
 const headers=TRANSFER_UPGRADE_FIELDS.map(([,label])=>label),row=(values,n)=>`<row r="${n}">${values.map((v,i)=>v===null?'':`<c r="${String.fromCharCode(65+i)}${n}" ${typeof v==='number'?'':'t="inlineStr"'}>${typeof v==='number'?`<v>${v}</v>`:`<is><t xml:space="preserve">${xml(v)}</t></is>`}</c>`).join('')}</row>`;
 const sheet=`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${row(headers,2)}${rows.map((v,i)=>row(v,i+4)).join('')}</sheetData><mergeCells count="15">${headers.map((_,i)=>`<mergeCell ref="${String.fromCharCode(65+i)}2:${String.fromCharCode(65+i)}3"/>`).join('')}</mergeCells></worksheet>`;
 return zip([
 ['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+[1,2,3].map(i=>`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')+'</Types>'],
 ['_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
 ['xl/workbook.xml',`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${['移仓升级',sheetName,'Sheet3'].map((name,i)=>`<sheet name="${xml(name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`],
 ['xl/_rels/workbook.xml.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[1,2,3].map(i=>`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('')}</Relationships>`],
 ['xl/worksheets/sheet1.xml',sheet.replaceAll('SYNTH-TRANSFER','DO-NOT-IMPORT')],['xl/worksheets/sheet2.xml',sheet],['xl/worksheets/sheet3.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>']]);
}
