// Exact v32 table definitions captured from baseline 9c2e7c6. Only use on isolated migration fixtures.
import fs from 'node:fs';
const definitions=JSON.parse(fs.readFileSync(new URL('./schema32-relocation-tables.json',import.meta.url),'utf8'));
export function restoreSchema32Fixture(db) {
 const dependents=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('view','trigger') OR (type='index' AND sql IS NOT NULL AND tbl_name IN ('upgrade_relocation_work_items','upgrade_relocations','stock_batches','transit_preview_tokens'))").all();
 db.exec('PRAGMA foreign_keys=OFF; BEGIN');
 try {
  for(const row of dependents) db.exec(`DROP ${row.type} "${row.name}"`);
  for(const [name,sql] of Object.entries(definitions)) {
   db.exec(sql.replace(/CREATE TABLE (?:IF NOT EXISTS )?"?\w+"?/,`CREATE TABLE "${name}_old_fixture"`));
   const columns=db.prepare(`PRAGMA table_info("${name}_old_fixture")`).all().map(r=>'"'+r.name+'"').join(',');
   db.exec(`INSERT INTO "${name}_old_fixture"(${columns}) SELECT ${columns} FROM "${name}"; DROP TABLE "${name}"; ALTER TABLE "${name}_old_fixture" RENAME TO "${name}"`);
  }
  for(const row of dependents)db.exec(row.sql);
  db.exec('DELETE FROM schema_migrations WHERE version>32; PRAGMA user_version=32; COMMIT; PRAGMA foreign_keys=ON');
 }catch(error){db.exec('ROLLBACK; PRAGMA foreign_keys=ON');throw error;}
}
