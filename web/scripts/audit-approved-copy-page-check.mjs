// Approved audit-copy checks. Synthetic fixture + owned HTTP server only; no browser automation.
// ASTER_WEB_DIST=<independent build> node web/scripts/audit-approved-copy-page-check.mjs --serve
// Stop the owned fixture by creating the stopRequest file printed in fixture.json.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createTestInstanceId, freePort, waitForOwnedServer } from '../../scripts/test-server-ownership.mjs';

const root = path.resolve(import.meta.dirname, '../..');
assert(process.env.ASTER_WEB_DIST, 'Explicit isolated ASTER_WEB_DIST is required');
const dist = path.resolve(process.env.ASTER_WEB_DIST);
assert.notEqual(dist, path.join(root, 'web', 'dist'), 'Use an independent build, not the shared web/dist');
await fs.access(path.join(dist, 'index.html'));
const outputRoot = path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT || path.join(root, '.test-output', 'audit-approved-copy'));
await fs.mkdir(outputRoot, { recursive: true });
const out = await fs.mkdtemp(path.join(outputRoot, 'run-'));
const state = path.join(out, 'state');
await fs.mkdir(state);
const runtimeConfig = path.join(state, 'synthetic-runtime.json');
const accounts = path.join(state, 'synthetic-accounts.json');
await fs.writeFile(runtimeConfig, JSON.stringify({ schemaVersion: 1, overseasWarehouses: ['SyntheticWarehouseA', 'SyntheticWarehouseB'] }));
await fs.writeFile(accounts, JSON.stringify({ accounts: [{ account: 'AUS', shortName: 'SYNTH', room: 'R001', sourceCell: 'synthetic' }] }));
process.env.ASTER_RUNTIME_CONFIG = runtimeConfig;
process.env.ASTER_OVERSEAS_WAREHOUSES = 'SyntheticWarehouseA;SyntheticWarehouseB';
process.env.ASTER_WAREHOUSE_ACCOUNTS = accounts;
const { createInventoryDatabase, InventoryDatabase } = await import('../../inventory-db.mjs');
createInventoryDatabase({ databasePath: path.join(state, 'data', 'aster-inventory.sqlite'), seedCatalogData: false });
const db = new InventoryDatabase(state);
const requestId = () => crypto.randomUUID();
const current = record => db.getDocument(record.id);
const common = record => ({ expectedRevision: record.revision, requestId: requestId() });
const startedAt = new Date().toISOString();
const instanceId = createTestInstanceId('audit-approved-copy');
let port = await freePort();
while (port === 4173) port = await freePort();
const base = `http://127.0.0.1:${port}`;
const stopRequest = path.join(out, 'stop-request.json');
const checks = [], requests = [], services = [];
let child, failure, serverLog = '', stopping = false;
const json = (name, value) => fs.writeFile(path.join(out, `${name}.json`), JSON.stringify(value, null, 2));
const check = (name, detail = {}) => { checks.push({ name, ...detail }); console.log(`PASS ${name}`); };

function seedBatch(suffix, { team = '一团', warehouse = '合成来源仓A', shippingMethod = '海运' } = {}) {
  const model = `AUDIT-COPY-TONER-${suffix}`;
  const rows = [{ sourceRow: 2, data: { model, quantity: 500, packPerBox: '10', fnsku: `SOURCE-${suffix}`, shippingMethod: 'SyntheticWarehouseA', plan: `AUDIT-PLAN-${suffix}`, date: '2026-10-19', team, version: 'V1' } }];
  const proof = { kind: 'import', role: 'admin', fileName: `synthetic-硒鼓-${suffix}.csv`, fileHash: `synthetic-${requestId()}`, templateHash: 'synthetic-template', payload: { rows } };
  const transit = db.transitImport({ ...proof, rows, previewToken: db.createTransitPreviewToken(proof).token, requestId: requestId() }).rows[0];
  const shelf = db.markTransitOnShelf({ id: transit.id, role: team === '一团' ? 'assistant-1' : 'assistant-2', yes: 'YES', ...common(transit) });
  db.db.prepare('UPDATE stock_batches SET warehouse=?,shipping_method=? WHERE batch_key=?').run(warehouse, shippingMethod, shelf.batchKey);
  const batch = db.getCatalog().stockDetails[model].find(row => row.batchKey === shelf.batchKey);
  return { ...batch, model, team, warehouse, shippingMethod };
}

