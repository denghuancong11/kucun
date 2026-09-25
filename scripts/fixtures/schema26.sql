-- Schema-only fixture: exact schema 26 DDL, with no database rows.

PRAGMA foreign_keys = ON;

CREATE TABLE allocation_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_no TEXT NOT NULL UNIQUE,
      correction_of_id INTEGER REFERENCES allocation_documents(id),
      correction_document_id INTEGER REFERENCES allocation_documents(id),
      model TEXT NOT NULL REFERENCES catalog_models(model),
      batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
      plan TEXT NOT NULL,
      ship_date TEXT NOT NULL,
      version TEXT NOT NULL,
      fnsku TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      department TEXT NOT NULL CHECK (department IN ('一团', '二团')),
      store_name TEXT NOT NULL,
      operator_name TEXT NOT NULL,
      legacy_time_label TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'confirmed', 'cancelled', 'withdrawn')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      submitted_by_role TEXT,
      submitted_at TEXT,
      confirmed_by_role TEXT,
      confirmed_at TEXT,
      source_document TEXT,
      cancelled_by_role TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      withdrawn_by_role TEXT,
      withdrawn_at TEXT,
      withdraw_reason TEXT,
      external_sync_status TEXT NOT NULL DEFAULT 'not_synced' CHECK (external_sync_status IN ('not_synced', 'synced', 'cancel_pending')),
      updated_at TEXT NOT NULL
    , asin TEXT NOT NULL DEFAULT '', operator_note TEXT NOT NULL DEFAULT '', requested_quantity INTEGER CHECK (requested_quantity > 0), approved_quantity INTEGER CHECK (approved_quantity > 0), business_note TEXT NOT NULL DEFAULT '', approval_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (approval_status IN ('pending', 'approved', 'rejected', 'legacy')), reviewed_at TEXT, reviewed_by_role TEXT, lingxing_snapshot_json TEXT) STRICT;

CREATE TABLE catalog_models (
      model TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('硒鼓', '墨盒')),
      base_in_stock INTEGER NOT NULL CHECK (base_in_stock >= 0),
      in_transit INTEGER NOT NULL CHECK (in_transit >= 0),
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_by_import_id INTEGER REFERENCES import_batches(id)
    ) STRICT;

CREATE TABLE correction_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correction_id INTEGER NOT NULL REFERENCES correction_requests(id),
      event_type TEXT NOT NULL,
      role TEXT NOT NULL,
      operator_name TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;

CREATE TABLE correction_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correction_no TEXT NOT NULL UNIQUE,
      root_document_id INTEGER NOT NULL REFERENCES allocation_documents(id),
      source_document_id INTEGER NOT NULL REFERENCES allocation_documents(id),
      result_document_id INTEGER REFERENCES allocation_documents(id),
      correction_type TEXT NOT NULL,
      application_reason TEXT NOT NULL,
      applicant_name TEXT NOT NULL,
      applicant_role TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'rejected', 'cancelled', 'execution_failed')),
      source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
      proposed_quantity INTEGER NOT NULL CHECK (proposed_quantity > 0),
      proposed_department TEXT NOT NULL CHECK (proposed_department IN ('一团', '二团')),
      proposed_store_name TEXT NOT NULL,
      proposed_operator_name TEXT NOT NULL,
      original_snapshot_json TEXT NOT NULL,
      proposed_snapshot_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      reviewed_by_role TEXT,
      reviewed_by_name TEXT,
      reviewed_at TEXT,
      review_comment TEXT,
      processed_by_role TEXT,
      processed_by_name TEXT,
      processed_at TEXT,
      cancelled_by_role TEXT,
      cancelled_by_name TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      failure_code TEXT,
      failure_reason TEXT,
      failed_at TEXT,
      impact_hash TEXT,
      reversal_group TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

CREATE TABLE document_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER REFERENCES allocation_documents(id),
      legacy_record_id INTEGER,
      event_type TEXT NOT NULL,
      role TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;

CREATE TABLE document_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES allocation_documents(id),
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
      created_at TEXT NOT NULL,
      UNIQUE (document_id, reference_type, reference_id)
    ) STRICT;

CREATE TABLE fba_archives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transit_id INTEGER NOT NULL UNIQUE REFERENCES transit_batches(id),
      model TEXT NOT NULL REFERENCES catalog_models(model), quantity INTEGER NOT NULL CHECK(quantity>0),
      plan TEXT NOT NULL, ship_date TEXT NOT NULL, version TEXT NOT NULL, fnsku TEXT NOT NULL,
      team TEXT NOT NULL, shipping_method TEXT NOT NULL, archived_at TEXT NOT NULL, archived_by_role TEXT NOT NULL
    ) STRICT;

