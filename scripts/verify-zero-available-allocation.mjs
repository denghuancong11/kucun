// Requirement 13.1: isolated real HTTP/SQLite acceptance. Never uses production state or private runtime configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const repo = path.resolve(import.meta.dirname, '..');
const root = path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT || path.join(repo, '.test-output/zero-available-allocation'));
await fs.mkdir(root, { recursive: true });
const out = await fs.mkdtemp(path.join(root, 'run-')), state = path.join(out, 'state');
process.env.ASTER_OVERSEAS_WAREHOUSES = 'SyntheticWarehouseA;SyntheticWarehouseB';
process.env.ASTER_RUNTIME_CONFIG = path.join(out, 'synthetic-runtime.json');
process.env.ASTER_WAREHOUSE_ACCOUNTS = path.join(out, 'synthetic-accounts.json');
await fs.writeFile(process.env.ASTER_RUNTIME_CONFIG, JSON.stringify({ schemaVersion: 1, overseasWarehouses: ['SyntheticWarehouseA', 'SyntheticWarehouseB'] }));
await fs.writeFile(process.env.ASTER_WAREHOUSE_ACCOUNTS, JSON.stringify({ accounts: [{ account: 'A号', shortName: 'SYNTHETIC', room: 'TEST-101' }] }));
const { InventoryDatabase, createInventoryDatabase, INVENTORY_SCHEMA_VERSION } = await import(pathToFileURL(path.join(repo, 'inventory-db.mjs')));
const { freePort, createTestInstanceId, waitForOwnedServer } = await import('./test-server-ownership.mjs');
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite'), seedCatalogData: false });
const db = new InventoryDatabase(state), port = await freePort(), base = 'http://127.0.0.1:' + port, rid = () => crypto.randomUUID(), common = r => ({ expectedRevision: r.revision, requestId: rid() });
const clockFile = path.join(out, 'clock-offset.txt'), preload = path.join(out, 'clock-offset.mjs');
await fs.writeFile(clockFile, '0');
await fs.writeFile(preload, `import fs from 'node:fs';const RealDate=Date;const now=()=>RealDate.now()+Number(fs.readFileSync(${JSON.stringify(clockFile)},'utf8'));globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now()]));}static now(){return now();}};`);
const checks = [], trace = [], rejected = [], owned = [];
let child, serverLog = '', failure;
const all = () => Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.db.prepare('SELECT * FROM "' + name + '"').all()]));
const check = (name, evidence) => { checks.push({ name, evidence }); console.log('PASS ' + name); };
function fixture(name, category = '墨盒', quantity = 100, pack = '10', team = '一团') {
    const at = new Date().toISOString();
    db.db.prepare('INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at) VALUES(?,?,?,0,?)').run(name, category, quantity, at);
    db.db.prepare("INSERT INTO stock_batches(batch_key,model,plan,ship_date,version,fnsku,base_quantity,updated_at,pack_per_box,source_team) VALUES(?,?,?,'2026-10-19','V1','000S',?,?,?,?)").run(name + '-B', name, name + '-P', quantity, at, pack, team);
    return name;
}
const balance = name => db.getBalance(name + '-B');
const current = r => db.getDocument(r.id);
const body = (name, q, flag, extra = {}) => ({ model: name, sourceBatchKey: name + '-B', plan: name + '-P', date: '2026-10-19', version: 'V1', quantity: q, department: '一团', store: 'AUS', operator: '零可用隔离-' + rid(), fnsku: '000S', asin: 'BZERO13001', operatorNote: '13.1独立合成验收', requestId: rid(), ...(flag === undefined ? {} : { zeroAvailableConfirmed: flag }), ...extra });
async function start() { const instanceId = createTestInstanceId('zero-available'); child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(repo, 'server.mjs')], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ASTER_STATE_ROOT: state, ASTER_TEST_INSTANCE_ID: instanceId, HOST: '127.0.0.1', PORT: String(port), PROD: '1' } }); owned.push({ serverPid: child.pid, instanceId, base, state }); for (const stream of [child.stdout, child.stderr])
    stream.on('data', x => serverLog += x); await waitForOwnedServer({ base, child, instanceId }); }