function allocation(batch, operator) {
  return db.createAllocation({ role: batch.team === '一团' ? 'operation-1' : 'operation-2', model: batch.model, sourceBatchKey: batch.batchKey, plan: batch.plan, date: batch.date, version: batch.version, quantity: 20, department: batch.team, store: 'AUS', operator, fnsku: `DEST-${batch.model}`, asin: 'B0AUDIT001', operatorNote: `合成运营备注-${operator}`, requestId: requestId() }).record;
}

function legacyAllocation(batch) {
  return db.transaction(() => {
    const at = new Date().toISOString();
    const record = db.insertDocument({ role: 'operation-1', model: batch.model, batchKey: batch.batchKey, plan: batch.plan, date: batch.date, version: batch.version, fnsku: 'LEGACY-DEST', quantity: 10, department: '一团', store: 'AUS', operator: '合成旧式当前批次', asin: 'B0AUDIT001', operatorNote: '合成旧式事件，无来源快照', time: at, status: 'pending', at, submittedByRole: 'operation-1', submittedAt: at });
    db.addLedger(record.id, batch.batchKey, 'reserve', 0, 10, 'operation-1', at);
    db.addEvent(record.id, 'entry', 'operation-1', at, '合成历史原因保留', { quantity: 10, department: '一团', store: 'AUS', operator: '合成旧式当前批次', fnsku: 'LEGACY-DEST', asin: 'B0AUDIT001' });
    return current(record);
  });
}

function convertedInquiry(batch) {
  let record = allocation(batch, '合成转询库来源');
  record = db.transferAllocationToInquiry({ id: record.id, role: 'business', approvedQuantity: 30, businessNote: '合成转询库原因保留', ...common(record) }).record;
  const converted = db.decideAllocationConversion({ id: record.id, role: 'operation-1', decision: 'accept', ...common(record) });
  let inquiry = db.replyInquiry({ id: converted.inquiry.id, role: 'purchasing', supplierQuantity: 30, shippingWarehouse: 'CA', procurementNote: '合成采购备注保留', ...common(converted.inquiry) }).record;
  inquiry = db.archiveInquiry({ id: inquiry.id, role: 'purchasing', plan: 'AUDIT-INQUIRY-PLAN', date: '2026-10-20', version: 'V1', ...common(inquiry) }).record;
  return { allocation: current(record), inquiry };
}

function rejectedInquiry(batch) {
  let inquiry = db.createInquiry({ role: 'operation-1', model: batch.model, quantity: 10, department: '一团', store: 'AUS', operator: '合成独立拒绝询库', fnsku: 'INQUIRY-DEST', asin: 'B0AUDIT001', operatorNote: '合成独立询库备注', requestId: requestId() }).record;
  return db.reviewInquiry({ id: inquiry.id, role: 'business', decision: 'reject', businessNote: '合成商务拒绝原因保留', ...common(inquiry) }).record;
}

