// Migrate a synthetic schema26 fixture and compare every historical business table.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateInventoryDatabaseToCurrent, InventoryDatabase, INVENTORY_DATABASE_NAME } from "../inventory-db.mjs";
import { createSchema26Fixture } from "./fixtures/schema26-fixture.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "aster-migrate-check-"));
const sourceState = path.join(root, "source");
const destinationState = path.join(root, "migrated");
const destination = path.join(destinationState, "data", INVENTORY_DATABASE_NAME);
const previousPrivatePath = process.env.ASTER_PRIVATE_INBOUND_SOURCES;
let before = null;
let after = null;

try {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const fixture = await createSchema26Fixture(sourceState);
  await fs.copyFile(fixture.databasePath, destination);
  process.env.ASTER_PRIVATE_INBOUND_SOURCES = fixture.privateDataPath;
  before = new DatabaseSync(fixture.databasePath, { readOnly: true });
  assert.equal(before.prepare("PRAGMA user_version").get().user_version, 26);
  assert.deepEqual(before.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(before.prepare("SELECT COUNT(*) n FROM import_rows").get().n, 47);
  assert.equal(before.prepare("SELECT COUNT(*) n FROM transit_batches").get().n, 47);
  assert.equal(before.prepare("SELECT COUNT(*) n FROM stock_batches").get().n, 47);
  assert.equal(before.prepare("SELECT COUNT(*) n FROM inquiry_events").get().n, 1);

  const migration = migrateInventoryDatabaseToCurrent({ databasePath: destination });
  after = new InventoryDatabase(destinationState);
  const tables = before.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const preserved = [];
  for (const { name } of tables) {
    if (["schema_migrations", "system_meta"].includes(name)) continue;
    const oldRows = before.prepare(`SELECT * FROM "${name}"`).all();
    const columns = before.prepare(`PRAGMA table_info("${name}")`).all().map(column => `"${column.name}"`).join(",");
    const newRows = after.db.prepare(`SELECT ${columns} FROM "${name}"`).all();
    const fromVersion = Number(before.prepare("PRAGMA user_version").get().user_version);

    if (name === "inquiry_documents" && fromVersion < 27) {
      for (const row of oldRows) if (row.supplier_quantity !== null) {
        const updated = newRows.find(candidate => candidate.id === row.id);
        assert.equal(updated.requested_quantity, row.supplier_quantity);
        row.requested_quantity = row.supplier_quantity;
      }
    }
    if (name === "transit_batches") for (const row of oldRows) {
      const correction = migration.sourceInventory?.transitChanges.find(item => item.id === row.id);
      if (!correction) continue;
      assert.equal(row.pack_per_box, correction.before);
      const updated = newRows.find(candidate => candidate.id === row.id);
      assert.equal(updated.pack_per_box, correction.after);
      row.pack_per_box = correction.after;
    }
    if (name === "stock_batches") for (const row of oldRows) {
      const correction = migration.sourceInventory?.stockChanges.find(item => item.batchKey === row.batch_key);
      if (!correction) continue;
      assert.equal(row.pack_per_box, correction.before);
      const updated = newRows.find(candidate => candidate.batch_key === row.batch_key);
      assert.equal(updated.pack_per_box, correction.after);
      row.pack_per_box = correction.after;
    }
    assert.deepEqual(newRows, oldRows, `migration altered ${name}`);
    if (oldRows.length) preserved.push({ table: name, rows: oldRows.length });
  }

  after.assertInventoryInvariants();
  const foreignKeys = after.db.prepare("PRAGMA foreign_key_check").all();
  const quickCheck = after.db.prepare("PRAGMA quick_check").get().quick_check;
  assert.deepEqual(foreignKeys, []);
  assert.equal(quickCheck, "ok");
  assert.equal(migration.fromVersion, 26);
  assert.equal(migration.toVersion, 34);
  assert.equal(migration.sourceInventory?.verifiedTransitRows, 47);
  assert.equal(migration.sourceInventory.transitChanges.length, 47);
  assert.equal(migration.sourceInventory.stockChanges.length, 47);
  assert.equal(migration.sourceInventory.teamChanges.length, 47);
  console.log(JSON.stringify({
    kind: "synthetic-schema26-migration",
    fromVersion: migration.fromVersion,
    toVersion: migration.toVersion,
    preserved,
    verifiedSourceRows: migration.sourceInventory.verifiedTransitRows,
    transitCorrections: migration.sourceInventory.transitChanges.length,
    stockCorrections: migration.sourceInventory.stockChanges.length,
    teamAssignments: migration.sourceInventory.teamChanges.length,
    foreignKeys,
    quickCheck,
  }, null, 2));
} finally {
  before?.close();
  after?.close();
  if (previousPrivatePath === undefined) delete process.env.ASTER_PRIVATE_INBOUND_SOURCES;
  else process.env.ASTER_PRIVATE_INBOUND_SOURCES = previousPrivatePath;
  assert.equal(path.dirname(root), os.tmpdir());
  await fs.rm(root, { recursive: true, force: true });
}
