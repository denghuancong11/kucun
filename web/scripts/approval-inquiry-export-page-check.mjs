/* 审批中心询库 Excel 导出验收：真实页面、隔离 SQLite、随机端口与实际下载文件。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { strFromU8, unzipSync } from "fflate";
import { createInventoryDatabase, InventoryDatabase, INVENTORY_DATABASE_NAME } from "../../inventory-db.mjs";
import { createTestInstanceId, freePort, waitForOwnedServer } from "../../scripts/test-server-ownership.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aster-inquiry-export-"));
const roles = ["admin", "assistant-1", "assistant-2", "business", "operation-1", "operation-2", "purchasing"];
const headers = ["型号", "商务部审核数量", "供应商库存回复", "发货仓库", "采购备注", "调拨部门", "调拨店铺", "调拨运营", "已贴FNSKU", "提交时间", "状况"];
let server;
let browser;
let base;
let passed = 0;
let page;
let approvalMode = "live";
let holdRelease;
let heldRequests = 0;
let downloadCount = 0;
const pageErrors = [];
const replyPosts = [];
const requestId = prefix => `${prefix}-${randomUUID()}`;
const check = (name, condition = true) => { assert.ok(condition, name); passed += 1; console.log(`PASS ${name}`); };

async function callApi(method, route, role, body, status = 200) {
  const response = await fetch(base + route, {
    method,
    headers: { "x-role": role, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(result)}`);
  return result;
}

function createInquiry(db, { model, department, quantity, operator, fnsku, store = "AUS" }) {
  return db.createInquiry({
    role: "admin", model, quantity, department, store, operator, fnsku,
    asin: `BEXP${String(randomUUID().replaceAll("-", "").slice(0, 6)).toUpperCase()}`,
    operatorNote: "仅测试来源，未写入导出列", requestId: requestId("export-seed"),
  }).record;
}

function approveInquiry(db, row, approvedQuantity) {
  return db.reviewInquiry({
    id: row.id, role: "business", decision: "approve", approvedQuantity, businessNote: "验收审批",
    expectedRevision: row.revision, requestId: requestId("export-review"),
  }).record;
}

function replyInquiry(db, row, supplierQuantity, shippingWarehouse, purchaseNote) {
  return db.replyInquiry({
    id: row.id, role: "purchasing", supplierQuantity, shippingWarehouse, purchaseNote,
    expectedRevision: row.revision, requestId: requestId("export-reply"),
  }).record;
}

function currentApprovalCutoff() {
  const now = new Date();
  const boundary = new Date(now);
  boundary.setUTCHours(13, 0, 0, 0);
  while (boundary.toISOString() > now.toISOString() || ![2, 4].includes(boundary.getUTCDay())) boundary.setUTCDate(boundary.getUTCDate() - 1);
  return boundary.toISOString();
}

function seedDatabase() {
  const db = new InventoryDatabase(stateRoot);
  const records = {};
  let sequence = 0;
  const make = (key, model, department, quantity) => createInquiry(db, {
    model, department, quantity, operator: `运营_${key}`, fnsku: `FNSKU_${String(++sequence).padStart(4, "0")}`,
  });

  records.unreviewed = make("未审核", "SYNTH-TONER-001", "一团", 17);
  records.latest = approveInquiry(db, make("跨客户端最新", "SYNTH-TONER-001", "一团", 150), 90);
  records.draft = approveInquiry(db, make("采购草稿", "SYNTH-INK-001", "一团", 120), 70);
  records.historical = replyInquiry(db,
    approveInquiry(db, make("历史数量差异", "SYNTH-INK-001", "二团", 150), 90),
    60, "CA", "事件记录里的旧采购备注");
  const historicalNote = '=HYPERLINK("https://example.invalid","备注")\r\n第二行：中文与前导零 00089<&>';
  db.db.prepare(`UPDATE inquiry_documents SET requested_quantity = 150, approved_quantity = 90,
    supplier_quantity = 60, shipping_warehouse = ?, purchase_note = ?, store_name = ?, fnsku = ? WHERE id = ?`)
    .run("旧仓库（历史值）", historicalNote, "0012-中文店铺", "0000123456789", records.historical.id);
  records.historical = db.getInquiry(records.historical.id);

  records.noStock = replyInquiry(db,
    approveInquiry(db, make("采购无货", "SYNTH-INK-001", "二团", 20), 15), 0, "", "无货回复备注");
  const assistantReplied = replyInquiry(db, approveInquiry(db, make("助理完成", "SYNTH-TONER-001", "一团", 12), 8), 5, "SC", "助理归档备注");
  records.assistantComplete = db.archiveInquiry({
    id: assistantReplied.id,
    role: "assistant-1", plan: "EXPORT-ARCHIVE", date: "2026-09-01", version: "V1",
    expectedRevision: assistantReplied.revision,
    requestId: requestId("export-archive"),
  }).record;

  records.rejected = db.reviewInquiry({
    id: make("最近拒绝", "SYNTH-TONER-001", "一团", 4).id, role: "business", decision: "reject",
    businessNote: "拒绝验收", expectedRevision: 1, requestId: requestId("export-reject"),
  }).record;
  records.hidden = db.reviewInquiry({
    id: make("计划隐藏", "SYNTH-TONER-001", "一团", 3).id, role: "business", decision: "reject",
    businessNote: "旧单据", expectedRevision: 1, requestId: requestId("export-old-reject"),
  }).record;
  db.db.prepare("UPDATE inquiry_documents SET reviewed_at = ?, updated_at = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", records.hidden.id);
  records.otherTeam = make("二团队", "SYNTH-TONER-001", "二团", 6);
  records.otherCategory = make("墨盒一团", "SYNTH-INK-001", "一团", 7);

  db.db.prepare("UPDATE stock_batches SET pack_per_box = '1' WHERE model = ? AND version = 'V11'").run("SYNTH-TONER-001");
  const batch = db.db.prepare("SELECT batch_key, model, plan, ship_date, version, fnsku FROM stock_batches WHERE model = ? AND version = 'V11' LIMIT 1").get("SYNTH-TONER-001");
  assert.ok(batch, "隔离数据库必须有可用于调拨排除测试的硒鼓批次");
  const allocation = db.createAllocation({
    role: "admin", model: batch.model, plan: batch.plan, date: batch.ship_date, version: batch.version,
    sourceBatchKey: batch.batch_key, quantity: 1, department: "一团", store: "AUS", operator: "调拨排除验收",
    fnsku: batch.fnsku, asin: "BEXP000001", operatorNote: "不进入询库导出", requestId: requestId("export-allocation"),
  }).record;
  const cutoff = currentApprovalCutoff();
  db.db.prepare("INSERT INTO system_meta(key,value) VALUES('approval_first_clear_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(cutoff);
  db.db.prepare("INSERT INTO system_meta(key,value) VALUES('approval_clear_before', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(cutoff);
  db.close();
  return { records, allocation, historicalNote };
}

function businessSnapshot() {
  const db = new InventoryDatabase(stateRoot);
  try {
    return JSON.stringify({
      inquiries: db.db.prepare(`SELECT id, revision, status, requested_quantity, approved_quantity, supplier_quantity,
        shipping_warehouse, purchase_note, updated_at FROM inquiry_documents ORDER BY id`).all(),
      allocations: db.db.prepare("SELECT id, revision, status, quantity, updated_at FROM allocation_documents ORDER BY id").all(),
      inquiryEvents: db.db.prepare("SELECT * FROM inquiry_events ORDER BY id").all(),
      allocationEvents: db.db.prepare("SELECT * FROM document_events ORDER BY id").all(),
      ledger: db.db.prepare("SELECT * FROM inventory_ledger ORDER BY id").all(),
      catalog: db.db.prepare("SELECT model, base_in_stock, in_transit FROM catalog_models ORDER BY model").all(),
    });
  } finally { db.close(); }
}

function decodeXml(value) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, "\r").replace(/&amp;/g, "&");
}

function columnIndex(value) {
  return [...value].reduce((index, character) => index * 26 + character.charCodeAt(0) - 64, 0) - 1;
}

function readWorkbook(bytes) {
  const parts = unzipSync(new Uint8Array(bytes));
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"])
    assert.ok(parts[name], `xlsx 包含 ${name}`);
  const workbookXml = strFromU8(parts["xl/workbook.xml"]);
  const worksheetXml = strFromU8(parts["xl/worksheets/sheet1.xml"]);
  assert.match(workbookXml, /<sheet\b[^>]*name="询库"/);
  assert.doesNotMatch(worksheetXml, /<f(?:\s|>)/, "文字不得被写成 Excel 公式");
  const rows = [...worksheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(match => {
    const values = Array(11).fill(null);
    const types = Array(11).fill(null);
    for (const cellMatch of match[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const address = cellMatch[1].match(/\br="([A-Z]+\d+)"/)?.[1];
      assert.ok(address, "每个工作表单元格有位置");
      const index = columnIndex(address.match(/^[A-Z]+/)[0]);
      types[index] = cellMatch[1].match(/\bt="([^"]+)"/)?.[1] ?? null;
      const text = cellMatch[2] ?? "";
      if (types[index] === "inlineStr") values[index] = decodeXml(text.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1] ?? "");
      else if (types[index] === "n") {
        const numeric = text.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        values[index] = numeric === undefined ? null : Number(numeric);
      } else if (types[index] === null && !text.trim()) values[index] = null;
      else assert.fail(`未知的单元格类型 ${types[index] ?? "默认"}`);
    }
    return { values, types };
  });
  return { parts, workbookXml, worksheetXml, rows };
}

function exportStatus(row) {
  if (row.status === "archived" && row.supplierQuantity === 0 && row.archivedByRole === "purchasing") return "无货归档";
  if (row.status === "archived" && ["assistant", "assistant-1", "assistant-2"].includes(row.archivedByRole ?? "")) return "已完成";
  return row.statusText;
}

async function checkWorkbookMatchesResponse(download, response, currentPage) {
  assert.match(download.suggestedFilename(), /\.xlsx$/i);
  const filePath = await download.path();
  assert.ok(filePath, "浏览器生成了实际下载文件");
  const workbook = readWorkbook(await fs.readFile(filePath));
  assert.deepEqual(workbook.rows[0].values, headers, "工作簿表头和 11 列顺序严格匹配");
  assert.equal(workbook.rows.length, response.inquiries.length + 1, "询库每单一行，无汇总行或遗漏");
  assert.ok(response.allocations.length > 0, "API 响应含调拨以证明导出排除了调拨");
  const dataRows = workbook.rows.slice(1);
  const byOperator = new Map(dataRows.map(row => [row.values[7], row]));
  assert.equal(byOperator.size, dataRows.length, "同名测试运营没有合并单据");
  for (const inquiry of response.inquiries) {
    const actual = byOperator.get(inquiry.operator);
    assert.ok(actual, `文件包含 ${inquiry.operator} 对应询库`);
    const createdAt = await currentPage.evaluate(value => new Date(value).toLocaleString("zh-CN", { hour12: false }), inquiry.createdAt);
    assert.deepEqual(actual.values, [
      inquiry.model, inquiry.approvedQuantity, inquiry.supplierQuantity, inquiry.shippingWarehouse ?? "",
      inquiry.purchaseNote ?? "", inquiry.department, inquiry.store, inquiry.operator, inquiry.fnsku,
      createdAt, exportStatus(inquiry),
    ], `${inquiry.operator} 的导出值来自响应中的已保存字段`);
    for (const index of [0, 3, 4, 5, 6, 7, 8, 9, 10]) assert.equal(actual.types[index], "inlineStr", `第 ${index + 1} 列按文本写入`);
    for (const index of [1, 2]) {
      if (actual.values[index] === null) assert.equal(actual.values[index], null, "空数量保持空白");
      else assert.equal(actual.types[index], "n", "数量以 Excel 数值单元格写入");
    }
  }
  return { ...workbook, byOperator };
}

async function changeRole(value) {
  const selector = page.locator('select[aria-label="切换当前操作角色"]');
  if (await selector.inputValue() === value) return;
  const response = page.waitForResponse(item => new URL(item.url()).pathname === "/api/approvals" && item.request().method() === "GET");
  await selector.selectOption(value);
  await response;
}

async function expandModel(model) {
  const group = page.locator(`.approval-model-group[data-model="${model}"]`);
  await group.waitFor();
  const toggle = group.locator(".approval-expand");
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  return group;
}

async function exportDownload() {
  const responsePromise = page.waitForResponse(item => new URL(item.url()).pathname === "/api/approvals" && item.request().method() === "GET");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /^(导出询库|正在导出)/ }).click();
  const [response, download] = await Promise.all([responsePromise, downloadPromise]);
  assert.equal(response.status(), 200, "导出响应成功");
  return { response: await response.json(), download };
}

async function resetFilters() {
  await page.getByLabel("按需求类型筛选", { exact: true }).selectOption("all");
  await page.getByRole("group", { name: "按类目筛选", exact: true }).getByRole("button", { name: "全部类目", exact: true }).click();
  await page.getByLabel("筛选审批进度", { exact: true }).selectOption("all");
  const todo = page.getByRole("button", { name: /^我的待办/ });
  if (await todo.getAttribute("aria-pressed") === "true") await todo.click();
  await page.getByLabel("搜索运营姓名、型号或 ASIN", { exact: true }).fill("");
}

try {
  await fs.mkdir(path.join(stateRoot, "data"), { recursive: true });
  const permissions = {
    墨盒: Object.fromEntries(roles.map(role => [role, { summary: true, detail: true, expand: true, actions: true }])),
  };
  permissions["墨盒"]["operation-1"] = { summary: false, detail: false, expand: false, actions: false };
  await fs.writeFile(path.join(stateRoot, "data", "permissions.json"), JSON.stringify(permissions));
  createInventoryDatabase({ databasePath: path.join(stateRoot, "data", INVENTORY_DATABASE_NAME) });
  const { records, allocation, historicalNote } = seedDatabase();

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const instanceId = createTestInstanceId("inquiry-export");
  server = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root,
    env: { ...process.env, ASTER_STATE_ROOT: stateRoot, PORT: String(port), HOST: "127.0.0.1", PROD: "1", ASTER_TEST_INSTANCE_ID: instanceId },
    stdio: "ignore",
  });
  await waitForOwnedServer({ base, child: server, instanceId, readyPath: "/api/health" });

  const initialAdmin = await callApi("GET", "/api/approvals", "admin");
  assert.equal(initialAdmin.ok, true);
  assert.equal(initialAdmin.allocations.some(row => row.id === allocation.id), true, "审批 API 同时有调拨和询库");
  assert.equal(initialAdmin.inquiries.some(row => row.id === records.hidden.id), false, "按计划隐藏的旧终态不在审批 API 响应");
  check("导出数据来源的审批接口保留角色可见范围、计划隐藏规则并排除旧历史");

  const executablePath = [
    process.env.ASTER_BROWSER_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean).find(value => fsSync.existsSync(value));
  assert.ok(executablePath, "找不到用于审批中心导出验收的 Chromium 浏览器");
  browser = await chromium.launch({ executablePath, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("download", () => { downloadCount += 1; });
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && /^\/api\/inquiries\/\d+\/reply$/.test(pathname)) replyPosts.push(pathname);
  });
  await page.route("**/api/approvals", async route => {
    if (route.request().method() !== "GET") return route.continue();
    if (approvalMode === "empty") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, allocations: [], inquiries: [], sync: initialAdmin.sync }) });
    if (approvalMode === "failure") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "导出接口验收模拟失败" }) });
    if (approvalMode === "hold") {
      heldRequests += 1;
      await new Promise(resolve => { holdRelease = resolve; });
    }
    return route.continue();
  });
  await page.route("**/api/sync", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, sync: initialAdmin.sync }) }));
  await page.goto(base, { waitUntil: "networkidle" });
  const roleSelector = page.locator('select[aria-label="切换当前操作角色"]');
  if (await roleSelector.inputValue() !== "admin") await changeRole("admin");
  await page.locator(".sidebar .nav-item", { hasText: "审批中心" }).click();
  await page.locator(".approval-page").waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".approval-record").length > 0);
  assert.equal(await page.getByRole("button", { name: "导出询库", exact: true }).count(), 1, "审批中心应提供询库 Excel 导出入口");
  check("审批中心提供询库 Excel 导出入口");

  await expandModel("SYNTH-TONER-001");
  const staleRow = page.locator(`.approval-record[data-document-no="${records.latest.documentNo}"]`);
  assert.equal((await staleRow.locator('[data-field="供应商库存回复"]').textContent())?.trim(), "—", "页面先保留已加载的旧数据");
  await callApi("POST", `/api/inquiries/${records.latest.id}/reply`, "purchasing", {
    supplierQuantity: 60, shippingWarehouse: "CA", purchaseNote: "最新采购回复\n跨客户端保存的备注 060",
    expectedRevision: records.latest.revision, requestId: requestId("cross-client-reply"),
  });
  const afterClientReply = await callApi("GET", "/api/approvals", "admin");
  const latestSaved = afterClientReply.inquiries.find(row => row.id === records.latest.id);
  assert.equal(latestSaved.approvedQuantity, 60);
  assert.equal(latestSaved.supplierQuantity, 60);
  assert.notEqual(latestSaved.updatedAt, latestSaved.createdAt, "测试区分提交时间和更新时间");
  assert.equal((await staleRow.locator('[data-field="供应商库存回复"]').textContent())?.trim(), "—", "拦截版本轮询后页面仍保留旧缓存");
  check("另一客户端保存采购回复后，浏览器页面仍展示旧缓存以检验导出主动重查");

  const batchToggle = page.locator('.approval-model-group[data-model="SYNTH-TONER-001"] .approval-expand');
  if (await batchToggle.getAttribute("aria-expanded") === "true") await batchToggle.click();
  await page.getByLabel("按需求类型筛选", { exact: true }).selectOption("allocation");
  await page.getByRole("group", { name: "按类目筛选", exact: true }).getByRole("button", { name: "墨盒", exact: true }).click();
  await page.getByLabel("筛选审批进度", { exact: true }).selectOption("active");
  await page.getByRole("button", { name: /^我的待办/ }).click();
  await page.getByLabel("筛选审批进度", { exact: true }).selectOption("active");
  await page.getByLabel("搜索运营姓名、型号或 ASIN", { exact: true }).fill("筛选后没有匹配");
  const snapshotBeforeExport = businessSnapshot();
  const adminExport = await exportDownload();
  const adminWorkbook = await checkWorkbookMatchesResponse(adminExport.download, adminExport.response, page);
  assert.equal(adminExport.response.inquiries.some(row => row.id === records.hidden.id), false);
  assert.equal(adminExport.response.inquiries.some(row => row.model === "SYNTH-INK-001"), true, "墨盒询库包含在全量导出");
  assert.equal(adminExport.response.inquiries.some(row => row.model === "SYNTH-TONER-001"), true, "硒鼓询庫包含在全量导出");
  assert.ok(adminExport.response.inquiries.filter(row => row.model === "SYNTH-TONER-001").length > 1, "同型号多张询库分别保留");
  assert.equal(adminExport.response.inquiries.some(row => row.statusCode === "allocation"), false, "文件数据只来自询库数组");
  const unreviewedLine = adminWorkbook.byOperator.get("运营_未审核");
  assert.equal(unreviewedLine.values[1], null);
  assert.equal(unreviewedLine.values[2], null);
  const historicalLine = adminWorkbook.byOperator.get("运营_历史数量差异");
  assert.equal(historicalLine.values[1], 90);
  assert.equal(historicalLine.values[2], 60);
  assert.equal(historicalLine.values[3], "旧仓库（历史值）");
  assert.equal(historicalLine.values[4], historicalNote, "历史仓库和备注按当前存值逐字保留");
  assert.equal(historicalLine.values[8], "0000123456789", "FNSKU 前导零作为文本保留");
  assert.equal(historicalLine.types[4], "inlineStr", "公式样式备注按文本写入");
  const zeroLine = adminWorkbook.byOperator.get("运营_采购无货");
  assert.equal(zeroLine.values[1], 0);
  assert.equal(zeroLine.values[2], 0);
  assert.equal(zeroLine.types[1], "n");
  assert.equal(zeroLine.types[2], "n");
  assert.equal(zeroLine.values[10], "无货归档");
  assert.equal(adminWorkbook.byOperator.get("运营_助理完成").values[10], "已完成");
  assert.equal(adminWorkbook.byOperator.get("运营_最近拒绝").values[10], "已拒绝");
  const latestLine = adminWorkbook.byOperator.get("运营_跨客户端最新");
  assert.equal(latestLine.values[1], 60);
  assert.equal(latestLine.values[2], 60);
  assert.equal(latestLine.values[3], "CA");
  assert.equal(latestLine.values[4], "最新采购回复\n跨客户端保存的备注 060");
  const latestExportTime = await page.evaluate(value => new Date(value).toLocaleString("zh-CN", { hour12: false }), latestSaved.createdAt);
  assert.equal(latestLine.values[9], latestExportTime, "提交时间使用 createdAt 页面口径，不用更新时间");
  assert.deepEqual([
    await page.getByLabel("按需求类型筛选", { exact: true }).inputValue(),
    await page.getByLabel("筛选审批进度", { exact: true }).inputValue(),
    await page.getByLabel("搜索运营姓名、型号或 ASIN", { exact: true }).inputValue(),
    await page.getByRole("button", { name: /^我的待办/ }).getAttribute("aria-pressed"),
    await page.getByRole("group", { name: "按类目筛选", exact: true }).getByRole("button", { name: "墨盒", exact: true }).getAttribute("aria-pressed"),
  ], ["allocation", "active", "筛选后没有匹配", "true", "true"], "导出不改变类型、进度、搜索、待办和类目筛选状态");
  check("实际 xlsx 严格 11 列，保留两类/多单、数值空值/0、历史差异、状态、特殊文本与最新回复");

  await changeRole("purchasing");
  await resetFilters();
  await expandModel("SYNTH-INK-001");
  const draftRow = page.locator(`.approval-record[data-document-no="${records.draft.documentNo}"]`);
  await draftRow.getByLabel("供应商库存回复", { exact: true }).fill("88");
  await draftRow.getByLabel("发货仓库", { exact: true }).selectOption("SC");
  await draftRow.getByLabel("采购备注", { exact: true }).fill("尚未提交的草稿备注");
  const inkToggle = page.locator('.approval-model-group[data-model="SYNTH-INK-001"] .approval-expand');
  await inkToggle.click();
  const draftExport = await exportDownload();
  const draftWorkbook = await checkWorkbookMatchesResponse(draftExport.download, draftExport.response, page);
  assert.equal(await inkToggle.getAttribute("aria-expanded"), "false", "导出保留型号折叠状态");
  const draftLine = draftWorkbook.byOperator.get("运营_采购草稿");
  assert.equal(draftLine.values[1], 70);
  assert.equal(draftLine.values[2], null);
  assert.equal(draftLine.values[3], "");
  assert.equal(draftLine.values[4], "");
  assert.equal(await draftRow.getByLabel("供应商库存回复", { exact: true }).inputValue(), "88");
  assert.equal(await draftRow.getByLabel("发货仓库", { exact: true }).inputValue(), "SC");
  assert.equal(await draftRow.getByLabel("采购备注", { exact: true }).inputValue(), "尚未提交的草稿备注");
  assert.equal(replyPosts.length, 0, "填写草稿和导出不会提交采购回复");
  check("未提交采购草稿不进入文件，导出后表单草稿仍保留且无回复写入");

  const operationPayload = await callApi("GET", "/api/approvals", "operation-1");
  assert.ok(operationPayload.inquiries.length > 0);
  assert.ok(operationPayload.inquiries.every(row => row.category === "硒鼓" && row.department === "一团"));
  assert.equal(operationPayload.inquiries.some(row => row.id === records.otherTeam.id), false);
  assert.equal(operationPayload.inquiries.some(row => row.id === records.otherCategory.id), false);
  await changeRole("operation-1");
  await resetFilters();
  const operationExport = await exportDownload();
  const operationWorkbook = await checkWorkbookMatchesResponse(operationExport.download, operationExport.response, page);
  assert.deepEqual(operationWorkbook.rows.slice(1).map(row => row.values[7]).sort(), operationPayload.inquiries.map(row => row.operator).sort());
  assert.ok(operationWorkbook.rows.slice(1).every(row => row.values[5] === "一团" && row.values[0] === "SYNTH-TONER-001"));
  check("运营角色导出严格服从团队和类目权限");

  approvalMode = "empty";
  const beforeEmpty = downloadCount;
  await page.getByRole("button", { name: "导出询库", exact: true }).click();
  await page.getByText("当前角色没有可导出的询库单据", { exact: true }).waitFor();
  assert.equal(downloadCount, beforeEmpty, "空结果不下载空表或旧缓存");
  approvalMode = "failure";
  await page.getByRole("button", { name: "导出询库", exact: true }).click();
  await page.getByText("读取最新询库失败：导出接口验收模拟失败", { exact: true }).waitFor();
  assert.equal(downloadCount, beforeEmpty, "查询失败不使用已缓存页面数据下载");
  check("空结果有明确提示，读取失败明确报错且不使用旧缓存");

  approvalMode = "hold";
  heldRequests = 0;
  const heldResponse = page.waitForResponse(item => new URL(item.url()).pathname === "/api/approvals" && item.request().method() === "GET");
  const heldDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出询库", exact: true }).click();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(element => /^(导出询库|正在导出)/.test(element.textContent?.trim() ?? ""));
    return Boolean(button?.disabled && button.textContent?.includes("正在导出"));
  });
  assert.equal(heldRequests, 1);
  await page.getByRole("button", { name: /正在导出/ }).evaluate(button => button.click());
  await page.waitForTimeout(100);
  assert.equal(heldRequests, 1, "进行中按钮禁用，第二次点击没有重复请求");
  holdRelease();
  const [heldResponseResult, heldDownloadResult] = await Promise.all([heldResponse, heldDownload]);
  assert.equal(heldResponseResult.status(), 200);
  assert.match(heldDownloadResult.suggestedFilename(), /\.xlsx$/i);
  check("导出提供进行中状态并阻止连续点击产生重复请求");

  assert.equal(businessSnapshot(), snapshotBeforeExport, "所有导出和草稿操作不改业务单据、库存或事件");
  check("导出与未提交草稿未写入业务记录、库存或历史事件");
  assert.deepEqual(pageErrors, [], "页面无 JavaScript 运行错误");
  check("导出验收页面无 JavaScript 运行错误");
  console.log(`APPROVAL_INQUIRY_EXPORT_RESULT: ALL PASS (${passed} checks); actual downloads=${downloadCount}`);
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    const closed = new Promise(resolve => server.once("close", resolve));
    server.kill();
    await closed;
  }
  const relativeState = path.relative(os.tmpdir(), stateRoot);
  assert.ok(relativeState.startsWith("aster-inquiry-export-") && !relativeState.includes(".."), "只清理本测试创建的临时目录");
  await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
