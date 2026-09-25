import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { syntheticInboundRows } from "./generate-synthetic-workbook.mjs";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(fixtureDirectory, "schema26.sql");
const model = "SYNTH-ITEM-001";
const timestamp = "2026-01-01T00:00:00.000Z";
const sourceFileSha256 = crypto.createHash("sha256").update("synthetic-schema26-inbound-import").digest("hex").toUpperCase();

export async function createSchema26Fixture(stateRoot) {
  const databaseDirectory = path.join(stateRoot, "data");
  const databasePath = path.join(databaseDirectory, "aster-inventory.sqlite");
  const privateDataPath = path.join(stateRoot, "legacy-inbound-sources.synthetic.json");
  const rows = syntheticInboundRows(47).map((row, index) => ({
    ...row,
    sourceRow: index + 1,
    packPerBox: String(2 + index % 5),
  }));
  const expectedImport = {
    fileSha256: sourceFileSha256,
    rows: rows.map(({ sourceRow, model, quantity, fnsku, shippingMethod, plan, date, team, version, packPerBox }) => ({
      sourceRow, model, quantity, fnsku, shippingMethod, plan, date, team, version, packPerBox,
    })),
  };

  await fs.mkdir(databaseDirectory, { recursive: true });
  await fs.writeFile(privateDataPath, `${JSON.stringify({ schemaVersion: 1, imports: [expectedImport] }, null, 2)}\n`);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(await fs.readFile(schemaPath, "utf8"));
    const migrations = db.prepare("INSERT INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)");
    for (let version = 1; version <= 26; version += 1) migrations.run(version, timestamp, "synthetic schema fixture");
    db.prepare("INSERT INTO system_meta(key,value) VALUES('database_id','synthetic-schema26')").run();
    db.prepare("INSERT INTO system_meta(key,value) VALUES('data_version','0')").run();
    db.prepare("INSERT INTO system_meta(key,value) VALUES('updated_at',?)").run(timestamp);
    db.prepare(`INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at)
      VALUES(?, '硒鼓', 0, ?, ?)`)
      .run(model, rows.reduce((sum, row) => sum + row.quantity, 0), timestamp);
    const batchId = Number(db.prepare(`INSERT INTO import_batches(
      file_name,file_sha256,template_sha256,status,row_count,inventory_applied,created_by_role,created_at,import_kind
    ) VALUES(?, ?, ?, 'staged', ?, 1, 'admin', ?, 'transit')`).run(
      "synthetic-inbound.xlsx", sourceFileSha256, "b".repeat(64), rows.length, timestamp,
    ).lastInsertRowid);
    const insertTransit = db.prepare(`INSERT INTO transit_batches(
      model,quantity,remaining_quantity,plan,ship_date,version,fnsku,shipping_method,team,
      logistics_status,on_shelf_indicator,import_batch_id,source_row,created_at,updated_at,pack_per_box
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'synthetic-status', 'synthetic-indicator', ?, ?, ?, ?, NULL)`);
    const insertImportRow = db.prepare(`INSERT INTO import_rows(import_batch_id,source_row,payload_json,current_transit_id)
      VALUES(?,?,?,?)`);
    const insertStock = db.prepare(`INSERT INTO stock_batches(
      batch_key,model,plan,ship_date,version,fnsku,base_quantity,updated_at,created_by_transit_id,warehouse,pack_per_box
    ) VALUES(?,?,?,?,?,?,0,?,?,?,NULL)`);
    for (const row of rows) {
      const transitId = Number(insertTransit.run(
        row.model, row.quantity, row.quantity, row.plan, row.date, row.version, row.fnsku,
        row.shippingMethod, row.team, batchId, row.sourceRow, timestamp, timestamp,
      ).lastInsertRowid);
      const payload = {
        sourceRow: row.sourceRow,
        model: row.model,
        quantity: row.quantity,
        fnsku: row.fnsku,
        shippingMethod: row.shippingMethod,
        plan: row.plan,
        date: row.date,
        team: row.team,
        version: row.version,
      };
      insertImportRow.run(batchId, row.sourceRow, JSON.stringify(payload), transitId);
      insertStock.run(
        `SYNTH-BATCH-${String(row.sourceRow).padStart(3, "0")}`,
        row.model, row.plan, row.date, row.version, row.fnsku, timestamp, transitId,
        row.shippingMethod === "直发FBA" ? "SyntheticFBA" : "SyntheticWarehouse",
      );
    }

    db.prepare(`INSERT INTO inquiry_documents(
      document_no,model,asin,fnsku,requested_quantity,approved_quantity,supplier_quantity,department,
      store_name,operator_name,status,created_by_role,created_at,archived_by_role,archived_at,updated_at
    ) VALUES('SYNTH-INQ-0001', ?, 'TEST-ASIN-0001', 'TEST-FNSKU-0001', 99, 50, 20, '一团',
      'SyntheticStore', 'SyntheticOperator', 'archived', 'operation-1', ?, 'assistant-1', ?, ?)`)
      .run(model, timestamp, timestamp, timestamp);
    db.prepare(`INSERT INTO inquiry_events(inquiry_id,event_type,role,occurred_at,payload_json)
      VALUES(1,'synthetic-entry','operation-1',?,'{"requestedQuantity":99}')`).run(timestamp);
    db.exec("PRAGMA user_version = 26");

    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
    if (integrity !== "ok" || foreignKeyErrors.length !== 0) throw new Error("Generated schema26 fixture failed SQLite integrity checks.");
  } finally {
    db.close();
  }
  return { databasePath, privateDataPath, rows };
}
