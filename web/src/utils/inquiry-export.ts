import { strToU8, zipSync } from "fflate";
import type { Inquiry } from "../types";
import { displayTime } from "../components/ui";

const HEADERS = [
  "型号", "商务部审核数量", "供应商库存回复", "发货仓库", "采购备注",
  "调拨部门", "调拨店铺", "调拨运营", "已贴FNSKU", "提交时间", "状况",
] as const;
const CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type CellValue = string | number | null;

function xmlText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");
}

function columnName(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function cellXml(address: string, value: CellValue) {
  if (value === null) return `<c r="${address}"/>`;
  if (typeof value === "number") return `<c r="${address}" t="n"><v>${value}</v></c>`;
  return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function exportValues(row: Inquiry): CellValue[] {
  return [
    String(row.model ?? ""), row.approvedQuantity, row.supplierQuantity,
    String(row.shippingWarehouse ?? ""), String(row.purchaseNote ?? ""), String(row.department ?? ""),
    String(row.store ?? ""), String(row.operator ?? ""), String(row.fnsku ?? ""),
    displayTime(row.createdAt), row.statusText,
  ];
}

export function buildInquiryWorkbook(inquiries: readonly Inquiry[]) {
  const rows: readonly (readonly CellValue[])[] = [HEADERS, ...inquiries.map(exportValues)];
  return buildFlatWorkbook(rows, "询库");
}

export function buildFlatWorkbook(rows: readonly (readonly CellValue[])[], sheetName: string) {
  const sheetData = rows.map((values, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = values.map((value, columnIndex) => cellXml(`${columnName(columnIndex)}${rowNumber}`, value).replace('<c ' , `<c s="${rowIndex===0?1:2}" `)).join("");
    const height=rowIndex===0?36:Math.max(30,...values.map(v=>Math.min(120,(String(v??" ").split("\n").length+1)*18)));
    return `<row r="${rowNumber}" ht="${height}" customHeight="1">${cells}</row>`;
  }).join("");
  const cols=(rows[0]||[]).map((label,index)=>`<col min="${index+1}" max="${index+1}" width="${String(label).includes("地址")?52:String(label).includes("ID")?42:Math.max(16,String(label).length*2+2)}" customWidth="1"/>`).join("");
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF244565"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" fillId="2" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${sheetData}</sheetData><autoFilter ref="A1:${columnName((rows[0]?.length||1)-1)}${rows.length}"/></worksheet>`),
  };
  return { bytes: zipSync(files), contentType: CONTENT_TYPE };
}
