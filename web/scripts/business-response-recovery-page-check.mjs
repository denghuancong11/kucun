// 真实 Edge、独立 SQLite：成功保存但 HTTP 2xx 回执损坏时，重试仍只能产生一笔业务记录。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createInventoryDatabase, InventoryDatabase } from '../../inventory-db.mjs';
import { freePort, createTestInstanceId, waitForOwnedServer } from '../../scripts/test-server-ownership.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const output = process.env.ASTER_RESPONSE_RECOVERY_OUTPUT || path.join(root, '.test-output/business-response-recovery');
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-response-recovery-'));
await fs.mkdir(output, { recursive: true });
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite') });
const db = new InventoryDatabase(state);
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const instanceId = createTestInstanceId('response-recovery');
const server = spawn(process.execPath, [path.join(root, 'server.mjs')], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, ASTER_STATE_ROOT: state, PORT: String(port), HOST: '127.0.0.1', PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId },
});
let browser, page, failure;
const checks = [], errors = [], requests = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const fields = async (scope, values) => { for (const [label, value] of Object.entries(values)) await scope.getByLabel(label, { exact: true }).fill(value); };
const openModel = async () => {
  await page.goto(`${base}/?q=SYNTH-TONER-001&model=SYNTH-TONER-001`);
  await page.getByRole('button', { name: '询库', exact: true }).waitFor();
};

try {
  await waitForOwnedServer({ base, child: server, instanceId });
  browser = await chromium.launch({ headless: true, executablePath: process.env.ASTER_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));

  for (const [label, body, contentType] of [['invalid-json', '{"ok":true,', 'application/json'], ['html', '<html>upstream response unavailable</html>', 'text/html'], ['empty', '', 'application/json']]) {
    await openModel();
    let first = true;
    const writes = [];
    await page.route('**/api/inquiries', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      writes.push(route.request().postDataJSON());
      if (!first) return route.continue();
      first = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.fulfill({ status: 200, contentType, body });
    });
    await page.getByRole('button', { name: '询库', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await fields(dialog, { '询库数量（必填）': '7', '询库店铺（必填）': 'AUDITUS', '询库运营（必填）': label, 'ASIN（必填）': 'BAUDIT001', 'FNSKU（必填）': 'XAUDIT001' });
    await dialog.getByRole('button', { name: '提交询库', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    await dialog.getByRole('button', { name: '重试确认', exact: true }).waitFor();
    assert.equal(await dialog.getByLabel('询库数量（必填）', { exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: '重试确认', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(db.db.prepare('SELECT COUNT(*) n FROM inquiry_documents WHERE operator_name=?').get(label).n, 1);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1], writes[0]);
    requests.push({ label, writes });
    check(`${label}：询库回执不可确认时冻结原草稿并复用完整请求，只保存一笔`);
    await page.unroute('**/api/inquiries');
  }

  await openModel();
  const before = db.getCatalog().models.find(item => item.model === 'SYNTH-TONER-001');
  let firstAllocation = true;
  const allocationWrites = [];
  await page.route('**/api/allocations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    allocationWrites.push(route.request().postDataJSON());
    if (!firstAllocation) return route.continue();
    firstAllocation = false;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,' });
  });
  await page.locator('.alloc-toggle').first().click();
  const allocation = page.locator('.allocation-panel');
  await fields(allocation, { '调拨数量': '5', '调拨店铺': 'AUDITUS', '调拨运营': 'allocation-damaged', '已贴 FNSKU': 'XALLOC001', 'ASIN（必填）': 'BALLOC001' });
  await allocation.getByRole('button', { name: '录入并预锁定', exact: true }).click();
  await allocation.getByRole('button', { name: '重试确认', exact: true }).waitFor();
  assert.equal(await allocation.getByLabel('调拨数量', { exact: true }).isDisabled(), true);
  await allocation.getByRole('button', { name: '重试确认', exact: true }).click();
  await allocation.getByRole('status').waitFor();
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM allocation_documents WHERE operator_name='allocation-damaged'").get().n, 1);
  assert.equal(db.getCatalog().models.find(item => item.model === 'SYNTH-TONER-001').locked, before.locked + 5);
  assert.deepEqual(allocationWrites[1], allocationWrites[0]);
  requests.push({ label: 'allocation', writes: allocationWrites });
  check('调拨坏回执重试只预锁5件、只有一笔单据');
  await page.unroute('**/api/allocations');

  // 确定的业务拒绝仍应允许用户修正输入；空白运营由真实后端拒绝。
  await openModel();
  await page.getByRole('button', { name: '询库', exact: true }).click();
  const rejected = page.getByRole('dialog');
  await fields(rejected, { '询库数量（必填）': '2', '询库店铺（必填）': 'AUDITUS', '询库运营（必填）': '   ', 'ASIN（必填）': 'BREJECT001', 'FNSKU（必填）': 'XREJECT001' });
  const refusal = page.waitForResponse(response => new URL(response.url()).pathname === '/api/inquiries' && response.request().method() === 'POST');
  await rejected.getByRole('button', { name: '提交询库', exact: true }).click();
  assert.equal((await refusal).status(), 400);
  await rejected.getByRole('alert').waitFor();
  assert.equal(await rejected.getByLabel('询库运营（必填）', { exact: true }).isEnabled(), true);
  assert.equal(await rejected.getByRole('button', { name: '重试确认', exact: true }).count(), 0);
  await rejected.getByLabel('询库运营（必填）', { exact: true }).fill('corrected-rejection');
  await rejected.getByRole('button', { name: '提交询库', exact: true }).click();
  await rejected.waitFor({ state: 'hidden' });
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM inquiry_documents WHERE operator_name='corrected-rejection'").get().n, 1);
  check('明确400拒绝后允许修正内容并正常提交');
  assert.deepEqual(errors, []);
  db.assertInventoryInvariants();
  assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
  check('页面无运行错误，库存和外键约束一致');
} catch (error) {
  failure = error.stack;
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await browser?.close();
  server.kill();
  db.close();
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ state, base, checks, errors, requests, failure, ownServerTerminated: server.killed }, null, 2));
}
