// 仅隔离 DOM fixture；不连接领星、不复用用户浏览器、不写库存数据库。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = await fs.readFile(path.join(root, "scripts/lingxing-page-collector.js"), "utf8");
const output = path.resolve(process.env.ASTER_LINGXING_RESULT || path.join(root, ".test-output/lingxing-page-script-fixture-result.json"));
const executablePath = [process.env.ASTER_BROWSER_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fsSync.existsSync);
assert.ok(executablePath, "缺少隔离 fixture 浏览器");
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>FIXTURE ONLY — not Lingxing</title>
<style>body{font:16px sans-serif}.body--wrapper{width:400px;overflow:auto}table{border-collapse:collapse}th,td{min-width:120px}.hidden{display:none}</style>
<div>FIXTURE ONLY：全部数值均为测试样例</div><button id="tab-msku" aria-selected="false">MSKU</button><button id="reset"><span>重置</span></button>
<input placeholder="全部国家" readonly value="美国"><span id="stores">测试店铺</span>
<!-- 2026-09-20 保存的真实产品表现页：字段、模糊/精确和输入框并列，字段由标签显示。 -->
<div class="search-block"><div class="ak-advanced-input__new">
<div class="el-select field-select"><input readonly value="" id="searchType"><span class="fake-select-label" id="searchTypeLabel">MSKU</span><div id="typeOptions" class="el-select-dropdown" hidden><ul><li class="el-select-dropdown__item">ASIN</li></ul></div></div>
<div class="el-select search-mode-select"><input readonly value="模糊"></div><div class="search-input el-input"><input id="search"></div>
</div></div><button id="tab-asin">ASIN</button>
<div class="el-input"><input readonly id="currency" value="原币种"></div>
<ul id="currencyOptions" hidden><li class="el-select-dropdown__item">USD</li></ul>
<div class="el-popover__reference" aria-describedby="dateOptions"><input placeholder="开始日期" readonly value="2026-09-08"><input placeholder="结束日期" readonly value="2026-09-08"></div>
<div id="dateOptions" class="el-popover" hidden><ul class="el-cascader-menu__list"><li class="el-cascader-node is-leaf-node" role="menuitem"><div class="el-cascader-node__label">近30天</div></li><li class="el-cascader-node is-leaf-node" role="menuitem"><div class="el-cascader-node__label">近7天</div></li><li class="el-cascader-node is-leaf-node" role="menuitem"><div class="el-cascader-node__label">前30天</div></li></ul></div>
<button id="otherDate">近30天</button><div id="otherDatePanel"><li class="el-cascader-node is-leaf-node" role="menuitem">近30天</li></div>
<div id="pane-msku"></div><div id="report"><div id="count" class="el-pagination__total">共2条</div><div class="vxe-table--loading vxe-loading ak-loading-mask" hidden style="width:400px;height:20px"><div class="ak-loading-spinner">加载中</div></div>
<div class="vxe-table--header-wrapper body--wrapper"><table><thead><tr></tr></thead></table></div>
<div class="vxe-table--body-wrapper body--wrapper"><div style="width:2400px"></div></div>
<div class="vxe-table--footer-wrapper body--wrapper"><table><tfoot><tr></tr></tfoot></table></div>
<div class="fixed-left--wrapper"><div class="vxe-table--footer-wrapper"><table><tr><td>999999</td></tr></table></div></div></div>
<script>
window.fixture = { mode: 'normal', events: [], requests: 0, applied: [], dates: [], current: null };
const select = s => document.querySelector(s);
const data = {
 BFIXTURE01: { thirty: '1,234', seven: '21', profit: '$123.45', available:'90', pending:'11', moving:'22', inbound:'33' },
 BFIXTURE02: { thirty: '5,678', seven: '42', profit: '-$4.50', available:'1', pending:'2', moving:'3', inbound:'4' },
 BFIXTURE00: { thirty: '0', seven: '0', profit: '$0.00', available:'0', pending:'0', moving:'0', inbound:'0' }
};
let range = 30, displayedRange = 30, currentAsin = 'BFIXTURE01', generation = 0;
function renderColumns() {
 const row = data[currentAsin] || data.BFIXTURE01;
 const columns = [ ['ASIN',''], ['7天日均','999.9'], ['销量',displayedRange===30?'3466':'732'], ['7天销量',row.seven], ['30天销量',row.thirty], ['销售额','$999999'], ['订单毛利润',row.profit], ['FBA可售',row.available], ['FBA待调仓',row.pending], ['FBA调仓中',row.moving], ['FBA在途',row.inbound] ];
 if(fixture.mode === 'hidden-asin') columns.splice(0,1);
 if(fixture.mode === 'missing') columns.splice(-2,2);
 if(fixture.mode === 'missing-sales30') columns.splice(columns.findIndex(c=>c[0]==='30天销量'),1);
 if(fixture.mode === 'invalid') columns.find(c=>c[0]==='FBA可售')[1] = '--';
 const offset = Math.min(columns.length-2, Math.floor(select('.vxe-table--body-wrapper.body--wrapper').scrollLeft / 200));
 const visible = columns.slice(offset,offset+3);
 // 空占位格模拟 vxe 主表；主表头与底部必须保持按列对应。
 select('.vxe-table--header-wrapper.body--wrapper tr').innerHTML='<th></th>'+visible.map(c=>'<th>'+c[0]+'</th>').join('');
 select('.vxe-table--footer-wrapper.body--wrapper tr').innerHTML='<td></td>'+visible.map(c=>'<td>'+c[1]+'</td>').join('');
}
function query() {
 const queryId = ++generation; fixture.requests++;
 const asin = select('#search').value;
 if(!data[asin]) return;
 const selectedRange = range;
 fixture.events.push({asin, range:selectedRange, currency:select('#currency').value});
 if(fixture.mode!=='no-refresh') select('.ak-loading-mask').hidden=false;
 // 查询后立即重排仍是旧值；响应晚于750ms，不能把这次DOM变更当作已刷新。
 if(fixture.mode!=='no-refresh' && fixture.mode!=='same-no-dom') renderColumns();
 setTimeout(()=>{
  if(queryId!==generation || fixture.mode==='no-refresh') return;
  currentAsin=asin; displayedRange=selectedRange; fixture.current={asin,range:selectedRange}; fixture.applied.push({asin,range:selectedRange});
  if(fixture.mode!=='same-no-dom') {
   select('#count').textContent = fixture.mode==='empty' ? '共0条' : '共2条';
   select('.vxe-table--body-wrapper.body--wrapper > div').innerHTML=fixture.mode==='empty' ? '暂无数据' : (fixture.mode==='hidden-asin'?'':'<span>'+asin+'</span>')+'<p>MSKU-A 明细 999</p><p>MSKU-B 明细 888</p><p>订单毛利润明细 $125.93</p>';
   renderColumns();
  }
  select('.ak-loading-mask').hidden=true;
 }, 1100);
}
select('#tab-msku').onclick=()=>select('#tab-msku').setAttribute('aria-selected','true');
select('#reset').onclick=()=>{select('[placeholder="全部国家"]').value='';select('#stores').textContent='全部店铺';select('#search').value='';fixture.events.push({reset:true});};
select('#searchType').onclick=()=>{document.body.append(select('#typeOptions'));select('#typeOptions').hidden=false;};
select('#typeOptions li').onclick=()=>{select('#searchTypeLabel').textContent='ASIN';select('#typeOptions').hidden=true;};
select('#tab-asin').onclick=()=>{fixture.wrongTabClick=true;};
select('#currency').onclick=()=>select('#currencyOptions').hidden=false;
select('#currencyOptions li').onclick=()=>{select('#currency').value='USD';select('#currencyOptions').hidden=true;};
select('[placeholder="开始日期"]').onclick=()=>select('#dateOptions').hidden=false;
for(const option of document.querySelectorAll('#dateOptions li')) option.onclick=()=>{
 fixture.dates.push(option.textContent);range=option.textContent==='近30天'?30:7;
 select('[placeholder="开始日期"]').value=range===30?'2026-08-10':'2026-09-02';
 select('[placeholder="结束日期"]').value='2026-09-08';select('#dateOptions').hidden=true;query();
};
select('#otherDate').onclick=select('#otherDatePanel li').onclick=()=>{fixture.wrongDateClick=true;};
select('#search').addEventListener('keyup',event=>{if(event.key==='Enter')query();});
select('.vxe-table--body-wrapper.body--wrapper').addEventListener('scroll',renderColumns);
select('.vxe-table--body-wrapper.body--wrapper > div').innerHTML='BFIXTURE01<p>MSKU-A 明细 999</p>';
renderColumns();
</script></html>`;

const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`DOM FIXTURE PASS ${name}`); };
const errors = [];
const browser = await chromium.launch({ executablePath, headless: true });
let fixtureResult;
async function openFixture(mode = "normal") {
  const page = await browser.newPage({ locale: "zh-CN" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url() === "https://erp.lingxing.com/erp/productExpressionNew" ? route.fulfill({ contentType: "text/html", body: fixture }) : route.abort());
  await page.goto("https://erp.lingxing.com/erp/productExpressionNew");
  await page.evaluate((value) => { window.fixture.mode = value; }, mode);
  await page.addScriptTag({ content: script });
  return page;
}
try {
  const page = await openFixture();
  check("加载脚本不自动查询", await page.evaluate(() => fixture.requests) === 0);
  fixtureResult = await page.evaluate(() => asterLingxing.collectAsins([' bfixture01 ', 'BFIXTURE02', 'BFIXTURE01']));
  check("依次查询并去重 ASIN，完整输出七项", fixtureResult.items.length === 2 && Object.keys(fixtureResult.items[0]).length === 8);
  assert.deepEqual(fixtureResult.items[0], { asin: "BFIXTURE01", sales7d:21, sales30d:1234, orderGrossProfit:123.45, fbaAvailable:90, fbaPendingTransfer:11, fbaTransferring:22, fbaInbound:33 });
  check("横滚虚拟列按主底部总计取数，排除日均、明细和固定列副本", true);
  assert.deepEqual(fixtureResult.items[1], { asin: "BFIXTURE02", sales7d:42, sales30d:5678, orderGrossProfit:-4.5, fbaAvailable:1, fbaPendingTransfer:2, fbaTransferring:3, fbaInbound:4 });
  check("查询延迟刷新及连续ASIN不读取前一次值，负毛利保留", true);
  check("直接取7天销量/30天销量专用总计，排除普通销量列", fixtureResult.source.captures[0].range30d.startDate === "2026-08-10" && fixtureResult.source.captures[0].totals30d['30天销量'] === "1,234" && fixtureResult.source.captures[0].totals30d['7天销量'] === "21" && fixtureResult.source.captures[0].resultCount30d === 2);
  check("每个ASIN只查近30天，删除近7天额外查询", await page.evaluate(() => fixture.events.filter(e=>e.asin).every(e=>e.range===30)) && !('range7d' in fixtureResult.source.captures[0]));
  check('只选择当前日期面板的近30天菜单项，不点击同名按钮、其他面板、前30天或近7天', await page.evaluate(()=>!fixture.wrongDateClick&&fixture.dates.length===2&&fixture.dates.every(value=>value==='近30天')));
  check('保留可见商品行，明细999和888不混入总计', fixtureResult.source.captures.every(row => [row.visibleRows30d].every(rows => rows.some(text => text.includes(row.asin) && text.includes('MSKU-A 明细 999') && text.includes('MSKU-B 明细 888')))) && fixtureResult.items[0].sales30d === 1234 && fixtureResult.items[0].sales7d === 21);
  check("实际筛选为MSKU/全部国家/全部店铺/USD/ASIN", await page.evaluate(() => document.querySelector('#tab-msku').getAttribute('aria-selected') === 'true' && document.querySelector('[placeholder="全部国家"]').value === '' && document.querySelector('#stores').textContent === '全部店铺' && document.querySelector('#currency').value === 'USD' && document.querySelector('#searchTypeLabel').textContent === 'ASIN'));
  check('实际字段标签与空 input 值分离时仍正确选择ASIN，不点击同名ASIN页签或模糊选项', await page.evaluate(()=>!fixture.wrongTabClick&&document.querySelector('#searchType').value===''&&document.querySelector('.search-mode-select input').value==='模糊'));
  check('字段下拉展开后移动到body仍选择ASIN，并以原字段标签验证生效', await page.evaluate(()=>document.querySelector('#typeOptions').parentElement===document.body&&document.querySelector('#searchTypeLabel').textContent==='ASIN'));
  check("结果携带来源条件和时间且不混入明细行", fixtureResult.source.kind === "lingxing_product_performance_browser_script" && fixtureResult.source.conditions.currency === "USD" && !Number.isNaN(Date.parse(fixtureResult.capturedAt)));
  const zeroResult = await page.evaluate(() => asterLingxing.collectAsins(['BFIXTURE00']));
  check("同页可复用，有记录的0销量/0库存正确保存", Object.entries(zeroResult.items[0]).filter(([key])=>key!=="asin").every(([,value])=>value===0));
  await page.evaluate(() => { fixture.mode = 'same-no-dom'; });
  const unchangedResult = await page.evaluate(() => asterLingxing.collectAsins(['BFIXTURE00']));
  check("相同零销量没有文本更新时依靠加载完成正确读取", unchangedResult.items[0].sales7d === 0 && unchangedResult.items[0].sales30d === 0);
  const beforeInvalid = await page.evaluate(() => fixture.requests);
  const invalidAsin = await page.evaluate(() => asterLingxing.collectAsins(['bad']).catch(error=>error.message));
  check("非法ASIN在任何查询前拒绝", invalidAsin.includes("无效 ASIN") && await page.evaluate(() => fixture.requests) === beforeInvalid);
  await page.close();

  const resetField = await openFixture();
  await resetField.evaluate(()=>{
    const reset=document.querySelector('#reset'), applyReset=reset.onclick;
    reset.onclick=()=>{applyReset();document.querySelector('#searchTypeLabel').textContent='MSKU';};
    document.querySelector('#typeOptions li').onclick=()=>setTimeout(()=>{document.querySelector('#searchTypeLabel').textContent='ASIN';document.querySelector('#typeOptions').hidden=true;},300);
  });
  const resetResults=await resetField.evaluate(async()=>[await asterLingxing.collectAsins(['BFIXTURE01']),await asterLingxing.collectAsins(['BFIXTURE02'])]);
  check('重置把字段恢复为MSKU后重新选择ASIN，并等待显示标签更新；连续任务不沿用旧条件', resetResults[0].items[0].sales30d===1234&&resetResults[1].items[0].sales30d===5678);
  await resetField.close();

  const duplicateField = await openFixture();
  await duplicateField.evaluate(()=>document.querySelector('.search-block').append(document.querySelector('.field-select').cloneNode(true)));
  const duplicateError=await duplicateField.evaluate(()=>asterLingxing.collectAsins(['BFIXTURE01']).catch(error=>error.message));
  check('存在两个可见查询字段时保留唯一性校验，不猜选目标或开始取数', duplicateError.includes('无法找到唯一的“查询类型”')&&await duplicateField.evaluate(()=>fixture.requests)===0);
  await duplicateField.close();

  const hidden = await openFixture('hidden-asin');
  const hiddenResult = await hidden.evaluate(() => asterLingxing.collectAsins(['BFIXTURE01','BFIXTURE02']));
  check('ASIN列隐藏时仍按完整查询加载周期读取，两次不同ASIN不串结果', hiddenResult.items[0].sales30d === 1234 && hiddenResult.items[1].sales30d === 5678 && hiddenResult.source.captures.every(row=>row.visibleRows30d.every(text=>!text.includes(row.asin))));
  check('商品行毛利润与底部不一致时严格取底部总计', hiddenResult.source.captures[0].visibleRows30d.some(text=>text.includes('$125.93')) && hiddenResult.items[0].orderGrossProfit === 123.45);
  await hidden.close();

  const dropdown = await openFixture();
  await dropdown.evaluate(() => {
    const input = document.querySelector('#currency');
    const menu = document.querySelector('#currencyOptions');
    menu.innerHTML = '<div>USD</div>';
    input.onclick = () => setTimeout(() => { menu.hidden = false; }, 600);
    menu.firstElementChild.onclick = () => setTimeout(() => { input.value = 'USD'; menu.hidden = true; }, 250);
  });
  const delayed = await dropdown.evaluate(() => asterLingxing.collectAsins(['BFIXTURE01']));
  check('币种下拉延迟展开、div选项和延迟回填仍正确选择USD', delayed.source.conditions.currency === 'USD' && delayed.items[0].orderGrossProfit === 123.45);
  await dropdown.evaluate(() => {
    const input = document.querySelector('#currency');
    const menu = document.querySelector('#currencyOptions');
    input.value = '原币种'; menu.hidden = false;
    input.onclick = () => { menu.hidden = !menu.hidden; };
  });
  const reopened = await dropdown.evaluate(() => asterLingxing.collectAsins(['BFIXTURE01']));
  check('失败重跑时币种菜单已经展开，不再次点击把菜单收起', reopened.items[0].orderGrossProfit === 123.45);
  await dropdown.close();

  const focusedCurrency = await openFixture();
  await focusedCurrency.evaluate(() => {
    const input=document.querySelector('#currency'),menu=document.querySelector('#currencyOptions');
    input.onclick=null;
    input.onfocus=()=>setTimeout(()=>{menu.hidden=false;},600);
  });
  const focusResult=await focusedCurrency.evaluate(()=>asterLingxing.collectAsins(['BFIXTURE01']));
  check('币种输入框需要聚焦才展开时，仍完成USD选择并读取底部七项',focusResult.source.conditions.currency==='USD'&&focusResult.items[0].orderGrossProfit===123.45);
  await focusedCurrency.close();

  const toggleCurrency = await openFixture();
  await toggleCurrency.evaluate(()=>{
    const input=document.querySelector('#currency'),menu=document.querySelector('#currencyOptions');
    input.onfocus=()=>{menu.hidden=false;};
    input.onclick=()=>{menu.hidden=!menu.hidden;};
  });
  const toggleResult=await toggleCurrency.evaluate(()=>asterLingxing.collectAsins(['BFIXTURE01']));
  check('聚焦已展开币种菜单后不再点击收起，按实际USD继续查询',toggleResult.items[0].sales30d===1234);
  await toggleCurrency.close();

  const backgroundDropdown = await openFixture();
  await backgroundDropdown.evaluate(() => {
    // 真实 #36—#38：display:block，入场类未退出，scaleY(0) 导致可见高度为0。
    fixture.frameRequests = 0;
    window.requestAnimationFrame = () => { fixture.frameRequests++; return 1; };
    const style = document.createElement('style');
    style.textContent = '.el-zoom-in-top-enter,.el-zoom-in-top-leave-active{opacity:0;transform:scaleY(0)}';
    document.head.append(style);
    const input = document.querySelector('#currency'), menu = document.querySelector('#currencyOptions');
    menu.classList.add('el-select-dropdown');
    input.onclick = () => {
      menu.hidden = false;
      menu.classList.remove('el-zoom-in-top-leave-active');
      menu.classList.add('el-zoom-in-top-enter','el-zoom-in-top-enter-active');
    };
    menu.firstElementChild.onclick = () => {
      input.value = 'USD';
      menu.classList.add('el-zoom-in-top-leave-active');
    };
  });
  const backgroundResult = await backgroundDropdown.evaluate(() => asterLingxing.collectAsins(['BFIXTURE01','BFIXTURE02']));
  check('后台动画帧暂停、已打开USD下拉缩放为0时仍完成选择，连续ASIN保留各自七项总计', backgroundResult.items[0].orderGrossProfit === 123.45 && backgroundResult.items[1].sales30d === 5678);
  check('采集过程不请求动画帧，后台冻结RAF不会阻断下拉、日期或横滚取数', await backgroundDropdown.evaluate(() => fixture.frameRequests === 0));
  check('已关闭的下拉不因入场样式被重新展开', await backgroundDropdown.locator('#currencyOptions').evaluate(e => e.getBoundingClientRect().height) === 0);
  await backgroundDropdown.evaluate(() => {
    document.querySelector('#currency').value = '原币种';
    document.querySelector('#currency').onclick = null;
    document.querySelector('#currencyOptions').hidden = true;
  });
  const closedError = await backgroundDropdown.evaluate(() => asterLingxing.collectAsins(['BFIXTURE01']).catch(error => error.message));
  check('未打开的菜单仍拒绝选择，不以取消入场动画绕过USD生效检查', closedError.includes('5秒内未找到可见选项'));
  await backgroundDropdown.close();

  const lateDropdownBackfill = await openFixture();
  await lateDropdownBackfill.evaluate(() => {
    const schedule = window.setTimeout.bind(window);
    const input = document.querySelector('#currency');
    const menu = document.querySelector('#currencyOptions');
    fixture.lateMenuOpened = false;
    fixture.lateCurrencyBackfilled = false;
    input.onclick = () => {
      schedule(() => { menu.hidden = false; fixture.lateMenuOpened = true; }, 5100);
    };
    window.setTimeout = (callback, ms, ...args) => {
      if (ms >= 4900 && ms <= 5000) return schedule(callback, ms + 200, ...args);
      return schedule(callback, ms, ...args);
    };
    menu.firstElementChild.onclick = () => queueMicrotask(() => {
      input.value = 'USD';
      fixture.lateCurrencyBackfilled = true;
    });
  });
  const lateDropdownResult = await lateDropdownBackfill.evaluate(() => asterLingxing.collectAsins(['BFIXTURE01']));
  check('菜单在旧5秒期限后才出现时仍只点击一次，并等待异步属性回填，不因过期期限立即失败', lateDropdownResult.source.conditions.currency === 'USD' && lateDropdownResult.items[0].sales30d === 1234 && await lateDropdownBackfill.evaluate(() => fixture.lateMenuOpened && fixture.lateCurrencyBackfilled));
  await lateDropdownBackfill.close();

  const delayedPageTimer = await openFixture();
  await delayedPageTimer.evaluate(() => {
    const schedule = window.setTimeout.bind(window);
    const input = document.querySelector('#currency');
    const menu = document.querySelector('#currencyOptions');
    fixture.pageTimerDelayMs = 0;
    input.onclick = () => schedule(() => { menu.hidden = false; }, 80);
    window.setTimeout = (callback, ms, ...args) => {
      if (ms >= 4500 && ms <= 5000) {
        fixture.pageTimerDelayMs = 60000;
        return schedule(callback, ms + fixture.pageTimerDelayMs, ...args);
      }
      return schedule(callback, ms, ...args);
    };
    menu.firstElementChild.onclick = () => queueMicrotask(() => { input.value = 'USD'; });
  });
  const delayedTimerResult = await delayedPageTimer.evaluate(() => asterLingxing.collectAsins(['BFIXTURE01']));
  check('页面5秒回退计时器模拟迟到60秒时，USD菜单DOM变化仍即时唤醒采集', delayedTimerResult.source.conditions.currency === 'USD' && delayedTimerResult.items[0].sales30d === 1234 && await delayedPageTimer.evaluate(() => fixture.pageTimerDelayMs === 60000));
  await delayedPageTimer.close();

  const dates = await openFixture();
  await dates.evaluate(() => {
    const input = document.querySelector('[placeholder="开始日期"]');
    const menu = document.querySelector('#dateOptions');
    input.onclick = null;
    input.onfocus = () => setTimeout(() => { menu.hidden = false; }, 600);
    for (const item of menu.querySelectorAll('li')) {
      const apply = item.onclick;
      const option = item.cloneNode(true);
      option.onclick = () => setTimeout(apply, 250);
      item.replaceWith(option);
    }
  });
  const delayedDates = await dates.evaluate(() => asterLingxing.collectAsins(['BFIXTURE01']));
  check('日期输入框需获得焦点才展开，延迟显示的真实级联菜单项仍可选择', delayedDates.items[0].sales30d === 1234 && delayedDates.items[0].sales7d === 21);
  check('日期选中后等待近30天实际范围回填', delayedDates.source.captures[0].range30d.startDate === '2026-08-10' && delayedDates.source.captures[0].range30d.endDate === '2026-09-08');
  await dates.close();

  const openDates = await openFixture();
  await openDates.evaluate(() => {
    const menu = document.querySelector('#dateOptions');
    menu.hidden = false;
    document.querySelector('[placeholder="开始日期"]').onclick = () => { menu.hidden = !menu.hidden; };
  });
  const openDateResult = await openDates.evaluate(() => asterLingxing.collectAsins(['BFIXTURE01']));
  check('重跑时日期面板已展开，直接选择日期而不点击收起', openDateResult.items[0].sales30d === 1234 && openDateResult.items[0].sales7d === 21);
  await openDates.close();

  const closingDates = await openFixture();
  await closingDates.evaluate(() => {
    // #42 真实后台 DOM：关闭动画未结束，旧近30天仍有尺寸且保留选中态。
    window.requestAnimationFrame = () => 1;
    const menu = document.querySelector('#dateOptions');
    const input = document.querySelector('[placeholder="开始日期"]');
    const end = document.querySelector('[placeholder="结束日期"]');
    const option = menu.querySelector('li');
    const style = document.createElement('style');
    style.textContent = '.fade-in-linear-leave-active{opacity:0}';
    document.head.append(style);
    fixture.dateOpens = 0;
    const reset = document.querySelector('#reset'), applyReset = reset.onclick;
    reset.onclick = () => { applyReset(); input.value = end.value = '2026-09-08'; };
    input.onclick = () => {
      fixture.dateOpens++;
      menu.hidden = false;
      menu.classList.remove('fade-in-linear-leave-active');
      if (input.value === end.value) option.classList.remove('is-active');
    };
    const applyDate = option.onclick;
    option.onclick = () => {
      if (option.classList.contains('is-active')) return;
      applyDate();
      option.classList.add('is-active');
      menu.hidden = false;
      menu.classList.add('fade-in-linear-leave-active');
    };
  });
  const closingDateResults = await closingDates.evaluate(async () => [
    await asterLingxing.collectAsins(['BFIXTURE01']),
    await asterLingxing.collectAsins(['BFIXTURE02']),
  ]);
  check('日期面板停在关闭动画时重新打开，逐ASIN重置后仍得到30天及各自总计', closingDateResults[0].items[0].sales30d === 1234 && closingDateResults[1].items[0].sales30d === 5678 && closingDateResults.every(result => result.source.captures[0].range30d.startDate === '2026-08-10'));
  check('每次日期选择只打开一次、点击一次，不以重复点击修复旧选项', await closingDates.evaluate(() => fixture.dateOpens === 2 && fixture.dates.length === 2));
  await closingDates.close();

  const delayedDateChange = await openFixture();
  await delayedDateChange.evaluate(() => {
    const schedule = window.setTimeout.bind(window);
    const option = document.querySelector('#dateOptions li'), apply = option.onclick;
    option.onclick = () => schedule(apply, 250);
  });
  const delayedDateResult = await delayedDateChange.evaluate(() => asterLingxing.collectAsins(['BFIXTURE01']));
  check('日期控件异步回填通过DOM变化唤醒，无100毫秒页面轮询', delayedDateResult.source.captures[0].range30d.startDate === '2026-08-10' && delayedDateResult.items[0].sales30d === 1234);
  await delayedDateChange.close();

  const observedQuery = await openFixture();
  await observedQuery.evaluate(() => {
    const schedule = window.setTimeout.bind(window);
    const option = document.querySelector('#dateOptions li'), apply = option.onclick;
    fixture.pagePollTimers = 0;
    option.onclick = () => { apply(); };
    window.setTimeout = (callback, ms, ...args) => {
      if (ms === 100) fixture.pagePollTimers++;
      return schedule(callback, ms, ...args);
    };
  });
  const observedQueryResult = await observedQuery.evaluate(() => asterLingxing.collectAsins(['BFIXTURE02']));
  check('报表加载遮罩及主表变更唤醒查询稳定判断，完整取数且不使用100毫秒轮询', observedQueryResult.items[0].sales30d === 5678 && observedQueryResult.items[0].sales7d === 42 && await observedQuery.evaluate(() => fixture.pagePollTimers === 0));
  await observedQuery.close();

  const duplicateDate = await openFixture();
  await duplicateDate.evaluate(()=>{
    const menu=document.querySelector('#dateOptions ul');
    menu.append(menu.firstElementChild.cloneNode(true));
  });
  const duplicateDateError=await duplicateDate.evaluate(()=>asterLingxing.collectAsins(['BFIXTURE01']).catch(error=>error.message));
  check('同一日期面板出现重复近30天时拒绝猜选，不执行查询',duplicateDateError.includes('日期选项不唯一')&&await duplicateDate.evaluate(()=>fixture.requests)===0);
  await duplicateDate.close();

  const wrongRange = await openFixture();
  await wrongRange.evaluate(()=>{
    document.querySelector('#dateOptions li').onclick=()=>{
      document.querySelector('[placeholder="开始日期"]').value='2026-09-02';
      document.querySelector('#dateOptions').hidden=true;
    };
  });
  const wrongRangeError=await wrongRange.evaluate(()=>asterLingxing.collectAsins(['BFIXTURE01']).catch(error=>error.message));
  check('近30天选项实际回填7天时保留天数校验，不采集或返回结果',wrongRangeError.includes('天数不符')&&await wrongRange.evaluate(()=>fixture.requests)===0);
  await wrongRange.close();

  for (const [mode, message] of [["missing-sales30", "领星报表缺少30天销量列"], ["missing", "领星报表缺少FBA调仓中、FBA在途列"], ["invalid", "FBA可售"], ["empty", "领星未找到该 ASIN 的产品表现"]]) {
    const scenario = await openFixture(mode);
    const error = await scenario.evaluate(() => asterLingxing.collectAsins(['BFIXTURE01']).catch(error=>error.message));
    check(`${mode} 明确报错且不返回不完整结果`, typeof error === "string" && error.includes(message));
    await scenario.close();
  }
  const stale = await openFixture("no-refresh");
  const noRefresh = await stale.evaluate(() => asterLingxing.collectAsins(['BFIXTURE01']).catch(error=>error.message));
  check("没有观察到查询刷新时拒绝读取既有表格", noRefresh === "领星近30天报表未加载完成，请在部署电脑检查后重新同步。");
  await stale.close();
  const cancelled = await openFixture();
  const cancellation = await cancelled.evaluate(async () => {
    const Observer = MutationObserver;
    let observers = 0, frameRequests = 0;
    window.MutationObserver = class extends Observer {
      observe(...args) { observers++; return super.observe(...args); }
      disconnect() { observers--; return super.disconnect(); }
    };
    window.requestAnimationFrame = () => ++frameRequests;
    const controller = new AbortController();
    const collecting = asterLingxing.collectAsins(['BFIXTURE01'], {signal:controller.signal}).catch(error => error.message);
    const before = {observers, frameRequests};
    controller.abort(new Error('受控取消'));
    const error = await collecting;
    const after = {observers, frameRequests, styles:[...document.querySelectorAll('style')].filter(el=>el.textContent.includes('el-zoom-in-top-enter')).length};
    const next = await asterLingxing.collectAsins(['BFIXTURE02']);
    return {before,after,error,next,final:{observers,frameRequests}};
  });
  check('取消指标采集撤销观察器和临时USD样式，且未调度动画帧', cancellation.before.observers>0 && cancellation.before.frameRequests===0 && cancellation.error==='受控取消' && Object.values(cancellation.after).every(value=>value===0));
  check('同文档取消后仍可再次取数，成功也不遗留动画帧或观察器', cancellation.next.items[0].sales30d===5678 && Object.values(cancellation.final).every(value=>value===0));
  await cancelled.close();
  check("全部隔离页面无JS错误", errors.length === 0);
  await fs.writeFile(output, JSON.stringify({ kind: "dom-fixture-only", realLingxingConnected: false, realData: false, passed: checks.length, checks, errors, testedAt: new Date().toISOString(), fixtureOnlyScriptResult: fixtureResult }, null, 2));
  console.log(`LINGXING_PAGE_SCRIPT_FIXTURE_RESULT ${checks.length} PASS; NO LIVE LINGXING`);
} finally { await browser.close(); }
