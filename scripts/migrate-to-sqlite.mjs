import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInventoryDatabase,
  InventoryDatabase,
  INVENTORY_DATABASE_NAME,
  INVENTORY_SCHEMA_VERSION,
} from "../inventory-db.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const stateRoot = path.resolve(option("--state-root") || projectRoot);
const backupRoot = path.resolve(option("--backup-root") || path.join(stateRoot, "backups"));
const verifyOnly = args.includes("--verify");
const dataDir = path.join(stateRoot, "data");
const databasePath = path.join(dataDir, INVENTORY_DATABASE_NAME);

const stamp = () => {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

const hashFile = async (file) => {
  const buffer = await fs.readFile(file);
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
};

const exists = async (file) => fs.access(file).then(() => true).catch(() => false);

if (verifyOnly) {
  const database = new InventoryDatabase(stateRoot);
  try {
    console.log(JSON.stringify({ ok: true, databasePath, sync: database.syncState(), catalog: database.getCatalog().models }, null, 2));
  } finally {
    database.close();
  }
  process.exit(0);
}

if (await exists(databasePath)) {
  throw new Error(`统一库存数据库已存在，拒绝重复迁移：${databasePath}；如需检查请使用 --verify`);
}

await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `${stamp()}-pre-sqlite-v${INVENTORY_SCHEMA_VERSION}`);
await fs.mkdir(backupPath, { recursive: false });

const sourceFiles = [
  path.join(stateRoot, "config.json"),
  path.join(dataDir, "permissions.json"),
  path.join(dataDir, "allocation-records.json"),
  path.join(dataDir, "allocation-audit.log"),
];
const manifest = [];
for (const source of sourceFiles) {
  if (!(await exists(source))) continue;
  const relativePath = path.relative(stateRoot, source).replaceAll("\\", "/");
  const destination = path.join(backupPath, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  const stat = await fs.stat(source);
  manifest.push({ relativePath, backupPath: path.relative(backupPath, destination).replaceAll("\\", "/"), size: stat.size, sha256: await hashFile(destination) });
}

await fs.writeFile(
  path.join(backupPath, "backup-manifest.json"),
  `${JSON.stringify({ schemaVersion: INVENTORY_SCHEMA_VERSION, sourceSchemaVersion: "legacy-json", preflightQuickCheck: "not-applicable", createdAt: new Date().toISOString(), stateRoot, files: manifest }, null, 2)}\n`,
  "utf8",
);

const recordsPath = path.join(dataDir, "allocation-records.json");
const auditPath = path.join(dataDir, "allocation-audit.log");
const legacyStore = await exists(recordsPath)
  ? JSON.parse((await fs.readFile(recordsPath, "utf8")).replace(/^\uFEFF/, ""))
  : { meta: { nextId: 1, fnskuSeq: 1 }, batches: {} };
const auditLines = await exists(auditPath)
  ? (await fs.readFile(auditPath, "utf8")).split(/\r?\n/).filter((line) => line.trim())
  : [];
const legacyAudit = auditLines.map((line, index) => {
  try {
    return JSON.parse(line);
  } catch {
    return { action: "legacy_raw", role: "legacy", at: new Date().toISOString(), raw: line, sourceLine: index + 1 };
  }
});

const temporaryPath = `${databasePath}.new-${process.pid}`;
let migration;
try {
  migration = createInventoryDatabase({ databasePath: temporaryPath, legacyStore, legacyAudit });
  await fs.rename(temporaryPath, databasePath);
  migration.databasePath = databasePath;
} catch (error) {
  await fs.rm(temporaryPath, { force: true }).catch(() => {});
  throw error;
}

const database = new InventoryDatabase(stateRoot);
let verification;
try {
  const catalog = database.getCatalog();
  verification = {
    sync: database.syncState(),
    models: catalog.models,
    allocationCounts: Object.fromEntries(catalog.models.map((model) => {
      const records = database.getAllocations(model.model).records;
      return [model.model, Object.values(records).flat().length];
    })),
  };
} finally {
  database.close();
}

const report = {
  schemaVersion: INVENTORY_SCHEMA_VERSION,
  status: "migrated",
  migratedAt: new Date().toISOString(),
  stateRoot,
  databasePath,
  databaseSha256: await hashFile(databasePath),
  backupPath,
  legacyFilesRetained: true,
  migration,
  verification,

};
await fs.writeFile(path.join(backupPath, "migration-result.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(dataDir, "sqlite-migration-result.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
