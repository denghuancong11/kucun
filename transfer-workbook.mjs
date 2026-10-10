import zlib from 'node:zlib';
// 转仓导出与更新使用同一业务列；扣回批次在确认页面指定。
export const TRANSFER_STAGES={rma:'RMA',count:'实际清点数量',progress:'升级进度'};
export const TRANSFER_EDITABLE={rma:['rma'],count:['countedQuantity'],progress:['inProgressQuantity','completedQuantity','completedVersion']};
const xml=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll('\r','&#13;');
const col=i=>String.fromCharCode(65+i);
export function transferUpdateValues(record,fields){return [record.documentNo,...fields.map(([key])=>['returnQuantity','countedQuantity','inProgressQuantity','completedQuantity'].includes(key)&&record.data[key]!==''?Number(record.data[key]):record.data[key]),String(record.revision)];}
export function transferUpdateWorkbook(records,stage,fields,crc32){
 const headers=['转仓单号',...fields.map(([,label])=>label),'记录版本'];
 const editable=(stage ? TRANSFER_EDITABLE[stage] : Object.values(TRANSFER_EDITABLE).flat()).map(key=>1+fields.findIndex(([k])=>k===key));
 const sheets=[{name:'转仓升级',headers,editable,note:'按转仓单号定位；单号、记录版本及非本次办理阶段字段只读。未修改行不办理。数量单位：销售套数。减少累计完成量时，在导入确认页指定原入库批次；新增入库至Aster海外仓，套/箱补齐前不能调拨。',rows:records.map(r=>transferUpdateValues(r,fields))}];
 const sheetXml=sheet=>{
   const row=(values,n)=>'<row r="'+n+'" ht="32" customHeight="1">'+values.map((v,i)=>{
     const style=n===2?1:n>=4&&sheet.editable.includes(i)?2:0,ref=col(i)+n;
     return v==null||v===''?'<c r="'+ref+'" s="'+style+'"/>':typeof v==='number'?'<c r="'+ref+'" s="'+style+'"><v>'+v+'</v></c>':'<c r="'+ref+'" s="'+style+'" t="inlineStr"><is><t xml:space="preserve">'+xml(v)+'</t></is></c>';
   }).join('')+'</row>';
   return '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" state="frozen"/></sheetView></sheetViews><cols>'+sheet.headers.map((_,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+(sheet.name==='扣回明细'&&i===1?35:24)+'" customWidth="1"/>').join('')+'</cols><sheetData>'+row([sheet.note],1)+row(sheet.headers,2)+sheet.rows.map((r,i)=>row(r,i+4)).join('')+'</sheetData><sheetProtection sheet="1" selectLockedCells="0" selectUnlockedCells="0" deleteRows="0"/><mergeCells>'+sheet.headers.map((_,i)=>'<mergeCell ref="'+col(i)+'2:'+col(i)+'3"/>').join('')+'<mergeCell ref="A1:'+col(sheet.headers.length-1)+'1"/></mergeCells></worksheet>';
 };
 const entries=[
 ['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+sheets.map((_,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')+'</Types>'],
 ['_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
 ['xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+sheets.map((x,i)=>'<sheet name="'+x.name+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets></workbook>'],
 ['xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+sheets.map((_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+'<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
 ['xl/styles.xml','<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7F1FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf fontId="0" fillId="2" borderId="0" xfId="0" applyProtection="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/><protection locked="0"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
 ...sheets.map((x,i)=>['xl/worksheets/sheet'+(i+1)+'.xml',sheetXml(x)])];
  const locals = [], directory = []; let offset = 0;
  for (const [file, text] of entries) {
    const name = Buffer.from(file), source = Buffer.from(text), compressed = zlib.deflateRawSync(source), crc = crc32(source);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(source.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    locals.push(local, compressed); directory.push(central); offset += local.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
