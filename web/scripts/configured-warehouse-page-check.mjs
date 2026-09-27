// 配置仓库贯通真实升级完成页面和后端白名单；仅用合成库存及历史包裹夹具。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { freePort, createTestInstanceId, waitForOwnedServer } from '../../scripts/test-server-ownership.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const output = process.env.ASTER_WAREHOUSE_OPTIONS_OUTPUT || path.join(root, '.test-output/configured-warehouse-page');
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-configured-warehouse-'));
await fs.mkdir(output, { recursive: true });
const warehouses = ['AUDIT-WH-ONE', 'AUDIT-WH-TWO'];
process.env.ASTER_RUNTIME_CONFIG = path.join(state, 'runtime-config.json');
delete process.env.ASTER_OVERSEAS_WAREHOUSES;
await fs.writeFile(process.env.ASTER_RUNTIME_CONFIG, JSON.stringify({ schemaVersion: 1, overseasWarehouses: warehouses }));
const { createInventoryDatabase, InventoryDatabase } = await import('../../inventory-db.mjs');
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite') });
const db = new InventoryDatabase(state), rid = () => crypto.randomUUID();
const direct = db.createDirectUpgrade({ role: 'admin', model: 'SYNTH-TONER-001', sourceVersion: 'V11', requestId: rid() }).upgrade;
let inquiry = db.createInquiry({ role: 'admin', model: 'SYNTH-TONER-001', quantity: 20, department: '一团', store: 'AUDITUS', operator: 'warehouse-fixture', asin: 'BWARE001', fnsku: 'XWARE001', requestId: rid() }).record;
inquiry = db.reviewInquiry({ id: inquiry.id, role: 'business', decision: 'approve', approvedQuantity: 20, expectedRevision: inquiry.revision, requestId: rid() }).record;
inquiry = db.replyInquiry({ id: inquiry.id, role: 'purchasing', supplierQuantity: 20, shippingWarehouse: 'CA', expectedRevision: inquiry.revision, requestId: rid() }).record;
inquiry = db.archiveInquiry({ id: inquiry.id, role: 'assistant-1', plan: 'AUDIT-PLAN', date: '2026-09-01', version: 'V1', expectedRevision: inquiry.revision, requestId: rid() }).record;
let work = db.initiateRelocationUpgrade({ role: 'admin', inquiryId: inquiry.id, requestId: rid() }).workItem;
work = db.recordRelocationProcurement({ id: work.id, role: 'purchasing', rma: 'AUDIT-RMA', relocationAddress: 'synthetic-address', expectedRevision: work.revision, requestId: rid() }).workItem;
work = db.recordRelocationOperation({ id: work.id, role: 'operation-1', removalOrderNo: 'AUDIT-ORDER', expectedRevision: work.revision, requestId: rid() }).workItem;
// 只准备已具备包裹凭据的合成历史状态，不启动领星执行器、不请求外部服务。
db.syncRelocationLogistics({ id: work.id, role: 'admin', shipments: [{ externalId: 'AUDIT-PACKAGE', storeId: 'AUDIT', orderNo: 'AUDIT-ORDER', fnsku: 'XWARE001', carrier: 'TEST', trackingNo: 'AUDIT-TRACK', quantity: 10, shipDate: '2026-09-01' }], capturedAt: new Date().toISOString(), requestId: rid() });
work = db.getRelocationWorkItem(work.id);
db.shipRelocationUpgrade({ id: work.id, role: 'admin', fbaRemainingQuantity: 10, externalItems: [{ lineId: work.externalShipments[0].lineId, quantity: 10 }], expectedRevision: work.revision, requestId: rid() });
const relocationId = db.getRelocationWorkItem(work.id).relocationId;
const port = await freePort(), base = `http://127.0.0.1:${port}`, instanceId = createTestInstanceId('configured-warehouse-page');
const server = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, ASTER_STATE_ROOT: state, PORT: String(port), HOST: '127.0.0.1', PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId } });
let browser, page, failure;
const checks = [], errors = [], receipts = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const api = async (route, payload) => {
  const response = await fetch(base + route, { method: payload ? 'POST' : 'GET', headers: { 'x-role': 'purchasing', 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  return { status: response.status, body: await response.json() };
};
const submit = async (route, button) => {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === route && response.request().method() === 'POST');
  await button.click(); const response = await pending; const body = await response.json(); receipts.push({ route, status: response.status(), body }); assert.equal(response.status(), 200, JSON.stringify(body));
};
try {
  await waitForOwnedServer({ base, child: server, instanceId });
  assert.deepEqual((await api('/api/upgrades')).body.overseasWarehouses, warehouses);
  const rejected = await api(`/api/upgrades/direct/${direct.id}/complete`, { sourceLineId: direct.lines[0].id, completedQuantity: 1, newVersion: 'INVALID-WH', targetWarehouse: 'SyntheticWarehouseA', expectedRevision: direct.revision, requestId: rid() });
  assert.equal(rejected.status, 422); assert.equal(rejected.body.code, 'invalid_target_warehouse');
  check('API公开实际配置名单，后端仍拒绝名单外仓库');
  browser = await chromium.launch({ headless: true, executablePath: process.env.ASTER_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  page = await browser.newPage({ viewport: { width: 1500, height: 1100 } }); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByLabel('切换当前操作角色', { exact: true }).selectOption('purchasing'); await page.locator('.sidebar .nav-item', { hasText: '升级库存' }).click();
  await page.getByRole('tab', { name: '在库升级', exact: true }).click();
  const job = page.locator('.upgrade-job').filter({ hasText: direct.upgradeNo }); await job.waitFor();
  const target = job.getByLabel(`${direct.upgradeNo} 目标海外仓`, { exact: true });
  assert.deepEqual(await target.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean)), warehouses);
  await job.getByLabel(`${direct.upgradeNo} 升级完成数量`, { exact: true }).fill('5'); await job.getByLabel(`${direct.upgradeNo} 升级完成版本号`, { exact: true }).fill('WARE-DIRECT'); await target.selectOption(warehouses[0]);
  const before = db.getCatalog().models.find(model => model.model === 'SYNTH-TONER-001').inStock;
  await submit(`/api/upgrades/direct/${direct.id}/complete`, job.getByRole('button', { name: '登记完成并转入新版本', exact: true }));
  await job.getByText('WARE-DIRECT / AUDIT-WH-ONE：5', { exact: true }).waitFor();
  assert.equal(db.getCatalog().models.find(model => model.model === 'SYNTH-TONER-001').inStock, before);
  assert.equal(db.getCatalog().stockDetails['SYNTH-TONER-001'].find(row => row.version === 'WARE-DIRECT' && row.warehouse === warehouses[0]).quantity, 5);
  check('在库升级通过页面进入配置仓库，版本5件与总量守恒可回读');
  await page.getByRole('tab', { name: '移仓升级', exact: true }).click(); await page.locator('.source-select').filter({ hasText: inquiry.documentNo }).click();
  const relocation = page.locator(`[data-relocation-id="${relocationId}"]`); await relocation.waitFor();
  const warehouse = relocation.getByRole('combobox');
  assert.deepEqual(await warehouse.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean)), warehouses);
  await relocation.locator('input').nth(0).fill('4'); await relocation.locator('input').nth(1).fill('WARE-RELOCATION'); await warehouse.selectOption(warehouses[1]);
  await submit(`/api/upgrades/relocations/${relocationId}/complete`, relocation.getByRole('button', { name: '完成入库', exact: true }));
  await relocation.getByText('WARE-RELOCATION / AUDIT-WH-TWO：4', { exact: true }).waitFor();
  assert.equal(db.getUpgradeRelocation(relocationId).completed_quantity, 4);
  assert.equal(db.getCatalog().models.find(model => model.model === 'SYNTH-TONER-001').inStock, before + 4);
  assert.equal(db.getCatalog().stockDetails['SYNTH-TONER-001'].find(row => row.version === 'WARE-RELOCATION' && row.warehouse === warehouses[1]).quantity, 4);
  check('移仓升级通过页面进入另一配置仓库，回库4件可回读');
  assert.deepEqual(errors, []); db.assertInventoryInvariants(); assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []); check('页面无运行异常，库存和外键约束一致');
} catch (error) {
  failure = error.stack; await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); throw error;
} finally {
  await browser?.close(); server.kill(); db.close();
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ state, base, warehouses, checks, errors, receipts, failure, ownServerTerminated: server.killed }, null, 2));
}
