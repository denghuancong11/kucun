// 当前标签页记住演示角色；独立标签页互不覆盖，非法存储值不进入业务请求。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createInventoryDatabase, InventoryDatabase } from '../../inventory-db.mjs';
import { freePort, createTestInstanceId, waitForOwnedServer } from '../../scripts/test-server-ownership.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const output = process.env.ASTER_ROLE_SESSION_OUTPUT || path.join(root, '.test-output/role-session');
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-role-session-'));
await fs.mkdir(output, { recursive: true });
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite') });
const db = new InventoryDatabase(state);
const records = ['一团', '二团'].map(department => db.createInquiry({ role: 'admin', model: 'SYNTH-TONER-001', quantity: 7, department, store: 'AUDITUS', operator: department, asin: 'BSESSION01', fnsku: 'XSESSION01', requestId: crypto.randomUUID() }).record);
const port = await freePort(), base = `http://127.0.0.1:${port}`, instanceId = createTestInstanceId('role-session');
const server = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, ASTER_STATE_ROOT: state, PORT: String(port), HOST: '127.0.0.1', PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId } });
let browser, page, failure;
const checks = [], errors = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const selector = target => target.getByLabel('切换当前操作角色', { exact: true });
try {
  await waitForOwnedServer({ base, child: server, instanceId });
  browser = await chromium.launch({ headless: true, executablePath: process.env.ASTER_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); assert.equal(await selector(page).inputValue(), 'admin');
  await selector(page).selectOption('operation-1');
  const firstCatalog = page.waitForRequest(request => new URL(request.url()).pathname === '/api/inventory/catalog');
  await page.reload(); const roleRequest = await firstCatalog;
  assert.equal(await selector(page).inputValue(), 'operation-1', '刷新当前标签页应保留所选运营一团');
  assert.equal(await roleRequest.headerValue('x-role'), 'operation-1', '首次业务读取即使用恢复后的角色');
  check('刷新后保持运营一团，首次请求未短暂以admin读取业务');
  await page.locator('.sidebar .nav-item', { hasText: '审批中心' }).click();
  await page.locator(`[data-document-no="${records[0].documentNo}"]`).waitFor({ state: 'attached' });
  assert.equal(await page.locator(`[data-document-no="${records[1].documentNo}"]`).count(), 0);
  check('刷新后的审批仍仅包含本团记录');

  const other = await context.newPage(); other.on('pageerror', error => errors.push(error.message));
  await other.goto(base); assert.equal(await selector(other).inputValue(), 'admin');
  await selector(other).selectOption('operation-2'); await other.reload();
  assert.equal(await selector(other).inputValue(), 'operation-2');
  assert.equal(await selector(page).inputValue(), 'operation-1');
  await page.reload(); assert.equal(await selector(page).inputValue(), 'operation-1');
  check('独立标签页首次默认admin，两个标签页的角色互不覆盖');

  for (const role of ['admin', 'assistant-1', 'assistant-2', 'operation-1', 'operation-2', 'purchasing', 'business']) {
    await selector(page).selectOption(role); await page.reload(); assert.equal(await selector(page).inputValue(), role);
  }
  check('七个合法角色均可在当前标签页刷新恢复');
  await page.evaluate(() => sessionStorage.setItem('aster-current-role', 'not-a-role'));
  const invalidCatalog = page.waitForRequest(request => new URL(request.url()).pathname === '/api/inventory/catalog');
  await page.reload(); assert.equal(await selector(page).inputValue(), 'admin'); assert.equal(await (await invalidCatalog).headerValue('x-role'), 'admin');
  check('非法存储值安全回退admin，未发送非法角色头');

  assert.deepEqual(errors, []); check('页面无运行异常');
} catch (error) {
  failure = error.stack; await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); throw error;
} finally {
  await browser?.close(); server.kill(); db.close();
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ checks, errors, state, base, failure, ownServerTerminated: server.killed }, null, 2));
}
