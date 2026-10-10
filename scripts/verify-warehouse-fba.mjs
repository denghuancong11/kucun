import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInventoryDatabase, InventoryDatabase } from "../inventory-db.mjs";
import { freePort, createTestInstanceId, waitForOwnedServer } from "./test-server-ownership.mjs";
import { syntheticInboundRows, writeSyntheticTransitWorkbook } from "./fixtures/generate-synthetic-workbook.mjs";

const root = path.resolve(import.meta.dirname, "..");
const state = await fs.mkdtemp(path.join(os.tmpdir(), "aster-warehouse-fba-"));
const output = process.env.ASTER_ACCEPTANCE_OUTPUT || path.join(state, "artifacts");
const sourceRows = syntheticInboundRows(47).map(row => ({ ...row, date: "1.1" }));
const fbaRows = sourceRows.filter(row => row.shippingMethod === "直发FBA");
const localSourceQuantity = sourceRows.filter(row => row.shippingMethod !== "直发FBA").reduce((sum, row) => sum + row.quantity, 0);
const fbaSourceQuantity = fbaRows.reduce((sum, row) => sum + row.quantity, 0);
const databasePath = path.join(state, "data", "aster-inventory.sqlite");
const workbookPath = path.join(state, "synthetic-inbound-47.xlsx");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const instanceId = createTestInstanceId("warehouse-fba");
const rid = () => crypto.randomUUID();
const checks = [];
const check = name => { checks.push(name); console.log("PASS " + name); };

await writeSyntheticTransitWorkbook(workbookPath, { rows: sourceRows, sheetName: "SyntheticImport" });
await fs.mkdir(output, { recursive: true });
createInventoryDatabase({ databasePath, seedCatalogData: false });
const db = new InventoryDatabase(state);
const server = spawn(process.execPath, [path.join(root, "server.mjs")], {
  cwd: root,
  windowsHide: true,
  stdio: "ignore",
  env: { ...process.env, ASTER_STATE_ROOT: state, PORT: String(port), HOST: "127.0.0.1", PROD: "1", ASTER_TEST_INSTANCE_ID: instanceId },
});

