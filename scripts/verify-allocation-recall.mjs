// Requirement 13.3: owned loopback server, fresh synthetic state/configuration, no production access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { freePort, createTestInstanceId, waitForOwnedServer } from './test-server-ownership.mjs';
const repo = path.resolve(import.meta.dirname, '..'), root = path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT || path.join(repo, '.test-output/allocation-recall'));
await fs.mkdir(root, { recursive: true });
const out = await fs.mkdtemp(path.join(root, 'attempt-')), state = path.join(out, 'state');
process.env.ASTER_RUNTIME_CONFIG = path.join(out, 'synthetic-runtime.json');
process.env.ASTER_WAREHOUSE_ACCOUNTS = path.join(out, 'synthetic-accounts.json');
process.env.ASTER_OVERSEAS_WAREHOUSES = 'SyntheticWarehouseA;SyntheticWarehouseB';
await fs.writeFile(process.env.ASTER_RUNTIME_CONFIG, JSON.stringify({ schemaVersion: 1, overseasWarehouses: ['SyntheticWarehouseA', 'SyntheticWarehouseB'] }));
await fs.writeFile(process.env.ASTER_WAREHOUSE_ACCOUNTS, JSON.stringify({ accounts: [{ account: 'A号', shortName: 'SYNTHETIC', room: 'TEST-13-3' }] }));
const { InventoryDatabase, createInventoryDatabase, ROLES } = await import(pathToFileURL(path.join(repo, 'inventory-db.mjs')));
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite'), seedCatalogData: false });
const db = new InventoryDatabase(state), port = await freePort(), base = `http://127.0.0.1:${port}`, instanceId = createTestInstanceId('allocation-recall');
const checks = [], trace = [], rejected = [], fixtureChanges = [], snapshots = [];
let child, failure, diagnostics = '';
const rid = () => crypto.randomUUID(), common = r => ({ expectedRevision: r.revision, requestId: rid() });
const all = () => Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.db.prepare(`SELECT * FROM "${name}"`).all()]));
const serial = value => JSON.parse(JSON.stringify(value));
const check = (name, evidence = {}) => { checks.push({ name, evidence }); console.log('PASS ' + name); };
const current = r => db.getDocument(r.id), ledger = r => db.db.prepare('SELECT * FROM inventory_ledger WHERE document_id=? ORDER BY id').all(r.id);
function fixture(model, category = '硒鼓', team = '一团', suffix = 'A') {
  const at = new Date().toISOString(), key = model + '-' + suffix;
  if (!db.getModel(model)) db.db.prepare('INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at) VALUES(?,?,0,0,?)').run(model, category, at);
  db.db.prepare("INSERT INTO stock_batches(batch_key,model,plan,ship_date,version,fnsku,base_quantity,updated_at,pack_per_box,source_team,warehouse,shipping_method) VALUES(?,?,?,'2026-10-19','V1','SRC',100,?,'10',?,?,?)").run(key, model, model + '-P', at, team, suffix === 'B' ? 'SyntheticWarehouseB' : 'SyntheticWarehouseA', '原来源发货方式-' + suffix);
  return db.db.prepare('SELECT * FROM stock_batches WHERE batch_key=?').get(key);
}
const body = (b, quantity = 20, zero = false) => ({ model: b.model, sourceBatchKey: b.batch_key, plan: b.plan, date: b.ship_date, version: b.version, quantity, department: b.source_team,
  store: 'RECALLUS', operator: '13.3隔离运营', fnsku: 'OPERATOR-CODE', asin: 'BRECALL133', operatorNote: '原运营备注', requestId: rid(), ...(zero ? { zeroAvailableConfirmed: true } : {}) });
