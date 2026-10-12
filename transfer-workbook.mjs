import zlib from 'node:zlib';
import template from './upgrade-workbook-template.json' with {type:'json'};

// 原模板的样式与表头；不保存示例、单号或记录版本。
export const RELOCATION_UPDATE_HEADERS=['型号','来源','发货计划号','发货时间','版本号','已贴FNSKU','初始调拨数量','FBA剩余库存','调拨店铺','状况','RMA','移仓地址','订单号','承运商','运单号','移仓-已发货数量','升级中数量','升级完数量','升级完，版本号'];
export const TRANSFER_STAGES={rma:'RMA',count:'实际清点数量',progress:'升级进度'};
export const TRANSFER_EDITABLE={rma:['rma'],count:['countedQuantity'],progress:['inProgressQuantity','completedQuantity','completedVersion']};
const xml=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll('\r','&#13;');
const col=i=>String.fromCharCode(65+i);

export function transferUpdateValues(record,fields){
  return fields.map(([key])=>['returnQuantity','countedQuantity','inProgressQuantity','completedQuantity'].includes(key)&&record.data[key]!==''?Number(record.data[key]):record.data[key]);
}
export function transferUpdateWorkbook(records,fields,crc32){
  return upgradeWorkbook('转仓升级',records.map(r=>transferUpdateValues(r,fields)),crc32);
}

export function upgradeWorkbook(sheetName,rows,crc32,waybillExport=false){
  const layout=template.sheets[sheetName];
  const sheetRows=rows.map((values,index)=>{
    const n=layout.startRow+index;
    return '<row r="'+n+'"'+layout.rowAttributes+'>'+layout.cellStyles.map((style,i)=>{
      const value=values[i],ref=col(i)+n;
      return value==null||value===''?'<c r="'+ref+'" s="'+style+'"/>':typeof value==='number'
        ?'<c r="'+ref+'" s="'+style+'" t="n"><v>'+value+'</v></c>'
        :'<c r="'+ref+'" s="'+style+'" t="inlineStr"><is><t xml:space="preserve">'+xml(value)+'</t></is></c>';
    }).join('')+'</row>';
  }).join('');
  const sheet=layout.prefix.replace(/<dimension ref="[^"]*"\/>/,'<dimension ref="A1:'+col(layout.cellStyles.length-1)+(layout.startRow+rows.length-1)+'"/>')
    +'<sheetData>'+layout.header+sheetRows+'</sheetData>'+layout.suffix;
  const entries=[
    ['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="'+sheetName+'" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="theme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>'],
    ['xl/styles.xml',template.styles],['xl/theme/theme1.xml',template.theme],['xl/worksheets/sheet1.xml',sheet],
  ];
  if(waybillExport){
    entries[0][1]=entries[0][1].replace('</Types>','<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>');
    entries[1][1]=entries[1][1].replace('</Relationships>','<Relationship Id="purpose" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>');
    entries.push(['docProps/custom.xml','<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="AsterWorkbookPurpose"><vt:lpwstr>relocation-waybills-view-only</vt:lpwstr></property></Properties>']);
  }
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
