import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateRequirementsV30 } from "./migrations/requirements-5-9.mjs";
import { accountForStore, processWarehouseAddress, lingxingStoreCode } from './warehouse-address.mjs';

export const INVENTORY_SCHEMA_VERSION = 30;
function loadLocalRuntimeConfig() {
  const configPath = path.resolve(process.env.ASTER_RUNTIME_CONFIG
    || path.join(import.meta.dirname, ".local-private", "runtime-config.local.json"));
  if (!fs.existsSync(configPath)) return null;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取本地运行配置 ${configPath}: ${error.message}`);
  }
  if (config?.schemaVersion !== 1 || !Array.isArray(config.overseasWarehouses)) {
    throw new Error(`本地运行配置格式无效：${configPath}`);
  }
  return config;
}

const localRuntimeConfig = loadLocalRuntimeConfig();
const configuredWarehouses = process.env.ASTER_OVERSEAS_WAREHOUSES
  ? process.env.ASTER_OVERSEAS_WAREHOUSES.split(";")
  : localRuntimeConfig?.overseasWarehouses;
export const OVERSEAS_WAREHOUSES = Object.freeze([...new Set(
  (configuredWarehouses ?? ["SyntheticWarehouseA", "SyntheticWarehouseB"])
    .map(value => String(value ?? "").trim()).filter(Boolean),
)]);
if (OVERSEAS_WAREHOUSES.length === 0) throw new Error("至少需要配置一个海外仓名称。");
export const INVENTORY_DATABASE_NAME = "aster-inventory.sqlite";
const MODEL_DELETE_META_KEY = "catalog_model_delete_model";
const TRANSIT_MUTATION_META_KEY = "transit_mutation_transit_id";
const LEGACY_PLACEHOLDER_CLEANUP_REQUEST_ID = "schema-v13-legacy-placeholder-cleanup";

export const ASSISTANT_ROLES = Object.freeze(["assistant-1", "assistant-2"]);
const ASSISTANT_ROLE_SET = new Set(ASSISTANT_ROLES);
export const ROLES = Object.freeze(["admin", ...ASSISTANT_ROLES, "operation-1", "operation-2", "purchasing", "business", "alan", "logistics"]);
const UPGRADE_ROLE_SET = new Set(["admin", ...ASSISTANT_ROLES, "operation-1", "operation-2", "purchasing", "logistics"]);
export const BUSINESS_ROLE = "business";
export const TRANSIT_ROLES = Object.freeze(["admin", ...ASSISTANT_ROLES, "purchasing", "logistics"]);
const TRANSIT_ROLE_SET = new Set(TRANSIT_ROLES);
export const TRANSIT_SHELF_ROLES = Object.freeze(["admin", ...ASSISTANT_ROLES]);
const TRANSIT_SHELF_ROLE_SET = new Set(TRANSIT_SHELF_ROLES);
export const OPERATION_GROUPS = { "operation-1": "一团", "operation-2": "二团", "assistant-1": "一团", "assistant-2": "二团" };

export function requireValidStoreCode(value) {
  const store = String(value ?? "");
  if (!store.includes("US") || store.includes("-")) throw new BusinessError(400, "invalid_store_format", "店铺名称须包含大写 US，且不能包含‘-’。");
  return store;
}

function requireDepartment(role, department) {
  const group = OPERATION_GROUPS[role];
  if (group && department !== group) throw new BusinessError(403, "group_forbidden", `当前角色仅可处理本团（${group}）记录`);
}

const STATUS_TEXT = {
  draft: "待修改",
  pending: "调拨中，预锁定",
  confirmed: "调拨完成，已备份",
  cancelled: "已撤销",
  withdrawn: "已撤回",
};

const CATALOG = [
  {
    model: "SYNTH-TONER-001",
    category: "硒鼓",
    baseInStock: 2000,
    inTransit: 1000,
    batches: [
      { plan: "TEST-PLAN-TONER", date: "2026-01-10", version: "V10", fnsku: "TEST-FNSKU-TONER-01", quantity: 800 },
      { plan: "TEST-PLAN-TONER", date: "2026-02-10", version: "V11", fnsku: "TEST-FNSKU-TONER-02", quantity: 500 },
      { plan: "TEST-PLAN-TONER", date: "2026-03-10", version: "V12", fnsku: "TEST-FNSKU-TONER-03", quantity: 400 },
      { plan: "TEST-PLAN-TONER", date: "2026-04-10", version: "V13", fnsku: "TEST-FNSKU-TONER-04", quantity: 300 },
    ],
    transit: [
      /* 活动在途记录按五字段唯一；演示数据保留原合计 1000，但用一行表示。 */
      { quantity: 1000, plan: "TEST-PLAN-TONER", date: "2026-01-10", version: "V10", fnsku: "TEST-FNSKU-TONER-01", status: "订单部更新物流状态", onShelf: "填写 YES" },
    ],
  },
  { model: "SYNTH-TONER-002", category: "硒鼓", baseInStock: 0, inTransit: 0, batches: [], transit: [] },
  {
    model: "SYNTH-INK-001",
    category: "墨盒",
    baseInStock: 300,
    inTransit: 0,
    batches: [
      { plan: "TEST-PLAN-INK-A", date: "2026-02-15", version: "V3", fnsku: "TEST-FNSKU-INK-01", quantity: 180 },
      { plan: "TEST-PLAN-INK-B", date: "2026-03-01", version: "V4", fnsku: "TEST-FNSKU-INK-02", quantity: 120 },
    ],
    transit: [],
  },
];

export class BusinessError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "BusinessError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function transitCategoryFromFileName(fileName) {
  const name = String(fileName ?? "").trim();
  const hasToner = name.includes("硒鼓");
  const hasInk = name.includes("墨盒");
  if (hasToner === hasInk) {
    throw new BusinessError(422, "transit_category_unrecognized", "文件名无法唯一识别类目（硒鼓或墨盒）");
  }
  return hasToner ? "硒鼓" : "墨盒";
}

function batchKey(model, plan, date, version) {
  return [model, plan, date, version].join("#");
}

/* 物流状态表的计划编号只去除首尾普通空格和不间断空格；内部字符、大小写和其他字符保持原样。 */
export function normalizeTransitPlan(value) {
  return String(value ?? "").replace(/^[ \u00a0]+|[ \u00a0]+$/g, "");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function configureDatabase(db) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");
}

function createCorrectionSchema(db) {
  db.exec(`
    CREATE TABLE correction_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correction_no TEXT NOT NULL UNIQUE,
      root_document_id INTEGER NOT NULL REFERENCES allocation_documents(id),
      source_document_id INTEGER NOT NULL REFERENCES allocation_documents(id),
      result_document_id INTEGER REFERENCES allocation_documents(id),
      correction_type TEXT NOT NULL,
      application_reason TEXT NOT NULL,
      applicant_name TEXT NOT NULL,
      applicant_role TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'rejected', 'cancelled', 'execution_failed')),
      source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
      proposed_quantity INTEGER NOT NULL CHECK (proposed_quantity > 0),
      proposed_department TEXT NOT NULL CHECK (proposed_department IN ('一团', '二团')),
      proposed_store_name TEXT NOT NULL,
      proposed_operator_name TEXT NOT NULL,
      original_snapshot_json TEXT NOT NULL,
      proposed_snapshot_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      reviewed_by_role TEXT,
      reviewed_by_name TEXT,
      reviewed_at TEXT,
      review_comment TEXT,
      processed_by_role TEXT,
      processed_by_name TEXT,
      processed_at TEXT,
      cancelled_by_role TEXT,
      cancelled_by_name TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      failure_code TEXT,
      failure_reason TEXT,
      failed_at TEXT,
      impact_hash TEXT,
      reversal_group TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE correction_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correction_id INTEGER NOT NULL REFERENCES correction_requests(id),
      event_type TEXT NOT NULL,
      role TEXT NOT NULL,
      operator_name TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;

    CREATE INDEX idx_corrections_status_time ON correction_requests(status, applied_at DESC, id DESC);
    CREATE INDEX idx_corrections_source ON correction_requests(source_document_id, id DESC);
    CREATE INDEX idx_corrections_root ON correction_requests(root_document_id, id DESC);
    CREATE INDEX idx_corrections_model_search ON correction_requests(source_document_id, status);
    CREATE INDEX idx_correction_events_request ON correction_events(correction_id, id);

    CREATE TRIGGER correction_requests_no_delete
    BEFORE DELETE ON correction_requests
    BEGIN SELECT RAISE(ABORT, '纠错单禁止删除'); END;

    CREATE TRIGGER correction_events_no_update
    BEFORE UPDATE ON correction_events
    BEGIN SELECT RAISE(ABORT, '纠错处理记录禁止覆盖'); END;

    CREATE TRIGGER correction_events_no_delete
    BEFORE DELETE ON correction_events
    BEGIN SELECT RAISE(ABORT, '纠错处理记录禁止删除'); END;
  `);
}

function createActiveCorrectionConstraint(db) {
  db.exec(`
    CREATE UNIQUE INDEX uq_corrections_one_active_per_root
    ON correction_requests(root_document_id)
    WHERE status IN ('pending', 'processing', 'execution_failed');
  `);
}

/* v8 -> v9：仅为管理员型号永久删除事务增加临时操作标识。
   普通业务不写入该标识，历史保护触发器仍然拒绝覆盖/删除；共享导入事件、
   幂等响应和逻辑快照的裁剪也只能在同一专用事务中进行。迁移可重复执行。 */
function migrateCatalogModelDeleteSchemaV9(db, appliedAt) {
  db.exec(`
    DROP TRIGGER IF EXISTS correction_requests_no_delete;
    DROP TRIGGER IF EXISTS correction_events_no_update;
    DROP TRIGGER IF EXISTS correction_events_no_delete;
    DROP TRIGGER IF EXISTS inventory_ledger_no_update;
    DROP TRIGGER IF EXISTS inventory_ledger_no_delete;
    DROP TRIGGER IF EXISTS document_events_no_update;
    DROP TRIGGER IF EXISTS document_events_no_delete;
    DROP TRIGGER IF EXISTS allocation_documents_no_delete;
    DROP TRIGGER IF EXISTS transit_batches_no_delete;
    DROP TRIGGER IF EXISTS stock_receipts_no_update;
    DROP TRIGGER IF EXISTS stock_receipts_no_delete;
    DROP TRIGGER IF EXISTS transit_events_no_update;
    DROP TRIGGER IF EXISTS transit_events_no_delete;
    DROP TRIGGER IF EXISTS transit_import_snapshots_no_update;
    DROP TRIGGER IF EXISTS transit_import_snapshots_no_delete;

    CREATE TRIGGER correction_requests_no_delete
    BEFORE DELETE ON correction_requests
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '纠错单禁止删除'); END;

    CREATE TRIGGER correction_events_no_update
    BEFORE UPDATE ON correction_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '纠错处理记录禁止覆盖'); END;

    CREATE TRIGGER correction_events_no_delete
    BEFORE DELETE ON correction_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '纠错处理记录禁止删除'); END;

    CREATE TRIGGER inventory_ledger_no_update
    BEFORE UPDATE ON inventory_ledger
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '库存流水禁止覆盖'); END;

    CREATE TRIGGER inventory_ledger_no_delete
    BEFORE DELETE ON inventory_ledger
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '库存流水禁止删除'); END;

    CREATE TRIGGER document_events_no_update
    BEFORE UPDATE ON document_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '历史事件禁止覆盖'); END;

    CREATE TRIGGER document_events_no_delete
    BEFORE DELETE ON document_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '历史事件禁止删除'); END;

    CREATE TRIGGER allocation_documents_no_delete
    BEFORE DELETE ON allocation_documents
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '业务单据禁止删除'); END;

    CREATE TRIGGER transit_batches_no_delete
    BEFORE DELETE ON transit_batches
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
          <> COALESCE(OLD.import_batch_id, -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1)
          <> OLD.id
    BEGIN SELECT RAISE(ABORT, '在途记录禁止删除'); END;

    CREATE TRIGGER stock_receipts_no_update
    BEFORE UPDATE ON stock_receipts
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '上架入库凭证禁止覆盖'); END;

    CREATE TRIGGER stock_receipts_no_delete
    BEFORE DELETE ON stock_receipts
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
          <> COALESCE((SELECT import_batch_id FROM transit_batches WHERE id = OLD.transit_id), -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1)
          <> OLD.transit_id
    BEGIN SELECT RAISE(ABORT, '上架入库凭证禁止删除'); END;

    CREATE TRIGGER transit_events_no_update
    BEFORE UPDATE ON transit_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '在途事件禁止覆盖'); END;

    CREATE TRIGGER transit_events_no_delete
    BEFORE DELETE ON transit_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
          <> COALESCE((SELECT import_batch_id FROM transit_batches WHERE id = OLD.transit_id), -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1)
          <> OLD.transit_id
    BEGIN SELECT RAISE(ABORT, '在途事件禁止删除'); END;

    CREATE TRIGGER transit_import_snapshots_no_update
    BEFORE UPDATE ON transit_import_snapshots
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '在途导入逻辑快照禁止覆盖'); END;

    CREATE TRIGGER transit_import_snapshots_no_delete
    BEFORE DELETE ON transit_import_snapshots
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '在途导入逻辑快照禁止删除'); END;
  `);
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 9").get()) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (9, ?, ?)")
      .run(appliedAt, "管理员型号永久删除专用事务与共享历史裁剪标识");
  }
}

/* v9 -> v10：为批次回退/重导增加最小的新旧关联字段，并为精确的在途
   数量贡献撤销增加独立临时标识。只重建两条在途删除触发器；其余历史保护
   触发器保持原有语义，普通业务不会写入该标识。迁移可重复执行。 */
function migrateTransitReplacementSchemaV10(db, appliedAt) {
  const importColumns = tableColumns(db, "import_batches");
  if (!importColumns.has("replaces_import_id")) {
    db.exec("ALTER TABLE import_batches ADD COLUMN replaces_import_id INTEGER REFERENCES import_batches(id)");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_import_batches_replaces ON import_batches(replaces_import_id);

    DROP TRIGGER IF EXISTS transit_batches_no_delete;
    DROP TRIGGER IF EXISTS transit_events_no_delete;

    CREATE TRIGGER transit_batches_no_delete
    BEFORE DELETE ON transit_batches
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
          <> COALESCE(OLD.import_batch_id, -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1)
          <> OLD.id
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = '${TRANSIT_MUTATION_META_KEY}'), -1)
          <> OLD.id
    BEGIN SELECT RAISE(ABORT, '在途记录禁止删除'); END;

    CREATE TRIGGER transit_events_no_delete
    BEFORE DELETE ON transit_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
          <> COALESCE((SELECT import_batch_id FROM transit_batches WHERE id = OLD.transit_id), -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1)
          <> OLD.transit_id
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = '${TRANSIT_MUTATION_META_KEY}'), -1)
          <> OLD.transit_id
    BEGIN SELECT RAISE(ABORT, '在途事件禁止删除'); END;
  `);
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 10").get()) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (10, ?, ?)")
      .run(appliedAt, "在途导入批次重导关联与精确数量贡献回退标识");
  }
}

/* v10 -> v11：客户端会话清空接口已停用，活动批次不再按客户端会话、角色
   强制唯一。保留 client_session_id 作为来源元数据；文件哈希和 requestId
   继续分别承担普通导入判重与请求幂等。迁移可重复执行。 */
function migrateTransitClientSessionSchemaV11(db, appliedAt) {
  db.exec("DROP INDEX IF EXISTS uq_import_batches_active_client_session");
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 11").get()) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (11, ?, ?)")
      .run(appliedAt, "移除停用客户端会话清空流程遗留的活动批次唯一约束");
  }
}

/* v11 -> v12：在途导入不再按文件摘要判重，但兼容旧版暂存流程仍需保留
   活动文件唯一约束。用 import_kind 将两类流程隔离；历史已入账批次按其
   在途关联或导入元数据标记为 transit，其他历史批次保留 legacy。迁移不
   改写批次内容、数量或历史状态，只新增流程标识并重建唯一索引。 */
function migrateTransitImportDuplicatePolicySchemaV12(db, appliedAt) {
  const importColumns = tableColumns(db, "import_batches");
  if (!importColumns.has("import_kind")) {
    db.exec("ALTER TABLE import_batches ADD COLUMN import_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (import_kind IN ('legacy', 'transit'))");
  }
  db.exec(`
    UPDATE import_batches
    SET import_kind = 'transit'
    WHERE inventory_applied = 1
       OR replaces_import_id IS NOT NULL
       OR database_id IS NOT NULL
       OR client_session_id IS NOT NULL
       OR snapshot_id IS NOT NULL
       OR EXISTS (
         SELECT 1 FROM transit_batches
         WHERE transit_batches.import_batch_id = import_batches.id
       );

    DROP INDEX IF EXISTS uq_import_batches_active_file;
    CREATE UNIQUE INDEX uq_import_batches_active_file
      ON import_batches(file_sha256)
      WHERE status <> 'reverted' AND import_kind = 'legacy';
  `);
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 12").get()) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (12, ?, ?)")
      .run(appliedAt, "在途导入允许相同文件重复入账，保留非在途暂存流程文件判重");
  }
}

/* v12 -> v13：占位批次只允许作为旧数据的只读历史痕迹存在。
   新建库和升级库都安装数据库级防线；升级时清理活动占位，避免仅靠
   应用层约定导致脚本、迁移或并发写入重新制造无法调拨的批次。 */
function installLegacyPlaceholderGuards(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS stock_batches_no_legacy_placeholder_insert;
    CREATE TRIGGER stock_batches_no_legacy_placeholder_insert
    BEFORE INSERT ON stock_batches
    WHEN NEW.is_legacy_placeholder = 1
    BEGIN SELECT RAISE(ABORT, '禁止新建在库占位批次'); END;

    DROP TRIGGER IF EXISTS stock_batches_no_legacy_placeholder_update;
    CREATE TRIGGER stock_batches_no_legacy_placeholder_update
    BEFORE UPDATE OF is_legacy_placeholder ON stock_batches
    WHEN NEW.is_legacy_placeholder = 1
    BEGIN SELECT RAISE(ABORT, '禁止写入在库占位批次'); END;

    DROP TRIGGER IF EXISTS transit_batches_no_legacy_placeholder_insert;
    CREATE TRIGGER transit_batches_no_legacy_placeholder_insert
    BEFORE INSERT ON transit_batches
    WHEN NEW.is_legacy_placeholder = 1
    BEGIN SELECT RAISE(ABORT, '禁止新建在途占位批次'); END;

    DROP TRIGGER IF EXISTS transit_batches_no_legacy_placeholder_update;
    CREATE TRIGGER transit_batches_no_legacy_placeholder_update
    BEFORE UPDATE OF is_legacy_placeholder ON transit_batches
    WHEN NEW.is_legacy_placeholder = 1
    BEGIN SELECT RAISE(ABORT, '禁止写入在途占位批次'); END;
  `);
}

function recordLegacyPlaceholderRemoval(db, {
  kind,
  model,
  batchKey = null,
  transitId = null,
  quantity = 0,
  at,
}) {
  const normalizedQuantity = Math.max(0, Number(quantity) || 0);
  const onHandDelta = kind === "stock" ? -normalizedQuantity : 0;
  const inTransitDelta = kind === "transit" ? -normalizedQuantity : 0;
  const payload = {
    kind,
    model,
    batch: batchKey,
    batchKey,
    transitId,
    quantity: normalizedQuantity,
    onHandDelta,
    lockedDelta: 0,
    inTransitDelta,
    requestId: LEGACY_PLACEHOLDER_CLEANUP_REQUEST_ID,
  };
  db.prepare(`
    INSERT INTO document_events(document_id, legacy_record_id, event_type, role, occurred_at, reason, payload_json)
    VALUES (NULL, ?, 'legacy_placeholder_removed', 'migration', ?, ?, ?)
  `).run(transitId == null ? null : Number(transitId), at, "schema v13 清理历史占位批次", JSON.stringify(payload));
}

function migrateLegacyPlaceholderPolicySchemaV13(db, appliedAt) {
  const stockPlaceholders = db.prepare(`
    SELECT b.batch_key, b.model, b.base_quantity
    FROM stock_batches b
    WHERE b.is_legacy_placeholder = 1
    ORDER BY b.batch_key
  `).all();
  for (const batch of stockPlaceholders) {
    const references = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM stock_receipts WHERE batch_key = ?) AS receipt_count,
        (SELECT COUNT(*) FROM inventory_ledger WHERE batch_key = ?) AS ledger_count,
        (SELECT COUNT(*) FROM allocation_documents WHERE batch_key = ?) AS document_count
    `).get(batch.batch_key, batch.batch_key, batch.batch_key);
    if (Number(references.receipt_count) > 0 || Number(references.ledger_count) > 0 || Number(references.document_count) > 0) {
      throw new Error(`无法清理历史在库占位批次 ${batch.batch_key}：存在库存凭证、库存流水或调拨单据引用`);
    }
    const removed = db.prepare("DELETE FROM stock_batches WHERE batch_key = ? AND is_legacy_placeholder = 1").run(batch.batch_key);
    if (Number(removed.changes) !== 1) throw new Error(`清理历史在库占位批次失败：${batch.batch_key}`);
    recordLegacyPlaceholderRemoval(db, {
      kind: "stock",
      model: batch.model,
      batchKey: batch.batch_key,
      quantity: Number(batch.base_quantity),
      at: appliedAt,
    });
  }

  const transitPlaceholders = db.prepare(`
    SELECT *
    FROM transit_batches
    WHERE is_legacy_placeholder = 1 AND voided_at IS NULL
    ORDER BY id
  `).all();
  const affectedModels = new Set();
  for (const transit of transitPlaceholders) {
    const quantity = transit.status === "in_transit" ? Number(transit.remaining_quantity) : 0;
    const voided = db.prepare(`
      UPDATE transit_batches
      SET voided_at = ?, voided_by_role = 'migration', voided_request_id = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND is_legacy_placeholder = 1 AND voided_at IS NULL
    `).run(appliedAt, LEGACY_PLACEHOLDER_CLEANUP_REQUEST_ID, appliedAt, Number(transit.id));
    if (Number(voided.changes) !== 1) throw new Error(`清理历史在途占位批次失败：${transit.id}`);
    db.prepare(`
      INSERT INTO transit_events(transit_id, event_type, role, occurred_at, from_status, to_status, quantity, payload_json)
      VALUES (?, 'status_updated', 'migration', ?, ?, 'voided', ?, ?)
    `).run(Number(transit.id), appliedAt, transit.status, quantity, JSON.stringify({
      action: "legacy_placeholder_removed",
      requestId: LEGACY_PLACEHOLDER_CLEANUP_REQUEST_ID,
      model: transit.model,
      quantity,
      originalQuantity: Number(transit.quantity),
    }));
    recordLegacyPlaceholderRemoval(db, {
      kind: "transit",
      model: transit.model,
      transitId: Number(transit.id),
      quantity,
      at: appliedAt,
    });
    affectedModels.add(transit.model);
  }

  const refresh = db.prepare(`
    UPDATE catalog_models
    SET in_transit = COALESCE((
          SELECT SUM(remaining_quantity)
          FROM transit_batches
          WHERE model = catalog_models.model AND status = 'in_transit'
            AND remaining_quantity > 0 AND voided_at IS NULL
        ), 0),
        updated_at = ?, revision = revision + 1
    WHERE model = ?
  `);
  for (const model of affectedModels) refresh.run(appliedAt, model);

  installLegacyPlaceholderGuards(db);
  const remaining = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM stock_batches WHERE is_legacy_placeholder = 1) AS stock_count,
      (SELECT COUNT(*) FROM transit_batches WHERE is_legacy_placeholder = 1 AND voided_at IS NULL) AS transit_count
  `).get();
  if (Number(remaining.stock_count) > 0 || Number(remaining.transit_count) > 0) {
    throw new Error(`schema v13 清理后仍存在活动占位批次：${JSON.stringify(remaining)}`);
  }
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 13").get()) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (13, ?, ?)")
      .run(appliedAt, "禁止新建占位批次并清理活动历史占位");
  }
}

/* v13 -> v14：升级库存使用独立业务单、移仓明细和不可变库存流水。
   调拨库存与升级库存共享批次余额，但不复用调拨单专属 inventory_ledger，
   避免把已确认调拨再次扣减，或把升级锁定伪装成调拨流水。 */
function migrateUpgradeSchemaV14(db, appliedAt) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS upgrade_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upgrade_no TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('relocation', 'direct')),
      allocation_document_id INTEGER REFERENCES allocation_documents(id),
      model TEXT NOT NULL REFERENCES catalog_models(model),
      source_version TEXT NOT NULL,
      new_version TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
      initiated_by_role TEXT NOT NULL,
      initiated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at TEXT NOT NULL,
      CHECK ((kind = 'relocation' AND allocation_document_id IS NOT NULL)
          OR (kind = 'direct' AND allocation_document_id IS NULL))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS upgrade_stock_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upgrade_id INTEGER NOT NULL REFERENCES upgrade_jobs(id),
      source_batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
      initial_quantity INTEGER NOT NULL CHECK (initial_quantity > 0),
      completed_quantity INTEGER NOT NULL DEFAULT 0 CHECK (completed_quantity >= 0),
      remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at TEXT NOT NULL,
      CHECK (initial_quantity = completed_quantity + remaining_quantity),
      UNIQUE (upgrade_id, source_batch_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS upgrade_relocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      relocation_no TEXT NOT NULL UNIQUE,
      upgrade_id INTEGER NOT NULL REFERENCES upgrade_jobs(id),
      allocation_document_id INTEGER NOT NULL REFERENCES allocation_documents(id),
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      source_quantity_before INTEGER NOT NULL CHECK (source_quantity_before > 0),
      fba_remaining_quantity INTEGER NOT NULL CHECK (fba_remaining_quantity >= 0),
      shipped_quantity INTEGER NOT NULL CHECK (shipped_quantity > 0),
      completed_quantity INTEGER NOT NULL DEFAULT 0 CHECK (completed_quantity >= 0 AND completed_quantity <= shipped_quantity),
      rma TEXT NOT NULL,
      relocation_address TEXT NOT NULL,
      removal_order_no TEXT NOT NULL,
      carrier TEXT NOT NULL,
      tracking_no TEXT NOT NULL,
      external_sync_status TEXT NOT NULL DEFAULT 'not_synced' CHECK (external_sync_status IN ('not_synced', 'synced')),
      new_version TEXT,
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at TEXT NOT NULL,
      CHECK (source_quantity_before = fba_remaining_quantity + shipped_quantity),
      UNIQUE (upgrade_id, sequence)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS upgrade_inventory_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upgrade_id INTEGER NOT NULL REFERENCES upgrade_jobs(id),
      source_type TEXT NOT NULL CHECK (source_type IN ('direct_line', 'relocation')),
      source_id INTEGER NOT NULL,
      batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
      entry_type TEXT NOT NULL CHECK (entry_type IN ('direct_reserve', 'direct_transfer_out', 'direct_transfer_in', 'relocation_receipt')),
      on_hand_delta INTEGER NOT NULL DEFAULT 0,
      locked_delta INTEGER NOT NULL DEFAULT 0,
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_upgrade_direct_active
      ON upgrade_jobs(model, source_version)
      WHERE kind = 'direct' AND status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_upgrade_relocation_document
      ON upgrade_jobs(allocation_document_id)
      WHERE kind = 'relocation';
    CREATE INDEX IF NOT EXISTS idx_upgrade_jobs_model ON upgrade_jobs(model, source_version, status, id);
    CREATE INDEX IF NOT EXISTS idx_upgrade_lines_job ON upgrade_stock_lines(upgrade_id, id);
    CREATE INDEX IF NOT EXISTS idx_upgrade_relocations_job ON upgrade_relocations(upgrade_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_upgrade_ledger_batch ON upgrade_inventory_ledger(batch_key, id);

    CREATE TRIGGER IF NOT EXISTS upgrade_inventory_ledger_no_update
    BEFORE UPDATE ON upgrade_inventory_ledger
    BEGIN SELECT RAISE(ABORT, '升级库存流水禁止覆盖'); END;

    CREATE TRIGGER IF NOT EXISTS upgrade_inventory_ledger_no_delete
    BEFORE DELETE ON upgrade_inventory_ledger
    BEGIN SELECT RAISE(ABORT, '升级库存流水禁止删除'); END;

    CREATE TRIGGER IF NOT EXISTS upgrade_jobs_no_delete
    BEFORE DELETE ON upgrade_jobs
    BEGIN SELECT RAISE(ABORT, '升级业务单禁止删除'); END;

    CREATE TRIGGER IF NOT EXISTS upgrade_relocations_no_delete
    BEFORE DELETE ON upgrade_relocations
    BEGIN SELECT RAISE(ABORT, '移仓记录禁止删除'); END;
  `);
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 14").get()) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (14, ?, ?)")
      .run(appliedAt, "升级库存移仓跟踪、在库预锁定、版本转换与独立库存流水");
  }
}

/* v14 -> v15：把每次升级动作固化为可追溯操作，并为移仓增加采购、运营、
   发起人三段登记。升级撤回只追加反向流水，原事件和原库存流水保持不变。 */
function migrateUpgradeWithdrawalSchemaV15(db, appliedAt) {
  const jobColumns = tableColumns(db, "upgrade_jobs");
  if (!jobColumns.has("cancelled_by_role")) db.exec("ALTER TABLE upgrade_jobs ADD COLUMN cancelled_by_role TEXT");
  if (!jobColumns.has("cancelled_at")) db.exec("ALTER TABLE upgrade_jobs ADD COLUMN cancelled_at TEXT");
  if (!jobColumns.has("cancel_reason")) db.exec("ALTER TABLE upgrade_jobs ADD COLUMN cancel_reason TEXT");

  const relocationColumns = tableColumns(db, "upgrade_relocations");
  if (!relocationColumns.has("status")) db.exec("ALTER TABLE upgrade_relocations ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn'))");
  if (!relocationColumns.has("withdrawn_by_role")) db.exec("ALTER TABLE upgrade_relocations ADD COLUMN withdrawn_by_role TEXT");
  if (!relocationColumns.has("withdrawn_at")) db.exec("ALTER TABLE upgrade_relocations ADD COLUMN withdrawn_at TEXT");
  if (!relocationColumns.has("withdraw_reason")) db.exec("ALTER TABLE upgrade_relocations ADD COLUMN withdraw_reason TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS upgrade_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_no TEXT NOT NULL UNIQUE,
      upgrade_id INTEGER NOT NULL REFERENCES upgrade_jobs(id),
      relocation_id INTEGER REFERENCES upgrade_relocations(id),
      operation_type TEXT NOT NULL CHECK (operation_type IN ('direct_start', 'direct_complete', 'relocation_shipment', 'relocation_complete')),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      new_version TEXT,
      source_event_id INTEGER NOT NULL UNIQUE REFERENCES document_events(id),
      request_id TEXT NOT NULL,
      performed_by_role TEXT NOT NULL,
      performed_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      withdrawn_by_role TEXT,
      withdrawn_at TEXT,
      withdraw_reason TEXT,
      reversal_group TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      CHECK ((operation_type IN ('relocation_shipment', 'relocation_complete') AND relocation_id IS NOT NULL)
          OR (operation_type IN ('direct_start', 'direct_complete') AND relocation_id IS NULL))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS upgrade_relocation_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_no TEXT NOT NULL UNIQUE,
      allocation_document_id INTEGER NOT NULL REFERENCES allocation_documents(id),
      upgrade_id INTEGER REFERENCES upgrade_jobs(id),
      relocation_id INTEGER REFERENCES upgrade_relocations(id),
      source_quantity_before INTEGER NOT NULL CHECK (source_quantity_before > 0),
      status TEXT NOT NULL CHECK (status IN ('awaiting_procurement', 'awaiting_operation', 'awaiting_shipping', 'shipped', 'withdrawn')),
      initiated_by_role TEXT NOT NULL,
      initiated_at TEXT NOT NULL,
      rma TEXT,
      relocation_address TEXT,
      procurement_by_role TEXT,
      procurement_at TEXT,
      removal_order_no TEXT,
      operation_by_role TEXT,
      operation_at TEXT,
      fba_remaining_quantity INTEGER CHECK (fba_remaining_quantity >= 0),
      shipped_quantity INTEGER CHECK (shipped_quantity > 0),
      carrier TEXT,
      tracking_no TEXT,
      external_sync_status TEXT NOT NULL DEFAULT 'not_synced' CHECK (external_sync_status IN ('not_synced', 'synced')),
      shipping_by_role TEXT,
      shipping_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_upgrade_work_active
      ON upgrade_relocation_work_items(allocation_document_id)
      WHERE status IN ('awaiting_procurement', 'awaiting_operation', 'awaiting_shipping');
    CREATE INDEX IF NOT EXISTS idx_upgrade_operations_job ON upgrade_operations(upgrade_id, id);
    CREATE INDEX IF NOT EXISTS idx_upgrade_operations_status ON upgrade_operations(status, performed_at, id);
    CREATE INDEX IF NOT EXISTS idx_upgrade_work_status ON upgrade_relocation_work_items(status, updated_at, id);

    CREATE TRIGGER IF NOT EXISTS upgrade_operations_no_delete
    BEFORE DELETE ON upgrade_operations
    BEGIN SELECT RAISE(ABORT, '升级操作记录禁止删除'); END;

    CREATE TRIGGER IF NOT EXISTS upgrade_relocation_work_items_no_delete
    BEFORE DELETE ON upgrade_relocation_work_items
    BEGIN SELECT RAISE(ABORT, '移仓分步记录禁止删除'); END;
  `);

  /* v14 已经按每次提交写入独立事件和 requestId；据此回填操作记录，
     使历史完成登记也能逐笔进入撤回中心。 */
  const eventRows = db.prepare(`
    SELECT * FROM document_events
    WHERE event_type IN ('upgrade_direct_start', 'upgrade_direct_complete', 'upgrade_relocation_created', 'upgrade_relocation_complete')
    ORDER BY id
  `).all();
  const typeMap = {
    upgrade_direct_start: "direct_start",
    upgrade_direct_complete: "direct_complete",
    upgrade_relocation_created: "relocation_shipment",
    upgrade_relocation_complete: "relocation_complete",
  };
  const insertOperation = db.prepare(`
    INSERT OR IGNORE INTO upgrade_operations(
      operation_no, upgrade_id, relocation_id, operation_type, quantity, new_version,
      source_event_id, request_id, performed_by_role, performed_at, status, revision, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)
  `);
  for (const event of eventRows) {
    const payload = parseEventPayload(event.payload_json);
    const upgradeId = Number(payload.upgradeId);
    if (!Number.isInteger(upgradeId) || !db.prepare("SELECT 1 FROM upgrade_jobs WHERE id = ?").get(upgradeId)) continue;
    const operationType = typeMap[event.event_type];
    const relocationId = operationType.startsWith("relocation_") ? Number(payload.relocationId) : null;
    if (operationType.startsWith("relocation_") && (!Number.isInteger(relocationId) || !db.prepare("SELECT 1 FROM upgrade_relocations WHERE id = ?").get(relocationId))) continue;
    let quantity = Number(payload.quantity ?? payload.shippedQuantity);
    if (operationType === "direct_start" && (!Number.isInteger(quantity) || quantity <= 0)) {
      quantity = Number(db.prepare("SELECT COALESCE(SUM(initial_quantity), 0) AS quantity FROM upgrade_stock_lines WHERE upgrade_id = ?").get(upgradeId).quantity);
    }
    if (operationType === "relocation_shipment" && (!Number.isInteger(quantity) || quantity <= 0)) {
      quantity = Number(db.prepare("SELECT shipped_quantity AS quantity FROM upgrade_relocations WHERE id = ?").get(relocationId)?.quantity ?? 0);
    }
    if (!Number.isInteger(quantity) || quantity <= 0) continue;
    const requestId = String(payload.requestId || `schema-v15-event-${event.id}`);
    const result = insertOperation.run(
      `PENDING-${crypto.randomUUID()}`, upgradeId, relocationId, operationType, quantity,
      payload.newVersion == null ? null : String(payload.newVersion), Number(event.id), requestId,
      event.role, event.occurred_at, JSON.stringify({ migratedFromSchema: 14, eventPayload: payload }),
    );
    if (Number(result.changes) === 1) {
      const operationId = Number(result.lastInsertRowid);
      db.prepare("UPDATE upgrade_operations SET operation_no = ? WHERE id = ?")
        .run(`UOP-${String(operationId).padStart(8, "0")}`, operationId);
    }
  }

  const ledgerColumns = tableColumns(db, "upgrade_inventory_ledger");
  if (!ledgerColumns.has("operation_id")) {
    db.exec(`
      DROP TRIGGER IF EXISTS upgrade_inventory_ledger_no_update;
      DROP TRIGGER IF EXISTS upgrade_inventory_ledger_no_delete;
      ALTER TABLE upgrade_inventory_ledger RENAME TO upgrade_inventory_ledger_v14;

      CREATE TABLE upgrade_inventory_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upgrade_id INTEGER NOT NULL REFERENCES upgrade_jobs(id),
        operation_id INTEGER REFERENCES upgrade_operations(id),
        source_type TEXT NOT NULL CHECK (source_type IN ('direct_line', 'relocation')),
        source_id INTEGER NOT NULL,
        batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
        entry_type TEXT NOT NULL CHECK (entry_type IN (
          'direct_reserve', 'direct_transfer_out', 'direct_transfer_in', 'relocation_receipt',
          'direct_release_reservation', 'direct_completion_reverse_target',
          'direct_completion_restore_source', 'relocation_completion_reverse'
        )),
        on_hand_delta INTEGER NOT NULL DEFAULT 0,
        locked_delta INTEGER NOT NULL DEFAULT 0,
        related_ledger_id INTEGER REFERENCES upgrade_inventory_ledger(id),
        reversal_group TEXT,
        created_by_role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        request_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;

      INSERT INTO upgrade_inventory_ledger(
        id, upgrade_id, operation_id, source_type, source_id, batch_key, entry_type,
        on_hand_delta, locked_delta, related_ledger_id, reversal_group,
        created_by_role, created_at, request_id, metadata_json
      )
      SELECT l.id, l.upgrade_id,
             (SELECT o.id FROM upgrade_operations o
              WHERE o.upgrade_id = l.upgrade_id AND o.request_id = l.request_id
                AND ((l.entry_type = 'direct_reserve' AND o.operation_type = 'direct_start')
                  OR (l.entry_type IN ('direct_transfer_out', 'direct_transfer_in') AND o.operation_type = 'direct_complete')
                  OR (l.entry_type = 'relocation_receipt' AND o.operation_type = 'relocation_complete'))
              ORDER BY o.id LIMIT 1),
             l.source_type, l.source_id, l.batch_key, l.entry_type,
             l.on_hand_delta, l.locked_delta, NULL, NULL,
             l.created_by_role, l.created_at, l.request_id, l.metadata_json
      FROM upgrade_inventory_ledger_v14 l ORDER BY l.id;

      DROP TABLE upgrade_inventory_ledger_v14;
      CREATE INDEX idx_upgrade_ledger_batch ON upgrade_inventory_ledger(batch_key, id);
      CREATE INDEX idx_upgrade_ledger_operation ON upgrade_inventory_ledger(operation_id, id);

      CREATE TRIGGER upgrade_inventory_ledger_no_update
      BEFORE UPDATE ON upgrade_inventory_ledger
      BEGIN SELECT RAISE(ABORT, '升级库存流水禁止覆盖'); END;

      CREATE TRIGGER upgrade_inventory_ledger_no_delete
      BEFORE DELETE ON upgrade_inventory_ledger
      BEGIN SELECT RAISE(ABORT, '升级库存流水禁止删除'); END;
    `);
  }

  db.exec(`
    DROP INDEX IF EXISTS uq_upgrade_direct_active;
    CREATE UNIQUE INDEX uq_upgrade_direct_active
      ON upgrade_jobs(model, source_version)
      WHERE kind = 'direct' AND status = 'active' AND cancelled_at IS NULL;
  `);
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 15").get()) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (15, ?, ?)")
      .run(appliedAt, "升级单次操作撤回、反向升级流水与移仓分步职责");
  }
}

/* v15 -> v16：为未登记发货的移仓流程增加取消状态字段；当前取消权限仅限管理员。
   升级历史表继续禁止普通物理删除，仅在管理员型号永久删除专用事务且目标型号一致时放行。 */
function migrateCatalogModelUpgradeDeleteSchemaV16(db, appliedAt) {
  const workColumns = tableColumns(db, "upgrade_relocation_work_items");
  if (!workColumns.has("cancelled_at")) {
    db.exec(`
      DROP TRIGGER IF EXISTS upgrade_relocation_work_items_no_delete;
      DROP INDEX IF EXISTS uq_upgrade_work_active;
      DROP INDEX IF EXISTS idx_upgrade_work_status;
      ALTER TABLE upgrade_relocation_work_items RENAME TO upgrade_relocation_work_items_v15;

      CREATE TABLE upgrade_relocation_work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_no TEXT NOT NULL UNIQUE,
        allocation_document_id INTEGER NOT NULL REFERENCES allocation_documents(id),
        upgrade_id INTEGER REFERENCES upgrade_jobs(id),
        relocation_id INTEGER REFERENCES upgrade_relocations(id),
        source_quantity_before INTEGER NOT NULL CHECK (source_quantity_before > 0),
        status TEXT NOT NULL CHECK (status IN ('awaiting_procurement', 'awaiting_operation', 'awaiting_shipping', 'shipped', 'withdrawn', 'cancelled')),
        initiated_by_role TEXT NOT NULL,
        initiated_at TEXT NOT NULL,
        rma TEXT,
        relocation_address TEXT,
        procurement_by_role TEXT,
        procurement_at TEXT,
        removal_order_no TEXT,
        operation_by_role TEXT,
        operation_at TEXT,
        fba_remaining_quantity INTEGER CHECK (fba_remaining_quantity >= 0),
        shipped_quantity INTEGER CHECK (shipped_quantity > 0),
        carrier TEXT,
        tracking_no TEXT,
        external_sync_status TEXT NOT NULL DEFAULT 'not_synced' CHECK (external_sync_status IN ('not_synced', 'synced')),
        shipping_by_role TEXT,
        shipping_at TEXT,
        cancelled_by_role TEXT,
        cancelled_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO upgrade_relocation_work_items(
        id, work_no, allocation_document_id, upgrade_id, relocation_id,
        source_quantity_before, status, initiated_by_role, initiated_at,
        rma, relocation_address, procurement_by_role, procurement_at,
        removal_order_no, operation_by_role, operation_at,
        fba_remaining_quantity, shipped_quantity, carrier, tracking_no,
        external_sync_status, shipping_by_role, shipping_at,
        cancelled_by_role, cancelled_at, revision, updated_at
      )
      SELECT id, work_no, allocation_document_id, upgrade_id, relocation_id,
             source_quantity_before, status, initiated_by_role, initiated_at,
             rma, relocation_address, procurement_by_role, procurement_at,
             removal_order_no, operation_by_role, operation_at,
             fba_remaining_quantity, shipped_quantity, carrier, tracking_no,
             external_sync_status, shipping_by_role, shipping_at,
             NULL, NULL, revision, updated_at
      FROM upgrade_relocation_work_items_v15 ORDER BY id;

      DROP TABLE upgrade_relocation_work_items_v15;
    `);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_upgrade_work_active
      ON upgrade_relocation_work_items(allocation_document_id)
      WHERE status IN ('awaiting_procurement', 'awaiting_operation', 'awaiting_shipping');
    CREATE INDEX IF NOT EXISTS idx_upgrade_work_status
      ON upgrade_relocation_work_items(status, updated_at, id);

    DROP TRIGGER IF EXISTS upgrade_inventory_ledger_no_delete;
    DROP TRIGGER IF EXISTS upgrade_jobs_no_delete;
    DROP TRIGGER IF EXISTS upgrade_relocations_no_delete;
    DROP TRIGGER IF EXISTS upgrade_operations_no_delete;
    DROP TRIGGER IF EXISTS upgrade_relocation_work_items_no_delete;

    CREATE TRIGGER upgrade_inventory_ledger_no_delete
    BEFORE DELETE ON upgrade_inventory_ledger
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '')
         <> COALESCE((SELECT model FROM upgrade_jobs WHERE id = OLD.upgrade_id), '__missing_upgrade_model__')
    BEGIN SELECT RAISE(ABORT, '升级库存流水禁止删除'); END;

    CREATE TRIGGER upgrade_operations_no_delete
    BEFORE DELETE ON upgrade_operations
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '')
         <> COALESCE((SELECT model FROM upgrade_jobs WHERE id = OLD.upgrade_id), '__missing_upgrade_model__')
    BEGIN SELECT RAISE(ABORT, '升级操作记录禁止删除'); END;

    CREATE TRIGGER upgrade_relocation_work_items_no_delete
    BEFORE DELETE ON upgrade_relocation_work_items
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '')
         <> COALESCE((SELECT model FROM allocation_documents WHERE id = OLD.allocation_document_id), '__missing_upgrade_model__')
    BEGIN SELECT RAISE(ABORT, '移仓分步记录禁止删除'); END;

    CREATE TRIGGER upgrade_relocations_no_delete
    BEFORE DELETE ON upgrade_relocations
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '')
         <> COALESCE((SELECT model FROM upgrade_jobs WHERE id = OLD.upgrade_id), '__missing_upgrade_model__')
    BEGIN SELECT RAISE(ABORT, '移仓记录禁止删除'); END;

    CREATE TRIGGER upgrade_jobs_no_delete
    BEFORE DELETE ON upgrade_jobs
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') <> OLD.model
    BEGIN SELECT RAISE(ABORT, '升级业务单禁止删除'); END;
  `);
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 16").get()) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (16, ?, ?)")
      .run(appliedAt, "移仓流程取消与型号永久删除中的升级历史受控清理");
  }
}

function migrateApprovalSchemaV17(db, appliedAt) {
  const ledgerSequence = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'inventory_ledger'").get()?.seq ?? 0);
  db.exec(`
    ALTER TABLE allocation_documents ADD COLUMN asin TEXT NOT NULL DEFAULT '';
    ALTER TABLE allocation_documents ADD COLUMN operator_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE allocation_documents ADD COLUMN requested_quantity INTEGER CHECK (requested_quantity > 0);
    ALTER TABLE allocation_documents ADD COLUMN approved_quantity INTEGER CHECK (approved_quantity > 0);
    ALTER TABLE allocation_documents ADD COLUMN business_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE allocation_documents ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (approval_status IN ('pending', 'approved', 'rejected', 'legacy'));
    ALTER TABLE allocation_documents ADD COLUMN reviewed_at TEXT;
    ALTER TABLE allocation_documents ADD COLUMN reviewed_by_role TEXT;
    ALTER TABLE allocation_documents ADD COLUMN lingxing_snapshot_json TEXT;
    UPDATE allocation_documents
    SET requested_quantity = quantity,
        approved_quantity = CASE WHEN status IN ('confirmed', 'withdrawn') THEN quantity ELSE NULL END,
        approval_status = CASE WHEN status IN ('confirmed', 'withdrawn', 'cancelled') THEN 'legacy' ELSE 'pending' END;

    CREATE TABLE lingxing_asin_metrics (
      asin TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      synced_by_role TEXT NOT NULL,
      synced_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE inquiry_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_no TEXT NOT NULL UNIQUE,
      model TEXT NOT NULL REFERENCES catalog_models(model),
      asin TEXT NOT NULL,
      fnsku TEXT NOT NULL,
      requested_quantity INTEGER NOT NULL CHECK (requested_quantity >= 0),
      approved_quantity INTEGER CHECK (approved_quantity > 0),
      supplier_quantity INTEGER CHECK (supplier_quantity >= 0),
      department TEXT NOT NULL CHECK (department IN ('一团', '二团')),
      store_name TEXT NOT NULL,
      operator_name TEXT NOT NULL,
      operator_note TEXT NOT NULL DEFAULT '',
      business_note TEXT NOT NULL DEFAULT '',
      shipping_warehouse TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT '',
      ship_date TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending_business', 'pending_purchasing', 'pending_assistant', 'archived', 'rejected', 'cancelled')),
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reviewed_by_role TEXT,
      reviewed_at TEXT,
      replied_by_role TEXT,
      replied_at TEXT,
      archived_by_role TEXT,
      archived_at TEXT,
      cancelled_by_role TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      fba_shipped_at TEXT,
      fba_confirmed_by_role TEXT,
      lingxing_snapshot_json TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_inquiry_status_model ON inquiry_documents(status, model, updated_at);
    CREATE TABLE inquiry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_id INTEGER NOT NULL REFERENCES inquiry_documents(id),
      event_type TEXT NOT NULL,
      role TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_inquiry_events_document ON inquiry_events(inquiry_id, id);
    CREATE TRIGGER inquiry_documents_no_delete BEFORE DELETE ON inquiry_documents
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') <> OLD.model
    BEGIN SELECT RAISE(ABORT, '询库单禁止删除'); END;
    CREATE TRIGGER inquiry_events_no_update BEFORE UPDATE ON inquiry_events
    BEGIN SELECT RAISE(ABORT, '询库历史禁止覆盖'); END;
    CREATE TRIGGER inquiry_events_no_delete BEFORE DELETE ON inquiry_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '')
      <> COALESCE((SELECT model FROM inquiry_documents WHERE id = OLD.inquiry_id), '__missing_inquiry_model__')
    BEGIN SELECT RAISE(ABORT, '询库历史禁止删除'); END;

    DROP TRIGGER inventory_ledger_no_update;
    DROP TRIGGER inventory_ledger_no_delete;
    CREATE TABLE inventory_ledger_v17 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES allocation_documents(id),
      batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
      entry_type TEXT NOT NULL CHECK (entry_type IN ('reserve', 'review_adjustment', 'release_reservation', 'issue', 'reverse_issue')),
      on_hand_delta INTEGER NOT NULL DEFAULT 0,
      locked_delta INTEGER NOT NULL DEFAULT 0,
      related_ledger_id INTEGER REFERENCES inventory_ledger_v17(id),
      reversal_group TEXT,
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE (document_id, entry_type)
    ) STRICT;
    INSERT INTO inventory_ledger_v17 SELECT * FROM inventory_ledger;
    DROP TABLE inventory_ledger;
    ALTER TABLE inventory_ledger_v17 RENAME TO inventory_ledger;
    CREATE INDEX idx_ledger_batch ON inventory_ledger(batch_key);
    CREATE TRIGGER inventory_ledger_no_update
    BEFORE UPDATE ON inventory_ledger
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '库存流水禁止覆盖'); END;
    CREATE TRIGGER inventory_ledger_no_delete
    BEFORE DELETE ON inventory_ledger
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '') = ''
    BEGIN SELECT RAISE(ABORT, '库存流水禁止删除'); END;
    CREATE INDEX idx_allocation_approval ON allocation_documents(approval_status, status, model);
  `);
  setSequenceAtLeast(db, "inventory_ledger", ledgerSequence);
  /* 三张既有移仓表仅放宽来源外键，保持已存字段、索引、历史及删除权限。 */
  const sourceTables = ["upgrade_jobs", "upgrade_relocations", "upgrade_relocation_work_items"];
  const sourceSchemaObjects = db.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE type IN ('trigger', 'index') AND sql IS NOT NULL
      AND (tbl_name IN ('upgrade_jobs', 'upgrade_relocations', 'upgrade_relocation_work_items')
        OR name IN ('upgrade_inventory_ledger_no_delete', 'upgrade_operations_no_delete'))`).all();
  for (const item of sourceSchemaObjects) db.exec(`DROP ${item.type.toUpperCase()} "${item.name}"`);
  for (const table of sourceTables) {
    const sequence = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table)?.seq ?? 0);
    const columns = [...tableColumns(db, table)];
    let sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
    sql = sql.replace(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?["\x60]?${table}["\x60]?`), `CREATE TABLE ${table}_v17`)
      .replace("allocation_document_id INTEGER NOT NULL", "allocation_document_id INTEGER")
      .replace("allocation_document_id INTEGER REFERENCES allocation_documents(id),", "allocation_document_id INTEGER REFERENCES allocation_documents(id), inquiry_id INTEGER REFERENCES inquiry_documents(id),");
    if (table === "upgrade_jobs") {
      sql = sql.replace("(kind = 'relocation' AND allocation_document_id IS NOT NULL)", "(kind = 'relocation' AND ((allocation_document_id IS NOT NULL) <> (inquiry_id IS NOT NULL)))")
        .replace("(kind = 'direct' AND allocation_document_id IS NULL)", "(kind = 'direct' AND allocation_document_id IS NULL AND inquiry_id IS NULL)");
    }
    if (table !== "upgrade_jobs") sql = sql.replace(/\) STRICT$/, ", CHECK ((allocation_document_id IS NOT NULL) <> (inquiry_id IS NOT NULL))) STRICT");
    db.exec(sql);
    db.exec(`INSERT INTO ${table}_v17(${columns.join(", ")}) SELECT ${columns.join(", ")} FROM ${table}`);
    db.exec(`DROP TABLE ${table}; ALTER TABLE ${table}_v17 RENAME TO ${table}`);
    setSequenceAtLeast(db, table, sequence);
  }
  for (const item of sourceSchemaObjects) {
    const sql = item.name === "upgrade_relocation_work_items_no_delete"
      ? item.sql.replace("(SELECT model FROM allocation_documents WHERE id = OLD.allocation_document_id)", "COALESCE((SELECT model FROM allocation_documents WHERE id = OLD.allocation_document_id), (SELECT model FROM inquiry_documents WHERE id = OLD.inquiry_id))")
      : item.sql;
    db.exec(sql);
  }
  db.exec(`
    CREATE UNIQUE INDEX uq_upgrade_relocation_inquiry ON upgrade_jobs(inquiry_id) WHERE kind = 'relocation';
    CREATE UNIQUE INDEX uq_upgrade_work_inquiry_active ON upgrade_relocation_work_items(inquiry_id)
      WHERE status IN ('awaiting_procurement', 'awaiting_operation', 'awaiting_shipping');
    CREATE VIEW relocation_sources AS
      SELECT id AS allocation_document_id, NULL AS inquiry_id, 'allocation' AS source_kind,
        document_no, model, batch_key, plan, ship_date, version, fnsku, quantity,
        department, store_name, operator_name, asin, status, confirmed_at, NULL AS fba_shipped_at
      FROM allocation_documents
      UNION ALL
      SELECT NULL, id, 'inquiry', document_no, model, NULL, plan,
        COALESCE(fba_shipped_at, ship_date), version, fnsku, supplier_quantity,
        department, store_name, operator_name, asin, status, archived_at, fba_shipped_at
      FROM inquiry_documents;
  `);
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (17, ?, ?)")
    .run(appliedAt, "调拨与询库审批、审核差额流水、领星快照及独立询库升级来源");
}

function migrateInquiryShipmentSchemaV18(db, appliedAt) {
  db.exec(`
    CREATE TABLE inquiry_shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_id INTEGER NOT NULL REFERENCES inquiry_documents(id),
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      ship_date TEXT NOT NULL,
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_inquiry_shipments_document ON inquiry_shipments(inquiry_id, id);
    CREATE TRIGGER inquiry_shipments_no_delete BEFORE DELETE ON inquiry_shipments
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '')
      <> COALESCE((SELECT model FROM inquiry_documents WHERE id = OLD.inquiry_id), '__missing_inquiry_model__')
    BEGIN SELECT RAISE(ABORT, '询库发货批次禁止删除'); END;
    INSERT INTO inquiry_shipments(inquiry_id, quantity, ship_date, created_by_role, created_at, updated_at)
      SELECT id, supplier_quantity, fba_shipped_at, COALESCE(fba_confirmed_by_role, 'assistant'), updated_at, updated_at
      FROM inquiry_documents WHERE fba_shipped_at IS NOT NULL;
    ALTER TABLE upgrade_relocations ADD COLUMN sold_quantity INTEGER NOT NULL DEFAULT 0 CHECK (sold_quantity >= 0);
    ALTER TABLE upgrade_relocations ADD COLUMN inquiry_shipment_id INTEGER REFERENCES inquiry_shipments(id);
    ALTER TABLE upgrade_relocation_work_items ADD COLUMN sold_quantity INTEGER NOT NULL DEFAULT 0 CHECK (sold_quantity >= 0);
    ALTER TABLE upgrade_relocation_work_items ADD COLUMN inquiry_shipment_id INTEGER REFERENCES inquiry_shipments(id);
    UPDATE upgrade_relocations SET inquiry_shipment_id = (SELECT id FROM inquiry_shipments WHERE inquiry_id = upgrade_relocations.inquiry_id)
      WHERE inquiry_id IS NOT NULL;
    UPDATE upgrade_relocation_work_items SET inquiry_shipment_id = (SELECT id FROM inquiry_shipments WHERE inquiry_id = upgrade_relocation_work_items.inquiry_id)
      WHERE inquiry_id IS NOT NULL;
    DROP INDEX uq_upgrade_work_inquiry_active;
    CREATE UNIQUE INDEX uq_upgrade_work_inquiry_active ON upgrade_relocation_work_items(inquiry_shipment_id)
      WHERE status IN ('awaiting_procurement', 'awaiting_operation', 'awaiting_shipping');
    DROP VIEW relocation_sources;
    CREATE VIEW relocation_sources AS
      SELECT id AS allocation_document_id, NULL AS inquiry_id, 'allocation' AS source_kind,
        document_no, model, batch_key, plan, ship_date, version, fnsku, quantity,
        department, store_name, operator_name, asin, status, confirmed_at, NULL AS fba_shipped_at
      FROM allocation_documents
      UNION ALL
      SELECT NULL, d.id, 'inquiry', document_no, model, NULL, plan,
        COALESCE(fba_shipped_at, ship_date), version, fnsku,
        COALESCE((SELECT SUM(s.quantity) FROM inquiry_shipments s WHERE s.inquiry_id = d.id), 0),
        department, store_name, operator_name, asin, status, archived_at, fba_shipped_at
      FROM inquiry_documents d;
  `);
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'upgrade_relocations' AND type IN ('trigger', 'index') AND sql IS NOT NULL").all();
  const sequence = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'upgrade_relocations'").get()?.seq ?? 0);
  const columns = [...tableColumns(db, "upgrade_relocations")];
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'upgrade_relocations'").get().sql
    .replace(/CREATE TABLE ["`]?upgrade_relocations["`]?/, "CREATE TABLE upgrade_relocations_v18")
    .replace("source_quantity_before = fba_remaining_quantity + shipped_quantity", "source_quantity_before = fba_remaining_quantity + shipped_quantity + sold_quantity");
  for (const item of objects) db.exec(`DROP ${item.type.toUpperCase()} "${item.name}"`);
  db.exec(sql);
  db.exec(`INSERT INTO upgrade_relocations_v18(${columns.join(", ")}) SELECT ${columns.join(", ")} FROM upgrade_relocations;
    DROP TABLE upgrade_relocations; ALTER TABLE upgrade_relocations_v18 RENAME TO upgrade_relocations;`);
  for (const item of objects) db.exec(item.sql);
  setSequenceAtLeast(db, "upgrade_relocations", sequence);
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (18, ?, ?)")
    .run(appliedAt, "FBA人工已售、询库纠错与实际分批发货来源");
}

function migrateRelocationLogisticsSchemaV19(db, appliedAt) {
  db.exec(`
    CREATE TABLE lingxing_removal_shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      store_name TEXT NOT NULL,
      country_code TEXT NOT NULL,
      order_no TEXT NOT NULL,
      fnsku TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      carrier TEXT NOT NULL,
      tracking_no TEXT NOT NULL,
      ship_date TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      UNIQUE (store_id, external_id)
    ) STRICT;
    CREATE INDEX idx_lingxing_removal_order_fnsku ON lingxing_removal_shipments(order_no, fnsku, id);
    CREATE TABLE upgrade_relocation_external_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      relocation_id INTEGER NOT NULL REFERENCES upgrade_relocations(id),
      line_id INTEGER NOT NULL REFERENCES lingxing_removal_shipments(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (relocation_id, line_id)
    ) STRICT;
    CREATE INDEX idx_upgrade_external_line ON upgrade_relocation_external_items(line_id, relocation_id);
    CREATE TRIGGER upgrade_relocation_external_items_no_update BEFORE UPDATE ON upgrade_relocation_external_items
    BEGIN SELECT RAISE(ABORT, '领星物流采纳历史禁止覆盖'); END;
    CREATE TRIGGER upgrade_relocation_external_items_no_delete BEFORE DELETE ON upgrade_relocation_external_items
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = '${MODEL_DELETE_META_KEY}'), '')
      <> COALESCE((SELECT j.model FROM upgrade_relocations r JOIN upgrade_jobs j ON j.id = r.upgrade_id WHERE r.id = OLD.relocation_id), '__missing_upgrade_model__')
    BEGIN SELECT RAISE(ABORT, '领星物流采纳历史禁止删除'); END;
  `);
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (19, ?, ?)")
    .run(appliedAt, "领星移除包裹真实物流缓存、按来源采纳与跨工单防重复计量");
}

function createSchema(db, databaseId, createdAt) {
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT NOT NULL
    ) STRICT;

    CREATE TABLE system_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE catalog_models (
      model TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('硒鼓', '墨盒')),
      base_in_stock INTEGER NOT NULL CHECK (base_in_stock >= 0),
      in_transit INTEGER NOT NULL CHECK (in_transit >= 0),
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_by_import_id INTEGER REFERENCES import_batches(id)
    ) STRICT;

    CREATE TABLE stock_batches (
      batch_key TEXT PRIMARY KEY,
      model TEXT NOT NULL REFERENCES catalog_models(model),
      /* 旧数据库占位行保留空值以便审计读取；v13 后新写入不得使用该标记。 */
      plan TEXT NOT NULL DEFAULT '',
      ship_date TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      fnsku TEXT NOT NULL DEFAULT '',
      base_quantity INTEGER NOT NULL CHECK (base_quantity >= 0),
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_by_import_id INTEGER REFERENCES import_batches(id),
      created_by_transit_id INTEGER REFERENCES transit_batches(id),
      is_legacy_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_legacy_placeholder IN (0, 1)),
      UNIQUE (model, plan, ship_date, version, fnsku)
    ) STRICT;

    CREATE TABLE transit_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL REFERENCES catalog_models(model),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0 AND remaining_quantity <= quantity),
      plan TEXT NOT NULL,
      ship_date TEXT NOT NULL,
      version TEXT NOT NULL,
      fnsku TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '',
      transport_method TEXT NOT NULL DEFAULT '',
      shipping_method TEXT NOT NULL DEFAULT '',
      team TEXT NOT NULL DEFAULT '',
      logistics_status TEXT NOT NULL,
      on_shelf_indicator TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'on_shelf')),
      is_legacy_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_legacy_placeholder IN (0, 1)),
      import_batch_id INTEGER REFERENCES import_batches(id),
      source_row INTEGER,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      on_shelf_by_role TEXT,
      on_shelf_at TEXT,
      /* 业务作废采用 tombstone，保留原始数量、事件和来源关系。 */
      voided_at TEXT,
      voided_by_role TEXT,
      voided_request_id TEXT
    ) STRICT;

    /* 预览凭证只保存服务器规范化后的预览快照；正式写入前必须在同一事务内消费。 */
    CREATE TABLE transit_preview_tokens (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('import', 'status')),
      role TEXT NOT NULL,
      database_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      template_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    ) STRICT;

    CREATE TABLE stock_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transit_id INTEGER NOT NULL REFERENCES transit_batches(id),
      batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      ledger_watermark INTEGER,
      UNIQUE (transit_id)
    ) STRICT;

    CREATE TABLE transit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transit_id INTEGER NOT NULL REFERENCES transit_batches(id),
      event_type TEXT NOT NULL CHECK (event_type IN ('imported', 'status_updated', 'on_shelf')),
      role TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;

    CREATE TABLE allocation_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_no TEXT NOT NULL UNIQUE,
      correction_of_id INTEGER REFERENCES allocation_documents(id),
      correction_document_id INTEGER REFERENCES allocation_documents(id),
      model TEXT NOT NULL REFERENCES catalog_models(model),
      batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
      plan TEXT NOT NULL,
      ship_date TEXT NOT NULL,
      version TEXT NOT NULL,
      fnsku TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      department TEXT NOT NULL CHECK (department IN ('一团', '二团')),
      store_name TEXT NOT NULL,
      operator_name TEXT NOT NULL,
      legacy_time_label TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'confirmed', 'cancelled', 'withdrawn')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      submitted_by_role TEXT,
      submitted_at TEXT,
      confirmed_by_role TEXT,
      confirmed_at TEXT,
      source_document TEXT,
      cancelled_by_role TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      withdrawn_by_role TEXT,
      withdrawn_at TEXT,
      withdraw_reason TEXT,
      external_sync_status TEXT NOT NULL DEFAULT 'not_synced' CHECK (external_sync_status IN ('not_synced', 'synced', 'cancel_pending')),
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE inventory_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES allocation_documents(id),
      batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
      entry_type TEXT NOT NULL CHECK (entry_type IN ('reserve', 'release_reservation', 'issue', 'reverse_issue')),
      on_hand_delta INTEGER NOT NULL DEFAULT 0,
      locked_delta INTEGER NOT NULL DEFAULT 0,
      related_ledger_id INTEGER REFERENCES inventory_ledger(id),
      reversal_group TEXT,
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE (document_id, entry_type)
    ) STRICT;

    CREATE TABLE document_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER REFERENCES allocation_documents(id),
      legacy_record_id INTEGER,
      event_type TEXT NOT NULL,
      role TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;

    CREATE TABLE document_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES allocation_documents(id),
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
      created_at TEXT NOT NULL,
      UNIQUE (document_id, reference_type, reference_id)
    ) STRICT;

    CREATE TABLE idempotency_requests (
      scope TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope, request_id)
    ) WITHOUT ROWID, STRICT;

    CREATE TABLE import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      template_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('staged', 'reverted')),
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      inventory_applied INTEGER NOT NULL DEFAULT 0 CHECK (inventory_applied IN (0, 1)),
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reverted_by_role TEXT,
      reverted_at TEXT,
      database_id TEXT,
      client_session_id TEXT,
      snapshot_id TEXT REFERENCES transit_import_snapshots(snapshot_id),
      revert_request_id TEXT,
      replaces_import_id INTEGER REFERENCES import_batches(id),
      import_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (import_kind IN ('legacy', 'transit'))
    ) STRICT;

    CREATE TABLE import_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_batch_id INTEGER NOT NULL REFERENCES import_batches(id),
      source_row INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE (import_batch_id, source_row)
    ) STRICT;

    /* 内容和元数据均不可覆盖；批次是否已恢复由 import_batches.status 表示。 */
    CREATE TABLE transit_import_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      import_batch_id INTEGER NOT NULL UNIQUE REFERENCES import_batches(id),
      database_id TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      template_sha256 TEXT NOT NULL,
      structure_version INTEGER NOT NULL CHECK (structure_version >= 1),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('native', 'historical_backup_rebuild')),
      source_reference_sha256 TEXT,
      content_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX idx_allocation_model_batch ON allocation_documents(model, batch_key, status);
    CREATE INDEX idx_ledger_batch ON inventory_ledger(batch_key);
    CREATE INDEX idx_receipts_batch ON stock_receipts(batch_key);
    CREATE INDEX idx_transit_model_status ON transit_batches(model, status, id);
    CREATE UNIQUE INDEX idx_transit_identity_active
      ON transit_batches(model, plan, ship_date, version, fnsku)
      WHERE status = 'in_transit' AND is_legacy_placeholder = 0 AND remaining_quantity > 0 AND voided_at IS NULL;
    CREATE INDEX idx_transit_events_transit ON transit_events(transit_id, id);
    CREATE INDEX idx_transit_preview_expiry ON transit_preview_tokens(expires_at);
    CREATE UNIQUE INDEX uq_import_batches_active_file
      ON import_batches(file_sha256)
      WHERE status <> 'reverted' AND import_kind = 'legacy';
    CREATE INDEX idx_events_document ON document_events(document_id, id);
    CREATE INDEX idx_references_document ON document_references(document_id, status);

    CREATE TRIGGER inventory_ledger_no_update
    BEFORE UPDATE ON inventory_ledger
    BEGIN SELECT RAISE(ABORT, '库存流水禁止覆盖'); END;

    CREATE TRIGGER inventory_ledger_no_delete
    BEFORE DELETE ON inventory_ledger
    BEGIN SELECT RAISE(ABORT, '库存流水禁止删除'); END;

    CREATE TRIGGER document_events_no_update
    BEFORE UPDATE ON document_events
    BEGIN SELECT RAISE(ABORT, '历史事件禁止覆盖'); END;

    CREATE TRIGGER document_events_no_delete
    BEFORE DELETE ON document_events
    BEGIN SELECT RAISE(ABORT, '历史事件禁止删除'); END;

    CREATE TRIGGER allocation_documents_no_delete
    BEFORE DELETE ON allocation_documents
    BEGIN SELECT RAISE(ABORT, '业务单据禁止删除'); END;

    CREATE TRIGGER transit_batches_no_delete
    BEFORE DELETE ON transit_batches
    WHEN COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
         <> COALESCE(OLD.import_batch_id, -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1)
         <> OLD.id
    BEGIN SELECT RAISE(ABORT, '在途记录禁止删除'); END;

    CREATE TRIGGER stock_receipts_no_update
    BEFORE UPDATE ON stock_receipts
    BEGIN SELECT RAISE(ABORT, '上架入库凭证禁止覆盖'); END;

    CREATE TRIGGER stock_receipts_no_delete
    BEFORE DELETE ON stock_receipts
    WHEN COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
         <> COALESCE((SELECT import_batch_id FROM transit_batches WHERE id = OLD.transit_id), -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1)
         <> OLD.transit_id
    BEGIN SELECT RAISE(ABORT, '上架入库凭证禁止删除'); END;

    CREATE TRIGGER transit_events_no_update
    BEFORE UPDATE ON transit_events
    BEGIN SELECT RAISE(ABORT, '在途事件禁止覆盖'); END;

    CREATE TRIGGER transit_events_no_delete
    BEFORE DELETE ON transit_events
    WHEN COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
         <> COALESCE((SELECT import_batch_id FROM transit_batches WHERE id = OLD.transit_id), -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1)
         <> OLD.transit_id
    BEGIN SELECT RAISE(ABORT, '在途事件禁止删除'); END;

    CREATE TRIGGER transit_import_snapshots_no_update
    BEFORE UPDATE ON transit_import_snapshots
    BEGIN SELECT RAISE(ABORT, '在途导入逻辑快照禁止覆盖'); END;

    CREATE TRIGGER transit_import_snapshots_no_delete
    BEFORE DELETE ON transit_import_snapshots
    BEGIN SELECT RAISE(ABORT, '在途导入逻辑快照禁止删除'); END;
  `);

  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)")
    .run(1, createdAt, "统一库存数据库、不可变流水、撤回冲销与修订重提");
  createCorrectionSchema(db);
  createActiveCorrectionConstraint(db);
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)")
    .run(2, createdAt, "独立多纠错单、审核状态、并发约束与可追溯执行");
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)")
    .run(3, createdAt, "在途库存导入、状态更新、上架转换与可追溯事件");
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)")
    .run(4, createdAt, "在途身份唯一约束与服务器预览凭证");
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)")
    .run(5, createdAt, "在途导入批次原子撤销、来源标识与后续库存使用保护");
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)")
    .run(6, createdAt, "在途导入批次级逻辑快照、客户端持久清空入口与贡献恢复");
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)")
    .run(7, createdAt, "统一库存明细口径、整库快照恢复、单条在途录入与下架");
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)")
    .run(8, createdAt, "在途记录业务作废 tombstone 与删除审计");
  migrateCatalogModelDeleteSchemaV9(db, createdAt);
  migrateTransitReplacementSchemaV10(db, createdAt);
  migrateTransitClientSessionSchemaV11(db, createdAt);
  migrateTransitImportDuplicatePolicySchemaV12(db, createdAt);
  migrateLegacyPlaceholderPolicySchemaV13(db, createdAt);
  migrateUpgradeSchemaV14(db, createdAt);
  migrateUpgradeWithdrawalSchemaV15(db, createdAt);
  migrateCatalogModelUpgradeDeleteSchemaV16(db, createdAt);
  migrateApprovalSchemaV17(db, createdAt);
  migrateInquiryShipmentSchemaV18(db, createdAt);
  migrateRelocationLogisticsSchemaV19(db, createdAt);
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (20, ?, ?)")
    .run(createdAt, "在库批次按 FNSKU 区分，保留原批次键和全部引用");
  migrateSimplificationV21(db, createdAt);
  migrateLingxingHostV22(db, createdAt);
  migrateBusinessCorrectionsV23(db, createdAt);
  migrateSourceAttributionV24(db, createdAt);
  migrateWarehouseFbaV25(db, createdAt);
  migratePackPerBoxV26(db, createdAt, []);
  migrateInquiryFinalQuantityV27(db, createdAt);
  migrateSourceInventoryV28(db, createdAt, []);
  migrateInquiryProcurementSchemaV29(db, createdAt);
  migrateRequirementsV30(db, createdAt);
  const insertMeta = db.prepare("INSERT INTO system_meta(key, value) VALUES (?, ?)");
  insertMeta.run("database_id", databaseId);
  insertMeta.run("data_version", "0");
  insertMeta.run("updated_at", createdAt);
  db.exec(`PRAGMA user_version = ${INVENTORY_SCHEMA_VERSION}`);
}

function seedCatalog(db, at) {
  const modelStmt = db.prepare(`
    INSERT INTO catalog_models(model, category, base_in_stock, in_transit, updated_at, revision)
    VALUES (?, ?, 0, ?, ?, 1)
  `);
  const batchStmt = db.prepare(`
    INSERT INTO stock_batches(batch_key, model, plan, ship_date, version, fnsku, base_quantity, updated_at, revision, is_legacy_placeholder)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const transitStmt = db.prepare(`
    INSERT INTO transit_batches(
      model, quantity, remaining_quantity, plan, ship_date, version, fnsku,
      brand, transport_method, shipping_method, team, logistics_status, on_shelf_indicator,
      status, is_legacy_placeholder, import_batch_id, source_row, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_transit', ?, NULL, NULL, 1, ?, ?)
  `);
  for (const item of CATALOG) {
    if (item.legacyPlaceholder || item.transit.some((row) => row.legacyPlaceholder)) {
      throw new Error(`种子数据包含已禁止的占位批次：${item.model}`);
    }
    modelStmt.run(item.model, item.category, item.inTransit, at);
    for (const row of item.batches) {
      batchStmt.run(batchKey(item.model, row.plan, row.date, row.version), item.model, row.plan, row.date, row.version, row.fnsku, row.quantity, at, 0);
    }
    /* 新库不再把没有身份字段的型号层数量伪造成批次；所有在库数量必须
       已经属于带计划号、日期、版本号和 FNSKU 的正常批次。 */
    const detailedBase = item.batches.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    const unallocated = Math.max(0, Number(item.baseInStock || 0) - detailedBase);
    if (unallocated > 0) {
      throw new Error(`种子数据存在未分配在库数量，禁止创建占位批次：${item.model} (${unallocated})`);
    }
    for (const row of item.transit) {
      transitStmt.run(
        item.model, row.quantity, row.quantity, row.plan, row.date, row.version, row.fnsku,
        row.brand ?? "", row.transportMethod ?? "", row.shippingMethod ?? "", row.team ?? "",
        row.status, row.onShelf, 0, at, at,
      );
    }
  }
}

function documentNumber(id, legacy = false) {
  return `${legacy ? "ALLOC-LEGACY" : "ALLOC"}-${String(id).padStart(8, "0")}`;
}

function upgradeNumber(id) {
  return `UPG-${String(id).padStart(8, "0")}`;
}

function relocationNumber(id) {
  return `MOVE-${String(id).padStart(8, "0")}`;
}

function upgradeOperationNumber(id) {
  return `UOP-${String(id).padStart(8, "0")}`;
}

function relocationWorkNumber(id) {
  return `MOVE-WORK-${String(id).padStart(8, "0")}`;
}

function correctionNumber(id) {
  return `CORR-${String(id).padStart(8, "0")}`;
}

const CORRECTION_STATUS_TEXT = {
  pending: "待处理",
  processing: "处理中",
  completed: "已完成",
  rejected: "已驳回",
  cancelled: "已取消",
  execution_failed: "执行失败",
};

const ACTIVE_CORRECTION_STATUSES = ["pending", "processing", "execution_failed"];

function documentSnapshot(row) {
  return {
    id: Number(row.id),
    documentNo: row.document_no,
    model: row.model,
    batchKey: row.batch_key,
    plan: row.plan,
    date: row.ship_date,
    version: row.version,
    fnsku: row.fnsku,
    quantity: Number(row.quantity),
    department: row.department,
    store: row.store_name,
    operator: row.operator_name,
    status: row.status,
    revision: Number(row.revision),
    confirmedAt: row.confirmed_at,
    externalSyncStatus: row.external_sync_status,
  };
}

function correctionSnapshot({ quantity, department, store, operator }) {
  return { quantity: Number(quantity), department, store, operator };
}

function rootDocumentId(db, documentId) {
  let current = Number(documentId);
  const visited = new Set();
  while (!visited.has(current)) {
    visited.add(current);
    const row = db.prepare("SELECT correction_of_id FROM allocation_documents WHERE id = ?").get(current);
    if (!row || row.correction_of_id == null) return current;
    current = Number(row.correction_of_id);
  }
  throw new Error(`单据纠错链形成循环：${[...visited].join(" -> ")}`);
}

function normalizeLegacyDepartment(value) {
  return value === "二团" ? "二团" : "一团";
}

function legacyStatus(value) {
  if (value === "调拨完成，已备份") return "confirmed";
  if (value === "已撤销") return "cancelled";
  if (value === "已撤回") return "withdrawn";
  return "pending";
}

function setSequenceAtLeast(db, table, value) {
  const result = db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?").run(value, table);
  if (Number(result.changes) === 0) db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)").run(table, value);
}

function insertCorrectionRow(db, fields) {
  const placeholder = `PENDING-${crypto.randomUUID()}`;
  const values = {
    correction_no: placeholder,
    root_document_id: fields.rootDocumentId,
    source_document_id: fields.sourceDocumentId,
    result_document_id: fields.resultDocumentId ?? null,
    correction_type: fields.correctionType,
    application_reason: fields.applicationReason,
    applicant_name: fields.applicantName,
    applicant_role: fields.applicantRole,
    applied_at: fields.appliedAt,
    status: fields.status,
    source_revision: fields.sourceRevision,
    proposed_quantity: fields.proposed.quantity,
    proposed_department: fields.proposed.department,
    proposed_store_name: fields.proposed.store,
    proposed_operator_name: fields.proposed.operator,
    original_snapshot_json: JSON.stringify(fields.original),
    proposed_snapshot_json: JSON.stringify(fields.proposed),
    version: fields.version ?? 1,
    reviewed_by_role: fields.reviewedByRole ?? null,
    reviewed_by_name: fields.reviewedByName ?? null,
    reviewed_at: fields.reviewedAt ?? null,
    review_comment: fields.reviewComment ?? null,
    processed_by_role: fields.processedByRole ?? null,
    processed_by_name: fields.processedByName ?? null,
    processed_at: fields.processedAt ?? null,
    cancelled_by_role: fields.cancelledByRole ?? null,
    cancelled_by_name: fields.cancelledByName ?? null,
    cancelled_at: fields.cancelledAt ?? null,
    cancel_reason: fields.cancelReason ?? null,
    failure_code: fields.failureCode ?? null,
    failure_reason: fields.failureReason ?? null,
    failed_at: fields.failedAt ?? null,
    impact_hash: fields.impactHash ?? null,
    reversal_group: fields.reversalGroup ?? null,
    created_at: fields.createdAt,
    updated_at: fields.updatedAt,
  };
  const columns = Object.keys(values);
  const result = db.prepare(`
    INSERT INTO correction_requests(${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `).run(...Object.values(values));
  const id = Number(result.lastInsertRowid);
  db.prepare("UPDATE correction_requests SET correction_no = ? WHERE id = ?").run(correctionNumber(id), id);
  return db.prepare("SELECT * FROM correction_requests WHERE id = ?").get(id);
}

function addCorrectionEventRaw(db, correctionId, type, role, operatorName, at, reason = null, payload = {}) {
  db.prepare(`
    INSERT INTO correction_events(correction_id, event_type, role, operator_name, occurred_at, reason, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(correctionId, type, role, operatorName, at, reason, JSON.stringify(payload));
}

function migrateLegacyCorrectionsV2(db, appliedAt) {
  const children = db.prepare(`
    SELECT child.*, source.withdraw_reason AS source_withdraw_reason,
           source.withdrawn_by_role AS source_withdrawn_by_role,
           source.withdrawn_at AS source_withdrawn_at
    FROM allocation_documents child
    JOIN allocation_documents source ON source.id = child.correction_of_id
    ORDER BY child.id
  `).all();
  const representedSources = new Set();
  let migrated = 0;
  for (const child of children) {
    const source = db.prepare("SELECT * FROM allocation_documents WHERE id = ?").get(child.correction_of_id);
    if (!source) continue;
    representedSources.add(Number(source.id));
    const status = child.status === "confirmed"
      ? "completed"
      : child.status === "cancelled"
        ? "cancelled"
        : child.status === "withdrawn"
          ? "execution_failed"
          : "processing";
    const appliedAtValue = child.source_withdrawn_at || child.created_at || appliedAt;
    const role = String(child.source_withdrawn_by_role || child.created_by_role || "migration");
    const reverse = db.prepare("SELECT reversal_group FROM inventory_ledger WHERE document_id = ? AND entry_type = 'reverse_issue'").get(source.id);
    const row = insertCorrectionRow(db, {
      rootDocumentId: rootDocumentId(db, source.id),
      sourceDocumentId: Number(source.id),
      resultDocumentId: Number(child.id),
      correctionType: "历史撤回纠错",
      applicationReason: String(child.source_withdraw_reason || "v1 撤回后生成的待修改单据"),
      applicantName: role,
      applicantRole: role,
      appliedAt: appliedAtValue,
      status,
      sourceRevision: Number(source.revision),
      proposed: correctionSnapshot({ quantity: child.quantity, department: child.department, store: child.store_name, operator: child.operator_name }),
      original: documentSnapshot(source),
      reviewedByRole: role,
      reviewedByName: role,
      reviewedAt: child.source_withdrawn_at || appliedAtValue,
      reviewComment: "由 v1 已撤回/待修改流程迁入",
      processedByRole: status === "completed" ? String(child.confirmed_by_role || role) : null,
      processedByName: status === "completed" ? String(child.confirmed_by_role || role) : null,
      processedAt: status === "completed" ? (child.confirmed_at || child.updated_at) : null,
      cancelledByRole: status === "cancelled" ? String(child.cancelled_by_role || role) : null,
      cancelledByName: status === "cancelled" ? String(child.cancelled_by_role || role) : null,
      cancelledAt: status === "cancelled" ? (child.cancelled_at || child.updated_at) : null,
      cancelReason: status === "cancelled" ? String(child.cancel_reason || "历史纠错单已撤销") : null,
      failureCode: status === "execution_failed" ? "legacy_child_withdrawn" : null,
      failureReason: status === "execution_failed" ? "历史纠错子单也已撤回，需人工核对" : null,
      failedAt: status === "execution_failed" ? child.updated_at : null,
      reversalGroup: reverse?.reversal_group ?? null,
      createdAt: appliedAtValue,
      updatedAt: child.updated_at || appliedAtValue,
    });
    addCorrectionEventRaw(db, Number(row.id), "legacy_migrated", "migration", "v2 数据迁移", appliedAt, null, {
      sourceDocumentId: Number(source.id), resultDocumentId: Number(child.id), legacyChildStatus: child.status,
    });
    migrated += 1;
  }

  const orphanWithdrawals = db.prepare("SELECT * FROM allocation_documents WHERE status = 'withdrawn' ORDER BY id").all()
    .filter((row) => !representedSources.has(Number(row.id)));
  for (const source of orphanWithdrawals) {
    const role = String(source.withdrawn_by_role || "migration");
    const reverse = db.prepare("SELECT reversal_group FROM inventory_ledger WHERE document_id = ? AND entry_type = 'reverse_issue'").get(source.id);
    const at = source.withdrawn_at || source.updated_at || appliedAt;
    const row = insertCorrectionRow(db, {
      rootDocumentId: rootDocumentId(db, source.id), sourceDocumentId: Number(source.id),
      correctionType: "历史仅撤回", applicationReason: String(source.withdraw_reason || "历史记录仅完成撤回冲销"),
      applicantName: role, applicantRole: role, appliedAt: at, status: "completed", sourceRevision: Number(source.revision),
      proposed: correctionSnapshot({ quantity: source.quantity, department: source.department, store: source.store_name, operator: source.operator_name }),
      original: documentSnapshot(source), processedByRole: role, processedByName: role, processedAt: at,
      reversalGroup: reverse?.reversal_group ?? null, createdAt: at, updatedAt: source.updated_at || at,
    });
    addCorrectionEventRaw(db, Number(row.id), "legacy_migrated", "migration", "v2 数据迁移", appliedAt, "历史记录没有关联纠错子单", {
      sourceDocumentId: Number(source.id), resultDocumentId: null,
    });
    migrated += 1;
  }
  return { migratedCorrections: migrated, migratedLegacyChildren: children.length, migratedOrphanWithdrawals: orphanWithdrawals.length };
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => String(row.name)));
}

function migrateTransitSchemaV3(db, appliedAt) {
  const columns = tableColumns(db, "transit_batches");
  const add = (name, definition) => {
    if (!columns.has(name)) db.exec(`ALTER TABLE transit_batches ADD COLUMN ${name} ${definition}`);
  };
  /* v2 的 quantity 是唯一口径；v3 保留它作为原始数量，并以 remaining_quantity 作为在途余额。 */
  add("remaining_quantity", "INTEGER NOT NULL DEFAULT 0");
  add("brand", "TEXT NOT NULL DEFAULT ''");
  add("transport_method", "TEXT NOT NULL DEFAULT ''");
  add("shipping_method", "TEXT NOT NULL DEFAULT ''");
  add("team", "TEXT NOT NULL DEFAULT ''");
  add("status", "TEXT NOT NULL DEFAULT 'in_transit'");
  add("is_legacy_placeholder", "INTEGER NOT NULL DEFAULT 0");
  add("import_batch_id", "INTEGER");
  add("source_row", "INTEGER");
  add("revision", "INTEGER NOT NULL DEFAULT 1");
  add("created_at", "TEXT NOT NULL DEFAULT ''");
  add("updated_at", "TEXT NOT NULL DEFAULT ''");
  add("on_shelf_by_role", "TEXT");
  add("on_shelf_at", "TEXT");
  db.prepare("UPDATE transit_batches SET remaining_quantity = quantity WHERE remaining_quantity = 0 AND status = 'in_transit'").run();
  db.prepare("UPDATE transit_batches SET created_at = ? WHERE created_at = ''").run(appliedAt);
  db.prepare("UPDATE transit_batches SET updated_at = ? WHERE updated_at = ''").run(appliedAt);
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transit_id INTEGER NOT NULL REFERENCES transit_batches(id),
      batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      UNIQUE (transit_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS transit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transit_id INTEGER NOT NULL REFERENCES transit_batches(id),
      event_type TEXT NOT NULL CHECK (event_type IN ('imported', 'status_updated', 'on_shelf')),
      role TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_receipts_batch ON stock_receipts(batch_key);
    CREATE INDEX IF NOT EXISTS idx_transit_model_status ON transit_batches(model, status, id);
    CREATE INDEX IF NOT EXISTS idx_transit_events_transit ON transit_events(transit_id, id);
    CREATE TRIGGER IF NOT EXISTS transit_batches_no_delete
    BEFORE DELETE ON transit_batches
    BEGIN SELECT RAISE(ABORT, '在途记录禁止删除'); END;
    CREATE TRIGGER IF NOT EXISTS stock_receipts_no_update
    BEFORE UPDATE ON stock_receipts
    BEGIN SELECT RAISE(ABORT, '上架入库凭证禁止覆盖'); END;
    CREATE TRIGGER IF NOT EXISTS stock_receipts_no_delete
    BEFORE DELETE ON stock_receipts
    BEGIN SELECT RAISE(ABORT, '上架入库凭证禁止删除'); END;
    CREATE TRIGGER IF NOT EXISTS transit_events_no_update
    BEFORE UPDATE ON transit_events
    BEGIN SELECT RAISE(ABORT, '在途事件禁止覆盖'); END;
    CREATE TRIGGER IF NOT EXISTS transit_events_no_delete
    BEFORE DELETE ON transit_events
    BEGIN SELECT RAISE(ABORT, '在途事件禁止删除'); END;
  `);
  const models = db.prepare("SELECT model FROM catalog_models").all();
  /* v2 只有 catalog_models.in_transit 汇总而没有明细的差额。新规则不再把
     没有身份字段的差额伪造成在途批次；清除旧汇总差额并留下迁移审计。 */
  for (const row of models) {
    const cached = Number(db.prepare("SELECT in_transit FROM catalog_models WHERE model = ?").get(row.model)?.in_transit || 0);
    const detailed = Number(db.prepare("SELECT COALESCE(SUM(remaining_quantity), 0) AS total FROM transit_batches WHERE model = ? AND status = 'in_transit'").get(row.model)?.total || 0);
    const difference = cached - detailed;
    if (difference > 0) {
      recordLegacyPlaceholderRemoval(db, {
        kind: "transit",
        model: row.model,
        quantity: difference,
        at: appliedAt,
      });
    }
  }
  const refresh = db.prepare(`
    UPDATE catalog_models
    SET in_transit = COALESCE((SELECT SUM(remaining_quantity) FROM transit_batches WHERE model = catalog_models.model AND status = 'in_transit'), 0),
        updated_at = ?
    WHERE model = ?
  `);
  for (const row of models) refresh.run(appliedAt, row.model);
}

function migrateTransitSchemaV4(db, appliedAt) {
  /* 不自动删除或合并历史重复行；发现重复时让迁移整体回滚并报告。 */
  const duplicates = db.prepare(`
    SELECT model, plan, ship_date, version, fnsku, COUNT(*) AS count,
           GROUP_CONCAT(id) AS ids
    FROM transit_batches
    WHERE status = 'in_transit' AND is_legacy_placeholder = 0 AND remaining_quantity > 0
    GROUP BY model, plan, ship_date, version, fnsku
    HAVING COUNT(*) > 1
    ORDER BY model, plan, ship_date, version, fnsku
  `).all();
  if (duplicates.length > 0) {
    throw new Error(`迁移发现活动在途五字段重复，未删除或合并任何记录：${JSON.stringify(duplicates)}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS transit_preview_tokens (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('import', 'status')),
      role TEXT NOT NULL,
      database_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      template_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transit_identity_active
      ON transit_batches(model, plan, ship_date, version, fnsku)
      WHERE status = 'in_transit' AND is_legacy_placeholder = 0 AND remaining_quantity > 0;
    CREATE INDEX IF NOT EXISTS idx_transit_preview_expiry ON transit_preview_tokens(expires_at);
  `);
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (4, ?, ?)")
    .run(appliedAt, "在途身份唯一约束与服务器预览凭证");
}

function migrateTransitSchemaV5(db, appliedAt) {
  const catalogColumns = tableColumns(db, "catalog_models");
  if (!catalogColumns.has("created_by_import_id")) {
    db.exec("ALTER TABLE catalog_models ADD COLUMN created_by_import_id INTEGER REFERENCES import_batches(id)");
  }
  const stockColumns = tableColumns(db, "stock_batches");
  if (!stockColumns.has("created_by_import_id")) {
    db.exec("ALTER TABLE stock_batches ADD COLUMN created_by_import_id INTEGER REFERENCES import_batches(id)");
  }
  const receiptColumns = tableColumns(db, "stock_receipts");
  if (!receiptColumns.has("ledger_watermark")) {
    /* 历史上架凭证没有可证明的流水边界，保留 NULL；撤销时按不可安全回退处理。 */
    db.exec("ALTER TABLE stock_receipts ADD COLUMN ledger_watermark INTEGER");
  }

  const importTableSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_batches'").get()?.sql ?? "");
  if (!importTableSql.includes("reverted_by_role")) {
    db.exec(`
      DROP TABLE IF EXISTS import_batches_v5;
      CREATE TABLE import_batches_v5 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_name TEXT NOT NULL,
        file_sha256 TEXT NOT NULL,
        template_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('staged', 'reverted')),
        row_count INTEGER NOT NULL CHECK (row_count >= 0),
        inventory_applied INTEGER NOT NULL DEFAULT 0 CHECK (inventory_applied IN (0, 1)),
        created_by_role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reverted_by_role TEXT,
        reverted_at TEXT
      ) STRICT;
      INSERT INTO import_batches_v5(
        id, file_name, file_sha256, template_sha256, status, row_count,
        inventory_applied, created_by_role, created_at, reverted_by_role, reverted_at
      )
      SELECT id, file_name, file_sha256, template_sha256, status, row_count,
             inventory_applied, created_by_role, created_at, NULL, NULL
      FROM import_batches;
      DROP TABLE import_batches;
      ALTER TABLE import_batches_v5 RENAME TO import_batches;
    `);
  }
  db.exec(`
    DROP INDEX IF EXISTS uq_import_batches_active_file;
    CREATE UNIQUE INDEX uq_import_batches_active_file
      ON import_batches(file_sha256) WHERE status <> 'reverted';

    DROP TRIGGER IF EXISTS transit_batches_no_delete;
    DROP TRIGGER IF EXISTS stock_receipts_no_delete;
    DROP TRIGGER IF EXISTS transit_events_no_delete;

    CREATE TRIGGER transit_batches_no_delete
    BEFORE DELETE ON transit_batches
    WHEN COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
         <> COALESCE(OLD.import_batch_id, -2)
    BEGIN SELECT RAISE(ABORT, '在途记录禁止删除'); END;

    CREATE TRIGGER stock_receipts_no_delete
    BEFORE DELETE ON stock_receipts
    WHEN COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
         <> COALESCE((SELECT import_batch_id FROM transit_batches WHERE id = OLD.transit_id), -2)
    BEGIN SELECT RAISE(ABORT, '上架入库凭证禁止删除'); END;

    CREATE TRIGGER transit_events_no_delete
    BEFORE DELETE ON transit_events
    WHEN COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
         <> COALESCE((SELECT import_batch_id FROM transit_batches WHERE id = OLD.transit_id), -2)
    BEGIN SELECT RAISE(ABORT, '在途事件禁止删除'); END;
  `);
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get()) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (5, ?, ?)")
      .run(appliedAt, "在途导入批次原子撤销、来源标识与后续库存使用保护");
  }
}

function migrateTransitSchemaV6(db, appliedAt) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transit_import_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      import_batch_id INTEGER NOT NULL UNIQUE REFERENCES import_batches(id),
      database_id TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      template_sha256 TEXT NOT NULL,
      structure_version INTEGER NOT NULL CHECK (structure_version >= 1),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('native', 'historical_backup_rebuild')),
      source_reference_sha256 TEXT,
      content_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
  `);
  const importColumns = tableColumns(db, "import_batches");
  if (!importColumns.has("database_id")) db.exec("ALTER TABLE import_batches ADD COLUMN database_id TEXT");
  if (!importColumns.has("client_session_id")) db.exec("ALTER TABLE import_batches ADD COLUMN client_session_id TEXT");
  if (!importColumns.has("snapshot_id")) db.exec("ALTER TABLE import_batches ADD COLUMN snapshot_id TEXT REFERENCES transit_import_snapshots(snapshot_id)");
  if (!importColumns.has("revert_request_id")) db.exec("ALTER TABLE import_batches ADD COLUMN revert_request_id TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_import_batches_active_client_session
      ON import_batches(database_id, client_session_id, created_by_role)
      WHERE status <> 'reverted' AND database_id IS NOT NULL AND client_session_id IS NOT NULL;

    DROP TRIGGER IF EXISTS transit_import_snapshots_no_update;
    DROP TRIGGER IF EXISTS transit_import_snapshots_no_delete;
    CREATE TRIGGER transit_import_snapshots_no_update
    BEFORE UPDATE ON transit_import_snapshots
    BEGIN SELECT RAISE(ABORT, '在途导入逻辑快照禁止覆盖'); END;
    CREATE TRIGGER transit_import_snapshots_no_delete
    BEFORE DELETE ON transit_import_snapshots
    BEGIN SELECT RAISE(ABORT, '在途导入逻辑快照禁止删除'); END;
  `);
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get()) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (6, ?, ?)")
      .run(appliedAt, "在途导入批次级逻辑快照、客户端持久清空入口与贡献恢复");
  }
}

/* v6 -> v7：为外部整库快照、精确下架和单条在途录入补充最小来源标识。
   型号层遗留基线不再迁移成没有身份字段的占位批次，差额只写入迁移审计。 */
function migrateTransitSchemaV7(db, appliedAt) {
  const stockColumns = tableColumns(db, "stock_batches");
  if (!stockColumns.has("created_by_transit_id")) {
    db.exec("ALTER TABLE stock_batches ADD COLUMN created_by_transit_id INTEGER REFERENCES transit_batches(id)");
  }
  if (!stockColumns.has("is_legacy_placeholder")) {
    db.exec("ALTER TABLE stock_batches ADD COLUMN is_legacy_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_legacy_placeholder IN (0, 1))");
  }
  const models = db.prepare("SELECT model, base_in_stock FROM catalog_models ORDER BY model").all();
  const clearBase = db.prepare("UPDATE catalog_models SET base_in_stock = 0, updated_at = ?, revision = revision + 1 WHERE model = ? AND base_in_stock > 0");
  for (const model of models) {
    const quantity = Number(model.base_in_stock || 0);
    if (quantity <= 0) continue;
    /* v6 的型号基线可能已经由普通 stock_batches 表示；无法由明细解释的
       差额不再生成未分配批次，避免迁移继续制造无法调拨的占位数据。 */
    const detailed = db.prepare(`
      SELECT COALESCE(SUM(
        b.base_quantity
        + COALESCE((SELECT SUM(r.quantity) FROM stock_receipts r WHERE r.batch_key = b.batch_key), 0)
        + COALESCE((SELECT SUM(l.on_hand_delta) FROM inventory_ledger l WHERE l.batch_key = b.batch_key), 0)
      ), 0) AS quantity
      FROM stock_batches b WHERE b.model = ?
    `).get(model.model);
    const unallocated = Math.max(0, quantity - Number(detailed?.quantity || 0));
    if (unallocated <= 0) {
      clearBase.run(appliedAt, model.model);
      continue;
    }
    recordLegacyPlaceholderRemoval(db, {
      kind: "stock",
      model: model.model,
      batchKey: `${model.model}#LEGACY-UNALLOCATED`,
      quantity: unallocated,
      at: appliedAt,
    });
    clearBase.run(appliedAt, model.model);
  }

  db.exec(`
    DROP TRIGGER IF EXISTS transit_batches_no_delete;
    DROP TRIGGER IF EXISTS stock_receipts_no_delete;
    DROP TRIGGER IF EXISTS transit_events_no_delete;
    CREATE TRIGGER transit_batches_no_delete
    BEFORE DELETE ON transit_batches
    WHEN COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
         <> COALESCE(OLD.import_batch_id, -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1) <> OLD.id
    BEGIN SELECT RAISE(ABORT, '在途记录禁止删除'); END;
    CREATE TRIGGER stock_receipts_no_delete
    BEFORE DELETE ON stock_receipts
    WHEN COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
         <> COALESCE((SELECT import_batch_id FROM transit_batches WHERE id = OLD.transit_id), -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1) <> OLD.transit_id
    BEGIN SELECT RAISE(ABORT, '上架入库凭证禁止删除'); END;
    CREATE TRIGGER transit_events_no_delete
    BEFORE DELETE ON transit_events
    WHEN COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
         <> COALESCE((SELECT import_batch_id FROM transit_batches WHERE id = OLD.transit_id), -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1) <> OLD.transit_id
    BEGIN SELECT RAISE(ABORT, '在途事件禁止删除'); END;
  `);
  const refresh = db.prepare(`
    UPDATE catalog_models
    SET in_transit = COALESCE((SELECT SUM(remaining_quantity) FROM transit_batches WHERE model = catalog_models.model AND status = 'in_transit' AND remaining_quantity > 0), 0),
        updated_at = ?
    WHERE model = ?
  `);
  for (const model of models) refresh.run(appliedAt, model.model);
  db.prepare("UPDATE transit_batches SET on_shelf_indicator = '尚未确认' WHERE status = 'in_transit' AND on_shelf_indicator IN ('填写 YES', '助理填写 YES')").run();
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 7").get()) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (7, ?, ?)")
      .run(appliedAt, "统一库存明细口径、整库快照恢复、单条在途录入与下架");
  }
}

/* v7 -> v8：为在途记录增加业务作废 tombstone。原始行、数量和事件不可删除；
   活动汇总与复合键约束仅统计 voided_at 为空的记录。迁移可重复执行。 */
function migrateTransitSchemaV8(db, appliedAt) {
  const columns = tableColumns(db, "transit_batches");
  if (!columns.has("voided_at")) db.exec("ALTER TABLE transit_batches ADD COLUMN voided_at TEXT");
  if (!columns.has("voided_by_role")) db.exec("ALTER TABLE transit_batches ADD COLUMN voided_by_role TEXT");
  if (!columns.has("voided_request_id")) db.exec("ALTER TABLE transit_batches ADD COLUMN voided_request_id TEXT");
  db.exec(`
    DROP INDEX IF EXISTS idx_transit_identity_active;
    CREATE UNIQUE INDEX idx_transit_identity_active
      ON transit_batches(model, plan, ship_date, version, fnsku)
      WHERE status = 'in_transit' AND is_legacy_placeholder = 0 AND remaining_quantity > 0 AND voided_at IS NULL;
  `);
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 8").get()) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (8, ?, ?)")
      .run(appliedAt, "在途记录业务作废 tombstone 与删除审计");
  }
}

function migrateStockFnskuSchemaV20(db, appliedAt) {
  db.exec(`
    CREATE TABLE stock_batches_v20 (
      batch_key TEXT PRIMARY KEY,
      model TEXT NOT NULL REFERENCES catalog_models(model),
      plan TEXT NOT NULL DEFAULT '', ship_date TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '', fnsku TEXT NOT NULL DEFAULT '',
      base_quantity INTEGER NOT NULL CHECK (base_quantity >= 0),
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_by_import_id INTEGER REFERENCES import_batches(id),
      created_by_transit_id INTEGER REFERENCES transit_batches(id),
      is_legacy_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_legacy_placeholder IN (0, 1)),
      UNIQUE (model, plan, ship_date, version, fnsku)
    ) STRICT;
    INSERT INTO stock_batches_v20 SELECT * FROM stock_batches;
    DROP TABLE stock_batches;
    ALTER TABLE stock_batches_v20 RENAME TO stock_batches;
  `);
  installLegacyPlaceholderGuards(db);
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (20, ?, ?)")
    .run(appliedAt, "在库批次按 FNSKU 区分，保留原批次键和全部引用");
}

function migrateSimplificationV21(db, appliedAt) {
  db.exec("DROP VIEW relocation_sources");
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='inquiry_documents'").get().sql;
  const related = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('index','trigger') AND (tbl_name='inquiry_documents' OR sql LIKE '%inquiry_documents%')").all();
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='inquiry_documents'").get()?.seq;
  for (const item of related) db.exec(`DROP ${item.type} "${item.name}"`);
  db.exec(schema.replace('inquiry_documents', 'inquiry_documents_v21').replace('supplier_quantity >= 0 AND supplier_quantity <= approved_quantity', 'supplier_quantity >= 0'));
  db.exec(`INSERT INTO inquiry_documents_v21 SELECT * FROM inquiry_documents;
    DROP TABLE inquiry_documents;
    ALTER TABLE inquiry_documents_v21 RENAME TO inquiry_documents;`);
  for (const item of related) db.exec(item.sql);
  if (sequence != null) db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='inquiry_documents'").run(sequence);
  db.exec(`
    CREATE VIEW relocation_sources AS
      SELECT id AS allocation_document_id, NULL AS inquiry_id, 'allocation' AS source_kind,
        document_no, model, batch_key, plan, ship_date, version, fnsku, quantity,
        department, store_name, operator_name, asin, status, confirmed_at, NULL AS fba_shipped_at
      FROM allocation_documents
      UNION ALL
      SELECT NULL, id, 'inquiry', document_no, model, NULL, plan, ship_date, version, fnsku, supplier_quantity,
        department, store_name, operator_name, asin, status, archived_at, fba_shipped_at FROM inquiry_documents;`);
  db.exec(`CREATE VIEW stock_balances AS
    SELECT b.*,
      COALESCE((SELECT SUM(quantity) FROM stock_receipts WHERE batch_key=b.batch_key),0) AS receipt_quantity,
      COALESCE((SELECT SUM(on_hand_delta) FROM upgrade_inventory_ledger WHERE batch_key=b.batch_key AND on_hand_delta>0),0) AS upgrade_receipt_quantity,
      b.base_quantity + COALESCE((SELECT SUM(quantity) FROM stock_receipts WHERE batch_key=b.batch_key),0)
        + COALESCE((SELECT SUM(on_hand_delta) FROM inventory_ledger WHERE batch_key=b.batch_key),0)
        + COALESCE((SELECT SUM(on_hand_delta) FROM upgrade_inventory_ledger WHERE batch_key=b.batch_key),0) AS on_hand,
      COALESCE((SELECT SUM(locked_delta) FROM inventory_ledger WHERE batch_key=b.batch_key),0)
        + COALESCE((SELECT SUM(locked_delta) FROM upgrade_inventory_ledger WHERE batch_key=b.batch_key),0) AS locked,
      -COALESCE((SELECT SUM(on_hand_delta) FROM inventory_ledger WHERE batch_key=b.batch_key),0) AS done
    FROM stock_batches b;`);
  db.prepare(`UPDATE inquiry_documents SET status = 'archived', archived_at = ?, archived_by_role = replied_by_role,
    revision = revision + 1, updated_at = ? WHERE status = 'pending_purchasing' AND supplier_quantity = 0`).run(appliedAt, appliedAt);
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (21, ?, ?)")
    .run(appliedAt, "精简询库为供应商最终量归档来源；无货结束；保留历史发货、撤回与记账记录");
}

function migrateLingxingHostV22(db, at) {
  db.exec(`CREATE TABLE lingxing_sync_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    request_json TEXT NOT NULL,
    requested_from TEXT NOT NULL,
    target_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
    message TEXT NOT NULL,
    worker_id TEXT,
    capture_json TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE UNIQUE INDEX idx_lingxing_single_running ON lingxing_sync_jobs(state) WHERE state='running';
  CREATE INDEX idx_lingxing_queue ON lingxing_sync_jobs(state,id);`);
  db.prepare('INSERT INTO schema_migrations(version,applied_at,description) VALUES(22,?,?)')
    .run(at, '部署电脑串行执行领星同步，持久化请求、采集结果和保存状态');
}

function migrateBusinessCorrectionsV23(db, at) {
  // 更正追加流水；允许同一单据多次重办。原流水及外键编号全部保留。
  const view = db.prepare("SELECT sql FROM sqlite_master WHERE name='stock_balances'").get().sql;
  db.exec('DROP VIEW stock_balances');
  const related = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='inventory_ledger' AND sql IS NOT NULL AND type IN ('index','trigger')").all();
  for (const item of related) db.exec(`DROP ${item.type} "${item.name}"`);
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='inventory_ledger'").get().sql;
  db.exec(schema.replace(/CREATE TABLE "?inventory_ledger"?/, 'CREATE TABLE inventory_ledger_v23')
    .replace('document_id INTEGER NOT NULL', 'document_id INTEGER')
    .replace("'reverse_issue'))", "'reverse_issue', 'correction', 'return_receipt'))")
    .replace(/,\s*UNIQUE \(document_id, entry_type\)/, ''));
  db.exec('INSERT INTO inventory_ledger_v23 SELECT * FROM inventory_ledger; DROP TABLE inventory_ledger; ALTER TABLE inventory_ledger_v23 RENAME TO inventory_ledger');
  for (const item of related) db.exec(item.sql);
  db.exec(view.replace('FROM inventory_ledger WHERE batch_key=b.batch_key),0) AS done', 'FROM inventory_ledger WHERE batch_key=b.batch_key AND document_id IS NOT NULL),0) AS done'));
  const receiptView=db.prepare("SELECT sql FROM sqlite_master WHERE name='stock_balances'").get().sql;
  db.exec('DROP VIEW stock_balances');
  const receiptSchema=db.prepare("SELECT sql FROM sqlite_master WHERE name='stock_receipts'").get().sql;
  const receiptObjects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='stock_receipts' AND sql IS NOT NULL AND type IN ('index','trigger')").all();
  for(const item of receiptObjects)db.exec(`DROP ${item.type} "${item.name}"`);
  db.exec(receiptSchema.replace(/CREATE TABLE "?stock_receipts"?/,'CREATE TABLE stock_receipts_v23').replace(/,\s*UNIQUE \(transit_id\)/,''));
  db.exec('INSERT INTO stock_receipts_v23 SELECT * FROM stock_receipts; DROP TABLE stock_receipts; ALTER TABLE stock_receipts_v23 RENAME TO stock_receipts');
  for(const item of receiptObjects)db.exec(item.sql);
  db.exec(receiptView);
  // 每个导入源行保留原始payload，当前贡献单独记录，避免回退合并明细时误减其他文件。
  db.exec('ALTER TABLE import_rows ADD COLUMN corrected_quantity INTEGER CHECK(corrected_quantity >= 0)');
  const packageSchema=db.prepare("SELECT sql FROM sqlite_master WHERE name='upgrade_relocation_external_items'").get().sql;
  const packageObjects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='upgrade_relocation_external_items' AND sql IS NOT NULL AND type IN ('index','trigger')").all();
  for(const item of packageObjects)db.exec(`DROP ${item.type} "${item.name}"`);
  db.exec(packageSchema.replace(/CREATE TABLE "?upgrade_relocation_external_items"?/,'CREATE TABLE upgrade_relocation_external_items_v23').replace('CHECK (quantity > 0)','CHECK (quantity <> 0)').replace(/,\s*UNIQUE \(relocation_id, line_id\)/,''));
  db.exec('INSERT INTO upgrade_relocation_external_items_v23 SELECT * FROM upgrade_relocation_external_items; DROP TABLE upgrade_relocation_external_items; ALTER TABLE upgrade_relocation_external_items_v23 RENAME TO upgrade_relocation_external_items');
  for(const item of packageObjects)db.exec(item.sql);
  const sourceView = db.prepare("SELECT sql FROM sqlite_master WHERE name='relocation_sources'").get().sql;
  db.exec('DROP VIEW relocation_sources');
  db.exec(sourceView.replace('fnsku, quantity,', "fnsku, quantity - COALESCE((SELECT SUM(on_hand_delta) FROM inventory_ledger WHERE document_id=allocation_documents.id AND entry_type='return_receipt'),0) AS quantity,"));
  db.prepare('INSERT INTO schema_migrations(version,applied_at,description) VALUES(23,?,?)').run(at,'岗位业务更正、追加调整流水、退货来源扣减及文件贡献量');
}

function migrateSourceAttributionV24(db, at) {
  db.exec('ALTER TABLE import_rows ADD COLUMN current_transit_id INTEGER REFERENCES transit_batches(id)');
  const schema=db.prepare("SELECT sql FROM sqlite_master WHERE name='upgrade_stock_lines'").get().sql;
  const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='upgrade_stock_lines' AND sql IS NOT NULL AND type IN ('index','trigger')").all();
  for(const o of objects)db.exec(`DROP ${o.type} "${o.name}"`);
  db.exec(schema.replace(/CREATE TABLE (?:IF NOT EXISTS )?"?upgrade_stock_lines"?/,'CREATE TABLE upgrade_stock_lines_v24').replace('initial_quantity > 0','initial_quantity >= 0'));
  db.exec('INSERT INTO upgrade_stock_lines_v24 SELECT * FROM upgrade_stock_lines; DROP TABLE upgrade_stock_lines; ALTER TABLE upgrade_stock_lines_v24 RENAME TO upgrade_stock_lines');
  for(const o of objects)db.exec(o.sql);
  db.prepare('INSERT INTO schema_migrations(version,applied_at,description) VALUES(24,?,?)').run(at,'按凭证更正文件来源及已使用库存关联，原导入内容保留');
}

function migrateWarehouseFbaV25(db, at) {
  const views = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='view'").all();
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  for (const item of views) db.exec(`DROP VIEW "${item.name}"`);
  for (const item of triggers) db.exec(`DROP TRIGGER "${item.name}"`);
  db.exec(`ALTER TABLE stock_batches ADD COLUMN warehouse TEXT NOT NULL DEFAULT '';
    CREATE TABLE fba_archives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transit_id INTEGER NOT NULL UNIQUE REFERENCES transit_batches(id),
      model TEXT NOT NULL REFERENCES catalog_models(model), quantity INTEGER NOT NULL CHECK(quantity>0),
      plan TEXT NOT NULL, ship_date TEXT NOT NULL, version TEXT NOT NULL, fnsku TEXT NOT NULL,
      team TEXT NOT NULL, shipping_method TEXT NOT NULL, archived_at TEXT NOT NULL, archived_by_role TEXT NOT NULL
    ) STRICT;`);
  for (const table of ['stock_batches','upgrade_jobs','upgrade_relocations','upgrade_relocation_work_items']) {
    const sequence = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)?.seq;
    if (table !== 'stock_batches') db.exec(`ALTER TABLE ${table} ADD COLUMN fba_archive_id INTEGER REFERENCES fba_archives(id)`);
    let sql = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table).sql;
    const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type='index' AND sql IS NOT NULL").all(table);
    sql = sql.replace(/CREATE TABLE (?:IF NOT EXISTS )?"?\w+"?/, `CREATE TABLE ${table}_v25`)
      .replace('UNIQUE (model, plan, ship_date, version, fnsku)', 'UNIQUE (model, plan, ship_date, version, fnsku, warehouse)')
      .replaceAll('((allocation_document_id IS NOT NULL) <> (inquiry_id IS NOT NULL))', '((allocation_document_id IS NOT NULL) + (inquiry_id IS NOT NULL) + (fba_archive_id IS NOT NULL) = 1)')
      .replace("kind = 'direct' AND allocation_document_id IS NULL AND inquiry_id IS NULL", "kind = 'direct' AND allocation_document_id IS NULL AND inquiry_id IS NULL AND fba_archive_id IS NULL");
    db.exec(sql);
    db.exec(`INSERT INTO ${table}_v25 SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_v25 RENAME TO ${table}`);
    if (sequence !== undefined) {
      db.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(table);
      db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(table,sequence);
    }
    for (const index of indexes) db.exec(index.sql);
  }
  for (const item of views) if (item.name !== 'relocation_sources') db.exec(item.sql);
  for (const item of triggers) db.exec(item.sql);
  db.exec(`CREATE VIEW relocation_sources AS
    SELECT id AS allocation_document_id, NULL AS inquiry_id, 'allocation' AS source_kind,
      document_no, model, batch_key, plan, ship_date, version, fnsku,
      quantity - COALESCE((SELECT SUM(on_hand_delta) FROM inventory_ledger WHERE document_id=allocation_documents.id AND entry_type='return_receipt'),0) AS quantity,
      department, store_name, operator_name, asin, status, confirmed_at, NULL AS fba_shipped_at, NULL AS fba_archive_id
    FROM allocation_documents
    UNION ALL SELECT NULL,id,'inquiry',document_no,model,NULL,plan,ship_date,version,fnsku,supplier_quantity,
      department,store_name,operator_name,asin,status,archived_at,fba_shipped_at,NULL FROM inquiry_documents
    UNION ALL SELECT NULL,NULL,'fba','FBA-' || printf('%08d',id),model,NULL,plan,ship_date,version,fnsku,quantity,
      team,NULL,NULL,NULL,'archived',archived_at,ship_date,id FROM fba_archives;
    CREATE UNIQUE INDEX uq_upgrade_relocation_fba ON upgrade_jobs(fba_archive_id) WHERE kind='relocation';
    CREATE UNIQUE INDEX uq_upgrade_work_fba_active ON upgrade_relocation_work_items(fba_archive_id)
      WHERE status IN ('awaiting_procurement','awaiting_operation','awaiting_shipping');
    DROP INDEX idx_transit_identity_active;
    CREATE UNIQUE INDEX idx_transit_identity_active ON transit_batches(model,plan,ship_date,version,fnsku,shipping_method)
      WHERE status='in_transit' AND is_legacy_placeholder=0 AND remaining_quantity>0 AND voided_at IS NULL;
    UPDATE stock_batches SET warehouse=(SELECT MIN(t.shipping_method) FROM stock_receipts r JOIN transit_batches t ON t.id=r.transit_id WHERE r.batch_key=stock_batches.batch_key)
      WHERE base_quantity=0
      AND NOT EXISTS(SELECT 1 FROM upgrade_inventory_ledger l WHERE l.batch_key=stock_batches.batch_key AND l.on_hand_delta>0)
      AND (SELECT COUNT(DISTINCT t.shipping_method) FROM stock_receipts r JOIN transit_batches t ON t.id=r.transit_id WHERE r.batch_key=stock_batches.batch_key)=1
      AND NOT EXISTS(SELECT 1 FROM stock_receipts r JOIN transit_batches t ON t.id=r.transit_id WHERE r.batch_key=stock_batches.batch_key AND t.shipping_method IN ('','直发FBA'));`);
  db.prepare('INSERT INTO schema_migrations(version,applied_at,description) VALUES(25,?,?)').run(at,'按海外仓区分库存批次，直发FBA独立归档及移仓升级来源');
}
const EXPECTED_PRIVATE_INBOUND_SOURCE_ROWS = 47;

function loadVerifiedPackImports() {
  const defaultPath = path.join(import.meta.dirname, ".local-private", "legacy-inbound-sources.local.json");
  const sourcePath = path.resolve(process.env.ASTER_PRIVATE_INBOUND_SOURCES || defaultPath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`历史迁移需要 ${EXPECTED_PRIVATE_INBOUND_SOURCE_ROWS} 条私有在途来源数据。请将本地文件放到 ${defaultPath}，或设置 ASTER_PRIVATE_INBOUND_SOURCES 指向该 JSON 文件。`);
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取历史迁移所需的私有在途来源文件 ${sourcePath}: ${error.message}`);
  }
  const imports = document?.schemaVersion === 1 && Array.isArray(document.imports) ? document.imports : null;
  if (!imports?.length) throw new Error(`私有在途来源文件格式无效：${sourcePath}`);
  let rowCount = 0;
  for (const source of imports) {
    if (!/^[a-f0-9]{64}$/i.test(String(source?.fileSha256 ?? "")) || !Array.isArray(source.rows)) {
      throw new Error(`私有在途来源文件包含无效的导入项：${sourcePath}`);
    }
    rowCount += source.rows.length;
    for (const row of source.rows) {
      if (!Number.isInteger(Number(row.sourceRow)) || Number(row.sourceRow) < 1
        || !Number.isInteger(Number(row.quantity)) || Number(row.quantity) < 1
        || [row.model, row.fnsku, row.shippingMethod, row.plan, row.date, row.team, row.version, row.packPerBox]
          .some(value => String(value ?? "").trim() === "")) {
        throw new Error(`私有在途来源文件包含无效的来源行：${sourcePath}`);
      }
    }
  }
  if (rowCount !== EXPECTED_PRIVATE_INBOUND_SOURCE_ROWS) {
    throw new Error(`私有在途来源文件应包含 ${EXPECTED_PRIVATE_INBOUND_SOURCE_ROWS} 行，实际为 ${rowCount} 行：${sourcePath}`);
  }
  return imports;
}


function sameTransitSource(payload, transit, sourceRow) {
  return Number(payload.sourceRow) === Number(sourceRow)
    && String(payload.model ?? "").trim() === transit.model
    && Number(payload.quantity) === Number(transit.quantity)
    && String(payload.fnsku ?? "").trim() === transit.fnsku
    && String(payload.shippingMethod ?? "").trim() === transit.shipping_method
    && String(payload.plan ?? "").trim() === transit.plan
    && String(payload.date ?? "").trim() === transit.ship_date
    && String(payload.team ?? "").trim() === transit.team
    && String(payload.version ?? "").trim() === transit.version;
}

function verifiedTransitPackBackfill(db, { correctExisting = false, imports }) {
  const changes = [], verified = new Map();
  let matched = 0, unmatched = 0;
  let expectedRows = 0;
  for (const source of imports) {
    const batches = db.prepare("SELECT * FROM import_batches WHERE UPPER(file_sha256) = ? AND import_kind = 'transit' AND inventory_applied = 1").all(source.fileSha256);
    if (!batches.length) throw new Error("历史迁移找不到私有来源文件对应的在途导入批次；未执行 schema 更新");
    for (const batch of batches) {
      expectedRows += source.rows.length;
      const rows = db.prepare("SELECT source_row, current_transit_id, payload_json FROM import_rows WHERE import_batch_id = ? ORDER BY source_row").all(batch.id);
      if (Number(batch.row_count) !== source.rows.length || rows.length !== source.rows.length) throw new Error("套/箱凭证行数与已核实原表不一致：" + batch.id);
      for (const expected of source.rows) {
        const row = rows.find(item => Number(item.source_row) === expected.sourceRow);
        const payload = row && JSON.parse(row.payload_json);
        const transitId = Number(row?.current_transit_id ?? payload?.transitId ?? payload?.mergedIntoTransitId ?? 0);
        const transit = db.prepare("SELECT * FROM transit_batches WHERE id = ?").get(transitId);
        if (!transit || Number(transit.import_batch_id) !== Number(batch.id) || Number(transit.source_row) !== expected.sourceRow
          || !sameTransitSource(payload ?? {}, transit, expected.sourceRow) || !sameTransitSource(expected, transit, expected.sourceRow)) {
          throw new Error("套/箱来源身份与已核实原表不一致：" + JSON.stringify({ importId: batch.id, sourceRow: expected.sourceRow, transitId }));
        }
        const pack = expected.packPerBox;
        verified.set(transitId, pack);
        if (transit.pack_per_box != null && transit.pack_per_box !== pack && !correctExisting) { unmatched += 1; continue; }
        if (transit.pack_per_box !== pack) {
          db.prepare("UPDATE transit_batches SET pack_per_box = ? WHERE id = ?").run(pack, transitId);
          changes.push({ table: "transit_batches", id: transitId, importId: batch.id, sourceRow: expected.sourceRow, model: transit.model, before: transit.pack_per_box, after: pack });
        }
        matched += 1;
      }
    }
  }
  if (matched + unmatched !== expectedRows) throw new Error("历史迁移未能核验私有在途来源中的全部行");
  return { matched, unmatched, changes, verified };
}

function stockPackSources(db) {
  const batches = db.prepare("SELECT * FROM stock_batches ORDER BY batch_key").all();
  const byKey = new Map(batches.map(row => [row.batch_key, row]));
  const sources = new Map();
  const add = (targetKey, source) => {
    if (!byKey.has(targetKey)) return;
    const list = sources.get(targetKey) ?? new Map();
    list.set(`${source.kind}:${source.key}`, source);
    sources.set(targetKey, list);
  };
  const sameBatchIdentity = (stock, transit) => stock.model === transit.model && stock.plan === transit.plan
    && stock.ship_date === transit.ship_date && stock.version === transit.version && stock.fnsku === transit.fnsku;

  for (const row of db.prepare("SELECT batch_key, transit_id FROM stock_receipts").all()) add(row.batch_key, { kind: "transit", key: Number(row.transit_id) });
  for (const stock of batches) {
    if (stock.created_by_transit_id != null) add(stock.batch_key, { kind: "transit", key: Number(stock.created_by_transit_id) });
    if (stock.created_by_import_id != null) {
      const rows = db.prepare("SELECT current_transit_id, payload_json FROM import_rows WHERE import_batch_id = ?").all(Number(stock.created_by_import_id));
      let found = false;
      for (const row of rows) {
        let payload = null;
        try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
        const transitId = Number(row.current_transit_id ?? payload?.transitId ?? payload?.mergedIntoTransitId ?? 0);
        const transit = transitId > 0 ? db.prepare("SELECT * FROM transit_batches WHERE id = ?").get(transitId) : null;
        if (transit && sameBatchIdentity(stock, transit)) {
          add(stock.batch_key, { kind: "transit", key: transitId });
          found = true;
        }
      }
      if (!found) add(stock.batch_key, { kind: "unknown", key: `import:${stock.created_by_import_id}` });
    }
    if (Number(stock.base_quantity) > 0) add(stock.batch_key, { kind: "unknown", key: "base-quantity" });
  }

  for (const row of db.prepare(`SELECT target.batch_key AS target_key, source.source_batch_key AS source_key
    FROM upgrade_inventory_ledger target
    JOIN upgrade_stock_lines source ON source.id = target.source_id
    WHERE target.source_type = 'direct_line' AND target.entry_type = 'direct_transfer_in' AND target.on_hand_delta > 0`).all()) {
    add(row.target_key, byKey.has(row.source_key) ? { kind: "stock", key: row.source_key } : { kind: "unknown", key: `direct:${row.source_key}` });
  }

  const relocationRows = db.prepare(`SELECT target.batch_key AS target_key, j.model AS job_model, j.source_version AS job_source_version,
      d.batch_key AS source_batch_key, d.model AS source_model, d.plan AS source_plan, d.ship_date AS source_ship_date, d.version AS source_version, d.fnsku AS source_fnsku,
      f.transit_id AS source_transit_id, f.model AS fba_model, f.plan AS fba_plan, f.version AS fba_version, f.fnsku AS fba_fnsku
    FROM upgrade_inventory_ledger target
    JOIN upgrade_relocations r ON r.id = target.source_id
    JOIN upgrade_jobs j ON j.id = target.upgrade_id
    LEFT JOIN allocation_documents d ON d.id = r.allocation_document_id
    LEFT JOIN fba_archives f ON f.id = r.fba_archive_id
    WHERE target.source_type = 'relocation' AND target.entry_type = 'relocation_receipt' AND target.on_hand_delta > 0`).all();
  for (const row of relocationRows) {
    const target = byKey.get(row.target_key);
    if (!target || target.model !== row.job_model) { add(row.target_key, { kind: "unknown", key: "relocation-identity" }); continue; }
    if (row.source_batch_key) {
      const source = byKey.get(row.source_batch_key);
      const matches = source && source.model === row.source_model && source.plan === row.source_plan
        && source.version === row.source_version && source.version === row.job_source_version
        && target.plan === row.source_plan
        && target.ship_date === row.source_ship_date && target.fnsku === row.source_fnsku;
      add(row.target_key, matches ? { kind: "stock", key: row.source_batch_key } : { kind: "unknown", key: `allocation:${row.source_batch_key}` });
    } else if (row.source_transit_id != null) {
      const transit = db.prepare("SELECT * FROM transit_batches WHERE id = ?").get(Number(row.source_transit_id));
      const matches = transit && transit.model === row.fba_model && transit.model === row.job_model
        && transit.plan === row.fba_plan && transit.version === row.fba_version && transit.version === row.job_source_version && transit.fnsku === row.fba_fnsku
        && target.plan === row.fba_plan && target.fnsku === row.fba_fnsku;
      add(row.target_key, matches ? { kind: "transit", key: Number(row.source_transit_id) } : { kind: "unknown", key: `fba:${row.source_transit_id}` });
    } else {
      add(row.target_key, { kind: "unknown", key: "inquiry-source" });
    }
  }

  return { batches, byKey, sources };
}

function stockPackBackfill(db) {
  const { batches, byKey, sources } = stockPackSources(db);
  const update = db.prepare("UPDATE stock_batches SET pack_per_box = ? WHERE batch_key = ? AND pack_per_box IS NULL");
  let changed = true;
  let matched = 0;
  while (changed) {
    changed = false;
    for (const batch of batches) {
      if (batch.pack_per_box != null) continue;
      const refs = [...(sources.get(batch.batch_key)?.values() ?? [])];
      if (!refs.length) continue;
      const values = refs.map(source => {
        if (source.kind === "unknown") return null;
        if (source.kind === "transit") return db.prepare("SELECT pack_per_box FROM transit_batches WHERE id = ?").get(source.key)?.pack_per_box ?? null;
        return byKey.get(source.key)?.pack_per_box ?? null;
      }).map(value => value == null ? "" : String(value).trim());
      if (values.some(value => !value) || new Set(values).size !== 1) continue;
      const pack = values[0];
      update.run(pack, batch.batch_key);
      batch.pack_per_box = pack;
      changed = true;
      matched += 1;
    }
  }
  return { matched, unmatched: batches.length - matched };
}

function migratePackPerBoxV26(db, at, imports) {
  const view = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='stock_balances'").get()?.sql;
  if (!view) throw new Error("迁移 v26 找不到库存余额视图 stock_balances");
  db.exec("DROP VIEW stock_balances; ALTER TABLE stock_batches ADD COLUMN pack_per_box TEXT; ALTER TABLE transit_batches ADD COLUMN pack_per_box TEXT");
  db.exec(view);
  const transit = verifiedTransitPackBackfill(db, { imports });
  const stock = stockPackBackfill(db);
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (26, ?, ?)")
    .run(at, "导入在途套/箱并沿可核实来源回填在库批次");
  return { packPerBoxBackfill: { transitMatched: transit.matched, transitUnmatched: transit.unmatched, stockBatchesMatched: stock.matched, stockBatchesUnmatched: stock.unmatched } };
}

function stockBatchSourceTeams(db) {
    const teamsByBatch = new Map();
    const addTeam = (batchKey, team) => {
      const normalized = String(team ?? "").trim();
      if (!batchKey || !normalized) return false;
      const teams = teamsByBatch.get(batchKey) ?? new Set();
      const changed = !teams.has(normalized);
      teams.add(normalized);
      teamsByBatch.set(batchKey, teams);
      return changed;
    };

    for (const row of db.prepare(`
      SELECT r.batch_key, t.team
      FROM stock_receipts r
      JOIN transit_batches t ON t.id = r.transit_id
    `).all()) addTeam(row.batch_key, row.team);
    for (const row of db.prepare(`
      SELECT b.batch_key, t.team
      FROM stock_batches b
      JOIN transit_batches t ON t.id = b.created_by_transit_id
    `).all()) addTeam(row.batch_key, row.team);

    /* 兼容仍保留导入来源编号的历史在库批次；团队若存在于原始导入凭证，也属于来源关系。 */
    for (const row of db.prepare(`
      SELECT b.*, r.payload_json
      FROM stock_batches b
      JOIN import_rows r ON r.import_batch_id = b.created_by_import_id
      WHERE b.created_by_import_id IS NOT NULL
    `).all()) {
      try {
        const payload = JSON.parse(row.payload_json);
        if (payload.model === row.model && payload.plan === row.plan && payload.date === row.ship_date
          && payload.version === row.version && payload.fnsku === row.fnsku) addTeam(row.batch_key, payload.team ?? payload.团队);
      } catch {
        /* 导入原文不影响其他来源关系的读取。 */
      }
    }

    if (tableColumns(db, "stock_batches").has("source_team")) {
      for (const row of db.prepare("SELECT batch_key, source_team FROM stock_batches WHERE source_team <> ''").all()) addTeam(row.batch_key, row.source_team);
    }

    /* 在库升级的正向转入沿来源批次传递团队；允许多级升级，但不按当前库存数量推断来源。 */
    const directEdges = db.prepare(`
      SELECT target.batch_key AS target_batch_key, line.source_batch_key
      FROM upgrade_inventory_ledger target
      JOIN upgrade_stock_lines line ON line.id = target.source_id
      WHERE target.source_type = 'direct_line'
        AND target.entry_type = 'direct_transfer_in'
        AND target.on_hand_delta > 0
    `).all();

    /* 移仓升级的目标批次沿现有调拨/询库/FBA来源取得部门团队。 */
    for (const row of db.prepare(`
      SELECT l.batch_key, d.batch_key AS allocation_source_key,
             COALESCE(i.department, f.team) AS team
      FROM upgrade_inventory_ledger l
      JOIN upgrade_jobs j ON j.id = l.upgrade_id
      LEFT JOIN allocation_documents d ON d.id = j.allocation_document_id
      LEFT JOIN inquiry_documents i ON i.id = j.inquiry_id
      LEFT JOIN fba_archives f ON f.id = j.fba_archive_id
      WHERE l.source_type = 'relocation'
        AND l.entry_type = 'relocation_receipt'
        AND l.on_hand_delta > 0
    `).all()) {
      if (row.allocation_source_key) directEdges.push({target_batch_key: row.batch_key, source_batch_key: row.allocation_source_key});
      else addTeam(row.batch_key, row.team);
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of directEdges) {
        for (const team of teamsByBatch.get(edge.source_batch_key) ?? []) {
          if (addTeam(edge.target_batch_key, team)) changed = true;
        }
      }
    }
    return teamsByBatch;
  }

function migrateInquiryFinalQuantityV27(db, at) {
  const view = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='relocation_sources'").get()?.sql;
  if (!view) throw new Error("迁移 v27 找不到移仓来源视图 relocation_sources");
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='inquiry_documents'").get()?.sql;
  if (!schema) throw new Error("迁移 v27 找不到询库单表 inquiry_documents");
  const related = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('index','trigger') AND (tbl_name='inquiry_documents' OR sql LIKE '%inquiry_documents%')").all();
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='inquiry_documents'").get()?.seq;
  db.exec("DROP VIEW relocation_sources");
  for (const item of related) db.exec(`DROP ${item.type} "${item.name}"`);
  const rebuiltSchema = schema
    .replace('inquiry_documents', 'inquiry_documents_v27')
    .replace('requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0)', 'requested_quantity INTEGER NOT NULL CHECK (requested_quantity >= 0)')
    .replace('supplier_quantity INTEGER CHECK (supplier_quantity >= 0 AND supplier_quantity <= approved_quantity)', 'supplier_quantity INTEGER CHECK (supplier_quantity >= 0)');
  db.exec(rebuiltSchema);
  db.exec(`INSERT INTO inquiry_documents_v27 SELECT * FROM inquiry_documents;
    DROP TABLE inquiry_documents;
    ALTER TABLE inquiry_documents_v27 RENAME TO inquiry_documents;`);
  if (sequence != null) db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='inquiry_documents'").run(sequence);
  db.prepare("UPDATE inquiry_documents SET requested_quantity=supplier_quantity WHERE supplier_quantity IS NOT NULL AND requested_quantity<>supplier_quantity").run();
  for (const item of related) db.exec(item.sql);
  db.exec(view);
  db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (27, ?, ?)")
    .run(at, "采购回复量同步为询库最终申请量；无货回复允许申请量为零；保留历史与归档资料");
}


function migrateSourceInventoryV28(db, at, imports) {
  const transit = verifiedTransitPackBackfill(db, { correctExisting: true, imports });
  if (imports.length && (transit.unmatched !== 0 || transit.matched < EXPECTED_PRIVATE_INBOUND_SOURCE_ROWS)) {
    throw new Error("schema28 未能修正全部私有在途来源记录；迁移已中止");
  }
  const { batches, sources } = stockPackSources(db);
  const expectedStock = new Map(), stockChanges = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const batch of batches) {
      if (expectedStock.has(batch.batch_key)) continue;
      const refs = [...(sources.get(batch.batch_key)?.values() ?? [])];
      const values = refs.map(ref => ref.kind === "transit" ? transit.verified.get(ref.key) : ref.kind === "stock" ? expectedStock.get(ref.key) : undefined);
      if (!values.length || values.some(value => value == null) || new Set(values).size !== 1) continue;
      expectedStock.set(batch.batch_key, values[0]); progressed = true;
      if (batch.pack_per_box !== values[0]) {
        db.prepare("UPDATE stock_batches SET pack_per_box=? WHERE batch_key=?").run(values[0], batch.batch_key);
        stockChanges.push({ table: "stock_batches", batchKey: batch.batch_key, before: batch.pack_per_box, after: values[0], sources: refs });
      }
    }
  }
  const teams = stockBatchSourceTeams(db);
  const mixed = [...teams].filter(([, values]) => values.size > 1).map(([batchKey, values]) => ({batchKey, teams: [...values]}));
  if (mixed.length) throw new Error("来源团队混合，须先逐批核对凭证：" + JSON.stringify(mixed));
  const views = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='view'").all();
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  for (const item of views) db.exec(`DROP VIEW "${item.name}"`);
  for (const item of triggers) db.exec(`DROP TRIGGER "${item.name}"`);
  db.exec("ALTER TABLE stock_batches ADD COLUMN source_team TEXT NOT NULL DEFAULT '' CHECK(source_team IN ('','一团','二团'))");
  const teamChanges = [];
  for (const batch of batches) {
    const team = [...(teams.get(batch.batch_key) ?? [])][0] ?? "";
    db.prepare("UPDATE stock_batches SET source_team=? WHERE batch_key=?").run(team,batch.batch_key);
    teamChanges.push({batchKey: batch.batch_key, sourceTeam: team});
  }
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='stock_batches'").get().sql;
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='stock_batches' AND sql IS NOT NULL").all();
  db.exec(schema.replace(/CREATE TABLE (?:IF NOT EXISTS )?"?stock_batches"?/, 'CREATE TABLE stock_batches_v28')
    .replace('UNIQUE (model, plan, ship_date, version, fnsku, warehouse)', 'UNIQUE (model, plan, ship_date, version, fnsku, warehouse, source_team)'));
  db.exec('INSERT INTO stock_batches_v28 SELECT * FROM stock_batches; DROP TABLE stock_batches; ALTER TABLE stock_batches_v28 RENAME TO stock_batches');
  for (const index of indexes) db.exec(index.sql);
  for (const item of views) db.exec(item.sql);
  for (const item of triggers) db.exec(item.sql);
  // Source reservation state is maintained by SQLite, including historical cancelled jobs.
  db.exec(`DROP INDEX uq_upgrade_direct_active;
    ALTER TABLE upgrade_stock_lines ADD COLUMN reservation_active INTEGER NOT NULL DEFAULT 0 CHECK(reservation_active IN (0,1));
    UPDATE upgrade_stock_lines SET reservation_active = CASE WHEN remaining_quantity > 0 AND EXISTS(
      SELECT 1 FROM upgrade_jobs j WHERE j.id=upgrade_id AND j.kind='direct' AND j.status='active' AND j.cancelled_at IS NULL) THEN 1 ELSE 0 END;
    CREATE UNIQUE INDEX uq_upgrade_direct_source_active ON upgrade_stock_lines(source_batch_key) WHERE reservation_active=1;
    CREATE TRIGGER upgrade_source_reservation_guard BEFORE UPDATE OF reservation_active ON upgrade_stock_lines
      WHEN NEW.reservation_active <> CASE WHEN NEW.remaining_quantity>0 AND EXISTS(
        SELECT 1 FROM upgrade_jobs j WHERE j.id=NEW.upgrade_id AND j.kind='direct' AND j.status='active' AND j.cancelled_at IS NULL) THEN 1 ELSE 0 END
      BEGIN SELECT RAISE(ABORT,'升级来源占用状态必须与活动单及剩余数量一致'); END;
    CREATE TRIGGER upgrade_source_reservation_insert AFTER INSERT ON upgrade_stock_lines BEGIN
      UPDATE upgrade_stock_lines SET reservation_active=CASE WHEN remaining_quantity>0 AND EXISTS(
        SELECT 1 FROM upgrade_jobs j WHERE j.id=upgrade_id AND j.kind='direct' AND j.status='active' AND j.cancelled_at IS NULL) THEN 1 ELSE 0 END WHERE id=NEW.id;
    END;
    CREATE TRIGGER upgrade_source_reservation_update AFTER UPDATE OF remaining_quantity,upgrade_id,source_batch_key ON upgrade_stock_lines BEGIN
      UPDATE upgrade_stock_lines SET reservation_active=CASE WHEN remaining_quantity>0 AND EXISTS(
        SELECT 1 FROM upgrade_jobs j WHERE j.id=upgrade_id AND j.kind='direct' AND j.status='active' AND j.cancelled_at IS NULL) THEN 1 ELSE 0 END WHERE id=NEW.id;
    END;
    CREATE TRIGGER upgrade_source_reservation_job AFTER UPDATE OF status,cancelled_at ON upgrade_jobs BEGIN
      UPDATE upgrade_stock_lines SET reservation_active=CASE WHEN remaining_quantity>0 AND NEW.kind='direct' AND NEW.status='active' AND NEW.cancelled_at IS NULL THEN 1 ELSE 0 END WHERE upgrade_id=NEW.id;
    END;`);
  db.prepare("INSERT INTO schema_migrations(version,applied_at,description) VALUES(28,?,?)").run(at,"原表47行套/箱前向修正，来源团队批次身份及按实际来源升级互斥");
  return { sourceInventory: { verifiedTransitRows: transit.matched, transitChanges: transit.changes, stockChanges,
    verifiedDerivedBatches: [...expectedStock].map(([batchKey,packPerBox])=>({batchKey,packPerBox,sources:[...(sources.get(batchKey)?.values()??[])]})), teamChanges } };
}

function migrateInquiryProcurementSchemaV29(db, at) {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='inquiry_documents'").get()?.sql;
  if (!schema) throw new Error("迁移 v29 找不到询库单表 inquiry_documents");
  const tableName = /CREATE TABLE (?:IF NOT EXISTS )?(?:"inquiry_documents"|inquiry_documents)\s*\(/;
  if (!tableName.test(schema) || !schema.includes("approved_quantity INTEGER CHECK (approved_quantity > 0)")
    || !schema.includes("business_note TEXT NOT NULL DEFAULT '',")) {
    throw new Error("迁移 v29 遇到非预期的询库表结构，迁移已中止");
  }
  const related = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('index','trigger') AND (tbl_name='inquiry_documents' OR sql LIKE '%inquiry_documents%')").all();
  const views = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='view' AND sql LIKE '%inquiry_documents%'").all();
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='inquiry_documents'").get()?.seq;
  for (const view of views) db.exec(`DROP VIEW "${view.name}"`);
  for (const item of related) db.exec(`DROP ${item.type} "${item.name}"`);

  const rebuiltSchema = schema
    .replace(tableName, "CREATE TABLE inquiry_documents_v29 (")
    .replace("approved_quantity INTEGER CHECK (approved_quantity > 0)", "approved_quantity INTEGER CHECK (approved_quantity >= 0)")
    .replace("business_note TEXT NOT NULL DEFAULT '',", "business_note TEXT NOT NULL DEFAULT '',\n      purchase_note TEXT NOT NULL DEFAULT '',");
  if (rebuiltSchema === schema) throw new Error("迁移 v29 未能生成询库表结构，迁移已中止");
  const columns = db.prepare("PRAGMA table_info(inquiry_documents)").all().map(column => `"${column.name}"`).join(",");
  db.exec(rebuiltSchema);
  db.exec(`INSERT INTO inquiry_documents_v29(${columns}) SELECT ${columns} FROM inquiry_documents;
    DROP TABLE inquiry_documents;
    ALTER TABLE inquiry_documents_v29 RENAME TO inquiry_documents;`);
  if (sequence != null) db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='inquiry_documents'").run(sequence);
  for (const item of related) db.exec(item.sql);
  for (const view of views) db.exec(view.sql);
  db.prepare("INSERT INTO schema_migrations(version,applied_at,description) VALUES(29,?,?)")
    .run(at, "询库采购回复限定仓库并将采购回复量作为最终量；新增采购备注");
}

export function migrateInventoryDatabaseToCurrent({ databasePath, appliedAt = new Date().toISOString(), bumpDataVersion = true }) {
  if (!fs.existsSync(databasePath)) throw new Error(`找不到待迁移数据库：${databasePath}`);
  const db = new DatabaseSync(databasePath);
  configureDatabase(db);
  const fromVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
  if (fromVersion === INVENTORY_SCHEMA_VERSION) {
    db.close();
    return { changed: false, fromVersion, toVersion: INVENTORY_SCHEMA_VERSION, migratedCorrections: 0 };
  }
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29].includes(fromVersion)) {
    db.close();
    throw new Error(`只支持从数据库 v1 至 v29 迁移到 v${INVENTORY_SCHEMA_VERSION}，实际版本为 v${fromVersion}`);
  }
  let verifiedPackImports = [];
  if (fromVersion < 28) {
    try {
      verifiedPackImports = loadVerifiedPackImports();
    } catch (error) {
      db.close();
      throw error;
    }
  }
  try {
    /* v5 需要重建 import_batches 以把文件唯一约束收窄为“未撤销批次”。
       SQLite 只能在事务外切换 foreign_keys；迁移末尾统一 foreign_key_check。 */
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    let migrated = { migratedCorrections: 0, migratedLegacyChildren: 0, migratedOrphanWithdrawals: 0 };
    let version = fromVersion;
    if (version === 1) {
      createCorrectionSchema(db);
      migrated = migrateLegacyCorrectionsV2(db, appliedAt);
      const duplicates = db.prepare(`
        SELECT root_document_id, COUNT(*) AS count
        FROM correction_requests
        WHERE status IN ('pending', 'processing', 'execution_failed')
        GROUP BY root_document_id HAVING COUNT(*) > 1
      `).all();
      if (duplicates.length > 0) throw new Error(`迁移发现同一根业务单存在多个进行中纠错：${JSON.stringify(duplicates)}`);
      createActiveCorrectionConstraint(db);
      db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (2, ?, ?)")
        .run(appliedAt, "独立多纠错单、审核状态、并发约束与可追溯执行");
      version = 2;
    }
    if (version === 2) {
      migrateTransitSchemaV3(db, appliedAt);
      db.prepare("INSERT INTO schema_migrations(version, applied_at, description) VALUES (3, ?, ?)")
        .run(appliedAt, "在途库存导入、状态更新、上架转换与可追溯事件");
      version = 3;
    }
    if (version === 3) {
      migrateTransitSchemaV4(db, appliedAt);
      version = 4;
    }
    if (version === 4) {
      migrateTransitSchemaV5(db, appliedAt);
      version = 5;
    }
    if (version === 5) {
      migrateTransitSchemaV6(db, appliedAt);
      version = 6;
    }
    if (version === 6) {
      migrateTransitSchemaV7(db, appliedAt);
      version = 7;
    }
    if (version === 7) {
      migrateTransitSchemaV8(db, appliedAt);
      version = 8;
    }
    if (version === 8) {
      migrateCatalogModelDeleteSchemaV9(db, appliedAt);
      version = 9;
    }
    if (version === 9) {
      migrateTransitReplacementSchemaV10(db, appliedAt);
      version = 10;
    }
    if (version === 10) {
      migrateTransitClientSessionSchemaV11(db, appliedAt);
      version = 11;
    }
    if (version === 11) {
      migrateTransitImportDuplicatePolicySchemaV12(db, appliedAt);
      version = 12;
    }
    if (version === 12) {
      migrateLegacyPlaceholderPolicySchemaV13(db, appliedAt);
      version = 13;
    }
    if (version === 13) {
      migrateUpgradeSchemaV14(db, appliedAt);
      version = 14;
    }
    if (version === 14) {
      migrateUpgradeWithdrawalSchemaV15(db, appliedAt);
      version = 15;
    }
    if (version === 15) {
      migrateCatalogModelUpgradeDeleteSchemaV16(db, appliedAt);
      version = 16;
    }
    if (version === 16) {
      migrateApprovalSchemaV17(db, appliedAt);
      version = 17;
    }
    if (version === 17) {
      migrateInquiryShipmentSchemaV18(db, appliedAt);
      version = 18;
    }
    if (version === 18) {
      migrateRelocationLogisticsSchemaV19(db, appliedAt);
      version = 19;
    }
    if (version === 19) {
      migrateStockFnskuSchemaV20(db, appliedAt);
      version = 20;
    }
    if (version === 20) { migrateSimplificationV21(db, appliedAt); version = 21; }
    if (version === 21) { migrateLingxingHostV22(db, appliedAt); version = 22; }
    if (version === 22) { migrateBusinessCorrectionsV23(db, appliedAt); version = 23; }
    if (version === 23) { migrateSourceAttributionV24(db, appliedAt); version = 24; }
    if (version === 24) { migrateWarehouseFbaV25(db, appliedAt); version = 25; }
    if (version === 25) { Object.assign(migrated, migratePackPerBoxV26(db, appliedAt, verifiedPackImports)); version = 26; }
    if (version === 26) { migrateInquiryFinalQuantityV27(db, appliedAt); version = 27; }
    if (version === 27) { Object.assign(migrated, migrateSourceInventoryV28(db, appliedAt, verifiedPackImports)); version = 28; }
    if (version === 28) { migrateInquiryProcurementSchemaV29(db, appliedAt); version = 29; }
    if (version === 29) { migrateRequirementsV30(db, appliedAt); version = 30; }
    db.exec(`PRAGMA user_version = ${version}`);
    if (bumpDataVersion) {
      db.prepare("UPDATE system_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version'").run();
      db.prepare("UPDATE system_meta SET value = ? WHERE key = 'updated_at'").run(appliedAt);
    }
    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    if (integrity !== "ok") throw new Error(`迁移后 SQLite 完整性检查失败：${integrity}`);
    const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyErrors.length > 0) throw new Error(`迁移后 SQLite 外键检查失败：${JSON.stringify(foreignKeyErrors)}`);
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
    return { changed: true, fromVersion, toVersion: INVENTORY_SCHEMA_VERSION, integrity, ...migrated };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
    try { db.exec("PRAGMA foreign_keys = ON"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    db.close();
  }
}

export function createInventoryDatabase({ databasePath, legacyStore = null, legacyAudit = [], createdAt = new Date().toISOString(), seedCatalogData = true }) {
  if (fs.existsSync(databasePath)) throw new Error(`目标数据库已存在，拒绝覆盖：${databasePath}`);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  configureDatabase(db);
  const databaseId = crypto.randomUUID();
  const importedIds = new Set();
  const auditIds = new Set();
  let orphanAuditEvents = 0;
  let migratedDocuments = 0;

  try {
    db.exec("BEGIN IMMEDIATE");
    createSchema(db, databaseId, createdAt);
    if (seedCatalogData) seedCatalog(db, createdAt);

    const insertDoc = db.prepare(`
      INSERT INTO allocation_documents(
        id, document_no, model, batch_key, plan, ship_date, version, fnsku, quantity, department,
        store_name, operator_name, legacy_time_label, status, revision, created_by_role, created_at,
        submitted_by_role, submitted_at, confirmed_by_role, confirmed_at, source_document,
        cancelled_by_role, cancelled_at, cancel_reason, withdrawn_by_role, withdrawn_at, withdraw_reason,
        external_sync_status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_synced', ?)
    `);
    const ledgerStmt = db.prepare(`
      INSERT INTO inventory_ledger(document_id, batch_key, entry_type, on_hand_delta, locked_delta, related_ledger_id, reversal_group, created_by_role, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [key, rows] of Object.entries(legacyStore?.batches ?? {})) {
      const [model, plan, date, version] = key.split("#");
      const knownBatch = db.prepare("SELECT fnsku FROM stock_batches WHERE batch_key = ?").get(key);
      if (!knownBatch) continue;
      for (const row of rows) {
        const id = Number(row.id);
        if (!Number.isInteger(id) || importedIds.has(id)) continue;
        const status = legacyStatus(row.status);
        const created = typeof row.createdAt === "string" ? row.createdAt : createdAt;
        const confirmed = typeof row.confirmedAt === "string" ? row.confirmedAt : null;
        const cancelled = typeof row.cancelledAt === "string" ? row.cancelledAt : null;
        const withdrawn = typeof row.withdrawnAt === "string" ? row.withdrawnAt : null;
        const updated = withdrawn ?? cancelled ?? confirmed ?? created;
        insertDoc.run(
          id, documentNumber(id, true), model, key, plan, date, version, String(row.fnsku || knownBatch.fnsku), Number(row.quantity),
          normalizeLegacyDepartment(row.department), String(row.store || "未填写"), String(row.operator || "未填写"), String(row.time || ""),
          status, Number.isInteger(row.revision) ? row.revision : 1, String(row.createdByRole || "legacy"), created,
          String(row.createdByRole || "legacy"), created, row.confirmedByRole ?? null, confirmed, row.sourceDocument ?? null,
          row.cancelledByRole ?? null, cancelled, row.cancelReason ?? null, row.withdrawnByRole ?? null, withdrawn, row.withdrawReason ?? null,
          updated,
        );
        importedIds.add(id);
        migratedDocuments += 1;
        const metadata = JSON.stringify({ migratedFrom: "allocation-records.json", legacyStatus: row.status });
        const reserve = ledgerStmt.run(id, key, "reserve", 0, Number(row.quantity), null, null, String(row.createdByRole || "legacy"), created, metadata);
        if (status === "confirmed") {
          ledgerStmt.run(id, key, "release_reservation", 0, -Number(row.quantity), Number(reserve.lastInsertRowid), null, String(row.confirmedByRole || "legacy"), confirmed ?? updated, metadata);
          ledgerStmt.run(id, key, "issue", -Number(row.quantity), 0, null, null, String(row.confirmedByRole || "legacy"), confirmed ?? updated, metadata);
        } else if (status === "cancelled") {
          ledgerStmt.run(id, key, "release_reservation", 0, -Number(row.quantity), Number(reserve.lastInsertRowid), null, String(row.cancelledByRole || "legacy"), cancelled ?? updated, metadata);
        } else if (status === "withdrawn") {
          const release = ledgerStmt.run(id, key, "release_reservation", 0, -Number(row.quantity), Number(reserve.lastInsertRowid), null, String(row.confirmedByRole || "legacy"), confirmed ?? updated, metadata);
          const issue = ledgerStmt.run(id, key, "issue", -Number(row.quantity), 0, Number(release.lastInsertRowid), null, String(row.confirmedByRole || "legacy"), confirmed ?? updated, metadata);
          ledgerStmt.run(id, key, "reverse_issue", Number(row.quantity), 0, Number(issue.lastInsertRowid), `legacy-${id}`, String(row.withdrawnByRole || "legacy"), withdrawn ?? updated, metadata);
        }
      }
    }

    const eventStmt = db.prepare(`
      INSERT INTO document_events(document_id, legacy_record_id, event_type, role, occurred_at, reason, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of legacyAudit) {
      const legacyId = Number(entry?.recordId);
      const hasId = Number.isInteger(legacyId);
      if (hasId) auditIds.add(legacyId);
      const documentId = hasId && importedIds.has(legacyId) ? legacyId : null;
      if (hasId && documentId === null) orphanAuditEvents += 1;
      eventStmt.run(
        documentId,
        hasId ? legacyId : null,
        String(entry?.action || "legacy_event"),
        String(entry?.role || "legacy"),
        String(entry?.at || createdAt),
        entry?.reason == null ? null : String(entry.reason),
        JSON.stringify({ ...entry, migratedFrom: "allocation-audit.log", orphanedMainRecord: hasId && documentId === null }),
      );
    }
    for (const id of importedIds) {
      if (!auditIds.has(id)) {
        eventStmt.run(id, id, "legacy_import", "migration", createdAt, "主记录没有对应旧审计日志，迁移时保留并标记", JSON.stringify({ migratedFrom: "allocation-records.json" }));
      }
    }

    const maxLegacyId = Math.max(0, ...importedIds, ...auditIds);
    db.exec(`UPDATE allocation_documents SET requested_quantity = quantity,
      approved_quantity = CASE WHEN status IN ('confirmed', 'withdrawn') THEN quantity ELSE NULL END,
      approval_status = CASE WHEN status IN ('confirmed', 'withdrawn', 'cancelled') THEN 'legacy' ELSE 'pending' END`);
    setSequenceAtLeast(db, "allocation_documents", maxLegacyId);
    db.prepare("UPDATE system_meta SET value = '1' WHERE key = 'data_version'").run();
    db.prepare("UPDATE system_meta SET value = ? WHERE key = 'updated_at'").run(createdAt);
    db.exec("COMMIT");
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") throw new Error(`SQLite 完整性检查失败：${integrity.integrity_check}`);
    return {
      schemaVersion: INVENTORY_SCHEMA_VERSION,
      databaseId,
      databasePath,
      migratedDocuments,
      importedAuditEvents: legacyAudit.length,
      orphanAuditEvents,
      maxReservedDocumentId: maxLegacyId,
      integrity: integrity.integrity_check,
    };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
    throw error;
  } finally {
    db.close();
  }
}

function normalizeAsin(value) {
  const asin = String(value ?? "").trim().toUpperCase();
  if (!asin) throw new BusinessError(400, "missing_asin", "请填写 ASIN");
  return asin;
}

function inquiryShipDate(value) {
  const date = String(value ?? "").trim();
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const calendar = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!match || calendar.getUTCFullYear() !== Number(match[1]) || calendar.getUTCMonth() + 1 !== Number(match[2]) || calendar.getUTCDate() !== Number(match[3])) {
    throw new BusinessError(400, "invalid_ship_date", "发货日期必须是有效的年-月-日，例如 2026-09-08");
  }
  return date;
}

function lingxingCoverage(lingxing, quantity) {
  if (!lingxing || lingxing.sales30d === 0) return { coverageBefore: null, coverageAfter: null };
  const stock = lingxing.fbaAvailable + lingxing.fbaPendingTransfer + lingxing.fbaTransferring + lingxing.fbaInbound;
  return {
    coverageBefore: Number((stock / lingxing.sales30d).toFixed(1)),
    coverageAfter: Number(((stock + quantity) / lingxing.sales30d).toFixed(1)),
  };
}

function rowToDocument(row, lingxing = null) {
  if (!row) return null;
  return {
    id: Number(row.id),
    documentNo: row.document_no,
    correctionOfId: row.correction_of_id == null ? undefined : Number(row.correction_of_id),
    correctionDocumentId: row.correction_document_id == null ? undefined : Number(row.correction_document_id),
    model: row.model,
    batchKey: row.batch_key,
    quantity: Number(row.quantity),
    requestedQuantity: Number(row.requested_quantity),
    approvedQuantity: row.approved_quantity == null ? null : Number(row.approved_quantity),
    asin: row.asin,
    operatorNote: row.operator_note,
    businessNote: row.business_note,
    approvalStatus: row.approval_status,
    reviewedAt: row.reviewed_at,
    reviewedByRole: row.reviewed_by_role,
    plan: row.plan,
    date: row.ship_date,
    lingxing,
    ...lingxingCoverage(lingxing, Number(row.quantity)),
    version: row.version,
    fnsku: row.fnsku,
    department: row.department,
    store: row.store_name,
    operator: row.operator_name,
    time: row.legacy_time_label,
    status: STATUS_TEXT[row.status] ?? row.status,
    statusCode: row.status,
    revision: Number(row.revision),
    createdByRole: row.created_by_role,
    createdAt: row.created_at,
    submittedByRole: row.submitted_by_role ?? undefined,
    submittedAt: row.submitted_at ?? undefined,
    confirmedByRole: row.confirmed_by_role ?? undefined,
    confirmedAt: row.confirmed_at ?? undefined,
    sourceDocument: row.source_document ?? undefined,
    cancelledByRole: row.cancelled_by_role ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    cancelReason: row.cancel_reason ?? undefined,
    withdrawnByRole: row.withdrawn_by_role ?? undefined,
    withdrawnAt: row.withdrawn_at ?? undefined,
    withdrawReason: row.withdraw_reason ?? undefined,
    externalSyncStatus: row.external_sync_status,
    updatedAt: row.updated_at,
  };
}

const AUDIT_OPERATIONS = [
  "entry", "review", "reject", "confirm", "cancel", "withdraw", "import_stage", "legacy_import",
  "transit_import", "transit_import_revert", "transit_status", "transit_on_shelf",
  "transit_merge", "transit_delete", "transit_manual", "transit_team_corrected", "legacy_placeholder_removed",
  "upgrade_direct_start", "upgrade_direct_complete", "upgrade_relocation_started",
  "upgrade_relocation_procurement", "upgrade_relocation_operation", "upgrade_relocation_corrected", "upgrade_relocation_cancelled", "upgrade_relocation_created",
  "upgrade_relocation_complete", "upgrade_direct_start_withdraw", "upgrade_direct_complete_withdraw",
  "upgrade_relocation_shipment_withdraw", "upgrade_relocation_complete_withdraw",
  "upgrade_transfer_started", "upgrade_flow_update",
];
const AUDIT_OPERATIONS_EXTRA = "transit_off_shelf";
const AUDIT_OPERATION_SET = new Set([...AUDIT_OPERATIONS, AUDIT_OPERATIONS_EXTRA, 'business_correction']);
const AUDIT_LEDGER_TYPES = {
  entry: ["reserve"],
  review: ["review_adjustment"],
  reject: ["release_reservation"],
  confirm: ["release_reservation", "issue"],
  cancel: ["release_reservation"],
  withdraw: ["reverse_issue"],
};

function parseEventPayload(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function rowToDocumentEvent(row) {
  return {
    id: Number(row.id),
    type: row.event_type,
    role: row.role,
    at: row.occurred_at,
    reason: row.reason ?? undefined,
    payload: parseEventPayload(row.payload_json),
  };
}

function rowToLedgerEntry(row) {
  return {
    id: Number(row.id),
    type: row.entry_type,
    onHandDelta: Number(row.on_hand_delta),
    lockedDelta: Number(row.locked_delta),
    relatedLedgerId: row.related_ledger_id == null ? undefined : Number(row.related_ledger_id),
    reversalGroup: row.reversal_group ?? undefined,
    role: row.created_by_role,
    at: row.created_at,
  };
}

function rowToUpgradeLedgerEntry(row) {
  return {
    id: Number(row.id),
    type: row.entry_type,
    batchKey: row.batch_key,
    onHandDelta: Number(row.on_hand_delta),
    lockedDelta: Number(row.locked_delta),
    relatedLedgerId: row.related_ledger_id == null ? undefined : Number(row.related_ledger_id),
    reversalGroup: row.reversal_group ?? undefined,
    role: row.created_by_role,
    at: row.created_at,
  };
}

function auditResult(operation, payload = {}) {
  if (operation === "review") return "商务已批准";
  if (operation === "reject") return "商务已拒绝";
  if (operation === "import_stage") return "已暂存";
  if (operation === "transit_import") return "在途已入账";
  if (operation === "transit_import_revert") return "在途导入已撤销";
  if (operation === "transit_status") return "物流状态已更新";
  if (operation === "transit_on_shelf") return payload.disposition === 'fba_archive' ? "直发FBA已归档，未增加本地在库" : "已转为在库";
  if (operation === "transit_off_shelf") return "已下架转回在途";
  if (operation === "transit_merge") return "在途记录已合并";
  if (operation === "transit_delete") return "在途记录已删除";
  if (operation === "transit_team_corrected") return "已修正团队归属，库存数量不变";
  if (operation === "transit_manual") return "单条在途录入";
  if (operation === "legacy_placeholder_removed") return "历史占位批次已清理";
  if (operation === "upgrade_direct_start") return "在库库存已预锁定升级";
  if (operation === "upgrade_direct_complete") return "在库库存已完成版本转换";
  if (operation === "upgrade_relocation_created") return "已登记移仓发货";
  if (operation === "upgrade_relocation_complete") return payload.completionId ? "升级完成明细已按累计量更新" : "移仓库存已完成升级入库";
  if (operation === "upgrade_transfer_started") return "已发起转仓升级";
  if (operation === "upgrade_flow_update") return "升级资料及进度已更新";
  if (operation === "upgrade_relocation_started") return "已发起移仓流程";
  if (operation === "upgrade_relocation_procurement") return "采购信息已登记";
  if (operation === "upgrade_relocation_operation") return "移除订单已登记";
  if (operation === "upgrade_relocation_corrected") return "移仓资料已更正";
  if (operation === "upgrade_relocation_cancelled") return "未发货移仓流程已取消";
  if (operation === "upgrade_direct_start_withdraw") return "在库升级发起已撤销";
  if (operation === "upgrade_direct_complete_withdraw") return "在库升级完成已撤回";
  if (operation === "upgrade_relocation_shipment_withdraw") return "移仓发货登记已撤回";
  if (operation === "upgrade_relocation_complete_withdraw") return "移仓升级完成已撤回";
  return "成功";
}

function payloadModel(payload) {
  if (typeof payload.model === "string" && payload.model.trim()) return payload.model.trim();
  if (typeof payload.batch !== "string") return undefined;
  const separator = payload.batch.indexOf("#");
  return separator > 0 ? payload.batch.slice(0, separator) : undefined;
}

function optionalPayloadNumber(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (character) => `\\${character}`);
}

export class InventoryDatabase {
  constructor(stateRoot) {
    this.stateRoot = path.resolve(stateRoot);
    this.databasePath = path.join(stateRoot, "data", INVENTORY_DATABASE_NAME);
    if (!fs.existsSync(this.databasePath)) {
      throw new Error(`缺少统一库存数据库 ${this.databasePath}；请先运行 scripts/migrate-to-sqlite.mjs，禁止自动创建空库`);
    }
    this.openDatabase();
  }

  openDatabase() {
    this.db = new DatabaseSync(this.databasePath);
    configureDatabase(this.db);
    const version = Number(this.db.prepare("PRAGMA user_version").get().user_version);
    if (version !== INVENTORY_SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`库存数据库版本不匹配：程序需要 ${INVENTORY_SCHEMA_VERSION}，实际 ${version}；请先执行受控迁移`);
    }
    const integrity = this.db.prepare("PRAGMA quick_check").get().quick_check;
    if (integrity !== "ok") {
      this.db.close();
      throw new Error(`库存数据库完整性检查失败：${integrity}`);
    }
  }

  close() {
    this.db.close();
  }

  transaction(task) {
    const run = () => {
      this.changedBatches = new Set();
      let started = false;
      try {
        this.db.exec("BEGIN IMMEDIATE");
        started = true;
        const result = task();
        for (const batch of this.changedBatches) this.getBalance(batch);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        if (started) {
          try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
        }
        if (/SQLITE_BUSY|database is locked/i.test(`${error?.code ?? ""} ${error?.message ?? ""}`)) {
          throw new BusinessError(409, "database_busy", "库存数据库正被其他操作占用，请刷新后重试");
        }
        throw error;
      }
    };
    return run();
  }

  syncState() {
    const rows = this.db.prepare("SELECT key, value FROM system_meta WHERE key IN ('database_id', 'data_version', 'updated_at')").all();
    const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      databaseId: meta.database_id,
      dataVersion: Number(meta.data_version || 0),
      updatedAt: meta.updated_at,
      schemaVersion: INVENTORY_SCHEMA_VERSION,
      pollAfterMs: 2000,
    };
  }

  bumpVersion(at = new Date().toISOString()) {
    this.db.prepare("UPDATE system_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version'").run();
    this.db.prepare("UPDATE system_meta SET value = ? WHERE key = 'updated_at'").run(at);
    return this.syncState();
  }

  refreshApprovalDisplay(at = new Date().toISOString()) {
    // 北京时间周二、周四 21:00 即 UTC 当日 13:00，不受部署电脑时区影响。
    const boundary = new Date(at);
    boundary.setUTCHours(13, 0, 0, 0);
    while (boundary.toISOString() > at || ![2, 4].includes(boundary.getUTCDay())) boundary.setUTCDate(boundary.getUTCDate() - 1);
    const cutoff = boundary.toISOString();
    const meta = Object.fromEntries(this.db.prepare("SELECT key, value FROM system_meta WHERE key IN ('approval_first_clear_at', 'approval_clear_before')").all().map(row => [row.key, row.value]));
    if (!meta.approval_first_clear_at) {
      do { boundary.setUTCDate(boundary.getUTCDate() + 1); } while (![2, 4].includes(boundary.getUTCDay()));
      this.db.prepare("INSERT INTO system_meta(key, value) VALUES ('approval_first_clear_at', ?)").run(boundary.toISOString());
    } else if (cutoff >= meta.approval_first_clear_at && (!meta.approval_clear_before || cutoff > meta.approval_clear_before)) {
      this.transaction(() => {
        this.db.prepare("INSERT INTO system_meta(key, value) VALUES ('approval_clear_before', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(cutoff);
        this.bumpVersion(at);
      });
      return cutoff;
    }
    return meta.approval_clear_before ?? null;
  }

  /* 显式全库验收：核对型号、批次、在途和可用量恒等式；日常写事务只校验本次改动批次余额。 */
  assertInventoryInvariants() {
    const models = this.db.prepare("SELECT model, in_transit FROM catalog_models").all();
    for (const model of models) {
      const stock = this.db.prepare(`
        SELECT COALESCE(SUM(b.base_quantity
          + COALESCE((SELECT SUM(r.quantity) FROM stock_receipts r WHERE r.batch_key = b.batch_key), 0)
          + COALESCE((SELECT SUM(l.on_hand_delta) FROM inventory_ledger l WHERE l.batch_key = b.batch_key), 0)
          + COALESCE((SELECT SUM(u.on_hand_delta) FROM upgrade_inventory_ledger u WHERE u.batch_key = b.batch_key), 0)), 0) AS on_hand,
          COALESCE(SUM(
            COALESCE((SELECT SUM(l.locked_delta) FROM inventory_ledger l WHERE l.batch_key = b.batch_key), 0)
            + COALESCE((SELECT SUM(u.locked_delta) FROM upgrade_inventory_ledger u WHERE u.batch_key = b.batch_key), 0)
          ), 0) AS locked
        FROM stock_batches b WHERE b.model = ?
      `).get(model.model);
      const transit = this.db.prepare(`
        SELECT COALESCE(SUM(remaining_quantity), 0) AS quantity
        FROM transit_batches WHERE model = ? AND status = 'in_transit' AND remaining_quantity > 0 AND voided_at IS NULL
      `).get(model.model);
      const onHand = Number(stock?.on_hand || 0);
      const locked = Number(stock?.locked || 0);
      const inTransit = Number(transit?.quantity || 0);
      if (onHand < 0 || locked < 0 || onHand < locked
        || Number(model.in_transit) !== inTransit) {
        throw new BusinessError(500, "inventory_invariant", `型号 ${model.model} 的库存汇总与明细不一致，本次修改未保存`, {
          model: model.model, summary: { inTransit: Number(model.in_transit) },
          detail: { inStock: onHand, locked, inTransit },
        });
      }
    }
    const batches = this.db.prepare(`
      SELECT b.batch_key, b.base_quantity
        + COALESCE((SELECT SUM(r.quantity) FROM stock_receipts r WHERE r.batch_key = b.batch_key), 0)
        + COALESCE((SELECT SUM(l.on_hand_delta) FROM inventory_ledger l WHERE l.batch_key = b.batch_key), 0)
        + COALESCE((SELECT SUM(u.on_hand_delta) FROM upgrade_inventory_ledger u WHERE u.batch_key = b.batch_key), 0) AS on_hand,
        COALESCE((SELECT SUM(l.locked_delta) FROM inventory_ledger l WHERE l.batch_key = b.batch_key), 0)
        + COALESCE((SELECT SUM(u.locked_delta) FROM upgrade_inventory_ledger u WHERE u.batch_key = b.batch_key), 0) AS locked
      FROM stock_batches b
    `).all();
    for (const batch of batches) {
      if (Number(batch.on_hand) < 0 || Number(batch.locked) < 0 || Number(batch.on_hand) < Number(batch.locked)) {
        throw new BusinessError(500, "inventory_invariant", `批次 ${batch.batch_key} 的在库、预锁定或可用数量不合法，本次修改未保存`);
      }
    }
    return true;
  }







  getModel(model) {
    return this.db.prepare("SELECT * FROM catalog_models WHERE model = ?").get(model) ?? null;
  }


  stockBatchSourceTeams() { return stockBatchSourceTeams(this.db); }

  visibleStockBatchKeys(model, category, visibleGroup, scopeAllCategories = false) {
    if (!visibleGroup || (!scopeAllCategories && category !== "墨盒")) return null;
    const teamsByBatch = this.stockBatchSourceTeams();
    return new Set(this.db.prepare("SELECT batch_key FROM stock_batches WHERE model = ?").all(model)
      .filter((row) => teamsByBatch.get(row.batch_key)?.size === 1 && teamsByBatch.get(row.batch_key)?.has(visibleGroup))
      .map((row) => row.batch_key));
  }


  getCatalog({ visibleGroup = null, scopeAllCategories = false } = {}) {
    const models = this.db.prepare(`SELECT m.*,
      COALESCE((SELECT SUM(on_hand) FROM stock_balances WHERE model=m.model),0) AS in_stock,
      COALESCE((SELECT SUM(locked) FROM stock_balances WHERE model=m.model),0) AS locked,
      COALESCE((SELECT SUM(remaining_quantity) FROM transit_batches WHERE model=m.model AND status='in_transit' AND voided_at IS NULL),0) AS in_transit
      FROM catalog_models m ORDER BY m.model`).all();
    const batchRows = this.db.prepare("SELECT * FROM stock_balances ORDER BY model, ship_date, version, fnsku").all();
    /* 明细保留已上架的原始行（数量为 0、status=on_shelf）以便追溯；汇总在途仅计算 active remaining_quantity。 */
    const transitRows = this.db.prepare("SELECT * FROM transit_batches WHERE voided_at IS NULL ORDER BY model, id").all();
    const stockDetails = {};
    const inTransitDetails = {};
    for (const row of batchRows) {
      const onHand = Number(row.on_hand);
      const locked = Number(row.locked);
      if (onHand < 0 || locked < 0 || onHand - locked < 0) {
        throw new BusinessError(500, "inventory_invariant", `批次 ${row.batch_key} 库存不一致，已停止展示与写入`);
      }
      const legacy = Number(row.is_legacy_placeholder) === 1;
      (stockDetails[row.model] ??= []).push({
        quantity: onHand,
        baseQuantity: Number(row.base_quantity) + Number(row.receipt_quantity || 0) + Number(row.upgrade_receipt_quantity || 0),
        locked,
        available: onHand - locked,
        plan: legacy ? null : row.plan,
        date: legacy ? null : row.ship_date,
        version: legacy ? null : row.version,
        fnsku: legacy ? null : row.fnsku,
        packPerBox: row.pack_per_box == null ? null : String(row.pack_per_box),
        batchKey: row.batch_key, warehouse: row.warehouse, shippingMethod: row.shipping_method || row.warehouse, sourceTeam: row.source_team || null,
        revision: Number(row.revision),
        isLegacyPlaceholder: legacy,
      });
    }
    for (const row of transitRows) {
      (inTransitDetails[row.model] ??= []).push({
        id: Number(row.id),
        quantity: Number(row.remaining_quantity), originalQuantity: Number(row.quantity),
        plan: Number(row.is_legacy_placeholder) === 1 ? null : row.plan,
        date: Number(row.is_legacy_placeholder) === 1 ? null : row.ship_date,
        version: Number(row.is_legacy_placeholder) === 1 ? null : row.version,
        fnsku: Number(row.is_legacy_placeholder) === 1 ? null : row.fnsku,
        packPerBox: row.pack_per_box == null ? null : String(row.pack_per_box),
        brand: row.brand, transportMethod: row.transport_method, shippingMethod: row.shipping_method, team: row.team, store: row.store_name,
        status: row.logistics_status, statusCode: row.status, onShelf: row.on_shelf_indicator,
        revision: Number(row.revision), updatedAt: row.updated_at, importBatchId: row.import_batch_id == null ? null : Number(row.import_batch_id),
        isLegacyPlaceholder: Number(row.is_legacy_placeholder) === 1,
      });
    }
    const identityValue = (rows, field) => {
      const values = rows.map((row) => String(row[field] ?? "").trim()).filter((value) => value && value !== "-");
      return [...new Set(values)].join("、") || "-";
    };
    const teamsByBatch = visibleGroup ? this.stockBatchSourceTeams() : null;
    const scopedCategory = category => Boolean(scopeAllCategories || category === "墨盒");
    const visibleStockRows = (model, category) => {
      const rows = stockDetails[model] ?? [];
      if (!visibleGroup || !scopedCategory(category)) return rows;
      return rows.filter((row) => teamsByBatch.get(row.batchKey)?.size === 1 && teamsByBatch.get(row.batchKey)?.has(visibleGroup));
    };
    const visibleTransitRows = (model, category) => {
      const rows = inTransitDetails[model] ?? [];
      if (!visibleGroup || !scopedCategory(category)) return rows;
      return rows.filter((row) => row.team === visibleGroup);
    };
    const scopedModels = [];
    const scopedStockDetails = {};
    const scopedTransitDetails = {};
    for (const row of models) {
      const stockRows = visibleStockRows(row.model, row.category);
      const transitRowsForModel = visibleTransitRows(row.model, row.category);
      const scoped = Boolean(visibleGroup && scopedCategory(row.category));
      if (scoped && stockRows.length === 0 && transitRowsForModel.length === 0) continue;
      const inStock = scoped ? stockRows.reduce((sum, item) => sum + Number(item.quantity || 0), 0) : Number(row.in_stock);
      const locked = scoped ? stockRows.reduce((sum, item) => sum + Number(item.locked || 0), 0) : Number(row.locked);
      const inTransit = scoped ? transitRowsForModel.reduce((sum, item) => sum + Number(item.quantity || 0), 0) : Number(row.in_transit);
      const identityRows = [...stockRows, ...transitRowsForModel];
      scopedModels.push({
        model: row.model, category: row.category, inStock, locked, available: inStock - locked, inTransit,
        /* 主汇总保留需求一的四个身份字段；同型号存在多个批次时逐项去重并以“、”展示，
           具体数量和字段组合仍以展开的在库/在途明细为准。 */
        plan: identityValue(identityRows, "plan"), shipDate: identityValue(identityRows, "date"),
        version: identityValue(identityRows, "version"), fnsku: identityValue(identityRows, "fnsku"),
        revision: Number(row.revision), updatedAt: row.updated_at,
      });
      scopedStockDetails[row.model] = stockRows;
      scopedTransitDetails[row.model] = transitRowsForModel;
    }
    return {
      models: scopedModels,
      stockDetails: scopedStockDetails,
      inTransitDetails: scopedTransitDetails,
      sync: this.syncState(),
    };
  }

  batchTotals(model) {
    const rows = this.db.prepare("SELECT * FROM stock_balances WHERE model = ?").all(model);
    return Object.fromEntries(rows.map((row) => {
      const onHand = Number(row.on_hand);
      const locked = Number(row.locked);
      const done = Number(row.done);
      if (onHand < 0 || locked < 0 || onHand - locked < 0 || done < 0) {
        throw new BusinessError(500, "inventory_invariant", `批次 ${row.batch_key} 库存余额异常，已停止相关操作`);
      }
      return [row.batch_key, {
        base: Number(row.base_quantity) + Number(row.receipt_quantity || 0) + Number(row.upgrade_receipt_quantity || 0), onHand, locked, done, available: onHand - locked,
        revision: Number(row.revision), updatedAt: row.updated_at,
      }];
    }));
  }

  getAllocations(model, { visibleGroup = null, scopeAllCategories = false } = {}) {
    const catalog = this.getModel(model);
    if (!catalog) throw new BusinessError(404, "unknown_model", `未知型号“${model}”`);
    const visibleBatchKeys = this.visibleStockBatchKeys(model, catalog.category, visibleGroup, scopeAllCategories);
    const rows = this.db.prepare(`SELECT d.*,
      (SELECT SUM(locked_delta) FROM inventory_ledger WHERE document_id=d.id) AS current_locked,
      (SELECT -SUM(on_hand_delta) FROM inventory_ledger WHERE document_id=d.id) AS actual_issued
      FROM allocation_documents d WHERE model = ? ORDER BY id DESC`).all(model);
    const records = {};
    const publicRecords = {};
    for (const row of rows) {
      if (visibleBatchKeys && !visibleBatchKeys.has(row.batch_key)) continue;
      (records[row.batch_key] ??= []).push(this.documentRecord(row));
      if (row.status === 'draft') continue;
      // 公开摘要只投影已确认可跨团查看的字段；占用和调出直接取调拨账本，不混入升级账本。
      (publicRecords[row.batch_key] ??= []).push({
        id: Number(row.id), documentNo: row.document_no, operator: row.operator_name, department: row.department,
        requestedQuantity: row.approval_status === 'legacy' || row.requested_quantity == null ? null : Number(row.requested_quantity),
        approvedQuantity: row.approval_status === 'legacy' || row.approved_quantity == null ? null : Number(row.approved_quantity),
        lockedQuantity: row.current_locked == null ? null : Number(row.current_locked),
        issuedQuantity: row.actual_issued == null ? null : Number(row.actual_issued),
        status: row.approval_status === 'rejected' ? '已拒绝'
          : row.status === 'confirmed' ? '已完成'
          : row.status === 'pending' ? row.approval_status === 'approved' ? '待助理完成' : '待商务审核'
          : STATUS_TEXT[row.status] ?? row.status,
      });
    }
    const allTotals = this.batchTotals(model);
    const totals = visibleBatchKeys
      ? Object.fromEntries(Object.entries(allTotals).filter(([key]) => visibleBatchKeys.has(key)))
      : allTotals;
    return { model, category: catalog.category, records, publicRecords, totals, sync: this.syncState() };
  }

  getDocument(id) {
    return this.documentRecord(this.db.prepare("SELECT * FROM allocation_documents WHERE id = ?").get(id));
  }

  getDocumentByNo(documentNo) {
    return this.documentRecord(this.db.prepare("SELECT * FROM allocation_documents WHERE document_no = ?").get(documentNo));
  }

  lingxingForDocument(row) {
    if (row.lingxing_snapshot_json != null) return JSON.parse(row.lingxing_snapshot_json);
    const metrics = this.db.prepare("SELECT data_json FROM lingxing_asin_metrics WHERE asin = ?").get(row.asin);
    return metrics ? JSON.parse(metrics.data_json) : null;
  }

  documentRecord(row) {
    return row ? rowToDocument(row, this.lingxingForDocument(row)) : null;
  }

  approvalView() {
    const cutoff = this.refreshApprovalDisplay();
    return {
      // 未完成单始终保留；终态按实际办结时间在下一次计划截止点隐藏。
      allocations: this.db.prepare(`SELECT d.*, b.pack_per_box AS source_pack_per_box
        FROM allocation_documents d LEFT JOIN stock_batches b ON b.batch_key = d.batch_key
        WHERE d.status <> 'draft'
        AND (d.status = 'pending' OR ? IS NULL OR CASE
          WHEN d.status = 'confirmed' THEN d.confirmed_at
          WHEN d.approval_status = 'rejected' THEN d.reviewed_at
          ELSE d.created_at END >= ?)
        ORDER BY d.updated_at DESC, d.id DESC`).all(cutoff, cutoff).map((row) => ({
          ...this.documentRecord(row),
          packPerBox: row.source_pack_per_box == null ? null : String(row.source_pack_per_box),
        })),
      inquiries: this.db.prepare(`SELECT * FROM inquiry_documents WHERE hidden_at IS NULL
        ORDER BY updated_at DESC, id DESC`).all().map((row) => this.inquiryRecord(row)),
    };
  }

  inquiryRecord(row) {
    if (!row) return null;
    const quantity = Number(row.supplier_quantity ?? row.approved_quantity ?? row.requested_quantity);
    const lingxing = this.lingxingForDocument(row);
    const shipments = this.inquiryShipments(Number(row.id));
    const shippedQuantity = shipments.reduce((total, shipment) => total + shipment.quantity, 0);
    return {
      id: Number(row.id), documentNo: row.document_no, model: row.model, asin: row.asin, fnsku: row.fnsku,
      quantity, requestedQuantity: Number(row.requested_quantity),
      approvedQuantity: row.approved_quantity == null ? null : Number(row.approved_quantity),
      supplierQuantity: row.supplier_quantity == null ? null : Number(row.supplier_quantity),
      packPerBox: row.pack_per_box, hiddenAt: row.hidden_at,
      sourceDeficit: row.supplier_quantity == null ? 0 : Math.max(0, -this.relocationSourceQuantity(null, Number(row.id))),
      department: row.department, store: row.store_name, operator: row.operator_name,
      operatorNote: row.operator_note, businessNote: row.business_note, shippingWarehouse: row.shipping_warehouse, purchaseNote: row.purchase_note ?? "",
      plan: row.plan, date: row.ship_date, version: row.version,
      status: row.status, statusCode: row.status,
      statusText: { pending_business: "待商务审核", pending_purchasing: "待Alan或采购回复", pending_procurement: "待采购归档", archived: "已完成", rejected: "已拒绝", cancelled: "已取消" }[row.status],
      approvalStatus: row.status === "rejected" ? "rejected" : row.approved_quantity == null ? "pending" : "approved",
      createdByRole: row.created_by_role, createdAt: row.created_at, updatedAt: row.updated_at,
      reviewedByRole: row.reviewed_by_role, reviewedAt: row.reviewed_at,
      repliedByRole: row.replied_by_role, repliedAt: row.replied_at,
      archivedByRole: row.archived_by_role, archivedAt: row.archived_at,
      cancelledByRole: row.cancelled_by_role, cancelledAt: row.cancelled_at, cancelReason: row.cancel_reason,
      fbaShippedAt: row.fba_shipped_at, fbaConfirmedByRole: row.fba_confirmed_by_role,
      shipments,
      revision: Number(row.revision), lingxing, ...lingxingCoverage(lingxing, quantity),
      events: this.db.prepare("SELECT * FROM inquiry_events WHERE inquiry_id = ? ORDER BY id").all(row.id).map((event) => ({
        id: Number(event.id), type: event.event_type, role: event.role, at: event.occurred_at, payload: JSON.parse(event.payload_json),
      })),
    };
  }

  getInquiry(id) {
    return this.inquiryRecord(this.db.prepare("SELECT * FROM inquiry_documents WHERE id = ?").get(id));
  }

  inquiryShipments(id) {
    return this.db.prepare("SELECT * FROM inquiry_shipments WHERE inquiry_id=? ORDER BY id").all(id).map(row => ({
      id:Number(row.id),quantity:Number(row.quantity),date:row.ship_date,revision:Number(row.revision),createdAt:row.created_at,updatedAt:row.updated_at,
    }));
  }

  inquiryForUpdate(id, expectedRevision, statuses) {
    const row = this.db.prepare("SELECT * FROM inquiry_documents WHERE id = ?").get(id);
    if (!row) throw new BusinessError(404, "inquiry_not_found", `找不到询库单 ${id}`);
    if (!Number.isInteger(expectedRevision)) throw new BusinessError(400, "missing_revision", "当前记录信息不完整，请重新加载后操作");
    if (Number(row.revision) !== expectedRevision) throw new BusinessError(409, "stale_revision", "询库单已被其他同事更新，请刷新后重试", { current: this.inquiryRecord(row) });
    if (!statuses.includes(row.status)) throw new BusinessError(409, "invalid_inquiry_status", "当前询库单不在本步骤，请刷新查看进度");
    return row;
  }

  addInquiryEvent(id, type, role, at, payload) {
    this.db.prepare("INSERT INTO inquiry_events(inquiry_id, event_type, role, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run(id, type, role, at, JSON.stringify(payload));
    this.db.prepare(`UPDATE catalog_models SET revision = revision + 1, updated_at = ?
      WHERE model = (SELECT model FROM inquiry_documents WHERE id = ?)`).run(at, id);
  }

  createInquiry({ role, model, quantity, department, store, operator, fnsku, asin, operatorNote, requestId }) {
    requireDepartment(role, department);
    if (!["admin", "operation-1", "operation-2"].includes(role)) throw new BusinessError(403, "entry_forbidden", "当前角色不能提交询库需求");
    store = requireValidStoreCode(store);
    const asinValue = normalizeAsin(asin);
    const note = String(operatorNote ?? "").trim();
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BusinessError(400, "invalid_quantity", "询库数量请填写大于 0 的整数");
    return this.idempotent("inquiry:create", requestId, { role, model, quantity, department, store, operator, fnsku, asin: asinValue, operatorNote: note }, () => {
      if (!this.getModel(model)) throw new BusinessError(400, "unknown_model", `未知型号“${model}”`);
      const at = new Date().toISOString();
      const inserted = this.db.prepare(`INSERT INTO inquiry_documents(document_no, model, asin, fnsku, requested_quantity,
        department, store_name, operator_name, operator_note, status, created_by_role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_business', ?, ?, ?)`)
        .run(`PENDING-${crypto.randomUUID()}`, model, asinValue, fnsku, quantity, department, store, operator, note, role, at, at);
      const id = Number(inserted.lastInsertRowid);
      this.db.prepare("UPDATE inquiry_documents SET document_no = ? WHERE id = ?").run(`XK-${String(id).padStart(6, "0")}`, id);
      this.addInquiryEvent(id, "entry", role, at, { requestedQuantity: quantity, asin: asinValue, operatorNote: note });
      return { ok: true, record: this.getInquiry(id) };
    });
  }

  reviewInquiry({ id, role, decision, approvedQuantity, businessNote, expectedRevision, requestId }) {
    if (role !== BUSINESS_ROLE) throw new BusinessError(403, "review_forbidden", "仅商务可审核询库");
    if (!["approve", "reject"].includes(decision)) throw new BusinessError(400, "invalid_review_decision", "请选择批准或拒绝");
    const approved = decision === "approve" ? Number(approvedQuantity) : null;
    if (decision === "approve" && (!Number.isInteger(approved) || approved <= 0)) throw new BusinessError(400, "invalid_quantity", "审核数量请填写大于 0 的整数");
    const note = String(businessNote ?? "").trim();
    return this.idempotent(`inquiry:review:${id}`, requestId, { id, role, decision, approvedQuantity: approved, businessNote: note, expectedRevision }, () => {
      const row = this.inquiryForUpdate(id, expectedRevision, ["pending_business"]);
      const at = new Date().toISOString();
      this.db.prepare(`UPDATE inquiry_documents SET approved_quantity = ?, business_note = ?, status = ?,
        reviewed_by_role = ?, reviewed_at = ?, lingxing_snapshot_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?`)
        .run(approved, note, decision === "approve" ? "pending_purchasing" : "rejected", role, at,
          decision === "reject" ? JSON.stringify(this.lingxingForDocument(row)) : null, at, id);
      this.addInquiryEvent(id, decision === "approve" ? "review" : "reject", role, at, { approvedQuantity: approved, businessNote: note });
      return { ok: true, record: this.getInquiry(id) };
    });
  }

  replyInquiry({ id, role, supplierQuantity, shippingWarehouse, purchaseNote, expectedRevision, requestId }) {
    if (!["purchasing", "alan"].includes(role)) throw new BusinessError(403, "inquiry_reply_forbidden", "仅Alan或采购可填写供应商库存回复");
    if (typeof supplierQuantity !== "number" && typeof supplierQuantity !== "string") {
      throw new BusinessError(400, "invalid_quantity", "供应商库存回复请填写 0 或正整数");
    }
    if (typeof supplierQuantity === "string" && supplierQuantity.trim() === "") {
      throw new BusinessError(400, "invalid_quantity", "供应商库存回复请填写 0 或正整数");
    }
    const quantity = Number(supplierQuantity);
    const warehouse = String(shippingWarehouse ?? "").trim();
    const note = String(purchaseNote ?? "").trim();
    if (!Number.isInteger(quantity) || quantity < 0) throw new BusinessError(400, "invalid_quantity", "供应商库存回复请填写 0 或正整数");
    if (quantity > 0 && !warehouse) throw new BusinessError(400, "missing_shippingWarehouse", "请填写发货仓库");
    if (warehouse && !["CA", "SC"].includes(warehouse)) throw new BusinessError(400, "invalid_shippingWarehouse", "发货仓库只能选择 CA 或 SC");
    return this.idempotent(`inquiry:reply:${id}`, requestId, { id, role, supplierQuantity: quantity, shippingWarehouse: warehouse, purchaseNote: note, expectedRevision }, () => {
      const row = this.inquiryForUpdate(id, expectedRevision, ["pending_purchasing"]);
      const at = new Date().toISOString();
      this.db.prepare(`UPDATE inquiry_documents SET supplier_quantity = ?, shipping_warehouse = ?,
        purchase_note = ?, status = ?,
        replied_by_role = ?, replied_at = ?, archived_by_role = ?, archived_at = ?, lingxing_snapshot_json = ?,
        revision = revision + 1, updated_at = ? WHERE id = ?`)
        .run(quantity, warehouse, note, quantity === 0 ? "rejected" : "pending_procurement", role, at,
          null, null,
          quantity === 0 ? JSON.stringify(this.lingxingForDocument(row)) : null, at, id);
      this.addInquiryEvent(id, quantity === 0 ? "reply_no_stock_reject" : "reply", role, at, { supplierQuantity: quantity, shippingWarehouse: warehouse, purchaseNote: note });
      if (quantity === 0) this.backupInquiry(id, role, at);
      return { ok: true, record: this.getInquiry(id) };
    });
  }

  archiveInquiry({ id, role, plan, date, version, expectedRevision, requestId }) {
    if (role !== 'purchasing') throw new BusinessError(403, "inquiry_archive_forbidden", "仅采购可归档询库");
    const fields = { plan: String(plan ?? "").trim(), date: inquiryShipDate(date), version: String(version ?? "").trim() };
    if (!fields.plan || !fields.version) throw new BusinessError(400, "missing_inquiry_archive_fields", "请填写发货计划号、发货日期和原版本");
    return this.idempotent(`inquiry:archive:${id}`, requestId, { id, role, ...fields, expectedRevision }, () => {
      const row = this.inquiryForUpdate(id, expectedRevision, ["pending_procurement"]);
      const remaining = this.relocationSourceQuantity(null, id);
      if (remaining < 0) throw new BusinessError(409, 'inquiry_source_deficit', `新回复比既有已发及其他减少少 ${-remaining} 件，请核对差额后再归档`, { deficit: -remaining });
      const at = new Date().toISOString();
      this.db.prepare(`UPDATE inquiry_documents SET plan = ?, ship_date = ?, version = ?, status = 'archived',
        archived_by_role = ?, archived_at = ?, lingxing_snapshot_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?`)
        .run(fields.plan, fields.date, fields.version, role, at, JSON.stringify(this.lingxingForDocument(row)), at, id);
      this.addInquiryEvent(id, "archive", role, at, { ...fields, quantity: Number(row.supplier_quantity) });
      this.backupInquiry(id, role, at);
      return { ok: true, record: this.getInquiry(id) };
    });
  }

  backupInquiry(id, role, at) {
    const snapshot = this.db.prepare('SELECT * FROM inquiry_documents WHERE id=?').get(id);
    this.addInquiryEvent(id, 'backup_snapshot', role, at, { snapshot });
  }

  inquiryBackups({ visibleGroup = null } = {}) {
    return this.db.prepare(`SELECT * FROM inquiry_documents i WHERE status IN ('archived','rejected')
      OR EXISTS(SELECT 1 FROM inquiry_events e WHERE e.inquiry_id=i.id AND e.event_type='backup_snapshot')
      ORDER BY updated_at DESC,id DESC`).all()
      .filter(row => !visibleGroup || row.department === visibleGroup).map(row => this.inquiryRecord(row));
  }

  recallInquiry({ id, role, expectedRevision, requestId }) {
    if (!['purchasing','business'].includes(role)) throw new BusinessError(403,'inquiry_recall_forbidden','仅采购或商务可回撤询库');
    return this.idempotent(`inquiry:recall:${id}`,requestId,{id,role,expectedRevision},()=>{
      const row=this.inquiryForUpdate(id,expectedRevision,['archived','rejected','pending_procurement','pending_purchasing','pending_business']);
      if(role==='purchasing' && row.status==='pending_business') throw new BusinessError(409,'inquiry_business_review_required','商务回撤后须先完成商务重审，采购不能回撤跳过审核');
      if (!['archived','rejected'].includes(row.status) && !this.db.prepare("SELECT 1 FROM inquiry_events WHERE inquiry_id=? AND event_type='backup_snapshot'").get(id)) {
        throw new BusinessError(409,'inquiry_not_backed_up','询库尚无终态备份，不能回撤');
      }
      const at=new Date().toISOString();
      if (['archived','rejected'].includes(row.status)) this.backupInquiry(id,role,at);
      const target=role==='business'?'pending_business':'pending_purchasing';
      this.db.prepare(`UPDATE inquiry_documents SET status=?,supplier_quantity=NULL,shipping_warehouse='',purchase_note='',
        replied_at=NULL,replied_by_role=NULL,plan='',ship_date='',version='',archived_at=NULL,archived_by_role=NULL,
        hidden_at=NULL,lingxing_snapshot_json=NULL,revision=revision+1,updated_at=? WHERE id=?`).run(target,at,id);
      if(role==='business') this.db.prepare("UPDATE inquiry_documents SET approved_quantity=NULL,business_note='',reviewed_at=NULL,reviewed_by_role=NULL WHERE id=?").run(id);
      this.addInquiryEvent(id,'recall',role,at,{from:row.status,to:target,snapshot:row});
      return {ok:true,record:this.getInquiry(id)};
    });
  }

  hideInquiries({ role, ids, requestId }) {
    if (!['admin','purchasing','business'].includes(role)) throw new BusinessError(403,'inquiry_clear_forbidden','仅采购、商务或管理员可手动清空询库');
    return this.idempotent('inquiry:hide',requestId,{role,ids},()=>{
      const at=new Date().toISOString(); let hidden=0;
      for (const id of ids) {
        const row=this.db.prepare("SELECT * FROM inquiry_documents WHERE id=? AND status IN ('archived','rejected') AND hidden_at IS NULL").get(id);
        if(!row) continue;
        this.backupInquiry(id,role,at);
        this.db.prepare('UPDATE inquiry_documents SET hidden_at=?,revision=revision+1,updated_at=? WHERE id=?').run(at,at,id);
        this.addInquiryEvent(id,'hide',role,at,{}); hidden++;
      }
      return {ok:true,hidden};
    });
  }


  syncLingxing({ role, items, capturedAt, requestId, onSaved }) {
    if (!["admin", "business"].includes(role)) throw new BusinessError(403, "lingxing_sync_forbidden", "仅商务或管理员可同步领星指标");
    if (!Array.isArray(items) || items.length === 0) throw new BusinessError(400, "missing_lingxing_items", "没有收到领星指标，请重新同步");
    const captureTime = new Date(capturedAt);
    if (!capturedAt || !Number.isFinite(captureTime.getTime())) throw new BusinessError(400, "invalid_captured_at", "领星指标缺少有效取数时间，请重新同步");
    const capture = captureTime.toISOString();
    const fields = ["sales7d", "sales30d", "fbaAvailable", "fbaPendingTransfer", "fbaTransferring", "fbaInbound"];
    const results = items.map((item) => {
      const asin = normalizeAsin(item?.asin);
      const data = { asin, scope: "all_stores", capturedAt: capture };
      for (const field of fields) {
        if (typeof item[field] !== "number" || !Number.isInteger(item[field]) || item[field] < 0) {
          throw new BusinessError(400, "invalid_lingxing_metric", `${asin} 的${({sales7d:"7 天销量",sales30d:"30 天销量",fbaAvailable:"FBA 可售",fbaPendingTransfer:"FBA 待调仓",fbaTransferring:"FBA 调仓中",fbaInbound:"FBA 在途"})[field]}不是有效数量，请在部署电脑核对领星报表`);
        }
        data[field] = item[field];
      }
      if (typeof item.orderGrossProfit !== "number" || !Number.isFinite(item.orderGrossProfit)) {
        throw new BusinessError(400, "invalid_lingxing_metric", `${asin} 的订单毛利润必须是有效数字`);
      }
      data.orderGrossProfit = item.orderGrossProfit;
      return data;
    });
    if (new Set(results.map((item) => item.asin)).size !== results.length) throw new BusinessError(400, "duplicate_lingxing_asin", "同一次同步中 ASIN 不能重复");
    return this.idempotent("approvals:lingxing-sync", requestId, { role, items: results, capturedAt: capture }, () => {
      const at = new Date().toISOString();
      const update = this.db.prepare(`INSERT INTO lingxing_asin_metrics(asin, data_json, captured_at, synced_by_role, synced_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(asin) DO UPDATE SET data_json = excluded.data_json, captured_at = excluded.captured_at,
          synced_by_role = excluded.synced_by_role, synced_at = excluded.synced_at`);
      for (const data of results) {
        const previous = this.db.prepare("SELECT captured_at FROM lingxing_asin_metrics WHERE asin = ?").get(data.asin);
        if (previous && previous.captured_at > capture) throw new BusinessError(409, "lingxing_stale_capture", `${data.asin} 已有更新的抓取结果`);
        update.run(data.asin, JSON.stringify(data), capture, role, at);
      }
      const result = { ok: true, updated: results.length, capturedAt: capture };
      // 部署端任务成功状态与业务结果在同一个事务提交。
      onSaved?.(result);
      return result;
    });
  }

  requireUpgradeRole(role) {
    if (!UPGRADE_ROLE_SET.has(role)) throw new BusinessError(403, "upgrade_role_forbidden", "当前角色无权操作升级库存");
  }

  requirePurchasingUpgradeRole(role) {
    if (role !== "purchasing") throw new BusinessError(403, "upgrade_purchasing_required", "仅采购角色可登记升级完成数量或采购信息");
  }

  requireOperationUpgradeRole(role, document) {
    if (!new Set(["operation-1", "operation-2"]).has(role)) {
      throw new BusinessError(403, "upgrade_operation_required", "仅运营角色可登记移除订单号");
    }
    const roleGroup = OPERATION_GROUPS[role];
    if (roleGroup !== document.department) {
      throw new BusinessError(403, "group_forbidden", `运营仅可处理本团（${roleGroup}）业务`);
    }
  }

  addUpgradeOperation({ upgradeId, relocationId = null, type, quantity, newVersion = null, eventId, requestId, role, at, metadata = {} }) {
    const result = this.db.prepare(`
      INSERT INTO upgrade_operations(
        operation_no, upgrade_id, relocation_id, operation_type, quantity, new_version,
        source_event_id, request_id, performed_by_role, performed_at, status, revision, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)
    `).run(
      `PENDING-${crypto.randomUUID()}`, Number(upgradeId), relocationId == null ? null : Number(relocationId),
      type, Number(quantity), newVersion, Number(eventId), requestId, role, at, JSON.stringify(metadata),
    );
    const operationId = Number(result.lastInsertRowid);
    this.db.prepare("UPDATE upgrade_operations SET operation_no = ? WHERE id = ?")
      .run(upgradeOperationNumber(operationId), operationId);
    return operationId;
  }

  addUpgradeLedger(upgradeId, sourceType, sourceId, batch, type, onHandDelta, lockedDelta, role, at, requestId, metadata = {}, operationId = null, relatedLedgerId = null, reversalGroup = null) {
    this.changedBatches.add(batch);
    const result = this.db.prepare(`
      INSERT INTO upgrade_inventory_ledger(
        upgrade_id, operation_id, source_type, source_id, batch_key, entry_type,
        on_hand_delta, locked_delta, related_ledger_id, reversal_group,
        created_by_role, created_at, request_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      upgradeId, operationId, sourceType, sourceId, batch, type,
      onHandDelta, lockedDelta, relatedLedgerId, reversalGroup,
      role, at, requestId, JSON.stringify(metadata),
    );
    this.db.prepare("UPDATE stock_batches SET revision = revision + 1, updated_at = ? WHERE batch_key = ?").run(at, batch);
    this.db.prepare(`
      UPDATE catalog_models SET revision = revision + 1, updated_at = ?
      WHERE model = (SELECT model FROM stock_batches WHERE batch_key = ?)
    `).run(at, batch);
    return Number(result.lastInsertRowid);
  }

  ensureStockBatch(sourceBatch, newVersion, at, warehouse, shippingMethod = sourceBatch.shipping_method === 'Aster海外仓-升级后库存' ? sourceBatch.shipping_method : '') {
    const version = String(newVersion ?? "").trim();
    if (!version) throw new BusinessError(400, "missing_new_version", "请填写升级完成版本号");
    const packPerBox = sourceBatch.pack_per_box == null || String(sourceBatch.pack_per_box).trim() === ""
      ? null : String(sourceBatch.pack_per_box).trim();
    const sourceTeam = String(sourceBatch.source_team ?? sourceBatch.team ?? "");
    const baseKey = batchKey(sourceBatch.model, sourceBatch.plan, sourceBatch.ship_date, version);
    let target = this.db.prepare(`SELECT * FROM stock_batches
      WHERE model = ? AND plan = ? AND ship_date = ? AND version = ? AND fnsku = ? AND warehouse = ? AND source_team = ? AND shipping_method=?`)
      .get(sourceBatch.model, sourceBatch.plan, sourceBatch.ship_date, version, sourceBatch.fnsku, warehouse, sourceTeam, shippingMethod);
    if (target && String(target.pack_per_box ?? "") !== String(packPerBox ?? "")) {
      throw new BusinessError(409, "pack_per_box_conflict", `目标在库批次 ${target.batch_key} 的套/箱与本次来源不一致，未合并`, {
        batchKey: target.batch_key, existing: target.pack_per_box ?? null, source: packPerBox,
      });
    }
    if (!target) {
      const key = this.db.prepare("SELECT 1 FROM stock_batches WHERE batch_key = ?").get(baseKey)
        ? `${baseKey}#SOURCE:${sha256(stableJson([sourceBatch.fnsku, warehouse, sourceTeam, shippingMethod]))}` : baseKey;
      this.db.prepare(`
        INSERT INTO stock_batches(
          batch_key, model, plan, ship_date, version, fnsku, base_quantity,
          updated_at, revision, created_by_import_id, created_by_transit_id, is_legacy_placeholder, warehouse, pack_per_box, source_team, shipping_method
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, NULL, NULL, 0, ?, ?, ?, ?)
      `).run(key, sourceBatch.model, sourceBatch.plan, sourceBatch.ship_date, version, sourceBatch.fnsku, at, warehouse, packPerBox, sourceTeam, shippingMethod);
      target = this.db.prepare("SELECT * FROM stock_batches WHERE batch_key = ?").get(key);
    }
    return target;
  }

  completionVersions(sourceType, sourceId) {
    return this.db.prepare(`SELECT b.version, b.warehouse, SUM(l.on_hand_delta) AS quantity
      FROM upgrade_inventory_ledger l JOIN stock_batches b ON b.batch_key=l.batch_key
      WHERE l.source_type=? AND l.source_id=?
      GROUP BY b.version,b.warehouse HAVING SUM(l.on_hand_delta)>0 ORDER BY b.version,b.warehouse`).all(sourceType, sourceId);
  }

  upgradeRecord(idOrRow) {
    const id = typeof idOrRow === "object" && idOrRow ? Number(idOrRow.id) : Number(idOrRow);
    const row = this.db.prepare(`
      SELECT j.*, m.category,
             d.document_no, d.plan, d.ship_date, d.fnsku, d.asin, d.quantity AS allocation_quantity,
             d.department, d.store_name, d.confirmed_at
      FROM upgrade_jobs j
      JOIN catalog_models m ON m.model = j.model
      LEFT JOIN relocation_sources d ON d.allocation_document_id = j.allocation_document_id OR d.inquiry_id = j.inquiry_id OR d.fba_archive_id = j.fba_archive_id
      WHERE j.id = ?
    `).get(id);
    if (!row) return null;
    if (row.kind !== 'direct') {
      const firstWork=this.db.prepare('SELECT * FROM upgrade_relocation_work_items WHERE upgrade_id=? ORDER BY id LIMIT 1').get(id);
      if(firstWork) {
        const source=this.flowSource(firstWork);
        Object.assign(row,{document_no:source.document_no,plan:source.plan,ship_date:source.ship_date,fnsku:source.fnsku,
          asin:source.asin,allocation_quantity:source.quantity,department:source.department,store_name:source.store_name,confirmed_at:source.confirmed_at});
      }
    }
    if (row.kind === "direct") {
      const cancelled = row.cancelled_at != null;
      const lines = this.db.prepare(`
        SELECT l.*, b.plan, b.ship_date, b.version, b.fnsku, b.warehouse, b.source_team
        FROM upgrade_stock_lines l
        JOIN stock_batches b ON b.batch_key = l.source_batch_key
        WHERE l.upgrade_id = ?
        ORDER BY b.ship_date, l.id
      `).all(id).map((line) => ({
        id: Number(line.id),
        sourceBatchKey: line.source_batch_key, warehouse: line.warehouse, sourceTeam: line.source_team || null,
        completions: this.completionVersions("direct_line", Number(line.id)),
        plan: line.plan,
        shipDate: line.ship_date,
        sourceVersion: line.version,
        fnsku: line.fnsku,
        initialQuantity: Number(line.initial_quantity),
        completedQuantity: Number(line.completed_quantity),
        inProgressQuantity: cancelled ? 0 : Number(line.remaining_quantity),
        revision: Number(line.revision),
        updatedAt: line.updated_at,
      }));
      const initialQuantity = lines.reduce((sum, line) => sum + line.initialQuantity, 0);
      const completedQuantity = lines.reduce((sum, line) => sum + line.completedQuantity, 0);
      const inProgressQuantity = lines.reduce((sum, line) => sum + line.inProgressQuantity, 0);
      return {
        id,
        upgradeNo: row.upgrade_no,
        kind: "direct",
        model: row.model,
        category: row.category,
        sourceVersion: row.source_version,
        newVersion: row.new_version,
        status: cancelled ? "cancelled" : row.status,
        statusText: cancelled ? "已撤销发起" : row.status === "completed" ? "升级完成" : "升级中，预锁定",
        initiatedByRole: row.initiated_by_role,
        initiatedAt: row.initiated_at,
        revision: Number(row.revision),
        updatedAt: row.updated_at,
        cancelledByRole: row.cancelled_by_role ?? null,
        cancelledAt: row.cancelled_at ?? null,
        cancelReason: row.cancel_reason ?? null,
        initialQuantity,
        completedQuantity,
        inProgressQuantity,
        lines,
      };
    }

    const relocations = this.db.prepare(`
      SELECT r.*, s.ship_date AS shipment_date,w.source_snapshot_json,w.in_progress_quantity FROM upgrade_relocations r
      LEFT JOIN inquiry_shipments s ON s.id = r.inquiry_shipment_id
      LEFT JOIN upgrade_relocation_work_items w ON w.relocation_id=r.id
      WHERE r.upgrade_id = ? ORDER BY r.sequence, r.id
    `).all(id).map((item) => ({
      id: Number(item.id),
      relocationNo: item.relocation_no,
      workId: this.db.prepare('SELECT id FROM upgrade_relocation_work_items WHERE relocation_id=? ORDER BY id DESC LIMIT 1').get(item.id)?.id ?? null,
      completions: this.completionVersions("relocation", Number(item.id)),
      sequence: Number(item.sequence),
      sourceQuantityBefore: Number(item.source_quantity_before),
      soldQuantity: Number(item.sold_quantity),
      inquiryShipmentId: item.inquiry_shipment_id == null ? null : Number(item.inquiry_shipment_id),
      source: JSON.parse(item.source_snapshot_json),
      shipDate: JSON.parse(item.source_snapshot_json).ship_date,
      fbaRemainingQuantity: Number(item.fba_remaining_quantity),
      shippedQuantity: Number(item.shipped_quantity),
      completedQuantity: Number(item.completed_quantity),
      inProgressQuantity: Number(item.in_progress_quantity),
      rma: item.rma,
      relocationAddress: item.relocation_address,
      removalOrderNo: item.removal_order_no,
      carrier: item.carrier,
      trackingNo: item.tracking_no,
      externalSyncStatus: item.external_sync_status,
      status: item.status,
      statusText: item.status === "withdrawn" ? "已撤回" : "有效",
      newVersion: item.new_version,
      createdByRole: item.created_by_role,
      createdAt: item.created_at,
      revision: Number(item.revision),
      updatedAt: item.updated_at,
      withdrawnByRole: item.withdrawn_by_role ?? null,
      withdrawnAt: item.withdrawn_at ?? null,
      withdrawReason: item.withdraw_reason ?? null,
      externalItems: this.relocationExternalItems(Number(item.id)),
      externalShipments: this.relocationExternalShipments(item.removal_order_no, JSON.parse(item.source_snapshot_json).fnsku),
    }));
    const activeRelocations = relocations.filter((item) => item.status === "active");
    const completedQuantity = activeRelocations.reduce((sum, item) => sum + item.completedQuantity, 0);
    const shippedQuantity = activeRelocations.reduce((sum, item) => sum + item.shippedQuantity, 0);
    const soldQuantity = activeRelocations.reduce((sum, item) => sum + item.soldQuantity, 0);
    return {
      id,
      upgradeNo: row.upgrade_no,
      kind: "relocation",
      allocationId: row.allocation_document_id == null ? null : Number(row.allocation_document_id),
      inquiryId: row.inquiry_id == null ? null : Number(row.inquiry_id),
      fbaArchiveId: row.fba_archive_id == null ? null : Number(row.fba_archive_id),
      sourceKind: row.fba_archive_id != null ? "fba" : row.inquiry_id == null ? "allocation" : "inquiry",
      documentNo: row.document_no,
      model: row.model,
      category: row.category,
      asin: row.asin ?? null,
      plan: row.plan,
      shipDate: row.ship_date,
      sourceVersion: row.source_version,
      fnsku: row.fnsku,
      department: row.department,
      store: row.store_name,
      confirmedAt: row.confirmed_at,
      newVersion: row.new_version,
      status: row.status,
      statusText: row.status === "completed" ? "升级完成" : "升级中",
      initiatedByRole: row.initiated_by_role,
      initiatedAt: row.initiated_at,
      revision: Number(row.revision),
      updatedAt: row.updated_at,
      initialQuantity: Number(row.allocation_quantity),
      fbaRemainingQuantity: Number(row.allocation_quantity) - shippedQuantity - soldQuantity,
      soldQuantity,
      shippedQuantity,
      completedQuantity,
      inProgressQuantity: activeRelocations.reduce((sum,item)=>sum+item.inProgressQuantity,0),
      relocations,
    };
  }

  getUpgrade(id) {
    return this.upgradeRecord(id);
  }

  getUpgradeRelocation(id) {
    const row = this.db.prepare("SELECT * FROM upgrade_relocations WHERE id = ?").get(Number(id));
    return row ? { ...row, id: Number(row.id), allocation_document_id: row.allocation_document_id == null ? null : Number(row.allocation_document_id), inquiry_id: row.inquiry_id == null ? null : Number(row.inquiry_id) } : null;
  }

  relocationExternalItems(relocationId) {
    return this.db.prepare("SELECT line_id,SUM(quantity) AS quantity,snapshot_json,MAX(id) AS id FROM upgrade_relocation_external_items WHERE relocation_id = ? GROUP BY line_id HAVING SUM(quantity)>0 ORDER BY id").all(relocationId)
      .map((row) => ({ lineId: Number(row.line_id), quantity: Number(row.quantity), snapshot: JSON.parse(row.snapshot_json) }));
  }

  relocationExternalShipments(orderNo, fnsku) {
    return this.db.prepare(`SELECT s.*, COALESCE((SELECT SUM(i.quantity) FROM upgrade_relocation_external_items i
      JOIN upgrade_relocations r ON r.id = i.relocation_id WHERE i.line_id = s.id AND r.status = 'active'), 0) AS used_quantity
      FROM lingxing_removal_shipments s WHERE s.order_no = ? AND s.fnsku = ? ORDER BY s.store_id, s.ship_date, s.id`)
      .all(orderNo, fnsku).map((row) => ({
        lineId: Number(row.id), externalId: row.external_id, storeId: row.store_id, storeName: row.store_name,
        countryCode: row.country_code, orderNo: row.order_no, fnsku: row.fnsku, quantity: Number(row.quantity),
        usedQuantity: Number(row.used_quantity), availableQuantity: Number(row.quantity) - Number(row.used_quantity),
        carrier: row.carrier, trackingNo: row.tracking_no, shipDate: row.ship_date, capturedAt: row.captured_at,
      }));
  }

  syncRelocationLogistics({ id, role, shipments, capturedAt, requestId, onSaved }) {
    this.requireUpgradeRole(role);
    const workId = Number(id);
    if (!Number.isInteger(workId) || workId <= 0) throw new BusinessError(400, "invalid_relocation_work", "请选择有效移仓流程");
    if (!Array.isArray(shipments)) throw new BusinessError(400, "invalid_logistics_shipments", "领星物流返回格式不正确，请重新同步");
    const time = new Date(capturedAt);
    if (!capturedAt || !Number.isFinite(time.getTime())) throw new BusinessError(400, "invalid_captured_at", "领星物流缺少有效取数时间，请重新同步");
    const capture = time.toISOString();
    const rows = shipments.map((item) => {
      const row = {};
      for (const field of ["externalId", "storeId", "storeName", "countryCode", "orderNo", "fnsku", "carrier", "trackingNo", "shipDate"]) {
        row[field] = String(item?.[field] ?? "").trim();
      }
      if (!["externalId", "storeId", "orderNo", "fnsku"].every((field) => row[field])) throw new BusinessError(400, "missing_external_shipment_identity", "领星包裹缺少商品记录编号、店铺编号、移除订单号或 FNSKU，请在部署电脑核对报表");
      if (typeof item?.quantity !== "number" || !Number.isInteger(item.quantity) || item.quantity < 0) throw new BusinessError(400, "invalid_external_shipment_quantity", "领星包裹数量请填写 0 或正整数");
      row.quantity = item.quantity;
      return row;
    });
    if (new Set(rows.map((row) => JSON.stringify([row.storeId, row.externalId]))).size !== rows.length) throw new BusinessError(400, "duplicate_external_shipment", "同次物流同步中包裹商品行不能重复");
    return this.idempotent(`upgrade:relocation:logistics-sync:${workId}`, requestId, { id: workId, role, shipments: rows, capturedAt: capture }, () => {
      const work = this.db.prepare("SELECT * FROM upgrade_relocation_work_items WHERE id = ?").get(workId);
      if (!work) throw new BusinessError(404, "relocation_work_not_found", `找不到移仓流程 ${workId}`);
      if (["cancelled","withdrawn"].includes(work.status)) throw new BusinessError(409, "relocation_cancelled", "本次移仓已取消或撤销，未保存新的物流数据");
      const source = this.flowSource(work);
      if (!work.removal_order_no || !source) throw new BusinessError(409, "missing_removal_order", "请先由运营填写移除订单号，再同步物流");
      const at = new Date().toISOString();
      const upsert = this.db.prepare(`INSERT INTO lingxing_removal_shipments(external_id, store_id, store_name, country_code,
        order_no, fnsku, quantity, carrier, tracking_no, ship_date, captured_at, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(store_id, external_id) DO UPDATE SET store_name = excluded.store_name, country_code = excluded.country_code,
          quantity = excluded.quantity, carrier = excluded.carrier, tracking_no = excluded.tracking_no,
          ship_date = excluded.ship_date, captured_at = excluded.captured_at, synced_at = excluded.synced_at`);
      for (const row of rows) {
        if (row.orderNo !== work.removal_order_no || row.fnsku !== source.fnsku) throw new BusinessError(409, "external_shipment_source_mismatch", "领星物流订单号或FNSKU与当前移仓来源不一致");
        const previous = this.db.prepare(`SELECT s.*, COALESCE((SELECT SUM(i.quantity) FROM upgrade_relocation_external_items i
          JOIN upgrade_relocations r ON r.id = i.relocation_id WHERE i.line_id = s.id AND r.status = 'active'), 0) AS used_quantity
          FROM lingxing_removal_shipments s WHERE s.store_id = ? AND s.external_id = ?`).get(row.storeId, row.externalId);
        if (previous) {
          if (previous.order_no !== row.orderNo || previous.fnsku !== row.fnsku) throw new BusinessError(409, "external_shipment_identity_changed", "同一领星包裹商品行不能改换订单号或FNSKU");
          if (previous.captured_at > capture) throw new BusinessError(409, "logistics_stale_capture", "已有更新的领星物流抓取结果");
          if (row.quantity < Number(previous.used_quantity)) throw new BusinessError(409, "external_shipment_below_used", `该领星包裹已采纳 ${previous.used_quantity} 件，不能更新为更少数量；请核对领星包裹记录`);
        }
        upsert.run(row.externalId, row.storeId, row.storeName, row.countryCode, row.orderNo, row.fnsku, row.quantity,
          row.carrier, row.trackingNo, row.shipDate, capture, at);
      }
      if (rows.length > 0) this.db.prepare(`UPDATE upgrade_relocation_work_items SET external_sync_status = 'synced',
        revision = revision + CASE WHEN external_sync_status = 'synced' THEN 0 ELSE 1 END,
        updated_at = CASE WHEN external_sync_status = 'synced' THEN updated_at ELSE ? END WHERE id = ?`).run(at, workId);
      if(rows.length>0&&work.relocation_id)this.db.prepare("UPDATE upgrade_relocations SET external_sync_status='synced',revision=revision+CASE WHEN external_sync_status='synced' THEN 0 ELSE 1 END,updated_at=CASE WHEN external_sync_status='synced' THEN updated_at ELSE ? END WHERE id=? AND status='active'").run(at,work.relocation_id);
      let application;
      this.db.exec('SAVEPOINT apply_logistics');
      try {
        application=this.applyCapturedShipments(workId,rows,role,at,requestId);
        this.db.exec('RELEASE apply_logistics');
      } catch(error) {
        this.db.exec('ROLLBACK TO apply_logistics; RELEASE apply_logistics');
        if(!(error instanceof BusinessError)) throw error;
        application={businessApplied:false,businessMessage:error.message,businessCode:error.code};
      }
      const result = { ok: true, updated: rows.length, capturedAt: capture, cacheSaved:true, ...application, workItem: this.relocationWorkRecord(workId) };
      onSaved?.(result);
      return result;
    });
  }

  relocationWorkRecord(idOrRow) {
    const id = typeof idOrRow === "object" && idOrRow ? Number(idOrRow.id) : Number(idOrRow);
    const row = this.db.prepare(`SELECT w.*,j.upgrade_no,r.relocation_no FROM upgrade_relocation_work_items w
      LEFT JOIN upgrade_jobs j ON j.id=w.upgrade_id LEFT JOIN upgrade_relocations r ON r.id=w.relocation_id WHERE w.id=?`).get(id);
    if (!row) return null;
    const source=this.flowSource(row);
    Object.assign(row,{document_no:source.document_no,model:source.model,source_version:source.version,plan:source.plan,
      ship_date:source.ship_date,fnsku:source.fnsku,asin:source.asin,department:source.department,store_name:source.store_name,
      confirmed_at:source.confirmed_at,category:this.getModel(source.model)?.category});
    const statusText = {
      awaiting_procurement: "待物流填写RMA和移仓地址",
      awaiting_operation: "待运营填写订单号",
      awaiting_shipping: "移仓和升级中",
      shipped: "移仓和升级中",
      withdrawn: "发货登记已撤回",
      cancelled: "已取消",
    }[row.status] ?? row.status;
    return {
      id,
      workNo: row.work_no,
      allocationId: row.allocation_document_id == null ? null : Number(row.allocation_document_id),
      inquiryId: row.inquiry_id == null ? null : Number(row.inquiry_id),
      fbaArchiveId: row.fba_archive_id == null ? null : Number(row.fba_archive_id),
      sourceKind: row.fba_archive_id != null ? "fba" : row.inquiry_id == null ? "allocation" : "inquiry",
      documentNo: row.document_no,
      upgradeId: row.upgrade_id == null ? null : Number(row.upgrade_id),
      upgradeNo: row.upgrade_no ?? null,
      relocationId: row.relocation_id == null ? null : Number(row.relocation_id),
      relocationNo: row.relocation_no ?? null,
      model: row.model,
      category: row.category,
      asin: row.asin ?? null,
      sourceVersion: row.source_version,
      plan: row.plan,
      shipDate: row.ship_date,
      fnsku: row.fnsku,
      department: row.department,
      store: row.store_name,
      confirmedAt: row.confirmed_at,
      sourceQuantityBefore: Number(row.source_quantity_before),
      inquiryShipmentId: row.inquiry_shipment_id == null ? null : Number(row.inquiry_shipment_id),
      soldQuantity: Number(row.sold_quantity),
      status: row.status,
      statusText,
      initiatedByRole: row.initiated_by_role,
      initiatedAt: row.initiated_at,
      rma: row.rma ?? null,
      relocationAddress: row.relocation_address ?? null,
      procurementByRole: row.procurement_by_role ?? null,
      procurementAt: row.procurement_at ?? null,
      removalOrderNo: row.removal_order_no ?? null,
      operationByRole: row.operation_by_role ?? null,
      operationAt: row.operation_at ?? null,
      fbaRemainingQuantity: row.fba_remaining_quantity == null ? null : Number(row.fba_remaining_quantity),
      shippedQuantity: row.shipped_quantity == null ? null : Number(row.shipped_quantity),
      carrier: row.carrier ?? null,
      trackingNo: row.tracking_no ?? null,
      externalSyncStatus: row.external_sync_status,
      externalShipments: this.relocationExternalShipments(row.removal_order_no ?? "", row.fnsku),
      externalItems: row.relocation_id == null ? [] : this.relocationExternalItems(Number(row.relocation_id)),
      shippingByRole: row.shipping_by_role ?? null,
      shippingAt: row.shipping_at ?? null,
      cancelledByRole: row.cancelled_by_role ?? null,
      cancelledAt: row.cancelled_at ?? null,
      revision: Number(row.revision),
      updatedAt: row.updated_at,
    };
  }

  getRelocationWorkItem(id) {
    return this.relocationWorkRecord(id);
  }

  getRelocationWorkItems({ visibleGroup = null } = {}) {
    const group = String(visibleGroup ?? "").trim();
    return this.db.prepare(`
      SELECT id FROM upgrade_relocation_work_items
      WHERE status IN ('awaiting_procurement', 'awaiting_operation', 'awaiting_shipping')
      ORDER BY updated_at, id
    `).all().map((row) => this.relocationWorkRecord(row.id)).filter((row) => (
      row && !(group && row.department !== group)
    ));
  }

  directSourceBatches({ model = null, sourceVersion = null, visibleGroup = null } = {}) {
    const teams = visibleGroup ? this.stockBatchSourceTeams() : null;
    return this.db.prepare(`SELECT b.*,m.category,EXISTS(SELECT 1 FROM upgrade_stock_lines l WHERE l.source_batch_key=b.batch_key AND l.reservation_active=1) AS upgrade_reserved
      FROM stock_batches b JOIN catalog_models m ON m.model=b.model WHERE b.is_legacy_placeholder=0
      AND (? IS NULL OR b.model=?) AND (? IS NULL OR b.version=?) ORDER BY b.model,b.version,b.ship_date,b.batch_key`)
      .all(model,model,sourceVersion,sourceVersion)
      .filter(b=>!teams || (teams.get(b.batch_key)?.size===1 && teams.get(b.batch_key)?.has(visibleGroup)));
  }

  getDirectUpgradeSources({ visibleGroup = null } = {}) {
    const batches = this.directSourceBatches({ visibleGroup });
    const grouped = new Map();
    for (const batch of batches) {
      const balance = this.getBalance(batch.batch_key);
      const allocationLocked = Number(this.db.prepare(`
        SELECT COALESCE(SUM(locked_delta), 0) AS quantity FROM inventory_ledger WHERE batch_key = ?
      `).get(batch.batch_key).quantity);
      const upgradeLocked = Number(this.db.prepare(`
        SELECT COALESCE(SUM(locked_delta), 0) AS quantity FROM upgrade_inventory_ledger WHERE batch_key = ?
      `).get(batch.batch_key).quantity);
      if (balance.onHand === 0 && allocationLocked === 0 && upgradeLocked === 0) continue;
      const groupKey = `${batch.model}\u0000${batch.version}`;
      const current = grouped.get(groupKey) ?? {
        model: batch.model,
        category: batch.category,
        sourceVersion: batch.version,
        inStock: 0,
        allocationLocked: 0,
        upgradeLocked: 0,
        available: 0,
        batchCount: 0,
      };
      current.inStock += balance.onHand;
      current.allocationLocked += allocationLocked;
      current.upgradeLocked += upgradeLocked;
      current.available += batch.upgrade_reserved ? 0 : balance.available;
      current.batchCount += 1;
      grouped.set(groupKey, current);
    }
    return [...grouped.values()].sort((left, right) => left.model.localeCompare(right.model, "zh-CN") || left.sourceVersion.localeCompare(right.sourceVersion, "zh-CN"));
  }

  getRelocationCandidates({ model = "", sourceVersion = "", visibleGroup = null } = {}) {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const modelName = String(model ?? "").trim();
    const version = String(sourceVersion ?? "").trim();
    const rows = this.db.prepare(`
      SELECT d.*, m.category, j.id AS upgrade_id, j.upgrade_no, j.status AS upgrade_status
      FROM relocation_sources d
      JOIN catalog_models m ON m.model = d.model
      LEFT JOIN upgrade_jobs j ON (j.allocation_document_id = d.allocation_document_id OR j.inquiry_id = d.inquiry_id OR j.fba_archive_id = d.fba_archive_id) AND j.kind = 'relocation'
      WHERE d.status IN ('confirmed', 'archived') AND (d.source_kind IN ('fba', 'inquiry') OR d.confirmed_at >= ?)
        AND (? = '' OR d.model = ?)
        AND (? = '' OR d.version = ?)
      ORDER BY d.confirmed_at DESC, d.document_no DESC
    `).all(cutoff, modelName, modelName, version, version);
    const group = String(visibleGroup ?? "").trim();
    const result = [];
    for (const row of rows) {
      if (group && row.department !== group) continue;
      const fbaRemainingQuantity = this.relocationSourceQuantity(row.allocation_document_id, row.inquiry_id, null, row.fba_archive_id);
      if (fbaRemainingQuantity <= 0) continue;
      const totals = row.upgrade_id == null ? { shipped: 0, completed: 0, sold: 0 } : this.db.prepare(`
        SELECT COALESCE(SUM(shipped_quantity), 0) AS shipped,
               COALESCE(SUM(completed_quantity), 0) AS completed, COALESCE(SUM(sold_quantity), 0) AS sold
        FROM upgrade_relocations WHERE upgrade_id = ? AND status = 'active'
      `).get(Number(row.upgrade_id));
      result.push({
        allocationId: row.allocation_document_id == null ? null : Number(row.allocation_document_id),
        inquiryId: row.inquiry_id == null ? null : Number(row.inquiry_id),
      fbaArchiveId: row.fba_archive_id == null ? null : Number(row.fba_archive_id),
        sourceKind: row.source_kind,
        documentNo: row.document_no,
        model: row.model,
        category: row.category,
        asin: row.asin,
        plan: row.plan,
        shipDate: row.ship_date,
        sourceVersion: row.version,
        fnsku: row.fnsku,
        initialQuantity: Number(row.quantity),
        fbaRemainingQuantity,
        soldQuantity: Number(totals.sold),
        shippedQuantity: Number(totals.shipped),
        completedQuantity: Number(totals.completed),
        inProgressQuantity: Number(totals.shipped) - Number(totals.completed),
        department: row.department,
        store: row.store_name,
        confirmedAt: row.confirmed_at,
        upgradeId: row.upgrade_id == null ? null : Number(row.upgrade_id),
        upgradeNo: row.upgrade_no ?? null,
      });
    }
    return result;
  }

  getUpgrades({ visibleGroup = null, scopeDirectByTeam = false } = {}) {
    const group = String(visibleGroup ?? "").trim();
    const teamsByBatch = scopeDirectByTeam && group ? this.stockBatchSourceTeams() : null;
    return this.db.prepare("SELECT id FROM upgrade_jobs WHERE kind <> 'transfer' ORDER BY updated_at DESC, id DESC").all()
      .map((row) => this.upgradeRecord(Number(row.id)))
      .map(row => {
        if (!row || row.kind !== "direct" || !teamsByBatch) return row;
        const lines = row.lines.filter(line => teamsByBatch.get(line.sourceBatchKey)?.size === 1 && teamsByBatch.get(line.sourceBatchKey)?.has(group));
        if (!lines.length) return null;
        const initialQuantity = lines.reduce((sum, line) => sum + line.initialQuantity, 0);
        const completedQuantity = lines.reduce((sum, line) => sum + line.completedQuantity, 0);
        const inProgressQuantity = lines.reduce((sum, line) => sum + line.inProgressQuantity, 0);
        const lineIds = lines.map(line => line.id);
        const latestCompletion = lineIds.length ? this.db.prepare(`SELECT o.new_version FROM upgrade_operations o
          JOIN upgrade_inventory_ledger l ON l.operation_id = o.id AND l.source_type = 'direct_line'
          WHERE o.upgrade_id = ? AND o.operation_type = 'direct_complete' AND l.source_id IN (${lineIds.map(() => "?").join(",")})
          ORDER BY o.id DESC LIMIT 1`).get(row.id, ...lineIds) : null;
        const cancelled = row.status === "cancelled";
        return {
          ...row, lines, initialQuantity, completedQuantity, inProgressQuantity,
          status: cancelled ? "cancelled" : inProgressQuantity === 0 ? "completed" : "active",
          statusText: cancelled ? row.statusText : inProgressQuantity === 0 ? "升级完成" : "升级中，预锁定",
          newVersion: latestCompletion?.new_version ?? null,
        };
      })
      .filter((row) => row && !(group && row.kind === "relocation" && row.department !== group));
  }

  getUpgradeDashboard({ visibleGroup = null, scopeDirectByTeam = false } = {}) {
    return {
      overseasWarehouses: [...OVERSEAS_WAREHOUSES],
      directSources: this.getDirectUpgradeSources({ visibleGroup, scopeDirectByTeam }),
      relocationCandidates: this.getRelocationCandidates({ visibleGroup }),
      relocationWorkItems: this.getRelocationWorkItems({ visibleGroup }),
      upgrades: this.getUpgrades({ visibleGroup, scopeDirectByTeam }),
      sync: this.syncState(),
    };
  }

  createDirectUpgrade({ role, model, sourceVersion, requestId }) {
    if(role==='logistics') throw new BusinessError(403,'upgrade_role_forbidden','物流办理移仓与转仓升级，在库升级仍由原岗位办理');
    const modelName = String(model ?? "").trim();
    const version = String(sourceVersion ?? "").trim();
    this.requireUpgradeRole(role);
    if (!modelName) throw new BusinessError(400, "missing_model", "请填写型号");
    if (!version) throw new BusinessError(400, "missing_source_version", "请填写原版本号");
    return this.idempotent("upgrade:direct:create", requestId, { role, model: modelName, sourceVersion: version }, () => {
      const catalog = this.getModel(modelName);
      if (!catalog) throw new BusinessError(404, "unknown_model", `未知型号“${modelName}”`);
      const candidates = this.directSourceBatches({model: modelName, sourceVersion: version, visibleGroup: OPERATION_GROUPS[role] ?? null});
      const sourceRows = candidates.filter(batch=>!batch.upgrade_reserved)
        .map(batch=>({batch,available:this.getBalance(batch.batch_key).available})).filter(item=>item.available>0);
      const total = sourceRows.reduce((sum,item)=>sum+item.available,0);
      if (total<=0) {
        if (candidates.some(batch=>batch.upgrade_reserved)) throw new BusinessError(409,"upgrade_already_active","本团可办理来源已有进行中的在库升级，请先登记完成数量");
        throw new BusinessError(409,"no_upgrade_available","该型号和原版本没有可锁定的可用库存；调拨预锁定数量已排除");
      }
      const at = new Date().toISOString();
      const inserted = this.db.prepare(`
        INSERT INTO upgrade_jobs(
          upgrade_no, kind, allocation_document_id, model, source_version, new_version,
          status, initiated_by_role, initiated_at, revision, updated_at
        ) VALUES (?, 'direct', NULL, ?, ?, NULL, 'active', ?, ?, 1, ?)
      `).run(`PENDING-${crypto.randomUUID()}`, modelName, version, role, at, at);
      const upgradeId = Number(inserted.lastInsertRowid);
      const no = upgradeNumber(upgradeId);
      this.db.prepare("UPDATE upgrade_jobs SET upgrade_no = ? WHERE id = ?").run(no, upgradeId);
      const reservedLines = [];
      for (const item of sourceRows) {
        const lineResult = this.db.prepare(`
          INSERT INTO upgrade_stock_lines(
            upgrade_id, source_batch_key, initial_quantity, completed_quantity,
            remaining_quantity, revision, updated_at
          ) VALUES (?, ?, ?, 0, ?, 1, ?)
        `).run(upgradeId, item.batch.batch_key, item.available, item.available, at);
        const lineId = Number(lineResult.lastInsertRowid);
        reservedLines.push({ lineId, batchKey: item.batch.batch_key, quantity: item.available });
      }
      const eventId = this.addEvent(null, "upgrade_direct_start", role, at, null, {
        upgradeId, upgradeNo: no, model: modelName, category: catalog.category,
        sourceVersion: version, quantity: total, onHandDelta: 0, lockedDelta: total, requestId,
      });
      const operationId = this.addUpgradeOperation({
        upgradeId, type: "direct_start", quantity: total, eventId, requestId, role, at,
        metadata: { model: modelName, sourceVersion: version },
      });
      for (const item of reservedLines) {
        this.addUpgradeLedger(
          upgradeId, "direct_line", item.lineId, item.batchKey, "direct_reserve",
          0, item.quantity, role, at, requestId,
          { model: modelName, sourceVersion: version }, operationId,
        );
      }
      return { ok: true, upgrade: this.upgradeRecord(upgradeId) };
    });
  }

  completeDirectUpgrade({ id, role, sourceLineId, completedQuantity, newVersion, targetWarehouse, expectedRevision, requestId }) {
    const quantity = Number(completedQuantity);
    const targetVersion = String(newVersion ?? "").trim();
    if (!OVERSEAS_WAREHOUSES.includes(targetWarehouse)) throw new BusinessError(422, "invalid_target_warehouse", "请选择本次完成入库的目标海外仓");
    this.requirePurchasingUpgradeRole(role);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BusinessError(400, "invalid_quantity", "升级完成数量请填写大于 0 的整数");
    if (!targetVersion) throw new BusinessError(400, "missing_new_version", "请填写升级完成版本号");
    return this.idempotent(`upgrade:direct:complete:${id}`, requestId, {
      id: Number(id), role, sourceLineId: sourceLineId ?? null, completedQuantity: quantity, newVersion: targetVersion, targetWarehouse, expectedRevision,
    }, () => {
      const job = this.db.prepare("SELECT * FROM upgrade_jobs WHERE id = ? AND kind = 'direct'").get(Number(id));
      if (!job) throw new BusinessError(404, "upgrade_not_found", `找不到在库升级单 ${id}`);
      if (!Number.isInteger(Number(expectedRevision))) throw new BusinessError(400, "missing_revision", "当前记录信息不完整，请重新加载后操作");
      if (Number(job.revision) !== Number(expectedRevision)) throw new BusinessError(409, "upgrade_stale_revision", "升级记录已被其他操作更新，请刷新后重试");
      if (job.cancelled_at) throw new BusinessError(409, "upgrade_cancelled", "该在库升级发起已撤销");
      if (job.status !== "active") throw new BusinessError(409, "upgrade_completed", "该在库升级已全部完成");
      if (targetVersion === job.source_version) throw new BusinessError(422, "unchanged_upgrade_version", "升级完成版本号必须与原版本不同");
      const remainingTotal = Number(this.db.prepare(`
        SELECT COALESCE(SUM(remaining_quantity), 0) AS quantity FROM upgrade_stock_lines WHERE upgrade_id = ?
      `).get(Number(id)).quantity);
      if (quantity > remainingTotal) throw new BusinessError(409, "upgrade_quantity_exceeded", `升级完成数量超出升级中数量（当前 ${remainingTotal}）`);
      let lines = this.db.prepare(`
        SELECT l.*, b.*
        FROM upgrade_stock_lines l JOIN stock_batches b ON b.batch_key = l.source_batch_key
        WHERE l.upgrade_id = ? AND l.remaining_quantity > 0
        ORDER BY b.ship_date, l.id
      `).all(Number(id));
      if (sourceLineId != null) lines = lines.filter(line => Number(line.id) === Number(sourceLineId));
      if (lines.length !== 1) throw new BusinessError(400, "select_upgrade_batch", "请选择本次实际完成的来源批次");
      if (quantity > Number(lines[0].remaining_quantity)) throw new BusinessError(409, "upgrade_quantity_exceeded", "完成量超过所选批次的升级中数量");
      const at = new Date().toISOString();
      const catalog = this.getModel(job.model);
      const eventId = this.addEvent(null, "upgrade_direct_complete", role, at, null, {
        upgradeId: Number(id), upgradeNo: job.upgrade_no, model: job.model, category: catalog?.category,
        sourceVersion: job.source_version, newVersion: targetVersion, targetWarehouse, quantity,
        onHandDelta: 0, lockedDelta: -quantity, requestId,
      });
      const operationId = this.addUpgradeOperation({
        upgradeId: Number(id), type: "direct_complete", quantity, newVersion: targetVersion,
        eventId, requestId, role, at, metadata: { sourceVersion: job.source_version, targetWarehouse },
      });
      const line = lines[0];
      const ownLocked = Number(this.db.prepare(`
        SELECT COALESCE(SUM(locked_delta), 0) AS quantity
        FROM upgrade_inventory_ledger WHERE source_type = 'direct_line' AND source_id = ?
      `).get(Number(line.id)).quantity);
      if (ownLocked < quantity) throw new BusinessError(409, "upgrade_lock_inconsistent", "升级预锁定余额不足，已停止版本转换");
      const target = this.ensureStockBatch(line, targetVersion, at, targetWarehouse);
      this.addUpgradeLedger(
        Number(id), "direct_line", Number(line.id), line.source_batch_key, "direct_transfer_out",
        -quantity, -quantity, role, at, requestId,
        { targetBatchKey: target.batch_key, newVersion: targetVersion }, operationId,
      );
      this.addUpgradeLedger(
        Number(id), "direct_line", Number(line.id), target.batch_key, "direct_transfer_in",
        quantity, 0, role, at, requestId,
        { sourceBatchKey: line.source_batch_key, warehouse: line.warehouse, sourceVersion: job.source_version }, operationId,
      );
      const changed = this.db.prepare(`
        UPDATE upgrade_stock_lines
        SET completed_quantity = completed_quantity + ?, remaining_quantity = remaining_quantity - ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ? AND remaining_quantity >= ?
      `).run(quantity, quantity, at, Number(line.id), quantity);
      if (Number(changed.changes) !== 1) throw new BusinessError(409, "upgrade_concurrent_update", "升级批次已被其他操作更新，请刷新后重试");
      const remainingAfter = remainingTotal - quantity;
      const updated = this.db.prepare(`
        UPDATE upgrade_jobs
        SET new_version = ?, status = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'active'
      `).run(targetVersion, remainingAfter === 0 ? "completed" : "active", at, Number(id), Number(expectedRevision));
      if (Number(updated.changes) !== 1) throw new BusinessError(409, "upgrade_concurrent_update", "升级记录已被其他操作更新，请刷新后重试");
      return { ok: true, upgrade: this.upgradeRecord(Number(id)) };
    });
  }

  snapshotRelocationSource(source) {
    const batch=source.batch_key ? this.db.prepare('SELECT * FROM stock_batches WHERE batch_key=?').get(source.batch_key) : null;
    const extra=source.inquiry_id ? this.db.prepare('SELECT pack_per_box FROM inquiry_documents WHERE id=?').get(source.inquiry_id)
      : source.fba_archive_id ? this.db.prepare('SELECT pack_per_box FROM fba_archives WHERE id=?').get(source.fba_archive_id) : null;
    return {...source,pack_per_box:batch?.pack_per_box ?? extra?.pack_per_box ?? null,source_team:batch?.source_team || source.department};
  }

  applyCapturedShipments(id,rows,role,at,requestId) {
    const work=this.db.prepare('SELECT * FROM upgrade_relocation_work_items WHERE id=?').get(id);
    if(!['awaiting_shipping','shipped'].includes(work.status)) throw new BusinessError(409,'logistics_step_changed','当前流程不在移仓和升级中，缓存已保存但未更新已发');
    const source=this.flowSource(work),account=accountForStore(source.store_name);
    if(account.issue) throw new BusinessError(422,'store_mapping_missing',account.issue);
    const expected=account.stores.find(s=>lingxingStoreCode(s));
    const matches=rows.filter(r=>r.orderNo===work.removal_order_no && r.fnsku===source.fnsku && lingxingStoreCode(r.storeName)===expected);
    if(!matches.length) throw new BusinessError(422,'logistics_store_no_match',`未取得店铺 ${source.store_name}、订单 ${work.removal_order_no}、FNSKU ${source.fnsku} 的匹配包裹`);
    const all=this.relocationExternalShipments(work.removal_order_no,source.fnsku);
    const increments=[];
    for(const r of matches) {
      const line=all.find(l=>l.storeId===r.storeId && l.externalId===r.externalId);
      if(line.availableQuantity<=0) continue;
      if(!line.carrier||!line.trackingNo) throw new BusinessError(422,'external_shipment_logistics_missing','匹配包裹缺少承运商或运单号，缓存已保存但未更新已发');
      increments.push({line,quantity:line.availableQuantity});
    }
    const delta=increments.reduce((sum,r)=>sum+r.quantity,0);
    if(!delta) return {businessApplied:true,shippedDelta:0,shippedQuantity:Number(work.shipped_quantity||0),businessMessage:'匹配包裹已采纳，已发数量未重复增加'};
    const total=Number(work.shipped_quantity||0)+delta;
    const others=Number(this.db.prepare(`SELECT COALESCE(SUM(shipped_quantity+sold_quantity),0) AS n FROM upgrade_relocations
      WHERE status='active' AND (allocation_document_id=? OR inquiry_id=? OR fba_archive_id=?) AND id<>?`)
      .get(work.allocation_document_id,work.inquiry_id,work.fba_archive_id,work.relocation_id||0).n);
    if(total+Number(work.sold_quantity)+others>Number(source.quantity)) throw new BusinessError(409,'logistics_source_exceeded','匹配包裹超过启动来源扣除既有消耗后的数量，缓存已保存，请核对来源和订单');
    const relocation=this.ensureFlowRelocation(work,total,role,at,requestId);
    for(const {line,quantity} of increments) this.db.prepare('INSERT INTO upgrade_relocation_external_items(relocation_id,line_id,quantity,snapshot_json,created_at) VALUES(?,?,?,?,?)')
      .run(relocation.id,line.lineId,quantity,JSON.stringify(line),at);
    const adopted=this.relocationExternalItems(relocation.id);
    const carrier=[...new Set(adopted.map(r=>r.snapshot.carrier))].join('、'),tracking=[...new Set(adopted.map(r=>r.snapshot.trackingNo))].join('、');
    const remaining=Number(work.source_quantity_before)-total-Number(work.sold_quantity);
    if(remaining<0) throw new BusinessError(409,'logistics_source_exceeded','累计已发超过本流程启动数量，缓存已保存，请核对');
    this.db.prepare(`UPDATE upgrade_relocations SET shipped_quantity=?,fba_remaining_quantity=?,carrier=?,tracking_no=?,external_sync_status='synced',revision=revision+1,updated_at=? WHERE id=?`)
      .run(total,remaining,carrier,tracking,at,relocation.id);
    this.db.prepare(`UPDATE upgrade_relocation_work_items SET shipped_quantity=?,fba_remaining_quantity=?,carrier=?,tracking_no=?,status='shipped',
      in_progress_quantity=in_progress_quantity+?,external_sync_status='synced',shipping_by_role=?,shipping_at=?,revision=revision+1,updated_at=? WHERE id=?`)
      .run(total,remaining,carrier,tracking,delta,role,at,at,id);
    const eventId=this.addEvent(work.allocation_document_id,'upgrade_relocation_created',role,at,null,{workId:work.id,flowId:work.work_no,model:source.model,
      team:source.department,quantity:delta,shippedQuantity:total,otherReduction:Number(work.sold_quantity),requestId});
    this.addUpgradeOperation({upgradeId:relocation.upgrade_id,relocationId:relocation.id,type:'relocation_shipment',quantity:delta,eventId,requestId,role,at,
      metadata:{flowId:work.work_no,externalItems:increments.map(x=>({lineId:x.line.lineId,quantity:x.quantity}))}});
    this.refreshUpgradeJobState(relocation.upgrade_id,at);
    return {businessApplied:true,shippedDelta:delta,shippedQuantity:total,businessMessage:`已发增加 ${delta} 件，累计 ${total} 件`};
  }

  flowSource(work) { return JSON.parse(work.source_snapshot_json); }

  flowDetails(id) {
    return this.db.prepare('SELECT * FROM upgrade_completion_details WHERE work_id=? ORDER BY rowid').all(id).map(d=>({
      id:d.id,revision:Number(d.revision),quantity:Number(d.quantity),version:d.version,warehouse:d.warehouse,
      batchKey:d.batch_key,operationId:d.operation_id,
    }));
  }

  upgradeTemplateRows(ids) {
    return ids.flatMap(id=>{
      const f=this.upgradeFlow(id);
      if(!f) throw new BusinessError(404,'flow_not_found',`找不到流程 ${id}`);
      return f.details.map(d=>({flowId:f.flowId,flowRevision:f.revision,completionId:d.id,completionRevision:d.revision,
        kind:f.kind==='transfer'?'转仓升级':'移仓升级',model:f.model,plan:f.plan,date:f.date,fnsku:f.fnsku,sourceVersion:f.sourceVersion,
        store:f.store,packPerBox:f.packPerBox,rma:f.rma,rawAddress:f.rawAddress,processedAddress:f.processedAddress,
        contact:f.contact,street:f.street,orderNo:f.orderNo,status:f.statusText,sourceQuantity:f.sourceQuantity,
        countedQuantity:f.countedQuantity,progressQuantity:f.kind==='transfer'&&f.countedQuantity===null?null:f.progressQuantity,completedQuantity:d.quantity,completedVersion:d.version,warehouse:d.warehouse}));
    });
  }

  importTransferFlows({role,rows,requestId,previewToken}) {
    if(role!=='logistics') throw new BusinessError(403,'logistics_required','仅物流可导入转仓升级表格');
    if(!Array.isArray(rows)||!rows.length) throw new BusinessError(422,'empty_transfer_rows','没有转仓来源行');
    return this.idempotent('upgrade:transfer:import',requestId,{role,rows,previewToken},()=>{
      if(previewToken) this.consumeTransitPreviewToken({kind:'transfer',role,token:previewToken,rows});
      const seen=new Set(),ids=[],at=new Date().toISOString();
      for(const input of rows) {
        const key=String(input.importId||'').trim();
        if(!key || seen.has(key)) throw new BusinessError(422,'duplicate_transfer_id','首次导入ID缺失或同文件重复，请使用转仓模板');
        seen.add(key);
        const existing=this.db.prepare('SELECT * FROM upgrade_relocation_work_items WHERE transfer_key=?').get(key);
        if(existing) {
          if(stableJson(this.flowSource(existing).transferInput)!==stableJson(input)) throw new BusinessError(409,'transfer_identity_conflict','该首次导入ID已有不同内容，请从升级库存导出对应流程更新');
          ids.push(existing.id); continue;
        }
        const qty=Number(input.quantity);
        if(!Number.isSafeInteger(qty)||qty<=0) throw new BusinessError(422,'invalid_quantity','转出数量须为正整数（件）');
        const transitId=input.transitId==null||input.transitId===''?null:Number(input.transitId);
        let t=null;
        if(transitId!==null) {
          t=this.db.prepare("SELECT * FROM transit_batches WHERE id=? AND voided_at IS NULL AND status='in_transit'").get(transitId);
          if(!t) throw new BusinessError(404,'transit_not_found',`在途记录 ${transitId} 不存在或已上架`);
          if(qty>Number(t.remaining_quantity)) throw new BusinessError(409,'transfer_quantity_exceeded',`在途记录 ${transitId} 仅余 ${t.remaining_quantity} 件`);
          for(const [key,column] of Object.entries({model:'model',plan:'plan',date:'ship_date',version:'version',fnsku:'fnsku',team:'team',store:'store_name',packPerBox:'pack_per_box'})) {
            if(input[key]!=='' && input[key]!=null && t[column]!=null && t[column]!=='' && String(input[key])!==String(t[column]))
              throw new BusinessError(409,'transfer_source_mismatch',`在途记录 ${transitId} 的 ${key} 与模板不一致`);
          }
        }
        const source={model:t?.model||input.model,plan:t?.plan||input.plan,ship_date:t?.ship_date||input.date,version:t?.version||input.version,
          fnsku:t?.fnsku||input.fnsku,department:t?.team||input.team,store_name:t?.store_name||input.store||null,
          pack_per_box:t?.pack_per_box||input.packPerBox||null,quantity:qty,document_no:key,source_kind:'transfer',transferInput:input};
        source.source_team=source.department;
        if(!this.getModel(source.model)) throw new BusinessError(422,'unknown_model','请填写已存在的型号');
        if(!source.plan||!source.version||!source.fnsku||!['一团','二团'].includes(source.department)) throw new BusinessError(422,'transfer_source_missing','转仓来源缺少计划、原版本、FNSKU或团队');
        inquiryShipDate(source.ship_date);
        if(source.pack_per_box && !/^[1-9]\d*$/.test(String(source.pack_per_box))) throw new BusinessError(422,'invalid_pack_per_box','套/箱须为真实正整数，未知请留空');
        const id=Number(this.db.prepare(`INSERT INTO upgrade_relocation_work_items(work_no,kind,transfer_key,transit_id,source_quantity_before,
          source_snapshot_json,status,initiated_by_role,initiated_at,updated_at) VALUES(?,'transfer',?,?,?,?,'third_party',?,?,?)`)
          .run(`PENDING-${crypto.randomUUID()}`,key,transitId,qty,JSON.stringify(source),role,at,at).lastInsertRowid);
        const no=`TRANSFER-${String(id).padStart(8,'0')}`;
        this.db.prepare('UPDATE upgrade_relocation_work_items SET work_no=? WHERE id=?').run(no,id);
        this.db.prepare('INSERT INTO upgrade_completion_details(id,work_id,updated_at) VALUES(?,?,?)').run(`COMP-${no}-1`,id,at);
        if(t) {
          this.db.prepare('UPDATE transit_batches SET remaining_quantity=remaining_quantity-?,revision=revision+1,updated_at=? WHERE id=?').run(qty,at,transitId);
          this.refreshTransitModel(source.model,at);
          this.db.prepare("INSERT INTO transit_events(transit_id,event_type,role,occurred_at,from_status,to_status,quantity,payload_json) VALUES(?,'transfer_upgrade',?,?,'in_transit','in_transit',?,?)")
            .run(transitId,role,at,qty,JSON.stringify({flowId:no,quantity:qty,remaining:Number(t.remaining_quantity)-qty,requestId}));
        }
        this.addEvent(null,'upgrade_transfer_started',role,at,null,{flowId:no,model:source.model,team:source.department,transitId,quantity:qty,requestId});
        ids.push(id);
      }
      return {ok:true,flows:ids.map(id=>this.upgradeFlow(id))};
    });
  }

  upgradeFlow(id) {
    const w=this.db.prepare('SELECT * FROM upgrade_relocation_work_items WHERE id=?').get(Number(id));
    if(!w) return null;
    const source=this.flowSource(w), details=this.flowDetails(w.id);
    const completed=details.reduce((sum,d)=>sum+d.quantity,0);
    const statuses={awaiting_procurement:'待物流填写RMA和移仓地址',awaiting_operation:'待运营填写订单号',
      awaiting_shipping:'移仓和升级中',shipped:'移仓和升级中',third_party:'已在第三方海外仓',awaiting_count:'待确认实际清点数量',
      transferring:'转仓和升级中',withdrawn:'已撤回',cancelled:'已取消'};
    return {id:Number(w.id),flowId:w.work_no,revision:Number(w.revision),kind:w.kind,model:source.model,
      category:this.getModel(source.model)?.category,documentNo:source.document_no,department:source.department,store:source.store_name || '',
      plan:source.plan,date:source.ship_date,fnsku:source.fnsku,sourceVersion:source.version,packPerBox:source.pack_per_box || '',
      sourceQuantity:Number(w.source_quantity_before),transitId:w.transit_id,transferKey:w.transfer_key,
      countedQuantity:w.counted_quantity,countDifference:w.count_difference,progressQuantity:Number(w.in_progress_quantity),
      shippedQuantity:Number(w.shipped_quantity || 0),otherReduction:Number(w.sold_quantity),completedQuantity:completed,
      sourceRemaining:w.kind==='transfer'? (w.counted_quantity==null?null:Number(w.counted_quantity)-completed-Number(w.in_progress_quantity))
        :this.relocationSourceQuantity(w.allocation_document_id,w.inquiry_id,null,w.fba_archive_id),
      status:w.status,statusText:statuses[w.status],rma:w.rma || '',rawAddress:w.relocation_address || '',
      processedAddress:w.processed_address || '',addressIssue:w.address_issue || '',contact:w.address_contact || '',street:w.address_street || '',
      orderNo:w.removal_order_no || '',carrier:w.carrier || '',trackingNo:w.tracking_no || '',
      externalItems:w.relocation_id?this.relocationExternalItems(w.relocation_id):[],details,
      latestTask:(()=>{const task=this.db.prepare("SELECT state,message,created_at FROM lingxing_sync_jobs WHERE json_extract(target_json,'$.workId')=? ORDER BY id DESC LIMIT 1").get(w.id);
        return task?{state:task.state,message:task.message,createdAt:task.created_at}:null;})(),
      allocationId:w.allocation_document_id,inquiryId:w.inquiry_id,fbaArchiveId:w.fba_archive_id,updatedAt:w.updated_at};
  }

  getUpgradeFlows({visibleGroup=null}={}) {
    return this.db.prepare('SELECT id FROM upgrade_relocation_work_items ORDER BY updated_at DESC,id DESC').all()
      .map(w=>this.upgradeFlow(w.id)).filter(w=>!visibleGroup || w.department===visibleGroup);
  }

  addCompletionDetail({id,role,expectedRevision,requestId}) {
    if(role!=='logistics') throw new BusinessError(403,'logistics_required','仅物流可新增完成明细');
    return this.idempotent(`upgrade:detail:${id}`,requestId,{id,role,expectedRevision},()=>{
      const w=this.db.prepare('SELECT * FROM upgrade_relocation_work_items WHERE id=?').get(id);
      if(!w) throw new BusinessError(404,'flow_not_found','升级流程不存在');
      if(Number(w.revision)!==Number(expectedRevision)) throw new BusinessError(409,'upgrade_stale_revision','流程已更新，请重新导出');
      if(['withdrawn','cancelled'].includes(w.status)) throw new BusinessError(409,'flow_inactive','该流程已撤回或取消');
      const at=new Date().toISOString(), detailId=`COMP-${crypto.randomUUID()}`;
      this.db.prepare('INSERT INTO upgrade_completion_details(id,work_id,updated_at) VALUES(?,?,?)').run(detailId,id,at);
      this.db.prepare('UPDATE upgrade_relocation_work_items SET revision=revision+1,updated_at=? WHERE id=?').run(at,id);
      return {ok:true,flow:this.upgradeFlow(id),detailId};
    });
  }

  ensureFlowRelocation(work,quantity,role,at,requestId) {
    const source=this.flowSource(work);
    if(work.relocation_id) return this.getUpgradeRelocation(work.relocation_id);
    const transfer=work.kind==='transfer';
    let job=transfer?null:this.db.prepare("SELECT * FROM upgrade_jobs WHERE kind='relocation' AND (allocation_document_id=? OR inquiry_id=? OR fba_archive_id=?)")
      .get(work.allocation_document_id,work.inquiry_id,work.fba_archive_id);
    if(!job) {
      const id=Number(this.db.prepare(`INSERT INTO upgrade_jobs(upgrade_no,kind,allocation_document_id,inquiry_id,fba_archive_id,transfer_work_id,
        model,source_version,status,initiated_by_role,initiated_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'active',?,?,?)`)
        .run(`PENDING-${crypto.randomUUID()}`,work.kind,work.allocation_document_id,work.inquiry_id,work.fba_archive_id,transfer?work.id:null,
          source.model,source.version,work.initiated_by_role,work.initiated_at,at).lastInsertRowid);
      this.db.prepare('UPDATE upgrade_jobs SET upgrade_no=? WHERE id=?').run(upgradeNumber(id),id);
      job=this.db.prepare('SELECT * FROM upgrade_jobs WHERE id=?').get(id);
    }
    const seq=Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM upgrade_relocations WHERE upgrade_id=?').get(job.id).n);
    const remaining=transfer?0:Number(work.source_quantity_before)-quantity-Number(work.sold_quantity);
    const id=Number(this.db.prepare(`INSERT INTO upgrade_relocations(relocation_no,upgrade_id,allocation_document_id,inquiry_id,fba_archive_id,transfer_work_id,
      sequence,source_quantity_before,fba_remaining_quantity,shipped_quantity,sold_quantity,rma,relocation_address,removal_order_no,carrier,tracking_no,created_by_role,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`PENDING-${crypto.randomUUID()}`,job.id,work.allocation_document_id,work.inquiry_id,work.fba_archive_id,
      transfer?work.id:null,seq,work.source_quantity_before,remaining,quantity,work.sold_quantity,work.rma || '',work.processed_address || '',work.removal_order_no || '',
      work.carrier || '',work.tracking_no || '',role,at,at).lastInsertRowid);
    this.db.prepare('UPDATE upgrade_relocations SET relocation_no=? WHERE id=?').run(relocationNumber(id),id);
    this.db.prepare('UPDATE upgrade_relocation_work_items SET upgrade_id=?,relocation_id=? WHERE id=?').run(job.id,id,work.id);
    return this.getUpgradeRelocation(id);
  }

  updateUpgradeFlows({role,rows,requestId,previewToken}) {
    if(role!=='logistics') throw new BusinessError(403,'logistics_required','仅物流可导入RMA、清点和升级进度');
    if(!Array.isArray(rows)||!rows.length) throw new BusinessError(400,'empty_upgrade_rows','没有升级数据');
    return this.idempotent('upgrade:template:update',requestId,{role,rows,previewToken},()=>{
      if(previewToken) this.consumeTransitPreviewToken({kind:'upgrade',role,token:previewToken,rows});
      const ids=new Set(), groups=new Map();
      for(const input of rows) {
        if(!input.completionId || ids.has(input.completionId)) throw new BusinessError(422,'duplicate_completion_id','同文件完成明细ID缺失或重复，整份未保存');
        ids.add(input.completionId);
        const work=this.db.prepare('SELECT * FROM upgrade_relocation_work_items WHERE work_no=?').get(input.flowId);
        if(!work) throw new BusinessError(404,'flow_not_found',`找不到流程 ${input.flowId}`);
        const group=groups.get(work.id)||{work,rows:[]}; group.rows.push(input);groups.set(work.id,group);
      }
      const at=new Date().toISOString();
      for(const {work,rows:items} of groups.values()) this.applyFlowRows(work,items,role,at,requestId);
      // 同文件全部明细共同计算差额；按最终共享批次余额判断，不让 Excel 行序决定结果。
      for(const batch of this.changedBatches) {
        const balance=this.db.prepare('SELECT on_hand,locked FROM stock_balances WHERE batch_key=?').get(batch);
        if(Number(balance.on_hand)<Number(balance.locked)) throw new BusinessError(409,'completion_balance_insufficient','原批次可用余额不足，数量和版本更正整份未保存');
      }
      return {ok:true,flows:[...groups.keys()].map(id=>this.upgradeFlow(id))};
    });
  }

  applyFlowRows(work,items,role,at,requestId) {
    if(['withdrawn','cancelled'].includes(work.status)) throw new BusinessError(409,'flow_inactive','该流程已取消或撤回');
    const source=this.flowSource(work), first=items[0];
    const fields=['flowRevision','rma','rawAddress','contact','street','store','packPerBox','progressQuantity','countedQuantity'];
    for(const row of items) for(const field of fields) if(String(row[field]??'')!==String(first[field]??''))
      throw new BusinessError(422,'flow_rows_disagree',`${work.work_no} 多行的${field}不一致，整份未保存`);
    const number=(value,label)=>{ if(value==null || String(value).trim()==='' || !Number.isSafeInteger(Number(value)) || Number(value)<0)
      throw new BusinessError(422,'invalid_quantity',`${label}须填写0或正整数（件）`); return Number(value); };
    const previous=this.upgradeFlow(work.id);
    const changes=[];
    for(const row of items) {
      const d=this.db.prepare('SELECT * FROM upgrade_completion_details WHERE id=? AND work_id=?').get(row.completionId,work.id);
      if(!d) throw new BusinessError(422,'completion_not_found','完成明细ID不属于本流程；新增一批请先创建完成明细再导出');
      const quantity=number(row.completedQuantity,'升级完数量'),version=String(row.completedVersion||'').trim(),warehouse=String(row.warehouse||'').trim();
      const changed=quantity!==Number(d.quantity)||version!==d.version||warehouse!==d.warehouse;
      if(changed && Number(row.completionRevision)!==Number(d.revision)) throw new BusinessError(409,'completion_stale_revision',`${d.id} 已更新，请重新导出`);
      changes.push({d,quantity,version,warehouse,changed});
    }
    const counted=first.countedQuantity==null||first.countedQuantity===''?null:number(first.countedQuantity,'实际清点数量');
    const progress=work.kind==='transfer' && previous.countedQuantity===null && (first.progressQuantity==null||first.progressQuantity==='')
      ? (counted??0) : number(first.progressQuantity,'升级中数量');
    const rma=String(first.rma||'').trim(),raw=String(first.rawAddress||'').trim();
    const contact=String(first.contact||'').trim(),street=String(first.street||'').trim();
    const store=String(first.store||'').trim(),pack=String(first.packPerBox||'').trim();
    const flowChanged=rma!==previous.rma || raw!==previous.rawAddress || contact!==previous.contact || street!==previous.street ||
      store!==previous.store || pack!==previous.packPerBox || progress!==previous.progressQuantity || counted!==previous.countedQuantity;
    if(!flowChanged && !changes.some(c=>c.changed)) return;
    if(Number(first.flowRevision)!==Number(work.revision)) throw new BusinessError(409,'upgrade_stale_revision',`${work.work_no} 已更新，请重新导出；未覆盖现值`);
    if(store!==previous.store) {
      if(source.store_name && !accountForStore(source.store_name).issue) throw new BusinessError(409,'source_snapshot_fixed','已明确的启动店铺不能随模板改换');
      if(!store || accountForStore(store).issue) throw new BusinessError(422,'store_mapping_missing',accountForStore(store).issue || '请补实际店铺');
      source.store_name=store;
    }
    if(pack!==previous.packPerBox) {
      if(source.pack_per_box) throw new BusinessError(409,'source_snapshot_fixed','已明确的启动套/箱不能改换');
      if(!/^[1-9]\d*$/.test(pack)) throw new BusinessError(422,'invalid_pack_per_box','请补真实正整数套/箱');
      source.pack_per_box=pack;
    }
    // 补录来源缺值，后续新流程沿同一真实资料继续；不改变已有明确信息。
    if(store!==previous.store || pack!==previous.packPerBox) {
      if(work.inquiry_id) this.db.prepare("UPDATE inquiry_documents SET store_name=CASE WHEN ?='' THEN store_name ELSE ? END,pack_per_box=?,revision=revision+1,updated_at=? WHERE id=?")
        .run(store,store,source.pack_per_box,at,work.inquiry_id);
      if(work.fba_archive_id) {
        this.db.prepare('UPDATE fba_archives SET store_name=?,pack_per_box=? WHERE id=?').run(source.store_name,source.pack_per_box,work.fba_archive_id);
        this.db.prepare('UPDATE transit_batches SET store_name=?,pack_per_box=?,revision=revision+1,updated_at=? WHERE id=(SELECT transit_id FROM fba_archives WHERE id=?)')
          .run(source.store_name,source.pack_per_box,at,work.fba_archive_id);
      }
      if(work.allocation_document_id && store!==previous.store) this.db.prepare('UPDATE allocation_documents SET store_name=?,revision=revision+1,updated_at=? WHERE id=?').run(store,at,work.allocation_document_id);
    }
    const total=previous.completedQuantity+changes.reduce((s,c)=>s+c.quantity-Number(c.d.quantity),0);
    const transfer=work.kind==='transfer';
    if(!transfer && counted!==null) throw new BusinessError(422,'relocation_no_count','移仓升级不填写实际清点数量');
    if(transfer && counted!==null && !rma) throw new BusinessError(422,'missing_rma','清点前请填写RMA');
    const verified=transfer?(counted??0):Number(work.shipped_quantity||0);
    if(total+progress>verified) throw new BusinessError(422,'upgrade_quantity_exceeded',`升级中 ${progress} 加累计完成 ${total} 超过已核实来源 ${verified} 件`);
    if(total>0 && !/^[1-9]\d*$/.test(String(source.pack_per_box||''))) throw new BusinessError(422,'invalid_pack_per_box','完成入库前请补真实套/箱');
    if(total>0 && !source.store_name) throw new BusinessError(422,'missing_source_store','完成入库前请补真实来源店铺');
    let status=work.status, address={processed:work.processed_address||'',issue:work.address_issue||'',contact,street};
    if(transfer) status=counted!==null?'transferring':rma?'awaiting_count':'third_party';
    else if(['awaiting_procurement','awaiting_operation'].includes(work.status)) {
      address=rma && raw?processWarehouseAddress({store:source.store_name,rma,raw,contact,street}):{processed:'',issue:'请填写RMA和原始移仓地址',contact,street};
      status=address.issue?'awaiting_procurement':'awaiting_operation';
    } else if(rma!==previous.rma || raw!==previous.rawAddress || contact!==previous.contact || street!==previous.street) {
      throw new BusinessError(409,'source_after_order_fixed','订单号已提交，不能在进度模板中改换RMA或地址');
    }
    this.db.prepare(`UPDATE upgrade_relocation_work_items SET source_snapshot_json=?,rma=?,relocation_address=?,processed_address=?,address_issue=?,
      address_contact=?,address_street=?,counted_quantity=?,count_difference=?,in_progress_quantity=?,status=?,procurement_by_role=?,procurement_at=?,updated_at=? WHERE id=?`)
      .run(JSON.stringify(source),rma,raw,address.processed,address.issue,contact,street,counted,
        transfer&&counted!==null?counted-Number(work.source_quantity_before):null,progress,status,role,at,at,work.id);
    work=this.db.prepare('SELECT * FROM upgrade_relocation_work_items WHERE id=?').get(work.id);
    let relocation=work.relocation_id?this.getUpgradeRelocation(work.relocation_id):null;
    if(transfer && counted!==null) {
      relocation=this.ensureFlowRelocation(work,counted,role,at,requestId);
      // 下调清点和完成可在同文件同事务执行，不先让中间状态破坏约束。
      this.db.prepare('UPDATE upgrade_relocations SET shipped_quantity=?,completed_quantity=?,rma=?,revision=revision+1,updated_at=? WHERE id=?').run(counted,total,rma,at,relocation.id);
    }
    if(total>0 && !relocation) throw new BusinessError(409,'shipment_not_applied','尚未取得可完成的来源数量');
    for(const c of changes) {
      if(!c.changed) continue;
      if(c.quantity>0 && (!c.version || c.version===source.version)) throw new BusinessError(422,'unchanged_upgrade_version','升级完，版本号须填写且与原版本不同');
      if(c.quantity>0 && !OVERSEAS_WAREHOUSES.includes(c.warehouse)) throw new BusinessError(422,'invalid_target_warehouse','请选择实际目标海外仓');
      const target=c.quantity>0?this.ensureStockBatch(source,c.version,at,c.warehouse,'Aster海外仓-升级后库存'):null;
      const same=c.d.batch_key===target?.batch_key;
      const deltas=same?[{batch:c.d.batch_key,delta:c.quantity-Number(c.d.quantity)}]:
        [{batch:c.d.batch_key,delta:-Number(c.d.quantity)},{batch:target?.batch_key,delta:c.quantity}];
      const eventId=this.addEvent(work.allocation_document_id,'upgrade_relocation_complete',role,at,null,{
        workId:work.id,flowId:work.work_no,completionId:c.d.id,model:source.model,department:source.department,team:source.department,
        previousQuantity:Number(c.d.quantity),quantity:c.quantity,newVersion:c.version,onHandDelta:c.quantity-Number(c.d.quantity),requestId});
      let operationId=null;
      if(relocation && deltas.some(d=>d.delta)) {
        operationId=this.addUpgradeOperation({upgradeId:relocation.upgrade_id,relocationId:relocation.id,type:'relocation_complete',
          quantity:Math.max(c.quantity,Number(c.d.quantity)),newVersion:c.version,eventId,requestId,role,at,metadata:{completionId:c.d.id,cumulative:true}});
        for(const {batch,delta} of deltas) if(batch && delta) {
          const related=delta<0?this.db.prepare("SELECT id FROM upgrade_inventory_ledger WHERE json_extract(metadata_json,'$.completionId')=? AND batch_key=? AND on_hand_delta>0 ORDER BY id DESC LIMIT 1").get(c.d.id,batch)?.id
            ??this.db.prepare('SELECT id FROM upgrade_inventory_ledger WHERE operation_id=? AND batch_key=? AND on_hand_delta>0 LIMIT 1').get(c.d.operation_id,batch)?.id:null;
          this.addUpgradeLedger(relocation.upgrade_id,'relocation',relocation.id,batch,delta>0?'relocation_receipt':'relocation_completion_reverse',delta,0,role,at,requestId,{completionId:c.d.id},operationId,related??null);
        }
      }
      this.db.prepare('UPDATE upgrade_completion_details SET quantity=?,version=?,warehouse=?,batch_key=?,operation_id=COALESCE(operation_id,?),revision=revision+1,updated_at=? WHERE id=?')
        .run(c.quantity,c.version,c.warehouse,target?.batch_key??null,operationId,at,c.d.id);
    }
    if(relocation) {
      this.db.prepare('UPDATE upgrade_relocations SET completed_quantity=?,revision=revision+1,updated_at=? WHERE id=?').run(total,at,relocation.id);
      this.refreshUpgradeJobState(relocation.upgrade_id,at);
    }
    this.db.prepare('UPDATE upgrade_relocation_work_items SET revision=revision+1,updated_at=? WHERE id=?').run(at,work.id);
    this.addEvent(work.allocation_document_id,'upgrade_flow_update',role,at,null,{workId:work.id,flowId:work.work_no,model:source.model,team:source.department,
      before:previous,after:this.upgradeFlow(work.id),requestId});
  }

  relocationSource(allocationId, inquiryId = null, fbaArchiveId = null) {
    return this.db.prepare("SELECT * FROM relocation_sources WHERE allocation_document_id = ? OR inquiry_id = ? OR fba_archive_id = ?")
      .get(allocationId == null ? null : Number(allocationId), inquiryId == null ? null : Number(inquiryId), fbaArchiveId == null ? null : Number(fbaArchiveId));
  }

  relocationSourceQuantity(allocationId, inquiryId = null, inquiryShipmentId = null, fbaArchiveId = null) {
    const sourceQuantity = inquiryShipmentId == null ? Number(this.relocationSource(allocationId, inquiryId, fbaArchiveId)?.quantity ?? 0)
      : Number(this.db.prepare("SELECT quantity FROM inquiry_shipments WHERE id = ? AND inquiry_id = ?").get(inquiryShipmentId, inquiryId)?.quantity ?? 0);
    const used = this.db.prepare(`SELECT COALESCE(SUM(shipped_quantity + sold_quantity), 0) AS quantity
      FROM upgrade_relocations WHERE (allocation_document_id = ? OR inquiry_id = ? OR fba_archive_id = ?) AND status = 'active'
      AND (? IS NULL OR inquiry_shipment_id = ?)`).get(allocationId ?? null, inquiryId ?? null, fbaArchiveId, inquiryShipmentId, inquiryShipmentId);
    return sourceQuantity - Number(used.quantity);
  }

  initiateRelocationUpgrade({ role, allocationId, inquiryId, fbaArchiveId, requestId }) {
    const documentId = allocationId == null ? null : Number(allocationId);
    const inquirySourceId = inquiryId == null ? null : Number(inquiryId);
    const fbaSourceId = fbaArchiveId == null ? null : Number(fbaArchiveId);
    this.requireUpgradeRole(role);
    if ([documentId, inquirySourceId, fbaSourceId].filter(value => value != null).length !== 1
      || (fbaSourceId != null && (!Number.isInteger(fbaSourceId) || fbaSourceId <= 0))
      || (documentId != null && (!Number.isInteger(documentId) || documentId <= 0))
      || (inquirySourceId != null && (!Number.isInteger(inquirySourceId) || inquirySourceId <= 0))) {
      throw new BusinessError(400, "invalid_allocation", "请选择一条已归档的调拨、询库或直发FBA记录");
    }
    return this.idempotent("upgrade:relocation:initiate", requestId, { role, allocationId: documentId, inquiryId: inquirySourceId, fbaArchiveId: fbaSourceId }, () => {
      const document = this.relocationSource(documentId, inquirySourceId, fbaSourceId);
      if (!document || !["confirmed", "archived"].includes(document.status)) throw new BusinessError(409, "allocation_not_confirmed", "仅可选择已归档的调拨、询库或直发FBA记录");
      const shipmentId = null;
      const confirmedAt = Date.parse(document.confirmed_at ?? "");
      if (document.source_kind === "allocation" && (!Number.isFinite(confirmedAt) || confirmedAt < Date.now() - 90 * 24 * 60 * 60 * 1000)) {
        throw new BusinessError(409, "allocation_outside_90_days", "该来源记录归档已超过 90 天");
      }
      const existing = this.db.prepare(`
        SELECT id FROM upgrade_relocation_work_items
        WHERE (allocation_document_id = ? OR inquiry_id = ? OR fba_archive_id = ?) AND status IN ('awaiting_procurement', 'awaiting_operation', 'awaiting_shipping')
      `).get(documentId, inquirySourceId, fbaSourceId);
      if (existing) throw new BusinessError(409, "relocation_work_active", `该来源已有待处理移仓流程 ${relocationWorkNumber(existing.id)}`);
      const sourceBefore = this.relocationSourceQuantity(documentId, inquirySourceId, shipmentId, fbaSourceId);
      if (sourceBefore <= 0) throw new BusinessError(409, "no_fba_remaining", "该归档来源没有可继续移仓的 FBA 剩余库存");
      const at = new Date().toISOString();
      const inserted = this.db.prepare(`
        INSERT INTO upgrade_relocation_work_items(
          work_no, allocation_document_id, inquiry_id, fba_archive_id, inquiry_shipment_id, source_quantity_before, status,
          initiated_by_role, initiated_at, revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'awaiting_procurement', ?, ?, 1, ?)
      `).run(`PENDING-${crypto.randomUUID()}`, documentId, inquirySourceId, fbaSourceId, shipmentId, sourceBefore, role, at, at);
      const workId = Number(inserted.lastInsertRowid);
      const workNo = relocationWorkNumber(workId);
      this.db.prepare("UPDATE upgrade_relocation_work_items SET work_no = ? WHERE id = ?").run(workNo, workId);
      const snapshot=this.snapshotRelocationSource(document);
      this.db.prepare('UPDATE upgrade_relocation_work_items SET source_snapshot_json=? WHERE id=?').run(JSON.stringify(snapshot),workId);
      this.db.prepare('INSERT INTO upgrade_completion_details(id,work_id,updated_at) VALUES(?,?,?)').run(`COMP-${workNo}-1`,workId,at);
      const catalog = this.getModel(document.model);
      this.addEvent(documentId, "upgrade_relocation_started", role, at, null, {
        workId, workNo, inquiryId: inquirySourceId, fbaArchiveId: fbaSourceId, inquiryShipmentId: shipmentId, model: document.model, category: catalog?.category,
        department: document.department, team: document.department, sourceVersion: document.version,
        quantity: sourceBefore, onHandDelta: 0, lockedDelta: 0, requestId,
      });
      return { ok: true, workItem: this.relocationWorkRecord(workId) };
    });
  }


  recordRelocationProcurement({ id, role, rma, relocationAddress, expectedRevision, requestId }) {
    const rows=this.upgradeTemplateRows([id]).map(row=>({...row,rma,rawAddress:relocationAddress,flowRevision:expectedRevision}));
    const result=this.updateUpgradeFlows({role,rows,requestId});
    return {...result,workItem:this.relocationWorkRecord(id)};
  }

  recordRelocationOperation({ id, role, removalOrderNo, expectedRevision, requestId }) {
    const workId = Number(id);
    const orderNo = String(removalOrderNo ?? "").trim();
    if (!orderNo) throw new BusinessError(400, "missing_removal_order_no", "请填写移除订单号");
    return this.idempotent(`upgrade:relocation:operation:${workId}`, requestId, { id: workId, role, removalOrderNo: orderNo, expectedRevision }, () => {
      const row = this.db.prepare("SELECT * FROM upgrade_relocation_work_items WHERE id = ?").get(workId);
      if (!row) throw new BusinessError(404, "relocation_work_not_found", `找不到移仓流程 ${workId}`);
      const document = this.flowSource(row);
      this.requireOperationUpgradeRole(role, document);
      if (row.status !== "awaiting_operation") throw new BusinessError(409, "invalid_relocation_step", "当前移仓流程不在运营填写步骤");
      if (!Number.isInteger(Number(expectedRevision)) || Number(row.revision) !== Number(expectedRevision)) {
        throw new BusinessError(409, "upgrade_stale_revision", "移仓流程已被其他操作更新，请刷新后重试");
      }
      const at = new Date().toISOString();
      const changed = this.db.prepare(`
        UPDATE upgrade_relocation_work_items
        SET removal_order_no = ?, operation_by_role = ?, operation_at = ?,
            status = 'awaiting_shipping', revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'awaiting_operation'
      `).run(orderNo, role, at, at, workId, Number(expectedRevision));
      if (Number(changed.changes) !== 1) throw new BusinessError(409, "upgrade_concurrent_update", "移仓流程已被其他操作更新，请刷新后重试");
      const record = this.relocationWorkRecord(workId);
      this.addEvent(row.allocation_document_id, "upgrade_relocation_operation", role, at, null, {
        inquiryId: row.inquiry_id, fbaArchiveId: row.fba_archive_id,
        workId, workNo: row.work_no, model: record.model, category: record.category,
        department: record.department, team: record.department, quantity: Number(row.source_quantity_before),
        onHandDelta: 0, lockedDelta: 0, requestId,
      });
      return { ok: true, workItem: record };
    });
  }

  getBalance(batch) {
    const row = this.db.prepare("SELECT * FROM stock_balances WHERE batch_key = ?").get(batch);
    if (!row) throw new BusinessError(400, "unknown_batch", "找不到对应在库批次");
    const balance = {
      base: Number(row.base_quantity) + Number(row.receipt_quantity || 0) + Number(row.upgrade_receipt_quantity || 0),
      onHand: Number(row.on_hand),
      locked: Number(row.locked),
    };
    balance.available = balance.onHand - balance.locked;
    if (balance.onHand < 0 || balance.locked < 0 || balance.available < 0) {
      throw new BusinessError(500, "inventory_invariant", "库存余额、锁定量或可用量出现负数，已停止写入");
    }
    return balance;
  }

  inventoryResultForRole(result, role) {
    const group = OPERATION_GROUPS[role];
    const model = result?.record?.model ?? result?.document?.model ?? result?.model;
    if (!group || !model || this.getModel(model)?.category !== "墨盒") return result;
    const visible = this.visibleStockBatchKeys(model, "墨盒", group);
    const record = result.record ?? result.document;
    if (record?.batchKey && !visible.has(record.batchKey)) throw new BusinessError(403,"source_team_forbidden","当前角色不能使用该墨盒来源批次");
    const scoped = {...result};
    if (result.totals) scoped.totals = Object.fromEntries(Object.entries(result.totals).filter(([key])=>visible.has(key)));
    // Old cached shelf responses have global before/after values without a per-team breakdown.
    // The UI does not use these fields. Return the existing scoped inventory query instead.
    if (Object.hasOwn(scoped,"before") || Object.hasOwn(scoped,"after")) {
      delete scoped.before; delete scoped.after;
      scoped.inventory = this.getCatalog({visibleGroup:group}).models.find(row=>row.model===model) ?? null;
    }
    return scoped;
  }

  idempotent(scope, requestId, payload, operation) {
    const key = String(requestId || "").trim();
    if (!key) throw new BusinessError(400, "missing_request_id", "本次提交信息不完整，请重新打开表单后提交");
    if (key.length > 200) throw new BusinessError(400, "invalid_request_id", "本次提交编号无效，请重新打开表单后提交");
    const requestHash = sha256(stableJson(payload));
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM idempotency_requests WHERE scope = ? AND request_id = ?").get(scope, key);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new BusinessError(409, "idempotency_conflict", "本次提交的内容与上次不同，未保存新内容。请先查看上次结果，再重新填写", { requestId: key });
        }
        return this.inventoryResultForRole({ ...JSON.parse(existing.response_json), deduped: true }, payload.role);
      }
      const result = operation();
      const response = { ...result, sync: this.bumpVersion() };
      this.db.prepare(`
        INSERT INTO idempotency_requests(scope, request_id, request_hash, response_status, response_json, created_at)
        VALUES (?, ?, ?, 200, ?, ?)
      `).run(scope, key, requestHash, JSON.stringify(response), new Date().toISOString());
      return this.inventoryResultForRole(response, payload.role);
    });
  }






  insertDocument(fields) {
    const placeholder = `PENDING-${crypto.randomUUID()}`;
    const result = this.db.prepare(`
      INSERT INTO allocation_documents(
        document_no, correction_of_id, model, batch_key, plan, ship_date, version, fnsku, quantity,
        department, store_name, operator_name, legacy_time_label, status, revision, created_by_role,
        created_at, submitted_by_role, submitted_at, external_sync_status, updated_at,
        asin, operator_note, requested_quantity, approval_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'not_synced', ?, ?, ?, ?, 'pending')
    `).run(
      placeholder, fields.correctionOfId ?? null, fields.model, fields.batchKey, fields.plan, fields.date, fields.version,
      fields.fnsku, fields.quantity, fields.department, fields.store, fields.operator, fields.time,
      fields.status, fields.role, fields.at, fields.submittedByRole ?? null, fields.submittedAt ?? null, fields.at,
      fields.asin ?? "", fields.operatorNote ?? "", fields.quantity,
    );
    const id = Number(result.lastInsertRowid);
    this.db.prepare("UPDATE allocation_documents SET document_no = ? WHERE id = ?").run(documentNumber(id), id);
    return this.db.prepare("SELECT * FROM allocation_documents WHERE id = ?").get(id);
  }

  addLedger(documentId, batch, type, onHandDelta, lockedDelta, role, at, relatedId = null, group = null, metadata = {}) {
    this.changedBatches.add(batch);
    const result = this.db.prepare(`
      INSERT INTO inventory_ledger(document_id, batch_key, entry_type, on_hand_delta, locked_delta, related_ledger_id, reversal_group, created_by_role, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(documentId, batch, type, onHandDelta, lockedDelta, relatedId, group, role, at, JSON.stringify(metadata));
    this.db.prepare("UPDATE stock_batches SET revision = revision + 1, updated_at = ? WHERE batch_key = ?").run(at, batch);
    this.db.prepare(`
      UPDATE catalog_models SET revision = revision + 1, updated_at = ?
      WHERE model = (SELECT model FROM stock_batches WHERE batch_key = ?)
    `).run(at, batch);
    return result;
  }

  addEvent(documentId, type, role, at, reason = null, payload = {}) {
    const result = this.db.prepare(`
      INSERT INTO document_events(document_id, legacy_record_id, event_type, role, occurred_at, reason, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(documentId, documentId, type, role, at, reason, JSON.stringify(payload));
    return Number(result.lastInsertRowid);
  }

  createAllocation({ role, model, plan, date, version, sourceBatchKey, quantity, department, store, operator, fnsku, asin, operatorNote, requestId }) {
    requireDepartment(role, department);
    store = requireValidStoreCode(store);
    const asinValue = normalizeAsin(asin);
    const note = String(operatorNote ?? "").trim();
    const payload = { role, model, plan, date, version, ...(sourceBatchKey ? { sourceBatchKey } : {}), quantity, department, store, operator, fnsku, asin: asinValue, operatorNote: note };
    return this.idempotent("allocation:create", requestId, payload, () => {
      const batches = this.db.prepare(`SELECT * FROM stock_batches WHERE model = ? AND plan = ? AND ship_date = ? AND version = ?
        AND (? IS NULL OR batch_key = ?)`)
        .all(model, plan, date, version, sourceBatchKey ?? null, sourceBatchKey ?? null);
      if (batches.length > 1) throw new BusinessError(409, "select_stock_batch", "同计划、日期和版本有多个贴码批次，请刷新后选择对应批次");
      const batch = batches[0];
      if (!batch) throw new BusinessError(400, "unknown_batch", `型号“${model}”无此在库批次`);
      const visibleKeys = this.visibleStockBatchKeys(model, this.getModel(model)?.category, OPERATION_GROUPS[role] ?? null);
      if (visibleKeys && !visibleKeys.has(batch.batch_key)) throw new BusinessError(403, "source_team_forbidden", "当前角色不能使用该墨盒来源批次");
      if (["operation-1", "operation-2"].includes(role)) {
        const packText = String(batch.pack_per_box ?? "").trim();
        const pack = Number(packText);
        if (!/^\d+(?:\.0+)?$/.test(packText) || !Number.isSafeInteger(pack) || pack <= 0) {
          throw new BusinessError(400, "invalid_pack_per_box", "本批次套/箱未维护或不是正整数，请补齐后再调拨。");
        }
        if (quantity % pack !== 0) {
          throw new BusinessError(400, "allocation_pack_multiple", `本批次套/箱为 ${pack}，调拨数量须为 ${pack} 的整数倍。`);
        }
      }
      const key = batch.batch_key;
      const balance = this.getBalance(key);
      if (quantity > balance.available) throw new BusinessError(409, "insufficient_available", `超出可用库存（当前可用 ${balance.available}）`);
      const at = new Date().toISOString();
      const row = this.insertDocument({
        model, batchKey: key, plan, date, version, fnsku, quantity, department, store, operator, asin: asinValue, operatorNote: note,
        time: at, status: "pending", role, at, submittedByRole: role, submittedAt: at,
      });
      this.addLedger(Number(row.id), key, "reserve", 0, quantity, role, at, null, null, { requestId });
      this.addEvent(Number(row.id), "entry", role, at, null, { quantity, department, store, operator, fnsku, asin: asinValue, operatorNote: note, requestId });
      return { ok: true, record: this.documentRecord(row), totals: this.batchTotals(model) };
    });
  }

  requireRevision(row, expectedRevision) {
    if (!Number.isInteger(expectedRevision)) throw new BusinessError(400, "missing_revision", "当前记录信息不完整，请重新加载后操作");
    if (Number(row.revision) !== expectedRevision) {
      throw new BusinessError(409, "stale_revision", `单据已被其他同事更新，请重新加载后核对`, { current: this.documentRecord(row) });
    }
  }

  reviewAllocation({ id, role, decision, approvedQuantity, businessNote, expectedRevision, requestId }) {
    if (role !== BUSINESS_ROLE) throw new BusinessError(403, "review_forbidden", "仅商务可审核调拨");
    if (!["approve", "reject"].includes(decision)) throw new BusinessError(400, "invalid_review_decision", "请选择批准或拒绝");
    const approved = decision === "approve" ? Number(approvedQuantity) : null;
    if (decision === "approve" && (!Number.isInteger(approved) || approved <= 0)) throw new BusinessError(400, "invalid_quantity", "审核数量请填写大于 0 的整数");
    const note = String(businessNote ?? "").trim();
    return this.idempotent(`allocation:review:${id}`, requestId, { id, role, decision, approvedQuantity: approved, businessNote: note, expectedRevision }, () => {
      const row = this.db.prepare("SELECT * FROM allocation_documents WHERE id = ?").get(id);
      if (!row) throw new BusinessError(404, "not_found", `找不到调拨单据 ${id}`);
      this.requireRevision(row, expectedRevision);
      if (row.status !== "pending" || row.approval_status !== "pending") throw new BusinessError(409, "invalid_approval_status", "仅待商务审核的调拨可审核");
      normalizeAsin(row.asin);
      if (decision === "approve") {
        const sourceBatch = this.db.prepare("SELECT pack_per_box FROM stock_batches WHERE batch_key = ?").get(row.batch_key);
        const packText = String(sourceBatch?.pack_per_box ?? "").trim();
        const pack = Number(packText);
        if (!/^\d+(?:\.0+)?$/.test(packText) || !Number.isSafeInteger(pack) || pack <= 0) {
          throw new BusinessError(400, "invalid_pack_per_box", "来源批次套/箱未维护或不是正整数，请补齐后再批准。");
        }
        if (approved % pack !== 0) {
          throw new BusinessError(400, "allocation_pack_multiple", `来源批次套/箱为 ${pack}，审核数量须为 ${pack} 的整数倍。`);
        }
      }
      const at = new Date().toISOString();
      const reserve = this.db.prepare("SELECT id FROM inventory_ledger WHERE document_id = ? AND entry_type = 'reserve'").get(id);
      if (decision === "approve") {
        const difference = approved - Number(row.quantity);
        const balance = this.getBalance(row.batch_key);
        if (difference > balance.available) throw new BusinessError(409, "insufficient_available", `增批 ${difference} 件超出可用库存（当前可用 ${balance.available}）`);
        this.db.prepare(`UPDATE allocation_documents SET quantity = ?, approved_quantity = ?, business_note = ?,
          approval_status = 'approved', reviewed_at = ?, reviewed_by_role = ?, revision = revision + 1, updated_at = ? WHERE id = ?`)
          .run(approved, approved, note, at, role, at, id);
        this.addLedger(id, row.batch_key, "review_adjustment", 0, difference, role, at, reserve.id, null, { requestedQuantity: Number(row.requested_quantity), approvedQuantity: approved });
        this.addEvent(id, "review", role, at, note, { quantity: approved, requestedQuantity: Number(row.requested_quantity), approvedQuantity: approved, lockedDelta: difference });
      } else {
        this.db.prepare(`UPDATE allocation_documents SET status = 'cancelled', approval_status = 'rejected', business_note = ?,
          reviewed_at = ?, reviewed_by_role = ?, cancelled_at = ?, cancelled_by_role = ?, cancel_reason = ?,
          lingxing_snapshot_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?`)
          .run(note, at, role, at, role, note, JSON.stringify(this.lingxingForDocument(row)), at, id);
        this.addLedger(id, row.batch_key, "release_reservation", 0, -Number(row.quantity), role, at, reserve.id);
        this.addEvent(id, "reject", role, at, note, { quantity: Number(row.quantity), requestedQuantity: Number(row.requested_quantity) });
      }
      return { ok: true, record: this.getDocument(id), totals: this.batchTotals(row.model) };
    });
  }

  confirmAllocation({ id, role, expectedRevision, requestId }) {
    if (!ASSISTANT_ROLE_SET.has(role)) throw new BusinessError(403, "confirm_forbidden", "仅助理角色可确认调拨完成");
    return this.idempotent(`allocation:confirm:${id}`, requestId, { id, role, expectedRevision }, () => {
      const row = this.db.prepare("SELECT * FROM allocation_documents WHERE id = ?").get(id);
      if (!row) throw new BusinessError(404, "not_found", `找不到调拨单据 ${id}`);
      this.requireRevision(row, expectedRevision);
      if (row.status !== "pending") throw new BusinessError(409, "invalid_status", `当前状态“${STATUS_TEXT[row.status]}”不能确认`);
      if (row.approval_status !== "approved") throw new BusinessError(409, "approval_required", "调拨须先由商务审核通过，助理才能确认完成");
      const balance = this.getBalance(row.batch_key);
      if (balance.onHand < Number(row.quantity)) throw new BusinessError(409, "insufficient_stock", "在库数量不足，无法确认调出");
      const at = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE allocation_documents
        SET status = 'confirmed', confirmed_by_role = ?, confirmed_at = ?, lingxing_snapshot_json = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'pending'
      `).run(role, at, JSON.stringify(this.lingxingForDocument(row)), at, id, expectedRevision);
      if (Number(result.changes) !== 1) throw new BusinessError(409, "concurrent_update", "单据已被其他同事处理，请刷新");
      const reserve = this.db.prepare("SELECT id FROM inventory_ledger WHERE document_id = ? AND entry_type = 'reserve'").get(id);
      this.addLedger(id, row.batch_key, "release_reservation", 0, -Number(row.quantity), role, at, reserve?.id ?? null);
      this.addLedger(id, row.batch_key, "issue", -Number(row.quantity), 0, role, at);
      this.addEvent(id, "confirm", role, at, null, { quantity: Number(row.quantity) });
      if (process.env.ASTER_TEST_FAILPOINT === "confirm-before-commit") throw new Error("test failpoint: confirm-before-commit");
      const updated = this.db.prepare("SELECT * FROM allocation_documents WHERE id = ?").get(id);
      return { ok: true, record: this.documentRecord(updated), totals: this.batchTotals(row.model) };
    });
  }




  refreshUpgradeJobState(upgradeId, at) {
    const job = this.db.prepare("SELECT * FROM upgrade_jobs WHERE id = ?").get(Number(upgradeId));
    if (!job) throw new BusinessError(404, "upgrade_not_found", `找不到升级单 ${upgradeId}`);
    const latest=this.db.prepare("SELECT new_version FROM upgrade_operations WHERE upgrade_id=? AND operation_type IN ('direct_complete','relocation_complete') AND status='active' ORDER BY id DESC LIMIT 1").get(Number(upgradeId));
    this.db.prepare('UPDATE upgrade_jobs SET new_version=? WHERE id=?').run(latest?.new_version??null,Number(upgradeId));
    const active = this.db.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(shipped_quantity - completed_quantity), 0) AS open,
             COALESCE(SUM(completed_quantity), 0) AS completed
      FROM upgrade_relocations WHERE upgrade_id = ? AND status = 'active'
    `).get(Number(upgradeId));
    const remaining = this.relocationSourceQuantity(job.allocation_document_id, job.inquiry_id, null, job.fba_archive_id);
    const status = Number(active.count) > 0 && remaining === 0 && Number(active.open) === 0
      ? "completed"
      : "active";
    this.db.prepare(`
      UPDATE upgrade_jobs
      SET status = ?, new_version = CASE WHEN ? = 0 THEN NULL ELSE new_version END,
          revision = revision + 1, updated_at = ?
      WHERE id = ?
    `).run(status, Number(active.completed), at, Number(upgradeId));
  }




  history(id) {
    const document = this.getDocument(id);
    if (!document) throw new BusinessError(404, "not_found", `找不到调拨单据 ${id}`);
    const events = this.db.prepare("SELECT * FROM document_events WHERE document_id = ? ORDER BY id").all(id).map(rowToDocumentEvent);
    const ledger = this.db.prepare("SELECT * FROM inventory_ledger WHERE document_id = ? ORDER BY id").all(id).map(rowToLedgerEntry);
    return { document, events, ledger };
  }

  auditEventRow(eventId) {
    return this.db.prepare(`
      SELECT e.*, d.document_no, d.model, d.batch_key, d.quantity,
             d.department, d.store_name, d.operator_name
      FROM document_events e
      LEFT JOIN allocation_documents d ON d.id = e.document_id
      WHERE e.id = ?
        AND e.event_type IN (${[...AUDIT_OPERATION_SET].map(type=>`'${type}'`).join(',')})
    `).get(eventId) ?? null;
  }

  upgradeLedgerForAuditEvent(row) {
    if (Array.isArray(row.scopedUpgradeLedger)) return row.scopedUpgradeLedger;
    if (!String(row.event_type).startsWith("upgrade_")) return [];
    const payload = parseEventPayload(row.payload_json);
    let operationId = Number(payload.operationId);
    if (!Number.isInteger(operationId) || operationId <= 0) {
      operationId = Number(this.db.prepare("SELECT id FROM upgrade_operations WHERE source_event_id = ?").get(Number(row.id))?.id ?? 0);
    }
    if (!Number.isInteger(operationId) || operationId <= 0) return [];
    return this.db.prepare(`
      SELECT * FROM upgrade_inventory_ledger
      WHERE operation_id = ? AND created_at = ? ORDER BY id
    `).all(operationId, row.occurred_at);
  }

  scopeAuditRow(row, group, { scopeDirectByTeam = false } = {}) {
    const payload = parseEventPayload(row.payload_json);
    // 业务归属来自当前来源单据，与处理岗位及历史载荷中记录的旧团队无关。
    const document = row.document_id == null ? null : this.getDocument(Number(row.document_id));
    const inquiry = payload.inquiryId == null ? null : this.getInquiry(Number(payload.inquiryId));
    const upgrade = payload.upgradeId == null ? null : this.upgradeRecord(Number(payload.upgradeId));
    const work = payload.workId == null ? null : this.getRelocationWorkItem(Number(payload.workId));
    const team = String(row.event_type).startsWith('upgrade_')
      ? work?.department ?? upgrade?.department ?? document?.department ?? inquiry?.department
      : document?.department ?? inquiry?.department;
    if (team) return !group || team === group ? {...row, currentTeam:team} : null;
    if (String(row.event_type).startsWith('upgrade_direct_')) {
      if (!scopeDirectByTeam || !group) return row;
      const scopedUpgrade = this.getUpgrades({ visibleGroup: group, scopeDirectByTeam: true })
        .find(item => item.kind === "direct" && item.id === Number(payload.upgradeId));
      if (!scopedUpgrade) return null;
      const teamsByBatch = this.stockBatchSourceTeams();
      const visibleLedger = this.upgradeLedgerForAuditEvent(row).filter(entry => (
        teamsByBatch.get(entry.batch_key)?.size === 1 && teamsByBatch.get(entry.batch_key)?.has(group)
      ));
      if (!visibleLedger.length) return null;
      const quantity = visibleLedger.reduce((sum, entry) => sum + Math.max(0, Number(entry.on_hand_delta), Number(entry.locked_delta)), 0);
      const scopedPayload = {
        ...payload, quantity, department: group, team: group, teams: [group],
        onHandDelta: visibleLedger.reduce((sum, entry) => sum + Number(entry.on_hand_delta), 0),
        lockedDelta: visibleLedger.reduce((sum, entry) => sum + Number(entry.locked_delta), 0),
      };
      return { ...row, currentTeam: group, payload_json: JSON.stringify(scopedPayload), scopedUpgradeLedger: visibleLedger };
    }
    if (String(row.event_type).startsWith('transit_')) {
      const imported = payload.importId == null ? [] : this.transitImportRows(Number(payload.importId));
      const ids = payload.transitId != null ? [payload.transitId] : payload.transitIds ?? imported.map(item => item.transit?.id).filter(Boolean);
      const transits = [...new Set(ids.map(Number))].map(id => this.getTransit(id)).filter(Boolean);
      if (transits.length) {
        const owned = group ? transits.filter(item => item.team === group) : transits;
        if (!owned.length) return null;
        const teams = [...new Set(owned.map(item => item.team))];
        const scopedRow = {...row, currentTeam:teams.length === 1 ? teams[0] : undefined};
        if (!group || owned.length === transits.length) return scopedRow;
        // 一个导入/物流事件可以覆盖两团；接口只投影本团部分，原事件不改写。
        const visibleRows = imported.filter(item => item.team === group);
        const models = [...new Set(owned.map(item => item.model))];
        const categories = [...new Set(models.map(model => this.getModel(model)?.category).filter(Boolean))];
        const scoped = {
          fileName:payload.fileName, fileHash:payload.fileHash, templateHash:payload.templateHash, importId:payload.importId,
          transitIds:owned.map(item => item.id), models, model:models.length === 1 ? models[0] : undefined,
          teams:[group], category:categories.length === 1 ? categories[0] : null, categories,
          rowCount:owned.length, onHandDelta:0, lockedDelta:0,
        };
        if (row.event_type === 'transit_import') {
          scoped.quantity = visibleRows.reduce((sum,item) => sum + Number(item.payload.quantity ?? 0),0);
          scoped.sourceRowCount = visibleRows.length;
          scoped.mergedRowCount = visibleRows.length - owned.length;
        } else if (row.event_type === 'transit_status') {
          scoped.updatedDetailCount = owned.length;
          scoped.processedPlanCount = scoped.matchedPlanCount = new Set(owned.map(item => item.plan)).size;
          scoped.unmatchedPlanCount = 0; scoped.unmatchedPlans = [];
        }
        return {...scopedRow, payload_json:JSON.stringify(scoped)};
      }
    }
    const teams = [...new Set((payload.teams ?? [payload.team ?? payload.department]).filter(Boolean))];
    if (!group || (teams.length === 1 && teams[0] === group)) return row;
    // 未带团队的公共库存事件不按处理人臆造归属。
    return teams.length === 0 && ['legacy_placeholder_removed'].includes(row.event_type) ? row : null;
  }

  auditRecord(row) {
    const operation = row.event_type;
    const payload = parseEventPayload(row.payload_json);
    if (operation === 'business_correction') return {
      operation,eventType:operation,action:operation,eventId:Number(row.id),documentId:row.document_id,
      model:payload.model,category:payload.category,quantity:payload.quantity,role:row.role,at:row.occurred_at,reason:row.reason,
      onHandDelta:payload.onHandDelta,lockedDelta:payload.lockedDelta,inTransitDelta:payload.inTransitDelta,
      availableDelta:payload.onHandDelta-payload.lockedDelta,effectKnown:true,result:payload.actionLabel,
      department:payload.department,team:payload.team,ledgerIds:payload.ledgerIds,sourceAvailable:row.document_id != null,
      businessNo:payload.after?.document_no||payload.after?.work_no||payload.after?.operation_no||String(payload.targetId),
    };
    const sourceAvailable = row.document_id != null && row.document_no != null;
    const expectedTypes = AUDIT_LEDGER_TYPES[operation] ?? [];
    let matchingLedger = [];

    if (sourceAvailable) {
      const rows = this.db.prepare(`
        SELECT * FROM inventory_ledger
        WHERE document_id = ? AND created_at = ?
        ORDER BY id
      `).all(Number(row.document_id), row.occurred_at);
      matchingLedger = operation === "legacy_import"
        ? rows
        : rows.filter((entry) => expectedTypes.includes(entry.entry_type));
    }
    const upgradeLedger = this.upgradeLedgerForAuditEvent(row);
    if (upgradeLedger.length > 0) matchingLedger = upgradeLedger;

    let effectKnown = false;
    let onHandDelta = null;
    let lockedDelta = null;
    if (operation === "import_stage" && payload.inventoryApplied === false) {
      effectKnown = true;
      onHandDelta = 0;
      lockedDelta = 0;
    } else if (["upgrade_transfer_started", "upgrade_flow_update", "transit_import", "transit_import_revert", "transit_status", "transit_on_shelf", "transit_off_shelf", "transit_merge", "transit_delete", "transit_manual", "transit_team_corrected", "legacy_placeholder_removed", "upgrade_direct_start", "upgrade_direct_complete", "upgrade_relocation_started", "upgrade_relocation_procurement", "upgrade_relocation_operation", "upgrade_relocation_corrected", "upgrade_relocation_cancelled", "upgrade_relocation_created", "upgrade_relocation_complete", "upgrade_direct_start_withdraw", "upgrade_direct_complete_withdraw", "upgrade_relocation_shipment_withdraw", "upgrade_relocation_complete_withdraw"].includes(operation)) {
      effectKnown = true;
      onHandDelta = optionalPayloadNumber(payload.onHandDelta) ?? 0;
      lockedDelta = optionalPayloadNumber(payload.lockedDelta) ?? 0;
    } else if (sourceAvailable && operation === "legacy_import" && matchingLedger.length > 0) {
      effectKnown = true;
    } else if (sourceAvailable && expectedTypes.length > 0 && expectedTypes.every((type) => matchingLedger.some((entry) => entry.entry_type === type))) {
      effectKnown = true;
    }
    if (effectKnown && onHandDelta === null) {
      onHandDelta = matchingLedger.reduce((total, entry) => total + Number(entry.on_hand_delta), 0);
      lockedDelta = matchingLedger.reduce((total, entry) => total + Number(entry.locked_delta), 0);
    }

    const ledgerIds = matchingLedger.map((entry) => Number(entry.id));
    const relatedLedgerIds = [...new Set(matchingLedger
      .filter((entry) => entry.related_ledger_id != null)
      .map((entry) => Number(entry.related_ledger_id)))];
    const reversalGroups = [...new Set(matchingLedger
      .map((entry) => entry.reversal_group)
      .filter((value) => typeof value === "string" && value))];
    const payloadQuantity = optionalPayloadNumber(payload.quantity)
      ?? (operation === "transit_merge" ? optionalPayloadNumber(payload.quantityAfter) : undefined);
    const quantity = payloadQuantity ?? (row.quantity == null ? null : Number(row.quantity));
    const inTransitDelta = operation === "transit_on_shelf" ? -quantity : operation === "legacy_placeholder_removed"
      ? optionalPayloadNumber(payload.inTransitDelta) ?? 0
      : null;
    const payloadModels = Array.isArray(payload.models) ? payload.models.map((value) => String(value).trim()).filter(Boolean) : [];
    const model = row.model ?? payloadModel(payload) ?? (payloadModels.length === 1 ? payloadModels[0] : null);
    const category = model ? (this.getModel(model)?.category ?? payload.category ?? null) : (payload.category ?? null);
    const payloadTeams = Array.isArray(payload.teams) ? payload.teams.map((value) => String(value).trim()).filter(Boolean) : [];
    const team = String(row.currentTeam ?? row.department ?? payload.team ?? (payloadTeams.length === 1 ? payloadTeams[0] : payload.department ?? "")).trim() || undefined;
    const businessNo = operation === "upgrade_relocation_cancelled" ? payload.workNo : payload.upgradeNo ?? row.document_no ?? null;
    const documentId = sourceAvailable ? Number(row.document_id) : null;

    return {
      operation,
      eventType: row.event_type,
      eventId: Number(row.id),
      documentId,
      businessNo,
      model,
      category,
      quantity,
      onHandDelta,
      lockedDelta,
      inTransitDelta,
      availableDelta: effectKnown ? onHandDelta - lockedDelta : null,
      effectKnown,
      result: auditResult(operation, payload),
      ...(operation === "upgrade_relocation_corrected" ? {correction: {workNo:payload.workNo, before:payload.beforeLabel, after:payload.afterLabel}} : {}),
      role: row.role,
      at: row.occurred_at,
      reason: row.reason ?? null,
      ledgerIds,
      relatedLedgerIds,
      reversalGroup: reversalGroups[0] ?? null,
      sourceAvailable,
      /* 兼容旧库存流水页面与既有 API 调用方。 */
      action: operation,
      recordId: documentId ?? (row.legacy_record_id == null ? undefined : Number(row.legacy_record_id)),
      batch: payload.batch ?? row.batch_key ?? undefined,
      department: row.currentTeam ?? row.department ?? payload.department ?? undefined,
      team,
      store: payload.store ?? row.store_name ?? undefined,
      operator: payload.operator ?? row.operator_name ?? undefined,
    };
  }

  audit(filters = 100) {
    const options = typeof filters === "number" ? { limit: filters } : (filters ?? {});
    const requestedLimit = Number(options.limit ?? 100);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.trunc(requestedLimit), 500)) : 100;
    const action = String(options.action ?? options.operation ?? "").trim();
    if (action && !AUDIT_OPERATION_SET.has(action)) {
      throw new BusinessError(400, "invalid_audit_action", `未知库存流水分类“${action}”`);
    }

    const clauses = [`e.event_type IN (${[...AUDIT_OPERATION_SET].map(type=>`'${type}'`).join(',')})`];
    const parameters = [];
    if (action) {
      clauses.push("e.event_type = ?");
      parameters.push(action);
    }
    const businessNo = String(options.businessNo ?? "").trim();
    if (businessNo) {
      clauses.push("(d.document_no LIKE ? ESCAPE '\\' OR CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json, '$.upgradeNo') LIKE ? ESCAPE '\\' ELSE 0 END)");
      const pattern = `%${escapeLike(businessNo)}%`;
      parameters.push(pattern, pattern);
    }
    const model = String(options.model ?? "").trim();
    if (model) {
      clauses.push(`(
        d.model LIKE ? ESCAPE '\\'
        OR CASE WHEN json_valid(e.payload_json) THEN (
          (
            json_type(e.payload_json, '$.model') = 'text'
            AND json_extract(e.payload_json, '$.model') LIKE ? ESCAPE '\\'
          )
          OR (
            json_type(e.payload_json, '$.batch') = 'text'
            AND instr(json_extract(e.payload_json, '$.batch'), '#') > 0
            AND substr(json_extract(e.payload_json, '$.batch'), 1, instr(json_extract(e.payload_json, '$.batch'), '#') - 1) LIKE ? ESCAPE '\\'
          )
          OR (
            json_type(e.payload_json, '$.models') = 'array'
            AND EXISTS (SELECT 1 FROM json_each(e.payload_json, '$.models') WHERE CAST(value AS TEXT) LIKE ? ESCAPE '\\')
          )
        ) ELSE 0 END
      )`);
      const pattern = `%${escapeLike(model)}%`;
      parameters.push(pattern, pattern, pattern, pattern);
    }
    if (options.from) {
      clauses.push("e.occurred_at >= ?");
      parameters.push(String(options.from));
    }
    if (options.to) {
      clauses.push("e.occurred_at <= ?");
      parameters.push(String(options.to));
    }
    const visibleGroup = String(options.visibleGroup ?? "").trim();
    const scope = { scopeDirectByTeam: Boolean(options.scopeDirectByTeam) };

    return this.db.prepare(`
      SELECT e.*, d.document_no, d.model, d.batch_key, d.quantity,
             d.department, d.store_name, d.operator_name
      FROM document_events e
      LEFT JOIN allocation_documents d ON d.id = e.document_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY e.id DESC
    `).all(...parameters).map(row => this.scopeAuditRow(row, visibleGroup, scope)).filter(Boolean)
      .filter(row => !model || [this.auditRecord(row).model, ...((parseEventPayload(row.payload_json).models) ?? [])].some(value => String(value ?? "").toLowerCase().includes(model.toLowerCase())))
      .slice(0, limit).map(row => this.auditRecord(row));
  }

  auditDetail(eventId, visibleGroup = null, { scopeDirectByTeam = false } = {}) {
    const scope = { scopeDirectByTeam };
    const sourceRow = this.auditEventRow(eventId);
    const row = sourceRow && this.scopeAuditRow(sourceRow, visibleGroup, scope);
    if (sourceRow && !row) throw new BusinessError(403, "group_forbidden", `运营仅可查看本团（${visibleGroup}）库存流水`);
    if (!row) throw new BusinessError(404, "audit_event_not_found", `找不到库存流水事件 ${eventId}`);
    const record = this.auditRecord(row);
    const payload = parseEventPayload(row.payload_json);
    let rawUpgradeLedger = this.upgradeLedgerForAuditEvent(row);
    if (scopeDirectByTeam && visibleGroup && String(row.event_type).startsWith("upgrade_direct_")) {
      const teamsByBatch = this.stockBatchSourceTeams();
      rawUpgradeLedger = rawUpgradeLedger.filter(entry => teamsByBatch.get(entry.batch_key)?.size === 1 && teamsByBatch.get(entry.batch_key)?.has(visibleGroup));
    }
    const upgradeLedger = rawUpgradeLedger.map(rowToUpgradeLedgerEntry);
    const relatedUpgrade = payload.upgradeId == null ? null : this.getUpgrades({ visibleGroup, scopeDirectByTeam })
      .find(item => item.id === Number(payload.upgradeId)) ?? null;
    if (record.sourceAvailable) {
      const history = this.history(record.documentId);
      return {
        record,
        sourceAvailable: true,
        document: history.document,
        events: history.events.filter(event => !visibleGroup || this.scopeAuditRow({...event,document_id:record.documentId,department:history.document.department,payload_json:JSON.stringify(event.payload)},visibleGroup,scope)),
        ledger: upgradeLedger.length > 0 ? upgradeLedger : history.ledger,
        upgrade: relatedUpgrade,
        sync: this.syncState(),
      };
    }

    const relatedRows = row.legacy_record_id == null
      ? [row]
      : this.db.prepare(`
          SELECT * FROM document_events
          WHERE document_id IS NULL AND legacy_record_id = ?
          ORDER BY id
        `).all(row.legacy_record_id);
    return {
      record,
      sourceAvailable: false,
      events: relatedRows.map(item => this.scopeAuditRow(item, visibleGroup, scope)).filter(Boolean).map(rowToDocumentEvent),
      ledger: upgradeLedger,
      upgrade: relatedUpgrade,
      sync: this.syncState(),
    };
  }


  refreshTransitModel(model, at) {
    this.db.prepare(`
      UPDATE catalog_models
      SET in_transit = COALESCE((SELECT SUM(remaining_quantity) FROM transit_batches WHERE model = ? AND status = 'in_transit' AND voided_at IS NULL), 0),
          updated_at = ?, revision = revision + 1
      WHERE model = ?
    `).run(model, at, model);
  }

  createTransitPreviewToken({ kind, role, fileName, fileHash, templateHash, payload, ttlMs = 15 * 60 * 1000 }) {
    if (!TRANSIT_ROLE_SET.has(role)) throw new BusinessError(403, kind === "status" ? "transit_status_forbidden" : "transit_import_forbidden", kind === "status" ? "当前角色无权更新物流状态" : "当前角色无权导入在途库存");
    if (!['import','status','upgrade','transfer'].includes(kind)) throw new BusinessError(400, "invalid_preview_kind", "文件预览类型不正确，请重新上传文件");
    if (['upgrade','transfer'].includes(kind) && role!=='logistics') throw new BusinessError(403,'logistics_required','仅物流可导入升级模板');
    if (kind === "import") this.requireTransitImportTeams(role, payload.rows);
    return this.transaction(() => {
      const token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = sha256(token);
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + Math.max(30_000, Math.min(Number(ttlMs) || 15 * 60 * 1000, 60 * 60 * 1000)));
      const databaseId = this.syncState().databaseId;
      this.db.prepare("DELETE FROM transit_preview_tokens WHERE expires_at < ? OR consumed_at IS NOT NULL").run(createdAt.toISOString());
      this.db.prepare(`
        INSERT INTO transit_preview_tokens(token_hash, kind, role, database_id, file_name, file_sha256, template_sha256, payload_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(tokenHash, kind, role, databaseId, String(fileName), String(fileHash), String(templateHash), JSON.stringify(payload), createdAt.toISOString(), expiresAt.toISOString());
      return { token, expiresAt: expiresAt.toISOString() };
    });
  }

  consumeTransitPreviewToken({ token, kind, role, fileName, fileHash, templateHash, rows, consume = true }) {
    if (!TRANSIT_ROLE_SET.has(role)) throw new BusinessError(403, kind === "status" ? "transit_status_forbidden" : "transit_import_forbidden", kind === "status" ? "当前角色无权更新物流状态" : "当前角色无权导入在途库存");
    const rawToken = String(token ?? "").trim();
    if (!rawToken || rawToken.length > 256) throw new BusinessError(422, "preview_token_missing", "未找到文件预览，请重新上传文件");
    const tokenHash = sha256(rawToken);
    const stored = this.db.prepare("SELECT * FROM transit_preview_tokens WHERE token_hash = ?").get(tokenHash);
    if (!stored) throw new BusinessError(422, "preview_token_invalid", "文件预览已失效，请重新上传文件");
    if (stored.kind !== kind || stored.role !== role || stored.database_id !== this.syncState().databaseId) {
      throw new BusinessError(409, "preview_token_context_conflict", "当前角色或库存服务已改变，请重新上传文件并预览");
    }
    if (stored.consumed_at) throw new BusinessError(409, "preview_token_used", "这份预览已提交过，请先查看导入或更新结果");
    if (Date.parse(stored.expires_at) <= Date.now()) throw new BusinessError(422, "preview_token_expired", "文件预览已过期，请重新上传文件");
    if (fileName !== undefined && String(fileName) !== stored.file_name) throw new BusinessError(409, "preview_file_mismatch", "提交文件与预览文件不一致，请重新预览");
    if (fileHash !== undefined && String(fileHash) !== stored.file_sha256) throw new BusinessError(409, "preview_hash_mismatch", "文件内容与预览时不同，请重新上传文件");
    if (templateHash !== undefined && String(templateHash) !== stored.template_sha256) throw new BusinessError(409, "preview_template_mismatch", "文件表头与预览时不同，请重新上传文件");
    let snapshot;
    try { snapshot = JSON.parse(stored.payload_json); } catch { throw new BusinessError(500, "preview_token_corrupt", "无法读取之前的预览，请重新上传文件"); }
    const submitted = Array.isArray(rows) ? rows : [];
    const expectedRows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
    if (kind === "import") {
      const blockedErrors = expectedRows.flatMap((item) => Array.isArray(item?.errors) ? item.errors : [])
        .filter((error) => error && error.code !== "missing_team" && error.code !== "missing_version");
      if (blockedErrors.length > 0) {
        throw new BusinessError(422, "preview_validation_failed", "预览中还有错误，请按提示修改后再导入", { errors: blockedErrors.slice(0, 50), errorCount: blockedErrors.length });
      }
    }
    const normalizeRow = (item) => {
      if (['upgrade','transfer'].includes(kind)) return item;
      const data = item?.data ?? item ?? {};
      if (kind === "import") {
        return {
          sourceRow: Number(item?.sourceRow ?? data.sourceRow ?? 0),
          data: {
            model: String(data.model ?? "").trim(), quantity: Number(data.quantity ?? 0),
            fnsku: String(data.fnsku ?? "").trim(), shippingMethod: String(data.shippingMethod ?? "").trim(),
            plan: String(data.plan ?? "").trim(), date: String(data.date ?? "").trim(),
            rawDate: String(data.rawDate ?? "").trim(), team: String(data.team ?? "").trim(),
            version: String(data.version ?? "").trim(), packPerBox: String(data.packPerBox ?? data["套/箱"] ?? "").trim(), store: String(data.store ?? '').trim(),
          },
        };
      }
      return {
        sourceRow: Number(item?.sourceRow ?? data.sourceRow ?? 0),
        data: {
          plan: normalizeTransitPlan(data.plan ?? data.计划编号 ?? data.计划号 ?? data.发货计划号 ?? ""),
          status: String(data.status ?? data.logisticsStatus ?? data.物流状态 ?? "").trim(),
        },
      };
    };
    const actualRows = submitted.map(normalizeRow);
    if (kind === "import") {
      this.requireTransitImportTeams(role, expectedRows);
      this.requireTransitImportTeams(role, actualRows);
    }
    if (actualRows.length !== expectedRows.length) throw new BusinessError(409, "preview_rows_mismatch", "提交行数与预览结果不一致，请重新预览");
    for (let index = 0; index < expectedRows.length; index += 1) {
      const expected = normalizeRow(expectedRows[index]);
      const actual = actualRows[index];
      if (['upgrade','transfer'].includes(kind)) {
        if(stableJson(actual)!==stableJson(expected)) throw new BusinessError(409,'preview_rows_mismatch','提交数据与文件预览不一致');
        continue;
      }
      if (actual.sourceRow !== expected.sourceRow) throw new BusinessError(409, "preview_rows_mismatch", "提交源文件行与预览结果不一致，请重新预览");
      const keys = kind === "import"
        ? ["model", "quantity", "fnsku", "shippingMethod", "plan", "date", "rawDate", "team", "version", "packPerBox", "store"]
        : ["plan", "status"];
      if (keys.some((key) => actual.data[key] !== expected.data[key])) {
        throw new BusinessError(409, "preview_rows_mismatch", "提交的数据与预览不同，请重新上传文件");
      }
    }
    if (consume) {
      const consumed = this.db.prepare("UPDATE transit_preview_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL").run(new Date().toISOString(), tokenHash);
      if (Number(consumed.changes) !== 1) throw new BusinessError(409, "preview_token_used", "这份预览已提交过，请先查看导入或更新结果");
    }
    return { stored, snapshot, rows: actualRows };
  }

  requireTransitImportTeams(role, rows) {
    if (!TRANSIT_ROLE_SET.has(role)) throw new BusinessError(403, "transit_import_forbidden", "当前角色无权导入在途库存");
    const group = OPERATION_GROUPS[role];
    if (!group) return;
    for (const row of rows ?? []) {
      const team = String((row.data ?? row).team ?? "").trim();
      if (team && team !== group) throw new BusinessError(403, "transit_team_forbidden", `第 ${row.sourceRow} 行不属于${group}，整份文件未导入，请核对团队后重新上传。`);
    }
  }

  transitImport({ role, previewToken, fileName, fileHash, templateHash, rows, requestId }) {
    if (!TRANSIT_ROLE_SET.has(role)) throw new BusinessError(403, "transit_import_forbidden", "当前角色无权导入在途库存");
    this.requireTransitImportTeams(role, rows);
    return this.idempotent("transit:import", requestId, { role, previewToken, fileName, fileHash, templateHash, rows }, () => {
      const proof = this.consumeTransitPreviewToken({ kind: "import", role, token: previewToken, fileName, fileHash, templateHash, rows });
      fileName = proof.stored.file_name;
      fileHash = proof.stored.file_sha256;
      templateHash = proof.stored.template_sha256;
      rows = proof.rows;
      const importCategory = transitCategoryFromFileName(fileName);
      const databaseId = this.syncState().databaseId;
      if (!Array.isArray(rows) || rows.length === 0) throw new BusinessError(422, "empty_transit_import", "没有可导入的在途库存行");
      const at = new Date().toISOString();
      const sourceRows = new Set();
      const normalizedRows = [];
      const aggregateByIdentity = new Map();
      for (const item of rows) {
        const data = item?.data ?? item;
        const model = String(data.model ?? data.ITEM ?? "").trim();
        const plan = String(data.plan ?? data.计划号 ?? "").trim();
        const date = String(data.date ?? data.shipDate ?? data.出货时间 ?? "").trim();
        const version = String(data.version ?? data.版本号 ?? "").trim();
        const packPerBox = String(data.packPerBox ?? data["套/箱"] ?? "").trim();
        const fnsku = String(data.fnsku ?? data.FNSKU ?? "").trim();
        const quantity = Number(data.quantity ?? data.数量 ?? data.orderQuantity);
        const sourceRow = Number(item.sourceRow);
        const identity = [model, plan, date, version, fnsku, String(data.shippingMethod ?? data.发货方式 ?? "").trim()].join("#");
        if (!Number.isInteger(sourceRow) || sourceRow < 1) throw new BusinessError(422, "invalid_source_row", "导入行缺少有效源文件行号");
        if (sourceRows.has(sourceRow)) throw new BusinessError(422, "duplicate_source_row", `源文件行 ${sourceRow} 重复`);
        sourceRows.add(sourceRow);
        const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const calendarDate = dateMatch ? new Date(Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]))) : null;
        const validDate = Boolean(dateMatch && Number(dateMatch[1]) >= 1900 && Number(dateMatch[1]) <= 2200 && calendarDate && !Number.isNaN(calendarDate.getTime()) && calendarDate.getUTCFullYear() === Number(dateMatch[1]) && calendarDate.getUTCMonth() === Number(dateMatch[2]) - 1 && calendarDate.getUTCDate() === Number(dateMatch[3]));
        if (!validDate || !model || !plan || !version || !fnsku || !Number.isInteger(quantity) || quantity <= 0) {
          throw new BusinessError(422, "invalid_transit_row", `第 ${item.sourceRow ?? "?"} 行缺少有效型号、数量、计划号、日期、版本号或 FNSKU`);
        }
        const team = String(data.team ?? data.团队 ?? "").trim();
        if (!team) {
          throw new BusinessError(422, "missing_team", `第 ${sourceRow} 行团队不能为空`);
        }
        const catalog = this.getModel(model);
        const category = catalog?.category ?? importCategory;
        const expectedTeam = OPERATION_GROUPS[role];
        if (expectedTeam && team !== expectedTeam) {
          throw new BusinessError(422, "transit_team_forbidden", `第 ${sourceRow} 行团队“${team}”不属于当前角色${expectedTeam}`, { row: sourceRow, field: "团队", expectedTeam, actualTeam: team });
        }
        const normalized = {
          model, quantity, plan, date, version, fnsku,
          packPerBox, store: String(data.store ?? '').trim(),
          brand: "",
          transportMethod: "",
          shippingMethod: String(data.shippingMethod ?? data.发货方式 ?? "").trim(),
          team,
          logisticsStatus: "待更新物流状态",
          onShelfIndicator: "尚未确认",
        };
        if (!normalized.shippingMethod) throw new BusinessError(422, "missing_shipping_method", `第 ${sourceRow} 行发货方式不能为空`);
        const aggregate = aggregateByIdentity.get(identity);
        if (aggregate) {
          const conflictingField = [
            ["brand", "品牌"],
            ["transportMethod", "运输方式"],
            ["shippingMethod", "发货方式"],
            ["team", "团队"],
            ["packPerBox", "套/箱"],
            ["store", "店铺"],
          ].find(([field]) => String(aggregate.data[field] ?? "") !== String(normalized[field] ?? ""));
          if (conflictingField) {
            throw new BusinessError(422, "transit_duplicate_conflict", `第 ${sourceRow} 行与相同型号、计划号、日期、版本和 FNSKU 记录的${conflictingField[1]}不一致，不能合并`, {
              row: sourceRow,
              identity,
              field: conflictingField[0],
            });
          }
          aggregate.data.quantity += normalized.quantity;
          aggregate.sourceRows.push(sourceRow);
          aggregate.sourceItems.push({ sourceRow, data: normalized });
        } else {
          const entry = { sourceRow, sourceRows: [sourceRow], sourceItems: [{ sourceRow, data: { ...normalized } }], data: { ...normalized }, category };
          aggregateByIdentity.set(identity, entry);
          normalizedRows.push(entry);
        }
      }

      /* 同一五字段身份可跨文件追加数量；其他源业务字段冲突时仍拒绝，避免静默覆盖。 */
      this.resolveTransitIdentityMatches(normalizedRows, role);

      const duplicate = this.db.prepare("SELECT id FROM import_batches WHERE file_sha256 = ? AND import_kind = 'transit' AND inventory_applied = 1 AND status <> 'reverted'").get(fileHash);
      if (duplicate) throw new BusinessError(409, "duplicate_import_file", `该文件已入账（批次 ${duplicate.id}），不能重复导入`);
      const batch = this.db.prepare(`
        INSERT INTO import_batches(
          file_name, file_sha256, template_sha256, status, row_count, inventory_applied,
          created_by_role, created_at, database_id, client_session_id, snapshot_id, revert_request_id, replaces_import_id, import_kind
        ) VALUES (?, ?, ?, 'staged', ?, 0, ?, ?, ?, ?, NULL, NULL, NULL, 'transit')
      `).run(fileName, fileHash, templateHash, rows.length, role, at, databaseId, null);
      const importId = Number(batch.lastInsertRowid);

      const rowStmt = this.db.prepare("INSERT INTO import_rows(import_batch_id, source_row, payload_json) VALUES (?, ?, ?)");
      const transitStmt = this.db.prepare(`
        INSERT INTO transit_batches(
          model, quantity, remaining_quantity, plan, ship_date, version, fnsku, pack_per_box,
          brand, transport_method, shipping_method, team, logistics_status, on_shelf_indicator,
          status, import_batch_id, source_row, revision, created_at, updated_at, store_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_transit', ?, ?, 1, ?, ?, ?)
      `);
      const mergeTransitStmt = this.db.prepare(`
        UPDATE transit_batches
        SET quantity = quantity + ?, remaining_quantity = remaining_quantity + ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'in_transit' AND is_legacy_placeholder = 0 AND voided_at IS NULL
      `);
      const eventStmt = this.db.prepare(`
        INSERT INTO transit_events(transit_id, event_type, role, occurred_at, from_status, to_status, quantity, payload_json)
        VALUES (?, 'imported', ?, ?, ?, 'in_transit', ?, ?)
      `);
      const createCatalogStmt = this.db.prepare(`
        INSERT INTO catalog_models(model, category, base_in_stock, in_transit, updated_at, revision, created_by_import_id)
        VALUES (?, ?, 0, 0, ?, 1, ?)
      `);
      const inserted = [];
      const models = new Set();
      const categories = new Set();
      for (const item of normalizedRows) {
        const { sourceRow, sourceRows: itemSourceRows, sourceItems, data: normalized, category } = item;
        let catalog = this.getModel(normalized.model);
        if (!catalog) {
          createCatalogStmt.run(normalized.model, category, at, importId);
          catalog = this.getModel(normalized.model);
        }
        const isMerge = Number.isInteger(item.existingTransitId);
        let id;
        let revision;
        if (isMerge) {
          const result = mergeTransitStmt.run(normalized.quantity, normalized.quantity, at, item.existingTransitId, item.existingRevision);
          if (Number(result.changes) !== 1) throw new BusinessError(409, "transit_revision_conflict", `在途记录 #${item.existingTransitId} 已被更新，请重新预览并导入`);
          id = item.existingTransitId;
          revision = item.existingRevision + 1;
        } else {
          let result;
          try {
            result = transitStmt.run(
              normalized.model, normalized.quantity, normalized.quantity, normalized.plan, normalized.date, normalized.version, normalized.fnsku, normalized.packPerBox || null,
              normalized.brand, normalized.transportMethod, normalized.shippingMethod, normalized.team,
              normalized.logisticsStatus, normalized.onShelfIndicator, importId, sourceRow, at, at, normalized.store || null,
            );
          } catch (error) {
            /* 唯一索引是跨实例竞态的最终防线；把约束冲突转换成稳定的业务 409，
               不让第二个并发导入冒泡成不可诊断的 500。 */
            if (String(error?.code ?? "").startsWith("SQLITE_CONSTRAINT") || /UNIQUE constraint failed: transit_batches\./i.test(String(error?.message ?? ""))) {
              const identity = [normalized.model, normalized.plan, normalized.date, normalized.version, normalized.fnsku].join("#");
              throw new BusinessError(409, "duplicate_transit_identity", `第 ${sourceRow} 行已有相同型号、计划号、日期、版本和 FNSKU 的在途记录`, { row: sourceRow, identity });
            }
            throw error;
          }
          id = Number(result.lastInsertRowid);
          revision = 1;
        }
        for (const sourceItem of sourceItems) {
          rowStmt.run(importId, sourceItem.sourceRow, JSON.stringify({
            ...sourceItem.data,
            sourceRow: sourceItem.sourceRow,
            transitId: id,
            mergedIntoTransitId: isMerge ? id : null,
            mergedSourceRows: itemSourceRows,
          }));
        }
        eventStmt.run(id, role, at, isMerge ? "in_transit" : null, normalized.quantity, JSON.stringify({
          importId, operation: isMerge ? "transit_merge" : "transit_import", sourceRow, sourceRows: itemSourceRows,
          transitId: id, model: normalized.model, category: catalog.category, team: normalized.team,
          plan: normalized.plan, date: normalized.date, version: normalized.version, fnsku: normalized.fnsku, packPerBox: normalized.packPerBox,
        }));
        inserted.push({ id, sourceRow, sourceRows: itemSourceRows, merged: isMerge, ...normalized, statusCode: "in_transit", revision });
        models.add(normalized.model);
        categories.add(catalog.category);
      }
      for (const model of models) this.refreshTransitModel(model, at);
      this.db.prepare("UPDATE import_batches SET inventory_applied = 1 WHERE id = ?").run(importId);
      this.db.prepare(`
        INSERT INTO document_events(document_id, legacy_record_id, event_type, role, occurred_at, reason, payload_json)
        VALUES (NULL, NULL, 'transit_import', ?, ?, NULL, ?)
      `).run(role, at, JSON.stringify({
        importId, fileName, fileHash, templateHash, rowCount: inserted.length, sourceRowCount: rows.length,
        mergedRowCount: rows.length - inserted.length,
        quantity: inserted.reduce((sum, row) => sum + row.quantity, 0), onHandDelta: 0, lockedDelta: 0,
        transitIds: inserted.map((row) => row.id), models: inserted.map((row) => row.model),
        category: categories.size === 1 ? [...categories][0] : null, categories: [...categories],
        teams: [...new Set(inserted.map((row) => row.team).filter(Boolean))],
      }));
      return {
        ok: true, importId, status: "imported",
        rowCount: inserted.length, sourceRowCount: rows.length, mergedRowCount: rows.length - inserted.length,
        inventoryApplied: true, rows: inserted, sync: this.syncState(),
      };
    });
  }

  previewTransitStatusUpdates(rows, role) {
    const updates = [];
    const errors = [];
    const unmatchedPlans = [];
    if (!TRANSIT_ROLE_SET.has(role)) throw new BusinessError(403, "transit_status_forbidden", "当前角色无权更新物流状态");
    const byPlan = new Map();
    for (const item of rows ?? []) {
      const row = item?.data ?? item ?? {};
      const plan = normalizeTransitPlan(row.plan ?? row.计划编号 ?? row.计划号 ?? row.发货计划号 ?? "");
      const status = String(row.status ?? row.logisticsStatus ?? row.物流状态 ?? "").trim();
      const sourceRow = Number(item?.sourceRow ?? row.sourceRow ?? 0);
      if (!plan) {
        errors.push({ row: sourceRow, field: "计划编号", code: "missing_plan", message: `第 ${sourceRow} 行“计划编号”不能为空` });
        continue;
      }
      if (!status) {
        errors.push({ row: sourceRow, field: "物流状态", code: "empty_status", message: `第 ${sourceRow} 行物流状态不能为空` });
        continue;
      }
      /* 解析层已经按文件顺序折叠重复计划；这里再次按计划编号收口，避免直接调用时重复写入同一目标。 */
      byPlan.set(plan, { plan, status, sourceRow });
    }
    for (const { plan, status, sourceRow } of byPlan.values()) {
      const matches = this.db.prepare(`
        SELECT * FROM transit_batches
        WHERE plan = ? AND status = 'in_transit' AND remaining_quantity > 0
          AND voided_at IS NULL AND is_legacy_placeholder = 0
        ORDER BY id
      `).all(plan);
      if (matches.length === 0) {
        unmatchedPlans.push(plan);
        continue;
      }
      const expectedTeam = OPERATION_GROUPS[role];
      const unauthorized = matches.find((matched) => {
        const catalog = this.getModel(matched.model);
        return expectedTeam && matched.team !== expectedTeam;
      });
      if (unauthorized) {
        errors.push({ row: sourceRow, field: "团队", code: "transit_team_forbidden", message: `第 ${sourceRow} 行计划“${plan}”包含其他团队“${unauthorized.team || "未填写"}”，不属于当前角色${expectedTeam}` });
        continue;
      }
      for (const matched of matches) {
        updates.push({
          sourceRow, id: Number(matched.id), revision: Number(matched.revision), model: matched.model, plan: matched.plan,
          date: matched.ship_date, version: matched.version, fnsku: matched.fnsku,
          currentStatus: matched.logistics_status, status, quantity: Number(matched.remaining_quantity),
        });
      }
    }
    const matchedPlanCount = new Set(updates.map((item) => item.plan)).size;
    return { updates, errors, unmatchedPlans, unmatchedPlanCount: unmatchedPlans.length, matchedPlanCount, canApply: errors.length === 0 && updates.length > 0 };
  }

  updateTransitStatuses({ role, previewToken, rows, requestId, fileHash = undefined, templateHash = undefined, fileName = undefined }) {
    if (!TRANSIT_ROLE_SET.has(role)) throw new BusinessError(403, "transit_status_forbidden", "当前角色无权更新物流状态");
    return this.idempotent("transit:status", requestId, { role, previewToken, rows, fileHash, templateHash, fileName }, () => {
      const proof = this.consumeTransitPreviewToken({ kind: "status", role, token: previewToken, rows, fileName, fileHash, templateHash });
      const updates = Array.isArray(proof.snapshot.updates) ? proof.snapshot.updates : [];
      if (updates.length === 0) throw new BusinessError(422, "transit_status_validation_failed", "物流状态更新校验失败，未更新任何记录");
      const at = new Date().toISOString();
      const applied = [];
      const models = new Set();
      const categories = new Set();
      const unmatchedPlans = Array.isArray(proof.snapshot.unmatchedPlans) ? proof.snapshot.unmatchedPlans.map((plan) => normalizeTransitPlan(plan)).filter(Boolean) : [];
      const processedPlanCount = Array.isArray(proof.snapshot.rows) ? proof.snapshot.rows.length : new Set(updates.map((item) => normalizeTransitPlan(item.plan))).size + unmatchedPlans.length;
      const matchedPlanCount = new Set(updates.map((item) => normalizeTransitPlan(item.plan))).size;
      for (const item of updates) {
        const current = this.db.prepare("SELECT * FROM transit_batches WHERE id = ?").get(Number(item.id));
        if (!current || current.status !== "in_transit" || current.voided_at || Number(current.remaining_quantity) <= 0 || Number(current.is_legacy_placeholder) !== 0) {
          throw new BusinessError(409, "transit_concurrent_update", `在途记录 ${item.id} 已被其他操作更新，请重新预览`);
        }
        if (Number(current.revision) !== Number(item.revision)) {
          throw new BusinessError(409, "transit_stale_revision", `在途记录 ${item.id} 已被其他操作更新，请重新预览`, { currentRevision: Number(current.revision) });
        }
        const catalog = this.getModel(current.model);
        if (catalog?.category) categories.add(catalog.category);
        const expectedTeam = OPERATION_GROUPS[role];
        if (expectedTeam && current.team !== expectedTeam) {
          throw new BusinessError(403, "transit_team_forbidden", `第 ${item.sourceRow ?? "?"} 行团队“${current.team || "未填写"}”不属于当前角色${expectedTeam}`);
        }
        const result = this.db.prepare(`
          UPDATE transit_batches SET logistics_status = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'in_transit' AND remaining_quantity > 0 AND voided_at IS NULL AND is_legacy_placeholder = 0
        `).run(String(item.status).trim(), at, Number(item.id), Number(item.revision));
        if (Number(result.changes) !== 1) throw new BusinessError(409, "transit_concurrent_update", `在途记录 ${item.id} 已被其他操作更新，请重新预览`);
        this.db.prepare(`
          INSERT INTO transit_events(transit_id, event_type, role, occurred_at, from_status, to_status, quantity, payload_json)
          VALUES (?, 'status_updated', ?, ?, ?, ?, 0, ?)
        `).run(Number(item.id), role, at, current.logistics_status, String(item.status).trim(), JSON.stringify({
          fileHash: proof.stored.file_sha256, sourceRow: item.sourceRow, transitId: Number(item.id), model: current.model,
          category: catalog?.category ?? null, team: current.team, plan: current.plan, date: current.ship_date,
          version: current.version, fnsku: current.fnsku,
        }));
        models.add(current.model);
        applied.push({ ...item, model: current.model, currentStatus: current.logistics_status, revision: Number(item.revision) + 1 });
      }
      for (const model of models) this.refreshTransitModel(model, at);
      this.db.prepare(`
        INSERT INTO document_events(document_id, legacy_record_id, event_type, role, occurred_at, reason, payload_json)
        VALUES (NULL, NULL, 'transit_status', ?, ?, NULL, ?)
      `).run(role, at, JSON.stringify({
        fileHash: proof.stored.file_sha256, templateHash: proof.stored.template_sha256, fileName: proof.stored.file_name,
        rowCount: applied.length, onHandDelta: 0, lockedDelta: 0,
        transitIds: applied.map((item) => Number(item.id)), models: applied.map((item) => item.model),
        category: categories.size === 1 ? [...categories][0] : null, categories: [...categories],
        teams: [...new Set(applied.map((item) => String(this.getTransit(item.id)?.team ?? "").trim()).filter(Boolean))],
        processedPlanCount, matchedPlanCount, updatedDetailCount: applied.length,
        unmatchedPlanCount: unmatchedPlans.length, unmatchedPlans,
      }));
      return {
        ok: true, updated: applied, rowCount: applied.length,
        processedPlanCount, matchedPlanCount, updatedDetailCount: applied.length,
        unmatchedPlanCount: unmatchedPlans.length, unmatchedPlans,
      };
    });
  }




  resolveTransitIdentityMatches(normalizedRows, role) {
    for (const item of normalizedRows) {
      const normalized = item.data;
      const existingRows = this.db.prepare(`
        SELECT * FROM transit_batches
        WHERE model = ? AND plan = ? AND ship_date = ? AND version = ? AND fnsku = ? AND shipping_method = ?
          AND status = 'in_transit' AND is_legacy_placeholder = 0 AND remaining_quantity > 0 AND voided_at IS NULL
        ORDER BY id
      `).all(normalized.model, normalized.plan, normalized.date, normalized.version, normalized.fnsku, normalized.shippingMethod);
      for (const existing of existingRows) requireDepartment(role, existing.team);
      if (existingRows.length > 1) {
        throw new BusinessError(409, "duplicate_transit_identity_ambiguous", `相同型号、计划号、日期、版本和 FNSKU 对应多条在途记录（${existingRows.map((row) => `#${row.id}`).join(", ")}），请先核对重复记录`, {
          identity: [normalized.model, normalized.plan, normalized.date, normalized.version, normalized.fnsku].join("#"),
          transitIds: existingRows.map((row) => Number(row.id)),
        });
      }
      const existing = existingRows[0] ?? null;
      if (!existing) {
        delete item.existingTransitId;
        delete item.existingRevision;
        continue;
      }
      const conflictingField = [
        ["brand", "品牌"],
        ["transport_method", "运输方式"],
        ["shipping_method", "发货方式", "shippingMethod"],
        ["team", "团队"],
        ["pack_per_box", "套/箱", "packPerBox"],
        ["store_name", "店铺", "store"],
      ].find(([dbField, , normalizedField = dbField]) => String(existing[dbField] ?? "") !== String(normalized[normalizedField] ?? ""));
      if (conflictingField) {
        throw new BusinessError(422, "transit_duplicate_conflict", `在途记录 #${existing.id} 的${conflictingField[1]}与待合并行不一致，不能合并`, {
          transitId: Number(existing.id), field: conflictingField[2],
        });
      }
      item.existingTransitId = Number(existing.id);
      item.existingRevision = Number(existing.revision);
    }
    return normalizedRows;
  }


  transitImportRows(importId) {
    return this.db.prepare('SELECT * FROM import_rows WHERE import_batch_id = ? ORDER BY source_row').all(importId).map(row => {
      const payload = parseEventPayload(row.payload_json);
      const transit = this.getTransit(Number(row.current_transit_id ?? payload.transitId ?? payload.mergedIntoTransitId))
        ?? this.db.prepare('SELECT * FROM transit_batches WHERE import_batch_id = ? AND source_row = ?').get(importId, row.source_row);
      return {...row, payload, transit, team:transit?.team ?? payload.team ?? payload.department ?? ''};
    });
  }

  listTransitImports(role) {
    if (!TRANSIT_ROLE_SET.has(role)) throw new BusinessError(403, "transit_import_forbidden", "当前角色无权查看导入批次");
    const group = OPERATION_GROUPS[role];
    const imports = this.db.prepare(`
      SELECT id, file_name, file_sha256, template_sha256, status, row_count, inventory_applied, created_by_role, created_at, replaces_import_id
      FROM import_batches ORDER BY id DESC
    `).all();
    const visible = [];
    for (const row of imports) {
      const rowCount = group ? this.transitImportRows(row.id).filter(item => item.team === group).length : Number(row.row_count);
      if (group && rowCount === 0) continue;
      visible.push({
      id: Number(row.id), fileName: row.file_name, fileSha256: row.file_sha256, templateSha256: row.template_sha256,
      status: row.inventory_applied ? "imported" : row.status, rowCount, inventoryApplied: Boolean(row.inventory_applied),
      active: row.status !== "reverted" && Boolean(row.inventory_applied), createdByRole: row.created_by_role, createdAt: row.created_at,
      replacesImportId: row.replaces_import_id == null ? null : Number(row.replaces_import_id),
      });
      if (visible.length === 100) break;
    }
    return visible;
  }




  getTransit(id) {
    return this.db.prepare("SELECT * FROM transit_batches WHERE id = ?").get(id) ?? null;
  }

  markTransitOnShelf({ id, role, expectedRevision, requestId, yes }) {
    return this.idempotent(`transit:on-shelf:${id}`, requestId, { id, role, expectedRevision, yes }, () => {
      if (!TRANSIT_SHELF_ROLE_SET.has(role)) throw new BusinessError(403, "transit_on_shelf_forbidden", "仅管理员或助理可执行上架");
      if (String(yes ?? "").trim() !== "YES") throw new BusinessError(422, "invalid_yes", "请点击“确认上架”完成上架");
      if (!Number.isInteger(Number(expectedRevision))) throw new BusinessError(400, "missing_revision", "当前记录信息不完整，请重新加载后操作");
      const current = this.db.prepare("SELECT * FROM transit_batches WHERE id = ?").get(id);
      if (!current) throw new BusinessError(404, "transit_not_found", `找不到在途记录 ${id}`);
      if (current.voided_at) throw new BusinessError(409, "transit_deleted", "该在途记录已删除，不能再次上架");
      if (Number(current.is_legacy_placeholder) === 1) throw new BusinessError(409, "legacy_transit_not_actionable", "历史汇总在途没有可操作明细，请先补充来源文件");
      if (Number(current.revision) !== Number(expectedRevision)) throw new BusinessError(409, "transit_stale_revision", "在途记录已被其他操作更新，请刷新后重试", { currentRevision: Number(current.revision) });
      if (current.status !== "in_transit" || Number(current.remaining_quantity) <= 0) throw new BusinessError(409, "transit_already_on_shelf", "该在途记录已上架或没有可转数量");
      const catalog = this.getModel(current.model);
      if (!catalog) throw new BusinessError(500, "catalog_missing", `型号 ${current.model} 不存在于库存目录`);
      const expectedTeam = OPERATION_GROUPS[role];
      if (expectedTeam && current.team !== expectedTeam) {
        throw new BusinessError(403, "transit_team_forbidden", `该在途记录属于${current.team || "未填写"}，当前角色仅可操作${expectedTeam}`, { field: "团队", expectedTeam, actualTeam: current.team || "" });
      }
      const at = new Date().toISOString();
      const before = this.db.prepare(`SELECT
        COALESCE((SELECT SUM(on_hand) FROM stock_balances WHERE model=?),0) AS inStock,
        COALESCE((SELECT SUM(remaining_quantity) FROM transit_batches WHERE model=? AND status='in_transit' AND voided_at IS NULL),0) AS inTransit`).get(current.model,current.model);
      const quantity = Number(current.remaining_quantity);
      const directFba = current.shipping_method === '直发FBA';
      let targetBatchKey = null, fbaArchiveId = null;
      if (directFba) {
        const archived = this.db.prepare(`INSERT INTO fba_archives(transit_id,model,quantity,plan,ship_date,version,fnsku,team,shipping_method,archived_at,archived_by_role,store_name,pack_per_box)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,current.model,quantity,current.plan,current.ship_date,current.version,current.fnsku,current.team,current.shipping_method,at,role,current.store_name,current.pack_per_box);
        fbaArchiveId = Number(archived.lastInsertRowid);
      } else {
        targetBatchKey = this.ensureStockBatch(current, current.version, at, current.shipping_method).batch_key;
        const ledgerWatermark = Number(this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM inventory_ledger").get().id);
        this.db.prepare(`
        INSERT INTO stock_receipts(transit_id, batch_key, quantity, created_by_role, created_at, request_id, ledger_watermark)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, targetBatchKey, quantity, role, at, requestId, ledgerWatermark);
      }
      const updated = this.db.prepare(`
        UPDATE transit_batches
        SET remaining_quantity = 0, status = 'on_shelf', on_shelf_indicator = 'YES', on_shelf_by_role = ?, on_shelf_at = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'in_transit' AND remaining_quantity > 0 AND voided_at IS NULL
      `).run(role, at, at, id, expectedRevision);
      if (Number(updated.changes) !== 1) throw new BusinessError(409, "transit_concurrent_update", "在途记录已被其他操作更新，请刷新后重试");
      this.db.prepare(`
        INSERT INTO transit_events(transit_id, event_type, role, occurred_at, from_status, to_status, quantity, payload_json)
        VALUES (?, 'on_shelf', ?, ?, 'in_transit', 'on_shelf', ?, ?)
      `).run(id, role, at, quantity, JSON.stringify({ batchKey: targetBatchKey, fbaArchiveId, disposition: directFba ? 'fba_archive' : 'warehouse_receipt', shippingMethod: current.shipping_method, model: current.model, category: catalog.category, team: current.team, plan: current.plan, date: current.ship_date, version: current.version, fnsku: current.fnsku }));
      this.refreshTransitModel(current.model, at);
      this.db.prepare(`
        INSERT INTO document_events(document_id, legacy_record_id, event_type, role, occurred_at, reason, payload_json)
        VALUES (NULL, NULL, 'transit_on_shelf', ?, ?, NULL, ?)
      `).run(role, at, JSON.stringify({ transitId: id, fbaArchiveId, disposition: directFba ? 'fba_archive' : 'warehouse_receipt', shippingMethod: current.shipping_method, model: current.model, category: catalog.category, team: current.team, batch: targetBatchKey, quantity, onHandDelta: directFba ? 0 : quantity, lockedDelta: 0 }));
      const after = {inStock:before.inStock+(directFba ? 0 : quantity),inTransit:before.inTransit-quantity};
      return {
        ok: true, transitId: id, batchKey: targetBatchKey, fbaArchiveId, disposition: directFba ? 'fba_archive' : 'warehouse_receipt', quantity, record: { ...current, remaining_quantity: 0, status: "on_shelf", on_shelf_indicator: "YES", revision: Number(expectedRevision) + 1 },
        before: before ? { inStock: Number(before.inStock), inTransit: Number(before.inTransit), total: Number(before.inStock) + Number(before.inTransit) } : null,
        after: after ? { inStock: Number(after.inStock), inTransit: Number(after.inTransit), total: Number(after.inStock) + Number(after.inTransit) } : null,
      };
    });
  }




}

export function hashBuffer(buffer) {
  return sha256(buffer);
}

export function hashTemplate(headers) {
  return sha256(stableJson(headers.map((item) => String(item).trim())));
}