function snapshotBusinessTables() {
  return Object.fromEntries(['allocation_documents', 'inquiry_documents', 'document_events', 'inquiry_events', 'stock_batches', 'inventory_ledger', 'upgrade_inventory_ledger'].map(table => [table, db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

async function get(route, role = 'admin', status = 200) {
  const response = await fetch(base + route, { headers: { 'x-role': role } });
  const body = await response.json();
  requests.push({ method: 'GET', route, role, status: response.status });
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

const batches = {
  first: seedBatch('ONE'),
  second: seedBatch('TWO', { warehouse: '合成来源仓B', shippingMethod: '空运' }),
  otherTeam: seedBatch('TEAM2', { team: '二团', warehouse: '合成二团仓', shippingMethod: '二团海运' }),
};
const first = allocation(batches.first, '合成流水第一条');
const second = allocation(batches.second, '合成流水第二条');
const legacy = legacyAllocation(batches.first);
const linked = convertedInquiry(batches.first);
const rejected = rejectedInquiry(batches.second);
const otherTeam = allocation(batches.otherTeam, '合成二团独立记录');
let confirmed = allocation(batches.first, '合成移仓调拨来源');
confirmed = db.reviewAllocation({ id: confirmed.id, role: 'business', decision: 'approve', approvedQuantity: 20, businessNote: '合成商务批准', ...common(confirmed) }).record;
confirmed = db.confirmAllocation({ id: confirmed.id, role: 'assistant-1', ...common(confirmed) }).record;
db.refreshApprovalDisplay();
db.assertInventoryInvariants();
assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
const baseline = snapshotBusinessTables();
const events = db.audit({ limit: 500 });
const eventFor = (action, record, kind = 'allocation') => events.find(row => row.eventType === action && (kind === 'inquiry' ? row.inquiryId === record.id : row.documentId === record.id));
const cases = [
  ['entry-first', 'entry', first], ['entry-second', 'entry', second], ['entry-current-batch', 'entry', legacy],
  ['entry-linked-allocation', 'entry', linked.allocation], ['inquiry-completed', 'inquiry_completed', linked.inquiry, 'inquiry'],
  ['inquiry-rejected', 'inquiry_rejected', rejected, 'inquiry'], ['entry-other-team', 'entry', otherTeam],
  ['confirmed-relocation-source', 'confirm', confirmed],
].map(([name, action, record, kind = 'allocation']) => {
  const event = eventFor(action, record, kind);
  assert(event, `Missing fixture event ${name}`);
  return { name, action, kind, id: record.id, documentNo: record.documentNo, model: record.model, operator: record.operator, team: record.department, eventId: event.eventId, sourceBatchInfo: kind === 'allocation' ? record.sourceBatchInfo : undefined };
});

async function httpChecks() {
  const before = snapshotBusinessTables();
  for (const role of ['admin', 'operation-1', 'assistant-1']) {
    const visible = await get('/api/audit?limit=500', role);
    assert(visible.records.some(row => row.documentId === first.id));
    assert.equal(visible.records.some(row => row.documentId === otherTeam.id), role === 'admin');
    for (const item of cases.filter(row => role === 'admin' || row.team === '一团')) {
      const detail = await get(`/api/audit/${item.eventId}`, role);
      assert.equal(detail.record.eventId, item.eventId);
      assert.equal(detail.sourceAvailable, true);
      assert.equal(detail.document.id, item.id);
      assert.equal(detail.document.documentNo, item.documentNo);
      assert.equal(detail.record.businessNo, item.documentNo);
      const history = await get(`/api/${item.kind === 'inquiry' ? 'inquiries' : 'allocations'}/${item.id}/history`, role);
      assert.equal(history.document.documentNo, item.documentNo);
      if (item.sourceBatchInfo) assert.deepEqual(history.document.sourceBatchInfo, item.sourceBatchInfo);
    }
    const a = await get(`/api/allocations/${linked.allocation.id}/history`, role);
    const i = await get(`/api/inquiries/${linked.inquiry.id}/history`, role);
    assert.equal(a.document.convertedInquiryId, i.document.id);
    assert.equal(i.document.sourceAllocationId, a.document.id);
    const approvals = await get('/api/approvals', role);
    assert(approvals.allocations.some(row => row.id === first.id));
    assert.equal(approvals.allocations.some(row => row.id === otherTeam.id), role === 'admin');
  }
  const forbidden = cases.find(row => row.name === 'entry-other-team');
  await get(`/api/audit/${forbidden.eventId}`, 'operation-1', 403);
  await get(`/api/allocations/${otherTeam.id}/history`, 'operation-1', 403);
  assert.equal(db.getDocument(legacy.id).sourceBatchInfo.origin, 'current_batch');
  assert.equal(db.getDocument(first.id).sourceBatchInfo.origin, 'snapshot');
  assert(db.getRelocationCandidates().some(row => row.allocationId === confirmed.id));
  assert(db.getRelocationCandidates().some(row => row.inquiryId === linked.inquiry.id));
  assert.deepEqual(snapshotBusinessTables(), before);
  assert.deepEqual(snapshotBusinessTables(), baseline);
  check('HTTP GET preserves document numbers, source data, links and business tables; admin/team roles remain scoped');
}

async function stop() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  const closed = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
  });
  services.at(-1).stopped = { at: new Date().toISOString(), portClosed: closed, exitCode: child.exitCode, signal: child.signalCode };
  assert(closed, 'Owned fixture port must close');
  child = undefined;
}

try {
  child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ASTER_STATE_ROOT: state, ASTER_WEB_DIST: dist, ASTER_RUNTIME_CONFIG: runtimeConfig, ASTER_WAREHOUSE_ACCOUNTS: accounts, HOST: '127.0.0.1', PORT: String(port), PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId } });
  child.stdout.on('data', data => { serverLog += data; });
  child.stderr.on('data', data => { serverLog += data; });
  services.push({ pid: child.pid, port, startedAt: new Date().toISOString() });
  await waitForOwnedServer({ base, child, instanceId });
  await httpChecks();
  const fixture = { root, out, state, dist, base, instanceId, stopRequest, cases, linked: { allocationId: linked.allocation.id, allocationNo: linked.allocation.documentNo, inquiryId: linked.inquiry.id, inquiryNo: linked.inquiry.documentNo }, sharedEntries: { stockDetailModel: first.model, approvalModel: first.model, relocationAllocationId: confirmed.id, relocationAllocationNo: confirmed.documentNo, relocationInquiryId: linked.inquiry.id, relocationInquiryNo: linked.inquiry.documentNo }, browserChecksPending: ['查看详情入口和所选记录一致；开关外层及关联弹窗', '库存流水打开的调拨/询库详情标题不带编号，关联链接编号仍完整', '同一关联弹窗在调拨和承接询库之间切换后仍隐藏标题编号', '流水记录详情不再重复业务动作字段，其余字段保持', '仅库存流水调拨来源按发货方式在前、仓库在后且一行；当前批次标记保留', '管理员及运营一团/助理一团；二团记录隔离', '审批中心、在库明细、移仓来源的原标题和仓库在前的原排列保持'] };
  await json('fixture', fixture);
  console.log(JSON.stringify({ ready: true, base, out, fixture: path.join(out, 'fixture.json'), stopRequest, cases }, null, 2));
  if (process.argv.includes('--serve')) {
    const requestStop = () => { stopping = true; };
    process.once('SIGINT', requestStop);
    process.once('SIGTERM', requestStop);
    while (!stopping) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned fixture server exited while browser checks were pending');
      try { await fs.access(stopRequest); stopping = true; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    await httpChecks();
  }
} catch (error) {
  failure = error.stack;
  process.exitCode = 1;
  console.error(failure);
} finally {
  try { await stop(); } catch (error) { failure = [failure, error.stack].filter(Boolean).join('\n'); process.exitCode = 1; }
  db.close();
  await json('requests', requests);
  await json('service-log', { text: serverLog });
  await json('result', { requirement: 'audit-approved-copy-01-06', startedAt, finishedAt: new Date().toISOString(), base, out, state, dist, instanceId, checks, services, failure, exitCode: failure ? 1 : 0, browserChecks: 'Not run by this fixture; use CUA against base and record actual evidence separately', productionWrites: 0 });
}