CREATE TABLE idempotency_requests (
      scope TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope, request_id)
    ) WITHOUT ROWID, STRICT;

CREATE TABLE import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      template_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('staged', 'reverted')),
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      inventory_applied INTEGER NOT NULL DEFAULT 0 CHECK (inventory_applied IN (0, 1)),
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reverted_by_role TEXT,
      reverted_at TEXT,
      database_id TEXT,
      client_session_id TEXT,
      snapshot_id TEXT REFERENCES transit_import_snapshots(snapshot_id),
      revert_request_id TEXT,
      replaces_import_id INTEGER REFERENCES import_batches(id),
      import_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (import_kind IN ('legacy', 'transit'))
    ) STRICT;

CREATE TABLE import_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_batch_id INTEGER NOT NULL REFERENCES import_batches(id),
      source_row INTEGER NOT NULL,
      payload_json TEXT NOT NULL, corrected_quantity INTEGER CHECK(corrected_quantity >= 0), current_transit_id INTEGER REFERENCES transit_batches(id),
      UNIQUE (import_batch_id, source_row)
    ) STRICT;

CREATE TABLE "inquiry_documents" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_no TEXT NOT NULL UNIQUE,
      model TEXT NOT NULL REFERENCES catalog_models(model),
      asin TEXT NOT NULL,
      fnsku TEXT NOT NULL,
      requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
      approved_quantity INTEGER CHECK (approved_quantity > 0),
      supplier_quantity INTEGER CHECK (supplier_quantity >= 0),
      department TEXT NOT NULL CHECK (department IN ('一团', '二团')),
      store_name TEXT NOT NULL,
      operator_name TEXT NOT NULL,
      operator_note TEXT NOT NULL DEFAULT '',
      business_note TEXT NOT NULL DEFAULT '',
      shipping_warehouse TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT '',
      ship_date TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending_business', 'pending_purchasing', 'pending_assistant', 'archived', 'rejected', 'cancelled')),
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reviewed_by_role TEXT,
      reviewed_at TEXT,
      replied_by_role TEXT,
      replied_at TEXT,
      archived_by_role TEXT,
      archived_at TEXT,
      cancelled_by_role TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      fba_shipped_at TEXT,
      fba_confirmed_by_role TEXT,
      lingxing_snapshot_json TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at TEXT NOT NULL
    ) STRICT;

CREATE TABLE inquiry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_id INTEGER NOT NULL REFERENCES inquiry_documents(id),
      event_type TEXT NOT NULL,
      role TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;

CREATE TABLE inquiry_shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_id INTEGER NOT NULL REFERENCES inquiry_documents(id),
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      ship_date TEXT NOT NULL,
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at TEXT NOT NULL
    ) STRICT;

CREATE TABLE "inventory_ledger" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER REFERENCES allocation_documents(id),
      batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
      entry_type TEXT NOT NULL CHECK (entry_type IN ('reserve', 'review_adjustment', 'release_reservation', 'issue', 'reverse_issue', 'correction', 'return_receipt')),
      on_hand_delta INTEGER NOT NULL DEFAULT 0,
      locked_delta INTEGER NOT NULL DEFAULT 0,
      related_ledger_id INTEGER REFERENCES "inventory_ledger"(id),
      reversal_group TEXT,
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;

CREATE TABLE lingxing_asin_metrics (
      asin TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      synced_by_role TEXT NOT NULL,
      synced_at TEXT NOT NULL
    ) STRICT;

CREATE TABLE lingxing_removal_shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      store_name TEXT NOT NULL,
      country_code TEXT NOT NULL,
      order_no TEXT NOT NULL,
      fnsku TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      carrier TEXT NOT NULL,
      tracking_no TEXT NOT NULL,
      ship_date TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      UNIQUE (store_id, external_id)
    ) STRICT;

CREATE TABLE lingxing_sync_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    request_json TEXT NOT NULL,
    requested_from TEXT NOT NULL,
    target_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
    message TEXT NOT NULL,
    worker_id TEXT,
    capture_json TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );

CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT NOT NULL
    ) STRICT;

