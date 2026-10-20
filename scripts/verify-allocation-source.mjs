// Requirement 13.2: fresh synthetic SQLite + owned loopback HTTP only; never production state/configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { freePort, createTestInstanceId, waitForOwnedServer } from './test-server-ownership.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const root = path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT || path.join(repo, '.test-output/allocation-source'));
await fs.mkdir(root, { recursive: true });
const out = await fs.mkdtemp(path.join(root, 'run-')), state = path.join(out, 'state');
process.env.ASTER_RUNTIME_CONFIG = path.join(out, 'synthetic-runtime.json');
process.env.ASTER_WAREHOUSE_ACCOUNTS = path.join(out, 'synthetic-accounts.json');
process.env.ASTER_OVERSEAS_WAREHOUSES = 'SyntheticWarehouseA;SyntheticWarehouseB';
await fs.writeFile(process.env.ASTER_RUNTIME_CONFIG, JSON.stringify({ schemaVersion: 1, overseasWarehouses: ['SyntheticWarehouseA', 'SyntheticWarehouseB'] }));
await fs.writeFile(process.env.ASTER_WAREHOUSE_ACCOUNTS, JSON.stringify({ accounts: [{ account: 'A号', shortName: 'SYNTHETIC', room: 'TEST-13-2' }] }));
const { InventoryDatabase, createInventoryDatabase, INVENTORY_SCHEMA_VERSION, ROLES } = await import(pathToFileURL(path.join(repo, 'inventory-db.mjs')));
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite'), seedCatalogData: false });
const db = new InventoryDatabase(state), port = await freePort(), base = `http://127.0.0.1:${port}`;
const trace = [], checks = [], rejected = [], fixtureChanges = [], servers = [];
let child, failure, diagnostics = '';
const rid = () => crypto.randomUUID(), common = record => ({ expectedRevision: record.revision, requestId: rid() });
const all = () => Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.db.prepare(`SELECT * FROM "${name}"`).all()]));
const inventory = () => Object.fromEntries(['stock_batches', 'stock_receipts', 'inventory_ledger', 'upgrade_inventory_ledger'].map(name => [name, db.db.prepare(`SELECT * FROM ${name}`).all()]));
const pair = (warehouse, shippingMethod, origin = 'snapshot') => ({ warehouse, shippingMethod, origin });
const check = (name, evidence = {}) => { checks.push({ name, evidence }); console.log('PASS ' + name); };
function fixture(model, category, suffix = 'A', warehouse = 'SyntheticWarehouseA', shippingMethod = '独立来源方式A', team = '一团') {
  const at = new Date().toISOString(), key = `${model}-${suffix}`;
  if (!db.getModel(model)) db.db.prepare('INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at) VALUES(?,?,0,0,?)').run(model, category, at);
  db.db.prepare("INSERT INTO stock_batches(batch_key,model,plan,ship_date,version,fnsku,base_quantity,updated_at,pack_per_box,source_team,warehouse,shipping_method) VALUES(?,?,?,'2026-10-19','V1','SOURCE-FNSKU',100,?,'10',?,?,?)").run(key, model, model + '-PLAN', at, team, warehouse, shippingMethod);
  return db.db.prepare('SELECT * FROM stock_batches WHERE batch_key=?').get(key);
}
const body = (batch, quantity = 10, zero = false, extra = {}) => ({ model: batch.model, sourceBatchKey: batch.batch_key, plan: batch.plan, date: batch.ship_date, version: batch.version,
  quantity, department: batch.source_team || '一团', store: 'SOURCEUS', operator: '13.2隔离运营', fnsku: 'OPERATOR-FNSKU', asin: 'BSOURCE132', operatorNote: '来源快照隔离验收', requestId: rid(), ...(zero ? { zeroAvailableConfirmed: true } : {}), ...extra });
