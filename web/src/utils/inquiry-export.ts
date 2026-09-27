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

function statusText(row: Inquiry) {
  if (row.status === "archived" && row.supplierQuantity === 0 && row.archivedByRole === "purchasing") return "无货归档";
  if (row.status === "archived" && ["assistant", "assistant-1", "assistant-2"].includes(row.archivedByRole ?? "")) return "已完成";
  return row.statusText;
}

function exportValues(row: Inquiry): CellValue[] {
  return [
    String(row.model ?? ""), row.approvedQuantity, row.supplierQuantity,
    String(row.shippingWarehouse ?? ""), String(row.purchaseNote ?? ""), String(row.department ?? ""),
    String(row.store ?? ""), String(row.operator ?? ""), String(row.fnsku ?? ""),
    displayTime(row.createdAt), statusText(row),
  ];
}

export function buildInquiryWorkbook(inquiries: readonly Inquiry[]) {
  const rows: readonly (readonly CellValue[])[] = [HEADERS, ...inquiries.map(exportValues)];
  const sheetData = rows.map((values, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = values.map((value, columnIndex) => cellXml(`${columnName(columnIndex)}${rowNumber}`, value)).join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="询库" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`),
  };
  return { bytes: zipSync(files), contentType: CONTENT_TYPE };
}