CREATE TABLE "stock_batches" (
      batch_key TEXT PRIMARY KEY,
      model TEXT NOT NULL REFERENCES catalog_models(model),
      /* 旧数据库占位行保留空值以便审计读取；v13 后新写入不得使用该标记。 */
      plan TEXT NOT NULL DEFAULT '',
      ship_date TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      fnsku TEXT NOT NULL DEFAULT '',
      base_quantity INTEGER NOT NULL CHECK (base_quantity >= 0),
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_by_import_id INTEGER REFERENCES import_batches(id),
      created_by_transit_id INTEGER REFERENCES transit_batches(id),
      is_legacy_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_legacy_placeholder IN (0, 1)), warehouse TEXT NOT NULL DEFAULT '', pack_per_box TEXT,
      UNIQUE (model, plan, ship_date, version, fnsku, warehouse)
    ) STRICT;

CREATE TABLE "stock_receipts" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transit_id INTEGER NOT NULL REFERENCES transit_batches(id),
      batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      ledger_watermark INTEGER
    ) STRICT;

CREATE TABLE system_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

CREATE TABLE transit_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL REFERENCES catalog_models(model),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0 AND remaining_quantity <= quantity),
      plan TEXT NOT NULL,
      ship_date TEXT NOT NULL,
      version TEXT NOT NULL,
      fnsku TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '',
      transport_method TEXT NOT NULL DEFAULT '',
      shipping_method TEXT NOT NULL DEFAULT '',
      team TEXT NOT NULL DEFAULT '',
      logistics_status TEXT NOT NULL,
      on_shelf_indicator TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'on_shelf')),
      is_legacy_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_legacy_placeholder IN (0, 1)),
      import_batch_id INTEGER REFERENCES import_batches(id),
      source_row INTEGER,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      on_shelf_by_role TEXT,
      on_shelf_at TEXT,
      /* 业务作废采用 tombstone，保留原始数量、事件和来源关系。 */
      voided_at TEXT,
      voided_by_role TEXT,
      voided_request_id TEXT
    , pack_per_box TEXT) STRICT;

CREATE TABLE transit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transit_id INTEGER NOT NULL REFERENCES transit_batches(id),
      event_type TEXT NOT NULL CHECK (event_type IN ('imported', 'status_updated', 'on_shelf')),
      role TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;

CREATE TABLE transit_import_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      import_batch_id INTEGER NOT NULL UNIQUE REFERENCES import_batches(id),
      database_id TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      template_sha256 TEXT NOT NULL,
      structure_version INTEGER NOT NULL CHECK (structure_version >= 1),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('native', 'historical_backup_rebuild')),
      source_reference_sha256 TEXT,
      content_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

CREATE TABLE transit_preview_tokens (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('import', 'status')),
      role TEXT NOT NULL,
      database_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      template_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    ) STRICT;

CREATE TABLE upgrade_inventory_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upgrade_id INTEGER NOT NULL REFERENCES upgrade_jobs(id),
        operation_id INTEGER REFERENCES upgrade_operations(id),
        source_type TEXT NOT NULL CHECK (source_type IN ('direct_line', 'relocation')),
        source_id INTEGER NOT NULL,
        batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
        entry_type TEXT NOT NULL CHECK (entry_type IN (
          'direct_reserve', 'direct_transfer_out', 'direct_transfer_in', 'relocation_receipt',
          'direct_release_reservation', 'direct_completion_reverse_target',
          'direct_completion_restore_source', 'relocation_completion_reverse'
        )),
        on_hand_delta INTEGER NOT NULL DEFAULT 0,
        locked_delta INTEGER NOT NULL DEFAULT 0,
        related_ledger_id INTEGER REFERENCES upgrade_inventory_ledger(id),
        reversal_group TEXT,
        created_by_role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        request_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;

CREATE TABLE "upgrade_jobs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upgrade_no TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('relocation', 'direct')),
      allocation_document_id INTEGER REFERENCES allocation_documents(id), inquiry_id INTEGER REFERENCES inquiry_documents(id),
      model TEXT NOT NULL REFERENCES catalog_models(model),
      source_version TEXT NOT NULL,
      new_version TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
      initiated_by_role TEXT NOT NULL,
      initiated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at TEXT NOT NULL, cancelled_by_role TEXT, cancelled_at TEXT, cancel_reason TEXT, fba_archive_id INTEGER REFERENCES fba_archives(id),
      CHECK ((kind = 'relocation' AND ((allocation_document_id IS NOT NULL) + (inquiry_id IS NOT NULL) + (fba_archive_id IS NOT NULL) = 1))
          OR (kind = 'direct' AND allocation_document_id IS NULL AND inquiry_id IS NULL AND fba_archive_id IS NULL))
    ) STRICT;

