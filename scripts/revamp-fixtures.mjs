// Deterministic visual data; only called with a newly created temporary state directory.
import { createInventoryDatabase, InventoryDatabase, INVENTORY_DATABASE_NAME } from '../inventory-db.mjs';
import path from 'node:path';
export const displayTime = '2026-09-18T06:00:00.000Z';
export const longNote = '请按原申请核对数量、店铺和批次；备注完整保留，允许换行或局部滚动。'.repeat(8) + 'END-LONG-NOTE-1234567890';
export const previewCsv = 'ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n' + Array.from({ length: 36 }, (_, i) => `PREVIEW-${String(i + 1).padStart(2, '0')},${100 + i},4,XPREVIEW${i},SyntheticWarehouseB,PREVIEW-PLAN-${i},2026-09-01,一团,V1`).join('\n');
export const statusCsv = '计划号,物流状态\n' + Array.from({ length: 36 }, (_, i) => `STOCK-PLAN-${i},到港待提货`).join('\n');
export function seedVisualFixtures(stateRoot) {
  const NativeDate = globalThis.Date;
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [displayTime])); }
    static now() { return NativeDate.parse(displayTime); }
  };
  let db;
  try {
    createInventoryDatabase({ databasePath: path.join(stateRoot, 'data', INVENTORY_DATABASE_NAME), seedCatalogData: true });
    db = new InventoryDatabase(stateRoot);
    let sequence = 0;
    const rid = () => `visual-fixture-${++sequence}`;
    const models = [...Array.from({ length: 36 }, (_, i) => `STOCK-${String(i + 1).padStart(2, '0')}`), 'APP-18', 'APP-20', 'APP-22', 'APP-25'];
    const rows = models.map((model, i) => ({ sourceRow: i + 2, data: { model, quantity: 3000, packPerBox: "4", fnsku: `XVISUAL${i}`, shippingMethod: 'SyntheticWarehouseB', plan: `STOCK-PLAN-${i}`, date: '2026-09-01', team: '一团', version: 'V1' } }));
    const proof = { kind: 'import', role: 'admin', fileName: '基线硒鼓.csv', fileHash: 'visual-fixture-file', templateHash: 'visual-fixture-template', payload: { rows } };
    const token = db.createTransitPreviewToken(proof).token;
    const imported = db.transitImport({ ...proof, rows, previewToken: token, requestId: rid() });
    for (const row of imported.rows) if (row.model.startsWith('APP-')) db.markTransitOnShelf({ id: row.id, role: 'assistant-1', expectedRevision: row.revision, yes: 'YES', requestId: rid() });
    function allocation(model, i, stage = 0) {
      const batch = db.getCatalog().stockDetails[model][0];
      let r = db.createAllocation({ role: 'operation-1', model, plan: batch.plan, date: batch.date, version: batch.version, sourceBatchKey: batch.batchKey, quantity: 5, department: '一团', store: 'VISUALUS', operator: `运营${String(i + 1).padStart(2, '0')}`, asin: 'BVISUAL001', fnsku: batch.fnsku, operatorNote: '核对店铺与批次', requestId: rid() }).record;
      if (stage > 0) r = db.reviewAllocation({ id: r.id, role: 'business', decision: 'approve', approvedQuantity: 4, businessNote: '按申请核准', expectedRevision: r.revision, requestId: rid() }).record;
      if (stage > 2) r = db.confirmAllocation({ id: r.id, role: 'assistant-1', expectedRevision: r.revision, requestId: rid() }).record;
      return r;
    }
    function inquiry(model, i, stage = 0) {
      let r = db.createInquiry({ role: 'operation-1', model, quantity: 100, department: '一团', store: 'INQUIRYUS', operator: `运营${String(i + 1).padStart(2, '0')}`, asin: 'BVISUAL002', fnsku: `XINQUIRY${i}`, operatorNote: '海外仓备货', requestId: rid() }).record;
      if (stage > 0) r = db.reviewInquiry({ id: r.id, role: 'business', decision: 'approve', approvedQuantity: 80, businessNote: '核准 80 件', expectedRevision: r.revision, requestId: rid() }).record;
      if (stage > 1) r = db.replyInquiry({ id: r.id, role: 'purchasing', supplierQuantity: 60, shippingWarehouse: '东莞供应仓', expectedRevision: r.revision, requestId: rid() }).record;
      if (stage > 2) r = db.archiveInquiry({ id: r.id, role: 'assistant-1', plan: `ARCHIVE-PLAN-${i}`, date: '2026-09-01', version: 'V1', expectedRevision: r.revision, requestId: rid() }).record;
      return r;
    }
    for (const [model, maxStage] of [['APP-18', 0], ['APP-20', 1], ['APP-22', 2], ['APP-25', 3]]) {
      for (let i = 0; i < 32; i++) {
        const stage = Math.floor(i / 2) % (maxStage + 1);
        if (i % 2 === 0) allocation(model, i, stage); else inquiry(model, i, stage);
      }
    }
    const sources = Array.from({ length: 28 }, (_, i) => allocation('SYNTH-TONER-001', i, 3));
    const source = sources[0];
    let work = db.initiateRelocationUpgrade({ allocationId: source.id, role: 'operation-1', requestId: rid() }).workItem;
    work = db.recordRelocationProcurement({ id: work.id, role: 'purchasing', rma: 'RMA-VISUAL', relocationAddress: '洛杉矶升级仓', expectedRevision: work.revision, requestId: rid() }).workItem;
    work = db.recordRelocationOperation({ id: work.id, role: 'operation-1', removalOrderNo: 'REMOVE-VISUAL', expectedRevision: work.revision, requestId: rid() }).workItem;
    work = db.syncRelocationLogistics({ id: work.id, role: 'operation-1', capturedAt: displayTime, shipments: [{ externalId: 'PKG-VISUAL', storeId: 'STORE-VISUAL', storeName: 'VISUALUS', countryCode: 'US', orderNo: 'REMOVE-VISUAL', fnsku: source.fnsku, carrier: 'UPS', trackingNo: 'TRACK-VISUAL', shipDate: '2026-09-10', quantity: 2 }], requestId: rid() }).workItem;
    db.shipRelocationUpgrade({ id: work.id, role: 'operation-1', fbaRemainingQuantity: 2, externalItems: [{ lineId: work.externalShipments[0].lineId, quantity: 2 }], expectedRevision: work.revision, requestId: rid() });
    db.initiateRelocationUpgrade({ allocationId: sources[1].id, role: 'operation-1', requestId: rid() });
    db.createDirectUpgrade({ role: 'operation-1', model: 'APP-18', sourceVersion: 'V1', requestId: rid() });
    db.assertInventoryInvariants();
    return { models: models.length + 3, approvalRecordsPerModel: 32, previewRows: 36, displayTime };
  } finally { db?.close(); globalThis.Date = NativeDate; }
}
