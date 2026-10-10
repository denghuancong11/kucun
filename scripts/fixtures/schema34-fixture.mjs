// Remove only schema35 export metadata in isolated migration fixtures; preserve all schema34 business tables.
export function restoreSchema34Fixture(db) {
 if(db.prepare('PRAGMA user_version').get().user_version===35)db.exec('DROP TABLE relocation_waybill_exports; DROP TABLE relocation_waybill_export_files; DELETE FROM schema_migrations WHERE version=35; PRAGMA user_version=34');
}