CREATE TABLE upgrade_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_no TEXT NOT NULL UNIQUE,
      upgrade_id INTEGER NOT NULL REFERENCES upgrade_jobs(id),
      relocation_id INTEGER REFERENCES upgrade_relocations(id),
      operation_type TEXT NOT NULL CHECK (operation_type IN ('direct_start', 'direct_complete', 'relocation_shipment', 'relocation_complete')),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      new_version TEXT,
      source_event_id INTEGER NOT NULL UNIQUE REFERENCES document_events(id),
      request_id TEXT NOT NULL,
      performed_by_role TEXT NOT NULL,
      performed_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      withdrawn_by_role TEXT,
      withdrawn_at TEXT,
      withdraw_reason TEXT,
      reversal_group TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      CHECK ((operation_type IN ('relocation_shipment', 'relocation_complete') AND relocation_id IS NOT NULL)
          OR (operation_type IN ('direct_start', 'direct_complete') AND relocation_id IS NULL))
    ) STRICT;

CREATE TABLE "upgrade_relocation_external_items" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      relocation_id INTEGER NOT NULL REFERENCES upgrade_relocations(id),
      line_id INTEGER NOT NULL REFERENCES lingxing_removal_shipments(id),
      quantity INTEGER NOT NULL CHECK (quantity <> 0),
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

CREATE TABLE "upgrade_relocation_work_items" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_no TEXT NOT NULL UNIQUE,
        allocation_document_id INTEGER REFERENCES allocation_documents(id), inquiry_id INTEGER REFERENCES inquiry_documents(id),
        upgrade_id INTEGER REFERENCES upgrade_jobs(id),
        relocation_id INTEGER REFERENCES upgrade_relocations(id),
        source_quantity_before INTEGER NOT NULL CHECK (source_quantity_before > 0),
        status TEXT NOT NULL CHECK (status IN ('awaiting_procurement', 'awaiting_operation', 'awaiting_shipping', 'shipped', 'withdrawn', 'cancelled')),
        initiated_by_role TEXT NOT NULL,
        initiated_at TEXT NOT NULL,
        rma TEXT,
        relocation_address TEXT,
        procurement_by_role TEXT,
        procurement_at TEXT,
        removal_order_no TEXT,
        operation_by_role TEXT,
        operation_at TEXT,
        fba_remaining_quantity INTEGER CHECK (fba_remaining_quantity >= 0),
        shipped_quantity INTEGER CHECK (shipped_quantity > 0),
        carrier TEXT,
        tracking_no TEXT,
        external_sync_status TEXT NOT NULL DEFAULT 'not_synced' CHECK (external_sync_status IN ('not_synced', 'synced')),
        shipping_by_role TEXT,
        shipping_at TEXT,
        cancelled_by_role TEXT,
        cancelled_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        updated_at TEXT NOT NULL
      , sold_quantity INTEGER NOT NULL DEFAULT 0 CHECK (sold_quantity >= 0), inquiry_shipment_id INTEGER REFERENCES inquiry_shipments(id), fba_archive_id INTEGER REFERENCES fba_archives(id), CHECK ((allocation_document_id IS NOT NULL) + (inquiry_id IS NOT NULL) + (fba_archive_id IS NOT NULL) = 1)) STRICT;

