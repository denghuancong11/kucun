// v38 only adds this nullable column; removing it restores the exact v37 table shape.
// Use only on synthetic databases owned by tests.
export function restoreSchema37Fixture(db) {
  db.exec(`ALTER TABLE allocation_documents DROP COLUMN toner_conversion_status;
    DELETE FROM schema_migrations WHERE version>37; PRAGMA user_version=37;`);
}
