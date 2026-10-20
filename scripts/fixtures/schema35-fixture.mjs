// Exact pre-Alan-node schema35 definitions from df83fa9. Isolated migration fixtures only.
import fs from 'node:fs';
const definitions = JSON.parse(fs.readFileSync(new URL('./schema35-ink-tables.json', import.meta.url), 'utf8'));
export function restoreSchema35Fixture(db) {
  if (db.prepare('PRAGMA user_version').get().user_version < 36) return;
  const dependents = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('view','trigger') OR (type='index' AND sql IS NOT NULL AND tbl_name IN ('allocation_documents','inquiry_documents'))").all();
  db.exec('PRAGMA foreign_keys=OFF; BEGIN');
  try {
    for (const row of dependents) db.exec(`DROP ${row.type} "${row.name}"`);
    db.exec("UPDATE inquiry_documents SET status='pending_purchasing' WHERE status='pending_alan'");
    for (const [name, sql] of Object.entries(definitions)) {
      db.exec(sql.replace(/CREATE TABLE (?:IF NOT EXISTS )?"?\w+"?/, `CREATE TABLE "${name}_v35_fixture"`));
      const columns = db.prepare(`PRAGMA table_info("${name}_v35_fixture")`).all().map(row => '"' + row.name + '"').join(',');
      db.exec(`INSERT INTO "${name}_v35_fixture" SELECT ${columns} FROM "${name}"; DROP TABLE "${name}"; ALTER TABLE "${name}_v35_fixture" RENAME TO "${name}"`);
    }
    // The exact v35 tables intentionally omit these v37-only columns/indexes.
    for (const row of dependents) if (!['uq_inquiry_source_allocation', 'idx_ink_alan_deadline'].includes(row.name)) db.exec(row.sql);
    db.exec('DELETE FROM schema_migrations WHERE version>35; PRAGMA user_version=35; COMMIT; PRAGMA foreign_keys=ON');
  } catch (error) {db.exec('ROLLBACK; PRAGMA foreign_keys=ON'); throw error;}
}