CREATE TABLE "upgrade_relocations" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      relocation_no TEXT NOT NULL UNIQUE,
      upgrade_id INTEGER NOT NULL REFERENCES upgrade_jobs(id),
      allocation_document_id INTEGER REFERENCES allocation_documents(id), inquiry_id INTEGER REFERENCES inquiry_documents(id),
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      source_quantity_before INTEGER NOT NULL CHECK (source_quantity_before > 0),
      fba_remaining_quantity INTEGER NOT NULL CHECK (fba_remaining_quantity >= 0),
      shipped_quantity INTEGER NOT NULL CHECK (shipped_quantity > 0),
      completed_quantity INTEGER NOT NULL DEFAULT 0 CHECK (completed_quantity >= 0 AND completed_quantity <= shipped_quantity),
      rma TEXT NOT NULL,
      relocation_address TEXT NOT NULL,
      removal_order_no TEXT NOT NULL,
      carrier TEXT NOT NULL,
      tracking_no TEXT NOT NULL,
      external_sync_status TEXT NOT NULL DEFAULT 'not_synced' CHECK (external_sync_status IN ('not_synced', 'synced')),
      new_version TEXT,
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')), withdrawn_by_role TEXT, withdrawn_at TEXT, withdraw_reason TEXT, sold_quantity INTEGER NOT NULL DEFAULT 0 CHECK (sold_quantity >= 0), inquiry_shipment_id INTEGER REFERENCES inquiry_shipments(id), fba_archive_id INTEGER REFERENCES fba_archives(id),
      CHECK (source_quantity_before = fba_remaining_quantity + shipped_quantity + sold_quantity),
      UNIQUE (upgrade_id, sequence)
    , CHECK ((allocation_document_id IS NOT NULL) + (inquiry_id IS NOT NULL) + (fba_archive_id IS NOT NULL) = 1)) STRICT;

CREATE TABLE "upgrade_stock_lines" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upgrade_id INTEGER NOT NULL REFERENCES upgrade_jobs(id),
      source_batch_key TEXT NOT NULL REFERENCES stock_batches(batch_key),
      initial_quantity INTEGER NOT NULL CHECK (initial_quantity >= 0),
      completed_quantity INTEGER NOT NULL DEFAULT 0 CHECK (completed_quantity >= 0),
      remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at TEXT NOT NULL,
      CHECK (initial_quantity = completed_quantity + remaining_quantity),
      UNIQUE (upgrade_id, source_batch_key)
    ) STRICT;

CREATE INDEX idx_allocation_approval ON allocation_documents(approval_status, status, model);

CREATE INDEX idx_allocation_model_batch ON allocation_documents(model, batch_key, status);

CREATE INDEX idx_correction_events_request ON correction_events(correction_id, id);

CREATE INDEX idx_corrections_model_search ON correction_requests(source_document_id, status);

CREATE INDEX idx_corrections_root ON correction_requests(root_document_id, id DESC);

CREATE INDEX idx_corrections_source ON correction_requests(source_document_id, id DESC);

CREATE INDEX idx_corrections_status_time ON correction_requests(status, applied_at DESC, id DESC);

CREATE INDEX idx_events_document ON document_events(document_id, id);

CREATE INDEX idx_import_batches_replaces ON import_batches(replaces_import_id);

CREATE INDEX idx_inquiry_events_document ON inquiry_events(inquiry_id, id);

CREATE INDEX idx_inquiry_shipments_document ON inquiry_shipments(inquiry_id, id);

CREATE INDEX idx_inquiry_status_model ON inquiry_documents(status, model, updated_at);

CREATE INDEX idx_ledger_batch ON inventory_ledger(batch_key);

CREATE INDEX idx_lingxing_queue ON lingxing_sync_jobs(state,id);

CREATE INDEX idx_lingxing_removal_order_fnsku ON lingxing_removal_shipments(order_no, fnsku, id);

CREATE UNIQUE INDEX idx_lingxing_single_running ON lingxing_sync_jobs(state) WHERE state='running';

CREATE INDEX idx_receipts_batch ON stock_receipts(batch_key);

CREATE INDEX idx_references_document ON document_references(document_id, status);

CREATE INDEX idx_transit_events_transit ON transit_events(transit_id, id);

CREATE UNIQUE INDEX idx_transit_identity_active ON transit_batches(model,plan,ship_date,version,fnsku,shipping_method)
      WHERE status='in_transit' AND is_legacy_placeholder=0 AND remaining_quantity>0 AND voided_at IS NULL;

CREATE INDEX idx_transit_model_status ON transit_batches(model, status, id);

CREATE INDEX idx_transit_preview_expiry ON transit_preview_tokens(expires_at);

CREATE INDEX idx_upgrade_external_line ON upgrade_relocation_external_items(line_id, relocation_id);

CREATE INDEX idx_upgrade_jobs_model ON upgrade_jobs(model, source_version, status, id);

CREATE INDEX idx_upgrade_ledger_batch ON upgrade_inventory_ledger(batch_key, id);

CREATE INDEX idx_upgrade_ledger_operation ON upgrade_inventory_ledger(operation_id, id);

CREATE INDEX idx_upgrade_lines_job ON upgrade_stock_lines(upgrade_id, id);

CREATE INDEX idx_upgrade_operations_job ON upgrade_operations(upgrade_id, id);

