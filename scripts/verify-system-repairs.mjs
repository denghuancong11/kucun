// D01–D04 isolated HTTP/SQLite regressions. Synthetic configuration only; all rejected writes compare every table.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
const repo = path.resolve(import.meta.dirname, '..'), outputRoot = path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT || path.join(repo, '.test-output/system-repairs'));
await fs.mkdir(outputRoot, { recursive: true });
const out = await fs.mkdtemp(path.join(outputRoot, 'run-'));
process.env.ASTER_OVERSEAS_WAREHOUSES = 'SyntheticWarehouseA;SyntheticWarehouseB';
process.env.ASTER_RUNTIME_CONFIG = path.join(out, 'synthetic-runtime.json');
process.env.ASTER_WAREHOUSE_ACCOUNTS = path.join(out, 'synthetic-accounts.json');
await fs.writeFile(process.env.ASTER_RUNTIME_CONFIG, JSON.stringify({ schemaVersion: 1, overseasWarehouses: ['SyntheticWarehouseA', 'SyntheticWarehouseB'] }));
await fs.writeFile(process.env.ASTER_WAREHOUSE_ACCOUNTS, JSON.stringify({ accounts: [{ account: 'A号', shortName: 'SYNTHETIC', room: 'TEST-101' }] }));
const { InventoryDatabase, createInventoryDatabase, INVENTORY_SCHEMA_VERSION } = await import(pathToFileURL(path.join(repo, 'inventory-db.mjs'))), { freePort, createTestInstanceId, waitForOwnedServer } = await import(pathToFileURL(path.join(repo, 'scripts/test-server-ownership.mjs')));
const state = path.join(out, 'state');
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite') });
const db = new InventoryDatabase(state), port = await freePort(), base = 'http://127.0.0.1:' + port, instanceId = createTestInstanceId('repair-backend'), trace = [], checks = [], rid = () => crypto.randomUUID(), common = r => ({ expectedRevision: r.revision, requestId: rid() });
let serverLog = '', failure;
const all = () => Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.db.prepare('SELECT * FROM "' + name + '"').all()]));
const child = spawn(process.execPath, [path.join(repo, 'server.mjs')], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ASTER_STATE_ROOT: state, ASTER_TEST_INSTANCE_ID: instanceId, HOST: '127.0.0.1', PORT: String(port), PROD: '1' } });
child.stdout.on('data', x => serverLog += x);
child.stderr.on('data', x => serverLog += x);
await fs.writeFile(path.join(out, 'owned.json'), JSON.stringify({ runnerPid: process.pid, serverPid: child.pid, state, base, instanceId }, null, 2));
async function api(route, role, body, status = 200) { const r = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-role': role, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), j = await r.json(); trace.push({ route, role, body, status: r.status, result: j }); assert.equal(r.status, status, JSON.stringify(j)); return j; }
async function reject(route, role, body, status = 400) { const before = all(), j = await api(route, role, body, status); assert.deepEqual(all(), before, 'rejected request wrote database'); return j; }
const check = s => { checks.push(s); console.log('PASS ' + s); };
function model(name, category = '墨盒') { db.db.prepare('INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at) VALUES(?,?,0,0,?)').run(name, category, new Date().toISOString()); }
function stock(name, team, quantity = 0) { const key = name + '-B'; db.db.prepare("INSERT INTO stock_batches(batch_key,model,plan,ship_date,version,fnsku,base_quantity,updated_at,pack_per_box,source_team) VALUES(?,?,?,'2026-10-19','V1','000S',?,?,'5',?)").run(key, name, key, quantity, new Date().toISOString(), team); return key; }
function transit(name, team, { remaining = 10, voided = false, pack = '4', fba = false } = {}) { const at = new Date().toISOString(), id = Number(db.db.prepare("INSERT INTO transit_batches(model,quantity,remaining_quantity,plan,ship_date,version,fnsku,shipping_method,team,logistics_status,on_shelf_indicator,status,created_at,updated_at,pack_per_box,voided_at) VALUES(?,100,?,?,'2026-10-19','V0','000F',?,?,'在途','尚未确认',?,?,?, ?,?)").run(name, remaining, 'PLAN-' + rid(), fba ? '直发FBA' : '整柜', team, remaining === 0 ? 'on_shelf' : 'in_transit', at, at, pack, voided ? at : null).lastInsertRowid); db.refreshTransitModel(name, at); return id; }
const inquiryBody = (name, team = '一团') => ({ model: name, quantity: 100, department: team, store: 'AUS', operator: '修复回归', fnsku: '000Q', asin: 'BREPAIR001', requestId: rid() });
async function inquiry(name = 'SYNTH-TONER-001') { return (await api('/api/inquiries', 'operation-1', inquiryBody(name))).record; }
async function review(r, kind = 'inquiries', quantity = 75) { return (await api('/api/' + kind + '/' + r.id + '/review', 'business', { decision: 'approve', approvedQuantity: quantity, ...common(r) })).record; }
async function inquiryDone() { let r = await review(await inquiry(), 'inquiries', 100); r = (await api('/api/inquiries/' + r.id + '/reply', 'purchasing', { supplierQuantity: 100, shippingWarehouse: 'CA', ...common(r) })).record; return (await api('/api/inquiries/' + r.id + '/archive', 'purchasing', { plan: 'Q-' + r.id, date: '2026-10-19', version: 'V0', ...common(r) })).record; }
async function allocation(batch, quantity = 100) { return (await api('/api/allocations', 'operation-1', { model: batch.model, sourceBatchKey: batch.batch_key, plan: batch.plan, date: batch.ship_date, version: batch.version, quantity, department: '一团', store: 'AUS', operator: '修复回归', fnsku: batch.fnsku, asin: 'BREPAIR001', requestId: rid() })).record; }
async function relocation(kind = 'inquiry', pack = '4') {
    let source;
    if (kind === 'inquiry')
        source = { inquiryId: (await inquiryDone()).id };
    else if (kind === 'allocation') {
        const b = db.db.prepare("SELECT * FROM stock_batches WHERE model='SYNTH-TONER-001' AND pack_per_box IS NOT NULL AND base_quantity>=300 ORDER BY base_quantity DESC LIMIT 1").get();
        let r = await review(await allocation(b), 'allocations', 100);
        r = (await api('/api/allocations/' + r.id + '/confirm', 'assistant-1', common(r))).record;
        if (pack === null)
            db.db.prepare('UPDATE stock_batches SET pack_per_box=NULL WHERE batch_key=?').run(b.batch_key);
        source = { allocationId: r.id };
    }
    else {
        const id = transit('SYNTH-TONER-001', '一团', { remaining: 100, pack, fba: true }), r = db.markTransitOnShelf({ id, role: 'assistant-1', expectedRevision: 1, yes: 'YES', requestId: rid() });
        source = { fbaArchiveId: r.fbaArchiveId, account: 'AUS' };
    }
    let w = (await api('/api/upgrades/relocation-work-items', 'operation-1', { ...source, requestId: rid() })).workItem;
    w = (await api('/api/upgrades/relocation-work-items/' + w.id + '/procurement', 'logistics', { rma: 'RMA-REPAIR', relocationAddress: 'Supplier (RMA#: RMA-REPAIR)\n12000 Magnolia Ave, Suite#101\nTEL:1234567890', ...common(w) })).workItem;
    w = (await api('/api/upgrades/relocation-work-items/' + w.id + '/operation', 'operation-1', { removalOrderNo: 'ORDER-' + w.id, ...common(w) })).workItem;
    db.syncRelocationLogistics({ id: w.id, role: 'logistics', requestId: rid(), capturedAt: new Date().toISOString(), shipments: [{ externalId: 'PKG-' + w.id, storeId: 'lingxing-remove-inbound', storeName: 'A-US 美国', countryCode: 'US', orderNo: w.removalOrderNo, fnsku: w.fnsku, quantity: 100, carrier: 'UPS', trackingNo: 'TRACK-' + w.id, shipDate: '2026-10-19' }] });
    return { work: w, row: () => db.getUpgrade(db.getRelocationWorkItem(w.id).upgradeId).relocations[0] };
}
const completion = (r, q = 20, p = 5, extra = {}) => ({ completedQuantity: q, inProgressQuantity: p, newVersion: 'V2', targetWarehouse: 'SyntheticWarehouseA', ...common(r), ...extra });
try {
    await waitForOwnedServer({ base, child, instanceId });
    assert.equal(INVENTORY_SCHEMA_VERSION, 38);
    db.db.prepare("UPDATE stock_batches SET pack_per_box='10' WHERE model='SYNTH-TONER-001'").run();
    db.db.prepare("UPDATE stock_batches SET source_team='一团',pack_per_box='10' WHERE model='SYNTH-INK-001'").run();
    for (const name of ['NONE', 'OTHER', 'OWNZERO', 'OWNTRANSIT', 'VOID', 'RETRY', 'PUBLIC'])
        model('INK-' + name);
    stock('INK-OTHER', '二团');
    stock('INK-OWNZERO', '一团');
    transit('INK-OWNTRANSIT', '一团', { remaining: 0 });
    transit('INK-VOID', '一团', { voided: true });
    const publicSource = stock('INK-PUBLIC', ''), at = new Date().toISOString(), importId = Number(db.db.prepare("INSERT INTO transfer_upgrade_imports(file_name,file_sha256,sheet_name,imported_by_role,imported_at) VALUES('synthetic.xlsx','synthetic','转仓升级','logistics',?)").run(at).lastInsertRowid), transferId = Number(db.db.prepare("INSERT INTO transfer_upgrade_rows(import_id,source_row,data_json,document_no,updated_at) VALUES(?,4,?,'TC-TEST-PUBLIC',?)").run(importId, JSON.stringify({ model: 'INK-PUBLIC' }), at).lastInsertRowid);
    db.db.prepare('UPDATE stock_batches SET transfer_upgrade_id=? WHERE batch_key=?').run(transferId, publicSource);
    for (const role of ['operation-1', 'operation-2'])
        await api('/api/inquiries', role, inquiryBody('INK-PUBLIC', role === 'operation-1' ? '一团' : '二团'));
    for (const role of ['operation-1', 'operation-2']) {
        const team = role === 'operation-1' ? '一团' : '二团';
        for (const name of ['INK-NONE', 'INK-VOID']) {
            await reject('/api/inquiries', role, inquiryBody(name, team), 403);
        }
        assert.throws(() => db.createInquiry({ role, ...inquiryBody('INK-NONE', team) }), e => e.code === 'inquiry_source_team_forbidden');
    }
    await reject('/api/inquiries', 'operation-1', inquiryBody('INK-OTHER'), 403);
    await api('/api/inquiries', 'operation-2', inquiryBody('INK-OTHER', '二团'));
    await api('/api/inquiries', 'operation-1', inquiryBody('INK-OWNZERO'));
    await api('/api/inquiries', 'operation-1', inquiryBody('INK-OWNTRANSIT'));
    await reject('/api/inquiries', 'operation-2', inquiryBody('INK-OWNZERO', '二团'), 403);
    await api('/api/inquiries', 'admin', inquiryBody('INK-NONE'));
    await api('/api/inquiries', 'operation-1', inquiryBody('SYNTH-TONER-002'));
    const retry = inquiryBody('INK-RETRY'), retrySource = stock('INK-RETRY', '一团');
    db.createInquiry({ role: 'operation-1', ...retry });
    db.db.prepare("UPDATE stock_batches SET source_team='' WHERE batch_key=?").run(retrySource);
    const beforeRetry = all();
    assert((await api('/api/inquiries', 'operation-1', retry)).deduped);
    assert.deepEqual(all(), beforeRetry);
    await reject('/api/inquiries', 'operation-1', { ...retry, quantity: 101 }, 409);
    await reject('/api/inquiries', 'operation-1', { ...retry, requestId: rid() }, 403);
    check('D02两团无来源/跨团/作废来源拒绝全库无写；本团零余额历史来源可询库，管理员/硒鼓合同保留，旧已保存请求原样重放');
    const b = db.db.prepare("SELECT * FROM stock_batches WHERE model='SYNTH-INK-001' LIMIT 1").get();
    let source = await allocation(b);
    source = (await api('/api/allocations/' + source.id + '/transfer-inquiry', 'business', { approvedQuantity: 75, ...common(source) })).record;
    const accepted = await api('/api/allocations/' + source.id + '/conversion-decision', 'operation-1', { decision: 'accept', ...common(source) });
    let q = (await api('/api/inquiries/' + accepted.inquiry.id + '/reply', 'purchasing', { supplierQuantity: 65, shippingWarehouse: 'CA', ...common(accepted.inquiry) })).record;
    assert.equal(q.sourceOriginalRequestedQuantity, 100);
    assert.equal(q.originalRequestedQuantity, 75);
    assert.equal(q.businessReviewedQuantity, 75);
    assert.equal(q.finalQuantity, 65);
    const beforeRead = all(), h = await api('/api/inquiries/' + q.id + '/history', 'operation-1');
    assert.equal(h.document.sourceOriginalRequestedQuantity, 100);
    assert.deepEqual(all(), beforeRead);
    const entry = q.events.find(x => x.type === 'entry');
    assert.equal(Object.hasOwn(entry.payload, 'sourceOriginalRequestedQuantity'), false);
    check('D04墨盒100/75/65正确投影；未改不可变转换entry，history读取全库无写');
    const flow = await relocation(), route = '/api/upgrades/relocations/' + flow.row().id + '/complete';
    for (const field of ['completedQuantity', 'inProgressQuantity'])
        for (const value of [undefined, null, '', '   ', -1, 0.5])
            await reject(route, 'purchasing', { ...completion(flow.row(), 0, 5), [field]: value });
    await api(route, 'purchasing', completion(flow.row(), 0, 0));
    for (const value of [undefined, null, '', '   ', 0, -1, 1.5, true, false, [4], [], {}])
        assert.equal((await reject(route, 'purchasing', completion(flow.row(), 20, 5, { packPerBox: value }), 422)).code, 'invalid_pack_per_box');
    check('D03两个移仓数量字段空/非法值拒绝无写，显式0保存；D01缺/空/非正整数/非number或string包装拒绝全库无写');
    const first = completion(flow.row(), 20, 5, { packPerBox: '4' });
    await api(route, 'purchasing', first);
    const firstState = all();
    assert((await api(route, 'purchasing', first)).deduped);
    assert.deepEqual(all(), firstState);
    await api(route, 'purchasing', completion(flow.row(), 35, 5, { packPerBox: 5 }));
    let receipts = flow.row().receiptBatches;
    assert.deepEqual(receipts.map(x => [x.quantity, x.packPerBox]), [[20, '4'], [15, '5']]);
    for (const receipt of receipts) {
        const stock = db.db.prepare('SELECT * FROM stock_batches WHERE batch_key=?').get(receipt.batchKey), ledger = db.db.prepare('SELECT * FROM upgrade_inventory_ledger WHERE id=?').get(receipt.ledgerId);
        assert.equal(stock.pack_per_box, receipt.packPerBox);
        assert.equal(JSON.parse(ledger.metadata_json).packPerBox, receipt.packPerBox);
    }
    const r = receipts[1], batch = db.db.prepare('SELECT * FROM stock_batches WHERE batch_key=?').get(r.batchKey), hold = await allocation(batch, 5);
    await reject(route, 'purchasing', completion(flow.row(), 25, 5, { reversals: [{ ledgerId: r.ledgerId, quantity: 10 }] }), 409);
    await api('/api/allocations/' + hold.id + '/review', 'business', { decision: 'reject', ...common(hold) });
    await api(route, 'purchasing', completion(flow.row(), 20, 5, { reversals: [{ ledgerId: r.ledgerId, quantity: 15 }] }));
    await api(route, 'purchasing', completion(flow.row(), 20, 0));
    check('D01询库回库每批真实4/5绑定不同批次，正常调拨锁5；占用拒扣，释放后扣回15/仅改进度无需套箱；重试不重复入库');
    const issuedReceipt = receipts[0], issuedBatch = db.db.prepare('SELECT * FROM stock_batches WHERE batch_key=?').get(issuedReceipt.batchKey);
    let downstream = await review(await allocation(issuedBatch, 4), 'allocations', 4);
    downstream = (await api('/api/allocations/' + downstream.id + '/confirm', 'assistant-1', common(downstream))).record;
    assert.equal(db.getBalance(issuedReceipt.batchKey).locked, 0);
    assert.equal(db.getBalance(issuedReceipt.batchKey).onHand, 16);
    await reject(route, 'logistics', completion(flow.row(), 19, 0, { reversals: [{ ledgerId: issuedReceipt.ledgerId, quantity: 1 }] }), 409);
    check('D01真实套箱4回库批次可完整调拨出库4；锁定为0仍阻止扣回已出库来源');
    const receiptEvents = db.db.prepare("SELECT payload_json FROM document_events WHERE event_type='upgrade_relocation_complete' AND json_extract(payload_json,'$.inquiryId')=? AND json_extract(payload_json,'$.onHandDelta')>0 ORDER BY id").all(flow.work.inquiryId).map(x => JSON.parse(x.payload_json));
    assert.deepEqual(receiptEvents.map(x => x.packPerBox), ['4', '5']);
    for (const [kind, pack] of [['allocation', '10'], ['allocation', null], ['fba', '4'], ['fba', null]]) {
        const f = await relocation(kind, pack);
        await api('/api/upgrades/relocations/' + f.row().id + '/complete', 'purchasing', completion(f.row(), 10, 0));
        assert.equal(f.row().receiptBatches[0].packPerBox, kind === 'allocation' && pack !== null ? '10' : pack);
    }
    check('D01旧调拨/FBA有套箱原样继承，缺值仍空且未新增前置；不默认为1');
    const typedPack = await relocation(), typedRoute = '/api/upgrades/relocations/' + typedPack.row().id + '/complete';
    await api(typedRoute, 'purchasing', completion(typedPack.row(), 4, 0, { packPerBox: 4 }));
    await api(typedRoute, 'purchasing', completion(typedPack.row(), 8, 0, { packPerBox: '4' }));
    assert.deepEqual(typedPack.row().receiptBatches.map(x => [x.quantity, x.packPerBox]), [[4, '4'], [4, '4']]);
    check('D01明确number4和string4均正常，按两次实际正入库各绑定套箱4');
    for (const [kind, actor, endpoint, field] of [['inquiry', 'alan', 'alan-review', 'alanQuantity'], ['inquiry', 'purchasing', 'reply', 'supplierQuantity']]) {
        let a = await review(await inquiry('SYNTH-INK-001'));
        for (const value of [null, '', '   '])
            await reject('/api/inquiries/' + a.id + '/' + endpoint, actor, { ...common(a), [field]: value, shippingWarehouse: 'CA' });
        const zero = (await api('/api/inquiries/' + a.id + '/' + endpoint, actor, { ...common(a), [field]: 0, shippingWarehouse: 'CA' })).record;
        assert.equal(zero[field], 0);
    }
    check('D03相邻Alan和采购回复空值拒绝，明确0含义与办理行为保留');
    for (const endpoint of ['alan-review', 'reply']) {
        let a = await allocation(db.db.prepare("SELECT * FROM stock_batches WHERE model='SYNTH-INK-001' LIMIT 1").get());
        if (endpoint === 'reply')
            db.db.prepare('UPDATE allocation_documents SET ink_workflow_stage=NULL WHERE id=?').run(a.id);
        a = await review(a, 'allocations', 80);
        const actor = endpoint === 'alan-review' ? 'alan' : 'purchasing', field = endpoint === 'alan-review' ? 'alanQuantity' : 'supplierQuantity';
        for (const value of [null, '', '   '])
            await reject('/api/allocations/' + a.id + '/' + endpoint, actor, { ...common(a), [field]: value });
        const zero = (await api('/api/allocations/' + a.id + '/' + endpoint, actor, { ...common(a), [field]: 0 })).record;
        assert.equal(zero[field], 0);
    }
    check('D03调拨Alan与保留旧采购链相邻入口空值拒绝、明确0保留');
    const csv = Buffer.from('Brand,ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\nAster,YEAR-TEST,5,5,000Y,整柜,YEAR-PLAN,1.1,一团,V1');
    const response = await fetch(base + '/api/transit/preview', { method: 'POST', headers: { 'x-role': 'admin', 'x-file-name': encodeURIComponent('年份硒鼓.csv') }, body: csv }), missing = await response.json();
    assert.equal(response.status, 200);
    assert(missing.dateYearRequired);
    assert(missing.validation.errors.some(x => x.code === 'date_year_required'));
    assert(!missing.previewToken);
    check('N01既有后端无年份返回缺年错误且无凭证，未改年份协议');
    db.assertInventoryInvariants();
    assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
}
catch (e) {
    failure = e.stack;
    throw e;
}
finally {
    if (child.exitCode === null) {
        const ended = once(child, 'exit');
        child.kill();
        await ended;
    }
    db.close();
    await fs.writeFile(path.join(out, 'server.log'), serverLog);
    await fs.writeFile(path.join(out, 'trace.json'), JSON.stringify(trace, null, 2));
    await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ at: new Date().toISOString(), out, state, base, instanceId, checks, failure: failure ?? null, schemaVersion: 38, serverStopped: child.exitCode !== null || child.signalCode !== null, productionWrites: 0 }, null, 2));
    console.log('OUTPUT ' + out);
}
const closed = await new Promise(resolve => { const s = net.createConnection({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', e => resolve(e.code === 'ECONNREFUSED')); s.setTimeout(2000, () => { s.destroy(); resolve(false); }); });
assert(closed);
await fs.writeFile(path.join(out, 'cleanup.json'), JSON.stringify({ at: new Date().toISOString(), port, closed: true }, null, 2));
