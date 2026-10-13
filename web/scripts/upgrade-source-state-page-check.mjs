// Real Edge against an owned random-port server and isolated SQLite. No production writes or real Lingxing calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInventoryDatabase, InventoryDatabase } from '../../inventory-db.mjs';
import { freePort, createTestInstanceId, waitForOwnedServer } from '../../scripts/test-server-ownership.mjs';
import { chromium } from '../node_modules/playwright-core/index.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, '.test-output/ui-consistency-fix/upgrade');
await fs.mkdir(out, { recursive: true });
const state = await fs.mkdtemp(path.join(out, 'state-'));
const accountsFile = path.join(state, 'accounts.json');
await fs.writeFile(accountsFile, JSON.stringify({ accounts: [{ account: 'AUS', shortName: 'AUDIT', room: '106' }] }));
process.env.ASTER_WAREHOUSE_ACCOUNTS = accountsFile;
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite') });
const db = new InventoryDatabase(state), rid = () => crypto.randomUUID();
const checks = [], screenshots = [], errors = [];
let child, browser, page, failure, serial = 0;
const check = (name, evidence = {}) => { checks.push({ name, ...evidence }); console.log('PASS ' + name); };
const stamp = () => new Date().toISOString();
const common = row => ({ expectedRevision: row.revision, requestId: rid() });
function transit(model, version, quantity, method) {
  const at = stamp();
  return Number(db.db.prepare(`INSERT INTO transit_batches(model,quantity,remaining_quantity,plan,ship_date,version,fnsku,
    shipping_method,team,logistics_status,on_shelf_indicator,created_at,updated_at,pack_per_box)
    VALUES(?,?,?,?,?,?,?,?,?,'在途','NO',?,?,'1')`).run(model, quantity, quantity, 'STATE-PLAN-' + (++serial),
    '2026-10-13', version, 'X011111111', method, '一团', at, at).lastInsertRowid);
}
const shelf = id => db.markTransitOnShelf({ id, role: 'assistant-1', expectedRevision: 1, yes: 'YES', requestId: rid() });
const fba = (model, version) => shelf(transit(model, version, 100, '直发FBA')).fbaArchiveId;
function inquiry() {
  return db.createInquiry({ role: 'operation-1', model: 'SYNTH-TONER-001', quantity: 100, department: '一团', store: 'AUS',
    operator: '隔离回归', fnsku: 'X011111111', asin: 'B000000001', requestId: rid() }).record;
}
function archive(row) {
  row = db.reviewInquiry({ id: row.id, role: 'business', decision: 'approve', approvedQuantity: 100, ...common(row) }).record;
  row = db.replyInquiry({ id: row.id, role: 'purchasing', supplierQuantity: 100, shippingWarehouse: 'CA', ...common(row) }).record;
  return db.archiveInquiry({ id: row.id, role: 'assistant-1', plan: 'STATE-INQUIRY-' + row.id, date: '2026-10-13',
    version: 'VFBA-A', ...common(row) }).record;
}
const sourceRecord = (kind, id) => db.getRelocationCandidates().find(row => row.sourceKind === kind && row[
  { fba: 'fbaArchiveId', inquiry: 'inquiryId', allocation: 'allocationId' }[kind]] === id);