async function api(route, role = 'admin', payload, expected = 200) {
  const response = await fetch(base + route, { method: payload === undefined ? 'GET' : 'POST', headers: { 'x-role': role, 'content-type': 'application/json', connection: 'close' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const result = await response.json();
  trace.push({ at: new Date().toISOString(), route, role, payload, status: response.status, result });
  if (expected !== null) assert.equal(response.status, expected, JSON.stringify(result));
  return { ...result, httpStatus: response.status };
}
async function noWriteReplay(route, role, payload, expectedRecord) {
  const before = all(), result = await api(route, role, payload);
  assert.equal(result.deduped, true); assert.deepEqual(all(), before);
  if (expectedRecord) assert.deepEqual(result.record, expectedRecord);
  return result;
}
async function deny(route, role, payload, status, code) {
  const before = all(), result = await api(route, role, payload, status);
  if (code) assert.equal(result.code, code);
  assert.deepEqual(all(), before);
  rejected.push({ route, role, status, code: result.code, allTablesUnchanged: true }); return result;
}
async function start() {
  const instanceId = createTestInstanceId('allocation-source');
  child = spawn(process.execPath, [path.join(repo, 'server.mjs')], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ASTER_STATE_ROOT: state, ASTER_TEST_INSTANCE_ID: instanceId, HOST: '127.0.0.1', PORT: String(port), PROD: '1' } });
  servers.push({ pid: child.pid, instanceId, state, base });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => diagnostics += value);
  await waitForOwnedServer({ base, child, instanceId });
}
async function stop() { if (child?.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } child = null; }
const create = async (batch, quantity = 10, zero = false) => (await api('/api/allocations', batch.source_team === '二团' ? 'operation-2' : 'operation-1', body(batch, quantity, zero))).record;
const approve = async (r, quantity) => (await api(`/api/allocations/${r.id}/review`, 'business', { ...common(r), decision: 'approve', approvedQuantity: quantity })).record;
const reject = async r => (await api(`/api/allocations/${r.id}/review`, 'business', { ...common(r), decision: 'reject' })).record;
const alan = async (r, quantity) => (await api(`/api/allocations/${r.id}/alan-review`, 'alan', { ...common(r), alanQuantity: quantity })).record;
const issue = async r => (await api(`/api/allocations/${r.id}/confirm`, 'assistant-1', common(r))).record;
const history = async r => (await api(`/api/allocations/${r.id}/history`, 'business')).document;
function source(record, expected) { assert.deepEqual(record.sourceBatchInfo, expected); }
function mutateSource(batch, warehouse, shippingMethod) {
  const before = db.db.prepare('SELECT warehouse,shipping_method FROM stock_batches WHERE batch_key=?').get(batch.batch_key);
  db.db.prepare('UPDATE stock_batches SET warehouse=?,shipping_method=? WHERE batch_key=?').run(warehouse, shippingMethod, batch.batch_key);
  fixtureChanges.push({ fixtureOnly: true, action: 'change exact source metadata', batchKey: batch.batch_key, before, after: { warehouse, shipping_method: shippingMethod } });
}
function legacyCache(batch, quantity = 10) {
  const request = body(batch, quantity), { requestId, ...submitted } = request, payload = { role: 'operation-1', ...submitted };
  // This models a pre-13.2 accepted request: entry has no snapshot and response has no sourceBatchInfo.
  const result = db.idempotent('allocation:create', requestId, payload, () => {
    const at = new Date().toISOString(), row = db.insertDocument({ role: 'operation-1', model: batch.model, batchKey: batch.batch_key, plan: batch.plan, date: batch.ship_date, version: batch.version,
      fnsku: request.fnsku, quantity, department: request.department, store: request.store, operator: request.operator, asin: request.asin, operatorNote: request.operatorNote,
      time: at, status: 'pending', at, submittedByRole: 'operation-1', submittedAt: at });
    if (db.getModel(batch.model).category === '墨盒') db.db.prepare("UPDATE allocation_documents SET ink_workflow_stage='pending_business' WHERE id=?").run(row.id);
    db.addLedger(row.id, batch.batch_key, 'reserve', 0, quantity, 'operation-1', at, null, null, { requestId });
    db.addEvent(row.id, 'entry', 'operation-1', at, null, { quantity, department: request.department, store: request.store, operator: request.operator, fnsku: request.fnsku, asin: request.asin, operatorNote: request.operatorNote, requestId });
    const record = db.getDocument(row.id); delete record.sourceBatchInfo;
    return { ok: true, record, totals: db.batchTotals(batch.model) };
  });
  fixtureChanges.push({ fixtureOnly: true, action: 'pre-13.2 entry and cached response', requestId, id: result.record.id });
  return { request, result };
}