async function stop() { if (child?.exitCode === null) {
    const ended = once(child, 'exit');
    child.kill();
    await ended;
} child = null; }
async function api(route, role = 'admin', payload, status = 200) { const r = await fetch(base + route, { method: payload === undefined ? 'GET' : 'POST', headers: { 'x-role': role, 'content-type': 'application/json', connection: 'close' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), j = await r.json(); trace.push({ route, role, payload, status: r.status, result: j }); if (status !== null)
    assert.equal(r.status, status, JSON.stringify(j)); return { ...j, httpStatus: r.status }; }
async function deny(route, role, payload, status, code) { const before = all(), r = await api(route, role, payload, status); if (code)
    assert.equal(r.code, code); assert.deepEqual(all(), before, 'rejected operation changed SQLite tables'); rejected.push({ route, role, payload, status, code: r.code, allTablesUnchanged: true }); return r; }
const create = async (name, q, flag, extra) => (await api('/api/allocations', 'operation-1', body(name, q, flag, extra))).record;
const approve = async (r, q) => (await api('/api/allocations/' + r.id + '/review', 'business', { ...common(r), decision: 'approve', approvedQuantity: q, businessNote: '13.1商务分配' })).record;
const reject = async (r) => (await api('/api/allocations/' + r.id + '/review', 'business', { ...common(r), decision: 'reject', businessNote: '13.1释放本单实际锁' })).record;
const alan = async (r, q) => (await api('/api/allocations/' + r.id + '/alan-review', 'alan', { ...common(r), alanQuantity: q, alanNote: '13.1保留Alan规则' })).record;
const confirm = async (r) => (await api('/api/allocations/' + r.id + '/confirm', 'assistant-1', common(r))).record;
async function full(name, category = '墨盒') { fixture(name, category); return create(name, 100); }
function assertZero(r) { assert.equal(r.quantity, r.requestedQuantity); assert.equal(r.zeroAvailableConfirmed, true); assert.equal(r.lockedQuantity, 0); assert.equal(r.statusText, '待商务分配（未预锁）'); assert.equal(r.events.find(x => x.type === 'entry').payload.zeroAvailableConfirmed, true); assert.equal(db.db.prepare("SELECT locked_delta FROM inventory_ledger WHERE document_id=? AND entry_type='reserve'").get(r.id).locked_delta, 0); }
async function noWriteReplay(route, role, payload) { const before = all(), r = await api(route, role, payload); assert.equal(r.deduped, true); assert.deepEqual(all(), before); return r; }
try {
    await start();
    assert.equal(INVENTORY_SCHEMA_VERSION, 38);
    for (const category of ['墨盒', '硒鼓']) {
        const n = category === '墨盒' ? 'INK-NORMAL' : 'TONER-NORMAL';
        fixture(n, category);
        const ordinary = body(n, 100), a = (await api('/api/allocations', 'operation-1', ordinary)).record;
        assert.equal(a.zeroAvailableConfirmed, false);
        assert.equal(a.lockedQuantity, 100);
        assert.equal(Object.hasOwn(a.events[0].payload, 'zeroAvailableConfirmed'), false);
        await noWriteReplay('/api/allocations', 'operation-1', { ...ordinary, zeroAvailableConfirmed: false });
        await deny('/api/allocations', 'operation-1', body(n, 10), 409, 'insufficient_available');
        await deny('/api/allocations', 'operation-1', body(n, 10, false), 409, 'insufficient_available');
        const zeroBody = body(n, 80, true), responses = await Promise.all([api('/api/allocations', 'operation-1', zeroBody), api('/api/allocations', 'operation-1', zeroBody)]);
        assert.equal(responses.filter(x => x.deduped).length, 1);
        const z = responses[0].record;
        assertZero(z);
        assert.deepEqual([balance(n).onHand, balance(n).locked, balance(n).available], [100, 100, 0]);
        assert.equal(db.db.prepare("SELECT COUNT(*) n FROM inventory_ledger WHERE document_id=? AND entry_type='reserve'").get(z.id).n, 1);
        const view = await api('/api/allocations?model=' + n, 'operation-1');
        assert.equal(view.records[n + '-B'].find(r => r.id === z.id).statusText, '待商务分配（未预锁）');
        assert.equal(view.publicRecords[n + '-B'].find(r => r.id === z.id).zeroAvailableConfirmed, true);
        assert.equal(view.publicRecords[n + '-B'].find(r => r.id === z.id).status, '待商务分配（未预锁）');
        await deny('/api/allocations', 'operation-1', { ...zeroBody, zeroAvailableConfirmed: false }, 409, 'idempotency_conflict');
        const shrunk = await approve(a, 60);
        assert.equal(shrunk.lockedQuantity, 60);
        await noWriteReplay('/api/allocations', 'operation-1', zeroBody);
        await noWriteReplay('/api/allocations', 'operation-1', ordinary);
        check(category + '普通入口及false保留；全锁确认新单实际锁0，标记/状态/公开摘要正确；并发同请求与状态变后回执只一次', { a: a.id, z: z.id, balance: balance(n) });
    }
    const invalid = await full('INK-INVALID');
    for (const value of ['true', 1, 0, null, [], [true], {}])
        await deny('/api/allocations', 'operation-1', body('INK-INVALID', 10, value), 400, 'invalid_zero_available_confirmation');
    for (const q of [0, -10, 1.5])
        await deny('/api/allocations', 'operation-1', body('INK-INVALID', q, true), 400, 'invalid_quantity');
    await deny('/api/allocations', 'operation-1', body('INK-INVALID', 15, true), 400, 'allocation_quantity_multiple');
    await deny('/api/allocations', 'operation-1', body('INK-INVALID', 110, true), 409, 'zero_available_condition_changed');
    fixture('INK-ZERO', '墨盒', 0);
    await deny('/api/allocations', 'operation-1', body('INK-ZERO', 10, true), 409, 'zero_available_condition_changed');
    fixture('INK-FREE');
    await deny('/api/allocations', 'operation-1', body('INK-FREE', 10, true), 409, 'zero_available_condition_changed');
    fixture('INK-PART');
    await create('INK-PART', 60);
    await deny('/api/allocations', 'operation-1', body('INK-PART', 50, true), 409, 'zero_available_condition_changed');
    await deny('/api/allocations', 'operation-1', body('INK-PART', 50), 409, 'insufficient_available');
    for (const pack of [null, '', 0, 'bad']) {
        const n = 'INK-BADPACK-' + rid();
        fixture(n, '墨盒', 100, pack);
        await deny('/api/allocations', 'operation-1', body(n, 10, true), 400, 'invalid_pack_per_box');
    }
    fixture('INK-TEAM', '墨盒', 100, '10', '二团');
    await deny('/api/allocations', 'operation-1', body('INK-TEAM', 10, true), 403, 'source_team_forbidden');
    for (const role of ['assistant-1', 'assistant-2', 'business', 'purchasing', 'logistics', 'alan'])
        await deny('/api/allocations', role, body('INK-INVALID', 10, true), 403);
    check('确认类型、数量正整箱、live在库上限、零在库/部分不足、坏包装与原角色团队范围均拒绝无写');
    for (const category of ['墨盒', '硒鼓']) {
        const n = (category === '墨盒' ? 'INK' : 'TONER') + '-CHANGE';
        let a = await full(n, category);
        const zeroBody = body(n, 80, true);
        a = await approve(a, 60);
        await deny('/api/allocations', 'operation-1', zeroBody, 409, 'zero_available_condition_changed');
        await create(n, 40);
        const z = (await api('/api/allocations', 'operation-1', zeroBody)).record;
        assertZero(z);
        await noWriteReplay('/api/allocations', 'operation-1', zeroBody);
        check(category + '确认后live资格变更409，不默改普通锁、不缓存失败；资格恢复后原true意图只登记0锁', { z: z.id });
    }
    let cap = await full('INK-LIVE-CAP'), capBody = body('INK-LIVE-CAP', 80, true);
    cap = await approve(cap, 50);
    cap = await alan(cap, 50);
    await confirm(cap);
    await create('INK-LIVE-CAP', 50);
    assert.deepEqual([balance('INK-LIVE-CAP').onHand, balance('INK-LIVE-CAP').locked], [50, 50]);
    await deny('/api/allocations', 'operation-1', capBody, 409, 'zero_available_condition_changed');
    check('提交时按实时onHand上限复核：100降到50后旧80需求不得登记');
    for (const category of ['墨盒', '硒鼓']) {
        const prefix = category === '墨盒' ? 'INK' : 'TONER';
        let owner = await full(prefix + '-REJECT', category);
        const z = await create(prefix + '-REJECT', 80, true), before = balance(prefix + '-REJECT');
        const r = await reject(z);
        assert.equal(r.lockedQuantity, 0);
        assert.deepEqual(balance(prefix + '-REJECT'), before);
        assert.equal(current(owner).lockedQuantity, 100);
        let ordinary = await full(prefix + '-CONVERT', category), converted = await create(prefix + '-CONVERT', 80, true);
        const convertedBody = { ...common(converted), approvedQuantity: 75, businessNote: '不按整箱转询库' };
        converted = (await api('/api/allocations/' + converted.id + '/transfer-inquiry', 'business', convertedBody)).record;
        assert.equal(converted.lockedQuantity, 0);
        assert.equal(current(ordinary).lockedQuantity, 100);
        await noWriteReplay('/api/allocations/' + converted.id + '/transfer-inquiry', 'business', convertedBody);
        const acceptance = { ...common(converted), decision: 'accept' }, accepted = await api('/api/allocations/' + converted.id + '/conversion-decision', 'operation-1', acceptance);
        await noWriteReplay('/api/allocations/' + converted.id + '/conversion-decision', 'operation-1', acceptance);
        let q = accepted.inquiry;
        assert.equal(q.quantity, 75);
        assert.equal(q.sourceOriginalRequestedQuantity, 80);
        q = (await api('/api/inquiries/' + q.id + '/reply', 'purchasing', { ...common(q), supplierQuantity: 65, shippingWarehouse: 'CA', procurementNote: '合成最终65' })).record;
        q = (await api('/api/inquiries/' + q.id + '/archive', 'purchasing', { ...common(q), plan: 'CONVERT-' + q.id, date: '2026-10-19', version: 'V1' })).record;
        assert.equal(q.status, 'archived');
        assert.deepEqual([balance(prefix + '-CONVERT').onHand, balance(prefix + '-CONVERT').locked], [100, 100]);
        const refused = await create(prefix + '-CONVERT', 20, true);
        let refusedTransfer = (await api('/api/allocations/' + refused.id + '/transfer-inquiry', 'business', { ...common(refused), approvedQuantity: 20 })).record;
        await api('/api/allocations/' + refusedTransfer.id + '/conversion-decision', 'operation-1', { ...common(refusedTransfer), decision: 'reject' });
        assert.equal(db.db.prepare('SELECT COUNT(*) n FROM inquiry_documents WHERE source_allocation_id=?').get(refused.id).n, 0);
        assert.equal(current(ordinary).lockedQuantity, 100);
        check(category + '0锁拒绝不释放别人；0锁转询库接受唯一建单并完成采购65，拒绝转换不建单，现有库存锁完全不变');
    }
    for (const category of ['墨盒', '硒鼓']) {
        const n = (category === '墨盒' ? 'INK' : 'TONER') + '-RACE';
        let owner = await full(n, category);
        const first = await create(n, 80, true), second = await create(n, 80, true);
        await reject(owner);
        const p1 = { ...common(first), decision: 'approve', approvedQuantity: 70 }, p2 = { ...common(second), decision: 'approve', approvedQuantity: 70 };
        const race = await Promise.all([api('/api/allocations/' + first.id + '/review', 'business', p1, null), api('/api/allocations/' + second.id + '/review', 'business', p2, null)]);
        assert.deepEqual(race.map(x => x.httpStatus).sort(), [200, 409]);
        assert.equal(balance(n).locked, 70);
        const winner = race.find(x => x.httpStatus === 200).record, loser = current(first.id === winner.id ? second : first);
        assert.equal(winner.lockedQuantity, 70);
        assert.equal(loser.lockedQuantity, 0);
        assert.equal(loser.statusText, '待商务分配（未预锁）');
        await noWriteReplay('/api/allocations/' + winner.id + '/review', 'business', winner.id === first.id ? p1 : p2);
        await deny('/api/allocations/' + winner.id + '/review', 'business', { ...common(winner), decision: 'approve', approvedQuantity: 20 }, 409, 'invalid_approval_status');
        check(category + '同批两0锁单并发各批70只有一单取得实际锁，另一单仍0锁；不抢已批准且同键重试不二次占用');
    }
    let reverseOwner = await full('INK-NO-QUEUE'), early = await create('INK-NO-QUEUE', 80, true), late = await create('INK-NO-QUEUE', 80, true);
    await reject(reverseOwner);
    late = await approve(late, 70);
    await deny('/api/allocations/' + early.id + '/review', 'business', { ...common(early), decision: 'approve', approvedQuantity: 70 }, 409, 'insufficient_available');
    assert.equal(current(early).lockedQuantity, 0);
    assert.equal(current(late).lockedQuantity, 70);
    check('较晚登记可先获商务批准，较早登记没有队列优先或抢回已批权利');
    for (const category of ['墨盒', '硒鼓']) {
        const n = (category === '墨盒' ? 'INK' : 'TONER') + '-UPGRADE';
        fixture(n, category);
        const job = (await api('/api/upgrades/direct', 'purchasing', { model: n, sourceVersion: 'V1', requestId: rid() })).upgrade;
        assert.equal(job.initialQuantity, 100);
        const u = await create(n, 20, true);
        assertZero(u);
        const upgradeBefore = db.db.prepare('SELECT * FROM upgrade_inventory_ledger WHERE upgrade_id=?').all(job.id);
        await deny('/api/allocations/' + u.id + '/review', 'business', { ...common(u), decision: 'approve', approvedQuantity: 20 }, 409, 'insufficient_available');
        await reject(u);
        assert.deepEqual(db.db.prepare('SELECT * FROM upgrade_inventory_ledger WHERE upgrade_id=?').all(job.id), upgradeBefore);
        assert.equal(balance(n).locked, 100);
        const mixed = n + '-MIX';
        fixture(mixed, category);
        const a = await create(mixed, 40); // pending ordinary 40, leaving 60 available to a real direct upgrade
        const j = (await api('/api/upgrades/direct', 'purchasing', { model: mixed, sourceVersion: 'V1', requestId: rid() })).upgrade;
        assert.equal(j.initialQuantity, 60);
        let zero = await create(mixed, 40, true);
        assertZero(zero);
        await deny('/api/allocations/' + zero.id + '/review', 'business', { ...common(zero), decision: 'approve', approvedQuantity: 40 }, 409, 'insufficient_available');
        await reject(a);
        zero = await approve(zero, 40);
        assert.equal(zero.lockedQuantity, 40);
        assert.equal(balance(mixed).locked, 100);
        assert.equal(db.db.prepare('SELECT SUM(locked_delta) n FROM upgrade_inventory_ledger WHERE upgrade_id=?').get(j.id).n, 60);
        const completed = (await api('/api/upgrades/direct/' + j.id + '/complete', 'purchasing', { sourceLineId: j.lines[0].id, completedQuantity: 60, newVersion: 'V2', targetWarehouse: 'SyntheticWarehouseA', ...common(j) })).upgrade;
        assert.equal(completed.status, 'completed');
        assert.deepEqual([balance(mixed).onHand, balance(mixed).locked, balance(mixed).available], [40, 40, 0]);
        assert.equal(current(zero).lockedQuantity, 40);
        check(category + '升级全锁可登记0锁但商务不能抢；调拨40+升级60共享上限，升级完成不释放旧批可用');
    }
    // Full issue and recall paths retain the original, non-queue quantity meanings.
    let inkOwner = await full('INK-CHAIN'), ink = await create('INK-CHAIN', 80, true);
    inkOwner = await approve(inkOwner, 40);
    ink = await approve(ink, 60);
    assert.equal(ink.lockedQuantity, 60);
    assert.equal(ink.businessReviewedQuantity, 60);
    ink = await alan(ink, 60);
    ink = await confirm(ink);
    assert.equal(ink.issuedQuantity, 60);
    assert.deepEqual([balance('INK-CHAIN').onHand, balance('INK-CHAIN').locked], [40, 40]);
    await deny('/api/allocations/' + ink.id + '/recall', 'business', common(ink), 409, 'insufficient_available');
    await alan(inkOwner, 0);
    ink = (await api('/api/allocations/' + ink.id + '/recall', 'business', common(ink))).record;
    assert.equal(ink.requestedQuantity, 80);
    assert.equal(ink.lockedQuantity, 80);
    assert.equal(ink.statusText, '待商务审核');
    assert.equal(ink.zeroAvailableConfirmed, true);
    assert.deepEqual([balance('INK-CHAIN').onHand, balance('INK-CHAIN').locked], [100, 80]);
    await reject(ink);
    let tonerOwner = await full('TONER-CHAIN', '硒鼓'), toner = await create('TONER-CHAIN', 60, true);
    tonerOwner = await approve(tonerOwner, 40);
    toner = await approve(toner, 60);
    assert.equal(toner.lockedQuantity, 60);
    toner = await confirm(toner);
    await confirm(tonerOwner);
    assert.deepEqual([balance('TONER-CHAIN').onHand, balance('TONER-CHAIN').locked], [0, 0]);
    assert.equal(toner.issuedQuantity, 60);
    check('墨盒0锁→商务真锁60→Alan→助理实际出60；回撤不足80整笔失败、释放后退60重锁原80；硒鼓独立完整出库链');
    let alanOwner = await full('INK-ALAN'), alanZero = await create('INK-ALAN', 80, true);
    alanOwner = await approve(alanOwner, 20);
    alanZero = await approve(alanZero, 60);
    let competing = await create('INK-ALAN', 20);
    const alanBody = { ...common(alanZero), alanQuantity: 80, alanNote: '只用实时空余' };
    await deny('/api/allocations/' + alanZero.id + '/alan-review', 'alan', alanBody, 409, 'insufficient_available');
    await reject(competing);
    alanZero = (await api('/api/allocations/' + alanZero.id + '/alan-review', 'alan', alanBody)).record;
    assert.equal(alanZero.alanQuantity, 80);
    assert.equal(alanZero.businessReviewedQuantity, 60);
    assert.equal(alanZero.lockedQuantity, 80);
    await noWriteReplay('/api/allocations/' + alanZero.id + '/alan-review', 'alan', alanBody);
    check('Alan保留商务60→80实时空余增量；被占时拒绝无写，释放后原失败请求正常只调本单实际锁');
    let timedOwner = await full('INK-TIME'), timed = await create('INK-TIME', 80, true);
    timedOwner = await approve(timedOwner, 20);
    timed = await approve(timed, 80);
    assert.equal(Date.parse(timed.alanDeadlineAt) - Date.parse(timed.reviewedAt), 18000000);
    const deadline = timed.alanDeadlineAt;
    await stop();
    await fs.writeFile(clockFile, String(Date.parse(deadline) - Date.now() + 100));
    await start();
    timed = current(timed);
    assert.equal(timed.inkWorkflowStage, 'pending_assistant');
    assert.equal(timed.finalQuantitySource, 'business');
    assert.equal(timed.quantity, 80);
    assert.equal(timed.lockedQuantity, 80);
    assert.equal(timed.issuedQuantity, 0);
    assert.equal(timed.events.filter(x => x.type === 'alan_timeout').length, 1);
    const timeoutState = all();
    await stop();
    await start();
    assert.deepEqual(all(), timeoutState);
    timed = await confirm(timed);
    assert.equal(timed.issuedQuantity, 80);
    await stop();
    await fs.writeFile(clockFile, '0');
    await start();
    check('商务真实锁足80后，服务停机跨连续5自然h重启只推进一次、不自动发出，随后本团助理按80完成');
    let legacy = await full('INK-LEGACY');
    db.db.prepare('UPDATE allocation_documents SET ink_workflow_stage=NULL,alan_deadline_at=NULL WHERE id=?').run(legacy.id);
    legacy = await approve(legacy, 80);
    legacy = await alan(legacy, 60);
    legacy = (await api('/api/allocations/' + legacy.id + '/reply', 'purchasing', { ...common(legacy), supplierQuantity: 40, procurementNote: '保留旧链' })).record;
    assert.equal(legacy.lockedQuantity, 40);
    legacy = (await api('/api/allocations/' + legacy.id + '/archive', 'purchasing', common(legacy))).record;
    assert.equal(legacy.issuedQuantity, 40);
    legacy = (await api('/api/allocations/' + legacy.id + '/recall', 'purchasing', common(legacy))).record;
    assert.equal(legacy.lockedQuantity, 60);
    assert.equal(legacy.zeroAvailableConfirmed, false);
    check('schema38显式legacy采购链的80/60/40、实际锁、归档与采购回撤60保持；真实schema36迁移由原v36套件另测');
    const persisted = all();
    await stop();
    await start();
    assert.deepEqual(all(), persisted);
    const approvals = await api('/api/approvals', 'business');
    assert(approvals.allocations.some(x => x.zeroAvailableConfirmed && x.statusText === '待商务分配（未预锁）'));
    const negative = db.db.prepare('SELECT document_id,SUM(locked_delta) locked FROM inventory_ledger GROUP BY document_id HAVING SUM(locked_delta)<0').all();
    assert.deepEqual(negative, []);
    db.assertInventoryInvariants();
    assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    check('刷新/重启后标记、状态、实际占用持久化；全部单实际锁非负、总余额、外键与完整性一致');
}
catch (e) {
    failure = e.stack;
    throw e;
}
finally {
    await stop();
    db.close();
    await fs.writeFile(path.join(out, 'owned.json'), JSON.stringify(owned, null, 2));
    await fs.writeFile(path.join(out, 'server.log'), serverLog);
    await fs.writeFile(path.join(out, 'trace.json'), JSON.stringify(trace, null, 2));
    await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ at: new Date().toISOString(), state, base, schemaVersion: 38, checks, rejected, failure: failure ?? null, productionWrites: 0, realLingxing: false, ownedServersStopped: child === null }, null, 2));
    console.log('OUTPUT ' + out);
}
const closed = await new Promise(resolve => { const s = net.createConnection({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', e => resolve(e.code === 'ECONNREFUSED')); s.setTimeout(2000, () => { s.destroy(); resolve(false); }); });
assert(closed);
await fs.writeFile(path.join(out, 'cleanup.json'), JSON.stringify({ port, closed: true }, null, 2));
console.log('ZERO_AVAILABLE_ALLOCATION_PASS ' + checks.length + ' groups; ' + rejected.length + ' rejected requests unchanged');
