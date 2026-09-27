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
let schema29 = null;

function createSchema28Fixture(databasePath) {
  const fixture = new DatabaseSync(databasePath);
  try {
    fixture.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL,description TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(28,'2026-01-01T00:00:00.000Z','synthetic schema28');
      CREATE TABLE system_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
      INSERT INTO system_meta VALUES('data_version','7'),('updated_at','2026-01-01T00:00:00.000Z');
      CREATE TABLE catalog_models(model TEXT PRIMARY KEY) STRICT;
      INSERT INTO catalog_models VALUES('SYNTH-MIGRATION-001');
      CREATE TABLE inquiry_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_no TEXT NOT NULL UNIQUE,
        model TEXT NOT NULL REFERENCES catalog_models(model),
        requested_quantity INTEGER NOT NULL CHECK (requested_quantity >= 0),
        approved_quantity INTEGER CHECK (approved_quantity > 0),
        supplier_quantity INTEGER CHECK (supplier_quantity >= 0),
        business_note TEXT NOT NULL DEFAULT '',
        shipping_warehouse TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_inquiry_status_model ON inquiry_documents(status,model);
      CREATE TABLE inquiry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inquiry_id INTEGER NOT NULL REFERENCES inquiry_documents(id),
        event_type TEXT NOT NULL,
        role TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TRIGGER inquiry_events_no_update BEFORE UPDATE ON inquiry_events
        BEGIN SELECT RAISE(ABORT,'inquiry history is immutable'); END;
      CREATE VIEW relocation_sources AS SELECT id,requested_quantity FROM inquiry_documents;
      INSERT INTO inquiry_documents(id,document_no,model,requested_quantity,approved_quantity,supplier_quantity,business_note,shipping_warehouse,status)
        VALUES(1,'SYNTH-INQ-HISTORY-1','SYNTH-MIGRATION-001',60,90,60,'商务历史','东莞旧仓','pending_assistant'),
              (2,'SYNTH-INQ-HISTORY-0','SYNTH-MIGRATION-001',0,40,0,'无货历史','','archived');
      INSERT INTO inquiry_events(inquiry_id,event_type,role,occurred_at,payload_json)
        VALUES(1,'entry','operation-1','2026-01-01T00:00:00.000Z','{"requestedQuantity":150}'),
              (1,'review','business','2026-01-01T00:00:01.000Z','{"approvedQuantity":90}'),
              (1,'reply','purchasing','2026-01-01T00:00:02.000Z','{"supplierQuantity":60}'),
              (2,'entry','operation-1','2026-01-01T00:00:00.000Z','{"requestedQuantity":70}'),
              (2,'review','business','2026-01-01T00:00:01.000Z','{"approvedQuantity":40}'),
              (2,'reply_no_stock_archive','purchasing','2026-01-01T00:00:02.000Z','{"supplierQuantity":0}');
      PRAGMA user_version=28;
    `);
  } finally {
    fixture.close();
  }
}

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
  check("旧版数据迁移修正全部 47 条合成在途来源并提交当前 schema", migration.sourceInventory?.verifiedTransitRows === 47
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

  const schema28Path = path.join(stateRoot, "schema28-without-private-sources.sqlite");
  createSchema28Fixture(schema28Path);
  const schema28Before = new DatabaseSync(schema28Path, { readOnly: true });
  const historicalRowsBefore = schema28Before.prepare("SELECT * FROM inquiry_documents ORDER BY id").all();
  const historicalEventsBefore = schema28Before.prepare("SELECT * FROM inquiry_events ORDER BY id").all();
  schema28Before.close();
  process.env.ASTER_PRIVATE_INBOUND_SOURCES = path.join(stateRoot, "missing-schema28-private-source.json");
  const schema28Migration = migrateInventoryDatabaseToCurrent({ databasePath: schema28Path, appliedAt: "2026-01-03T00:00:00.000Z" });
  schema29 = new DatabaseSync(schema28Path);
  const migratedRows = schema29.prepare("SELECT * FROM inquiry_documents ORDER BY id").all();
  const migratedEvents = schema29.prepare("SELECT * FROM inquiry_events ORDER BY id").all();
  const rebuiltSchema = schema29.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='inquiry_documents'").get().sql;
  check("schema28 可独立升级到 schema29，无需 47 条私有在途来源", schema28Migration.toVersion === INVENTORY_SCHEMA_VERSION
    && schema29.prepare("PRAGMA user_version").get().user_version === INVENTORY_SCHEMA_VERSION
    && schema28Migration.sourceInventory == null);
  check("schema28 升级保留已回复历史数量、旧仓库与事件，不回填采购备注", migratedRows.length === 2
    && migratedRows.every((row, index) => row.requested_quantity === historicalRowsBefore[index].requested_quantity
      && row.approved_quantity === historicalRowsBefore[index].approved_quantity
      && row.supplier_quantity === historicalRowsBefore[index].supplier_quantity
      && row.shipping_warehouse === historicalRowsBefore[index].shipping_warehouse
      && row.purchase_note === "")
    && JSON.stringify(migratedEvents) === JSON.stringify(historicalEventsBefore));
  check("schema29 允许新采购回复将商务审核数量写为0并保留数据库对象", /approved_quantity INTEGER CHECK \(approved_quantity >= 0\)/.test(rebuiltSchema)
    && schema29.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='relocation_sources'").get() != null
    && schema29.prepare("SELECT version FROM schema_migrations WHERE version=29").get() != null
    && schema29.prepare("PRAGMA foreign_key_check").all().length === 0
    && schema29.prepare("PRAGMA integrity_check").get().integrity_check === "ok");
  schema29.prepare("UPDATE inquiry_documents SET approved_quantity=0 WHERE id=1").run();
  check("schema29 的商务审核数量约束允许采购回复0覆盖", schema29.prepare("SELECT approved_quantity FROM inquiry_documents WHERE id=1").get().approved_quantity === 0);
} finally {
  legacy?.close();
  db?.close();
  schema29?.close();
  if (previousPrivatePath === undefined) delete process.env.ASTER_PRIVATE_INBOUND_SOURCES;
  else process.env.ASTER_PRIVATE_INBOUND_SOURCES = previousPrivatePath;
  assert.equal(path.dirname(stateRoot), os.tmpdir());
  await fs.rm(stateRoot, { recursive: true, force: true });
}