CREATE INDEX idx_upgrade_operations_status ON upgrade_operations(status, performed_at, id);

CREATE INDEX idx_upgrade_relocations_job ON upgrade_relocations(upgrade_id, sequence);

CREATE INDEX idx_upgrade_work_status
      ON upgrade_relocation_work_items(status, updated_at, id);

CREATE UNIQUE INDEX uq_corrections_one_active_per_root
    ON correction_requests(root_document_id)
    WHERE status IN ('pending', 'processing', 'execution_failed');

CREATE UNIQUE INDEX uq_import_batches_active_file
      ON import_batches(file_sha256)
      WHERE status <> 'reverted' AND import_kind = 'legacy';

CREATE UNIQUE INDEX uq_upgrade_direct_active
      ON upgrade_jobs(model, source_version)
      WHERE kind = 'direct' AND status = 'active' AND cancelled_at IS NULL;

CREATE UNIQUE INDEX uq_upgrade_relocation_document
      ON upgrade_jobs(allocation_document_id)
      WHERE kind = 'relocation';

CREATE UNIQUE INDEX uq_upgrade_relocation_fba ON upgrade_jobs(fba_archive_id) WHERE kind='relocation';

CREATE UNIQUE INDEX uq_upgrade_relocation_inquiry ON upgrade_jobs(inquiry_id) WHERE kind = 'relocation';

CREATE UNIQUE INDEX uq_upgrade_work_active
      ON upgrade_relocation_work_items(allocation_document_id)
      WHERE status IN ('awaiting_procurement', 'awaiting_operation', 'awaiting_shipping');

CREATE UNIQUE INDEX uq_upgrade_work_fba_active ON upgrade_relocation_work_items(fba_archive_id)
      WHERE status IN ('awaiting_procurement','awaiting_operation','awaiting_shipping');

CREATE UNIQUE INDEX uq_upgrade_work_inquiry_active ON upgrade_relocation_work_items(inquiry_shipment_id)
      WHERE status IN ('awaiting_procurement', 'awaiting_operation', 'awaiting_shipping');

CREATE TRIGGER allocation_documents_no_delete
    BEFORE DELETE ON allocation_documents
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
    BEGIN SELECT RAISE(ABORT, '业务单据禁止删除'); END;

CREATE TRIGGER correction_events_no_delete
    BEFORE DELETE ON correction_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
    BEGIN SELECT RAISE(ABORT, '纠错处理记录禁止删除'); END;

CREATE TRIGGER correction_events_no_update
    BEFORE UPDATE ON correction_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
    BEGIN SELECT RAISE(ABORT, '纠错处理记录禁止覆盖'); END;

CREATE TRIGGER correction_requests_no_delete
    BEFORE DELETE ON correction_requests
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
    BEGIN SELECT RAISE(ABORT, '纠错单禁止删除'); END;

CREATE TRIGGER document_events_no_delete
    BEFORE DELETE ON document_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
    BEGIN SELECT RAISE(ABORT, '历史事件禁止删除'); END;

CREATE TRIGGER document_events_no_update
    BEFORE UPDATE ON document_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
    BEGIN SELECT RAISE(ABORT, '历史事件禁止覆盖'); END;

CREATE TRIGGER inquiry_documents_no_delete BEFORE DELETE ON inquiry_documents
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') <> OLD.model
    BEGIN SELECT RAISE(ABORT, '询库单禁止删除'); END;

CREATE TRIGGER inquiry_events_no_delete BEFORE DELETE ON inquiry_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '')
      <> COALESCE((SELECT model FROM inquiry_documents WHERE id = OLD.inquiry_id), '__missing_inquiry_model__')
    BEGIN SELECT RAISE(ABORT, '询库历史禁止删除'); END;

CREATE TRIGGER inquiry_events_no_update BEFORE UPDATE ON inquiry_events
    BEGIN SELECT RAISE(ABORT, '询库历史禁止覆盖'); END;

CREATE TRIGGER inquiry_shipments_no_delete BEFORE DELETE ON inquiry_shipments
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '')
      <> COALESCE((SELECT model FROM inquiry_documents WHERE id = OLD.inquiry_id), '__missing_inquiry_model__')
    BEGIN SELECT RAISE(ABORT, '询库发货批次禁止删除'); END;

CREATE TRIGGER inventory_ledger_no_delete
    BEFORE DELETE ON inventory_ledger
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
    BEGIN SELECT RAISE(ABORT, '库存流水禁止删除'); END;

