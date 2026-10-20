// Schema 37 acceptance: isolated synthetic database, owned server, actual Edge UI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { createInventoryDatabase, InventoryDatabase } from '../../inventory-db.mjs';
import { freePort, createTestInstanceId, waitForOwnedServer } from '../../scripts/test-server-ownership.mjs';
import { openRelocationSource } from '../../scripts/fixtures/relocation-page.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT || path.join(root, '.test-output/ink-workflow-v37/page'));
await fs.mkdir(out, { recursive: true });
const state = await fs.mkdtemp(path.join(out, 'state-'));
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite') });
const db = new InventoryDatabase(state), rid = () => crypto.randomUUID(), common = r => ({ expectedRevision: r.revision, requestId: rid() });
const port = await freePort(), base = `http://127.0.0.1:${port}`, instanceId = createTestInstanceId('ink-workflow-v37-page');
const checks = [], screenshots = [], errors = [], posts = [], layoutEvidence = [], copyEvidence = [];
let child, browser, page, failure;
const check = name => { checks.push(name); console.log('PASS ' + name); };
const rows = [{ sourceRow: 2, data: { model: 'SYNTH-INK-001', quantity: 4000, packPerBox: '10', fnsku: 'V37-SOURCE', shippingMethod: 'SyntheticWarehouseA', plan: 'V37-SOURCE', date: '2026-10-15', team: '一团', version: 'V37' } }];
const proof = { kind: 'import', role: 'purchasing', fileName: 'V37-墨盒.csv', fileHash: 'v37-synthetic-source', templateHash: 'v37-synthetic-template', payload: { rows } };
const previewToken = db.createTransitPreviewToken(proof).token;
const imported = db.transitImport({ ...proof, rows, previewToken, requestId: rid() }).rows[0];
const onShelf = db.markTransitOnShelf({ id: imported.id, role: 'assistant-1', yes: 'YES', ...common(imported) });
const batch = db.getCatalog({ visibleGroup: '一团' }).stockDetails['SYNTH-INK-001'].find(r => r.batchKey === onShelf.batchKey);
assert(batch, 'fixture must have a real one-team source batch');
function allocation(operator, approved = false) {
  let r = db.createAllocation({ role: 'operation-1', model: 'SYNTH-INK-001', sourceBatchKey: batch.batchKey, plan: batch.plan, date: batch.date, version: batch.version, quantity: 100, department: '一团', store: 'V37US', operator, fnsku: '000V37', asin: 'BINKPAGE37', requestId: rid() }).record;
  if (approved) r = db.reviewAllocation({ id: r.id, role: 'business', decision: 'approve', approvedQuantity: 80, businessNote: '商务原始80', ...common(r) }).record;
  return { kind: 'allocation', ...r };
}
function inquiry(operator) {
  let r = db.createInquiry({ role: 'operation-1', model: 'SYNTH-INK-001', quantity: 100, department: '一团', store: 'V37US', operator, fnsku: '000V37', asin: 'BINKPAGE37', requestId: rid() }).record;
  r = db.reviewInquiry({ id: r.id, role: 'business', decision: 'approve', approvedQuantity: 80, businessNote: '商务询库80', ...common(r) }).record;
  return { kind: 'inquiry', ...r };
}
const record = r => r.kind === 'allocation' ? db.getDocument(r.id) : db.getInquiry(r.id);
const row = r => page.locator(`[data-document-key="${r.kind}-${r.id}"]`);
const lock = r => db.db.prepare('SELECT coalesce(sum(locked_delta),0) n FROM inventory_ledger WHERE document_id=?').get(r.id).n;
const stock = r => db.db.prepare('SELECT coalesce(sum(on_hand_delta),0) n FROM inventory_ledger WHERE document_id=?').get(r.id).n;
const route = (r, action) => `/api/${r.kind === 'allocation' ? 'allocations' : 'inquiries'}/${r.id}/${action}`;
async function wait(fn) { let last; for (let i = 0; i < 100; i++) { try { return await fn(); } catch (e) { last = e; } await new Promise(r => setTimeout(r, 100)); } throw last; }
async function open(role, keyword = '') {
  const closeNotice = page.getByRole('button', { name: '关闭提示', exact: true }); if (await closeNotice.count()) await closeNotice.click();
  await page.getByLabel('切换当前操作角色', { exact: true }).selectOption(role);
  await page.locator('.sidebar .nav-item', { hasText: '审批中心' }).click();
  await page.getByLabel('按需求类型筛选', { exact: true }).selectOption('all');
  await page.getByLabel('筛选审批进度', { exact: true }).selectOption('all');
  const mine = page.getByRole('button', { name: ['operation-1','operation-2'].includes(role) ? /^处理中/ : /^我的待办/ }); if (await mine.getAttribute('aria-pressed') === 'true') await mine.click();
  await page.getByLabel('搜索编号、型号、运营或 ASIN', { exact: true }).fill(keyword);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForLoadState('networkidle');
  while (await page.locator('.approval-model-row[aria-expanded="false"]').count()) await page.locator('.approval-model-row[aria-expanded="false"]').first().click();
}
async function posted(r, action, button, status = 200) {
  const response = page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === route(r, action));
  await button.click(); const res = await response, result = await res.json(); assert.equal(res.status(), status, JSON.stringify(result)); return result;
}
async function fields(r, expected) { return wait(async () => { for (const [field, value] of Object.entries(expected)) assert.equal((field==='申请数量' ? await row(r).locator('[data-field="'+field+'"]').evaluate(el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()) : (await row(r).locator('[data-field="'+field+'"]').innerText()).trim()),value); }); }
async function shot(name) {
  const file = path.join(out, name + '.png'); await page.screenshot({ path: file, fullPage: true, animations: 'disabled' }); screenshots.push(file);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page must keep wide approval content inside its horizontal scroller');
}
async function reply(r, quantity, actor = 'purchasing') {
  await open(actor); await row(r).getByLabel('供应商库存回复', { exact: true }).fill(String(quantity));
  if (r.kind === 'inquiry') await row(r).getByLabel('发货仓库', { exact: true }).selectOption('CA');
  await row(r).getByLabel('采购备注', { exact: true }).fill('采购最终' + quantity);
  return posted(r, 'reply', row(r).getByRole('button', { name: '提交采购回复', exact: true }));
}
async function archive(r) {
  await row(r).getByRole('button', { name: '采购归档', exact: true }).click();
  if (r.kind === 'allocation') return;
  const dialog = page.getByRole('dialog'); await dialog.getByText(/全部实际发出/).waitFor();
  await dialog.getByLabel('发货计划号').fill('V37-NEW-PLAN'); await dialog.getByLabel('发货时间').fill('2026-10-15'); await dialog.getByLabel('原版本号').fill('V37-NEW');
  await posted(r, 'archive', dialog.getByRole('button', { name: '提交采购归档', exact: true })); await dialog.waitFor({ state: 'hidden' });
}
async function source(r, role) {
  await page.getByLabel('切换当前操作角色', { exact: true }).selectOption(role); await page.locator('.sidebar .nav-item', { hasText: '升级库存' }).click();
  await page.getByRole('tab', { name: '移仓升级', exact: true }).click();
  const sourceRow = page.locator(`[data-source-key="${r.kind}:${r.id}"]`); await openRelocationSource(page, sourceRow);
  return page.locator(`[data-relocation-source-detail="${r.kind}:${r.id}"]`);
}
try {
  const normal = allocation('V37正常'), zero = allocation('V37Alan零', true), reject = allocation('V37独立拒绝', true), timeout = allocation('V37超时', true), convert = allocation('V37转换接受'), decline = allocation('V37转换不接受');
  const skip = inquiry('V37跳过草稿'), alanZero = inquiry('V37询库Alan零');
  const legacy = allocation('V37旧采购链', true);
  db.db.prepare("UPDATE allocation_documents SET ink_workflow_stage=NULL,alan_deadline_at=NULL,procurement_status='pending_purchasing' WHERE id=?").run(legacy.id);
  db.db.prepare('UPDATE allocation_documents SET alan_deadline_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), timeout.id);
  child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, ASTER_STATE_ROOT: state, HOST: '127.0.0.1', PORT: String(port), PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId } });
  await waitForOwnedServer({ base, child, instanceId });
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' }); page.setDefaultTimeout(12000);
  page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.method() === 'POST') posts.push({ path: new URL(r.url()).pathname, body: r.postDataJSON() }); }); await page.goto(base);

  await open('business', normal.operator); await row(normal).getByLabel('审核数量', { exact: true }).fill('80'); await row(normal).getByLabel('商务备注', { exact: true }).fill('商务原始80');
  await posted(normal, 'review', row(normal).getByRole('button', { name: '批准', exact: true }));
  await wait(() => assert.equal(record(normal).inkWorkflowStage, 'pending_alan')); assert.equal(lock(normal), 80); assert(record(normal).alanDeadlineAt);
  const deadlineBefore = { deadline: record(normal).alanDeadlineAt, revision: record(normal).revision, locked: lock(normal) }, deadlinePosts = posts.length;
  for (const role of ['alan', 'business', 'purchasing', 'assistant-1', 'operation-1']) {
    await open(role, normal.operator);
    const response = await fetch(base + '/api/approvals', { headers: { 'x-role': role } }); assert.equal(response.status, 200);
    const current = (await response.json()).allocations.find(r => r.id === normal.id); assert(current, role + ' must see the pending Alan allocation');
    assert.equal(current.alanDeadlineAt, deadlineBefore.deadline);
    const time = await page.evaluate(value => new Date(value).toLocaleString('zh-CN', { hour12: false }), current.alanDeadlineAt);
    const hint = row(normal).locator('[data-field="Alan审核截止"]'); await hint.scrollIntoViewIfNeeded(); assert(await hint.isVisible());
    const text = (await hint.innerText()).trim(); assert.equal(text, `截止：${time}。到期未提交则采用商务数量。`);
    const column = await hint.evaluate(element => { const cell = element.closest('td'), index = Array.from(cell.parentElement.children).indexOf(cell); return cell.closest('table').querySelector('thead tr').children[index].textContent.trim(); });
    assert.equal(column, 'Alan备注', 'the shortened deadline must remain within the Alan column');
    assert.equal(await row(normal).getByLabel('Alan审核数量', { exact: true }).count(), role === 'alan' ? 1 : 0);
    assert.equal(await row(normal).locator('.form-hint').evaluateAll(elements => elements.filter(element => !element.textContent.trim()).length), 0, 'no empty hint containers');
    assert.deepEqual({ deadline: record(normal).alanDeadlineAt, revision: record(normal).revision, locked: lock(normal) }, deadlineBefore, 'viewing shortened hints must not change deadline, revision or lock');
    copyEvidence.push({ role, text, column, ...deadlineBefore });
    if (role !== 'alan') await shot('deadline-readonly-' + role);
  }
  assert.equal(posts.length, deadlinePosts, 'viewing deadline hints must not submit a business operation');
  await open('alan', normal.operator); await row(normal).getByLabel('Alan备注', { exact: true }).fill('Alan独立60'); const count = posts.length;
  await row(normal).getByRole('button', { name: '提交Alan审核', exact: true }).click(); await row(normal).getByText('请填写Alan审核数量', { exact: true }).waitFor(); assert.equal(posts.length, count);
  await row(normal).getByLabel('Alan审核数量', { exact: true }).fill('60'); await page.locator('.sidebar .nav-item', { hasText: '库存汇总' }).click(); await open('alan', normal.operator);
  assert.equal(await row(normal).getByLabel('Alan审核数量', { exact: true }).inputValue(), '60'); await row(normal).locator('[data-field="Alan审核截止"]').waitFor();
  for (const width of [1366, 1440]) { await page.setViewportSize({ width, height: 1000 }); await row(normal).getByLabel('Alan备注', { exact: true }).scrollIntoViewIfNeeded(); await shot('alan-deadline-' + width); }
  await posted(normal, 'alan-review', row(normal).getByRole('button', { name: '提交Alan审核', exact: true })); await wait(() => assert.equal(record(normal).inkWorkflowStage, 'pending_assistant')); assert.equal(lock(normal), 60);
  await fields(normal, { '申请数量': '100', '商务审核数量': '80', '商务备注': '商务原始80', 'Alan审核数量': '60', 'Alan备注': 'Alan独立60' }); assert.match(await row(normal).locator('[data-field="最终执行数量"]').innerText(), /60[\s\S]*采用 Alan/);
  for (const role of ['purchasing', 'logistics', 'assistant-2']) { await open(role); assert.equal(await row(normal).getByRole('button', { name: '确认全部发出', exact: true }).count(), 0); assert.equal(await row(normal).getByRole('button', { name: '提交Alan审核', exact: true }).count(), 0); }
  await open('assistant-1', normal.operator); await row(normal).getByRole('button', { name: '确认全部发出', exact: true }).click(); const confirmDialog = page.getByRole('dialog'); assert.equal(await confirmDialog.locator('input').count(), 0); await shot('assistant-confirm-all');
  await posted(normal, 'confirm', confirmDialog.getByRole('button', { name: '确认全部发出', exact: true })); await wait(() => assert.equal(record(normal).inkWorkflowStage, 'completed')); assert.equal(lock(normal), 0); assert.equal(stock(normal), -60);
  check('新调拨100→商务80→Alan60，草稿不生效/只备注不能交，助理整单确认且采购物流无新链入口');

  await open('alan', zero.operator); await row(zero).getByLabel('Alan审核数量', { exact: true }).fill('0'); await posted(zero, 'alan-review', row(zero).getByRole('button', { name: '提交Alan审核', exact: true })); assert.equal(record(zero).inkWorkflowStage, 'rejected'); assert.equal(record(zero).alanQuantity, 0); assert.equal(lock(zero), 0);
  await open('alan', reject.operator); assert.equal(await row(reject).getByLabel('Alan审核数量', { exact: true }).inputValue(), ''); await posted(reject, 'alan-review', row(reject).getByRole('button', { name: '拒绝调拨', exact: true })); assert.equal(record(reject).inkWorkflowStage, 'rejected'); assert.equal(lock(reject), 0);
  await open('alan', timeout.operator); await wait(() => assert.equal(record(timeout).inkWorkflowStage, 'pending_assistant')); assert.equal(record(timeout).alanQuantity, null); assert.equal(await row(timeout).getByRole('button', { name: '提交Alan审核', exact: true }).count(), 0); assert.match(await row(timeout).locator('[data-field="最终执行数量"]').innerText(), /80[\s\S]*5h 到期采用商务/); await shot('timeout-business-adopted');
  check('Alan0与独立空数量拒绝均释放全锁；无浏览器时到期采用商务且截止后只读');

  for (const r of [convert, decline]) {
    await open('business', r.operator); await row(r).getByLabel('审核数量', { exact: true }).fill('75'); await row(r).getByLabel('商务备注', { exact: true }).fill('商务转换75'); await posted(r, 'transfer-inquiry', row(r).getByRole('button', { name: '转询库', exact: true }));
    assert.equal(lock(r), 0); assert.equal(record(r).inkWorkflowStage, 'pending_conversion_confirmation'); assert.equal(db.db.prepare('SELECT count(*) n FROM inquiry_documents WHERE source_allocation_id=?').get(r.id).n, 0);
    const request = posts.findLast(p => p.path === route(r, 'transfer-inquiry')).body; assert.equal(request.approvedQuantity, 75); assert(!('transferInquiryQuantity' in request));
  }
  await open('operation-1', convert.operator); await fields(convert, { '申请数量': '100', '商务审核数量': '75' }); assert.match(await row(convert).innerText(), /转询库，待运营确认/); assert.match(await page.locator('.approval-model-row [data-field="申请数量合计"]').innerText(), /^75/);
  const demandTooltip = await page.locator('.approval-model-row [data-field="申请数量合计"]').getAttribute('title');
  assert.equal(demandTooltip, '待运营确认的转询库按商务数量计入，原调拨申请量仅留作历史。'); copyEvidence.push({ field: '申请数量合计', tooltip: demandTooltip });
  await shot('conversion-pending-operation');
  const positions = await row(convert).evaluate(element => { const bounds = field => { const range = document.createRange(); range.selectNodeContents(element.querySelector(`[data-field="${field}"]`)); const r = range.getBoundingClientRect(); return { left: r.left, right: r.right }; }; return { business: bounds('商务审核数量'), final: bounds('最终执行数量') }; });
  assert(positions.final.left - positions.business.right >= 16, 'business and final quantity text must be visibly separated'); layoutEvidence.push(positions);
  await open('operation-2', convert.operator); assert.equal(await page.getByRole('button', { name: '接受转询库', exact: true }).count(), 0);
  await open('operation-1', convert.operator); await posted(convert, 'conversion-decision', row(convert).getByRole('button', { name: '接受转询库', exact: true }));
  const convertedId = db.db.prepare('SELECT id FROM inquiry_documents WHERE source_allocation_id=?').get(convert.id).id, converted = { kind: 'inquiry', ...db.getInquiry(convertedId) };
  assert.equal(converted.sourceOriginalRequestedQuantity,100); assert.equal(converted.status, 'pending_purchasing'); assert.equal(converted.alanQuantity, null); assert.equal(converted.alanNote, null); assert.equal(converted.originalRequestedQuantity, 75); assert.equal(converted.businessReviewedQuantity, 75);
  await wait(async () => { assert.equal(await row(converted).count(), 1); assert.equal((await page.locator('.approval-model-row [data-field="申请数量合计"]').innerText()).trim(), '75'); });
  await row(convert).getByRole('button', { name: /^查看承接询库/ }).click(); const linkedDialog = page.getByRole('dialog', { name: '询库详情 · ' + converted.documentNo, exact:true }); await linkedDialog.waitFor(); assert.match(await linkedDialog.innerText(), /75/); assert.equal(await row(convert).count(), 1); await linkedDialog.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  await open('operation-1', decline.operator); await posted(decline, 'conversion-decision', row(decline).getByRole('button', { name: '不接受', exact: true })); assert.equal(record(decline).inkWorkflowStage, 'rejected'); assert.equal(lock(decline), 0); assert.equal(db.db.prepare('SELECT count(*) n FROM inquiry_documents WHERE source_allocation_id=?').get(decline.id).n, 0);
  await reply(converted, 65); await fields(converted, { '申请数量': '75', '商务审核数量': '75', '供应商库存回复': '65' }); await archive(converted); assert.equal(stock(convert), 0); assert.equal(db.getInquiry(converted.id).plan, 'V37-NEW-PLAN');
  await open('purchasing', convert.operator); const clearing = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/approvals/inquiries/clear');
  await page.getByRole('button', { name: '清空询库列表', exact: true }).click(); assert.equal((await clearing).status(), 200); await wait(async () => assert.equal(await row(converted).count(), 0));
  await open('business', convert.operator); assert.equal(await row(convert).getByRole('button',{name:/^查看承接询库/}).count(),1); await row(convert).getByRole('button',{name:/^查看承接询库/}).click(); const hiddenDialog=page.getByRole('dialog',{name:'询库详情 · '+converted.documentNo,exact:true}); await hiddenDialog.waitFor(); assert.match(await hiddenDialog.innerText(), /65/); assert.equal(db.db.prepare('SELECT approval_hidden FROM inquiry_documents WHERE id=?').get(converted.id).approval_hidden,1); await shot('conversion-hidden-association'); await hiddenDialog.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  check('商务同次提交B75并释放原100预锁；本团运营接受才建唯一75询库直采购，不接受不建单；统计不重复且原阶段量不被采购65覆写');

  await open('alan', skip.operator); await row(skip).getByLabel('Alan审核数量', { exact: true }).fill('70'); await row(skip).getByLabel('Alan备注', { exact: true }).fill('未提交不可携带');
  await reply(skip, 60, 'logistics'); for (const field of ['alanQuantity', 'alanNote', 'alanReviewedByRole', 'alanReviewedAt']) assert.equal(record(skip)[field], null);
  await fields(skip, { '申请数量': '100', '商务审核数量': '80', 'Alan审核数量': '—', 'Alan备注': '—', '供应商库存回复': '60' });
  await open('alan', alanZero.operator); await row(alanZero).getByLabel('Alan审核数量', { exact: true }).fill('0'); await posted(alanZero, 'alan-review', row(alanZero).getByRole('button', { name: '提交Alan审核', exact: true })); assert.equal(record(alanZero).status, 'pending_purchasing'); await reply(alanZero, 0); assert.equal(record(alanZero).status, 'rejected');
  await open('purchasing', skip.operator); const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出询库', exact: true }).click(); const file = path.join(out, 'skip-alan.xlsx'); await (await download).saveAs(file);
  const exported = JSON.parse(execFileSync(process.env.ASTER_TEST_PYTHON || 'python', [path.join(root, 'scripts/fixtures/read-inquiry-export.py'), file], { encoding: 'utf8', windowsHide: true }));
  assert.equal(exported.maxColumn, 13); const exportedRow = exported.rows.find(r => r[9] === skip.operator); assert.equal(exportedRow[1], 80); assert.equal(exportedRow[2], null); assert.equal(exportedRow[3], null); assert.equal(exportedRow[4], 60);
  check('物流即时跳过未提交Alan草稿，四字段NULL，采购与商务量分离，13列Excel空值真实；询库Alan0不拒绝但采购0拒绝');

  for (const role of ['purchasing', 'logistics']) { const detail = await source(normal, role); assert.equal(await detail.getByRole('button', { name: /^回撤至/ }).count(), 0); }
  const detail = await source(normal, 'business'); await posted(normal, 'recall', detail.getByRole('button', { name: '回撤至待商务审核', exact: true })); assert.equal(lock(normal), 100); assert.equal(stock(normal), 0);
  await reply(legacy, 60); await posted(legacy, 'archive', row(legacy).getByRole('button', { name: '采购归档', exact: true })); assert.equal(record(legacy).inkWorkflowStage, null); assert.equal(stock(legacy), -60);
  await open('business', normal.operator); await row(normal).getByLabel('审核数量', { exact: true }).fill('80'); await posted(normal, 'review', row(normal).getByRole('button', { name: '批准', exact: true }));
  await open('alan', normal.operator); await row(normal).getByLabel('Alan审核数量', { exact: true }).fill('60'); const sent = []; let lose = true;
  await page.route('**' + route(normal, 'alan-review'), async r => { sent.push(r.request().postDataJSON()); const response = await r.fetch(); if (lose) { lose = false; return r.abort('failed'); } return r.fulfill({ response }); });
  await row(normal).getByRole('button', { name: '提交Alan审核', exact: true }).click(); await row(normal).getByRole('button', { name: '重试确认', exact: true }).waitFor(); await page.reload();
  await page.getByLabel('切换当前操作角色', { exact: true }).selectOption('alan'); await page.getByRole('region', { name: '待确认业务提交' }).getByRole('button', { name: '确认本次提交', exact: true }).click(); await page.getByText(/原提交结果已确认/).waitFor(); assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]); await page.unroute('**' + route(normal, 'alan-review'));
  check('新完成调拨仅商务回撤原申请重锁，旧采购链仍能完成；新Alan丢回执刷新原键确认不重复办理');
  db.assertInventoryInvariants(); assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []); assert.deepEqual(errors, []);
} catch (error) { failure = error; console.error(error); if (page) await shot('failure').catch(() => {}); }
finally {
  await browser?.close(); db.close(); if (child?.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ state, base, checks, screenshots, layoutEvidence, copyEvidence, errors, exitCode: failure ? 1 : 0, failure: failure?.stack, productionWrites: 0, realLingxing: false }, null, 2));
}
if (failure) process.exitCode = 1;