async function api(route, role = "admin", body, status = 200) {
  const response = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: { "x-role": role, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

async function preview(buffer, name, role = "admin", status = 200) {
  const response = await fetch(base + "/api/transit/preview", {
    method: "POST",
    headers: { "x-role": role, "x-file-name": encodeURIComponent(name), "x-date-year": "2026" },
    body: buffer,
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

const payload = value => ({
  previewToken: value.previewToken,
  fileName: value.fileName,
  fileHash: value.fileSha256,
  templateHash: value.templateSha256,
  rows: value.rows,
  requestId: rid(),
});
const shelf = transit => api(
  `/api/transit/${transit.id}/on-shelf`,
  db.getTransit(transit.id).team === "二团" ? "assistant-2" : "assistant-1",
  { expectedRevision: transit.revision, yes: "YES", requestId: rid() },
);
const allocate = (batch, team, quantity, operator) => api("/api/allocations", team === "一团" ? "operation-1" : "operation-2", {
  sourceBatchKey: batch.batchKey,
  model: "SYNTH-COMP-001",
  plan: batch.plan,
  date: batch.date,
  version: batch.version,
  quantity,
  department: team,
  operator,
  store: `SYNTH${team}US`,
  asin: "SYNTH00001",
  fnsku: "TEST-FNSKU-OP",
  operatorNote: "synthetic fixture",
  requestId: rid(),
}).then(result => result.record);
const review = (record, quantity, status = 200) => api(`/api/allocations/${record.id}/review`, "business", {
  decision: "approve",
  approvedQuantity: quantity,
  businessNote: "synthetic review",
  expectedRevision: record.revision,
  requestId: rid(),
}, status);

try {
  await waitForOwnedServer({ base, child: server, instanceId });
  const buffer = await fs.readFile(workbookPath);
  await preview(buffer, "uncategorized-fixture.xlsx", "admin", 422);
  check("无类目文件名拒绝，不猜类目");

  const parsed = await preview(buffer, "synthetic-硒鼓-import.xlsx");
  assert.equal(parsed.sheetName, "SyntheticImport");
  assert.equal(parsed.rows.length, 47);
  assert.equal(parsed.validation.canImport, true);
  for (const [index, row] of parsed.rows.entries()) {
    const expected = sourceRows[index];
    assert.equal(row.sourceRow, index + 3);
    assert.deepEqual(row.data, {
      ...expected,
      date: "2026-01-01",
      rawDate: "1.1",
    });
  }
  check("47 条合成 XLSX 行逐值解析，二行表头与短日期归一化正确");
  await preview(buffer, "synthetic-硒鼓-import.xlsx", "operation-1", 403);
  await preview(buffer, "synthetic-硒鼓-import.xlsx", "operation-2", 403);
  check("混合团队文件不能由任一单团运营跨团导入");

  for (const field of ["team", "version"]) {
    const altered = payload(parsed);
    altered.rows = structuredClone(parsed.rows);
    altered.rows[0].data[field] = "TAMPERED";
    await api("/api/transit/import", "admin", altered, 409);
  }
  check("提交篡改文件团队或版本拒绝");

  const imported = await api("/api/transit/import", "admin", payload(parsed));
  assert.equal(imported.rowCount, 47);
  const duplicate = await preview(buffer, "synthetic-硒鼓-copy.xlsx");
  await api("/api/transit/import", "admin", payload(duplicate), 409);
  check("相同合成文件内容不能重复导入");

  for (const row of parsed.rows) {
    const transit = db.db.prepare("SELECT * FROM transit_batches WHERE import_batch_id=? AND source_row=?").get(imported.importId, row.sourceRow);
    assert.equal(transit.version, row.data.version);
    assert.equal(transit.team, row.data.team);
    assert.equal(transit.shipping_method, row.data.shippingMethod);
    assert.equal(transit.quantity, row.data.quantity);
  }
  const beforeShelf = await api("/api/inventory/catalog");
  assert.equal(beforeShelf.models.reduce((sum, item) => sum + item.inTransit, 0), sourceRows.reduce((sum, row) => sum + row.quantity, 0));

  let archive;
  for (const transit of imported.rows) {
    const original = db.getTransit(transit.id);
    const result = await shelf(transit);
    assert.equal(result.after.inStock - result.before.inStock, original.shipping_method === "直发FBA" ? 0 : original.quantity);
    if (result.fbaArchiveId) archive = result;
  }
  const afterShelf = await api("/api/inventory/catalog");
  assert.equal(afterShelf.models.reduce((sum, item) => sum + item.inStock, 0), localSourceQuantity);
  assert.equal(afterShelf.models.reduce((sum, item) => sum + item.inTransit, 0), 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM fba_archives").get().n, fbaRows.length);
  assert.equal(db.db.prepare("SELECT SUM(quantity) q FROM fba_archives").get().q, fbaSourceQuantity);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM stock_receipts").get().n, sourceRows.length - fbaRows.length);
  assert.equal(db.db.prepare("SELECT SUM(on_hand) q FROM stock_balances").get().q, localSourceQuantity);
  check("上架后合成库存守恒，直发FBA独立归档且不生成普通收货");

  await shelf(db.getTransit(archive.transitId)).then(
    () => assert.fail("重复上架应拒绝"),
    error => assert.match(error.message, /409|在途记录|已上架/),
  );
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM fba_archives").get().n, fbaRows.length);
  check("重复上架不重复归档或入库");

  const fbaArchive = db.db.prepare("SELECT * FROM fba_archives ORDER BY id LIMIT 1").get();
  assert.equal(fbaArchive.quantity, 200);
  db.db.prepare("UPDATE fba_archives SET archived_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(fbaArchive.id);
  assert.ok((await api("/api/upgrades")).relocationCandidates.some(candidate => candidate.fbaArchiveId === fbaArchive.id));
  await api("/api/upgrades/relocation-work-items", "operation-2", { fbaArchiveId: fbaArchive.id, requestId: rid() }, 403);
  let work = (await api("/api/upgrades/relocation-work-items", "assistant-1", { fbaArchiveId: fbaArchive.id, requestId: rid() })).workItem;
  assert.equal(work.sourceKind, "fba");
  assert.equal(work.sourceQuantityBefore, fbaArchive.quantity);
  assert.equal(work.fnsku, fbaArchive.fnsku);
  assert.equal(work.store, null);
  await api("/api/upgrades/relocation-work-items", "assistant-1", { fbaArchiveId: fbaArchive.id, requestId: rid() }, 409);
  check("FBA 来源独立，无店铺字段且不受 90 天限制；团队与来源并发约束保留");

  work = (await api(`/api/upgrades/relocation-work-items/${work.id}/procurement`, "logistics", {
    rma: "TEST-RMA",
    relocationAddress: "Synthetic destination",
    expectedRevision: work.revision,
    requestId: rid(),
  })).workItem;
  work = (await api(`/api/upgrades/relocation-work-items/${work.id}/operation`, "operation-1", {
    removalOrderNo: "TEST-REMOVAL-ORDER",
    expectedRevision: work.revision,
    requestId: rid(),
  })).workItem;
  let workerId;
  const execute = async (action, body = {}) => {
    const response = await fetch(base + "/api/lingxing-worker/" + action, {
      method: "POST",
      headers: { origin: "chrome-extension://" + "a".repeat(32), "content-type": "application/json" },
      body: JSON.stringify({ workerId, ...body }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  workerId = (await execute("connect")).workerId;
  const metricsInquiry = (await api("/api/inquiries", "operation-1", {
    model: fbaArchive.model,
    quantity: 1,
    department: fbaArchive.team,
    store: "SYNTHUS",
    operator: "SyntheticOperator",
    asin: "SYNTH00001",
    fnsku: fbaArchive.fnsku,
    requestId: rid(),
  })).record;
  const jobs = await Promise.all([
    api("/api/lingxing/jobs", "business", { action: "metrics", documents: [{ kind: "inquiry", id: metricsInquiry.id }], requestId: rid() }, 202),
    api("/api/lingxing/jobs", "operation-1", { action: "logistics", workId: work.id, requestId: rid() }, 202),
  ]);
  assert.deepEqual(jobs[0].job.target.asins, ["SYNTH00001"]);
  assert.equal(jobs[1].job.target.fnsku, fbaArchive.fnsku);
  assert.equal(jobs[1].job.target.orderNo, "TEST-REMOVAL-ORDER");
  for (let index = 0; index < 2; index += 1) {
    const job = (await execute("claim")).job;
    assert.ok(job);
    assert.equal((await execute("claim")).job, null);
    const capture = job.target.action === "metrics"
      ? { items: [{ asin: "SYNTH00001", sales7d: 7, sales30d: 30, orderGrossProfit: 3, fbaAvailable: 30, fbaPendingTransfer: 0, fbaTransferring: 0, fbaInbound: 0 }] }
      : { shipments: [{ externalId: "TEST-PACKAGE", storeId: "SYNTH-STORE", storeName: "Synthetic Store", countryCode: "US", orderNo: "TEST-REMOVAL-ORDER", fnsku: fbaArchive.fnsku, quantity: 80, carrier: "TEST-CARRIER", trackingNo: "TEST-TRACKING", shipDate: "2026-01-01" }] };
    assert.equal((await execute("finish", { id: job.id, capture: { ...capture, capturedAt: new Date().toISOString() } })).job.state, "succeeded");
  }
  work = db.getRelocationWorkItem(work.id);
  assert.equal(db.getInquiry(metricsInquiry.id).lingxing.sales30d, 30);
  assert.equal(work.externalShipments[0].fnsku, fbaArchive.fnsku);
  check("指标与FBA物流并行排队、串行执行，合成指标与物流对象正确保存");

  assert.equal(db.db.prepare("SELECT SUM(on_hand) q FROM stock_balances").get().q, localSourceQuantity);
  check("采购与运营交接不自动发货或增加本地库存");
  const ship = { fbaRemainingQuantity: 120, externalItems: [{ lineId: work.externalShipments[0].lineId, quantity: 80 }], expectedRevision: work.revision, requestId: rid() };
  let upgrade = (await api(`/api/upgrades/relocation-work-items/${work.id}/ship`, "assistant-1", ship)).upgrade;
  assert.equal(upgrade.fbaRemainingQuantity, 120);
  assert.equal(upgrade.shippedQuantity, 80);
  assert.equal((await api(`/api/upgrades/relocation-work-items/${work.id}/ship`, "assistant-1", ship)).deduped, true);
  let relocation = upgrade.relocations[0];
  const completion = { completedQuantity: 30, newVersion: "TEST-V2", targetWarehouse: "SyntheticWarehouseA", expectedRevision: relocation.revision, requestId: rid() };
  await api(`/api/upgrades/relocations/${relocation.id}/complete`, "purchasing", { ...completion, targetWarehouse: "" }, 400);
  upgrade = (await api(`/api/upgrades/relocations/${relocation.id}/complete`, "purchasing", completion)).upgrade;
  assert.equal((await api(`/api/upgrades/relocations/${relocation.id}/complete`, "purchasing", completion)).deduped, true);
  relocation = upgrade.relocations[0];
  upgrade = (await api(`/api/upgrades/relocations/${relocation.id}/complete`, "purchasing", {
    completedQuantity: 50,
    newVersion: "TEST-V3",
    targetWarehouse: "SyntheticWarehouseB",
    expectedRevision: relocation.revision,
    requestId: rid(),
  })).upgrade;
  assert.deepEqual(upgrade.relocations[0].completions.map(item => [item.version, item.warehouse, item.quantity]), [
    ["TEST-V2", "SyntheticWarehouseA", 30],
    ["TEST-V3", "SyntheticWarehouseB", 50],
  ]);
  assert.equal(db.db.prepare("SELECT SUM(on_hand) q FROM stock_balances").get().q, localSourceQuantity + 80);
  check("FBA 移出与分次回库按合成数量入账，幂等重试不重复");

  const warehouseCsv = Buffer.from([
    "ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号",
    "SYNTH-COMP-001,100,5,TEST-COMP-FNSKU,SyntheticWarehouseA,TEST-SAME,2026-01-01,一团,TEST-V1",
    "SYNTH-COMP-001,100,5,TEST-COMP-FNSKU,SyntheticWarehouseB,TEST-SAME,2026-01-01,二团,TEST-V1",
  ].join("\n"));
  const warehousePreview = await preview(warehouseCsv, "synthetic-硒鼓-warehouse.csv");
  const warehouseImport = await api("/api/transit/import", "admin", payload(warehousePreview));
  for (const transit of warehouseImport.rows) await shelf(transit);
  const batches = (await api("/api/inventory/catalog")).stockDetails["SYNTH-COMP-001"];
  assert.equal(batches.length, 2);
  assert.notEqual(batches[0].batchKey, batches[1].batchKey);
  check("同型号同计划但不同仓库分别形成库存批次");

  let first = await allocate(batches[0], "一团", 50, "SyntheticOperatorA");
  let second = await allocate(batches[0], "二团", 50, "SyntheticOperatorB");
  await review(first, 80, 409);
  second = (await review(second, 20)).record;
  first = (await review(first, 80)).record;
  assert.equal(db.getBalance(batches[0].batchKey).locked, 100);
  assert.equal(db.getBalance(batches[1].batchKey).locked, 0);
  check("同批预占按审核结果增减，不跨仓库自动调配");
  for (const record of [first, second]) {
    await api(`/api/allocations/${record.id}/confirm`, record.department === "二团" ? "assistant-2" : "assistant-1", {
      expectedRevision: record.revision,
      requestId: rid(),
    });
  }
  const publicAllocations = await api("/api/allocations?model=SYNTH-COMP-001", "operation-1");
  assert.equal(Object.values(publicAllocations.records).flat().length, 1);
  assert.equal(publicAllocations.publicRecords[batches[0].batchKey].length, 2);
  assert.ok(publicAllocations.publicRecords[batches[0].batchKey].every(record => record.lockedQuantity === 0));
  assert.equal(publicAllocations.publicRecords[batches[0].batchKey].reduce((sum, record) => sum + record.issuedQuantity, 0), 100);
  assert.ok(publicAllocations.publicRecords[batches[0].batchKey].every(record => !("asin" in record) && !("store" in record)));
  check("跨团队公开摘要保留数量并隐藏私有店铺字段");

  let direct = (await api("/api/upgrades/direct", "operation-2", { model: "SYNTH-COMP-001", sourceVersion: "TEST-V1", requestId: rid() })).upgrade;
  direct = (await api(`/api/upgrades/direct/${direct.id}/complete`, "purchasing", {
    sourceLineId: direct.lines[0].id,
    completedQuantity: 40,
    newVersion: "TEST-V4",
    targetWarehouse: "SyntheticWarehouseA",
    expectedRevision: direct.revision,
    requestId: rid(),
  })).upgrade;
  assert.equal(direct.completedQuantity, 40);
  assert.equal(direct.inProgressQuantity, 60);
  assert.equal(direct.lines[0].completions[0].warehouse, "SyntheticWarehouseA");
  check("本地库存升级支持分次入库与目标仓库");
  assert.deepEqual(db.db.prepare("PRAGMA foreign_key_check").all(), []);
  db.assertInventoryInvariants();
  check("库存约束及外键通过");
  await fs.writeFile(path.join(output, "test-summary.json"), JSON.stringify({ kind: "synthetic-integration", checks, realLingxing: false }, null, 2));
  console.log(`WAREHOUSE_FBA_PASS ${checks.length}`);
} finally {
  db.close();
  server.kill();
  if (server.exitCode === null) await once(server, "exit");
  await fs.rm(state, { recursive: true, force: true });
}
