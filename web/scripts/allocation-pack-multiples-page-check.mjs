// 真实 Edge、独立 SQLite：运营提交和商务审核调拨按所选批次套/箱倍数拦截，询库保持原规则。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { createInventoryDatabase, InventoryDatabase } from '../../inventory-db.mjs';
import { createTestInstanceId, freePort, waitForOwnedServer } from '../../scripts/test-server-ownership.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const output = process.env.ASTER_ALLOCATION_PACK_PAGE_OUTPUT || path.join(root, '.test-output/allocation-pack-multiples-page');
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-allocation-pack-page-'));
await fs.mkdir(output, { recursive: true });
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite'), seedCatalogData: false });
const db = new InventoryDatabase(state);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const instanceId = createTestInstanceId('allocation-pack-page');
const server = spawn(process.execPath, [path.join(root, 'server.mjs')], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, ASTER_STATE_ROOT: state, HOST: '127.0.0.1', PORT: String(port), PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId },
});
let browser;
let page;
let failure;
const checks = [];
const allocationRequests = [];
const reviewRequests = [];
const pageErrors = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const rid = () => crypto.randomUUID();

async function api(route, role = 'admin', body) {
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-role': role, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

async function receive({ model, plan, quantity = 40, pack }) {
  const csv = `ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n${model},${quantity},${pack},XPACK00001,SyntheticWarehouseA,${plan},2026-09-24,一团,V1`;
  const previewResponse = await fetch(`${base}/api/transit/preview`, {
    method: 'POST', headers: { 'x-role': 'admin', 'x-file-name': encodeURIComponent(`allocation-pack-ui-硒鼓-${plan}.csv`) }, body: csv,
  });
  const previewText = await previewResponse.text();
  assert.equal(previewResponse.status, 200, previewText);
  const preview = JSON.parse(previewText);
  const imported = await api('/api/transit/import', 'admin', {
    previewToken: preview.previewToken, fileName: preview.fileName, fileHash: preview.fileSha256,
    templateHash: preview.templateSha256, rows: preview.rows, requestId: rid(),
  });
  const shelved = await api(`/api/transit/${imported.rows[0].id}/on-shelf`, 'admin', {
    yes: 'YES', expectedRevision: imported.rows[0].revision, requestId: rid(),
  });
  return { batchKey: shelved.batchKey, model, plan };
}

async function createAdminAllocation(batch, quantity, operator) {
  const result = await api('/api/allocations', 'admin', {
    model: batch.model, plan: batch.plan, date: '2026-09-24', version: 'V1', sourceBatchKey: batch.batchKey,
    quantity, department: '一团', store: 'AUS', operator, fnsku: 'XPACK00001', asin: 'BPACK00001', requestId: rid(),
  });
  return result.record;
}

async function openAllocation(batch) {
  const stockRow = page.locator('.detail-stock-table tbody tr').filter({ hasText: batch.plan }).first();
  await stockRow.waitFor({ state: 'visible' });
  await stockRow.locator('.alloc-toggle').click();
  return page.locator('.allocation-panel');
}

async function fillAllocation(panel, { quantity, operator }) {
  await panel.locator('input[type="number"]').fill(String(quantity));
  for (const [label, value] of Object.entries({
    '调拨店铺': 'AUS', '调拨运营': operator, '已贴 FNSKU': 'XPACK00001', 'ASIN（必填）': 'BPACK00001',
  })) await panel.getByLabel(label, { exact: true }).fill(value);
}

try {
  await waitForOwnedServer({ base, child: server, instanceId });
  const model = 'PACK-MULTIPLE-APPROVAL-UI';
  const batch4 = await receive({ model, plan: 'UI-PACK4', pack: '4' });
  const batch6 = await receive({ model, plan: 'UI-PACK6', pack: '6' });
  const missing = await receive({ model, plan: 'UI-PACK-MISSING', pack: '4' });
  db.db.prepare('UPDATE stock_batches SET pack_per_box = NULL WHERE batch_key = ?').run(missing.batchKey);
  const invalid = await receive({ model, plan: 'UI-PACK-INVALID', pack: '4' });
  db.db.prepare("UPDATE stock_batches SET pack_per_box = '0' WHERE batch_key = ?").run(invalid.batchKey);

  browser = await chromium.launch({ headless: true, executablePath: process.env.ASTER_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.setDefaultTimeout(10000);
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/allocations' && request.method() === 'POST') allocationRequests.push(request.postDataJSON());
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('aster-current-role', 'operation-1'));
  await page.goto(`${base}/?q=${encodeURIComponent(model)}&model=${encodeURIComponent(model)}`);
  await page.getByRole('button', { name: '询库', exact: true }).waitFor();

  const fourForm = await openAllocation(batch4);
  await fillAllocation(fourForm, { quantity: 5, operator: 'ui-pack-four-reject' });
  await fourForm.getByRole('button', { name: '录入并预锁定', exact: true }).click();
  const fourWarning = '本批次套/箱为 4，调拨数量须为 4 的整数倍。';
  await fourForm.getByRole('alert').filter({ hasText: fourWarning }).waitFor();
  assert.equal(await fourForm.locator('input[type="number"]').inputValue(), '5');
  assert.equal(allocationRequests.length, 0);
  assert.equal(await fourForm.locator('input[type="number"]').getAttribute('step'), '1');
  check('所选套/箱4的非倍数5显示明确警告、保留输入并在前端阻止请求');

  await fourForm.locator('input[type="number"]').fill('8');
  await fourForm.getByRole('button', { name: '录入并预锁定', exact: true }).click();
  await fourForm.getByRole('status').waitFor();
  assert.equal(allocationRequests.length, 1);
  assert.equal(allocationRequests[0].sourceBatchKey, batch4.batchKey);
  assert.equal(Object.hasOwn(allocationRequests[0], 'packPerBox'), false);
  assert.equal(db.db.prepare("SELECT quantity FROM allocation_documents WHERE operator_name='ui-pack-four-reject'").get().quantity, 8);
  check('修改为套/箱4的合法倍数8后成功提交并预锁');

  const sixForm = await openAllocation(batch6);
  await fillAllocation(sixForm, { quantity: 8, operator: 'ui-pack-six-reject' });
  const sixWarning = '本批次套/箱为 6，调拨数量须为 6 的整数倍。';
  await sixForm.getByRole('button', { name: '录入并预锁定', exact: true }).click();
  await sixForm.getByRole('alert').filter({ hasText: sixWarning }).waitFor();
  assert.equal(allocationRequests.length, 1);
  assert.equal(await sixForm.locator('input[type="number"]').inputValue(), '8');
  await sixForm.locator('input[type="number"]').fill('12');
  await sixForm.getByRole('button', { name: '录入并预锁定', exact: true }).click();
  await sixForm.getByRole('status').waitFor();
  assert.equal(allocationRequests.length, 2);
  assert.equal(allocationRequests[1].sourceBatchKey, batch6.batchKey);
  assert.equal(Object.hasOwn(allocationRequests[1], 'packPerBox'), false);
  assert.equal(db.db.prepare('SELECT quantity FROM allocation_documents ORDER BY id DESC LIMIT 1').get().quantity, 12);
  check('同型号套/箱6的批次按自身基数拒绝8并允许12');

  for (const [batch, operator] of [[missing, 'ui-pack-missing'], [invalid, 'ui-pack-invalid']]) {
    const form = await openAllocation(batch);
    await fillAllocation(form, { quantity: 4, operator });
    const warning = '本批次套/箱未维护或不是正整数，请补齐后再调拨。';
    await form.getByRole('alert').filter({ hasText: warning }).waitFor();
    await form.getByRole('button', { name: '录入并预锁定', exact: true }).click();
    assert.equal(allocationRequests.length, 2);
    assert.equal(db.db.prepare('SELECT id FROM allocation_documents WHERE operator_name = ?').get(operator), undefined);
  }
  check('缺失和无效套/箱均提示补齐并阻止运营调拨');

  await page.getByRole('button', { name: '询库', exact: true }).click();
  const inquiry = page.getByRole('dialog');
  await inquiry.getByLabel('询库数量（必填）', { exact: true }).fill('5');
  for (const [label, value] of Object.entries({ '询库店铺（必填）': 'AUS', '询库运营（必填）': 'ui-inquiry-pack', 'ASIN（必填）': 'BPACK00002', 'FNSKU（必填）': 'XPACK00002' })) {
    await inquiry.getByLabel(label, { exact: true }).fill(value);
  }
  await inquiry.getByRole('button', { name: '提交询库', exact: true }).click();
  await inquiry.waitFor({ state: 'hidden' });
  assert.equal(db.db.prepare("SELECT requested_quantity FROM inquiry_documents WHERE operator_name='ui-inquiry-pack'").get().requested_quantity, 5);
  assert.equal(allocationRequests.length, 2);
  check('询库表单仍可按旧规则提交数量5');

  const approvalModel = model;
  const approvalBatch4 = await receive({ model: approvalModel, plan: 'UI-APPROVAL-PACK4', quantity: 16, pack: '4' });
  const approvalBatch6 = await receive({ model: approvalModel, plan: 'UI-APPROVAL-PACK6', quantity: 18, pack: '6' });
  const approvalMissing = await receive({ model: approvalModel, plan: 'UI-APPROVAL-PACK-MISSING', quantity: 16, pack: '4' });
  db.db.prepare('UPDATE stock_batches SET pack_per_box = NULL WHERE batch_key = ?').run(approvalMissing.batchKey);
  const approvalInvalid = await receive({ model: approvalModel, plan: 'UI-APPROVAL-PACK-INVALID', quantity: 16, pack: '4' });
  db.db.prepare("UPDATE stock_batches SET pack_per_box = '0' WHERE batch_key = ?").run(approvalInvalid.batchKey);
  const adminFour = await createAdminAllocation(approvalBatch4, 5, 'approval-ui-admin-four');
  const adminSix = await createAdminAllocation(approvalBatch6, 5, 'approval-ui-admin-six');
  const adminMissing = await createAdminAllocation(approvalMissing, 5, 'approval-ui-admin-missing');
  const adminInvalid = await createAdminAllocation(approvalInvalid, 5, 'approval-ui-admin-invalid');
  const pendingInquiry = db.db.prepare("SELECT id FROM inquiry_documents WHERE operator_name = 'ui-inquiry-pack'").get();
  assert.ok(pendingInquiry);

  const businessPage = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  businessPage.setDefaultTimeout(10000);
  businessPage.on('request', request => {
    if (request.method() === 'POST' && /^\/api\/(allocations|inquiries)\/\d+\/review$/.test(new URL(request.url()).pathname)) {
      reviewRequests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    }
  });
  businessPage.on('pageerror', error => pageErrors.push(error.message));
  await businessPage.addInitScript(() => sessionStorage.setItem('aster-current-role', 'business'));
  await businessPage.goto(`${base}/?q=${encodeURIComponent(approvalModel)}&model=${encodeURIComponent(approvalModel)}`);
  await businessPage.getByRole('button', { name: '审批中心', exact: true }).click();
  const approvalGroup = businessPage.locator(`tbody.approval-model-group[data-model="${approvalModel}"]`);
  await approvalGroup.getByRole('button', { name: `展开 ${approvalModel}`, exact: true }).click();
  const allocationRow = id => businessPage.locator(`tbody.approval-record[data-document-key="allocation-${id}"]`);
  const fourRecord = allocationRow(adminFour.id);
  const reviewFourForm = fourRecord.locator('.approval-review-form');
  const fourPackField = reviewFourForm.getByLabel('套/箱', { exact: true });
  await fourPackField.waitFor();
  assert.equal(await fourPackField.inputValue(), '4');
  assert.equal(await fourPackField.evaluate(element => element.readOnly), true);
  await reviewFourForm.getByLabel('审核数量', { exact: true }).fill('7');
  await reviewFourForm.getByRole('button', { name: '批准', exact: true }).click();
  await fourRecord.getByRole('alert').filter({ hasText: '来源批次套/箱为 4，审核数量须为 4 的整数倍。' }).waitFor();
  assert.equal(reviewRequests.length, 0);
  assert.equal(await reviewFourForm.getByLabel('审核数量', { exact: true }).inputValue(), '7');
  await reviewFourForm.getByLabel('审核数量', { exact: true }).fill('5.5');
  await reviewFourForm.getByRole('button', { name: '批准', exact: true }).click();
  await fourRecord.getByRole('alert').filter({ hasText: '审核数量请填写大于 0 的整数' }).waitFor();
  assert.equal(reviewRequests.length, 0);
  assert.equal(db.db.prepare('SELECT approval_status FROM allocation_documents WHERE id = ?').get(adminFour.id).approval_status, 'pending');
  check('商务调拨审核表单按来源批次展示只读套/箱，非倍数和非整数在点击批准前被拦截且保留数量');

  await reviewFourForm.getByLabel('审核数量', { exact: true }).fill('16');
  await reviewFourForm.getByRole('button', { name: '批准', exact: true }).click();
  await reviewFourForm.waitFor({ state: 'detached' });
  assert.equal(reviewRequests.length, 1);
  assert.equal(db.db.prepare('SELECT quantity FROM allocation_documents WHERE id = ?').get(adminFour.id).quantity, 16);
  assert.equal(db.db.prepare("SELECT SUM(locked_delta) AS delta FROM inventory_ledger WHERE document_id = ? AND entry_type='review_adjustment'").get(adminFour.id).delta, 11);
  assert.equal(db.getBalance(approvalBatch4.batchKey).available, 0);
  check('商务可将管理员提交的申请5增至16（增加部分等于剩余可用11）并正确调整库存锁定');

  const sixRecord = allocationRow(adminSix.id);
  const reviewSixForm = sixRecord.locator('.approval-review-form');
  assert.equal(await reviewSixForm.getByLabel('套/箱', { exact: true }).inputValue(), '6');
  await reviewSixForm.getByLabel('审核数量', { exact: true }).fill('8');
  await reviewSixForm.getByRole('button', { name: '批准', exact: true }).click();
  await sixRecord.getByRole('alert').filter({ hasText: '来源批次套/箱为 6，审核数量须为 6 的整数倍。' }).waitFor();
  assert.equal(reviewRequests.length, 1);
  await reviewSixForm.getByLabel('审核数量', { exact: true }).fill('12');
  await reviewSixForm.getByRole('button', { name: '批准', exact: true }).click();
  await reviewSixForm.waitFor({ state: 'detached' });
  assert.equal(reviewRequests.length, 2);
  assert.equal(db.db.prepare('SELECT quantity FROM allocation_documents WHERE id = ?').get(adminSix.id).quantity, 12);
  check('同型号不同批次在商务审核中分别使用4和6的来源规格');

  const missingRecord = allocationRow(adminMissing.id);
  const missingForm = missingRecord.locator('.approval-review-form');
  assert.equal(await missingForm.getByLabel('套/箱', { exact: true }).inputValue(), '未维护');
  await missingForm.getByLabel('审核数量', { exact: true }).fill('4');
  await missingForm.getByRole('button', { name: '批准', exact: true }).click();
  await missingRecord.getByRole('alert').filter({ hasText: '来源批次套/箱未维护或不是正整数，请补齐后再批准。' }).waitFor();
  assert.equal(reviewRequests.length, 2);
  await missingForm.getByRole('button', { name: '拒绝', exact: true }).click();
  await missingForm.waitFor({ state: 'detached' });
  assert.equal(reviewRequests.length, 3);
  assert.equal(reviewRequests[2].body.decision, 'reject');
  assert.equal(db.db.prepare('SELECT approval_status FROM allocation_documents WHERE id = ?').get(adminMissing.id).approval_status, 'rejected');
  const invalidRecord = allocationRow(adminInvalid.id);
  const invalidForm = invalidRecord.locator('.approval-review-form');
  assert.equal(await invalidForm.getByLabel('套/箱', { exact: true }).inputValue(), '0');
  await invalidForm.getByLabel('审核数量', { exact: true }).fill('4');
  await invalidForm.getByRole('button', { name: '批准', exact: true }).click();
  await invalidRecord.getByRole('alert').filter({ hasText: '来源批次套/箱未维护或不是正整数，请补齐后再批准。' }).waitFor();
  assert.equal(reviewRequests.length, 3);
  check('缺失或无效套/箱时商务页面阻止批准但允许拒绝');

  const inquiryRecord = businessPage.locator(`tbody.approval-record[data-document-key="inquiry-${pendingInquiry.id}"]`);
  const inquiryForm = inquiryRecord.locator('.approval-review-form');
  assert.equal(await inquiryForm.getByLabel('套/箱', { exact: true }).count(), 0);
  await inquiryForm.getByLabel('审核数量', { exact: true }).fill('5');
  await inquiryForm.getByRole('button', { name: '批准', exact: true }).click();
  await inquiryForm.waitFor({ state: 'detached' });
  assert.equal(reviewRequests.length, 4);
  assert.equal(new URL(`http://localhost${reviewRequests[3].path}`).pathname, `/api/inquiries/${pendingInquiry.id}/review`);
  assert.equal(db.db.prepare('SELECT approved_quantity FROM inquiry_documents WHERE id = ?').get(pendingInquiry.id).approved_quantity, 5);
  check('调拨和询库混合审批时询库无套/箱字段且数量5仍可批准');
  await businessPage.close();

  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM allocation_documents WHERE operator_name LIKE 'ui-pack-%'").get().n, 2);
  assert.deepEqual(pageErrors, []);
  db.assertInventoryInvariants();
  assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
  check('页面交互结束后库存恒等式与外键保持一致');
} catch (error) {
  failure = error.stack;
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await browser?.close();
  db.close();
  server.kill();
  if (server.exitCode === null) await once(server, 'exit');
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ state, base, checks, allocationRequests, pageErrors, failure }, null, 2));
}

console.log(`ALLOCATION_PACK_MULTIPLES_PAGE_PASS ${checks.length}`);
