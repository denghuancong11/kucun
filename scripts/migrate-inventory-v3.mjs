/*
 * 受控旧版本 -> 当前 schema 迁移。
 * 先用 SQLite VACUUM INTO 生成一致性快照，再在原库上执行事务迁移；
 * 任何重复身份或完整性错误都会使迁移非零退出，绝不删除/合并历史行。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { INVENTORY_DATABASE_NAME, INVENTORY_SCHEMA_VERSION, migrateInventoryDatabaseToCurrent } from "../inventory-db.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const stateRoot = path.resolve(option("--state-root") || process.env.ASTER_STATE_ROOT || projectRoot);
const dataDir = path.join(stateRoot, "data");
const databasePath = path.join(dataDir, INVENTORY_DATABASE_NAME);
const backupRoot = path.resolve(option("--backup-root") || path.join(stateRoot, "backups"));
const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
const backupPath = path.join(backupRoot, `${stamp}-${process.pid}-pre-sqlite-v${INVENTORY_SCHEMA_VERSION}`);

const exists = async (file) => fs.access(file).then(() => true).catch(() => false);
const hashFile = async (file) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex").toUpperCase();
const relative = (file) => path.relative(stateRoot, file).replaceAll("\\", "/");

if (!(await exists(databasePath))) throw new Error(`找不到数据库：${databasePath}`);
await fs.mkdir(backupRoot, { recursive: true });
await fs.mkdir(backupPath, { recursive: false });

/* 只读检查 + VACUUM INTO：快照不依赖 WAL/SHM 是否恰好已落盘。 */
const source = new DatabaseSync(databasePath);
let sourceVersion;
let preflightQuickCheck;
const snapshot = path.join(backupPath, "data", INVENTORY_DATABASE_NAME);
try {
  preflightQuickCheck = source.prepare("PRAGMA quick_check").get().quick_check;
  if (preflightQuickCheck !== "ok") throw new Error(`迁移前 SQLite 完整性检查失败：${preflightQuickCheck}`);
  sourceVersion = Number(source.prepare("PRAGMA user_version").get().user_version);
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31].includes(sourceVersion)) throw new Error(`只支持从 v1 至 v31 迁移，实际版本为 v${sourceVersion}`);
  await fs.mkdir(path.dirname(snapshot), { recursive: true });
  source.prepare("VACUUM INTO ?").run(snapshot);
} finally {
  source.close();
}

/* 重新打开快照核对版本和完整性，避免 VACUUM INTO 过程中源库状态不一致时留下假备份。 */
const snapshotCheck = new DatabaseSync(snapshot, { readOnly: true });
try {
  const snapshotQuickCheck = snapshotCheck.prepare("PRAGMA quick_check").get().quick_check;
  const snapshotVersion = Number(snapshotCheck.prepare("PRAGMA user_version").get().user_version);
  if (snapshotQuickCheck !== "ok" || snapshotVersion !== sourceVersion) {
    throw new Error(`一致性快照校验失败：version=${snapshotVersion}, quick_check=${snapshotQuickCheck}`);
  }
} finally {
  snapshotCheck.close();
}

const manifest = [];
manifest.push({ relativePath: relative(databasePath), backupPath: path.relative(backupPath, snapshot).replaceAll("\\", "/"), sha256: await hashFile(snapshot) });
for (const original of [path.join(stateRoot, "config.json"), path.join(dataDir, "permissions.json")]) {
  if (!(await exists(original))) continue;
  const destination = path.join(backupPath, relative(original));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(original, destination);
  manifest.push({ relativePath: relative(original), backupPath: path.relative(backupPath, destination).replaceAll("\\", "/"), sha256: await hashFile(destination) });
}
await fs.writeFile(path.join(backupPath, "backup-manifest.json"), `${JSON.stringify({ schemaVersion: INVENTORY_SCHEMA_VERSION, sourceSchemaVersion: sourceVersion, preflightQuickCheck, createdAt: new Date().toISOString(), stateRoot, files: manifest }, null, 2)}\n`, "utf8");

let result;
try {
  result = migrateInventoryDatabaseToCurrent({ databasePath });
  const verify = new DatabaseSync(databasePath);
  try {
    const integrity = verify.prepare("PRAGMA quick_check").get().quick_check;
    const version = Number(verify.prepare("PRAGMA user_version").get().user_version);
    if (integrity !== "ok" || version !== INVENTORY_SCHEMA_VERSION) throw new Error(`迁移后验证失败：version=${version}, quick_check=${integrity}`);
    result = { ...result, integrity, version };
  } finally {
    verify.close();
  }
} catch (error) {
  console.error(`迁移失败，原数据库未执行部分提交；一致性备份保留于 ${backupPath}`);
  throw error;
}

const report = { ok: true, ...result, stateRoot, databasePath, backupPath, databaseSha256: await hashFile(databasePath), manifest: path.join(backupPath, "backup-manifest.json") };
await fs.writeFile(path.join(backupPath, "migration-result.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
