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
    assert.equal(await dialog.getByRole('alert').innerText(), '本次操作结果尚未确认，请点击“重试确认”。');
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
  await fields(allocation, { '调拨数量': '5', '调拨店铺': 'AUDITUS', '调拨运营': 'allocation-damaged', 'FNSKU': 'XALLOC001', 'ASIN（必填）': 'BALLOC001' });
  await allocation.getByRole('button', { name: '提交调拨', exact: true }).click();
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

  await openModel();
  await page.locator('.alloc-toggle').first().click();
  await fields(allocation, { '调拨数量': '1', '调拨店铺': 'AUDITUS', '调拨运营': 'allocation-refresh-failed', 'FNSKU': 'XALLOC002', 'ASIN（必填）': 'BALLOC002' });
  let allocationRefreshFailed = false;
  const failAllocationRead = route => allocationRefreshFailed
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '隔离调拨刷新失败' }) })
    : route.continue();
  await page.route('**/api/allocations?*', failAllocationRead);
  await page.route('**/api/inventory/catalog', failAllocationRead);
  await page.route('**/api/allocations', async route => {
    const response = await route.fetch(); assert.equal(response.status(), 200);
    allocationRefreshFailed = true; await route.fulfill({ response });
  });
  await allocation.getByRole('button', { name: '提交调拨', exact: true }).click();
  await allocation.getByText('调拨已提交，库存已锁定，待商务审核。 页面刷新失败，请刷新页面。', { exact: true }).waitFor();
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM allocation_documents WHERE operator_name='allocation-refresh-failed'").get().n, 1);
  assert.equal(await allocation.getByRole('button', { name: '重试确认', exact: true }).count(), 0);
  allocationRefreshFailed = false;
  await page.unroute('**/api/allocations?*'); await page.unroute('**/api/inventory/catalog'); await page.unroute('**/api/allocations');
  check('调拨已保存后查询失败仍显示成功和刷新失败，不误报未确认或提供重复提交重试');

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

  // 以下故障只拦截本次隔离服务器的请求，不连接正式库或领星。
  const nav = name => page.locator('.sidebar .nav-item', { hasText: name }).click();
  const role = name => page.getByLabel('切换当前操作角色').selectOption(name);
  const expand = async () => { for (const button of await page.locator('.approval-expand[aria-expanded="false"]').all()) await button.click(); };
  const row = no => page.locator(`.approval-record[data-document-no="${no}"]`);
  const notice = text => page.locator('.notice-text').getByText(text, { exact: true }).waitFor();
  const current = db.getInquiry(db.db.prepare("SELECT id FROM inquiry_documents WHERE operator_name='corrected-rejection'").get().id);
  await role('business'); await nav('审批中心'); await page.locator('.approval-expand').first().waitFor(); await expand();
  let failRefresh = false;
  await page.route('**/api/approvals', route => failRefresh
    ? route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'隔离测试查询失败'})})
    : route.continue());
  await page.route(`**/api/inquiries/${current.id}/review`, async route => {
    const result = await route.fetch(); assert.equal(result.status(), 200); failRefresh = true;
    await route.fulfill({response:result});
  });
  await row(current.documentNo).getByRole('button', {name:'批准',exact:true}).click();
  await notice(`${current.documentNo} 已批准 2 件。 页面刷新失败，请刷新页面。`);
  assert.equal(db.getInquiry(current.id).status, 'pending_purchasing');
  assert.equal(await row(current.documentNo).getByRole('button',{name:'重试确认',exact:true}).count(),0);
  check('审核已保存但审批查询失败时保留成功结果，并明确提示刷新失败');
  failRefresh=false; await page.unroute('**/api/approvals'); await page.unroute(`**/api/inquiries/${current.id}/review`);

  await role('alan'); await page.reload(); await nav('审批中心'); await page.locator('.approval-expand').first().waitFor(); await expand();
  await row(current.documentNo).getByLabel('供应商库存回复',{exact:true}).fill('0');
  await row(current.documentNo).getByRole('button',{name:'保存回复',exact:true}).click();
  await notice('已回复 0 件，询库已拒绝。'); assert.equal(db.getInquiry(current.id).status,'rejected');
  check('Alan回复0件显示已拒绝，保留0件且不误报待采购归档');

  let positive=db.createInquiry({role:'operation-1',model:'SYNTH-TONER-001',quantity:5,department:'一团',store:'COPYUS',operator:'合成文案验证',fnsku:'XCOPY00001',asin:'BCOPY00001',requestId:crypto.randomUUID()}).record;
  positive=db.reviewInquiry({id:positive.id,role:'business',decision:'approve',approvedQuantity:5,expectedRevision:positive.revision,requestId:crypto.randomUUID()}).record;
  await page.reload(); await nav('审批中心'); await page.locator('.approval-expand').first().waitFor(); await expand();
  await row(positive.documentNo).getByLabel('供应商库存回复',{exact:true}).fill('5');
  await row(positive.documentNo).getByLabel('发货仓库',{exact:true}).selectOption('CA');
  await row(positive.documentNo).getByRole('button',{name:'保存回复',exact:true}).click();
  await notice('已回复 5 件，待采购归档。'); assert.equal(db.getInquiry(positive.id).status,'pending_procurement');
  await role('purchasing'); await page.locator('.approval-expand').first().waitFor(); await expand();
  await row(positive.documentNo).getByRole('button',{name:'采购归档',exact:true}).click();
  const archive=page.getByRole('dialog');
  await fields(archive,{'发货计划号':'SYNTH-COPY-PLAN','发货日期':'2026-09-30','原版本号':'V1'});
  await archive.getByRole('button',{name:'确认归档',exact:true}).click();
  await notice('询库已归档。'); assert.equal(db.getInquiry(positive.id).status,'archived');
  check('正数回复显示待采购归档，归档弹窗保存后显示询库已归档');

  const hide=()=>page.getByRole('button',{name:'隐藏已完成/已拒绝询库',exact:true});
  const terminal=db.db.prepare("SELECT COUNT(*) n FROM inquiry_documents WHERE status IN ('archived','rejected') AND hidden_at IS NULL").get().n;
  await role('admin'); await page.getByLabel('搜索型号、单号、运营或 ASIN').fill('没有匹配的搜索词');
  await hide().click(); await notice(`已隐藏 ${terminal} 张询库单。`);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM inquiry_documents WHERE status IN ('archived','rejected') AND hidden_at IS NULL").get().n,0);
  await hide().click(); await notice('没有可隐藏的询库单。');
  assert.equal(await page.locator('.notice-warning').count(),1);
  check('无搜索结果仍隐藏权限内全部办结询库，重复操作0张显示无变化');
  await page.route('**/api/inquiries/clear',route=>route.abort('failed'));
  await hide().click(); await notice('隐藏结果尚未确认，请刷新审批中心查看。');
  await page.unroute('**/api/inquiries/clear');
  await page.route('**/api/inquiries/clear',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({ok:false,error:'隔离权限拒绝'})}));
  await hide().click(); await notice('隔离权限拒绝'); await page.unroute('**/api/inquiries/clear');
  check('隐藏请求中断与明确403拒绝分别展示未确认和具体拒绝原因');

  let additional=db.createInquiry({role:'operation-1',model:'SYNTH-TONER-001',quantity:1,department:'一团',store:'COPYUS',operator:'合成未回复',fnsku:'XCOPY00002',asin:'BCOPY00002',requestId:crypto.randomUUID()}).record;
  additional=db.reviewInquiry({id:additional.id,role:'business',decision:'reject',expectedRevision:additional.revision,requestId:crypto.randomUUID()}).record;
  failRefresh=false;
  await page.route('**/api/approvals',route=>failRefresh?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'隔离刷新失败'})}):route.continue());
  await page.route('**/api/inquiries/clear',async route=>{const result=await route.fetch();assert.equal(result.status(),200);failRefresh=true;await route.fulfill({response:result});});
  await hide().click(); await notice('已隐藏 1 张询库单。 页面刷新失败，请刷新页面。');
  assert.ok(db.getInquiry(additional.id).hiddenAt);
  failRefresh=false; await page.unroute('**/api/approvals'); await page.unroute('**/api/inquiries/clear');
  check('隐藏成功后刷新失败仍准确报告隐藏1张，不误报操作失败');

  await nav('升级库存'); await page.getByRole('tab',{name:'询库备份',exact:true}).click();
  const backup=no=>page.locator('.upgrade-history-card').filter({has:page.locator('strong',{hasText:no})});
  await backup(additional.documentNo).getByText('供应商回复：未回复；店铺：COPYUS；已隐藏',{exact:true}).waitFor();
  await backup(current.documentNo).locator('summary').click();
  assert.match(await backup(current.documentNo).innerText(),/备份 · Alan/);
  assert.match(await backup(current.documentNo).innerText(),/备份 · 管理员/);
  await role('purchasing'); await page.getByRole('tab',{name:'询库备份',exact:true}).click();
  await page.route(`**/api/inquiries/${positive.id}/recall`,async route=>{const result=await route.fetch();assert.equal(result.status(),200);await route.abort('failed');});
  await backup(positive.documentNo).getByRole('button',{name:'重新回复库存',exact:true}).click();
  await page.getByRole('alert').getByText('处理结果尚未确认，请刷新询库备份查看。',{exact:true}).waitFor();
  assert.equal(db.getInquiry(positive.id).status,'pending_purchasing');
  await page.unroute(`**/api/inquiries/${positive.id}/recall`);
  check('备份区分未回复与0件、显示真实岗位，回撤丢回执提示刷新核对');
  await role('operation-2'); await page.getByRole('tab',{name:'询库备份',exact:true}).click(); await page.getByText('暂无询库备份。',{exact:true}).waitFor();
  await nav('审批中心'); await page.getByRole('button',{name:'本团处理中 0',exact:true}).click();
  await page.getByText('本团暂无处理中记录',{exact:true}).waitFor();
  check('无备份与运营本团无处理中记录显示对应空状态');

  // 提交前另一笔真实调拨改变可用量，成功提示必须使用本次接口的实际锁定量。
  await role('admin'); await nav('升级库存'); await page.getByRole('tab',{name:'在库升级',exact:true}).click();
  const directPanel=page.locator('.panel').filter({has:page.getByRole('heading',{name:'发起在库升级',exact:true})});
  const directVersion=allocationWrites[0].version;
  await directPanel.getByLabel('型号').selectOption('SYNTH-TONER-001');
  await directPanel.getByLabel('原版本号').selectOption(directVersion);
  const availableBefore=db.getUpgradeDashboard().directSources.find(s=>s.model==='SYNTH-TONER-001'&&s.sourceVersion===directVersion).available;
  let createdUpgrade;
  await page.route('**/api/upgrades/direct',async route=>{
    const other=await fetch(base+'/api/allocations',{method:'POST',headers:{'x-role':'admin','content-type':'application/json'},body:JSON.stringify({...allocationWrites[0],quantity:5,operator:'concurrent-before-upgrade',requestId:crypto.randomUUID()})});
    assert.equal(other.status,200,await other.text());
    const response=await route.fetch();assert.equal(response.status(),200);createdUpgrade=(await response.json()).upgrade;
    await route.fulfill({response});
  });
  await directPanel.getByRole('button',{name:/^锁定全部/}).click();
  await notice(`已锁定 ${(availableBefore-5).toLocaleString('en-US')} 件，待采购登记完成。`);
  assert.equal(createdUpgrade.initialQuantity,availableBefore-5);
  await page.unroute('**/api/upgrades/direct');
  check('实际提交前库存变化时，锁定成功提示使用接口数量而非页面旧值');

  await role('purchasing'); await page.getByRole('tab',{name:'在库升级',exact:true}).click();
  const directJob=page.locator('.upgrade-job').filter({hasText:createdUpgrade.upgradeNo});
  const fillDirect=async(quantity,version)=>{
    await directJob.getByLabel(createdUpgrade.upgradeNo+' 升级完成数量',{exact:true}).fill(String(quantity));
    await directJob.getByLabel(createdUpgrade.upgradeNo+' 升级完成版本号',{exact:true}).fill(version);
    await directJob.getByLabel(createdUpgrade.upgradeNo+' 目标海外仓',{exact:true}).selectOption('SyntheticWarehouseA');
  };
  await fillDirect(1,directVersion);
  await directJob.getByRole('button',{name:'登记完成并转入新版本',exact:true}).click();
  await notice('升级完成版本号必须与原版本不同');
  assert.equal(await directJob.getByLabel(createdUpgrade.upgradeNo+' 升级完成版本号',{exact:true}).isEnabled(),true);
  check('在库升级明确拒绝保留具体原因，并允许修改填写内容');

  const completePath=`**/api/upgrades/direct/${createdUpgrade.id}/complete`,completionWrites=[];
  let damageCompletion=true;
  await page.route(completePath,async route=>{
    completionWrites.push(route.request().postDataJSON());const response=await route.fetch();assert.equal(response.status(),200);
    if(damageCompletion){damageCompletion=false;await route.fulfill({status:200,contentType:'text/html',body:'<html>response unavailable</html>'});}
    else await route.fulfill({response});
  });
  await fillDirect(2,'COPY-UPGRADE');
  await directJob.getByRole('button',{name:'登记完成并转入新版本',exact:true}).click();
  await notice('本次操作结果尚未确认，请点击“重试确认”。');
  await directJob.getByRole('button',{name:'重试确认',exact:true}).click();
  await notice(`已登记 2 件升级完成：${directVersion} → COPY-UPGRADE。`);
  assert.deepEqual(completionWrites[1],completionWrites[0]);assert.equal(db.upgradeRecord(createdUpgrade.id).completedQuantity,2);
  await page.unroute(completePath);
  check('在库升级坏回执只显示一次重试提示，原请求重试后仍只完成2件');

  let failUpgradeRefresh=false;
  await page.route('**/api/upgrades',route=>failUpgradeRefresh?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'隔离升级刷新失败'})}):route.continue());
  await page.route(completePath,async route=>{const response=await route.fetch();assert.equal(response.status(),200);failUpgradeRefresh=true;await route.fulfill({response});});
  await fillDirect(3,'COPY-UPGRADE');
  await directJob.getByRole('button',{name:'登记完成并转入新版本',exact:true}).click();
  await notice(`已登记 3 件升级完成：${directVersion} → COPY-UPGRADE。 页面刷新失败，请刷新页面。`);
  assert.equal(db.upgradeRecord(createdUpgrade.id).completedQuantity,5);
  failUpgradeRefresh=false;await page.unroute('**/api/upgrades');await page.unroute(completePath);
  check('在库升级已保存后刷新失败，错误页面仍保留准确的完成结果');
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
