// Isolated synthetic fixtures and project page regression. ASTER_PAGE_FIXTURE_ONLY=1
// starts only the owned server, so desktop acceptance can use cua_repl instead.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInventoryDatabase, InventoryDatabase } from '../../inventory-db.mjs';
import { freePort, createTestInstanceId, waitForOwnedServer } from '../../scripts/test-server-ownership.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT || path.join(root, '.test-output/toner-v38/page'));
await fs.mkdir(out, { recursive: true });
const state = await fs.mkdtemp(path.join(out, 'state-'));
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite'), seedCatalogData: false });
const db = new InventoryDatabase(state), rid = () => crypto.randomUUID(), common = row => ({ expectedRevision: row.revision, requestId: rid() });
const model = 'SYNTH-TONER-V38', today = new Date().toISOString().slice(0, 10);
db.db.prepare('INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at) VALUES(?,?,0,0,?)').run(model, '硒鼓', new Date().toISOString());
const rows = [{ sourceRow: 2, data: { model, quantity: 4000, packPerBox: '10', fnsku: 'V38-SOURCE', shippingMethod: 'SyntheticWarehouseA', plan: 'V38-SOURCE', date: today, team: '一团', version: 'V38-SOURCE' } }];
const proof = { kind: 'import', role: 'purchasing', fileName: 'V38-硒鼓.csv', fileHash: 'v38-synthetic-source', templateHash: 'v38-synthetic-template', payload: { rows } };
const imported = db.transitImport({ ...proof, rows, previewToken: db.createTransitPreviewToken(proof).token, requestId: rid() }).rows[0];
const shelf = db.markTransitOnShelf({ id: imported.id, role: 'assistant-1', yes: 'YES', ...common(imported) });
const batch = db.getCatalog().stockDetails[model].find(row => row.batchKey === shelf.batchKey);
assert(batch, 'synthetic source batch must exist');
function allocation(operator, department = '一团') {
  return db.createAllocation({ role: department === '一团' ? 'operation-1' : 'operation-2', model, sourceBatchKey: batch.batchKey, plan: batch.plan, date: batch.date, version: batch.version, quantity: 100, department, store: 'V38US', operator, fnsku: 'V38-DESTINATION', asin: 'BTONER38', operatorNote: '运营原始备注', requestId: rid() }).record;
}
function inquiry(operator) {
  return db.createInquiry({ role: 'operation-1', model, quantity: 100, department: '一团', store: 'V38US', operator, fnsku: 'V38-DESTINATION', asin: 'BTONER38', operatorNote: '询库原始备注', requestId: rid() }).record;
}
function approvedInquiry(operator) {
  const row = inquiry(operator);
  return db.reviewInquiry({ id: row.id, role: 'business', decision: 'approve', approvedQuantity: 80, businessNote: '商务原始80', ...common(row) }).record;
}
const fixture = { normal: allocation('V38普通调拨'), conversion: allocation('V38转换接受'), decline: allocation('V38转换不接受'), otherTeam: allocation('V38二团单', '二团'), inquiry: inquiry('V38普通询库'), zero: approvedInquiry('V38采购零拒绝') };
let old = approvedInquiry('V38旧助理归档');
old = db.replyInquiry({ id: old.id, role: 'purchasing', supplierQuantity: 60, shippingWarehouse: 'CA', procurementNote: '历史采购回复', ...common(old) }).record;
// Explicit historical fixture: do not reinterpret an old assistant archive as procurement shipment evidence.
const historicalAt = new Date().toISOString();
db.db.prepare("UPDATE inquiry_documents SET status='archived',plan='V38-OLD',ship_date=?,version='V38-OLD',archived_by_role='assistant-1',archived_at=? WHERE id=?").run(today, historicalAt, old.id);
db.addInquiryEvent(old.id, 'archive', 'assistant-1', historicalAt, { plan: 'V38-OLD', date: today, version: 'V38-OLD', quantity: 60 });
fixture.historical = db.getInquiry(old.id);

