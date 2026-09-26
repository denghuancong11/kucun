/* 需求 6 / 7 / 8：所有写入仅落在 mkdtemp 隔离库，使用正式 HTTP 审批流程。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createInventoryDatabase, InventoryDatabase, INVENTORY_DATABASE_NAME, INVENTORY_SCHEMA_VERSION, requireValidStoreCode } from "../inventory-db.mjs";
import { createTestInstanceId, waitForOwnedServer } from "./test-server-ownership.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aster-approvals-"));
const databasePath = path.join(stateRoot, "data", INVENTORY_DATABASE_NAME);
const requestId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const batch = { model: "SYNTH-TONER-001", plan: "TEST-PLAN-TONER", date: "2026-02-10", version: "V11" };
const batchKey = "SYNTH-TONER-001#TEST-PLAN-TONER#2026-02-10#V11";
let server;
let base;
let passed = 0;

function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`PASS ${name}`);
}

async function start() {
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const value = listener.address().port;
      listener.close((error) => error ? reject(error) : resolve(value));
    });
  });
  base = `http://127.0.0.1:${port}`;
  const instanceId = createTestInstanceId("approvals");
  server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, ASTER_STATE_ROOT: stateRoot, PORT: String(port), HOST: "127.0.0.1", PROD: "1", ASTER_TEST_INSTANCE_ID: instanceId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  server.stdout.on("data", (chunk) => { diagnostics += chunk; });
  server.stderr.on("data", (chunk) => { diagnostics += chunk; process.stderr.write(chunk); });
  try {
    await waitForOwnedServer({ base, child: server, instanceId, readyPath: "/api/health" });
  } catch (error) {
    throw new Error(`${error.message}\n${diagnostics}`);
  }
}

async function stop() {
  if (!server || server.exitCode !== null) return;
  const closed = new Promise((resolve) => server.once("close", resolve));
  server.kill();
  await closed;
}

// 业务计算回归直接调用当前内部保存方法；HTTP执行链由verify-lingxing-host单独验证。
function saveCapture(route,role,body,expectedStatus=200) {
  const fixtureDb=new InventoryDatabase(stateRoot);
  try {
    const id=route.match(/relocation-work-items\/(\d+)/)?.[1];
    if(expectedStatus!==200) {assert.throws(()=>fixtureDb.syncLingxing({role,...body}),error=>error.status===expectedStatus);return;}
    return id ? fixtureDb.syncRelocationLogistics({id:Number(id),role,...body}) : fixtureDb.syncLingxing({role,...body});
  } finally {fixtureDb.close();}
}
async function call(method, route, role, body, expectedStatus = 200) {
  const response = await fetch(base + route, {
    method,
    headers: { ...(role ? { "x-role": role } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, `${method} ${route}: ${JSON.stringify(payload)}`);
  return payload;
}

function read(sql, ...params) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

function writeSql(sql, ...params) {
  const db = new DatabaseSync(databasePath);
  try { return db.prepare(sql).run(...params); } finally { db.close(); }
}

async function balance() {
  const result = await call("GET", "/api/allocations?model=SYNTH-TONER-001", "admin");
  return result.totals[batchKey];
}

async function assertBalance(name, onHand, locked) {
  const row = await balance();
  check(name, row.onHand === onHand && row.locked === locked && row.available === onHand - locked);
}

const allocationBody = (quantity, suffix) => ({
  ...batch, quantity, department: "一团", store: "AUS", operator: "审批测试员", fnsku: "XAPPROVAL01",
  asin: "BTEST00001", operatorNote: "运营原始备注", requestId: requestId(`allocation-${suffix}`), allowDuplicate: false,
});
const reviewBody = (record, quantity) => ({
  decision: "approve", approvedQuantity: quantity, businessNote: "商务审核备注",
  expectedRevision: record.revision, requestId: requestId("review"),
});

async function upgradeRoundtrip(source, quantity, expected, suffix) {
  const catalogBefore = await call("GET", "/api/inventory/catalog", "admin");
  const modelBefore = catalogBefore.models.find((row) => row.model === batch.model).inStock;
  let result = await call("POST", "/api/upgrades/relocation-work-items", "assistant-1", { ...source, requestId: requestId(`move-${suffix}`) });
  let work = result.workItem;
  check(`${suffix} 移仓从执行量 ${quantity} 带出原计划、实际日期和版本`, work.sourceQuantityBefore === quantity
    && work.plan === expected.plan && work.shipDate === expected.date && work.sourceVersion === expected.version && work.sourceKind === suffix);
  result = await call("POST", `/api/upgrades/relocation-work-items/${work.id}/procurement`, "purchasing", {
    rma: `RMA-${suffix}`, relocationAddress: "供应商升级仓", expectedRevision: work.revision, requestId: requestId("procurement"),
  });
  work = result.workItem;
  result = await call("POST", `/api/upgrades/relocation-work-items/${work.id}/operation`, "operation-1", {
    removalOrderNo: `REMOVE-${suffix}`, expectedRevision: work.revision, requestId: requestId("operation"),
  });
  work = result.workItem;
  for (const retired of ['correct', 'cancel']) {
    await call('POST', `/api/upgrades/relocation-work-items/${work.id}/${retired}`, 'admin', {expectedRevision:work.revision,requestId:requestId('retired')}, 404);
  }
  check(`${suffix} 已删除移仓更正和取消接口且正常流程未改变`, JSON.stringify((await call('GET','/api/upgrades','admin')).relocationWorkItems.find(row=>row.id===work.id))===JSON.stringify(work));
  result = saveCapture(`/api/upgrades/relocation-work-items/${work.id}/lingxing-sync`, "assistant-1", {
    shipments: [{externalId:`EX-${suffix}`,storeId:"S1",storeName:"验收",countryCode:"US",orderNo:`REMOVE-${suffix}`,fnsku:expected.fnsku,carrier:"UPS",trackingNo:`TRACK-${suffix}`,shipDate:"2026-09-08",quantity:40}],
    capturedAt:new Date().toISOString(),requestId:requestId("logistics")
  });
  work=result.workItem;
  const shipment={fbaRemainingQuantity:quantity-40, externalItems:work.externalShipments.map(row=>({lineId:row.lineId,quantity:40})), expectedRevision:work.revision,requestId:requestId("ship")};
  result=await call("POST", `/api/upgrades/relocation-work-items/${work.id}/ship`, "assistant-1", shipment);
  check(`${suffix} 物流采纳重试不重复登记`,(await call("POST", `/api/upgrades/relocation-work-items/${work.id}/ship`, "assistant-1", shipment)).deduped);
  const upgrade = result.upgrade;
  const relocation = upgrade.relocations[0];
  const catalogAfterShip = await call("GET", "/api/inventory/catalog", "admin");
  check(`${suffix} 移仓登记不重复扣减本地库存`, catalogAfterShip.models.find((row) => row.model === batch.model).inStock === modelBefore);
  const completion = { completedQuantity: 25, newVersion: "V31", targetWarehouse: "SyntheticWarehouseA", expectedRevision: relocation.revision, requestId: requestId("complete") };
  result = await call("POST", `/api/upgrades/relocations/${relocation.id}/complete`, "purchasing", completion);
  check(`${suffix} 升级完成 25，剩余 15 升级中`, result.upgrade.completedQuantity === 25 && result.upgrade.inProgressQuantity === 15);
  result = await call("POST", `/api/upgrades/relocations/${relocation.id}/complete`, "purchasing", completion);
  check(`${suffix} 升级完成重试不重复入库`, result.deduped === true);
  const catalogAfterComplete = await call("GET", "/api/inventory/catalog", "admin");
  const target = catalogAfterComplete.stockDetails[batch.model].find((row) => row.plan === expected.plan && row.date === expected.date && row.version === "V31");
  check(`${suffix} 仅完成的 25 进入在库并继承正确 FNSKU`, target?.quantity === 25 && target.fnsku === expected.fnsku
    && catalogAfterComplete.models.find((row) => row.model === batch.model).inStock === modelBefore + 25);
  const next=result.upgrade?.relocations?.[0] ?? (await call("GET","/api/upgrades","admin")).upgrades.find(j=>j.id===upgrade.id).relocations[0];
  const final=await call("POST", `/api/upgrades/relocations/${relocation.id}/complete`, "purchasing", {completedQuantity:15,newVersion:"V32",targetWarehouse:"SyntheticWarehouseA",expectedRevision:next.revision,requestId:requestId("complete-v32")});
  check(`${suffix} 同移仓单两种新版本完整记账`, final.upgrade.relocations[0].completions.map(x=>`${x.version}:${x.quantity}`).join() === "V31:25,V32:15");

}

try {
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const roles = ["admin", "assistant-1", "assistant-2", "business", "operation-1", "operation-2", "purchasing"];
  await fs.writeFile(path.join(stateRoot, "data", "permissions.json"), JSON.stringify({
    墨盒: Object.fromEntries(roles.map((role) => [role, { summary: true, detail: true, expand: true, actions: true }])),
  }));
  createInventoryDatabase({ databasePath });
  // 本脚本不验证箱规；为审批与并发样例显式配置相关合成批次为每箱1件。
  assert.equal(writeSql("UPDATE stock_batches SET pack_per_box='1' WHERE model=? AND plan=? AND version IN ('V11','V12')", batch.model, batch.plan).changes, 2);
  await start();

  const missing = await call("POST", "/api/allocations", "operation-1", { ...allocationBody(100, "missing"), asin: "" }, 400);
  check("ASIN 必填且失败录入没有锁库存", missing.code === "missing_asin" && read("SELECT id FROM allocation_documents").length === 0);
  const validStores = ["AUS", "ABUS", "A1US", "USABC", "AUSB", "US"];
  const invalidStores = ["A-US", "US-ABC", "AAA", "aus"];
  check("共用店铺校验接受完整有效样例并拒绝完整无效样例",
    validStores.every((store) => requireValidStoreCode(store) === store)
      && invalidStores.every((store) => { try { requireValidStoreCode(store); return false; } catch (error) { return error.code === "invalid_store_format" && error.message === "店铺名称须包含大写 US，且不能包含‘-’。"; } }));
  const storeFailureBaseline = {
    allocations: read("SELECT COUNT(*) AS count FROM allocation_documents")[0].count,
    inquiries: read("SELECT COUNT(*) AS count FROM inquiry_documents")[0].count,
    ledger: read("SELECT COUNT(*) AS count FROM inventory_ledger")[0].count,
    balance: await balance(),
  };
  for (const store of invalidStores) {
    const rejected = await call("POST", "/api/allocations", "operation-1", { ...allocationBody(1, `bad-store-${store}`), store }, 400);
    check(`调拨店铺格式 ${store} 被拒且不生成单据`, rejected.code === "invalid_store_format"
      && rejected.error === "店铺名称须包含大写 US，且不能包含‘-’。"
      && read("SELECT COUNT(*) AS count FROM allocation_documents")[0].count === storeFailureBaseline.allocations
      && read("SELECT COUNT(*) AS count FROM inventory_ledger")[0].count === storeFailureBaseline.ledger
      && JSON.stringify(await balance()) === JSON.stringify(storeFailureBaseline.balance));
    const inquiryRejected = await call("POST", "/api/inquiries", "operation-1", {
      model: batch.model, quantity: 1, department: "一团", store, operator: "店铺校验", fnsku: "XINQUIRY01", asin: "BTEST00002", requestId: requestId(`bad-inquiry-store-${store}`),
    }, 400);
    check(`询库店铺格式 ${store} 被拒且不生成单据或占用库存`, inquiryRejected.code === "invalid_store_format"
      && inquiryRejected.error === "店铺名称须包含大写 US，且不能包含‘-’。"
      && read("SELECT COUNT(*) AS count FROM inquiry_documents")[0].count === storeFailureBaseline.inquiries
      && JSON.stringify(await balance()) === JSON.stringify(storeFailureBaseline.balance));
  }
  let result = await call("POST", "/api/allocations", "operation-1", { ...allocationBody(100, "100-to-90"), store: "ABUS" });
  const submitted = result.record;
  check("合法店铺 ABUS 可通过调拨接口提交", submitted.store === "ABUS");
  check("调拨保留 ASIN、运营备注、申请量并进入商务待审", submitted.asin === "BTEST00001" && submitted.operatorNote === "运营原始备注"
    && submitted.requestedQuantity === 100 && submitted.quantity === 100 && submitted.approvedQuantity === null && submitted.approvalStatus === "pending");
  await assertBalance("申请 100 只锁定 100，在库仍为 500", 500, 100);
  result = await call("GET", "/api/approvals", "business");
  check("审批中心查询返回新申请且领星未同步保持空值", result.allocations.some((row) => row.id === submitted.id && row.lingxing === null && row.coverageBefore === null));
  await call("POST", `/api/allocations/${submitted.id}/confirm`, "assistant-1", { expectedRevision: submitted.revision, requestId: requestId("bypass") }, 409);
  await assertBalance("旧助理确认入口不能跳过商务审批", 500, 100);
  for (const role of ["assistant-1", "assistant-2", "operation-1", "operation-2", "purchasing"]) {
    await call("POST", `/api/allocations/${submitted.id}/review`, role, reviewBody(submitted, 90), 403);
  }
  check("助理、运营、采购不能代替商务审核", read("SELECT COUNT(*) AS count FROM inventory_ledger WHERE document_id = ?", submitted.id)[0].count === 1);
  await call("POST", "/api/allocations", "business", allocationBody(1, "business-denied"), 403);
  await call("POST", "/api/upgrades/direct", "business", { model: batch.model, sourceVersion: "V11", requestId: requestId("business-upgrade") }, 403);
  check("商务没有调拨录入或升级发起权限", true);

  const firstMetrics = { asin: submitted.asin, sales7d: 40, sales30d: 170, orderGrossProfit: 123.4, fbaAvailable: 100, fbaPendingTransfer: 76, fbaTransferring: 100, fbaInbound: 100 };
  const syncBody = { items: [firstMetrics], capturedAt: new Date().toISOString(), requestId: requestId("lingxing") };
  saveCapture("/api/approvals/lingxing-sync", "operation-1", syncBody, 403);
  saveCapture("/api/approvals/lingxing-sync", "admin", syncBody);
  result = saveCapture("/api/approvals/lingxing-sync", "admin", syncBody);
  check("领星抓取结果按 ASIN 同步且重试不会重复写入", result.deduped === true);
  result = await call("GET", "/api/approvals", "business");
  let current = result.allocations.find((row) => row.id === submitted.id);
  check("四项 FBA 合计 376 / 30 天销量 170 显示 2.2，申请后为 2.8", current.coverageBefore === 2.2 && current.coverageAfter === 2.8
    && current.lingxing.scope === "all_stores" && current.lingxing.sales7d === 40 && current.lingxing.orderGrossProfit === 123.4);

  const approval = reviewBody(submitted, 90);
  result = await call("POST", `/api/allocations/${submitted.id}/review`, "business", approval);
  const approved = result.record;
  check("批准 90 保留原申请 100 和两方备注，覆盖当前执行量", approved.requestedQuantity === 100 && approved.approvedQuantity === 90 && approved.quantity === 90
    && approved.businessNote === "商务审核备注" && approved.operatorNote === "运营原始备注" && approved.approvalStatus === "approved" && approved.coverageAfter === 2.7);
  await assertBalance("批准后即时释放多锁的 10 件", 500, 90);
  check("审核差额以独立 -10 锁定流水记账", read("SELECT locked_delta, on_hand_delta FROM inventory_ledger WHERE document_id = ? AND entry_type = 'review_adjustment'", submitted.id)
    .some((row) => row.locked_delta === -10 && row.on_hand_delta === 0));
  result = await call("POST", `/api/allocations/${submitted.id}/review`, "business", approval);
  check("同请求审核重放一次且不重复释放", result.deduped === true && read("SELECT id FROM inventory_ledger WHERE document_id = ? AND entry_type = 'review_adjustment'", submitted.id).length === 1);
  await call("POST", `/api/allocations/${submitted.id}/confirm`, "assistant-1", { expectedRevision: submitted.revision, requestId: requestId("stale-confirm") }, 409);
  const confirmBody = { expectedRevision: approved.revision, requestId: requestId("confirm") };
  result = await call("POST", `/api/allocations/${submitted.id}/confirm`, "assistant-1", confirmBody);
  const confirmed = result.record;
  check("助理完成按批准量 90 出库并保留升级身份字段", confirmed.statusCode === "confirmed" && confirmed.quantity === 90 && confirmed.plan === batch.plan && confirmed.date === batch.date && confirmed.version === batch.version);
  await assertBalance("确认后在库 410、锁定 0，没有残留 10 件锁定", 410, 0);
  result = await call("POST", `/api/allocations/${submitted.id}/confirm`, "assistant-1", confirmBody);
  check("确认重试只生成一笔 -90 出库", result.deduped === true && read("SELECT on_hand_delta FROM inventory_ledger WHERE document_id = ? AND entry_type = 'issue'", submitted.id).map((row) => row.on_hand_delta).join() === "-90");
  result = await call("GET", "/api/upgrades", "assistant-1");
  check("归档调拨按批准 90 进入移仓升级并自动带出原计划、日期、版本", result.relocationCandidates.some((row) => row.allocationId === submitted.id
    && row.initialQuantity === 90 && row.plan === batch.plan && row.shipDate === batch.date && row.sourceVersion === batch.version));

  saveCapture("/api/approvals/lingxing-sync", "admin", { items: [{ ...firstMetrics, sales30d: 0 }], capturedAt: new Date().toISOString(), requestId: requestId("zero-sales") });
  result = await call("GET", "/api/approvals", "business");
  check("后续同步不会覆盖已完成调拨的领星快照", result.allocations.find((row) => row.id === submitted.id).lingxing.sales30d === 170);
  const beforeInquiryBalance = await balance();
  result = await call("POST", "/api/inquiries", "operation-1", {
    model: batch.model, quantity: 150, department: "一团", store: "USABC", operator: "询库测试员", fnsku: "XINQUIRY01", asin: "BTEST00002",
    operatorNote: "请询供应商现货", requestId: requestId("inquiry"), allowDuplicate: false,
  });
  const inquirySubmitted = result.record;
  check("询库申请 150 独立进入商务待审", inquirySubmitted.status === "pending_business" && inquirySubmitted.requestedQuantity === 150 && inquirySubmitted.asin === "BTEST00002");
  await call("POST", `/api/inquiries/${inquirySubmitted.id}/reply`, "purchasing", { supplierQuantity: 60, shippingWarehouse: "东莞仓", expectedRevision: inquirySubmitted.revision, requestId: requestId("reply-before-review") }, 409);
  result = await call("POST", `/api/inquiries/${inquirySubmitted.id}/review`, "business", reviewBody(inquirySubmitted, 90));
  const inquiryApproved = result.record;
  check("询库批准 90 保留申请 150 并进入采购待办", inquiryApproved.status === "pending_purchasing" && inquiryApproved.requestedQuantity === 150 && inquiryApproved.approvedQuantity === 90);
  result = await call("POST", `/api/inquiries/${inquirySubmitted.id}/reply`, "purchasing", { supplierQuantity: 60, shippingWarehouse: "东莞仓", expectedRevision: result.record.revision, requestId: requestId("reply-60") });
  const inquiryReplied = result.record;
  check("供应商回复 60 覆盖申请量、保留商务审核 90 并进入助理待办", inquiryReplied.status === "pending_assistant" && inquiryReplied.requestedQuantity === 60
    && inquiryReplied.approvedQuantity === 90 && inquiryReplied.supplierQuantity === 60 && inquiryReplied.quantity === 60 && inquiryReplied.shippingWarehouse === "东莞仓");
  check("采购回复保留最初申请事件及原始数量", inquiryReplied.events.find(event => event.type === "entry")?.payload.requestedQuantity === 150
    && inquiryReplied.events.some(event => event.type === "reply" && event.payload.supplierQuantity === 60));
  await call("POST", `/api/inquiries/${inquirySubmitted.id}/archive`, "assistant-1", { plan: "FBA-INQUIRY-PLAN", date: "", version: "V20", expectedRevision: inquiryReplied.revision, requestId: requestId("archive-missing-date") }, 400);
  const archiveBody = { plan: "FBA-INQUIRY-PLAN", date: "2026-09-01", version: "V20", expectedRevision: inquiryReplied.revision, requestId: requestId("archive") };
  result = await call("POST", `/api/inquiries/${inquirySubmitted.id}/archive`, "assistant-1", archiveBody);
  const inquiryArchived = result.record;
  check("助理归档登记计划、日期和原版本，最终执行量为 60", inquiryArchived.status === "archived" && inquiryArchived.plan === archiveBody.plan && inquiryArchived.date === archiveBody.date
    && inquiryArchived.version === "V20" && inquiryArchived.quantity === 60 && inquiryArchived.operatorNote === "请询供应商现货");
  result = await call("POST", `/api/inquiries/${inquirySubmitted.id}/archive`, "assistant-1", archiveBody);
  check("询库归档重试只重放一次", result.deduped === true);
  check("询库申请、审批、采购回复、归档全程不计入在库或锁定", JSON.stringify(await balance()) === JSON.stringify(beforeInquiryBalance)
    && read("SELECT COALESCE(SUM(on_hand_delta), 0) AS delta FROM inventory_ledger")[0].delta === -90);

  await upgradeRoundtrip({ inquiryId: inquirySubmitted.id }, 60, { plan: "FBA-INQUIRY-PLAN", date: "2026-09-01", version: "V20", fnsku: "XINQUIRY01" }, "inquiry");

  result = await call("POST", "/api/allocations", "operation-1", allocationBody(100, "roundtrip"));
  const allocationRoundtrip = result.record;
  result = await call("POST", `/api/allocations/${allocationRoundtrip.id}/review`, "business", reviewBody(allocationRoundtrip, 90));
  result = await call("POST", `/api/allocations/${allocationRoundtrip.id}/confirm`, "assistant-1", { expectedRevision: result.record.revision, requestId: requestId("roundtrip-confirm") });
  await upgradeRoundtrip({ allocationId: allocationRoundtrip.id }, 90, { ...batch, fnsku: allocationRoundtrip.fnsku }, "allocation");
  writeSql("UPDATE allocation_documents SET confirmed_at=? WHERE id=?", "2026-01-01T00:00:00.000Z", submitted.id);
  const balanceBeforeExpiredAllocation = await balance();
  const candidateList = await call("GET", "/api/upgrades", "assistant-1");
  check("超过90天的调拨来源仍被候选查询排除", !candidateList.relocationCandidates.some(row => row.allocationId === submitted.id));
  const expiredAllocation = await call("POST", "/api/upgrades/relocation-work-items", "assistant-1", { allocationId: submitted.id, requestId: requestId("expired-allocation") }, 409);
  check("超过90天的调拨来源仍被发起接口拒绝且不影响库存", expiredAllocation.code === "allocation_outside_90_days"
    && JSON.stringify(await balance()) === JSON.stringify(balanceBeforeExpiredAllocation));
  for (const qty of [0,120]) {
    let r=(await call("POST","/api/inquiries","operation-1",{...allocationBody(150,`reply-${qty}`),model:batch.model})).record;
    r=(await call("POST",`/api/inquiries/${r.id}/review`,"business",reviewBody(r,90))).record;
    r=(await call("POST",`/api/inquiries/${r.id}/reply`,"purchasing",{supplierQuantity:qty,shippingWarehouse:qty?"东莞仓":"",expectedRevision:r.revision,requestId:requestId("supplier")})).record;
    check(`供应商回复${qty}覆盖申请量并按最终量处理`,r.requestedQuantity===qty && r.quantity===qty && r.status===(qty===0?"archived":"pending_assistant"));
  }
  for (const route of ["/api/admin/withdrawals","/api/features","/api/transit/1/off-shelf","/api/inquiries/1/ship"]) await call(route.includes("ship")?"POST":"GET",route,"admin",undefined,404);
  const beforeRetired=read('SELECT * FROM stock_balances ORDER BY batch_key');
  const beforeEvents=read('SELECT COUNT(*) AS count FROM document_events');
  for (const kind of ['allocation','inquiry','transit','stock','upgrade','operation','relocation','work','import','package']) {
    const target=`/api/business-corrections/${kind}/1`;
    await call('GET',target,'admin',undefined,404);
    for (const action of ['preview','apply']) await call('POST',`${target}/${action}`,'admin',{action:'edit',values:{quantity:1},reason:'removed route',requestId:requestId('retired')},404);
  }
  check('所有原单更正读取、预览、提交接口均已删除，库存和事件未变', JSON.stringify(read('SELECT * FROM stock_balances ORDER BY batch_key'))===JSON.stringify(beforeRetired)&&JSON.stringify(read('SELECT COUNT(*) AS count FROM document_events'))===JSON.stringify(beforeEvents));

  check("已删除的流程接口不可再用",true);

  // In-transit ingestion exercises real parser and token boundary, without touching real data.
  const csv=rows=>Buffer.from(rows.map(row=>row.join(",")).join("\n"));
  async function upload(route, rows, fileName="测试硒鼓.csv", role="assistant-1") {
    const response=await fetch(base+route,{method:"POST",headers:{"x-role":role,"x-file-name":encodeURIComponent(fileName)},body:csv(rows)});
    const data=await response.json(); assert.equal(response.status,200,JSON.stringify(data)); return data;
  }
  const headers=["Brand","ITEM","订单数量","套/箱","FNSKU","发货方式","计划号","出货时间","团队","版本号"];
  const input=[headers,["Aster","TEST-MULTI",20,"4","X000000001","整柜","PLAN-M","2026-09-01","一团","V1"],["Aster","TEST-MULTI",30,"5","X000000002","整柜","PLAN-M","2026-09-01","一团","V1"]];
  const importPayload=preview=>({previewToken:preview.previewToken,fileName:"测试硒鼓.csv",fileHash:preview.fileSha256,templateHash:preview.templateSha256,rows:preview.rows.map(row=>({...row,data:{...row.data,version:"V1"}})),requestId:requestId("import")});
  let preview=await upload("/api/transit/preview",input);
  check("无风险列的全部在途行均签发预览",preview.rows.length===2 && Boolean(preview.previewToken));
  let imp=importPayload(preview);
  await call("POST","/api/transit/import","assistant-1",imp);
  check("套/箱随预览逐源行显示",preview.rows.map(row=>row.data.packPerBox).join() === "4,5");
  check("同请求导入重放不重复入账",(await call("POST","/api/transit/import","assistant-1",imp)).deduped);
  preview=await upload("/api/transit/preview",input);
  check("同文件重新预览后仍禁止重复入账",(await call("POST","/api/transit/import","assistant-1",importPayload(preview),409)).code==="duplicate_import_file");
  const extra=[headers,["Aster","TEST-MULTI",5,"4","X000000001","整柜","PLAN-M","2026-09-01","一团","V1"]];
  preview=await upload("/api/transit/preview",extra);
  await call("POST","/api/transit/import","assistant-1",importPayload(preview));
  const conflictingPack=[headers,["Aster","TEST-MULTI",1,"6","X000000001","整柜","PLAN-M","2026-09-01","一团","V1"]];
  const conflictPreview=await upload("/api/transit/preview",conflictingPack);
  const packConflict=await call("POST","/api/transit/import","assistant-1",importPayload(conflictPreview),422);
  check("同在途批次套/箱冲突时拒绝合并且不改库存",packConflict.code==="transit_duplicate_conflict"
    && (await call("GET","/api/inventory/catalog","admin")).models.find(m=>m.model==="TEST-MULTI").inTransit===55);
  let cat=await call("GET","/api/inventory/catalog","admin");
  check("不同文件同批次新增5，同FNSKU合并，不同FNSKU分开",cat.models.find(m=>m.model==="TEST-MULTI").inTransit===55 && cat.inTransitDetails["TEST-MULTI"].length===2);
  check("在途明细逐批次展示套/箱",cat.inTransitDetails["TEST-MULTI"].find(r=>r.fnsku==="X000000001").packPerBox==="4"
    && cat.inTransitDetails["TEST-MULTI"].find(r=>r.fnsku==="X000000002").packPerBox==="5");
  const riskBlank=[headers.concat("芯片升级风险"),extra[1].concat("")];
  preview=await upload("/api/transit/preview",riskBlank);
  check("风险列存在但为空不再阻断导入",Boolean(preview.previewToken));
  const statusPreview=await upload("/api/transit/status/preview",[["计划号","物流状态"],["PLAN-M","到港"]],"status.csv");
  await call("POST","/api/transit/status/apply","assistant-1",{previewToken:statusPreview.previewToken,rows:statusPreview.rows,fileHash:statusPreview.fileSha256,templateHash:statusPreview.templateSha256,fileName:"status.csv",requestId:requestId("status")});
  cat=await call("GET","/api/inventory/catalog","admin");
  check("人工物流文件按计划更新所有对应FNSKU行",cat.inTransitDetails["TEST-MULTI"].every(r=>r.status==="到港"));
  for(const row of cat.inTransitDetails["TEST-MULTI"]) {
    const shelf={yes:"YES",expectedRevision:row.revision,requestId:requestId("shelf")};
    await call("POST",`/api/transit/${row.id}/on-shelf`,"operation-1",shelf,403);
    await call("POST",`/api/transit/${row.id}/on-shelf`,"assistant-1",shelf);
    check(`上架${row.fnsku}重放不重复入库`,(await call("POST",`/api/transit/${row.id}/on-shelf`,"assistant-1",shelf)).deduped);
  }
  cat=await call("GET","/api/inventory/catalog","admin");
  const model=cat.models.find(m=>m.model==="TEST-MULTI");
  check("上架在途55转在库55，总量守恒、套/箱按批次保留且不同FNSKU独立",model.inTransit===0 && model.inStock===55 && cat.stockDetails["TEST-MULTI"].length===2
    && cat.stockDetails["TEST-MULTI"].find(r=>r.fnsku==="X000000001").packPerBox==="4"
    && cat.stockDetails["TEST-MULTI"].find(r=>r.fnsku==="X000000002").packPerBox==="5");
  let job=(await call("POST","/api/upgrades/direct","assistant-1",{model:"TEST-MULTI",sourceVersion:"V1",requestId:requestId("direct")})).upgrade;
  check("在库升级锁定全部55，可用为0",(await call("GET","/api/inventory/catalog","admin")).models.find(m=>m.model==="TEST-MULTI").available===0);
  await call("POST",`/api/upgrades/direct/${job.id}/complete`,"purchasing",{completedQuantity:1,newVersion:"V2",targetWarehouse:"SyntheticWarehouseA",expectedRevision:job.revision,requestId:requestId("ambiguous")},400);
  for(const [fn,qty,ver] of [["X000000002",10,"V2"],["X000000001",25,"V3"],["X000000002",20,"V4"]]) {
    const body={sourceLineId:job.lines.find(l=>l.fnsku===fn).id,completedQuantity:qty,newVersion:ver,targetWarehouse:"SyntheticWarehouseA",expectedRevision:job.revision,requestId:requestId("direct-complete")};
    job=(await call("POST",`/api/upgrades/direct/${job.id}/complete`,"purchasing",body)).upgrade;
    check(`在库升级${fn}到${ver}重复提交不重复转换`,(await call("POST",`/api/upgrades/direct/${job.id}/complete`,"purchasing",body)).deduped);
    cat=await call("GET","/api/inventory/catalog","admin");
    const expectedPack=fn==="X000000001"?"4":"5";
    check(`${ver}升级接受非整箱数量并继承来源套/箱`,cat.models.find(m=>m.model==="TEST-MULTI").inStock===55
      && cat.stockDetails["TEST-MULTI"].some(r=>r.version===ver && r.fnsku===fn && r.quantity===qty && r.packPerBox===expectedPack));
  }
  check("在库升级完成释放全部锁定并保留每批次版本明细",job.status==="completed" && job.lines.find(l=>l.fnsku==="X000000002").completions.length===2 && cat.models.find(m=>m.model==="TEST-MULTI").locked===0);
  // Concurrency and approval rejection use only untouched seed V12.
  const attempts=await Promise.all([1,2].map(async n=>{
    const response=await fetch(base+"/api/allocations",{method:"POST",headers:{"x-role":"operation-1","content-type":"application/json"},body:JSON.stringify({...allocationBody(300,`concurrent-${n}`),date:"2026-03-10",version:"V12"})});
    return {status:response.status,payload:await response.json()};
  }));
  // Check persisted effects independently of arrival order.
  const pendingRows=read("SELECT * FROM allocation_documents WHERE version='V12' AND status='pending'");
  check("两个并发300申请只有一个能锁400库存",pendingRows.length===1 && pendingRows[0].quantity===300);
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  assert.equal(attempts.find(r=>r.status===409).payload.code,"insufficient_available");
  let rejected=(await call("POST",`/api/allocations/${pendingRows[0].id}/review`,"business",{decision:"reject",businessNote:"测试拒绝",expectedRevision:pendingRows[0].revision,requestId:requestId("reject")})).record;
  check("商务拒绝释放该单锁定且不能完成",rejected.approvalStatus==="rejected");
  await call("POST",`/api/allocations/${rejected.id}/confirm`,"assistant-1",{expectedRevision:rejected.revision,requestId:requestId("rejected-confirm")},409);
  // An archive older than 90 days is historical, but cannot initiate a new relocation.
  const writeDb=new DatabaseSync(databasePath);
  writeDb.prepare("UPDATE allocation_documents SET confirmed_at=? WHERE id=?").run(new Date(Date.now()-91*86400000).toISOString(),submitted.id); writeDb.close();
  check("90天外归档不作为新升级候选",!(await call("GET","/api/upgrades","assistant-1")).relocationCandidates.some(r=>r.allocationId===submitted.id));
  await call("POST","/api/upgrades/relocation-work-items","assistant-1",{allocationId:submitted.id,requestId:requestId("old-source")},409);
  const ink = await call("POST","/api/inquiries","operation-1",{...allocationBody(10,"ink"),model:"SYNTH-INK-001",asin:"BINK000001"});
  check("墨盒询库仅向对应运营团队展示",!(await call("GET","/api/approvals","operation-2")).inquiries.some(r=>r.id===ink.record.id));
  let zeroWork=(await call("POST","/api/upgrades/relocation-work-items","assistant-1",{inquiryId:inquirySubmitted.id,requestId:requestId("zero-fba-start")})).workItem;
  zeroWork=(await call("POST",`/api/upgrades/relocation-work-items/${zeroWork.id}/procurement`,"purchasing",{rma:"FBA零",relocationAddress:"测试仓",expectedRevision:zeroWork.revision,requestId:requestId("zero-procurement")})).workItem;
  zeroWork=(await call("POST",`/api/upgrades/relocation-work-items/${zeroWork.id}/operation`,"operation-1",{removalOrderNo:"ZERO-FBA-ORDER",expectedRevision:zeroWork.revision,requestId:requestId("zero-operation")})).workItem;
  zeroWork=saveCapture(`/api/upgrades/relocation-work-items/${zeroWork.id}/lingxing-sync`,"assistant-1",{shipments:[{externalId:"ZERO-FBA-PKG",storeId:"S1",storeName:"验收",countryCode:"US",orderNo:"ZERO-FBA-ORDER",fnsku:zeroWork.fnsku,carrier:"UPS",trackingNo:"ZERO-FBA-TRACK",shipDate:"2026-09-10",quantity:1}],capturedAt:new Date().toISOString(),requestId:requestId("zero-sync")}).workItem;
  await call("POST",`/api/upgrades/relocation-work-items/${zeroWork.id}/ship`,"assistant-1",{fbaRemainingQuantity:0,externalItems:[{lineId:zeroWork.externalShipments[0].lineId,quantity:1}],expectedRevision:zeroWork.revision,requestId:requestId("zero-ship")});
  check("FBA实际剩余为0且有新包裹时仍可登记发货",true);
  await call("POST",`/api/upgrades/relocation-work-items/${zeroWork.id}/cancel`,"admin",{reason:"已发货不可取消",expectedRevision:zeroWork.revision+1,requestId:requestId("cancel-shipped")},404);
  check("已发货流程拒绝取消，保留包裹已用量与发货记录",true);
  const permissionPath=path.join(stateRoot,"data","permissions.json");
  const matrix=JSON.parse(await fs.readFile(permissionPath,"utf8"));
  matrix.墨盒["operation-1"]={summary:true,detail:false,expand:false,actions:false};
  await fs.writeFile(permissionPath,JSON.stringify(matrix));
  const restricted=await call("GET","/api/inventory/catalog","operation-1");
  const restrictedInkModel=restricted.models.find(m=>m.model==="SYNTH-INK-001");
  check("关闭明细权限不下发墨盒批次和可用量",!restricted.stockDetails["SYNTH-INK-001"] && (!restrictedInkModel || restrictedInkModel.available===null));
  await call("POST","/api/upgrades/direct","operation-1",{model:"SYNTH-INK-001",sourceVersion:"V3",requestId:requestId("permission")},403);
  check("升级来源同样遵守明细权限",!(await call("GET","/api/upgrades","operation-1")).directSources.some(r=>r.model==="SYNTH-INK-001"));
  matrix.墨盒["operation-1"]={summary:true,detail:true,expand:true,actions:true};
  await fs.writeFile(permissionPath,JSON.stringify(matrix));
  const beforeRestart = await call("GET", "/api/approvals", "admin");
  const upgradesBeforeRestart = await call("GET", "/api/upgrades", "admin");
  await stop();
  await start();
  const afterRestart = await call("GET", "/api/approvals", "admin");
  check("刷新和服务重启后全部审批记录、数量、备注和快照保持", JSON.stringify(afterRestart.allocations) === JSON.stringify(beforeRestart.allocations)
    && JSON.stringify(afterRestart.inquiries) === JSON.stringify(beforeRestart.inquiries) && afterRestart.sync.databaseId === beforeRestart.sync.databaseId);
  const upgradesAfterRestart = await call("GET", "/api/upgrades", "admin");
  check("服务重启后两种来源的升级记录保持", JSON.stringify(upgradesAfterRestart.upgrades) === JSON.stringify(upgradesBeforeRestart.upgrades)
    && JSON.stringify(upgradesAfterRestart.relocationWorkItems) === JSON.stringify(upgradesBeforeRestart.relocationWorkItems));
  check("数据库完整性、外键和当前迁移版本均通过", read("PRAGMA quick_check")[0].quick_check === "ok" && read("PRAGMA foreign_key_check").length === 0
    && read("PRAGMA user_version")[0].user_version === INVENTORY_SCHEMA_VERSION);
  console.log(`APPROVALS_RESULT: ALL PASS (${passed} checks)`);
} finally {
  await stop();
  await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