CREATE TRIGGER inventory_ledger_no_update
    BEFORE UPDATE ON inventory_ledger
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
    BEGIN SELECT RAISE(ABORT, '库存流水禁止覆盖'); END;

CREATE TRIGGER stock_batches_no_legacy_placeholder_insert
    BEFORE INSERT ON stock_batches
    WHEN NEW.is_legacy_placeholder = 1
    BEGIN SELECT RAISE(ABORT, '禁止新建在库占位批次'); END;

CREATE TRIGGER stock_batches_no_legacy_placeholder_update
    BEFORE UPDATE OF is_legacy_placeholder ON stock_batches
    WHEN NEW.is_legacy_placeholder = 1
    BEGIN SELECT RAISE(ABORT, '禁止写入在库占位批次'); END;

CREATE TRIGGER stock_receipts_no_delete
    BEFORE DELETE ON stock_receipts
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
          <> COALESCE((SELECT import_batch_id FROM transit_batches WHERE id = OLD.transit_id), -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1)
          <> OLD.transit_id
    BEGIN SELECT RAISE(ABORT, '上架入库凭证禁止删除'); END;

CREATE TRIGGER stock_receipts_no_update
    BEFORE UPDATE ON stock_receipts
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
    BEGIN SELECT RAISE(ABORT, '上架入库凭证禁止覆盖'); END;

CREATE TRIGGER transit_batches_no_delete
    BEFORE DELETE ON transit_batches
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
          <> COALESCE(OLD.import_batch_id, -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1)
          <> OLD.id
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_mutation_transit_id'), -1)
          <> OLD.id
    BEGIN SELECT RAISE(ABORT, '在途记录禁止删除'); END;

CREATE TRIGGER transit_batches_no_legacy_placeholder_insert
    BEFORE INSERT ON transit_batches
    WHEN NEW.is_legacy_placeholder = 1
    BEGIN SELECT RAISE(ABORT, '禁止新建在途占位批次'); END;

CREATE TRIGGER transit_batches_no_legacy_placeholder_update
    BEFORE UPDATE OF is_legacy_placeholder ON transit_batches
    WHEN NEW.is_legacy_placeholder = 1
    BEGIN SELECT RAISE(ABORT, '禁止写入在途占位批次'); END;

CREATE TRIGGER transit_events_no_delete
    BEFORE DELETE ON transit_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_revert_import_id'), -1)
          <> COALESCE((SELECT import_batch_id FROM transit_batches WHERE id = OLD.transit_id), -2)
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_off_shelf_id'), -1)
          <> OLD.transit_id
      AND COALESCE((SELECT CAST(value AS INTEGER) FROM system_meta WHERE key = 'transit_mutation_transit_id'), -1)
          <> OLD.transit_id
    BEGIN SELECT RAISE(ABORT, '在途事件禁止删除'); END;

CREATE TRIGGER transit_events_no_update
    BEFORE UPDATE ON transit_events
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
    BEGIN SELECT RAISE(ABORT, '在途事件禁止覆盖'); END;

CREATE TRIGGER transit_import_snapshots_no_delete
    BEFORE DELETE ON transit_import_snapshots
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
    BEGIN SELECT RAISE(ABORT, '在途导入逻辑快照禁止删除'); END;

CREATE TRIGGER transit_import_snapshots_no_update
    BEFORE UPDATE ON transit_import_snapshots
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') = ''
    BEGIN SELECT RAISE(ABORT, '在途导入逻辑快照禁止覆盖'); END;

CREATE TRIGGER upgrade_inventory_ledger_no_delete
    BEFORE DELETE ON upgrade_inventory_ledger
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '')
         <> COALESCE((SELECT model FROM upgrade_jobs WHERE id = OLD.upgrade_id), '__missing_upgrade_model__')
    BEGIN SELECT RAISE(ABORT, '升级库存流水禁止删除'); END;

CREATE TRIGGER upgrade_inventory_ledger_no_update
      BEFORE UPDATE ON upgrade_inventory_ledger
      BEGIN SELECT RAISE(ABORT, '升级库存流水禁止覆盖'); END;

CREATE TRIGGER upgrade_jobs_no_delete
    BEFORE DELETE ON upgrade_jobs
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '') <> OLD.model
    BEGIN SELECT RAISE(ABORT, '升级业务单禁止删除'); END;

