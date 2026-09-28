// 需求 5.1—9.2：仅迁移结构和历史状态，绝不重放库存入账。
export function migrateRequirementsV30(db, at) {
  const views = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='view'").all();
  const indexes = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  for (const v of views) db.exec(`DROP VIEW "${v.name}"`);
  for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  for (const i of indexes) db.exec(`DROP INDEX "${i.name}"`);
  const rebuild = (table, transform, select = columns => columns) => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table).sql;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => `"${c.name}"`).join(',');
    const seq = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)?.seq;
    db.exec(transform(sql).replace(/CREATE TABLE (?:IF NOT EXISTS )?"?\w+"?/, `CREATE TABLE ${table}_v30`));
    db.exec(`INSERT INTO ${table}_v30(${columns}) SELECT ${select(columns)} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_v30 RENAME TO ${table};`);
    if (seq != null) db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(seq, table);
  };
  rebuild('inquiry_documents', sql => sql.replace("'pending_assistant'", "'pending_procurement'"),
    columns => columns.replace('"status"', "CASE WHEN status='pending_assistant' THEN 'pending_procurement' ELSE status END"));
  db.exec(`ALTER TABLE inquiry_documents ADD COLUMN hidden_at TEXT;
    ALTER TABLE inquiry_documents ADD COLUMN pack_per_box TEXT;
    ALTER TABLE transit_batches ADD COLUMN store_name TEXT;
    ALTER TABLE fba_archives ADD COLUMN store_name TEXT;
    ALTER TABLE fba_archives ADD COLUMN pack_per_box TEXT;`);
  rebuild('stock_batches', sql => sql
    .replace('UNIQUE (model, plan, ship_date, version, fnsku, warehouse, source_team)', "shipping_method TEXT NOT NULL DEFAULT '', UNIQUE (model, plan, ship_date, version, fnsku, warehouse, source_team, shipping_method)"));
  rebuild('upgrade_relocation_work_items', sql => sql
    .replace("'cancelled'", "'cancelled', 'third_party', 'awaiting_count', 'transferring'")
    .replace('shipped_quantity > 0', 'shipped_quantity >= 0')
    .replace(', CHECK ((allocation_document_id IS NOT NULL)', `,
      kind TEXT NOT NULL DEFAULT 'relocation' CHECK(kind IN ('relocation','transfer')),
      source_snapshot_json TEXT NOT NULL DEFAULT '{}',
      processed_address TEXT, address_issue TEXT, address_contact TEXT, address_street TEXT,
      in_progress_quantity INTEGER NOT NULL DEFAULT 0 CHECK(in_progress_quantity>=0),
      transfer_key TEXT UNIQUE, transit_id INTEGER REFERENCES transit_batches(id),
      counted_quantity INTEGER CHECK(counted_quantity>=0), count_difference INTEGER,
      CHECK ((transfer_key IS NOT NULL) + (allocation_document_id IS NOT NULL)`));
  rebuild('upgrade_jobs', sql => sql
    .replace("kind IN ('relocation', 'direct')", "kind IN ('relocation', 'direct', 'transfer')")
    .replace("CHECK ((kind = 'relocation'", "transfer_work_id INTEGER UNIQUE REFERENCES upgrade_relocation_work_items(id), CHECK ((kind='transfer' AND transfer_work_id IS NOT NULL) OR (kind = 'relocation'"));
  rebuild('upgrade_relocations', sql => sql
    .replace('sequence INTEGER', 'transfer_work_id INTEGER REFERENCES upgrade_relocation_work_items(id), sequence INTEGER')
    .replace('shipped_quantity > 0', 'shipped_quantity >= 0')
    .replace('CHECK (source_quantity_before = fba_remaining_quantity + shipped_quantity + sold_quantity)', 'CHECK (transfer_work_id IS NOT NULL OR source_quantity_before = fba_remaining_quantity + shipped_quantity + sold_quantity)')
    .replace(', CHECK ((allocation_document_id IS NOT NULL)', ', CHECK ((transfer_work_id IS NOT NULL) + (allocation_document_id IS NOT NULL)'));
  rebuild('transit_preview_tokens', sql => sql.replace("'import', 'status'", "'import', 'status', 'upgrade', 'transfer'"));
  rebuild('transit_events', sql => sql.replace("'imported', 'status_updated', 'on_shelf'", "'imported', 'status_updated', 'on_shelf', 'transfer_upgrade'"));
  for (const i of indexes) db.exec(i.sql);
  for (const t of triggers) db.exec(t.sql);
  for (const v of views) db.exec(v.name === 'relocation_sources'
    ? v.sql.replace("team,NULL,NULL,NULL,'archived'", "team,store_name,NULL,NULL,'archived'") : v.sql);
  db.exec(`CREATE TABLE upgrade_completion_details (
    id TEXT PRIMARY KEY, work_id INTEGER NOT NULL REFERENCES upgrade_relocation_work_items(id),
    operation_id INTEGER REFERENCES upgrade_operations(id),
    quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity>=0), version TEXT NOT NULL DEFAULT '',
    warehouse TEXT NOT NULL DEFAULT '', batch_key TEXT REFERENCES stock_batches(batch_key),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1), updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_upgrade_completion_work ON upgrade_completion_details(work_id,id);
  UPDATE fba_archives SET pack_per_box=(SELECT pack_per_box FROM transit_batches WHERE id=transit_id);`);
  // 先保存旧归档事实，再迁移零回复状态，避免快照丢失旧归档岗位和时间。
  for (const i of db.prepare("SELECT * FROM inquiry_documents WHERE status IN ('archived','rejected')").all()) {
    db.prepare("INSERT INTO inquiry_events(inquiry_id,event_type,role,occurred_at,payload_json) VALUES(?,'backup_snapshot','migration',?,?)")
      .run(i.id,at,JSON.stringify({snapshot:i,migration:30}));
  }
  db.exec(`
  UPDATE inquiry_documents SET status='rejected',archived_at=NULL,archived_by_role=NULL
    WHERE status='archived' AND supplier_quantity=0
    AND EXISTS(SELECT 1 FROM inquiry_events WHERE inquiry_id=inquiry_documents.id AND event_type='reply_no_stock_archive');
  UPDATE inquiry_documents SET status='pending_procurement' WHERE status='pending_assistant';`);
  const source = db.prepare(`SELECT d.*,
    COALESCE(b.pack_per_box,i.pack_per_box,f.pack_per_box) AS pack_per_box,
    COALESCE(b.source_team,d.department) AS source_team
    FROM relocation_sources d LEFT JOIN stock_batches b ON b.batch_key=d.batch_key
    LEFT JOIN inquiry_documents i ON i.id=d.inquiry_id LEFT JOIN fba_archives f ON f.id=d.fba_archive_id
    WHERE d.allocation_document_id=? OR d.inquiry_id=? OR d.fba_archive_id=?`);
  for (const w of db.prepare('SELECT * FROM upgrade_relocation_work_items').all()) {
    const snapshot = source.get(w.allocation_document_id,w.inquiry_id,w.fba_archive_id);
    if (!snapshot) throw new Error(`移仓流程 ${w.work_no} 缺少历史来源，迁移中止`);
    if (w.inquiry_shipment_id) snapshot.ship_date=db.prepare('SELECT ship_date FROM inquiry_shipments WHERE id=?').get(w.inquiry_shipment_id).ship_date;
    const completed = w.relocation_id ? db.prepare('SELECT completed_quantity FROM upgrade_relocations WHERE id=?').get(w.relocation_id).completed_quantity : 0;
    db.prepare('UPDATE upgrade_relocation_work_items SET source_snapshot_json=?,in_progress_quantity=? WHERE id=?')
      .run(JSON.stringify(snapshot), Math.max(0, Number(w.shipped_quantity || 0)-completed),w.id);
    const ops = w.relocation_id ? db.prepare("SELECT * FROM upgrade_operations WHERE relocation_id=? AND operation_type='relocation_complete' ORDER BY id").all(w.relocation_id) : [];
    for (const op of ops) {
      const receipt = db.prepare("SELECT b.*,SUM(l.on_hand_delta) AS net FROM upgrade_inventory_ledger l JOIN stock_batches b ON b.batch_key=l.batch_key WHERE l.operation_id=? GROUP BY l.batch_key").all(op.id);
      if (receipt.length !== 1) throw new Error(`完成操作 ${op.operation_no} 的目标批次无法唯一接续`);
      const b=receipt[0];
      db.prepare('INSERT INTO upgrade_completion_details(id,work_id,operation_id,quantity,version,warehouse,batch_key,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(`COMP-${op.operation_no}`,w.id,op.id,op.status==='active'?Number(b.net):0,b.version,b.warehouse,b.batch_key,at);
    }
    if (!ops.length) db.prepare('INSERT INTO upgrade_completion_details(id,work_id,updated_at) VALUES(?,?,?)').run(`COMP-${w.work_no}-1`,w.id,at);
  }
  // 只有来源明确且没有普通入库混入的历史批次可标记；库存数量和台账完全不动。
  db.exec(`UPDATE stock_batches SET shipping_method='Aster海外仓-升级后库存'
    WHERE base_quantity=0 AND NOT EXISTS(SELECT 1 FROM stock_receipts r WHERE r.batch_key=stock_batches.batch_key)
    AND EXISTS(SELECT 1 FROM upgrade_inventory_ledger l WHERE l.batch_key=stock_batches.batch_key AND l.source_type='relocation')
    AND NOT EXISTS(SELECT 1 FROM upgrade_inventory_ledger l WHERE l.batch_key=stock_batches.batch_key AND l.source_type<>'relocation');`);
  db.prepare('INSERT INTO schema_migrations(version,applied_at,description) VALUES(30,?,?)')
    .run(at,'需求5.1—9.2：询库回撤隐藏、升级来源快照、累计完成明细、转仓与资料传递');
}