let hiddenAllocation = allocation('V38隐藏关联');
hiddenAllocation = db.transferAllocationToInquiry({ id: hiddenAllocation.id, role: 'business', approvedQuantity: 73, businessNote: '隐藏关联商务73', ...common(hiddenAllocation) }).record;
const accepted = db.decideAllocationConversion({ id: hiddenAllocation.id, role: 'operation-1', decision: 'accept', ...common(hiddenAllocation) });
hiddenAllocation = db.getDocument(hiddenAllocation.id);
let hiddenInquiry = db.getInquiry(hiddenAllocation.convertedInquiryId);
assert(accepted && hiddenInquiry);
hiddenInquiry = db.replyInquiry({ id: hiddenInquiry.id, role: 'purchasing', supplierQuantity: 90, shippingWarehouse: 'SC', procurementNote: '隐藏关联采购90', ...common(hiddenInquiry) }).record;
hiddenInquiry = db.archiveInquiry({ id: hiddenInquiry.id, role: 'purchasing', plan: 'V38-HIDDEN', date: today, version: 'V38-HIDDEN', ...common(hiddenInquiry) }).record;
db.db.prepare("UPDATE allocation_documents SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(hiddenAllocation.id);
db.db.prepare('UPDATE inquiry_documents SET approval_hidden=1 WHERE id=?').run(hiddenInquiry.id);
fixture.hiddenAllocation = db.getDocument(hiddenAllocation.id);
fixture.hiddenInquiry = db.getInquiry(hiddenInquiry.id);

// Establish an already-effective display cutoff; created_at alone is insufficient on a first-run database.
db.db.prepare("INSERT INTO system_meta(key,value) VALUES('approval_first_clear_at','2000-01-01T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
const port = await freePort(), base = `http://127.0.0.1:${port}`, instanceId = createTestInstanceId('toner-v38-page');
let child, browser, page, failure;
const checks = [], errors = [], posts = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
const info = { base, state, instanceId, model, batchKey: batch.batchKey, fixture, productionWrites: 0 };
async function stop() { if (child?.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
try {
  child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, ASTER_STATE_ROOT: state, HOST: '127.0.0.1', PORT: String(port), PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId, ASTER_OVERSEAS_WAREHOUSES: 'SyntheticWarehouseA;SyntheticWarehouseB' } });
  await waitForOwnedServer({ base, child, instanceId });
  await fs.writeFile(path.join(out, 'fixture.json'), JSON.stringify(info, null, 2));
  if (process.env.ASTER_PAGE_FIXTURE_ONLY === '1') {
    console.log('TONER_V38_FIXTURE ' + JSON.stringify({ base, state, fixtureFile: path.join(out, 'fixture.json'), instanceId }));
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
    await once(child, 'exit');
  } else {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
    await page.goto(base);
    const row = (kind, record) => page.locator(`[data-document-key="${kind}-${record.id}"]`);
    async function open(role, search = '') {
      await page.getByLabel('切换当前操作角色', { exact: true }).selectOption(role);
      await page.locator('.sidebar .nav-item', { hasText: '审批中心' }).click();
      await page.getByLabel('搜索编号、型号、运营或 ASIN', { exact: true }).fill(search);
      const mine = page.getByRole('button', { name: ['operation-1','operation-2'].includes(role) ? /^处理中/ : /^我的待办/ });
      if (await mine.getAttribute('aria-pressed') === 'true') await mine.click();
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.waitForLoadState('networkidle');
      while (await page.locator('.approval-model-row[aria-expanded="false"]').count()) await page.locator('.approval-model-row[aria-expanded="false"]').first().click();
    }
    async function write(kind, record, action, button) {
      const response = page.waitForResponse(result => result.request().method() === 'POST' && new URL(result.url()).pathname === `/api/${kind === 'allocation' ? 'allocations' : 'inquiries'}/${record.id}/${action}`);
      await button.click(); const result = await response, body = await result.json(); assert.equal(result.status(), 200, JSON.stringify(body)); return body;
    }
    async function business(kind, record, quantity, action = 'review') {
      await open('business', record.operator); const card = row(kind, record);
      await card.getByLabel('审核数量', { exact: true }).fill(String(quantity));
      await card.getByLabel('商务备注', { exact: true }).fill('V38商务' + quantity);
      return write(kind, record, action, card.getByRole('button', { name: action === 'review' ? '批准' : '转询库', exact: true }));
    }
    async function procurement(record, quantity) {
      await open('purchasing', record.operator); const card = row('inquiry', record);
      await card.getByLabel('供应商库存回复', { exact: true }).fill(String(quantity));
      await card.getByLabel('发货仓库', { exact: true }).selectOption('CA');
      await card.getByLabel('采购备注', { exact: true }).fill('V38采购' + quantity);
      return write('inquiry', record, 'reply', card.getByRole('button', { name: '提交采购回复', exact: true }));
    }
    async function archive(record) {
      await open('purchasing', record.operator);
      await row('inquiry', record).getByRole('button', { name: '确认实际发出并归档', exact: true }).click();
      const dialog = page.getByRole('dialog');
      assert.match(await dialog.innerText(), /全部实际发出/);
      await dialog.getByLabel('发货计划号', { exact: true }).fill('V38-FINAL');
      await dialog.getByLabel('发货时间', { exact: true }).fill(today);
      await dialog.getByLabel('原版本号', { exact: true }).fill('V38-FINAL');
      await write('inquiry', record, 'archive', dialog.getByRole('button', { name: '确认全部发出并归档', exact: true }));
      await dialog.waitFor({ state: 'hidden' });
    }
    await business('allocation', fixture.normal, 80);
    await open('assistant-1', fixture.normal.operator);
    await row('allocation', fixture.normal).getByRole('button', { name: '确认全部发出', exact: true }).click();
    await write('allocation', fixture.normal, 'confirm', page.getByRole('dialog').getByRole('button', { name: '确认全部发出', exact: true }));
    assert.equal(db.getDocument(fixture.normal.id).statusCode, 'confirmed');
    check('硒鼓普通调拨商务80、本团助理实际发出弹窗和完成');

    await business('allocation', fixture.conversion, 73, 'transfer-inquiry');
    assert.equal(db.getDocument(fixture.conversion.id).tonerConversionStatus, 'pending_confirmation');
    await open('operation-1', fixture.conversion.operator);
    await write('allocation', fixture.conversion, 'conversion-decision', row('allocation', fixture.conversion).getByRole('button', { name: '接受转询库', exact: true }));
    const converted = db.getInquiry(db.getDocument(fixture.conversion.id).convertedInquiryId);
    assert.equal(converted.sourceOriginalRequestedQuantity, 100); assert.equal(converted.originalRequestedQuantity, 73); assert.equal(converted.status, 'pending_purchasing'); assert.equal(converted.plan, '');
    await procurement(converted, 90); await archive(converted);
    check('非整箱73转换、运营接受直接采购90、实际发出归档及100/73/90历史');

    await business('allocation', fixture.decline, 73, 'transfer-inquiry'); await open('operation-1', fixture.decline.operator);
    await write('allocation', fixture.decline, 'conversion-decision', row('allocation', fixture.decline).getByRole('button', { name: '不接受', exact: true }));
    assert.equal(db.getDocument(fixture.decline.id).tonerConversionStatus, 'rejected');
    await business('inquiry', fixture.inquiry, 80); await procurement(fixture.inquiry, 60); await archive(fixture.inquiry);
    await procurement(fixture.zero, 0); assert.equal(db.getInquiry(fixture.zero.id).status, 'rejected');
    check('普通询库100/80/60、采购零拒绝和转换不接受分支');

    await open('logistics'); assert.equal(await page.getByLabel('供应商库存回复', { exact: true }).count(), 0); assert.equal(await page.getByRole('button', { name: '确认实际发出并归档', exact: true }).count(), 0);
    await open('operation-1'); assert.equal(await row('allocation', fixture.otherTeam).count(), 0);
    check('物流硒鼓只读及运营本团范围');

    await open('admin', fixture.hiddenInquiry.operator); assert.equal(await row('allocation', fixture.hiddenAllocation).count(), 0); assert.equal(await row('inquiry', fixture.hiddenInquiry).count(), 0);
    await page.locator('.sidebar .nav-item', { hasText: '库存流水' }).click();
    await page.getByLabel('选择库存业务动作', { exact: true }).selectOption('inquiry_completed');
    const completedEvent = db.db.prepare("SELECT id FROM document_events WHERE event_type='inquiry_completed' AND json_extract(payload_json,'$.inquiryId')=?").get(fixture.hiddenInquiry.id);
    assert(completedEvent);
    const auditRow = page.locator('.audit-table tbody tr').filter({ hasText: fixture.hiddenInquiry.operator });
    await auditRow.getByRole('button', { name: '查看流水', exact: true }).click();
    await page.getByRole('button', { name: '查看询库 · ' + fixture.hiddenInquiry.documentNo, exact: true }).click();
    await page.getByRole('dialog', { name: '询库详情 · ' + fixture.hiddenInquiry.documentNo, exact: true }).waitFor();
    const history = page.getByRole('dialog', { name: /^(询库|调拨)详情 · / });
    await history.getByRole('button', { name: '查看来源调拨 · ' + fixture.hiddenAllocation.documentNo, exact: true }).click();
    await history.getByRole('button', { name: '查看承接询库 · ' + fixture.hiddenInquiry.documentNo, exact: true }).click();
    assert.equal(db.db.prepare('SELECT approval_hidden FROM inquiry_documents WHERE id=?').get(fixture.hiddenInquiry.id).approval_hidden, 1);
    await history.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    check('两单隐藏后库存流水打开单据并双向追踪，不恢复隐藏');

    await page.getByRole('button', { name: '关闭', exact: true }).click(); await open('admin', fixture.historical.operator);
    await row('inquiry', fixture.historical).locator(':scope > .approval-data-row').click();
    await row('inquiry', fixture.historical).getByRole('region', { name: '询库详情', exact: true }).getByText('助理（历史归档）', { exact: true }).waitFor();
    await row('inquiry', fixture.historical).locator(':scope > .approval-data-row').click();
    for (const width of [1280, 1366, 1920]) { await page.setViewportSize({ width, height: 1000 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: path.join(out, `toner-v38-${width}.png`), fullPage: true }); }
    assert.deepEqual(errors, []); db.assertInventoryInvariants();
    check('旧助理归档事实、三种屏宽和页面运行检查');
  }
} catch (error) { failure = error.stack; await page?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
finally { await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ ...info, checks, errors, posts, failure }, null, 2)); await browser?.close(); await stop(); db.close(); }
if (process.env.ASTER_PAGE_FIXTURE_ONLY !== '1') console.log(`TONER_V38_PAGE_PASS ${checks.length} groups`);
