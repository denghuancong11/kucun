// All writes use synthetic temporary databases and child servers on owned random ports.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {freePort, createTestInstanceId, waitForOwnedServer} from './test-server-ownership.mjs';

process.env.ASTER_OVERSEAS_WAREHOUSES = 'SyntheticWarehouseA;SyntheticWarehouseB';
const {createInventoryDatabase, InventoryDatabase, migrateInventoryDatabaseToCurrent, INVENTORY_SCHEMA_VERSION, ROLES} = await import('../inventory-db.mjs');
const root = path.resolve(import.meta.dirname, '..');
const out = process.env.ASTER_ACCEPTANCE_OUTPUT || path.join(root, '.test-output/ink-workflow-v37/api');
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-ink-workflow-v37-'));
const databasePath = path.join(state, 'data/aster-inventory.sqlite');
await fs.mkdir(out, {recursive: true});
const clockFile = path.join(state, 'clock.json'), preload = path.join(state, 'clock.mjs');
await fs.writeFile(preload, `import fs from 'node:fs';const RealDate=Date;const now=()=>{const c=JSON.parse(fs.readFileSync(${JSON.stringify(clockFile)},'utf8'));return RealDate.parse(c.at)+(c.ticking?RealDate.now()-c.anchor:0);};globalThis.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[now()]));}static now(){return now();}};`);
const T0 = '2026-10-15T01:00:00.000Z', FIVE_HOURS = 5 * 60 * 60 * 1000;
async function setClock(at, ticking = false) {
  const next = clockFile + '.next';
  await fs.writeFile(next, JSON.stringify({at: new Date(at).toISOString(), ticking, anchor: Date.now()}));
  await fs.rename(next, clockFile);
}
await setClock(T0);
createInventoryDatabase({databasePath, seedCatalogData: false});
let db = new InventoryDatabase(state), server, failure;
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const checks = [], rejectedRequests = [], quantities = [], downloads = [], migrationEvidence = [], raceEvidence = [], timerEvidence = [];
const rid = () => crypto.randomUUID(), common = row => ({expectedRevision: row.revision, requestId: rid()});
const check = label => {checks.push(label); console.log('PASS ' + label);};
const snapshot = (connection = db.db) => Object.fromEntries(connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name}) => [name, connection.prepare(`SELECT * FROM "${name}"`).all()]));
const inventory = () => Object.fromEntries(['stock_batches', 'stock_receipts', 'inventory_ledger', 'upgrade_inventory_ledger'].map(name => [name, db.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
const count = table => Number(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
let diagnostics = '';
async function start() {
  const instanceId = createTestInstanceId('ink-workflow-v37'); diagnostics = '';
  server = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(root, 'server.mjs')], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ASTER_STATE_ROOT: state, ASTER_TEST_INSTANCE_ID: instanceId, HOST: '127.0.0.1', PORT: String(port), PROD: '1'}});
  server.stdout.on('data', value => {diagnostics += value;}); server.stderr.on('data', value => {diagnostics += value;});
  try {await waitForOwnedServer({base, child: server, instanceId});} catch (error) {throw new Error(error.message + '\n' + diagnostics);}
}
async function stop() {if (server?.exitCode === null) {const ended = once(server, 'exit'); server.kill(); await ended;} server = null;}
async function api(route, role = 'admin', body, expected = 200) {
  const response = await fetch(base + route, {method: body === undefined ? 'GET' : 'POST', headers: {'x-role': role, 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const data = await response.json();
  if (expected !== null) assert.equal(response.status, expected, `${role} ${route}: ${JSON.stringify(data)}`);
  return {...data, httpStatus: response.status};
}
async function rejected(route, role, body, status = 403, code) {
  const before = snapshot(), result = await api(route, role, body, status);
  if (code) assert.equal(result.code, code);
  assert.deepEqual(snapshot(), before, `${role} ${route} failed request changed database`);
  rejectedRequests.push({route, role, status, code: result.code, allTablesUnchanged: true}); return result;
}
const route = (kind, row, action) => `/api/${kind}/${row.id}/${action}`;
const batches = []; let batchIndex = 0;
async function allocation(quantity = 100, batch = batches[batchIndex++]) {
  assert(batch, 'synthetic source batch exhausted');
  return (await api('/api/allocations', 'operation-1', {model: batch.model || 'INK-V37', sourceBatchKey: batch.batchKey, plan: batch.plan, date: batch.date, version: batch.version, quantity, department: '一团', store: 'V37US', operator: '隔离新链验收', fnsku: '00001-V37', asin: 'BINKV37001', operatorNote: '原需求备注', requestId: rid()})).record;
}
async function inquiry(quantity = 100, marker = rid()) {
  return (await api('/api/inquiries', 'operation-1', {model: 'INK-V37', quantity, department: '一团', store: 'V37US', operator: marker, fnsku: '00002-V37', asin: 'BINKV37002', operatorNote: '原询库备注', requestId: rid()})).record;
}
async function review(row, kind = 'allocations', quantity = 80, decision = 'approve') {
  return (await api(route(kind, row, 'review'), 'business', {...common(row), decision, approvedQuantity: quantity, businessNote: '商务独立备注' + quantity})).record;
}
async function alan(row, kind = 'allocations', quantity = 60, note = 'Alan独立备注') {
  return (await api(route(kind, row, 'alan-review'), 'alan', {...common(row), alanQuantity: quantity, alanNote: note})).record;
}
async function confirm(row, role = 'assistant-1', request = common(row)) {return (await api(route('allocations', row, 'confirm'), role, request)).record;}
async function reply(row, quantity = 60, role = 'purchasing', request = null) {
  return (await api(route('inquiries', row, 'reply'), role, request || {...common(row), supplierQuantity: quantity, shippingWarehouse: 'CA', procurementNote: '采购最终备注'})).record;
}
async function archive(row, role = 'purchasing') {
  return (await api(route('inquiries', row, 'archive'), role, {...common(row), plan: 'NEW-SUPPLIER-' + row.id, date: '2026-10-15', version: 'NEW-V1'})).record;
}
async function transfer(row, quantity = 80, request = null) {
  return (await api(route('allocations', row, 'transfer-inquiry'), 'business', request || {...common(row), approvedQuantity: quantity, businessNote: '转换商务备注'})).record;
}
async function decide(row, decision = 'accept', role = 'operation-1', request = null) {
  return api(route('allocations', row, 'conversion-decision'), role, request || {...common(row), decision});
}
const current = row => db.getDocument(row.id), currentInquiry = row => db.getInquiry(row.id);
const source = (kind, row) => db.getRelocationCandidates().find(item => item[kind === 'allocations' ? 'allocationId' : 'inquiryId'] === row.id);
function stage(row, value) {assert.equal(row.inkWorkflowStage, value); assert.equal(row.workflowMode, 'ink-v2');}
function balance(row, onHand, locked, issued = 0) {
  const r = current(row), b = db.getBalance(r.batchKey);
  assert.equal(b.onHand, onHand); assert.equal(b.locked, locked); assert.equal(b.available, onHand - locked);
  assert.equal(r.lockedQuantity, locked); assert.equal(r.issuedQuantity, issued);
  quantities.push({id: row.id, stage: r.inkWorkflowStage, onHand, locked, available: b.available, issued});
}
function alanEmpty(row) {for (const key of ['alanQuantity', 'alanNote', 'alanReviewedByRole', 'alanReviewedAt']) assert.equal(row[key], null, key);}
async function auditFor(row, action, {inquiry: isInquiry = false, onHandDelta = 0, lockedDelta = 0} = {}) {
  const raw = db.db.prepare(`SELECT * FROM document_events WHERE event_type=? ${isInquiry ? "AND json_extract(payload_json,'$.inquiryId')=?" : 'AND document_id=?'} ORDER BY id DESC LIMIT 1`).get(action, row.id);
  assert(raw, `missing ${action} for ${isInquiry ? 'inquiry' : 'allocation'} ${row.id}`);
  const result = await api('/api/audit?' + new URLSearchParams({model: row.model, action, limit: '500'}));
  const record = result.records.find(item => item.eventId === Number(raw.id)); assert(record, 'audit projection missing');
  assert.equal(record.onHandDelta, onHandDelta); assert.equal(record.lockedDelta, lockedDelta); assert.equal(record.effectKnown, true);
  const detail = await api('/api/audit/' + raw.id); assert.equal(detail.record.eventId, Number(raw.id));
  assert.equal(detail.record.onHandDelta, onHandDelta); assert.equal(detail.record.lockedDelta, lockedDelta);
  if (isInquiry) {
    assert(!/已调出|退库并恢复预锁/.test(record.result), record.result);
    assert.equal(record.inquiryId, row.id); assert.equal(record.sourceInquiryEventId, JSON.parse(raw.payload_json).sourceInquiryEventId);
    assert.equal(detail.inquiry.id, row.id); assert.equal(detail.inquiry.lingxing.orderGrossProfit, 321);
    for (const hiddenRole of ['purchasing', 'logistics', 'assistant-1', 'alan']) {
      const hiddenDetail = await api('/api/audit/' + raw.id, hiddenRole);
      assert(hiddenDetail.inquiry.lingxing); assert.equal(Object.hasOwn(hiddenDetail.inquiry.lingxing, 'orderGrossProfit'), false, hiddenRole + ' audit detail exposes profit');
    }
    const hidden = await api('/api/audit?' + new URLSearchParams({action, limit: '500'}), 'operation-2');
    assert(!hidden.records.some(item => item.eventId === Number(raw.id)), 'other team sees inquiry audit');
  }
  return record;
}
async function completeAllocation(batch) {return confirm(await alan(await review(await allocation(100, batch))));}

async function migrationTest() {
  const moduleRoot = path.join(out, 'schema36-baseline'); await fs.mkdir(moduleRoot, {recursive: true});
  for (const file of ['inventory-db.mjs', 'relocation-address.mjs']) await fs.writeFile(path.join(moduleRoot, file), execFileSync('git', ['show', `43648e2:${file}`], {cwd: root, windowsHide: true}));
  const legacy = await import(pathToFileURL(path.join(moduleRoot, 'inventory-db.mjs')));
  const legacyState = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-ink-v36-to-v37-')), legacyPath = path.join(legacyState, 'data/aster-inventory.sqlite');
  legacy.createInventoryDatabase({databasePath: legacyPath}); const old = new legacy.InventoryDatabase(legacyState);
  const b = old.db.prepare("SELECT * FROM stock_batches WHERE model='SYNTH-INK-001' LIMIT 1").get();
  old.db.prepare("UPDATE stock_batches SET pack_per_box='10',base_quantity=3000,source_team='一团' WHERE batch_key=?").run(b.batch_key);
  const make = () => old.createAllocation({role: 'operation-1', model: b.model, sourceBatchKey: b.batch_key, plan: b.plan, date: b.ship_date, version: b.version, quantity: 100, department: '一团', store: 'OLDUS', operator: '真实schema36', fnsku: '000OLD37', asin: 'BOLDV37001', requestId: rid()}).record;
  const approve = r => old.reviewAllocation({id: r.id, role: 'business', decision: 'approve', approvedQuantity: 80, businessNote: '旧商务80', ...common(r)}).record;
  const oldAlan = r => old.reviewAlanAllocation({id: r.id, role: 'alan', alanQuantity: 60, alanNote: '旧Alan60', ...common(r)}).record;
  const oldReply = r => old.replyAllocation({id: r.id, role: 'purchasing', supplierQuantity: 60, procurementNote: '旧采购60', ...common(r)}).record;
  const business = make(), pending = approve(make()), purchasing = oldAlan(approve(make())), toArchive = oldReply(oldAlan(approve(make())));
  const completed = old.archiveAllocation({id: oldReply(oldAlan(approve(make()))).id, role: 'purchasing', expectedRevision: 4, requestId: rid()}).record;
  const rejectedRow = old.reviewAllocation({id: make().id, role: 'business', decision: 'reject', businessNote: '', expectedRevision: 1, requestId: rid()}).record;
  const oldInq = old.createInquiry({role: 'operation-1', model: b.model, quantity: 100, department: '一团', store: 'OLDUS', operator: '旧询库', fnsku: '000OLDINQ', asin: 'BOLDINQ037', requestId: rid()}).record;
  const iq = old.reviewInquiry({id: oldInq.id, role: 'business', decision: 'approve', approvedQuantity: 80, businessNote: '旧询库商务', ...common(oldInq)}).record;
  const before = snapshot(old.db), oldBalance = old.getBalance(b.batch_key); assert.equal(old.db.prepare('PRAGMA user_version').get().user_version, 36); old.close();
  const appliedAt = '2026-10-15T01:00:00.000Z', result = migrateInventoryDatabaseToCurrent({databasePath: legacyPath, appliedAt});
  assert.equal(result.fromVersion, 36); assert.equal(result.toVersion, INVENTORY_SCHEMA_VERSION);
  const migrated = new InventoryDatabase(legacyState);
  try {
    assert.equal(migrated.getDocument(business.id).inkWorkflowStage, 'pending_business');
    const p = migrated.getDocument(pending.id); stage(p, 'pending_alan'); assert.equal(p.alanDeadlineAt, new Date(Date.parse(appliedAt) + FIVE_HOURS).toISOString());
    assert.equal(p.reviewedAt, pending.reviewedAt); assert.deepEqual(p.events, pending.events); assert.equal(p.businessReviewedQuantity, 80);
    for (const r of [purchasing, toArchive, completed, rejectedRow]) {
      const found = migrated.getDocument(r.id); assert.equal(found.workflowMode, 'legacy'); assert.equal(found.inkWorkflowStage, null); assert.equal(found.procurementStatus, r.procurementStatus);
      assert.deepEqual(found.events, r.events); assert.equal(found.quantity, r.quantity);
    }
    assert.equal(migrated.getInquiry(iq.id).status, 'pending_alan'); alanEmpty(migrated.getInquiry(iq.id));
    assert.deepEqual(migrated.db.prepare('SELECT * FROM inventory_ledger').all(), before.inventory_ledger); assert.deepEqual(migrated.getBalance(b.batch_key), oldBalance);
    const migratedSnapshot = snapshot(migrated.db); assert.equal(migrateInventoryDatabaseToCurrent({databasePath: legacyPath}).changed, false); assert.deepEqual(snapshot(migrated.db), migratedSnapshot);
    let legacyRow = migrated.replyAllocation({id: purchasing.id, role: 'logistics', supplierQuantity: 50, procurementNote: '仍走旧链', ...common(migrated.getDocument(purchasing.id))}).record;
    legacyRow = migrated.archiveAllocation({id: legacyRow.id, role: 'logistics', ...common(legacyRow)}).record;
    assert.equal(legacyRow.workflowMode, 'legacy'); assert.equal(legacyRow.statusCode, 'confirmed');
    legacyRow = migrated.recallAllocation({id: legacyRow.id, role: 'purchasing', ...common(legacyRow)}).record;
    assert.equal(legacyRow.procurementStatus, 'pending_purchasing'); assert.equal(legacyRow.lockedQuantity, 60); assert.equal(legacyRow.alanQuantity, 60);
    migrated.assertInventoryInvariants(); assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
    migrationEvidence.push({legacyState, result, pendingId: pending.id, deadline: p.alanDeadlineAt, preservedLedgerRows: before.inventory_ledger.length, balanceUnchanged: true, oldDownstreamChainPreserved: true, migrationRepeatUnchanged: true});
  } finally {migrated.close();}
  check('真实43648e2 schema36→37：旧待商务/Alan接新链，启用+5h；旧后续/完成/拒绝和库存历史保留，旧采购回撤仍可用');
}

try {
  assert.equal(INVENTORY_SCHEMA_VERSION, 38);
  await migrationTest(); await start();
  const csv = 'ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n' + Array.from({length: 64}, (_, i) => `INK-V37,200,10,STOCK-V37-${i},SyntheticWarehouseA,P37-${i},2026-10-15,一团,V1`).join('\n');
  const fileName = '隔离新流程墨盒.csv';
  const previewResponse = await fetch(base + '/api/transit/preview', {method: 'POST', headers: {'x-role': 'admin', 'x-file-name': encodeURIComponent(fileName)}, body: csv});
  assert.equal(previewResponse.status, 200); const preview = await previewResponse.json();
  const imported = await api('/api/transit/import', 'admin', {previewToken: preview.previewToken, fileName, fileHash: preview.fileSha256, templateHash: preview.templateSha256, rows: preview.rows, requestId: rid()});
  for (const r of imported.rows) await api(`/api/transit/${r.id}/on-shelf`, 'assistant-1', {...common(r), yes: 'YES'});
  batches.push(...(await api('/api/inventory/catalog')).stockDetails['INK-V37']);
  assert.equal(batches.length, 64); assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, INVENTORY_SCHEMA_VERSION);
  // Synthetic metrics exercise audit-detail field permissions; no collector/account is contacted.
  db.syncLingxing({role: 'business', capturedAt: T0, requestId: rid(), items: ['BINKV37001', 'BINKV37002'].map(asin => ({asin, sales7d: 7, sales30d: 30, fbaAvailable: 10, fbaPendingTransfer: 0, fbaTransferring: 0, fbaInbound: 0, orderGrossProfit: 321}))});
  check('64个独立合成批次，H200/套箱10；独立状态目录、随机端口、服务实例身份均验证');

  let r = await allocation(); stage(r, 'pending_business'); balance(r, 200, 100);
  const original = {plan: r.plan, date: r.date, version: r.version, batchKey: r.batchKey};
  r = await review(r); stage(r, 'pending_alan'); balance(r, 200, 80);
  assert.equal(Date.parse(r.alanDeadlineAt) - Date.parse(r.reviewedAt), FIVE_HOURS);
  assert.equal(r.originalRequestedQuantity, 100); assert.equal(r.businessReviewedQuantity, 80);
  for (const role of ['admin', 'business', 'assistant-1', 'assistant-2', 'purchasing', 'logistics', 'operation-1']) await rejected(route('allocations', r, 'alan-review'), role, {...common(r), alanQuantity: 60});
  for (const invalid of [null, '', ' ', -1, 1.5]) await rejected(route('allocations', r, 'alan-review'), 'alan', {...common(r), alanQuantity: invalid, alanNote: '仅备注'}, 400);
  await rejected(route('allocations', r, 'alan-review'), 'alan', {...common(r), alanQuantity: 75}, 400);
  db.db.prepare('UPDATE stock_batches SET pack_per_box=NULL WHERE batch_key=?').run(r.batchKey);
  assert.equal((await rejected(route('allocations', r, 'alan-review'), 'alan', {...common(r), alanQuantity: 60}, 400, 'invalid_pack_per_box')).error, '来源批次的套/箱须为正整数，核对后才能提交。');
  db.db.prepare("UPDATE stock_batches SET pack_per_box='10' WHERE batch_key=?").run(r.batchKey);
  await rejected(route('allocations', r, 'alan-review'), 'alan', {...common(r), alanQuantity: 210}, 409);
  for (const role of ['purchasing', 'logistics']) for (const action of ['reply', 'archive', 'recall']) await rejected(route('allocations', r, action), role, {...common(r), supplierQuantity: 60});
  r = await alan(r); stage(r, 'pending_assistant'); balance(r, 200, 60);
  assert.equal(r.finalQuantity, 60); assert.equal(r.finalQuantitySource, 'alan'); assert.equal(r.originalRequestedQuantity, 100); assert.equal(r.businessReviewedQuantity, 80);
  assert.equal(r.businessNote, '商务独立备注80'); assert.equal(r.alanNote, 'Alan独立备注');
  await rejected(route('allocations', r, 'confirm'), 'assistant-2', common(r));
  // Deliberate isolated mismatch: the ledger still locks 60 while the document says 70.
  db.db.prepare('UPDATE allocation_documents SET quantity=70 WHERE id=?').run(r.id);
  await rejected(route('allocations', r, 'confirm'), 'assistant-1', common(r), 409, 'allocation_lock_mismatch');
  db.db.prepare('UPDATE allocation_documents SET quantity=60 WHERE id=?').run(r.id);
  const confirmRequest = common(r), jobsBefore = count('upgrade_jobs'), worksBefore = count('upgrade_relocation_work_items');
  const confirmation = await Promise.all([api(route('allocations', r, 'confirm'), 'assistant-1', confirmRequest), api(route('allocations', r, 'confirm'), 'assistant-1', confirmRequest)]);
  assert.equal(confirmation.filter(x => x.deduped).length, 1); r = current(r); stage(r, 'completed'); balance(r, 140, 0, 60);
  for (const [key, value] of Object.entries(original)) assert.equal(r[key], value);
  assert.equal(source('allocations', r).initialQuantity, 60); assert.equal(count('upgrade_jobs'), jobsBefore); assert.equal(count('upgrade_relocation_work_items'), worksBefore);
  await auditFor(r, 'confirm', {onHandDelta: -60, lockedDelta: -60});
  const completeSnapshot = snapshot(); assert.equal((await api(route('allocations', r, 'confirm'), 'assistant-1', confirmRequest)).deduped, true); assert.deepEqual(snapshot(), completeSnapshot);
  for (const role of ['purchasing', 'logistics']) await rejected(route('allocations', r, 'recall'), role, common(r));
  const deadlineBefore = r.alanDeadlineAt;
  r = (await api(route('allocations', r, 'recall'), 'business', common(r))).record; stage(r, 'pending_business'); balance(r, 200, 100); assert.equal(r.alanDeadlineAt, null); alanEmpty(r);
  const recalledSnapshot = snapshot(); assert.equal((await api(route('allocations', r, 'confirm'), 'assistant-1', confirmRequest)).deduped, true); assert.deepEqual(snapshot(), recalledSnapshot);
  await setClock(Date.parse(T0) + 60_000); r = await review(r, 'allocations', 70); balance(r, 200, 70); assert.notEqual(r.alanDeadlineAt, deadlineBefore);
  check('新调拨100→80→60由本团助理整量扣60；商务/Alan事实独立，采购禁办，重复确认仅一次，商务回撤重锁100并重新计时');

  for (const mode of ['zero', 'reject']) {
    let row = await review(await allocation());
    db.db.prepare('UPDATE stock_batches SET pack_per_box=NULL WHERE batch_key=?').run(row.batchKey);
    row = mode === 'zero' ? await alan(row, 'allocations', 0, '') : (await api(route('allocations', row, 'alan-review'), 'alan', {...common(row), decision: 'reject', alanNote: ''})).record;
    stage(row, 'rejected'); balance(row, 200, 0); assert.equal(row.businessReviewedQuantity, 80); assert.equal(source('allocations', row), undefined);
    assert.equal(row.alanQuantity, mode === 'zero' ? 0 : null);
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM inventory_ledger WHERE document_id=? AND entry_type='release_reservation'").get(row.id).n, 1);
    await auditFor(row, 'reject', {lockedDelta: -80});
    db.db.prepare("UPDATE stock_batches SET pack_per_box='10' WHERE batch_key=?").run(row.batchKey);
  }
  const rejectedBusiness = await review(await allocation(), 'allocations', 80, 'reject'); balance(rejectedBusiness, 200, 0); stage(rejectedBusiness, 'rejected');
  check('Alan0和独立拒绝理由可空，均只释放一次；商务拒绝同样不出库、不产生移仓来源');

  const timeRows = [];
  for (const offset of [-1, 0, 1]) {
    await stop(); await setClock(T0); await start();
    let row = await review(await allocation()); const deadline = row.alanDeadlineAt;
    await setClock(Date.parse(deadline) + offset);
    const result = await api(route('allocations', row, 'alan-review'), 'alan', {...common(row), alanQuantity: 60, alanNote: '边界'}, offset < 0 ? 200 : 409);
    row = current(row); stage(row, 'pending_assistant');
    assert.equal(row.finalQuantity, offset < 0 ? 60 : 80); assert.equal(row.finalQuantitySource, offset < 0 ? 'alan' : 'business');
    if (offset >= 0) alanEmpty(row);
    balance(row, 200, offset < 0 ? 60 : 80);
    if (offset >= 0) await rejected(route('allocations', row, 'alan-review'), 'alan', {...common(row), decision: 'reject'}, 409);
    timeRows.push({offsetMs: offset, status: result.httpStatus, final: row.finalQuantity});
  }
  timerEvidence.push({exactHttpBoundaries: timeRows});
  await stop(); await setClock(T0); await start(); let timerRow = await review(await allocation()); const originalDeadline = timerRow.alanDeadlineAt;
  await stop(); await setClock(Date.parse(originalDeadline) - 1500, true); await start(); assert.equal(current(timerRow).alanDeadlineAt, originalDeadline); stage(current(timerRow), 'pending_alan');
  // No business request is issued while the timer crosses its real remaining 1.5 seconds.
  await new Promise(resolve => setTimeout(resolve, 2300)); timerRow = current(timerRow); stage(timerRow, 'pending_assistant'); alanEmpty(timerRow); balance(timerRow, 200, 80);
  const timerEvents = timerRow.events.filter(event => event.type === 'alan_timeout'); assert.equal(timerEvents.length, 1);
  await stop(); await setClock(Date.parse(originalDeadline) + 60_000); await start(); assert.equal(current(timerRow).events.filter(event => event.type === 'alan_timeout').length, 1);
  const timerConfirmed = await confirm(current(timerRow)); balance(timerConfirmed, 120, 0, 80); assert.equal(source('allocations', timerConfirmed).initialQuantity, 80);
  timerEvidence.push({id: timerRow.id, originalDeadline, restartDidNotReset: true, noBusinessRequestWhileWaiting: true, timeoutEventCount: 1, onHandAfterConfirmation: 120});
  await stop(); await setClock(T0); await start(); const startupDue = await review(await allocation());
  await stop(); await setClock(Date.parse(startupDue.alanDeadlineAt) + 1); await start();
  const startupAdvanced = current(startupDue); stage(startupAdvanced, 'pending_assistant'); alanEmpty(startupAdvanced); balance(startupAdvanced, 200, 80);
  assert.equal(startupAdvanced.events.filter(event => event.type === 'alan_timeout').length, 1);
  timerEvidence.push({id: startupDue.id, case: 'restart-after-deadline', deadline: startupDue.alanDeadlineAt, noBusinessRequest: true, timeoutEventCount: 1});
  check('HTTP截止前1ms/截止时/截止后严格边界；重启保留期限，离线实时定时推进且重启不重复，超时单助理只扣商务80');

  await stop(); await setClock(T0); await start();
  const failureBatch = batches[batchIndex++]; let failedRecall = await completeAllocation(failureBatch); const other = await allocation(120, failureBatch);
  const failBefore = snapshot(); await api(route('allocations', failedRecall, 'recall'), 'business', common(failedRecall), 409); assert.deepEqual(snapshot(), failBefore);
  assert.equal(db.getBalance(failedRecall.batchKey).onHand, 140); assert.equal(db.getBalance(failedRecall.batchKey).locked, 120);
  await review(other, 'allocations', 120, 'reject'); failedRecall = (await api(route('allocations', failedRecall, 'recall'), 'business', common(failedRecall))).record; balance(failedRecall, 200, 100);
  const linked = await completeAllocation(); const work = (await api('/api/upgrades/relocation-work-items', 'operation-1', {allocationId: linked.id, requestId: rid()})).workItem;
  const blocked = await rejected(route('allocations', linked, 'recall'), 'business', common(linked), 409); assert(blocked.details.blockers.some(item => item.number === work.workNo));
  check('退60后不足重锁100整笔不变；释放他单后回撤成功，已有真实移仓待办阻止商务回撤');

  const convertedBase = await allocation(), conversionRequest = {...common(convertedBase), approvedQuantity: 80, businessNote: '转换商务备注'};
  for (const role of ROLES.filter(value => value !== 'business')) await rejected(route('allocations', convertedBase, 'transfer-inquiry'), role, conversionRequest);
  const ledgerBeforeConvert = count('inventory_ledger'); let converted = await transfer(convertedBase, 80, conversionRequest);
  stage(converted, 'pending_conversion_confirmation'); balance(converted, 200, 0); assert.equal(converted.businessReviewedQuantity, 80);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM inquiry_documents WHERE source_allocation_id=?').get(converted.id).n, 0);
  assert.equal(count('inventory_ledger'), ledgerBeforeConvert + 1); assert(!converted.events.some(event => event.type === 'review'));
  const convertedSnapshot = snapshot(); assert.equal((await api(route('allocations', converted, 'transfer-inquiry'), 'business', conversionRequest)).deduped, true); assert.deepEqual(snapshot(), convertedSnapshot);
  for (const action of ['alan-review', 'confirm', 'reply', 'archive']) await rejected(route('allocations', converted, action), action === 'alan-review' ? 'alan' : action === 'confirm' ? 'assistant-1' : 'purchasing', {...common(converted), alanQuantity: 60, supplierQuantity: 60}, action === 'reply' || action === 'archive' ? 403 : 409);
  for (const role of ROLES.filter(value => value !== 'operation-1')) await rejected(route('allocations', converted, 'conversion-decision'), role, {...common(converted), decision: 'accept'});
  const decisionRequest = {...common(converted), decision: 'accept'}, accepted = await Promise.all([decide(converted, 'accept', 'operation-1', decisionRequest), decide(converted, 'accept', 'operation-1', decisionRequest)]);
  assert.equal(accepted.filter(result => result.deduped).length, 1); converted = current(converted); stage(converted, 'converted');
  await rejected(route('allocations', converted, 'conversion-decision'), 'operation-1', {...decisionRequest, decision: 'reject'}, 409, 'idempotency_conflict');
  const linkedInquiries = db.db.prepare('SELECT id FROM inquiry_documents WHERE source_allocation_id=?').all(converted.id); assert.equal(linkedInquiries.length, 1);
  let convertedInquiry = db.getInquiry(Number(linkedInquiries[0].id)); assert.equal(convertedInquiry.status, 'pending_purchasing'); assert.equal(convertedInquiry.sourceAllocationId, converted.id);
  assert.equal(convertedInquiry.originalRequestedQuantity, 80); assert.equal(convertedInquiry.businessReviewedQuantity, 80); alanEmpty(convertedInquiry);
  for (const key of ['plan', 'date', 'version']) assert.equal(convertedInquiry[key], '');
  assert(!convertedInquiry.events.some(event => ['review', 'alan_review'].includes(event.type))); assert.equal(source('allocations', converted), undefined);
  const noInventory = inventory(); convertedInquiry = await archive(await reply(convertedInquiry, 60)); assert.deepEqual(inventory(), noInventory); assert.equal(source('inquiries', convertedInquiry).initialQuantity, 60);
  assert.equal(convertedInquiry.originalRequestedQuantity, 80); assert.equal(convertedInquiry.businessReviewedQuantity, 80);
  await auditFor(convertedInquiry, 'inquiry_completed', {inquiry: true});
  convertedInquiry = (await api(route('inquiries', convertedInquiry, 'recall'), 'logistics', common(convertedInquiry))).record;
  assert.equal(convertedInquiry.status, 'pending_purchasing'); assert.equal(convertedInquiry.originalRequestedQuantity, 80); assert.equal(convertedInquiry.businessReviewedQuantity, 80); alanEmpty(convertedInquiry); assert.deepEqual(inventory(), noInventory);
  convertedInquiry = await archive(await reply(convertedInquiry)); convertedInquiry = (await api(route('inquiries', convertedInquiry, 'recall'), 'business', common(convertedInquiry))).record;
  assert.equal(convertedInquiry.status, 'pending_business'); assert.equal(convertedInquiry.originalRequestedQuantity, 80); assert.deepEqual(inventory(), noInventory);
  convertedInquiry = await review(convertedInquiry, 'inquiries', 90); convertedInquiry = await alan(convertedInquiry, 'inquiries', 70); convertedInquiry = await archive(await reply(convertedInquiry));
  convertedInquiry = (await api(route('inquiries', convertedInquiry, 'recall'), 'purchasing', common(convertedInquiry))).record;
  assert.equal(convertedInquiry.originalRequestedQuantity, 80); assert.equal(convertedInquiry.businessReviewedQuantity, 90); assert.equal(convertedInquiry.alanQuantity, 70); assert.deepEqual(inventory(), noInventory);
  balance(converted, 200, 0);
  check('转换正式保存商务80即释放100；接受才唯一建询库直采购，无假review/Alan；采购60完成后两类回撤及再批90恢复真实轮次且永不重锁原批次');

  let refused = await transfer(await allocation(), 75); const releaseCount = count('inventory_ledger'), inquiryCount = count('inquiry_documents');
  refused = (await decide(refused, 'reject')).record; stage(refused, 'rejected'); balance(refused, 200, 0); assert.equal(count('inventory_ledger'), releaseCount); assert.equal(count('inquiry_documents'), inquiryCount);
  const conversionRaceRow = await transfer(await allocation(), 80);
  const conversionRace = await Promise.all([api(route('allocations', conversionRaceRow, 'conversion-decision'), 'operation-1', {...common(conversionRaceRow), decision: 'accept'}, null), api(route('allocations', conversionRaceRow, 'conversion-decision'), 'operation-1', {...common(conversionRaceRow), decision: 'reject'}, null)]);
  assert.deepEqual(conversionRace.map(result => result.httpStatus).sort(), [200, 409]);
  const conversionRaceFinal = current(conversionRaceRow), resultingInquiryCount = db.db.prepare('SELECT COUNT(*) n FROM inquiry_documents WHERE source_allocation_id=?').get(conversionRaceRow.id).n;
  assert.equal(resultingInquiryCount, conversionRaceFinal.inkWorkflowStage === 'converted' ? 1 : 0); balance(conversionRaceFinal, 200, 0);
  raceEvidence.push({kind: 'conversion-accept-reject-distinct-requests', statuses: conversionRace.map(result => result.httpStatus), inquiryCount: resultingInquiryCount});
  check('转换量75不受原批次套箱10限制；运营拒绝不建询库、不重复释放、无移仓来源');

  const pureInventory = inventory(), exportCases = [];
  for (const actor of ['purchasing', 'logistics']) {
    let iq = await review(await inquiry(100, 'SKIP-' + actor), 'inquiries'); const p = {...common(iq), supplierQuantity: 60, shippingWarehouse: 'CA', procurementNote: '采购跳过'};
    iq = await reply(iq, 60, actor, p); alanEmpty(iq); assert.equal(iq.status, 'pending_assistant'); assert.equal(iq.originalRequestedQuantity, 100); assert.equal(iq.businessReviewedQuantity, 80);
    assert.equal(iq.events.findLast(event => event.type === 'reply').payload.skippedAlan, true);
    const stale = await api(route('inquiries', iq, 'alan-review'), 'alan', {...common(iq), alanQuantity: 20}, 409); assert(stale.code);
    exportCases.push(iq); iq = await archive(iq, actor); await auditFor(iq, 'inquiry_completed', {inquiry: true});
    iq = (await api(route('inquiries', iq, 'recall'), actor, common(iq))).record; alanEmpty(iq); assert.equal(iq.status, 'pending_purchasing');
  }
  let zeroAlan = await alan(await review(await inquiry(100, 'ALAN-ZERO'), 'inquiries'), 'inquiries', 0, '确认为零的意见');
  assert.equal(zeroAlan.status, 'pending_purchasing'); exportCases.push(zeroAlan); zeroAlan = await reply(zeroAlan, 0); assert.equal(zeroAlan.status, 'rejected'); assert.equal(zeroAlan.alanQuantity, 0);
  await auditFor(zeroAlan, 'inquiry_rejected', {inquiry: true}); assert.equal(source('inquiries', zeroAlan), undefined);
  const rejectedInquiry = await review(await inquiry(), 'inquiries', 80, 'reject'); await auditFor(rejectedInquiry, 'inquiry_rejected', {inquiry: true});
  assert.deepEqual(inventory(), pureInventory);
  check('采购及物流即时跳过+回复同操作，Alan四字段NULL；Alan0仍待采购、采购0拒绝，完成/拒绝有零变动流水及团队隔离');

  for (let attempt = 0; attempt < 3; attempt++) {
    let iq = await review(await inquiry(), 'inquiries'); const pa = {...common(iq), alanQuantity: 70, alanNote: '竞争Alan'}, pp = {...common(iq), supplierQuantity: 60, shippingWarehouse: 'SC', procurementNote: '竞争采购'};
    const results = await Promise.all([api(route('inquiries', iq, 'alan-review'), 'alan', pa, null), api(route('inquiries', iq, 'reply'), 'purchasing', pp, null)]);
    assert.deepEqual(results.map(result => result.httpStatus).sort(), [200, 409]); iq = currentInquiry(iq);
    if (results[1].httpStatus === 200) alanEmpty(iq); else assert.equal(iq.alanQuantity, 70);
    raceEvidence.push({kind: 'inquiry-alan-purchasing', attempt, statuses: results.map(result => result.httpStatus)});
    const ar = await review(await allocation()), aa = {...common(ar), alanQuantity: 60}, ab = {...common(ar), decision: 'reject'};
    const allocationRace = await Promise.all([api(route('allocations', ar, 'alan-review'), 'alan', aa, null), api(route('allocations', ar, 'alan-review'), 'alan', ab, null)]);
    assert.deepEqual(allocationRace.map(result => result.httpStatus).sort(), [200, 409]);
    balance(ar, 200, current(ar).inkWorkflowStage === 'rejected' ? 0 : 60);
    raceEvidence.push({kind: 'allocation-alan-submit-reject', attempt, statuses: allocationRace.map(result => result.httpStatus)});
  }
  check('实际HTTP并发Alan/采购、调拨提交/拒绝各三轮，仅一个结果生效，无双重锁定或释放');

  const exportHeaders = ['型号', '商务部审核数量', 'Alan审核数量', 'Alan备注', '供应商库存回复', '发货仓库', '采购备注', '调拨部门', '调拨店铺', '调拨运营', '已贴FNSKU', '提交时间', '状况'];
  for (const [name, filters] of [['all', {category: '墨盒', type: 'inquiry'}], ['empty', {search: 'NO-MATCH-V37-EXPORT'}]]) {
    const before = snapshot(), response = await fetch(base + '/api/approvals/inquiries/export?' + new URLSearchParams(filters), {headers: {'x-role': 'purchasing'}}); assert.equal(response.status, 200);
    const file = path.join(out, `inquiry-${name}.xlsx`); await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
    const read = JSON.parse(execFileSync(process.env.ASTER_TEST_PYTHON || 'python', [path.join(root, 'scripts/fixtures/read-inquiry-export.py'), file], {encoding: 'utf8', windowsHide: true}));
    assert.deepEqual(read.rows[0], exportHeaders); assert.equal(read.maxColumn, 13);
    if (name === 'empty') assert.equal(read.maxRow, 1);
    else {
      const skipped = read.rows.find(row => row[9] === 'SKIP-purchasing'); assert(skipped); assert.equal(skipped[1], 80); assert.equal(skipped[2], null); assert.equal(skipped[3], null); assert.equal(skipped[10], '00002-V37');
      const zero = read.rows.find(row => row[9] === 'ALAN-ZERO'); assert(zero); assert.equal(zero[1], 80); assert.equal(zero[2], 0); assert.equal(zero[3], '确认为零的意见'); assert.equal(zero[4], 0);
      assert.equal(read.types[read.rows.indexOf(zero)][2], 'n');
    }
    assert.deepEqual(snapshot(), before); downloads.push({file, columns: read.maxColumn, rows: read.maxRow - 1, reader: 'openpyxl', databaseUnchanged: true});
  }
  for (const role of ROLES.filter(value => !['admin', 'purchasing', 'logistics'].includes(value))) assert.equal((await fetch(base + '/api/approvals/inquiries/export', {headers: {'x-role': role}})).status, 403);
  check('实际XLSX经openpyxl独立读取：13列不变、商务原80而非采购60、Alan NULL/数值0分开、FNSKU前导0、空筛选及导出只读');

  const toner = db.db.prepare("SELECT * FROM catalog_models WHERE category='硒鼓' LIMIT 1").get();
  if (!toner) db.db.prepare("INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at) VALUES('TONER-V37','硒鼓',0,0,?)").run(T0);
  let tq = (await api('/api/inquiries', 'operation-1', {model: toner?.model || 'TONER-V37', quantity: 100, department: '一团', store: 'TONERUS', operator: '硒鼓原链', fnsku: '000TONER', asin: 'BTONERV37', requestId: rid()})).record;
  tq = await review(tq, 'inquiries'); assert.equal(tq.status, 'pending_purchasing'); tq = await reply(tq, 0); assert.equal(tq.status, 'rejected');
  const beforeRestart = snapshot(); await stop(); db.close(); db = new InventoryDatabase(state); await start(); assert.deepEqual(snapshot(), beforeRestart);
  db.assertInventoryInvariants(); assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(db.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  check('硒鼓新规则0回复直接拒绝；服务/数据库重启、全部库存恒等式及外键保持');
} catch (error) {failure = error.stack; throw error;}
finally {
  await stop(); db?.close();
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({version: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), schemaVersion: INVENTORY_SCHEMA_VERSION, state, base, checks, rejectedRequests, quantities, downloads, migrationEvidence, raceEvidence, timerEvidence, failure: failure ?? null, productionWrites: 0, realLingxingRequests: 0}, null, 2));
}
console.log(`INK_WORKFLOW_V37_PASS ${checks.length} groups; ${rejectedRequests.length} rejected requests unchanged`);
