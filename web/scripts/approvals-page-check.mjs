/* 正式 React 审批页面验收：随机端口、隔离 SQLite；截图由 ASTER_UI_OUTPUT_DIR 指定。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createInventoryDatabase, InventoryDatabase, INVENTORY_DATABASE_NAME } from "../../inventory-db.mjs";
import { createTestInstanceId, waitForOwnedServer } from "../../scripts/test-server-ownership.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aster-approvals-ui-"));
const output = process.env.ASTER_UI_OUTPUT_DIR || path.join(root, ".test-output/approvals-page");
let server;
let browser;
let base;
let passed = 0;
const errors = [];
const storeValidationPosts = [];
const displayChecks = [];
const longNote = '调拨备注保留；请核对本次申请的型号、数量和店铺。备注需要完整显示，允许按页面宽度换行。'.repeat(3) + ' 连续编号：' + 'ABCDEFGHIJ1234567890'.repeat(5);
const requestId = (prefix) => `approval-ui-${prefix}-${crypto.randomUUID()}`;
const check = (name, condition) => { assert.ok(condition, name); passed += 1; console.log(`PASS ${name}`); };

async function api(method, route, role, body, status = 200) {
  const response = await fetch(base + route, { method, headers: { "x-role": role, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(result)}`);
  return result;
}

async function write(page, route, action) {
  const pending = page.waitForResponse((response) => new URL(response.url()).pathname === route && response.request().method() === "POST");
  await action();
  const response = await pending;
  const payload = await response.json();
  assert.equal(response.status(), 200, `${route}: ${JSON.stringify(payload)}`);
  return payload;
}

async function role(page, value) {
  const selector = page.locator('select[aria-label="切换当前操作角色"]');
  if (await selector.inputValue() === value) return;
  await selector.selectOption(value);
  await page.waitForFunction((expected) => document.querySelector('select[aria-label="切换当前操作角色"]')?.value === expected, value);
}

async function approvals(page) {
  await page.locator(".sidebar .nav-item", { hasText: "审批中心" }).click();
  await page.locator(".approval-page").waitFor();
  if (await page.getByRole("button", {name:/^我的待办/}).getAttribute("aria-pressed") === "true") await page.getByRole("button", {name:/^我的待办/}).click();
  await page.getByLabel("按需求类型筛选",{exact:true}).selectOption("all");
  await page.getByRole("group", { name: "按类目筛选", exact: true }).getByRole("button", { name: "全部类目", exact: true }).click();
  await page.getByLabel("搜索运营姓名、型号或 ASIN", { exact: true }).fill("");
  await page.getByLabel("筛选审批进度", { exact: true }).selectOption("all");
}

async function expand(page, model = "SYNTH-TONER-001") {
  const group=page.locator('.approval-model-group[data-model="'+model+'"]');
  await group.waitFor();
  const arrow=group.locator('.approval-expand');
  if(await arrow.getAttribute('aria-expanded')==='false')await arrow.click();
}

function record(page, documentNo) {
  return page.locator(`[data-document-no="${documentNo}"]`);
}

async function detailsText(row) { const group=row.locator('xpath=ancestor::tbody[contains(@class,"approval-model-group")]');if(await group.locator('.approval-expand').getAttribute('aria-expanded')==='false')await group.locator('.approval-expand').click();return row.innerText(); }

async function stock(page) {
  const result = await api("GET", "/api/allocations?model=SYNTH-TONER-001", "admin");
  return result.totals["SYNTH-TONER-001#TEST-PLAN-TONER#2026-02-10#V11"];
}

async function todo(page, count) {
  await page.waitForFunction(expected => [...document.querySelectorAll('.approval-toolbar button')].some(button => button.textContent.replace(/\s/g, '') === `我的待办${expected}`), count);
}

// 真实办理阶段的桌面摘要、详情和表单检查。
async function verifyApprovalDisplay(page, phase) {
  for (const width of [1280, 1366, 1920]) {
    await page.setViewportSize({width,height:1100});
    const result=await page.locator('.approval-page').evaluate(element=>({
      width:innerWidth,zoom:visualViewport.scale,pageWidth:document.documentElement.scrollWidth,
      role:document.querySelector('select[aria-label="切换当前操作角色"]')?.value,
      headers:[...element.querySelectorAll('.approval-summary-table > thead th')].map(e=>e.textContent),
      documentHeaders:[...element.querySelector('.approval-document-table').querySelectorAll('thead th')].map(e=>e.textContent),
      metrics:[...element.querySelectorAll('.approval-record')].filter(e=>e.getClientRects().length).map(e=>({count:e.querySelectorAll('.approval-metric-value').length,columnCount:e.querySelectorAll('.approval-data-row > td').length,colSpan:e.querySelector('.approval-action-row > td')?.colSpan,ys:[...e.querySelectorAll('.approval-data-row > td')].map(f=>f.getBoundingClientRect().y)})),
      tableScroll:[...element.querySelectorAll('.approval-table-scroll')].filter(e=>e.getClientRects().length).every(e=>getComputedStyle(e).overflowX==='auto' && (e.clientWidth>=(['assistant-1','assistant-2','purchasing'].includes(document.querySelector('select[aria-label="切换当前操作角色"]')?.value)?2700:2890) || e.scrollWidth>e.clientWidth)),
      clipped:[...element.querySelectorAll('.approval-row-actions input,.approval-row-actions select,.approval-metric-cell')].filter(e=>e.getClientRects().length&&e.clientWidth>0&&e.scrollWidth>e.clientWidth+1).map(e=>({tag:e.tagName,class:e.className,width:e.clientWidth,scroll:e.scrollWidth})),
      sizes:[...element.querySelectorAll('.approval-summary-table td,.approval-metric-value,input,select')].filter(e=>e.getClientRects().length).map(e=>parseFloat(getComputedStyle(e).fontSize))
    }));
    assert.deepEqual(result.headers,['','型号','在库库存','申请数量合计','商务审核数量合计']);
    const hidesProfit=['assistant-1','assistant-2','purchasing'].includes(result.role);
    const expectedDocumentHeaders=['申请数量','商务部审核数量','商务部备注','供应商库存回复','发货仓库','采购备注','调拨部门','调拨店铺','调拨运营','已贴FNSKU','ASIN','运营备注','提交时间','状况','7 天销量','30 天销量',...(hidesProfit?[]:['订单毛利润（USD）']),'FBA 可售','FBA 待调仓','FBA 调仓中','FBA 在途','调货前倍数','调货后倍数'];
    assert.deepEqual(result.documentHeaders,expectedDocumentHeaders);
    assert.equal(result.zoom,1);assert.ok(result.pageWidth<=width);assert.equal(result.tableScroll,true);assert.deepEqual(result.clipped,[]);
    const expectedColumns=hidesProfit?22:23,expectedMetrics=hidesProfit?6:7;
    assert.ok(result.metrics.length>0&&result.metrics.every(m=>m.count===expectedMetrics&&m.columnCount===expectedColumns&&m.colSpan===expectedColumns&&m.ys.length===expectedColumns&&new Set(m.ys).size===1));assert.ok(result.sizes.every(n=>n>=13));
    for (const dialog of await page.getByRole('dialog').all()) for (const button of await dialog.getByRole('button').all()) {
      assert.equal(await button.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'办理按钮不能被其他单据遮挡');
    }
    displayChecks.push({phase,...result});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(output,'approval-'+phase+'-'+width+'.png'),fullPage:true,animations:'disabled'});
  }
  await page.setViewportSize({width:1440,height:1100});
  check(phase+`型号汇总及${['assistant-1','assistant-2','purchasing'].includes(await page.locator('select[aria-label="切换当前操作角色"]').inputValue())?'22':'23'}列单据、对应指标及第二行原办理表单在1280/1366/1920完整显示且仅表内横向滚动`,true);
  await fs.writeFile(path.join(output,'approval-layout.json'),JSON.stringify(displayChecks,null,2));
}

try {
  await fs.mkdir(path.join(stateRoot, "data"), { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const roles = ["admin", "assistant-1", "assistant-2", "business", "operation-1", "operation-2", "purchasing"];
  await fs.writeFile(path.join(stateRoot, "data", "permissions.json"), JSON.stringify({ 墨盒: Object.fromEntries(roles.map((value) => [value, { summary: true, detail: true, expand: true, actions: true }])) }));
  createInventoryDatabase({ databasePath: path.join(stateRoot, "data", INVENTORY_DATABASE_NAME) });
  const packFixtureDb = new InventoryDatabase(stateRoot);
  packFixtureDb.db.prepare("UPDATE stock_batches SET pack_per_box = '1' WHERE model = ? AND version = 'V11'").run("SYNTH-TONER-001");
  packFixtureDb.close();
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer(); listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => { const value = listener.address().port; listener.close((error) => error ? reject(error) : resolve(value)); });
  });
  base = `http://127.0.0.1:${port}`;
  const instanceId = createTestInstanceId("approvals-ui");
  server = spawn(process.execPath, [path.join(root, "server.mjs")], { cwd: root, env: { ...process.env, ASTER_STATE_ROOT: stateRoot, PORT: String(port), HOST: "127.0.0.1", PROD: "1", ASTER_TEST_INSTANCE_ID: instanceId }, stdio: "ignore" });
  await waitForOwnedServer({ base, child: server, instanceId, readyPath: "/api/health" });
  const executablePath = [process.env.ASTER_BROWSER_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find((value) => fsSync.existsSync(value));
  assert.ok(executablePath, "找不到用于页面验收的 Chromium 浏览器");
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: "zh-CN" });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && ["/api/allocations", "/api/inquiries"].includes(pathname)) storeValidationPosts.push(pathname);
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await role(page, "operation-1");
  await page.locator(".inventory-summary-row").filter({ hasText: "SYNTH-TONER-001" }).click();
  const modelRow=page.locator('.inventory-summary-row').filter({hasText:'SYNTH-TONER-001'});
  const inquiryButton=page.locator('.detail-tabs').getByRole('button',{name:'询库',exact:true});
  await inquiryButton.waitFor();
  check('询库仅在明细标签右侧，主行无入口，批次调拨入口保留',await modelRow.locator('.inquiry-entry').count()===0 && await page.locator('.detail-tabs .inquiry-entry').count()===1 && await page.locator('.alloc-toggle').count()>0);

  await page.locator(".detail-stock-table tbody tr").filter({ hasText: "V11" }).locator(".alloc-toggle").click();
  const form = page.locator(".allocation-panel form");
  await form.getByLabel("调拨数量", { exact: true }).fill("100");
  const allocationStore = form.locator("input[pattern]");
  const validStores = ["AUS", "ABUS", "A1US", "USABC", "AUSB", "US"];
  const invalidStores = ["A-US", "US-ABC", "AAA", "aus"];
  for (const store of validStores) {
    await allocationStore.fill(store);
    assert.equal(await allocationStore.evaluate(element => element.validity.valid), true, `调拨原生校验应接受 ${store}`);
    assert.equal(await allocationStore.getAttribute("aria-invalid"), "false");
    assert.equal(await form.locator(".field-error").count(), 0);
  }
  for (const store of invalidStores) {
    await allocationStore.fill(store);
    assert.equal(await allocationStore.getAttribute("aria-invalid"), "true");
    assert.equal(await allocationStore.evaluate(element => element.validity.patternMismatch), true, `调拨原生校验应拒绝 ${store}`);
    assert.equal(await form.locator(".field-error").innerText(), "店铺名称须包含大写 US，且不能包含‘-’。");
  }
  await form.getByLabel("调拨运营", { exact: true }).fill("张三");
  await form.getByLabel("已贴 FNSKU", { exact: true }).fill("XUIAPP0001");
  await form.getByLabel("ASIN（必填）", { exact: true }).fill("BUIAPP0001");
  await form.getByLabel("运营备注（选填）", { exact: true }).fill(longNote);
  const postsBeforeInvalidAllocation = storeValidationPosts.length;
  await form.getByRole("button", { name: "录入并预锁定", exact: true }).click();
  assert.equal(storeValidationPosts.length, postsBeforeInvalidAllocation, "格式错误的调拨店铺不能发出请求");
  await allocationStore.fill("ABUS");
  let result = await write(page, "/api/allocations", () => form.getByRole("button", { name: "录入并预锁定", exact: true }).click());
  const allocation = result.record;
  check("页面申请保存 ASIN 和选填备注并预锁定 100", allocation.asin === "BUIAPP0001" && allocation.operatorNote === longNote && (await stock()).locked === 100);
  await role(page, "operation-1");
  await inquiryButton.click();
  const dialog = page.getByRole("dialog", { name: "提交询库需求 · SYNTH-TONER-001", exact: true });
  await dialog.getByLabel("询库数量（必填）", { exact: true }).fill("150");
  const inquiryStore = dialog.locator("input[pattern]");
  for (const store of validStores) {
    await inquiryStore.fill(store);
    assert.equal(await inquiryStore.evaluate(element => element.validity.valid), true, `询库原生校验应接受 ${store}`);
    assert.equal(await inquiryStore.getAttribute("aria-invalid"), "false");
    assert.equal(await dialog.locator(".field-error").count(), 0);
  }
  for (const store of invalidStores) {
    await inquiryStore.fill(store);
    assert.equal(await inquiryStore.getAttribute("aria-invalid"), "true");
    assert.equal(await inquiryStore.evaluate(element => element.validity.patternMismatch), true, `询库原生校验应拒绝 ${store}`);
    assert.equal(await dialog.locator(".field-error").innerText(), "店铺名称须包含大写 US，且不能包含‘-’。");
  }
  await dialog.getByLabel("询库运营（必填）", { exact: true }).fill("李四");
  await dialog.getByLabel("ASIN（必填）", { exact: true }).fill("BUIINQ0001");
  await dialog.getByLabel("FNSKU（必填）", { exact: true }).fill("XUIINQ0001");
  await dialog.getByLabel("运营备注（选填）", { exact: true }).fill("询库备注保留");
  const postsBeforeInvalidInquiry = storeValidationPosts.length;
  await dialog.getByRole("button", { name: "提交询库", exact: true }).click();
  assert.equal(storeValidationPosts.length, postsBeforeInvalidInquiry, "格式错误的询库店铺不能发出请求");
  await inquiryStore.fill("BUS");
  result = await write(page, "/api/inquiries", () => dialog.getByRole("button", { name: "提交询库", exact: true }).click());
  const inquiry = result.record;
  await dialog.waitFor({ state: "hidden" });
  check("运营从型号明细提交询库且不改变库存", inquiry.requestedQuantity === 150 && (await stock()).onHand === 500 && (await stock()).locked === 100);
  await api("POST", "/api/inquiries", "operation-2", { model: "SYNTH-INK-001", quantity: 10, department: "二团", store: "BUS", operator: "王五", fnsku: "XUIINK0001", asin: "BUIINK0001", operatorNote: "墨盒二团", requestId: requestId("ink-inquiry") });
  const metricFixtureDb = new InventoryDatabase(stateRoot);
  metricFixtureDb.syncLingxing({ role:"admin", items: [
    { asin: "BUIAPP0001", sales7d: 40, sales30d: 170, orderGrossProfit: 1234567890.12, fbaAvailable: 100, fbaPendingTransfer: 76, fbaTransferring: 100, fbaInbound: 100 },
    { asin: "BUIINQ0001", sales7d: 0, sales30d: 0, orderGrossProfit: 0, fbaAvailable: 0, fbaPendingTransfer: 0, fbaTransferring: 0, fbaInbound: 0 },
  ], capturedAt: new Date().toISOString(), requestId: requestId("metrics") });
  metricFixtureDb.close();

  for (const emptyRole of ['admin']) {
    await role(page, emptyRole); await approvals(page);
    await page.getByRole('button', {name:/^我的待办/}).click(); await todo(page, 0);
    await page.getByText('当前岗位暂无待办', {exact:true}).waitFor();
  }
  check('管理员待办保持空', true);
  const observers = [];
  for (const observerRole of ['business', 'purchasing', 'assistant-1', 'operation-1', 'operation-2']) {
    const observer = await browser.newPage({viewport:{width:1440,height:1100}});
    observer.on('pageerror', error => errors.push(error.message));
    await observer.goto(base, {waitUntil:'networkidle'}); await role(observer, observerRole); await approvals(observer);
    await observer.getByRole('button', {name:/^我的待办/}).click(); observers.push(observer);
  }
  const watchCounts = async counts => {
    await Promise.all(observers.map(async (observer, index) => {
      await todo(observer, counts[index]);
      while(await observer.locator('.approval-expand[aria-expanded="false"]').count())await observer.locator('.approval-expand[aria-expanded="false"]').first().click();
      assert.equal(await observer.locator('.approval-record').count(), counts[index], '其他电脑的实际待办行数与待办数量一致');
      if (index >= 3) {
        while(await observer.locator('.approval-expand[aria-expanded="false"]').count())await observer.locator('.approval-expand[aria-expanded="false"]').first().click();
        const departments = await observer.locator('.approval-record').allTextContents();
        assert.ok(departments.every(text => text.includes(index === 3 ? '一团' : '二团')), '运营只看到本团待办');
        assert.equal(await observer.locator('.approval-record .approval-review-form').count(), 0, '运营跟进不获得办理权限');
      }
    }));
  };
  const operationStage = async (documentNo, label) => {
    const row = record(observers[3], documentNo);
    await row.waitFor();
    assert.equal(await row.locator('.approval-progress .badge').count(), 1); // 未完成进度保留
    assert.equal(await row.locator('.approval-operation-row').isVisible(), false);
    if (label === '待助理完成' || label === '待采购回复') await row.locator('[data-field="商务审核数量"]').filter({hasText:/^\d+$/}).waitFor();
    if (label === '待助理归档') assert.equal((await api('GET','/api/approvals','admin')).inquiries.find(r=>r.documentNo===documentNo).supplierQuantity,60);
  };
  await watchCounts([3,0,0,2,1]);
  await operationStage(allocation.documentNo, '待商务审核'); await operationStage(inquiry.documentNo, '待商务审核');
  check('两团分别跟进本团所有进行中单据，另一客户端首次打开可见且没有办理表单', true);
  const operationPage = observers[3];
  await operationPage.getByRole('button',{name:/^我的待办/}).click();
  await operationPage.getByLabel('筛选审批进度',{exact:true}).selectOption('active');
  await operationPage.getByRole('button',{name:/^我的待办/}).click();
  assert.equal(await operationPage.getByLabel('筛选审批进度',{exact:true}).inputValue(),'all');
  await operationPage.getByLabel('搜索运营姓名、型号或 ASIN',{exact:true}).fill('没有这个姓名');
  await todo(operationPage,2); await operationPage.getByText('当前筛选下没有待办',{exact:true}).waitFor();
  await operationPage.getByRole('button',{name:'清除筛选',exact:true}).click();
  await expand(operationPage);await operationPage.locator('.approval-model-group[data-model="SYNTH-TONER-001"] .approval-expand').click(); await todo(operationPage,2); await expand(operationPage);
  await operationPage.screenshot({path:path.join(output,'operation-pending-business.png'),fullPage:true});
  check('运营待办保留进度冲突解除、筛选无结果及清除筛选，折叠不改变计数',true);

  await role(page, "business");
  await approvals(page);
  await expand(page);
  check("审批中心按型号归集且商务可见跨类目需求", new Set(await page.locator('.approval-model-name').allTextContents()).size === 2);
  const allocationCard = record(page, allocation.documentNo);
  const inquiryCard = record(page, inquiry.documentNo);
  const catalog = await api('GET','/api/inventory/catalog','business');
  const inStock = catalog.models.find(model=>model.model==='SYNTH-TONER-001').inStock.toLocaleString('zh-CN');
  const modelGroup=page.locator('.approval-model-group[data-model="SYNTH-TONER-001"]');
  assert.equal(await modelGroup.locator('[data-field="在库库存"]').innerText(),inStock);
  assert.equal(await modelGroup.locator('[data-field="申请数量合计"]').innerText(),'250');
  assert.equal(await modelGroup.locator('[data-field="商务审核数量合计"]').innerText(),'—');
  for (const [card,requested] of [[allocationCard,'100'],[inquiryCard,'150']]) {
    assert.equal(await card.locator('.approval-data-row > td').count(),23);
    assert.equal(await card.locator(':scope > tr').count(),2);
    assert.equal(await card.locator('.approval-action-row > td').getAttribute('colspan'),'23');
    assert.equal(await card.locator('.approval-metrics-row,.approval-metrics').count(),0);
    assert.equal(await card.locator('[data-field="申请数量"]').innerText(),requested);
    assert.equal(await card.locator('[data-field="商务审核数量"]').innerText(),'—');
    assert.equal(await card.locator('.approval-expand,.approval-model-toggle,[data-field="供货数量"],[data-field="来源批次"]').count(),0);
    assert.equal(await card.getByRole('button',{name:'商务审核',exact:true}).count(),0);
    assert.equal(await card.getByLabel('审核数量',{exact:true}).count(),1);
  }
  await expand(page,'SYNTH-INK-001');
  await modelGroup.locator('.approval-model-toggle').click();
  assert.equal(await allocationCard.isVisible(),false);assert.equal(await inquiryCard.isVisible(),false);
  assert.equal(await page.locator('.approval-model-group[data-model="SYNTH-INK-001"] .approval-record').isVisible(),true);
  await page.locator('.approval-model-group[data-model="SYNTH-INK-001"] .approval-expand').click();
  for(const width of [1280,1366,1920]) {await page.setViewportSize({width,height:1100});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,'summary-collapsed-'+width+'.png'),fullPage:true});}
  await modelGroup.locator('.approval-expand').click();
  for(const width of [1280,1366,1920]) {
    await page.setViewportSize({width,height:1100});
    const scroll=modelGroup.locator('.approval-table-scroll');
    await scroll.evaluate(el=>{el.scrollLeft=el.scrollWidth;});
    const box=await scroll.boundingBox();
    for(const card of [allocationCard,inquiryCard]) {const actions=await card.locator('.approval-row-actions').boundingBox();assert.ok(Math.abs(actions.x-box.x)<2);assert.ok(actions.width<=box.width+1);}
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(output,'summary-expanded-right-'+width+'.png'),fullPage:true});
    await scroll.evaluate(el=>{el.scrollLeft=0;});
    await page.screenshot({path:path.join(output,'summary-expanded-'+width+'.png'),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1100});
  assert.equal(await allocationCard.locator('[data-field="运营备注"]').innerText(),longNote);
  assert.deepEqual(await allocationCard.locator('.approval-metric-value').allTextContents(),['40','170','1,234,567,890.12','100','76','100','100']);
  assert.deepEqual(await inquiryCard.locator('.approval-metric-value').allTextContents(),['0','0','0','0','0','0','0']);
  assert.deepEqual(await allocationCard.locator('.approval-data-row > td').allTextContents().then(values=>values.slice(14)),['40','170','1,234,567,890.12','100','76','100','100','2.2 倍','2.8 倍']);
  assert.deepEqual(await inquiryCard.locator('.approval-data-row > td').allTextContents().then(values=>values.slice(14)),['0','0','0','0','0','0','0','无销量','无销量']);
  check('同型号合并250、库存只取一次、逐单100/150及未审核缺失值正确，多型号独立展开',true);
  check('不同ASIN保留各自七项指标与真实零，长备注全文保留，直接审核区不混入资料行',true);
  check("调拨保留2.2倍和USD，底层取数时间保留且不再展示", (await allocationCard.innerText()).includes("2.2") && Boolean((await api("GET","/api/approvals","admin")).allocations.find(r=>r.id===allocation.id).lingxing.capturedAt) && await allocationCard.locator('[data-field="取数时间"]').count()===0 && (await modelGroup.locator('.approval-document-table > thead').innerText()).includes('USD') && !(await allocationCard.innerText()).includes("全部店铺"));
  check("零销量显示明确无法计算", (await inquiryCard.innerText()).includes("无销量") && await inquiryCard.locator('.approval-coverage-value').filter({hasText:'无销量'}).count()===2);
  check("审批不再展示申请资料，但原批次资料仍在接口保留",await allocationCard.locator('[data-field="发货计划号"],[data-field="发货时间"],[data-field="原版本号"],[data-field="来源批次"]').count()===0 && (await api('GET','/api/approvals','admin')).allocations.find(r=>r.id===allocation.id).plan==='TEST-PLAN-TONER');
  await page.getByRole("group", { name: "按类目筛选", exact: true }).getByRole("button", { name: "墨盒", exact: true }).click();
  check("审批类目筛选仅显示墨盒型号", await page.locator('.approval-model-name').count()===1 && (await page.locator('.approval-model-name').innerText()).includes('SYNTH-INK-001'));
  await page.getByRole("group", { name: "按类目筛选", exact: true }).getByRole("button", { name: "全部类目", exact: true }).click();
  await page.getByLabel("按需求类型筛选",{exact:true}).selectOption("allocation");
  assert.equal(await modelGroup.locator('[data-field="申请数量合计"]').innerText(),'100');
  check("类型切换可单独查看调拨并只合计筛选内单据", await page.locator(".approval-record").count() === 1 && await allocationCard.count() === 1);
  await page.getByLabel("按需求类型筛选",{exact:true}).selectOption("all");
  await page.getByLabel("搜索运营姓名、型号或 ASIN", { exact: true }).fill("李四");
  assert.equal(await modelGroup.locator('[data-field="申请数量合计"]').innerText(),'150');
  check("运营姓名搜索只返回对应申请人的进度与合计", await page.locator(".approval-record").count() === 1 && (await detailsText(page.locator(".approval-record"))).includes("BUS"));
  await page.getByLabel("搜索运营姓名、型号或 ASIN", { exact: true }).fill("");
  await page.getByLabel('筛选审批进度', {exact:true}).selectOption('active');
  await page.getByRole("button",{name:/^我的待办/}).click();
  await todo(page, 3);
  await page.screenshot({path:path.join(output,'todo-archived-switch.png'),fullPage:true,animations:'disabled'});
  assert.equal(await page.getByLabel('筛选审批进度', {exact:true}).inputValue(), 'all');
  assert.ok(!(await page.getByLabel('筛选审批进度', {exact:true}).locator('option').allTextContents()).includes('已归档'));
  check('进入我的待办重置进度筛选，进度选项不再提供已归档', true);
  await page.getByLabel('搜索运营姓名、型号或 ASIN', {exact:true}).fill('没有这个姓名');
  await page.getByText('当前筛选下没有待办', {exact:true}).waitFor(); await todo(page, 3);
  assert.equal(await page.getByText('当前岗位暂无待办', {exact:true}).count(), 0);
  await page.screenshot({path:path.join(output,'todo-filter-empty.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button', {name:'清除筛选',exact:true}).click(); await allocationCard.waitFor();
  await page.getByRole('group', {name:'按类目筛选',exact:true}).getByRole('button', {name:'墨盒',exact:true}).click();
  await page.getByLabel('按需求类型筛选',{exact:true}).selectOption('allocation');
  await page.getByText('当前筛选下没有待办', {exact:true}).waitFor(); await todo(page, 3);
  await page.getByRole('button', {name:'清除筛选',exact:true}).click(); await allocationCard.waitFor();
  assert.equal(await page.getByLabel('搜索运营姓名、型号或 ASIN', {exact:true}).inputValue(), '');
  await expand(page); await page.locator('.approval-model-group[data-model="SYNTH-TONER-001"] .approval-expand').click(); await todo(page, 3); await expand(page);
  check('搜索或类目/类型遮挡时提示筛选无结果，清除筛选恢复，型号折叠不改变岗位总数', true);
  check("删除待办说明后仍显示商务待审核单据", await page.locator(".approval-scope-hint").count()===0 && await allocationCard.isVisible() && await inquiryCard.isVisible());
  await allocationCard.getByLabel("审核数量",{exact:true}).waitFor();
  await allocationCard.getByLabel("审核数量", { exact: true }).fill("90");
  await allocationCard.getByLabel("商务备注", { exact: true }).fill("批准 90 件");
  await inquiryCard.getByLabel('审核数量',{exact:true}).fill('80');
  await inquiryCard.getByLabel('商务备注',{exact:true}).fill('另一单未提交草稿');
  const reviewPosts=[];const captureReview=request=>{if(request.method()==='POST'&&request.url().endsWith('/review'))reviewPosts.push(request.postDataJSON());};page.on('request',captureReview);
  await inquiryCard.getByLabel('商务备注',{exact:true}).press('Tab');
  await inquiryCard.getByLabel('审核数量',{exact:true}).press('Enter');
  await modelGroup.locator('.approval-expand').click();await modelGroup.locator('.approval-model-toggle').click();
  const refreshed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/approvals');await page.getByRole('button',{name:'刷新',exact:true}).click();await refreshed;
  assert.equal(await allocationCard.getByLabel('审核数量',{exact:true}).inputValue(),'90');
  assert.equal(await inquiryCard.getByLabel('审核数量',{exact:true}).inputValue(),'80');
  assert.equal(await inquiryCard.getByLabel('商务备注',{exact:true}).inputValue(),'另一单未提交草稿');
  assert.equal(await modelGroup.locator('[data-field="商务审核数量合计"]').innerText(),'—');assert.deepEqual(reviewPosts,[]);page.off('request',captureReview);
  check('各单草稿在输入、失焦、Enter、收起重开及刷新后保持且不提交，不计入审核合计',true);
  await verifyApprovalDisplay(page, 'business');
  await modelGroup.locator('.approval-table-scroll').evaluate(el=>{el.scrollLeft=el.scrollWidth;});
  await allocationCard.getByLabel('商务备注',{exact:true}).fill('批准 90 件');
  assert.ok(await modelGroup.locator('.approval-table-scroll').evaluate(el=>el.scrollLeft>0));
  for(const button of await allocationCard.locator('.approval-review-form button').all())assert.equal(await button.evaluate(el=>{const r=el.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
  check('滚动到指标最右侧后审核输入和批准拒绝仍在可见区域，输入不会将表格推回左侧',true);
  await write(page, `/api/allocations/${allocation.id}/review`, () => allocationCard.getByRole("button", { name: "批准", exact: true }).click());
  await allocationCard.waitFor({ state: "hidden" });
  check("商务批准 90 后即时释放 10 并移出商务待办", (await stock()).locked === 90);
  await todo(page, 2); await watchCounts([2,0,1,2,1]);
  await operationStage(allocation.documentNo, '待助理完成');
  assert.equal(await inquiryCard.getByLabel('审核数量',{exact:true}).inputValue(),'80');
  assert.equal(await inquiryCard.getByLabel('商务备注',{exact:true}).inputValue(),'另一单未提交草稿');
  assert.equal(await modelGroup.locator('[data-field="商务审核数量合计"]').innerText(),'—');
  const operationGroup=operationPage.locator('.approval-model-group[data-model="SYNTH-TONER-001"]');
  assert.equal(await operationGroup.locator('[data-field="商务审核数量合计"]').innerText(),'90');
  check('批准另一单后保留未提交草稿；当前待办合计排除已转岗单，运营合计只计已保存90',true);
  await inquiryCard.getByLabel("审核数量",{exact:true}).waitFor();
  await inquiryCard.getByLabel("审核数量", { exact: true }).fill("90");
  await inquiryCard.getByLabel("商务备注", { exact: true }).fill("询库批准 90");
  await write(page, `/api/inquiries/${inquiry.id}/review`, () => inquiryCard.getByRole("button", { name: "批准", exact: true }).click());
  await inquiryCard.waitFor({ state: "hidden" });

  await todo(page, 1); await watchCounts([1,1,1,2,1]);
  await operationStage(inquiry.documentNo, '待采购回复');
  await operationPage.screenshot({path:path.join(output,'operation-after-business.png'),fullPage:true});
  check('提交进入商务，调拨批准转助理、询库批准转采购；三台岗位页面自动刷新数量', true);

  await role(page, "purchasing");
  await page.getByRole("button",{name:/^我的待办/}).click();
  await expand(page);
  await inquiryCard.getByLabel("供应商库存回复", { exact: true }).fill("60");
  const purchasingWarehouse = inquiryCard.locator(".inquiry-purchasing-form select");
  assert.equal(await purchasingWarehouse.count(), 1);
  assert.equal(await purchasingWarehouse.evaluate(element => element.tagName), "SELECT");
  assert.equal(await purchasingWarehouse.evaluate(element => element.closest("label")?.textContent?.trim().startsWith("发货仓库")), true);
  assert.deepEqual(await purchasingWarehouse.locator("option").allTextContents(), ["选择仓库", "CA", "SC"]);
  await purchasingWarehouse.selectOption("CA");
  await inquiryCard.getByLabel("采购备注", { exact: true }).fill("供应商确认可供 60 件");
  assert.equal(await record(operationPage,inquiry.documentNo).getByLabel('采购备注',{exact:true}).count(),0);
  await verifyApprovalDisplay(page, 'purchasing');
  await write(page, `/api/inquiries/${inquiry.id}/reply`, () => inquiryCard.getByRole("button", { name: "提交", exact: true }).click());
  await inquiryCard.waitFor({ state: "hidden" });

  await todo(page, 0); await watchCounts([1,0,2,2,1]);
  await operationStage(inquiry.documentNo, '待助理归档');
  await operationPage.screenshot({path:path.join(output,'operation-after-purchasing.png'),fullPage:true});
  check('商务、采购办理后运营两条待办持续保留，其他客户端自动更新已保存结果和岗位待办',true);
  check('采购有货回复后退出采购待办，助理新增询库归档待办', true);

  await role(page, "assistant-1");
  await page.getByRole("button",{name:/^我的待办/}).click();
  await expand(page);
  await verifyApprovalDisplay(page, 'assistant-confirm');
  await write(page, `/api/allocations/${allocation.id}/confirm`, () => allocationCard.getByRole("button", { name: "确认调拨完成", exact: true }).click());
  await allocationCard.waitFor({ state: "hidden" });
  check("助理页面确认按 90 扣减，锁定归零", (await stock()).onHand === 410 && (await stock()).locked === 0);
  await todo(page, 1); await watchCounts([1,0,1,1,1]);
  assert.equal(await record(operationPage,allocation.documentNo).count(),0);
  await inquiryCard.getByRole("button",{name:"助理归档",exact:true}).click();
  await inquiryCard.getByLabel("发货计划号", { exact: true }).fill("FBA-UI-INQUIRY");
  await inquiryCard.getByLabel("发货时间", { exact: true }).fill("2026-09-01");
  await inquiryCard.getByLabel("原版本号", { exact: true }).fill("V20");
  await verifyApprovalDisplay(page, 'assistant-archive');
  await write(page, `/api/inquiries/${inquiry.id}/archive`, () => inquiryCard.getByRole("button", { name: "提交", exact: true }).click());
  await inquiryCard.waitFor({state:"hidden"});
  check("助理一次归档结束待办，本地库存不变",(await stock()).onHand===410 && (await stock()).locked===0);
  await todo(page, 0); await watchCounts([1,0,0,0,1]); await page.getByText('当前岗位暂无待办',{exact:true}).waitFor();
  await operationPage.getByText('当前岗位暂无待办',{exact:true}).waitFor();
  check('调拨完成、询库归档后自动移出所属运营团队待办',true);
  check('调拨完成及询库归档退出待办，其他电脑自动同步列表和数量', true);
  await approvals(page); await expand(page);
  const archivedInquiry=(await api("GET","/api/approvals","admin")).inquiries.find(r=>r.id===inquiry.id);
  assert.equal(archivedInquiry.requestedQuantity,60);
  assert.equal(archivedInquiry.approvedQuantity,60);
  assert.equal(archivedInquiry.supplierQuantity,60);
  assert.equal(archivedInquiry.shippingWarehouse,"CA");
  assert.equal(archivedInquiry.purchaseNote,"供应商确认可供 60 件");
  assert.equal(archivedInquiry.events.find(event=>event.type==='entry').payload.requestedQuantity,150);
  assert.equal(await inquiryCard.locator('[data-field="申请数量"]').innerText(),'60');
  assert.equal(await inquiryCard.locator('[data-field="商务审核数量"]').innerText(),'60');
  assert.equal(await inquiryCard.locator('[data-field="供应商库存回复"]').innerText(),'60');
  assert.equal(await inquiryCard.locator('[data-field="发货仓库"]').innerText(),'CA');
  assert.equal(await inquiryCard.locator('[data-field="采购备注"]').innerText(),'供应商确认可供 60 件');
  assert.equal(await modelGroup.locator('[data-field="申请数量合计"]').innerText(),'160');
  assert.equal(await modelGroup.locator('[data-field="商务审核数量合计"]').innerText(),'150');
  check("采购回复后申请量、商务审核量及型号合计统一为最终量60，供应商回复、仓库和采购备注在正确列显示", await inquiryCard.locator('.approval-progress').innerText()==='已完成' && await allocationCard.locator('.approval-progress').innerText()==='已完成' && await inquiryCard.locator('.approval-row-actions button').count()===0);
  for (const close of await page.getByRole("button", { name: "关闭提示", exact: true }).all()) await close.click();
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0,0); });
  await page.screenshot({ path: path.join(output, "approvals-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.screenshot({ path: path.join(output, "approvals-1280.png"), fullPage: true });
  check("1280桌面审批页面无整页横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1440, height: 1100 });

  const beforeRefresh = await api("GET", "/api/approvals", "assistant-1");
  await page.reload({ waitUntil: "networkidle" });
  await role(page, "assistant-1");
  await approvals(page);
  await expand(page);
  check("浏览器刷新后审批归档数量和采购备注保持", (await detailsText(allocationCard)).includes("调拨备注保留") && (await detailsText(inquiryCard)).includes("供应商确认可供 60 件")
    && beforeRefresh.inquiries.find((row) => row.id === inquiry.id).quantity === 60);
  await page.locator(".sidebar .nav-item", { hasText: "升级库存" }).click();
  await page.locator(".upgrade-page").waitFor();
  const allocationSource = page.locator(".upgrade-candidate-table tbody tr").filter({ hasText: allocation.documentNo });
  const inquirySources = page.locator(".upgrade-candidate-table tbody tr").filter({ hasText: inquiry.documentNo });
  const inquirySource = inquirySources;
  await allocationSource.waitFor();
  await inquirySource.waitFor();
  await allocationSource.locator('.source-select').click();
  const sourceCard=page.locator('.relocation-documents > .panel');
  check("升级页面带出调拨批准量90及原计划、日期和版本",(await allocationSource.innerText()).includes('90') && (await sourceCard.innerText()).includes('TEST-PLAN-TONER') && (await sourceCard.innerText()).includes('2026-02-10') && (await sourceCard.innerText()).includes('V11'));
  await inquirySource.locator('.source-select').click();
  check("询库来源带出回复量、ASIN、计划、日期和原版本",await inquirySource.count()===1 && (await inquirySource.innerText()).includes('60') && (await sourceCard.innerText()).includes('BUIINQ0001') && (await sourceCard.innerText()).includes('V20') && (await sourceCard.innerText()).includes('FBA-UI-INQUIRY'));
  await page.screenshot({path:path.join(output,'approval-upgrade-sources.png'),fullPage:true});
  result = await write(page, "/api/upgrades/relocation-work-items", () => page.getByRole("button", { name: "发起移仓升级", exact: true }).click());
  check("升级页直接发起归档询库来源", result.workItem.inquiryId===inquiry.id && result.workItem.inquiryShipmentId==null && result.workItem.sourceQuantityBefore===60 && result.workItem.shipDate==="2026-09-01");
  // A second inquiry verifies the user-approved zero-stock exit through the real page.
  let zero=(await api("POST","/api/inquiries","operation-1",{model:"SYNTH-TONER-001",quantity:10,department:"一团",store:"AUS",operator:"无货测试",fnsku:"XUIZERO001",asin:"BUIZERO001",requestId:requestId("zero")})).record;
  zero=(await api("POST",`/api/inquiries/${zero.id}/review`,"business",{decision:"approve",approvedQuantity:10,expectedRevision:zero.revision,requestId:requestId("zero-review")})).record;
  await watchCounts([1,1,0,1,1]); await operationStage(zero.documentNo,'待采购回复');
  await role(page,"purchasing");await approvals(page);await expand(page);
  const zeroCard=record(page,zero.documentNo);
  const zeroQuantity=zeroCard.getByLabel("供应商库存回复",{exact:true});
  await zeroQuantity.fill("");assert.equal(await zeroQuantity.evaluate(input=>input.validity.valueMissing),true);
  await zeroQuantity.fill("-1");assert.equal(await zeroQuantity.evaluate(input=>input.validity.rangeUnderflow),true);
  await zeroQuantity.fill("0.5");assert.equal(await zeroQuantity.evaluate(input=>input.validity.stepMismatch),true);
  await zeroQuantity.fill("0");
  await page.screenshot({path:path.join(output,'zero-reply-form.png'),fullPage:true});
  assert.equal(await zeroCard.locator('.inquiry-purchasing-form').evaluate(form=>form.checkValidity()),true);
  assert.equal(await zeroCard.getByLabel('发货仓库',{exact:true}).inputValue(),'');
  assert.equal(await zeroCard.getByRole('button',{name:'提交',exact:true}).evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'零供货回复不能被后续详情遮挡');
  result=await write(page,`/api/inquiries/${zero.id}/reply`,()=>zeroCard.getByRole("button",{name:"提交",exact:true}).click());
  check("页面供应商0回复将申请量与商务审核量置0并立即归档",result.record.status==="archived" && result.record.requestedQuantity===0 && result.record.approvedQuantity===0 && result.record.quantity===0);
  await page.waitForFunction(documentNo=>{
    const row=document.querySelector(`[data-document-no="${CSS.escape(documentNo)}"]`);
    return row?.querySelector('[data-field="申请数量"]')?.textContent?.trim()==="0"
      && row?.querySelector('[data-field="商务审核数量"]')?.textContent?.trim()==="0"
      && row?.querySelector('[data-field="供应商库存回复"]')?.textContent?.trim()==="0";
  },zero.documentNo,{timeout:8000});
  assert.equal(await zeroCard.locator('[data-field="申请数量"]').innerText(),'0');
  assert.equal(await zeroCard.locator('[data-field="商务审核数量"]').innerText(),'0');
  assert.equal(await zeroCard.locator('[data-field="供应商库存回复"]').innerText(),'0');
  await todo(page, 0); await watchCounts([1,0,0,0,1]);
  check('采购回复0退出待办且不生成助理待办', true);
  let rejectedAllocation=(await api('POST','/api/allocations','operation-1',{model:'SYNTH-TONER-001',plan:'TEST-PLAN-TONER',date:'2026-02-10',version:'V11',quantity:10,department:'一团',store:'AUS',operator:'拒绝测试',fnsku:'XTODO00001',asin:'BTODO00001',requestId:requestId('reject-allocation')})).record;
  await watchCounts([2,0,0,1,1]);
  await role(page,'business'); await approvals(page); await page.getByRole('button',{name:/^我的待办/}).click();await expand(page);
  await record(page,rejectedAllocation.documentNo).getByLabel('审核数量',{exact:true}).waitFor();
  await write(page,`/api/allocations/${rejectedAllocation.id}/review`,()=>record(page,rejectedAllocation.documentNo).getByRole('button',{name:'拒绝',exact:true}).click());
  await todo(page,1); await watchCounts([1,0,0,0,1]);
  const remainingInquiry=(await api('GET','/api/approvals','business')).inquiries.find(row=>row.model==='SYNTH-INK-001');await expand(page,'SYNTH-INK-001');
  await record(page,remainingInquiry.documentNo).getByLabel('审核数量',{exact:true}).waitFor();
  await write(page,`/api/inquiries/${remainingInquiry.id}/review`,()=>record(page,remainingInquiry.documentNo).getByRole('button',{name:'拒绝',exact:true}).click());
  await todo(page,0); await watchCounts([0,0,0,0,0]); await page.getByText('当前岗位暂无待办',{exact:true}).waitFor();
  check('调拨和询库拒绝后均退出商务待办，也不转给其他岗位',true);
  // 补充只读历史响应，验证已取消、已撤回、已完成及已归档状态不被算作待办。
  const historyFixtures=await api('GET','/api/approvals','admin');
  await page.route('**/api/approvals',async route=>{
    const response=await route.fetch(),data=await response.json();
    data.allocations.push(...['cancelled','withdrawn','confirmed'].map((statusCode,index)=>({...(data.allocations[0]||historyFixtures.allocations[0]),id:90000+index,documentNo:'HISTORY-'+index,statusCode,approvalStatus:'pending'})));
    data.inquiries.push(...['cancelled','rejected','archived'].map((status,index)=>({...(data.inquiries[0]||historyFixtures.inquiries[0]),id:91000+index,documentNo:'INQUIRY-HISTORY-'+index,status})));
    await route.fulfill({response,json:data});
  });
  for(const currentRole of ['business','purchasing','assistant-1','assistant-2','operation-1','operation-2','admin']) {await role(page,currentRole);await approvals(page);await page.getByRole('button',{name:/^我的待办/}).click();await todo(page,0);await page.getByText('当前岗位暂无待办',{exact:true}).waitFor();}
  await page.unroute('**/api/approvals');
  check('已取消、已撤回、已完成及已归档历史均不计待办',true);
  // 另一个客户端提交新单，现有商务页面通过版本轮询发现；切页和浏览器刷新结果一致。
  await api('POST','/api/inquiries','operation-2',{model:'SYNTH-INK-001',quantity:10,department:'二团',store:'AUS',operator:'跨页面测试',fnsku:'XRELOAD001',asin:'BRELOAD001',requestId:requestId('reload-todo')});
  await watchCounts([1,0,0,0,1]); await role(page,'business');await approvals(page);await page.getByRole('button',{name:/^我的待办/}).click();await todo(page,1);
  await page.locator('.sidebar .nav-item',{hasText:'库存流水'}).click();await approvals(page);await page.getByRole('button',{name:/^我的待办/}).click();await todo(page,1);
  await page.reload({waitUntil:'networkidle'});await role(page,'business');await approvals(page);await page.getByRole('button',{name:/^我的待办/}).click();await todo(page,1);await expand(page,'SYNTH-INK-001');
  await page.screenshot({path:path.join(output,'todo-reloaded.png'),fullPage:true,animations:'disabled'});
  check('其他客户端提交后自动进入待办；切换岗位、重新进入和浏览器刷新计数一致',true);
  await role(page,'operation-2'); await approvals(page); await page.getByRole('button',{name:/^我的待办/}).click(); await todo(page,1);
  await page.reload({waitUntil:'networkidle'}); await role(page,'operation-2'); await approvals(page); await page.getByRole('button',{name:/^我的待办/}).click(); await todo(page,1); await expand(page,'SYNTH-INK-001');
  await page.screenshot({path:path.join(output,'operation-team2-reloaded.png'),fullPage:true});
  await role(page,'operation-1'); await approvals(page); await page.getByRole('button',{name:/^我的待办/}).click(); await todo(page,0);
  check('运营同团其他客户端新单自动出现，刷新和切换团队后计数与归属一致',true);
  // 二团另一客户端办理完整流程；姓名与一团相同，归属仍只按部门判断。
  let teamInquiry=(await api('GET','/api/approvals','operation-2')).inquiries.find(row=>row.status==='pending_business');
  let teamAllocation=(await api('POST','/api/allocations','operation-2',{model:'SYNTH-TONER-001',plan:'TEST-PLAN-TONER',date:'2026-02-10',version:'V11',quantity:10,department:'二团',store:'AUS',operator:'张三',fnsku:'XTEAM20001',asin:'BTEAM20001',requestId:requestId('team2-allocation')})).record;
  await watchCounts([2,0,0,0,2]);
  await api('POST',`/api/allocations/${teamAllocation.id}/review`,'operation-2',{decision:'approve',approvedQuantity:10,expectedRevision:teamAllocation.revision,requestId:requestId('forbidden-review')},403);
  teamAllocation=(await api('POST',`/api/allocations/${teamAllocation.id}/review`,'business',{decision:'approve',approvedQuantity:10,expectedRevision:teamAllocation.revision,requestId:requestId('team2-review')})).record;
  teamInquiry=(await api('POST',`/api/inquiries/${teamInquiry.id}/review`,'business',{decision:'approve',approvedQuantity:10,expectedRevision:teamInquiry.revision,requestId:requestId('team2-inquiry-review')})).record;
  await watchCounts([0,1,0,0,2]);
  await record(observers[4],teamAllocation.documentNo).locator('[data-field="商务审核数量"]').filter({hasText:/^\d+$/}).waitFor();
  await record(observers[4],teamInquiry.documentNo).locator('[data-field="商务审核数量"]').filter({hasText:/^\d+$/}).waitFor();
  await api('POST',`/api/inquiries/${teamInquiry.id}/reply`,'operation-2',{supplierQuantity:8,shippingWarehouse:'CA',expectedRevision:teamInquiry.revision,requestId:requestId('forbidden-reply')},403);
  await role(page,'purchasing');await approvals(page);await page.getByRole('button',{name:/^我的待办/}).click();await todo(page,1);await expand(page,'SYNTH-INK-001');
  const teamInquiryCard=record(page,teamInquiry.documentNo);
  await teamInquiryCard.getByLabel('供应商库存回复',{exact:true}).fill('8');
  await teamInquiryCard.getByLabel('发货仓库',{exact:true}).selectOption('SC');
  await teamInquiryCard.getByLabel('采购备注',{exact:true}).fill('墨盒供应商回复');
  teamInquiry=(await write(page,`/api/inquiries/${teamInquiry.id}/reply`,()=>teamInquiryCard.getByRole('button',{name:'提交',exact:true}).click())).record;
  await watchCounts([0,0,0,0,2]);
  assert.equal(teamInquiry.supplierQuantity,8);assert.equal(teamInquiry.requestedQuantity,8);assert.equal(teamInquiry.approvedQuantity,8);
  const teamObservedReply=record(observers[4],teamInquiry.documentNo).locator('[data-field="供应商库存回复"]');
  await teamObservedReply.filter({hasText:/^8$/}).waitFor();
  assert.equal(await teamObservedReply.innerText(),'8');
  assert.equal(await record(observers[4],teamInquiry.documentNo).locator('[data-field="发货仓库"]').innerText(),'SC');
  assert.equal(await record(observers[4],teamInquiry.documentNo).locator('[data-field="采购备注"]').innerText(),'墨盒供应商回复');
  check('硒鼓与墨盒均在表格正确列提交 CA/SC 回复，采购备注独立显示给其他岗位',true);
  await observers[4].screenshot({path:path.join(output,'operation-team2-following.png'),fullPage:true});
  await api('POST',`/api/allocations/${teamAllocation.id}/confirm`,'operation-2',{expectedRevision:teamAllocation.revision,requestId:requestId('forbidden-confirm')},403);
  await api('POST',`/api/inquiries/${teamInquiry.id}/archive`,'operation-2',{plan:'FBA-TEAM2',date:'2026-09-01',version:'V20',expectedRevision:teamInquiry.revision,requestId:requestId('forbidden-archive')},403);
  await api('POST',`/api/allocations/${teamAllocation.id}/confirm`,'assistant-2',{expectedRevision:teamAllocation.revision,requestId:requestId('team2-confirm')});
  await api('POST',`/api/inquiries/${teamInquiry.id}/archive`,'assistant-2',{plan:'FBA-TEAM2',date:'2026-09-01',version:'V20',expectedRevision:teamInquiry.revision,requestId:requestId('team2-archive')});
  await watchCounts([0,0,0,0,0]);
  check('二团跨类目调拨/询库全程跟进直到结束，一团同姓名不会看到二团待办',true);
  check('运营可见待办仍不能直接调用审核、采购回复、确认完成或归档接口',true);
  for(const observer of observers)await observer.close();

  // 独立标记数据覆盖角色 × 团队 × 类目 × 单据类型，避免正式空列表造成假阳性。
  const visibilityMetrics = [
    { asin: 'BVSTONAL01', sales7d: 17, sales30d: 175, orderGrossProfit: -12.34, fbaAvailable: 200, fbaPendingTransfer: 100, fbaTransferring: 100, fbaInbound: 141 },
    { asin: 'BVSTONIN01', sales7d: 18, sales30d: 32, orderGrossProfit: 0, fbaAvailable: 12, fbaPendingTransfer: 23, fbaTransferring: 34, fbaInbound: 45 },
    { asin: 'BVSINKAL01', sales7d: 19, sales30d: 33, orderGrossProfit: 250.5, fbaAvailable: 13, fbaPendingTransfer: 24, fbaTransferring: 35, fbaInbound: 46 },
    { asin: 'BVSINKIN01', sales7d: 20, sales30d: 34, orderGrossProfit: -0.5, fbaAvailable: 14, fbaPendingTransfer: 25, fbaTransferring: 36, fbaInbound: 47 },
  ];
  const metricCapturedAt = new Date(Date.now() + 1000).toISOString();
  const fixtureDb = new InventoryDatabase(stateRoot);
  fixtureDb.syncLingxing({ role: 'admin', items: visibilityMetrics, capturedAt: metricCapturedAt, requestId: requestId('visibility-metrics-live') });
  fixtureDb.close();
  const visibilitySpecs = [
    { model: 'SYNTH-TONER-001', category: '硒鼓', plan: 'TEST-PLAN-TONER', date: '2026-02-10', version: 'V11', fnsku: 'TEST-FNSKU-TONER-02', kind: 'allocation', asin: 'BVSTONAL01' },
    { model: 'SYNTH-TONER-001', category: '硒鼓', plan: 'TEST-PLAN-TONER', date: '2026-02-10', version: 'V11', fnsku: 'TEST-FNSKU-TONER-02', kind: 'inquiry', asin: 'BVSTONIN01' },
    { model: 'SYNTH-INK-001', category: '墨盒', plan: 'TEST-PLAN-INK-B', date: '2026-03-01', version: 'V4', fnsku: 'TEST-FNSKU-INK-02', kind: 'allocation', asin: 'BVSINKAL01' },
    { model: 'SYNTH-INK-001', category: '墨盒', plan: 'TEST-PLAN-INK-B', date: '2026-03-01', version: 'V4', fnsku: 'TEST-FNSKU-INK-02', kind: 'inquiry', asin: 'BVSINKIN01' },
  ];
  const teamStockBatchKeys = new Map();
  const scopedStockDb = new InventoryDatabase(stateRoot);
  for (const spec of visibilitySpecs) for (const department of ['一团', '二团']) {
    const key = `${spec.model}|${department}`;
    if (teamStockBatchKeys.has(key)) continue;
    const source = visibilitySpecs.find(item => item.model === spec.model);
    const sourceFnsku = `XTEAM-${spec.model.replace(/[^A-Z0-9]/gi, '')}-${department === '一团' ? 'ONE' : 'TWO'}`;
    const at = new Date().toISOString();
    const transit = scopedStockDb.db.prepare(`INSERT INTO transit_batches(
      model,quantity,remaining_quantity,plan,ship_date,version,fnsku,brand,transport_method,shipping_method,team,
      logistics_status,on_shelf_indicator,status,source_row,revision,created_at,updated_at,on_shelf_by_role,on_shelf_at,pack_per_box
    ) VALUES(?,100,0,?,?,?,?,'','','整柜',?,'已签收','已上架','on_shelf',1,1,?,?, 'admin', ?, '3')`)
      .run(spec.model, source.plan, source.date, source.version, sourceFnsku, department, at, at, at);
    const batchKey = `${spec.model}#${source.plan}#${source.date}#${source.version}#${sourceFnsku}`;
    scopedStockDb.db.prepare(`INSERT INTO stock_batches(
      batch_key,model,plan,ship_date,version,fnsku,base_quantity,updated_at,revision,created_by_import_id,
      created_by_transit_id,is_legacy_placeholder,warehouse,pack_per_box
    ) VALUES(?,?,?,?,?,?,0,?,1,NULL,?,0,?, '3')`)
      .run(batchKey, spec.model, source.plan, source.date, source.version, sourceFnsku, at, Number(transit.lastInsertRowid), 'SyntheticWarehouseA');
    scopedStockDb.db.prepare(`INSERT INTO stock_receipts(transit_id,batch_key,quantity,created_by_role,created_at,request_id,ledger_watermark)
      VALUES(?,?,100,'admin',?,?,0)`).run(Number(transit.lastInsertRowid), batchKey, at, `approval-team-source-${key}`);
    teamStockBatchKeys.set(key, batchKey);
  }
  scopedStockDb.close();
  const visibilityDocs = { allocations: [], inquiries: [] };
  for (const spec of visibilitySpecs) for (const department of ['一团', '二团']) {
    const sharedFields = { model: spec.model, department, store: 'AUS', operator: '同名运营', fnsku: spec.fnsku, asin: spec.asin, operatorNote: 'visibility-fixture' };
    if (spec.kind === 'allocation') {
      const created = await api('POST', '/api/allocations', 'admin', { ...sharedFields, sourceBatchKey: teamStockBatchKeys.get(`${spec.model}|${department}`), plan: spec.plan, date: spec.date, version: spec.version, quantity: 3, requestId: requestId('visibility-' + spec.asin + '-' + department) });
      assert.equal(created.record.createdByRole, 'admin');
      assert.equal(created.record.lingxing.orderGrossProfit, visibilityMetrics.find(item => item.asin === spec.asin).orderGrossProfit);
      visibilityDocs.allocations.push({ ...spec, department, record: created.record });
    } else {
      const created = await api('POST', '/api/inquiries', 'admin', { ...sharedFields, quantity: 3, requestId: requestId('visibility-' + spec.asin + '-' + department) });
      assert.equal(created.record.createdByRole, 'admin');
      assert.equal(created.record.lingxing.orderGrossProfit, visibilityMetrics.find(item => item.asin === spec.asin).orderGrossProfit);
      visibilityDocs.inquiries.push({ ...spec, department, record: created.record });
    }
  }
  await role(page, 'business');
  await approvals(page);
  await page.getByLabel('搜索运营姓名、型号或 ASIN', { exact: true }).fill('BVS');
  await expand(page, 'SYNTH-TONER-001');
  const calculationSource = visibilityDocs.allocations.find(row => row.asin === 'BVSTONAL01' && row.department === '一团');
  const calculationRow = record(page, calculationSource.record.documentNo);
  const calculation = calculationRow.getByLabel(`计算-调货后倍数 ${calculationSource.record.documentNo}`);
  await calculationRow.getByLabel('审核数量', { exact: true }).fill('30');
  assert.equal(await calculation.innerText(), '3.3 倍');
  await calculationRow.getByLabel('审核数量', { exact: true }).fill('80');
  assert.equal(await calculation.innerText(), '3.5 倍');
  const independentSource = visibilityDocs.inquiries.find(row => row.asin === 'BVSTONIN01' && row.department === '一团');
  const independentRow = record(page, independentSource.record.documentNo);
  assert.equal(await independentRow.getByLabel(`计算-调货后倍数 ${independentSource.record.documentNo}`).innerText(), '3.7 倍');
  await calculationRow.getByLabel('审核数量', { exact: true }).fill('1.5');
  assert.equal(await calculation.innerText(), '—');
  await calculationRow.getByLabel('审核数量', { exact: true }).fill('');
  assert.equal(await calculation.innerText(), '—');
  const unsaved = (await api('GET', '/api/approvals', 'business')).allocations.find(row => row.id === calculationSource.record.id);
  assert.equal(unsaved.approvedQuantity, null);
  assert.equal(unsaved.coverageAfter, calculationSource.record.coverageAfter);
  check('商务实时试算按当前输入独立计算示例3.3/3.5倍；无效输入为空且不写库或覆盖已保存倍数', true);
  const hiddenProfitRoles = new Set(['assistant-1', 'assistant-2', 'purchasing']);
  const inspectVisibility = async (currentRole, expectedMetrics = visibilityMetrics) => {
    const result = await api('GET', '/api/approvals', currentRole);
    const hidden = hiddenProfitRoles.has(currentRole);
    const group = currentRole === 'operation-1' || currentRole === 'assistant-1' ? '一团' : currentRole === 'operation-2' || currentRole === 'assistant-2' ? '二团' : null;
    const records = [...result.allocations.filter(row => row.asin.startsWith('BVS')), ...result.inquiries.filter(row => row.asin.startsWith('BVS'))];
    assert.equal(records.length, group ? 4 : 8, currentRole + ' 标记单据数量');
    assert.equal(result.allocations.filter(row => row.asin.startsWith('BVS')).length, group ? 2 : 4);
    assert.equal(result.inquiries.filter(row => row.asin.startsWith('BVS')).length, group ? 2 : 4);
    assert.ok(records.every(row => !group || row.department === group), currentRole + ' 只按单据 department 返回本团记录');
    assert.ok(records.every(row => row.createdByRole === 'admin' && row.operator === '同名运营' && row.store === 'AUS'), '归属不依据提交角色、运营姓名或店铺');
    const expectedByAsin = new Map(expectedMetrics.map(item => [item.asin, item]));
    for (const row of records) {
      const expected = expectedByAsin.get(row.asin);
      assert.ok(row.lingxing, row.documentNo + ' 保留领星指标');
      assert.equal(row.lingxing.sales7d, expected.sales7d);
      assert.equal(row.lingxing.sales30d, expected.sales30d);
      assert.equal(row.lingxing.fbaAvailable, expected.fbaAvailable);
      assert.equal(row.lingxing.fbaPendingTransfer, expected.fbaPendingTransfer);
      assert.equal(row.lingxing.fbaTransferring, expected.fbaTransferring);
      assert.equal(row.lingxing.fbaInbound, expected.fbaInbound);
      assert.equal(row.lingxing.scope, 'all_stores');
      assert.equal(Object.hasOwn(row.lingxing, 'orderGrossProfit'), !hidden);
      if (!hidden) assert.equal(row.lingxing.orderGrossProfit, expected.orderGrossProfit);
      else assert.ok(row.lingxing.orderGrossProfit === undefined);
    }
    for (const model of ['SYNTH-TONER-001', 'SYNTH-INK-001']) {
      const visibleTotal = records.filter(row => row.model === model).reduce((sum, row) => sum + row.requestedQuantity, 0);
      assert.equal(visibleTotal, group ? 6 : 12, currentRole + ' ' + model + ' 汇总只包含可见单据');
    }
    return result;
  };
  for (const currentRole of ['admin', 'assistant-1', 'assistant-2', 'business', 'operation-1', 'operation-2', 'purchasing']) await inspectVisibility(currentRole);
  check('七种角色的实时指标接口覆盖两团、两类商品及调拨/询库；运营和助理只按 department 过滤，型号合计仅计可见单据', true);

  for (const hiddenRole of ['assistant-1', 'assistant-2', 'purchasing']) for (const model of ['SYNTH-TONER-001', 'SYNTH-INK-001']) {
    const allocation = visibilityDocs.allocations.find(row => row.model === model && row.department === (hiddenRole === 'assistant-2' ? '二团' : '一团'));
    const query = await api('GET', '/api/allocations?model=' + encodeURIComponent(model), hiddenRole);
    const queried = Object.values(query.records).flat().find(row => row.id === allocation.record.id);
    assert.ok(queried && !Object.hasOwn(queried.lingxing, 'orderGrossProfit'));
    assert.equal(queried.lingxing.sales7d, visibilityMetrics.find(item => item.asin === allocation.asin).sales7d);
    assert.ok(!JSON.stringify(query.publicRecords).includes('orderGrossProfit'));
    const history = await api('GET', '/api/allocations/' + allocation.record.id + '/history', hiddenRole);
    assert.ok(!Object.hasOwn(history.document.lingxing, 'orderGrossProfit'));
    assert.equal(history.document.lingxing.fbaInbound, visibilityMetrics.find(item => item.asin === allocation.asin).fbaInbound);
    const eventId = history.events.find(event => event.type === 'entry').id;
    const auditDetail = await api('GET', '/api/audit/' + eventId, hiddenRole);
    assert.ok(!Object.hasOwn(auditDetail.document.lingxing, 'orderGrossProfit'));
    assert.equal(auditDetail.document.lingxing.sales30d, visibilityMetrics.find(item => item.asin === allocation.asin).sales30d);
  }
  check('助理/采购的两类调拨查询、历史详情和库存流水详情均不返回毛利润，其他领星指标保留', true);

  const expectedGrossProfit = new Map(visibilityMetrics.map(item => [item.asin, item.orderGrossProfit]));
  for (const fixture of visibilityDocs.allocations) {
    const reviewed = await api('POST', '/api/allocations/' + fixture.record.id + '/review', 'business', { decision: 'approve', approvedQuantity: 3, expectedRevision: fixture.record.revision, requestId: requestId('visibility-review-allocation') });
    assert.equal(reviewed.record.lingxing.orderGrossProfit, expectedGrossProfit.get(fixture.asin));
    const confirmed = await api('POST', '/api/allocations/' + fixture.record.id + '/confirm', fixture.department === '一团' ? 'assistant-1' : 'assistant-2', { expectedRevision: reviewed.record.revision, requestId: requestId('visibility-confirm-allocation') });
    assert.ok(!Object.hasOwn(confirmed.record.lingxing, 'orderGrossProfit'));
    assert.equal(confirmed.record.lingxing.sales7d, visibilityMetrics.find(item => item.asin === fixture.asin).sales7d);
    fixture.record = confirmed.record;
  }
  for (const fixture of visibilityDocs.inquiries) {
    const reviewed = await api('POST', '/api/inquiries/' + fixture.record.id + '/review', 'business', { decision: 'approve', approvedQuantity: 3, expectedRevision: fixture.record.revision, requestId: requestId('visibility-review-inquiry') });
    assert.equal(reviewed.record.lingxing.orderGrossProfit, expectedGrossProfit.get(fixture.asin));
    const replied = await api('POST', '/api/inquiries/' + fixture.record.id + '/reply', 'purchasing', { supplierQuantity: 3, shippingWarehouse: 'CA', expectedRevision: reviewed.record.revision, requestId: requestId('visibility-reply-inquiry') });
    assert.ok(!Object.hasOwn(replied.record.lingxing, 'orderGrossProfit'));
    assert.equal(replied.record.lingxing.sales30d, visibilityMetrics.find(item => item.asin === fixture.asin).sales30d);
    const archived = await api('POST', '/api/inquiries/' + fixture.record.id + '/archive', fixture.department === '一团' ? 'assistant-1' : 'assistant-2', { plan: 'FBA-VISIBILITY', date: '2026-09-22', version: 'V1', expectedRevision: replied.record.revision, requestId: requestId('visibility-archive-inquiry') });
    assert.ok(!Object.hasOwn(archived.record.lingxing, 'orderGrossProfit'));
    fixture.record = archived.record;
  }
  const changedMetrics = visibilityMetrics.map(item => ({ ...item, sales7d: item.sales7d + 100, sales30d: item.sales30d + 100, orderGrossProfit: item.orderGrossProfit + 1000 }));
  const snapshotDb = new InventoryDatabase(stateRoot);
  snapshotDb.syncLingxing({ role: 'admin', items: changedMetrics, capturedAt: new Date(Date.now() + 5000).toISOString(), requestId: requestId('visibility-metrics-after-snapshot') });
  snapshotDb.close();
  for (const currentRole of ['admin', 'assistant-1', 'assistant-2', 'business', 'operation-1', 'operation-2', 'purchasing']) await inspectVisibility(currentRole);
  const staleAllocation = visibilityDocs.allocations[0];
  const assistantConflict = await api('POST', '/api/allocations/' + staleAllocation.record.id + '/confirm', 'assistant-1', { expectedRevision: staleAllocation.record.revision - 1, requestId: requestId('visibility-stale-confirm') }, 409);
  assert.ok(!Object.hasOwn(assistantConflict.details.current.lingxing, 'orderGrossProfit'));
  assert.equal(assistantConflict.details.current.lingxing.sales7d, visibilityMetrics.find(item => item.asin === staleAllocation.asin).sales7d);
  const staleInquiry = visibilityDocs.inquiries[0];
  const purchasingConflict = await api('POST', '/api/inquiries/' + staleInquiry.record.id + '/reply', 'purchasing', { supplierQuantity: 3, shippingWarehouse: 'CA', expectedRevision: staleInquiry.record.revision - 1, requestId: requestId('visibility-stale-reply') }, 409);
  assert.ok(!Object.hasOwn(purchasingConflict.details.current.lingxing, 'orderGrossProfit'));
  assert.equal(purchasingConflict.details.current.lingxing.sales7d, visibilityMetrics.find(item => item.asin === staleInquiry.asin).sales7d);
  check('确认/采购回复/助理归档结果与 details.current 隐藏毛利润；后续同步不覆盖单据历史快照', true);

  for (const currentRole of ['admin', 'assistant-1', 'assistant-2', 'business', 'operation-1', 'operation-2', 'purchasing']) {
    await role(page, currentRole);
    await approvals(page);
    await page.getByLabel('搜索运营姓名、型号或 ASIN', { exact: true }).fill('BVS');
    for (const model of ['SYNTH-TONER-001', 'SYNTH-INK-001']) {
      const modelGroup = page.locator('.approval-model-group[data-model="' + model + '"]');
      await modelGroup.waitFor();
      if (await modelGroup.locator('.approval-expand').getAttribute('aria-expanded') === 'false') await modelGroup.locator('.approval-expand').click();
    }
    const group = currentRole === 'operation-1' || currentRole === 'assistant-1' ? '一团' : currentRole === 'operation-2' || currentRole === 'assistant-2' ? '二团' : null;
    const expectedPerModel = group ? 2 : 4;
    const hidesProfit = hiddenProfitRoles.has(currentRole);
    for (const model of ['SYNTH-TONER-001', 'SYNTH-INK-001']) {
      const modelGroup = page.locator('.approval-model-group[data-model="' + model + '"]');
      const rows = modelGroup.locator('.approval-record');
      await page.waitForFunction(({ model, expected }) => document.querySelectorAll('.approval-model-group[data-model="' + model + '"] .approval-record').length === expected, { model, expected: expectedPerModel });
      assert.equal(await rows.count(), expectedPerModel, currentRole + ' ' + model + ' 可见 fixture 单据数');
      const expectedTotal = group ? '6' : '12';
      assert.equal(await modelGroup.locator('[data-field="申请数量合计"]').innerText(), expectedTotal);
      assert.equal(await modelGroup.locator('[data-field="商务审核数量合计"]').innerText(), expectedTotal);
      const headers = await modelGroup.locator('.approval-document-table thead th').allTextContents();
      assert.equal(headers.includes('订单毛利润（USD）'), !hidesProfit);
      const cells = await rows.evaluateAll(elements => elements.map(element => {
        const tds = [...element.querySelectorAll('.approval-data-row > td')];
        return {
          department: tds[6]?.textContent?.trim(),
          asin: tds[10]?.textContent?.trim(),
          profit: element.querySelector('[data-field="订单毛利润（USD）"] .approval-metric-value')?.textContent?.trim(),
          metricCount: element.querySelectorAll('.approval-metric-value').length,
          hasSales: Boolean(element.querySelector('[data-field="7 天销量"] .approval-metric-value')),
          hasFbaTransit: Boolean(element.querySelector('[data-field="FBA 在途"] .approval-metric-value')),
        };
      }));
      assert.ok(cells.every(cell => !group || cell.department === group), currentRole + ' 页面仅保留当前团队行');
      assert.ok(cells.every(cell => cell.metricCount === (hidesProfit ? 6 : 7) && cell.hasSales && cell.hasFbaTransit));
      if (hidesProfit) assert.ok(cells.every(cell => cell.profit === undefined));
      else for (const cell of cells) assert.equal(Number(cell.profit), expectedGrossProfit.get(cell.asin));
    }
  }
  const missingMetricInquiry = (await api('POST', '/api/inquiries', 'admin', {
    model: 'SYNTH-TONER-001', quantity: 1, department: '一团', store: 'AUS', operator: '缺指标测试', fnsku: 'XNOMTRC001', asin: 'BNOMTRC001', requestId: requestId('calculation-missing-metric'),
  })).record;
  const zeroSalesInquiry = (await api('POST', '/api/inquiries', 'admin', {
    model: 'SYNTH-TONER-001', quantity: 1, department: '一团', store: 'BUS', operator: '零销量测试', fnsku: 'XZEROSALE01', asin: 'BUIINQ0001', requestId: requestId('calculation-zero-sales'),
  })).record;
  await role(page, 'business');
  await approvals(page);
  await page.getByLabel('搜索运营姓名、型号或 ASIN', { exact: true }).fill('BNOMTRC001');
  await expand(page, 'SYNTH-TONER-001');
  const missingRow = record(page, missingMetricInquiry.documentNo);
  assert.equal(await missingRow.getByLabel(`计算-调货后倍数 ${missingMetricInquiry.documentNo}`).innerText(), '—');
  await page.getByLabel('搜索运营姓名、型号或 ASIN', { exact: true }).fill('BUIINQ0001');
  const zeroSalesRow = record(page, zeroSalesInquiry.documentNo);
  await zeroSalesRow.waitFor();
  await zeroSalesRow.getByLabel('审核数量', { exact: true }).fill('80');
  assert.equal(await zeroSalesRow.getByLabel(`计算-调货后倍数 ${zeroSalesInquiry.documentNo}`).innerText(), '无销量');
  check('试算指标缺失显示—，30天销量为0显示无销量', true);
  check('页面角色切换覆盖七种角色；列数、毛利润零值/负值、团队明细及型号数量合计同步变化', true);
  await page.screenshot({path:path.join(output,"inquiry-zero.png"),fullPage:true});
  check("页面流程没有 JavaScript 运行错误", errors.length === 0);
  await fs.writeFile(path.join(output, "approvals-ui-result.json"), JSON.stringify({ passed, errors, allocationId: allocation.id, inquiryId: inquiry.id, screenshotDirectory: output }, null, 2));
  console.log(`APPROVALS_UI_RESULT: ALL PASS (${passed} checks); screenshots=${output}`);
} catch(error) {
  console.error(error);
  for(const page of browser?.contexts().flatMap(context=>context.pages())??[]) if(await page.locator('.dialog-mask:visible').count()) await page.screenshot({path:path.join(output,'failed-dialog.png'),fullPage:true});
  throw error;
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) { const closed = new Promise((resolve) => server.once("close", resolve)); server.kill(); await closed; }
  assert.ok(path.relative(os.tmpdir(), stateRoot).startsWith("aster-approvals-ui-") && !path.relative(os.tmpdir(), stateRoot).includes(".."), "只清理本测试生成的临时目录");
  await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