try {
  assert.equal(INVENTORY_SCHEMA_VERSION, 38); await start();
  for (const category of ['硒鼓', '墨盒']) {
    const model = category === '硒鼓' ? 'SOURCE-TONER' : 'SOURCE-INK';
    const a = fixture(model, category), b = fixture(model, category, 'B', 'SyntheticWarehouseB', '不同来源方式B');
    const ordinaryBody = body(a, 100, false, { warehouse: '伪造仓', shippingMethod: '伪造方式', sourceBatchSnapshot: { warehouse: '伪造仓' } });
    let ordinary = (await api('/api/allocations', 'operation-1', ordinaryBody)).record;
    source(ordinary, pair(a.warehouse, a.shipping_method));
    assert.deepEqual(ordinary.events[0].payload.sourceBatchSnapshot, { warehouse: a.warehouse, shippingMethod: a.shipping_method });
    const zeroBody = body(a, 80, true), parallel = await Promise.all([api('/api/allocations', 'operation-1', zeroBody), api('/api/allocations', 'operation-1', zeroBody)]);
    assert.equal(parallel.filter(r => r.deduped).length, 1); let zero = parallel[0].record;
    source(zero, pair(a.warehouse, a.shipping_method)); assert.equal(zero.lockedQuantity, 0); assert.equal(zero.statusText, '待商务分配（未预锁）');
    assert.equal(db.db.prepare('SELECT COUNT(*) n FROM inventory_ledger WHERE document_id=?').get(zero.id).n, 1);
    assert.deepEqual(db.getBalance(a.batch_key), { base: 100, onHand: 100, locked: 100, available: 0 });
    const other = await create(b, 20); source(other, pair(b.warehouse, b.shipping_method));
    const allocations = await api('/api/allocations?model=' + model, 'operation-1');
    source(allocations.records[a.batch_key].find(r => r.id === zero.id), pair(a.warehouse, a.shipping_method));
    source(allocations.records[b.batch_key].find(r => r.id === other.id), pair(b.warehouse, b.shipping_method));
    for (const rows of Object.values(allocations.publicRecords)) for (const row of rows) assert.equal(Object.hasOwn(row, 'sourceBatchInfo'), false);
    source(await history(zero), pair(a.warehouse, a.shipping_method));
    await deny('/api/allocations', 'operation-1', { ...body(a), sourceBatchKey: b.batch_key, plan: 'wrong-plan' }, 400, 'unknown_batch');
    const ambiguous = body(a); delete ambiguous.sourceBatchKey;
    await deny('/api/allocations', 'operation-1', ambiguous, 409, 'select_stock_batch');
    check(category + '普通/13.1四入口按真实批次快照，客户端伪造无效，同型号同计划异仓不串值，公开摘要不扩字段', { ordinaryId: ordinary.id, zeroId: zero.id, otherId: other.id });

    const zeroReject = await create(a, 20, true), zeroConvert = await create(a, 20, true);
    const beforeReject = db.getBalance(a.batch_key); source(await reject(zeroReject), pair(a.warehouse, a.shipping_method)); assert.deepEqual(db.getBalance(a.batch_key), beforeReject);
    let convert = (await api(`/api/allocations/${zeroConvert.id}/transfer-inquiry`, 'business', { ...common(zeroConvert), approvedQuantity: 20 })).record;
    source(convert, pair(a.warehouse, a.shipping_method)); assert.deepEqual(db.getBalance(a.batch_key), beforeReject);
    const accepted = await api(`/api/allocations/${convert.id}/conversion-decision`, 'operation-1', { ...common(convert), decision: 'accept' });
    assert.equal(Object.hasOwn(accepted.inquiry, 'sourceBatchInfo'), false); source(await history(convert), pair(a.warehouse, a.shipping_method));
    const afterConversion = inventory();
    const inquiryReply = (await api(`/api/inquiries/${accepted.inquiry.id}/reply`, 'purchasing', { ...common(accepted.inquiry), supplierQuantity: 20, shippingWarehouse: 'CA', procurementNote: '采购仓不等于来源仓' })).record;
    assert.equal(inquiryReply.shippingWarehouse, 'CA'); assert.equal(Object.hasOwn(inquiryReply, 'sourceBatchInfo'), false); assert.deepEqual(inventory(), afterConversion);
    check(category + '0锁拒绝/转询库不释放别人，关联询库不扩字段且采购CA不污染原调拨来源');

    mutateSource(a, '修改后的来源仓', '修改后的方式');
    source(await history(ordinary), pair(a.warehouse, a.shipping_method));
    source(await history(zero), pair(a.warehouse, a.shipping_method));
    await noWriteReplay('/api/allocations', 'operation-1', ordinaryBody, ordinary);
    await noWriteReplay('/api/allocations', 'operation-1', zeroBody, zero);
    const newlySubmitted = await create(a, 10, true); source(newlySubmitted, pair('修改后的来源仓', '修改后的方式'));
    ordinary = await approve(ordinary, 60); zero = await approve(zero, 40);
    source(zero, pair(a.warehouse, a.shipping_method)); assert.equal(zero.requestedQuantity, 80); assert.equal(zero.lockedQuantity, 40);
    assert.deepEqual(db.getBalance(a.batch_key), { base: 100, onHand: 100, locked: 100, available: 0 });
    await deny(`/api/allocations/${newlySubmitted.id}/review`, 'business', { ...common(newlySubmitted), decision: 'approve', approvedQuantity: 10 }, 409, 'insufficient_available');
    if (category === '墨盒') zero = await alan(zero, 40);
    zero = await issue(zero); source(zero, pair(a.warehouse, a.shipping_method));
    assert.deepEqual(db.getBalance(a.batch_key), { base: 100, onHand: 60, locked: 60, available: 0 });
    if (category === '墨盒') {
      await deny(`/api/allocations/${zero.id}/recall`, 'business', common(zero), 409, 'insufficient_available');
      await alan(ordinary, 0);
      zero = (await api(`/api/allocations/${zero.id}/recall`, 'business', common(zero))).record;
      source(zero, pair(a.warehouse, a.shipping_method)); assert.equal(zero.requestedQuantity, 80); assert.equal(zero.lockedQuantity, 80);
      assert.deepEqual(db.getBalance(a.batch_key), { base: 100, onHand: 100, locked: 80, available: 20 });
    }
    check(category + '修改源资料后旧单/新旧回执/后续审批发出保持提交快照，新申请才取新值；13.1实时分配及墨盒回撤原合同保持');
  }

  for (const category of ['硒鼓', '墨盒']) for (const [suffix, warehouse, shippingMethod] of [['WH', 'SyntheticWarehouseA', ''], ['METHOD', '', '特殊来源方式'], ['EMPTY', '', '']]) {
    const b = fixture(`PAIR-${category}-${suffix}`, category, 'A', warehouse, shippingMethod);
    const owner = await create(b, 100), zero = await create(b, 20, true);
    source(owner, pair(warehouse, shippingMethod)); source(zero, pair(warehouse, shippingMethod));
    mutateSource(b, '后来补充的仓', '后来补充的方式');
    source(await history(owner), pair(warehouse, shippingMethod)); source(await history(zero), pair(warehouse, shippingMethod));
    assert.deepEqual(db.getBalance(b.batch_key), { base: 100, onHand: 100, locked: 100, available: 0 });
  }
  check('两类耗材仓库单独有值/方式单独有值/双空均保存快照；双空后来补充也不fallback当前批次');

  for (const category of ['硒鼓', '墨盒']) {
    const b = fixture('LEGACY-' + category, category), old = legacyCache(b, 20);
    const originalCached = JSON.parse(db.db.prepare("SELECT response_json FROM idempotency_requests WHERE scope='allocation:create' AND request_id=?").get(old.request.requestId).response_json).record;
    source(await history(originalCached), pair(b.warehouse, b.shipping_method, 'current_batch'));
    const approved = await approve(originalCached, 10);
    mutateSource(b, '历史单当前来源仓', '历史单当前来源方式');
    source(await history(approved), pair('历史单当前来源仓', '历史单当前来源方式', 'current_batch'));
    const replay = await noWriteReplay('/api/allocations', 'operation-1', old.request, { ...originalCached, sourceBatchInfo: pair('历史单当前来源仓', '历史单当前来源方式', 'current_batch') });
    assert.equal(replay.record.approvalStatus, 'pending'); assert.equal(replay.record.lockedQuantity, 20); assert.equal(replay.record.revision, 1);
    assert.equal(db.getDocument(originalCached.id).approvalStatus, 'approved'); assert.equal(db.getDocument(originalCached.id).lockedQuantity, 10);
    assert.equal(Object.hasOwn(JSON.parse(db.db.prepare("SELECT response_json FROM idempotency_requests WHERE scope='allocation:create' AND request_id=?").get(old.request.requestId).response_json).record, 'sourceBatchInfo'), false);
    // Temporarily model a degraded historical foreign-key association; restore it before checking DB integrity.
    db.db.exec('PRAGMA foreign_keys=OFF');
    try {
      db.db.prepare('UPDATE allocation_documents SET batch_key=? WHERE id=?').run('MISSING-HISTORICAL-SOURCE', originalCached.id);
      fixtureChanges.push({ fixtureOnly: true, action: 'temporarily absent exact historical batch association', id: originalCached.id });
      source(await history(originalCached), pair('', '', 'unrecorded'));
      await noWriteReplay('/api/allocations', 'operation-1', old.request, { ...originalCached, sourceBatchInfo: pair('', '', 'unrecorded') });
    } finally {
      db.db.prepare('UPDATE allocation_documents SET batch_key=? WHERE id=?').run(b.batch_key, originalCached.id);
      db.db.exec('PRAGMA foreign_keys=ON');
    }
    assert.equal(db.db.prepare('SELECT COUNT(*) n FROM document_events WHERE document_id=? AND json_type(payload_json,\'$.sourceBatchSnapshot\') IS NOT NULL').get(originalCached.id).n, 0);
    check(category + '旧单按确切当前批次且无关联如实未记录；旧幂等缓存只补来源，不改原待审状态/数量/版本、不写回填', { id: originalCached.id });
  }

  const teams = [];
  for (const category of ['硒鼓', '墨盒']) for (const team of ['一团', '二团']) {
    const b = fixture('SCOPE-' + category + '-' + team, category, 'A', team + '-来源仓', '团队方式', team), r = await create(b); teams.push({ category, team, b, r });
  }
  for (const role of ROLES) {
    const result = await api('/api/approvals', role), group = role.endsWith('-1') ? '一团' : role.endsWith('-2') ? '二团' : null;
    for (const { team, r } of teams) {
      const actual = result.allocations.find(item => item.id === r.id);
      if (group && group !== team) assert.equal(actual, undefined); else source(actual, pair(team + '-来源仓', '团队方式'));
    }
  }
  for (const { team, r } of teams) {
    for (const role of team === '一团' ? ['operation-2', 'assistant-2'] : ['operation-1', 'assistant-1']) await deny(`/api/allocations/${r.id}/history`, role, undefined, 403, 'group_forbidden');
  }
  const team2Ink = teams.find(item => item.team === '二团' && item.category === '墨盒');
  await deny('/api/allocations', 'operation-1', body(team2Ink.b, 10, false, { department: '一团' }), 403, 'source_team_forbidden');
  const noRole = await api('/api/approvals', 'not-a-role', undefined, 403); assert.equal(noRole.code, 'invalid_demo_role');
  check('九角色审批读取沿用现有团队/类目范围，两团完整历史与墨盒来源访问拒绝越界');

  const p = teams.find(item => item.category === '墨盒' && item.team === '一团'), matrix = { 墨盒: Object.fromEntries(ROLES.map(role => [role, { summary: true, detail: true, expand: true, actions: true }])) };
  matrix.墨盒.purchasing.detail = false;
  await fs.writeFile(path.join(state, 'data/permissions.json'), JSON.stringify(matrix));
  assert.equal((await api('/api/approvals', 'purchasing')).allocations.some(item => item.id === p.r.id), false);
  await deny(`/api/allocations/${p.r.id}/history`, 'purchasing', undefined, 403, 'allocation_read_forbidden');
  matrix.墨盒.purchasing.detail = true; await fs.writeFile(path.join(state, 'data/permissions.json'), JSON.stringify(matrix));
  check('隔离类目读取权限收窄后来源随完整记录一起隐藏，不新开访问路径');

  const beforeRestart = all(); await stop(); await start(); assert.deepEqual(all(), beforeRestart);
  const afterRestart = await api('/api/approvals', 'business');
  assert(afterRestart.allocations.some(r => r.sourceBatchInfo.origin === 'snapshot'));
  assert(afterRestart.allocations.some(r => r.sourceBatchInfo.origin === 'current_batch'));
  assert(afterRestart.inquiries.every(r => !Object.hasOwn(r, 'sourceBatchInfo')));
  assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, 38); db.assertInventoryInvariants();
  assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.db.prepare('SELECT document_id,SUM(locked_delta) n FROM inventory_ledger GROUP BY document_id HAVING n<0').all(), []);
  await fs.writeFile(path.join(out, 'final-state.json'), JSON.stringify(all(), null, 2));
  await fs.writeFile(path.join(out, 'integrity.json'), JSON.stringify({ schema: 38, invariants: 'passed', foreignKeys: [], integrity: 'ok', negativeDocumentLocks: [], restartAllTablesUnchanged: true }, null, 2));
  check('隔离服务重启后来源持久化且全表不变；schema38不变、库存不变量/单据锁/外键/完整性通过');
} catch (error) { failure = error.stack; throw error; }
finally {
  await stop(); db.close();
  await fs.writeFile(path.join(out, 'trace.json'), JSON.stringify(trace, null, 2));
  await fs.writeFile(path.join(out, 'fixture-changes.json'), JSON.stringify(fixtureChanges, null, 2));
  await fs.writeFile(path.join(out, 'server.log'), diagnostics);
  await fs.writeFile(path.join(out, 'owned.json'), JSON.stringify(servers, null, 2));
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ at: new Date().toISOString(), state, base, schema: 38, checks, rejected, failure: failure ?? null, productionWrites: 0, realERP: false, ownedServersStopped: child === null }, null, 2));
  console.log('OUTPUT ' + out);
}
const closed = await new Promise(resolve => { const socket = net.createConnection({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', error => resolve(error.code === 'ECONNREFUSED')); socket.setTimeout(2000, () => { socket.destroy(); resolve(false); }); });
assert(closed); await fs.writeFile(path.join(out, 'cleanup.json'), JSON.stringify({ port, closed: true }, null, 2));
console.log('ALLOCATION_SOURCE_PASS ' + checks.length + ' groups; ' + rejected.length + ' rejected requests unchanged');
