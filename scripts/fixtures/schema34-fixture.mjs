// Remove schema35 export metadata after restoring pre-Alan schema; isolated fixtures only.
import {restoreSchema35Fixture} from './schema35-fixture.mjs';
export function restoreSchema34Fixture(db) {
 restoreSchema35Fixture(db);
 if(db.prepare('PRAGMA user_version').get().user_version===35)db.exec('DROP TABLE relocation_waybill_exports; DROP TABLE relocation_waybill_export_files; DELETE FROM schema_migrations WHERE version=35; PRAGMA user_version=34');
}
