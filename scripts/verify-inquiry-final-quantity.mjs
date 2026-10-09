import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  INVENTORY_SCHEMA_VERSION,
  InventoryDatabase,
  INVENTORY_DATABASE_NAME,
  migrateInventoryDatabaseToCurrent,
} from "../inventory-db.mjs";
import { createSchema26Fixture } from "./fixtures/schema26-fixture.mjs";

const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aster-inquiry-final-quantity-"));
const databasePath = path.join(stateRoot, "data", INVENTORY_DATABASE_NAME);
const requestId = (label) => `${label}-${crypto.randomUUID()}`;
const check = (label, condition) => { assert.ok(condition, label); console.log(`PASS ${label}`); };
const previousPrivatePath = process.env.ASTER_PRIVATE_INBOUND_SOURCES;
let legacy = null;
let db = null;

try {
  const fixture = await createSchema26Fixture(stateRoot);
  legacy = new DatabaseSync(databasePath);
  assert.equal(legacy.prepare("PRAGMA user_version").get().user_version, 26);
  const inquirySchema = legacy.prepare("SELECT sql FROM sqlite_master WHERE name='inquiry_documents'").get().sql;
  assert.match(inquirySchema, /requested_quantity > 0/);
  assert.match(inquirySchema, /supplier_quantity >= 0/);
  legacy.prepare(`INSERT OR IGNORE INTO catalog_models(model,category,base_in_stock,in_transit,updated_at)
    VALUES('SYNTH-ITEM-001','硒鼓',0,0,?)`).run(new Date().toISOString());

  function historicalInquiry(requested, approved, supplier, suffix) {
    const template = legacy.prepare("SELECT * FROM inquiry_documents ORDER BY id LIMIT 1").get();
    assert.ok(template, "schema26 fixture must contain a synthetic inquiry");
    const row = {
      ...template,
      document_no: `SYNTH-INQ-${suffix}-${crypto.randomUUID()}`,
      model: "SYNTH-ITEM-001",
      department: "一团",
      requested_quantity: requested,
      approved_quantity: approved,
      supplier_quantity: supplier,
      status: supplier == null ? "pending_business" : "archived",
      plan: `TEST-PLAN-${suffix}`,
      ship_date: "2026-01-01",
      version: "TEST-V1",
      fnsku: `TEST-FNSKU-${suffix}`,
      asin: `TEST-ASIN-${suffix}`,
      archived_at: supplier == null ? null : "2026-01-01T00:00:00.000Z",
      archived_by_role: supplier == null ? null : "assistant-1",
    };
    delete row.id;
    const columns = Object.keys(row);
    const id = Number(legacy.prepare(`INSERT INTO inquiry_documents(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
      .run(...Object.values(row)).lastInsertRowid);
    legacy.prepare(`INSERT INTO inquiry_events(inquiry_id,event_type,role,occurred_at,payload_json)
      VALUES(?,'entry','operation-1',?,?)`)
      .run(id, "2026-01-01T00:00:00.000Z", JSON.stringify({ requestedQuantity: requested, approvedQuantity: approved, supplierQuantity: supplier }));
    return { id };
  }

  const positive = historicalInquiry(80, 40, 20, "POS");
  const zero = historicalInquiry(70, 40, 0, "ZERO");
  const unreplied = historicalInquiry(11, null, null, "NONE");
  const beforeDataVersion = Number(legacy.prepare("SELECT value FROM system_meta WHERE key='data_version'").get().value);
  const beforeCatalog = legacy.prepare("SELECT model,base_in_stock,in_transit FROM catalog_models ORDER BY model").all();
  const beforeLedger = legacy.prepare("SELECT * FROM inventory_ledger ORDER BY id").all();
  const beforeEvents = legacy.prepare("SELECT * FROM inquiry_events WHERE inquiry_id IN (?,?) ORDER BY id").all(positive.id, zero.id);
  const beforeRows = legacy.prepare("SELECT * FROM inquiry_documents WHERE id IN (?,?,?) ORDER BY id").all(positive.id, zero.id, unreplied.id);
  legacy.close();
  legacy = null;

  process.env.ASTER_PRIVATE_INBOUND_SOURCES = path.join(stateRoot, "missing-private-source.json");
  assert.throws(
    () => migrateInventoryDatabaseToCurrent({ databasePath }),
    /歷史迁移需要 47 条私有在途来源数据|历史迁移需要 47 条私有在途来源数据/,
  );
  const unchanged = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(unchanged.prepare("PRAGMA user_version").get().user_version, 26);
  unchanged.close();
  check("缺失本地迁移来源时拒绝迁移，旧数据库版本保持不变", true);

  process.env.ASTER_PRIVATE_INBOUND_SOURCES = fixture.privateDataPath;
  const migration = migrateInventoryDatabaseToCurrent({ databasePath, appliedAt: "2026-01-02T00:00:00.000Z" });
  db = new InventoryDatabase(stateRoot);

  const afterRows = db.db.prepare("SELECT * FROM inquiry_documents WHERE id IN (?,?,?) ORDER BY id").all(positive.id, zero.id, unreplied.id);
  check("v26 数据迁移将正数与零回复的申请量回填为采购最终量", afterRows[0].requested_quantity === 20 && afterRows[1].requested_quantity === 0);
  check("未回复单据保持原申请量，完成时间、版本与更新时间不变", afterRows[2].requested_quantity === 11
    && afterRows[0].archived_at === beforeRows[0].archived_at && afterRows[0].revision === beforeRows[0].revision
    && afterRows[0].updated_at === beforeRows[0].updated_at && afterRows[1].archived_at === beforeRows[1].archived_at
    && afterRows[1].revision === beforeRows[1].revision && afterRows[1].updated_at === beforeRows[1].updated_at);
  check("原申请、商务审核及供应商回复事件完整不变", JSON.stringify(db.db.prepare("SELECT * FROM inquiry_events WHERE inquiry_id IN (?,?) ORDER BY id").all(positive.id, zero.id)) === JSON.stringify(beforeEvents));
  check("数据迁移仅更新询库申请量，库存与锁定账本不变", JSON.stringify(db.db.prepare("SELECT model,base_in_stock,in_transit FROM catalog_models ORDER BY model").all()) === JSON.stringify(beforeCatalog)
    && JSON.stringify(db.db.prepare("SELECT * FROM inventory_ledger ORDER BY id").all()) === JSON.stringify(beforeLedger));
  check("迁移修正全部 47 条合成在途来源并提交 schema29", migration.sourceInventory?.verifiedTransitRows === 47
    && migration.sourceInventory.transitChanges.length === 47
    && migration.toVersion === INVENTORY_SCHEMA_VERSION
    && db.db.prepare("PRAGMA user_version").get().user_version === INVENTORY_SCHEMA_VERSION
    && db.db.prepare("PRAGMA foreign_key_check").all().length === 0);
  check("零回复单不进入移仓候选，正数已完成询库来源保留最终数量", !db.getRelocationCandidates({ model: "SYNTH-ITEM-001" }).some(row => row.inquiryId === zero.id)
    && db.getRelocationCandidates({ model: "SYNTH-ITEM-001" }).some(row => row.inquiryId === positive.id && row.initialQuantity === 20));
  assert.throws(() => db.createInquiry({ role: "operation-1", model: "SYNTH-ITEM-001", quantity: 0, department: "一团",
    store: "SYNTHUS", operator: "SyntheticOperator", fnsku: "TEST-FNSKU-NEW", asin: "TEST-ASIN-NEW", requestId: requestId("new-zero") }), /大于 0/);
  check("新建询库仍拒绝零申请量", true);
  assert.equal(db.syncState().dataVersion, beforeDataVersion + 1);
  db.assertInventoryInvariants();
} finally {
  legacy?.close();
  db?.close();
  if (previousPrivatePath === undefined) delete process.env.ASTER_PRIVATE_INBOUND_SOURCES;
  else process.env.ASTER_PRIVATE_INBOUND_SOURCES = previousPrivatePath;
  assert.equal(path.dirname(stateRoot), os.tmpdir());
  await fs.rm(stateRoot, { recursive: true, force: true });
}
