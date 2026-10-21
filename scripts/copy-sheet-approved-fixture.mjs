// Prepare additional visible copy-review states in a brand-new synthetic schema38 DB.
// No deployed data/config, browser, network, or service startup is used by this script.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { prepareCopyFixture } from './copy-confirmation-20261016-fixture.mjs';
import { upgradeWorkbook, transferUpdateValues } from '../transfer-workbook.mjs';
import { writeSyntheticTransitWorkbook } from './fixtures/generate-synthetic-workbook.mjs';

const rid = () => crypto.randomUUID();
const common = row => ({ expectedRevision: row.revision, requestId: rid() });
const date = '2026-10-16';
const address = 'Synthetic Supplier (RMA#: COPY-SHEET-RMA)\n12000 Magnolia Ave, Suite#101\nRiverside, CA 92503 US\nTEL:0000000000';
const crcTable = Uint32Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export async function prepareApprovedFixture() {
  const info = await prepareCopyFixture('browser');
  // prepareCopyFixture sets only freshly generated synthetic config before DB import.
  const { InventoryDatabase, TRANSFER_UPGRADE_FIELDS } = await import('../inventory-db.mjs');
  const db = new InventoryDatabase(info.state);
  const inputs = path.join(info.out, 'copy-sheet-approved-fixture-inputs');
  await fs.mkdir(inputs, {recursive: true});
  const states = [], files = [];
  const add = (key, ids, role, entry, record, extra = {}) => {
    const item = {key, ids, role, model: record.model ?? record.data?.model, documentNo: record.documentNo ?? record.upgradeNo ?? record.workNo,
      recordId: record.id, plan: record.plan ?? record.data?.plan, sourceKind: record.sourceKind,
      sourceDocumentNo: record.sourceKind ? record.documentNo : undefined, workNo: record.workNo,
      status: record.statusText ?? record.data?.status ?? record.status, entry,
      syntheticOnly: true, construction: 'existing schema38 business methods with synthetic inputs', ...extra};
    states.push(item); return item;
  };
  const fileInfo = async (name, contents, ids, entry, extra = {}) => {
    const file = path.join(inputs, 'copy-sheet-approved-fixture-' + name);
    await fs.writeFile(file, contents);
    files.push({file, ids, role: 'logistics', entry, purpose: 'browser file-picker preview; do not confirm unless deliberately testing isolated submission', ...extra});
    return file;
  };
  try {
    const {toner, ink} = info.fixture;
    function inquiry(model, label, quantity = 30) {
      return db.createInquiry({role: 'operation-1', model, quantity, department: '一团', store: 'COPYUS', operator: label,
        fnsku: 'COPY-SHEET-' + label, asin: model === toner ? 'BCOPY00002' : 'BCOPY00003', operatorNote: '合成页面文案验收', requestId: rid()}).record;
    }
    function readyInquiry(model, label, quantity) {
      let row = inquiry(model, label, quantity);
      row = db.reviewInquiry({id: row.id, role: 'business', decision: 'approve', approvedQuantity: quantity, ...common(row)}).record;
      if (model === ink) row = db.reviewAlanInquiry({id: row.id, role: 'alan', alanQuantity: quantity, ...common(row)}).record;
      return db.replyInquiry({id: row.id, role: 'purchasing', supplierQuantity: quantity, shippingWarehouse: 'CA', procurementNote: '合成正数回复', ...common(row)}).record;
    }
    const inkArchive = readyInquiry(ink, 'COPY-INK-ARCHIVE-READY', 30);
    const tonerArchive = readyInquiry(toner, 'COPY-TONER-ARCHIVE-READY', 45);
    assert.equal(inkArchive.status, 'pending_assistant'); assert.equal(tonerArchive.status, 'pending_assistant');
    add('ink-inquiry-archive', ['SP-008', 'A003'], 'purchasing', '审批中心 → 墨盒 → 询库 → 展开型号 → 对应询库“采购归档”按钮 → 仅查看弹窗标题“保存”，关闭不提交', inkArchive);
    add('toner-inquiry-archive', ['SP-009'], 'purchasing', '审批中心 → 硒鼓 → 询库 → 展开型号 → 对应询库“确认实际发出并归档”按钮 → 仅查看弹窗标题“确认”，关闭不提交', tonerArchive);

    function conversion(model, quantity, convertedQuantity) {
      const batch = db.getCatalog().stockDetails[model].find(row => row.version === (model === toner ? 'COPY-V1' : 'COPY-INK-V1'));
      assert(batch, model + ': stock source');
      let row = db.createAllocation({role: 'operation-1', model, sourceBatchKey: batch.batchKey, plan: batch.plan, date: batch.date, version: batch.version,
        quantity, department: '一团', store: 'COPYUS', operator: 'COPY-CONVERSION-' + model, fnsku: 'COPY-CONVERSION', asin: 'BCOPY00001', requestId: rid()}).record;
      row = db.transferAllocationToInquiry({id: row.id, role: 'business', approvedQuantity: convertedQuantity, businessNote: '合成待运营确认转询库', ...common(row)}).record;
      assert.equal(row.lockedQuantity, 0);
      return row;
    }
    const inkConversion = conversion(ink, 10, 15), tonerConversion = conversion(toner, 20, 23);
    add('ink-conversion-pending', ['SP-016-A'], 'operation-1', '审批中心 → 墨盒 → 调拨 → 展开型号及对应调拨，查看转询库数量说明，不点击接受/不接受', inkConversion);
    add('toner-conversion-pending', ['SP-016-B'], 'operation-1', '审批中心 → 硒鼓 → 调拨 → 展开型号及对应调拨，查看转询库数量说明，不点击接受/不接受', tonerConversion);

    // Seed the direct job before new receipt batches so reversal receipts stay unoccupied.
    let direct = db.createDirectUpgrade({role: 'purchasing', model: toner, sourceVersion: 'COPY-V1', requestId: rid()}).upgrade;
    assert(direct.lines[0].inProgressQuantity >= 6);
    db.completeDirectUpgrade({id: direct.id, role: 'purchasing', sourceLineId: direct.lines[0].id, completedQuantity: 6,
      newVersion: 'COPY-DIRECT-V2', targetWarehouse: 'SyntheticWarehouseA', ...common(direct)});
    direct = db.getUpgrade(direct.id);
    add('direct-in-progress', ['SJ-003', 'SJ-004', 'SJ-005', 'SJ-006'], 'purchasing', '升级库存 → 在库升级 → COPY-TONER-20261016 → 展开记录；可打开“登记完成”查看表单。错误/不确定结果仍需浏览器或根测试主动构造。', direct,
      {sourceVersion: direct.sourceVersion, completedQuantity: direct.completedQuantity, remainingQuantity: direct.inProgressQuantity});

    let relocation = db.getRelocationWorkItem(info.fixture.relocation.id);
    const job = db.getUpgrade(relocation.upgradeId), part = job.relocations.find(row => row.id === relocation.relocationId);
    db.completeRelocationUpgrade({id: part.id, role: 'logistics', completedQuantity: 6, inProgressQuantity: 5, newVersion: 'COPY-RELOCATION-V2',
      targetWarehouse: 'SyntheticWarehouseB', reversals: [], ...common(part)});
    relocation = db.getRelocationWorkItem(relocation.id);
    const currentPart = db.getUpgrade(relocation.upgradeId).relocations.find(row => row.id === relocation.relocationId);
    assert(currentPart.receiptBatches.some(row => row.quantity === 6 && !row.issue));
    add('relocation-packages-and-receipt', ['SJ-013', 'SJ-014', 'SJ-015', 'SJ-017', 'SJ-026', 'SJ-027', 'SJ-028', 'SJ-029'], 'logistics',
      '升级库存 → 移仓升级 → 展开对应移仓升级记录；查看升级汇总状态、处理后地址、当前领星包裹及“领星包裹采纳明细”；可打开“更新升级数量”，将累计完成6改为3显示扣回批次，关闭不保存。', relocation,
      {relocationId: relocation.relocationId, completedQuantity: 6, inProgressQuantity: 5, receiptBatches: currentPart.receiptBatches,
        existingBaseFixtureReused: true});

    function archivedSource(label, quantity) {
      const ready = readyInquiry(toner, label, quantity);
      return db.archiveInquiry({id: ready.id, role: 'purchasing', plan: label + '-PLAN', date, version: label + '-V1', ...common(ready)}).record;
    }
    const uploadSource = archivedSource('COPY-RELOCATION-UPLOAD', 40);
    const uploadWork = db.initiateRelocationUpgrade({role: 'operation-1', inquiryId: uploadSource.id, sourceRevision: uploadSource.revision, requestId: rid()}).workItem;
    add('relocation-rma-upload', ['SJ-020', 'SJ-042', 'SJ-043', 'SJ-044', 'SJ-045', 'FW-018'], 'logistics',
      '升级库存 → 移仓升级 → 上传 RMA 与地址更新表格；选择 metadata.files 中 relocation-update.xlsx，查看预览后关闭。', uploadWork);
    const orderSource = archivedSource('COPY-RELOCATION-ORDER', 25);
    let orderWork = db.initiateRelocationUpgrade({role: 'operation-1', inquiryId: orderSource.id, sourceRevision: orderSource.revision, requestId: rid()}).workItem;
    orderWork = db.recordRelocationProcurement({id: orderWork.id, role: 'logistics', rma: 'COPY-ORDER-RMA', relocationAddress: address, ...common(orderWork)}).workItem;
    add('relocation-order-ready', ['SJ-018'], 'operation-1', '升级库存 → 移仓升级 → 对应记录“填写移仓订单号” → 查看“处理后移仓地址”，关闭不提交', orderWork);

    function seedTransfer(plan, model) {
      const data = {model, source: '合成第三方海外仓', plan, date, version: 'COPY-TRANSFER-V1', fnsku: 'COPY-' + plan, returnQuantity: '30', warehouse: 'SyntheticWarehouseA', store: 'COPYUS', status: '已在第三方海外仓', rma: '', countedQuantity: '', inProgressQuantity: '', completedQuantity: '', completedVersion: ''};
      const rows = [{sourceRow: 4, data}], proof = {kind: 'transfer_upgrade', role: 'logistics', fileName: plan + '.xlsx', fileHash: 'synthetic-' + plan, templateHash: 'synthetic-transfer-template', payload: {rows}};
      db.importTransferUpgrades({...proof, previewToken: db.createTransitPreviewToken(proof).token, rows, requestId: rid()});
      return db.getTransferUpgrades().find(row => row.data.plan === plan);
    }
    function updateTransfer(record, stage, change) {
      const item = {sourceRow: record.sourceRow, data: {documentNo: record.documentNo, revision: record.revision, stage, ...change, reversals: []}};
      const checked = db.validateTransferUpdate(item, stage, {preview: true});
      const rows = [{...item, before: checked.before, after: checked.after, quantityDelta: checked.delta, receiptBatches: record.receiptBatches}];
      const proof = {kind: 'transfer_update', role: 'logistics', fileName: record.data.plan + '-' + stage + '.xlsx', fileHash: 'synthetic-' + rid(), templateHash: 'synthetic-' + stage, payload: {rows}};
      db.updateTransferUpgrades({...proof, stage, previewToken: db.createTransitPreviewToken(proof).token, rows, requestId: rid()});
      return db.getTransferUpgrades().find(row => row.id === record.id);
    }
    const transferRma = seedTransfer('COPY-TRANSFER-RMA', toner);
    let transferCount = seedTransfer('COPY-TRANSFER-COUNT', ink);
    transferCount = updateTransfer(transferCount, 'rma', {rma: 'COPY-COUNT-RMA'});
    let transferProgress = seedTransfer('COPY-TRANSFER-PROGRESS', toner);
    transferProgress = updateTransfer(transferProgress, 'rma', {rma: 'COPY-PROGRESS-RMA'});
    transferProgress = updateTransfer(transferProgress, 'count', {countedQuantity: '25'});
    transferProgress = updateTransfer(transferProgress, 'progress', {inProgressQuantity: '5', completedQuantity: '12', completedVersion: 'COPY-TRANSFER-V2'});
    assert(transferProgress.receiptBatches.some(row => row.quantity === 12 && !row.issue));
    for (const [key, ids, record, step] of [
      ['transfer-rma', ['SJ-034', 'SJ-037', 'SJ-046', 'FW-015'], transferRma, 'RMA'],
      ['transfer-count', ['SJ-035', 'SJ-038', 'SJ-047', 'FW-016'], transferCount, '实际清点数量'],
      ['transfer-progress', ['SJ-036', 'SJ-039', 'SJ-040', 'SJ-041', 'SJ-048', 'FW-017'], transferProgress, '升级进度'],
    ]) add(key, ids, 'logistics', '升级库存 → 转仓升级 → 物流更新步骤选择“' + step + '” → 上传对应文件，仅查看预览后关闭', record,
      {plan: record.data.plan, step, receiptBatches: record.receiptBatches});

    const firstData = {...transferRma.data, plan: 'COPY-TRANSFER-NEW-FILE', fnsku: 'COPY-TRANSFER-NEW-FNSKU'};
    await fileInfo('transfer-first.xlsx', upgradeWorkbook('转仓升级', [TRANSFER_UPGRADE_FIELDS.map(([key]) => firstData[key])], crc32), ['SJ-030', 'SJ-031', 'SJ-032', 'SJ-033', 'FW-014'], '升级库存 → 转仓升级 → 上传转仓升级表格', {expectedRows: 1});
    for (const [name, record, changes, ids, step] of [
      ['transfer-rma.xlsx', transferRma, {rma: 'COPY-RMA-FILE'}, ['SJ-034', 'SJ-037'], 'rma'],
      ['transfer-count.xlsx', transferCount, {countedQuantity: '18'}, ['SJ-035', 'SJ-038'], 'count'],
      ['transfer-progress.xlsx', transferProgress, {inProgressQuantity: '4', completedQuantity: '14', completedVersion: 'COPY-TRANSFER-V3'}, ['SJ-036', 'SJ-039'], 'progress'],
      ['transfer-decrease.xlsx', transferProgress, {inProgressQuantity: '5', completedQuantity: '9', completedVersion: 'COPY-TRANSFER-V2'}, ['SJ-040', 'SJ-041'], 'progress'],
    ]) {
      const changed = {...record, data: {...record.data, ...changes}};
      await fileInfo(name, upgradeWorkbook('转仓升级', [transferUpdateValues(changed, TRANSFER_UPGRADE_FIELDS)], crc32), ids,
        '升级库存 → 转仓升级 → 物流更新步骤选择 ' + step + ' → 上传更新表格', {step, plan: record.data.plan, expectedRows: 1, expectedDelta: Number(changed.data.completedQuantity) - Number(record.data.completedQuantity)});
    }
    const relocationValues = [uploadWork.model, '询库', uploadWork.plan, uploadWork.shipDate, uploadWork.sourceVersion, uploadWork.fnsku, uploadWork.initialQuantity,
      uploadWork.fbaRemainingQuantity, uploadWork.store, uploadWork.statusText, 'COPY-SHEET-RMA', address, uploadWork.removalOrderNo ?? '', uploadWork.carrier ?? '', uploadWork.trackingNo ?? '',
      uploadWork.shippedQuantity, null, null, null];
    await fileInfo('relocation-update.xlsx', upgradeWorkbook('移仓升级', [relocationValues], crc32), ['SJ-020', 'SJ-045', 'FW-018'], '升级库存 → 移仓升级 → 上传 RMA 与地址更新表格', {plan: uploadWork.plan, expectedRows: 1});
    const inboundRow = {model: toner, quantity: 20, packPerBox: '10', fnsku: 'COPY-SHEET-IMPORT', shippingMethod: 'SyntheticWarehouseA', plan: 'COPY-SHEET-CSV-IMPORT', date, team: '一团', version: 'COPY-CSV-V1'};
    const csv = '\ufeffITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\r\n' + [inboundRow.model, inboundRow.quantity, inboundRow.packPerBox, inboundRow.fnsku, inboundRow.shippingMethod, inboundRow.plan, inboundRow.date, inboundRow.team, inboundRow.version].join(',') + '\r\n';
    await fileInfo('transit.csv', csv, ['FW-012'], '在途库存 → 导入库存 → 选择文件，仅查看预览', {role: 'purchasing', expectedRows: 1});
    const inboundXlsx = path.join(inputs, 'copy-sheet-approved-fixture-transit.xlsx');
    await writeSyntheticTransitWorkbook(inboundXlsx, {rows: [inboundRow], sheetName: 'SyntheticImport', includeTitle: false});
    files.push({file: inboundXlsx, ids: ['FW-012'], role: 'purchasing', entry: '在途库存 → 导入库存 → 选择文件，仅查看预览', expectedRows: 1});

    db.assertInventoryInvariants(); assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
    info.fixture.approvedExtension = {inkArchive, tonerArchive, inkConversion, tonerConversion, direct, relocation, uploadWork, orderWork, transferRma, transferCount, transferProgress};
    info.approvedMetadata = path.join(info.out, 'metadata.json');
    const metadata = {schemaVersion: 38, manifest: info.manifest, base: info.base, state: info.state, databasePath: info.databasePath, preparedAt: new Date().toISOString(),
      productionReads: 0, productionWrites: 0, startedService: false, controlledBrowser: false, directSqlEdgeStates: [],
      notes: ['All added states use schema38 business methods and synthetic preview tokens; no direct-SQL edge state was needed.', 'Current and adopted relocation packages reuse the existing base fixture.', 'Metadata ids identify relevant UI locations, not proof that every error/recovery state was exercised.', 'Files are local input artifacts; use the authorized browser file picker. No browser file-permission workaround is provided.', 'Keep previews unsubmitted when comparing multiple files; a confirmed update may invalidate a subsequent file based on the original row.'], states, files,
      checks: {inventoryInvariants: 'passed', foreignKeys: 'passed', transferReversalReceiptQuantity: 12, relocationReversalReceiptQuantity: 6}};
    await fs.writeFile(info.approvedMetadata, JSON.stringify(metadata, null, 2));
    await fs.writeFile(info.manifest, JSON.stringify(info, null, 2));
    return {info, metadata};
  } finally {db.close();}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const {info, metadata} = await prepareApprovedFixture();
  console.log('COPY_SHEET_APPROVED_FIXTURE_PREPARED ' + JSON.stringify({manifest: info.manifest, metadata: info.approvedMetadata, base: info.base, states: metadata.states.length, files: metadata.files.length, productionReads: 0, productionWrites: 0, startedService: false}));
}