const sourceRow = (kind, id) => page.locator(`tr[data-source-document-no="${sourceRecord(kind, id).documentNo}"]`);
const account = () => page.getByLabel('本次移仓账号', { exact: true });
const initiateButton = () => page.getByRole('button', { name: '发起移仓升级', exact: true });
const filters = () => page.locator('.relocation-source-panel select');
const selectedNo = () => page.locator('.relocation-source-panel tr.row-expanded').getAttribute('data-source-document-no');
async function waitFor(checking) {
  let error;
  for (let n = 0; n < 100; n++) {
    try { return await checking(); } catch (cause) { error = cause; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw error;
}
async function shot(name) {
  const file = path.join(out, name + '.png');
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' }); screenshots.push(file);
}
async function selectSource(kind, id) { await sourceRow(kind, id).getByRole('button').click(); }
async function expectAccountReset() {
  await waitFor(async () => { assert.equal(await account().count(), 1); assert.equal(await account().inputValue(), ''); assert.equal(await initiateButton().isEnabled(), false); });
}
async function refreshComplete(version) {
  await waitFor(async () => {
    const loaded = await page.evaluate(() => window.__upgradeStateTestVersion ?? 0);
    assert(loaded >= version, '升级查询尚未读到本次数据版本');
  });
}

const firstInquiry = archive(inquiry());
let pendingWork;
// Different tables deliberately reuse the integer 1; source identity must include its kind.
const fbaA = fba('SYNTH-TONER-001', 'VFBA-A');
const fbaB = fba('SYNTH-TONER-002', 'VFBA-B');
const fbaC = fba('SYNTH-TONER-001', 'VFBA-C');
const fbaD = fba('SYNTH-TONER-001', 'VFBA-D');
assert.equal(firstInquiry.id, fbaA);
const warehouseTransit = transit('SYNTH-TONER-001', 'V11', 17, 'SyntheticWarehouseA');
const port = await freePort(), base = 'http://127.0.0.1:' + port;
try {
  const instanceId = createTestInstanceId('upgrade-source-state');
  child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, windowsHide: true, stdio: 'pipe', env: {
    ...process.env, ASTER_STATE_ROOT: state, ASTER_WAREHOUSE_ACCOUNTS: accountsFile,
    ASTER_OVERSEAS_WAREHOUSES: 'SyntheticWarehouseA;SyntheticWarehouseB', HOST: '127.0.0.1', PORT: String(port),
    PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId,
  } });
  child.stderr.on('data', data => process.stderr.write(data));
  await waitForOwnedServer({ base, child, instanceId });
  browser = await chromium.launch({ executablePath: process.env.ASTER_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => {
    if (response.url() !== base + '/api/upgrades' || !response.ok()) return;
    const data = await response.json();
    await page.evaluate(version => { window.__upgradeStateTestVersion = version; }, data.sync.dataVersion).catch(() => {});
  });
  await page.goto(base); await page.locator('.sidebar .nav-item', { hasText: '升级库存' }).click();
  await sourceRow('fba', fbaA).waitFor();

  await selectSource('fba', fbaA); await account().selectOption('AUS');
  await selectSource('fba', fbaA); assert.equal(await account().inputValue(), 'AUS');
  check('重复点击同一来源保留账号');
  await selectSource('fba', fbaB); await expectAccountReset();
  check('点击另一来源时账号清空，重新选择前不可发起');
  await selectSource('fba', fbaA); await expectAccountReset();
  await selectSource('fba', fbaB); await expectAccountReset();
  check('A→B→A切换不会恢复旧来源的账号');
  await account().selectOption('AUS'); await filters().nth(0).selectOption('SYNTH-TONER-002');
  assert.equal(await selectedNo(), sourceRecord('fba', fbaB).documentNo); assert.equal(await account().inputValue(), 'AUS');
  check('筛选后实际仍为同一来源时保留账号');
  await filters().nth(0).selectOption('SYNTH-TONER-001');
  await expectAccountReset();
  assert.equal(await selectedNo(), sourceRecord('fba', fbaD).documentNo);
  check('型号筛选改变实际来源时账号清空');
  await account().selectOption('AUS'); await filters().nth(1).selectOption('VFBA-C'); await expectAccountReset();
  assert.equal(await selectedNo(), sourceRecord('fba', fbaC).documentNo);
  check('版本筛选改变实际来源时账号清空');

  await account().selectOption('AUS'); const otherInquiry = inquiry();
  await refreshComplete(db.syncState().dataVersion); assert.equal(await account().inputValue(), 'AUS');
  assert.equal(await selectedNo(), sourceRecord('fba', fbaC).documentNo);
  check('同来源数据刷新保留已选账号');
  await filters().nth(1).selectOption(''); await expectAccountReset();
  assert.equal(await selectedNo(), sourceRecord('fba', fbaD).documentNo); await account().selectOption('AUS');
  const fbaE = fba('SYNTH-TONER-001', 'VFBA-E');
  await refreshComplete(db.syncState().dataVersion);
  await waitFor(async () => assert.equal(await selectedNo(), sourceRecord('fba', fbaE).documentNo));
  await expectAccountReset();
  check('自动刷新使默认实际来源改变时账号清空'); await shot('account-source-reset');

  pendingWork = db.initiateRelocationUpgrade({ role: 'admin', inquiryId: firstInquiry.id, requestId: rid() }).workItem;
  await refreshComplete(db.syncState().dataVersion);
  await filters().nth(0).selectOption('');
  await selectSource('inquiry', firstInquiry.id); assert.equal(await initiateButton().count(), 0);
  await selectSource('fba', fbaA); await account().selectOption('AUS'); assert.equal(await initiateButton().isEnabled(), true);
  check('相同整数ID的询库来源与FBA来源互不碰撞', { inquiryId: firstInquiry.id, fbaArchiveId: fbaA });
  const secondInquiry = archive(otherInquiry); await sourceRow('inquiry', secondInquiry.id).waitFor();
  await selectSource('inquiry', secondInquiry.id); assert.equal(await initiateButton().isEnabled(), true);
  const response = page.waitForResponse(r => r.url() === base + '/api/upgrades/relocation-work-items' && r.request().method() === 'POST');
  await initiateButton().click(); assert.equal((await response).status(), 200);
  await waitFor(async () => assert.equal(await initiateButton().count(), 0));
  assert(db.getRelocationWorkItems().some(work => work.inquiryId === secondInquiry.id));
  check('同型号另一个独立来源可以实际发起，提交后入口更新');

  async function assertPending(status, label) {
    pendingWork = db.getRelocationWorkItem(pendingWork.id); assert.equal(pendingWork.status, status);
    await refreshComplete(db.syncState().dataVersion); await selectSource('inquiry', firstInquiry.id);
    await waitFor(async () => {
      assert.equal(await initiateButton().count(), 0);
      assert((await page.locator('.relocation-document-head').allTextContents()).some(text => text.includes(label)));
    });
    const before = db.db.prepare('SELECT COUNT(*) AS n FROM upgrade_relocation_work_items').get().n;
    const rejected = await fetch(base + '/api/upgrades/relocation-work-items', { method: 'POST', headers: {
      'x-role': 'admin', 'content-type': 'application/json',
    }, body: JSON.stringify({ inquiryId: firstInquiry.id, requestId: rid() }) });
    assert.equal(rejected.status, 409); assert.equal((await rejected.json()).code, 'relocation_work_active');
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM upgrade_relocation_work_items').get().n, before);
    check(status + ' 隐藏发起入口且后台重复发起校验保持有效');
  }
  await assertPending('awaiting_procurement', '待物流更新RMA和地址');
  pendingWork = db.recordRelocationProcurement({ id: pendingWork.id, role: 'logistics', rma: 'STATE-RMA',
    relocationAddress: '第三方仓退货\nRMA#R616738\nMirella RW (RMA#: R616738)\n12000 Magnolia Ave, Suite#101\nRiverside , CA 92503 US\nTEL:562-404-9315',
    ...common(pendingWork) }).workItem;
  await assertPending('awaiting_operation', '待运营填写订单号');
  pendingWork = db.recordRelocationOperation({ id: pendingWork.id, role: 'operation-1', removalOrderNo: 'STATE-ORDER', ...common(pendingWork) }).workItem;
  await assertPending('awaiting_shipping', '待确认移仓发货');
  assert(db.inquiryDownstream(firstInquiry.id).some(blocker => blocker.status === '待确认移仓发货'));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM lingxing_sync_jobs').get().n, 0);
  await shot('pending-shipping-stage');
  db.syncRelocationLogistics({ id: pendingWork.id, role: 'logistics', capturedAt: stamp(), requestId: rid(), shipments: [{
    externalId: 'STATE-PKG', storeId: 'lingxing-remove-inbound', storeName: 'A-US 美国', countryCode: 'US',
    orderNo: 'STATE-ORDER', fnsku: pendingWork.fnsku, quantity: 20, carrier: 'UPS', trackingNo: 'STATE-TRACK', shipDate: '2026-10-13',
  }] });
  pendingWork = db.getRelocationWorkItem(pendingWork.id);
  assert.equal(pendingWork.status, 'shipped'); assert.equal(pendingWork.statusText, '移仓和升级中');
  assert(db.inquiryDownstream(firstInquiry.id).some(blocker => blocker.status === '移仓和升级中'));
  assert.equal(pendingWork.fbaRemainingQuantity, 80); await refreshComplete(db.syncState().dataVersion);
  await waitFor(async () => { assert.equal(await initiateButton().isEnabled(), true);
    assert((await page.locator('.relocation-document-head').allTextContents()).some(text => text.includes('移仓和升级中'))); });
  await shot('shipped-can-reinitiate');
  const nextResponse = page.waitForResponse(r => r.url() === base + '/api/upgrades/relocation-work-items' && r.request().method() === 'POST');
  await initiateButton().click(); assert.equal((await nextResponse).status(), 200);
  await waitFor(async () => assert.equal(await initiateButton().count(), 0));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM upgrade_relocation_work_items WHERE inquiry_id=?').get(firstInquiry.id).n, 2);
  check('采纳20件后余80允许再次发起，仍按同来源独立建流程', { shipped: 20, remaining: 80 });

  await page.getByRole('tab', { name: '在库升级', exact: true }).click();
  await page.locator('.upgrade-filter select').nth(0).selectOption('SYNTH-TONER-001');
  await page.locator('.upgrade-filter select').nth(1).selectOption('V11');
  const before = db.getDirectUpgradeSources().find(source => source.model === 'SYNTH-TONER-001' && source.sourceVersion === 'V11').available;
  assert.equal(before, 500);
  await page.route('**/api/upgrades/direct', async route => { if (route.request().method() === 'POST') shelf(warehouseTransit); await route.continue(); });
  await page.getByRole('button', { name: '锁定全部 500 件并发起升级', exact: true }).click();
  await page.locator('.notice-success').filter({ hasText: '已锁定 517 件' }).waitFor();
  const notice = await page.locator('.notice-success').innerText();
  const job = db.getUpgrades().find(upgrade => upgrade.kind === 'direct' && upgrade.model === 'SYNTH-TONER-001');
  assert.equal(job.initialQuantity, 517); assert(!notice.includes('已锁定 500 件'));
  check('正常并发上架17件后实际锁定517，成功提示使用已保存的517', { before, received: 17, actualLocked: job.initialQuantity, notice });
  await shot('direct-actual-lock-quantity'); assert.deepEqual(errors, []);
} catch (error) { failure = error; console.error(error); if (page) await shot('failure').catch(() => {}); }
finally {
  await browser?.close(); db.db.close();
  if (child?.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed; }
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ state, base, checks, screenshots, errors, exitCode: failure ? 1 : 0,
    failure: failure?.stack, realLingxing: false, productionWrites: false }, null, 2));
}
if (failure) process.exitCode = 1;