async function api(route, role = 'business', payload, status = 200) {
  const response = await fetch(base + route, { method: payload === undefined ? 'GET' : 'POST', headers: { 'x-role': role, 'content-type': 'application/json', connection: 'close' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const result = await response.json(); trace.push({ at: new Date().toISOString(), route, role, payload, status: response.status, result });
  if (status !== null) assert.equal(response.status, status, JSON.stringify(result)); return { ...result, httpStatus: response.status };
}
async function deny(route, role, payload, status, code) {
  const before = all(), result = await api(route, role, payload, status); if (code) assert.equal(result.code, code);
  assert.deepEqual(all(), before); rejected.push({ route, role, payload, status, code: result.code, allTablesUnchanged: true }); return result;
}
async function replay(route, role, payload, record) {
  const before = all(), result = await api(route, role, payload); assert.equal(result.deduped, true); if (record) assert.deepEqual(result.record, serial(record)); assert.deepEqual(all(), before); return result;
}
const create = async (b, quantity = 20, zero = false) => (await api('/api/allocations', b.source_team === '二团' ? 'operation-2' : 'operation-1', body(b, quantity, zero))).record;
const approve = async (r, quantity) => (await api(`/api/allocations/${r.id}/review`, 'business', { ...common(r), decision: 'approve', approvedQuantity: quantity, businessNote: '原商务备注' })).record;
const reject = async r => (await api(`/api/allocations/${r.id}/review`, 'business', { ...common(r), decision: 'reject' })).record;
const alan = async (r, quantity) => (await api(`/api/allocations/${r.id}/alan-review`, 'alan', { ...common(r), alanQuantity: quantity, alanNote: '原Alan备注' })).record;
const issue = async r => (await api(`/api/allocations/${r.id}/confirm`, r.department === '二团' ? 'assistant-2' : 'assistant-1', common(r))).record;
const recall = async (r, role = 'business', payload = common(r)) => (await api(`/api/allocations/${r.id}/recall`, role, payload)).record;
async function complete(b, requested = 20, approved = requested) {
  let r = await approve(await create(b, requested), approved); if (db.getModel(b.model).category === '墨盒') r = await alan(r, approved); return issue(r);
}
function entryRows(r) { return db.db.prepare("SELECT * FROM document_events WHERE document_id=? AND event_type='entry' ORDER BY id").all(r.id); }
function recordState(label, r) { snapshots.push({ label, record: current(r), balance: db.getBalance(r.batchKey), ledger: ledger(r), entries: entryRows(r) }); }
function historicalCompleted(b, { entry = true, review = true, at = '2026-01-02T01:00:00.000Z', quantity = 20 } = {}) {
  return db.transaction(() => {
  // Explicit historical facts, not a product backfill or mutable event rewrite.
  const row = db.insertDocument({ role: 'operation-1', model: b.model, batchKey: b.batch_key, plan: b.plan, date: b.ship_date, version: b.version, fnsku: 'OLD-CODE', quantity,
    department: b.source_team, store: 'OLDUS', operator: '历史合成运营', asin: 'BOLDRECALL', operatorNote: '历史原备注', time: at, status: 'pending', at, submittedByRole: 'operation-1', submittedAt: at });
  const id = Number(row.id); db.addLedger(id, b.batch_key, 'reserve', 0, quantity, 'operation-1', at);
  if (entry) db.addEvent(id, 'entry', 'operation-1', at, null, { quantity, operator: '历史合成运营', department: b.source_team });
  db.db.prepare("UPDATE allocation_documents SET approved_quantity=?,approval_status='approved',reviewed_by_role='business',reviewed_at=?,revision=2 WHERE id=?").run(quantity, at, id);
  db.addLedger(id, b.batch_key, 'review_adjustment', 0, 0, 'business', at);
  if (review) db.addEvent(id, 'review', 'business', at, null, { quantity, approvedQuantity: quantity });
  db.addLedger(id, b.batch_key, 'release_reservation', 0, -quantity, 'assistant-1', at); db.addLedger(id, b.batch_key, 'issue', -quantity, 0, 'assistant-1', at);
  db.db.prepare("UPDATE allocation_documents SET status='confirmed',confirmed_at=?,confirmed_by_role='assistant-1',revision=3 WHERE id=?").run(at, id);
  db.addEvent(id, 'confirm', 'assistant-1', at, null, { quantity });
  fixtureChanges.push({ action: 'synthetic historical completed facts', id, entry, review, at }); return db.getDocument(id);
  });
}
function legacyEntry(b, quantity = 80) {
  return db.transaction(() => {
  const at = new Date().toISOString(), row = db.insertDocument({ role: 'operation-1', model: b.model, batchKey: b.batch_key, plan: b.plan, date: b.ship_date, version: b.version, fnsku: 'OLD-CODE', quantity,
    department: b.source_team, store: 'OLDUS', operator: '旧链隔离运营', asin: 'BLEGACY133', operatorNote: '旧原备注', time: at, status: 'pending', at, submittedByRole: 'operation-1', submittedAt: at });
  db.addLedger(row.id, b.batch_key, 'reserve', 0, quantity, 'operation-1', at); db.addEvent(row.id, 'entry', 'operation-1', at, null, { quantity, department: b.source_team });
  fixtureChanges.push({ action: 'legacy ink entry without new workflow stage or source snapshot', id: row.id }); return db.getDocument(row.id);
  });
}
async function start() {
  child = spawn(process.execPath, [path.join(repo, 'server.mjs')], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ASTER_STATE_ROOT: state, HOST: '127.0.0.1', PORT: String(port), PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => diagnostics += value); await waitForOwnedServer({ base, child, instanceId });
}
async function stop() { if (child?.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } child = null; }

try {
  await start();
  const b = fixture('TONER-ORDINARY'), otherBatch = fixture(b.model, '硒鼓', '一团', 'B'), untouched = db.getBalance(otherBatch.batch_key);
  let toner = await complete(b, 20, 40); const originalEntry = entryRows(toner), originalSource = toner.sourceBatchInfo;
  assert.equal(toner.recallInfo.workflowMode, 'toner'); assert.deepEqual(toner.recallInfo.canRecallByRole, ['business']); recordState('toner requested20 issued40 before recall', toner);
  const firstRecallBody = common(toner); toner = await recall(toner, 'business', firstRecallBody);
  assert.equal(toner.quantity, 20); assert.equal(toner.requestedQuantity, 20); assert.equal(toner.approvedQuantity, null); assert.equal(toner.businessReviewedQuantity, null);
  assert.equal(toner.lockedQuantity, 20); assert.equal(toner.issuedQuantity, 0); assert.equal(toner.approvalStatus, 'pending'); assert.equal(toner.statusText, '待商务审核');
  assert.equal(toner.inkWorkflowStage, null); assert.equal(toner.alanDeadlineAt, null); assert.equal(toner.procurementStatus, null); assert.equal(toner.recallInfo, null);
  assert.deepEqual(toner.sourceBatchInfo, originalSource); assert.deepEqual(entryRows(toner), originalEntry); assert.deepEqual(db.getBalance(otherBatch.batch_key), untouched);
  assert.deepEqual(db.getBalance(b.batch_key), { base: 100, onHand: 100, locked: 20, available: 80 }); recordState('toner returned40 but restored original20', toner);
  await replay(`/api/allocations/${toner.id}/recall`, 'business', firstRecallBody, toner);
  let reissued = await issue(await approve(toner, 20));
  await replay(`/api/allocations/${toner.id}/recall`, 'business', firstRecallBody, toner); assert.equal(current(reissued).statusCode, 'confirmed');
  await deny(`/api/allocations/${reissued.id}/recall`, 'business', common({ ...reissued, revision: reissued.revision - 1 }), 409, 'stale_revision');
  const concurrent = await Promise.all([api(`/api/allocations/${reissued.id}/recall`, 'business', common(reissued), null), api(`/api/allocations/${reissued.id}/recall`, 'business', common(reissued), null)]);
  assert.deepEqual(concurrent.map(r => r.httpStatus).sort(), [200, 409]); assert.equal(concurrent.find(r => r.httpStatus === 409).code, 'stale_revision');
  toner = current(reissued); assert.equal(toner.events.filter(e => e.type === 'recall').length, 2); assert.equal(toner.events.filter(e => e.type === 'recall').at(-1).payload.returnedQuantity, 20);
  assert.deepEqual(db.getBalance(b.batch_key), { base: 100, onHand: 100, locked: 20, available: 80 }); assert.deepEqual(entryRows(toner), originalEntry);
  check('硒鼓申请20批发40回撤只退实际40并重锁原20；重审本团助理再发、再次回撤只退净20；原批/快照及版本/并发/旧回执正确');

  for (const category of ['硒鼓', '墨盒']) {
    const c = fixture('ZERO-' + category, category), owner = await create(c, 60), holder = await create(c, 40), originalZero = await create(c, 80, true);
    await approve(owner, 20); let zero = await approve(originalZero, 40); if (category === '墨盒') zero = await alan(zero, 40); zero = await issue(zero);
    const entries = entryRows(zero), source = zero.sourceBatchInfo; recordState(category + ' zero-origin actual40 before capacity denial', zero);
    await deny(`/api/allocations/${zero.id}/recall`, 'business', common(zero), 409, 'insufficient_available');
    await reject(holder); const before = db.getBalance(c.batch_key); assert.equal(before.available, 40);
    const request = common(zero), responses = await Promise.all([api(`/api/allocations/${zero.id}/recall`, 'business', request), api(`/api/allocations/${zero.id}/recall`, 'business', request)]);
    assert.equal(responses.filter(r => r.deduped).length, 1); zero = responses[0].record;
    assert.equal(zero.requestedQuantity, 80); assert.equal(zero.lockedQuantity, 80); assert.equal(zero.issuedQuantity, 0); assert.equal(zero.zeroAvailableConfirmed, true);
    assert.equal(zero.statusText, '待商务审核'); assert.deepEqual(zero.sourceBatchInfo, source); assert.deepEqual(entryRows(zero), entries);
    assert.deepEqual(db.getBalance(c.batch_key), { base: 100, onHand: 100, locked: 100, available: 0 }); assert.equal(current(owner).lockedQuantity, 20);
    assert.equal(ledger(zero).filter(l => l.entry_type === 'reverse_issue').length, 1); recordState(category + ' zero-origin recall restored80 with owner20', zero);
    check(category + '13.1原申请80实际发40：不足80整笔无写，释放待审40后同键并发只退一次40并锁80，不改其他20/来源快照/原标记');
  }

  let newInk = await complete(fixture('INK-NEW', '墨盒'), 80, 40);
  assert.equal(newInk.recallInfo.workflowMode, 'ink-v2'); assert.deepEqual(newInk.recallInfo.canRecallByRole, ['business']);
  for (const role of ['purchasing', 'logistics']) await deny(`/api/allocations/${newInk.id}/recall`, role, common(newInk), 403, 'allocation_recall_forbidden');
  newInk = await recall(newInk); assert.equal(newInk.inkWorkflowStage, 'pending_business'); assert.equal(newInk.lockedQuantity, 80); assert.equal(newInk.alanDeadlineAt, null);
  const beforeReviewTime = Date.now(); newInk = await approve(newInk, 60); assert.equal(newInk.inkWorkflowStage, 'pending_alan'); assert.equal(Date.parse(newInk.alanDeadlineAt) - Date.parse(newInk.reviewedAt), 18000000); assert(Date.parse(newInk.reviewedAt) >= beforeReviewTime);
  check('新墨盒仅商务回待商务重锁原80，采购物流拒绝无写，重审后重新开始完整5自然小时');
  for (const role of ['business', 'purchasing', 'logistics']) {
    const l = fixture('INK-LEGACY-' + role, '墨盒'); let legacy = await approve(legacyEntry(l), 60); legacy = await alan(legacy, 50);
    legacy = (await api(`/api/allocations/${legacy.id}/reply`, 'purchasing', { ...common(legacy), supplierQuantity: 40, procurementNote: '旧采购最终40' })).record;
    legacy = (await api(`/api/allocations/${legacy.id}/archive`, 'purchasing', common(legacy))).record;
    assert.equal(legacy.recallInfo.workflowMode, 'legacy'); assert.deepEqual(legacy.recallInfo.canRecallByRole, ['business', 'purchasing', 'logistics']);
    const entries = entryRows(legacy); legacy = await recall(legacy, role); assert.equal(legacy.requestedQuantity, 80); assert.equal(legacy.issuedQuantity, 0); assert.equal(legacy.inkWorkflowStage, null);
    assert.equal(legacy.lockedQuantity, role === 'business' ? 80 : 50); assert.equal(legacy.procurementStatus, role === 'business' ? null : 'pending_purchasing');
    assert.equal(legacy.approvalStatus, role === 'business' ? 'pending' : 'approved'); assert.deepEqual(entryRows(legacy), entries); recordState('legacy recall by ' + role, legacy);
  }
  check('旧墨盒申请80/商务60/Alan50/实发40：商务回待商锁80，采购和物流仍回待采购锁50，原历史不重写');

  const forbiddenToner = await complete(fixture('TONER-ROLES'));
  for (const role of ROLES.filter(r => r !== 'business')) await deny(`/api/allocations/${forbiddenToner.id}/recall`, role, common(forbiddenToner), 403);
  for (const category of ['硒鼓', '墨盒']) {
    let r = await create(fixture('STAGES-' + category, category));
    assert.equal(r.recallInfo, null); await deny(`/api/allocations/${r.id}/recall`, 'business', common(r), 409, 'allocation_recall_unavailable');
    r = await approve(r, 20); assert.equal(r.recallInfo, null); await deny(`/api/allocations/${r.id}/recall`, 'business', common(r), 409, 'allocation_recall_unavailable');
    if (category === '墨盒') { r = await alan(r, 20); assert.equal(r.recallInfo, null); await deny(`/api/allocations/${r.id}/recall`, 'business', common(r), 409, 'allocation_recall_unavailable'); }
    let virtual = await create(fixture('VIRTUAL-' + category, category));
    virtual = (await api(`/api/allocations/${virtual.id}/transfer-inquiry`, 'business', { ...common(virtual), approvedQuantity: 20 })).record;
    assert.equal(virtual.recallInfo, null); await deny(`/api/allocations/${virtual.id}/recall`, 'business', common(virtual), 409, 'allocation_recall_unavailable');
    await api(`/api/allocations/${virtual.id}/conversion-decision`, 'operation-1', { ...common(virtual), decision: 'accept' }); virtual = current(virtual);
    assert.equal(virtual.isVirtual, true); assert.equal(virtual.recallInfo, null); await deny(`/api/allocations/${virtual.id}/recall`, 'business', common(virtual), 409, 'allocation_recall_unavailable');
  }
  for (const missing of ['entry', 'review']) {
    const h = historicalCompleted(fixture('MISSING-' + missing), { [missing]: false });
    await deny(`/api/allocations/${h.id}/recall`, 'business', common(h), 409, 'allocation_history_missing');
  }
  check('硒鼓其他8角色、两类非完成/转询库虚拟源、缺原申请或审核历史全部拒绝且全表不写，不补造事实');

  for (const category of ['硒鼓', '墨盒']) {
    const blocked = await complete(fixture('BLOCKED-' + category, category));
    const work = (await api('/api/upgrades/relocation-work-items', 'purchasing', { allocationId: blocked.id, requestId: rid() })).workItem;
    assert(work); assert(current(blocked).recallInfo.blockers.some(r => r.type === '移仓任务'));
    await deny(`/api/allocations/${blocked.id}/recall`, 'business', common(current(blocked)), 409, 'allocation_has_downstream');
    db.db.prepare("UPDATE upgrade_relocation_work_items SET status='cancelled' WHERE id=?").run(work.id);
    fixtureChanges.push({ action: 'synthetic historical cancelled relocation task', id: work.id });
    assert(current(blocked).recallInfo.blockers.some(r => r.status === '已取消'));
    await deny(`/api/allocations/${blocked.id}/recall`, 'business', common(current(blocked)), 409, 'allocation_has_downstream');
  }
  check('两类已创建但未发货的移仓任务阻断回撤；历史已取消关联仍按原合同阻断，不放宽下游规则');

  const hidden = [];
  for (const category of ['硒鼓', '墨盒']) for (const team of ['一团', '二团']) hidden.push(historicalCompleted(fixture('HIDDEN-' + category + '-' + team, category, team)));
  const oldPending = legacyEntry(fixture('OLD-PENDING', '墨盒'));
  db.db.prepare("UPDATE allocation_documents SET created_at='2026-01-02T01:00:00.000Z' WHERE id=?").run(oldPending.id);
  const oldRejected = await reject(await create(fixture('OLD-REJECTED')));
  db.db.prepare("UPDATE allocation_documents SET created_at='2026-01-02T01:00:00.000Z' WHERE id=?").run(oldRejected.id);
  for (const [key, value] of [['approval_first_clear_at', '2026-10-08T13:00:00.000Z'], ['approval_clear_before', '2026-10-15T13:00:00.000Z']]) db.db.prepare('INSERT INTO system_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  let inquiry = (await api('/api/inquiries', 'operation-1', { ...body(fixture('HIDDEN-INQUIRY')), quantity: 20 })).record;
  inquiry = (await api(`/api/inquiries/${inquiry.id}/review`, 'business', { ...common(inquiry), decision: 'approve', approvedQuantity: 20 })).record;
  inquiry = (await api(`/api/inquiries/${inquiry.id}/reply`, 'purchasing', { ...common(inquiry), supplierQuantity: 20, shippingWarehouse: 'CA' })).record;
  inquiry = (await api(`/api/inquiries/${inquiry.id}/archive`, 'purchasing', { ...common(inquiry), plan: 'INQ-P', date: '2026-10-19', version: 'V1' })).record;
  await api('/api/approvals/inquiries/clear', 'purchasing', { requestId: rid() });
  const beforeHiddenRead = all(), defaults = await api('/api/approvals'), optin = await api('/api/approvals?includeHiddenCompletedAllocations=1');
  assert.equal(Object.hasOwn(defaults, 'hiddenCompletedAllocationIds'), false);
  assert.deepEqual([...optin.hiddenCompletedAllocationIds].sort((a,b) => a-b), optin.allocations.filter(r => !defaults.allocations.some(d => d.id === r.id)).map(r => r.id).sort((a,b) => a-b));
  for (const r of hidden) { assert(!defaults.allocations.some(x => x.id === r.id)); assert(optin.allocations.some(x => x.id === r.id)); }
  assert(defaults.allocations.some(r => r.id === oldPending.id)); assert(optin.allocations.some(r => r.id === oldPending.id)); assert(!optin.allocations.some(r => r.id === oldRejected.id));
  assert.deepEqual(optin.inquiries, defaults.inquiries); assert(!optin.inquiries.some(r => r.id === inquiry.id)); assert.deepEqual(all(), beforeHiddenRead);
  assert.deepEqual((await api('/api/approvals?includeHiddenCompletedAllocations=true')).allocations, defaults.allocations);
  for (const role of ROLES) {
    const view = await api('/api/approvals?includeHiddenCompletedAllocations=1', role), group = role.endsWith('-1') ? '一团' : role.endsWith('-2') ? '二团' : null;
    for (const r of hidden) assert.equal(view.allocations.some(row => row.id === r.id), !group || group === r.department);
    const defaultRole = await api('/api/approvals', role);
    assert.equal(Object.hasOwn(defaultRole, 'hiddenCompletedAllocationIds'), false);
    assert.deepEqual([...view.hiddenCompletedAllocationIds].sort((a,b) => a-b), view.allocations.filter(r => !defaultRole.allocations.some(d => d.id === r.id)).map(r => r.id).sort((a,b) => a-b));
  }
  assert.deepEqual(all(), beforeHiddenRead);
  const oldToner = hidden.find(r => r.category === '硒鼓' && r.department === '一团'), oldCreated = oldToner.createdAt, cutoffBefore = db.db.prepare("SELECT value FROM system_meta WHERE key='approval_clear_before'").get().value;
  const oldEntries = entryRows(oldToner), oldHistory = await recall(oldToner);
  assert.equal(oldHistory.createdAt, oldCreated); assert.equal(oldHistory.statusCode, 'pending'); assert.equal(oldHistory.sourceBatchInfo.origin, 'current_batch'); assert.deepEqual(entryRows(oldHistory), oldEntries);
  assert((await api('/api/approvals')).allocations.some(r => r.id === oldHistory.id)); assert.equal(db.db.prepare("SELECT value FROM system_meta WHERE key='approval_clear_before'").get().value, cutoffBefore);
  check('optin只读额外显示隐藏confirmed（含>90天），默认/待审/旧拒绝/询库hidden及九角色团队范围不变；旧硒鼓回撤后pending自然出现不清cutoff', { oldId: oldHistory.id });

  const matrix = { 墨盒: Object.fromEntries(ROLES.map(role => [role, { summary: true, detail: true, expand: true, actions: true }])) };
  matrix.墨盒.purchasing.detail = false; await fs.writeFile(path.join(state, 'data/permissions.json'), JSON.stringify(matrix));
  const restricted = await api('/api/approvals?includeHiddenCompletedAllocations=1', 'purchasing');
  assert(!restricted.allocations.some(r => r.category === '墨盒'));
  for (const id of restricted.hiddenCompletedAllocationIds) assert(restricted.allocations.some(r => r.id === id && r.category !== '墨盒'));
  matrix.墨盒.business.actions = false; await fs.writeFile(path.join(state, 'data/permissions.json'), JSON.stringify(matrix));
  const hiddenInk = hidden.find(r => r.category === '墨盒'); await deny(`/api/allocations/${hiddenInk.id}/recall`, 'business', common(hiddenInk), 403, 'action_forbidden');
  check('隐藏optin不绕类目读取权限，回撤不绕类目actions权限');

  const persisted = all(); await stop(); await start(); assert.deepEqual(all(), persisted);
  db.assertInventoryInvariants(); assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, 38); assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.deepEqual(db.db.prepare('SELECT document_id,SUM(locked_delta) n FROM inventory_ledger GROUP BY document_id HAVING n<0').all(), []);
  await fs.writeFile(path.join(out, 'final-all-tables.json'), JSON.stringify(all(), null, 2)); db.db.prepare('VACUUM INTO ?').run(path.join(out, 'final.sqlite'));
  await fs.writeFile(path.join(out, 'integrity.json'), JSON.stringify({ schema: 38, inventoryInvariants: 'passed', foreignKeys: [], integrity: 'ok', negativeDocumentLocks: [], restartAllTablesUnchanged: true }, null, 2));
  check('重启持久化后全表不变；schema38、批次/型号库存不变量、完整性、外键及单据实际锁一致');
} catch (error) { failure = error.stack; throw error; }
finally {
  await stop(); db.close();
  await fs.writeFile(path.join(out, 'trace.json'), JSON.stringify(trace, null, 2)); await fs.writeFile(path.join(out, 'state-transitions.json'), JSON.stringify(snapshots, null, 2));
  await fs.writeFile(path.join(out, 'fixture-changes.json'), JSON.stringify(fixtureChanges, null, 2)); await fs.writeFile(path.join(out, 'server.log'), diagnostics);
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ at: new Date().toISOString(), state, base, instanceId, checks, rejected, failure: failure ?? null, ownedServerStopped: child === null, productionAccess: false, realERP: false }, null, 2));
  console.log('OUTPUT ' + out);
}
const closed = await new Promise(resolve => { const socket = net.createConnection({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', error => resolve(error.code === 'ECONNREFUSED')); socket.setTimeout(2000, () => { socket.destroy(); resolve(false); }); });
assert(closed); await fs.writeFile(path.join(out, 'cleanup.json'), JSON.stringify({ port, closed: true }, null, 2));
console.log('ALLOCATION_RECALL_PASS ' + checks.length + ' groups; ' + rejected.length + ' rejections unchanged');