CREATE TRIGGER upgrade_operations_no_delete
    BEFORE DELETE ON upgrade_operations
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '')
         <> COALESCE((SELECT model FROM upgrade_jobs WHERE id = OLD.upgrade_id), '__missing_upgrade_model__')
    BEGIN SELECT RAISE(ABORT, '升级操作记录禁止删除'); END;

CREATE TRIGGER upgrade_relocation_external_items_no_delete BEFORE DELETE ON upgrade_relocation_external_items
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '')
      <> COALESCE((SELECT j.model FROM upgrade_relocations r JOIN upgrade_jobs j ON j.id = r.upgrade_id WHERE r.id = OLD.relocation_id), '__missing_upgrade_model__')
    BEGIN SELECT RAISE(ABORT, '领星物流采纳历史禁止删除'); END;

CREATE TRIGGER upgrade_relocation_external_items_no_update BEFORE UPDATE ON upgrade_relocation_external_items
    BEGIN SELECT RAISE(ABORT, '领星物流采纳历史禁止覆盖'); END;

CREATE TRIGGER upgrade_relocation_work_items_no_delete
    BEFORE DELETE ON upgrade_relocation_work_items
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '')
         <> COALESCE(COALESCE((SELECT model FROM allocation_documents WHERE id = OLD.allocation_document_id), (SELECT model FROM inquiry_documents WHERE id = OLD.inquiry_id)), '__missing_upgrade_model__')
    BEGIN SELECT RAISE(ABORT, '移仓分步记录禁止删除'); END;

CREATE TRIGGER upgrade_relocations_no_delete
    BEFORE DELETE ON upgrade_relocations
    WHEN COALESCE((SELECT value FROM system_meta WHERE key = 'catalog_model_delete_model'), '')
         <> COALESCE((SELECT model FROM upgrade_jobs WHERE id = OLD.upgrade_id), '__missing_upgrade_model__')
    BEGIN SELECT RAISE(ABORT, '移仓记录禁止删除'); END;

CREATE VIEW relocation_sources AS
    SELECT id AS allocation_document_id, NULL AS inquiry_id, 'allocation' AS source_kind,
      document_no, model, batch_key, plan, ship_date, version, fnsku,
      quantity - COALESCE((SELECT SUM(on_hand_delta) FROM inventory_ledger WHERE document_id=allocation_documents.id AND entry_type='return_receipt'),0) AS quantity,
      department, store_name, operator_name, asin, status, confirmed_at, NULL AS fba_shipped_at, NULL AS fba_archive_id
    FROM allocation_documents
    UNION ALL SELECT NULL,id,'inquiry',document_no,model,NULL,plan,ship_date,version,fnsku,supplier_quantity,
      department,store_name,operator_name,asin,status,archived_at,fba_shipped_at,NULL FROM inquiry_documents
    UNION ALL SELECT NULL,NULL,'fba','FBA-' || printf('%08d',id),model,NULL,plan,ship_date,version,fnsku,quantity,
      team,NULL,NULL,NULL,'archived',archived_at,ship_date,id FROM fba_archives;

CREATE VIEW stock_balances AS
    SELECT b.*,
      COALESCE((SELECT SUM(quantity) FROM stock_receipts WHERE batch_key=b.batch_key),0) AS receipt_quantity,
      COALESCE((SELECT SUM(on_hand_delta) FROM upgrade_inventory_ledger WHERE batch_key=b.batch_key AND on_hand_delta>0),0) AS upgrade_receipt_quantity,
      b.base_quantity + COALESCE((SELECT SUM(quantity) FROM stock_receipts WHERE batch_key=b.batch_key),0)
        + COALESCE((SELECT SUM(on_hand_delta) FROM inventory_ledger WHERE batch_key=b.batch_key),0)
        + COALESCE((SELECT SUM(on_hand_delta) FROM upgrade_inventory_ledger WHERE batch_key=b.batch_key),0) AS on_hand,
      COALESCE((SELECT SUM(locked_delta) FROM inventory_ledger WHERE batch_key=b.batch_key),0)
        + COALESCE((SELECT SUM(locked_delta) FROM upgrade_inventory_ledger WHERE batch_key=b.batch_key),0) AS locked,
      -COALESCE((SELECT SUM(on_hand_delta) FROM inventory_ledger WHERE batch_key=b.batch_key AND document_id IS NOT NULL),0) AS done
    FROM stock_batches b;

PRAGMA user_version = 26;

