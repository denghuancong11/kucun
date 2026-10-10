// Exact schema33 tables from released 4693d59. Isolated fixtures only.
import fs from 'node:fs';
import {restoreSchema34Fixture} from './schema34-fixture.mjs';
const definitions=JSON.parse(fs.readFileSync(new URL('./schema33-transfer-tables.json',import.meta.url),'utf8'));
export function restoreSchema33Fixture(db){
 restoreSchema34Fixture(db);
 const deps=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('view','trigger') OR (type='index' AND sql IS NOT NULL AND tbl_name IN ('stock_batches','upgrade_inventory_ledger','transfer_upgrade_rows','transit_preview_tokens'))").all();
 db.exec('PRAGMA foreign_keys=OFF; BEGIN');
 try{
  for(const x of deps)db.exec('DROP '+x.type+' "'+x.name+'"');
  for(const [name,sql] of Object.entries(definitions)){
   db.exec(sql.replace(/CREATE TABLE (?:IF NOT EXISTS )?"?\w+"?/, 'CREATE TABLE "'+name+'_v33_fixture"'));
   const cols=db.prepare('PRAGMA table_info("'+name+'_v33_fixture")').all().map(x=>'"'+x.name+'"').join(',');
   db.exec('INSERT INTO "'+name+'_v33_fixture" SELECT '+cols+' FROM "'+name+'"; DROP TABLE "'+name+'"; ALTER TABLE "'+name+'_v33_fixture" RENAME TO "'+name+'"');
  }
  for(const x of deps)if(x.name!=='uq_transfer_document_no')db.exec(x.sql);
  db.exec('DELETE FROM schema_migrations WHERE version>33; PRAGMA user_version=33; COMMIT; PRAGMA foreign_keys=ON');
 }catch(e){db.exec('ROLLBACK; PRAGMA foreign_keys=ON');throw e;}
}
