/* DOM 模拟验收，不连接真实领星。包裹及数量是明确构造的测试样例。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
const script = await fs.readFile(path.join(import.meta.dirname, 'lingxing-removal-page-collector.js'), 'utf8');
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const checks = [];
try {
  const page = await browser.newPage();
  const header = ['','图片','MSKU','FNSKU','品名/SKU','第三方仓产品名/产品编码','申报量','可用量','次品量','销毁量','申收差异',''];
  const parent = (id, carrier, tracking) => `<tr><td></td><td colspan="11">${id} 店铺 : TEST-US 美国 移除单号 : TEST-ORDER 入库仓库 : - 发货日期 : 2026-09-01T02:50:19-07:00 承运商 : ${carrier} 运单号 : ${tracking} 备注 : -</td></tr>`;
  const item = (msku, fnsku, qty) => `<tr>${['','',msku,fnsku,'商品','-',qty+' ',0,0,0,qty,''].map(c=>`<td>${c}</td>`).join('')}</tr>`;
  const table = parent('OWR20260001','UPS','T1') + item('SKU-A','X011111111',2) + item('SKU-B','X022222222',9)
    + parent('OWR20260002','USPS','T2') + item('SKU-A','X011111111',3);
  const html = `<meta charset="utf-8"><div class="search-block"><div class="field-select"><input readonly value=""><span class="fake-select-label">移除单号</span></div><div class="search-mode-select"><input readonly value="模糊"></div><div class="search-input"><input value="TEST-ORDER"></div></div><input placeholder="开始日期" value="2026-08-10"><input placeholder="结束日期" value="2026-09-09"><div class="ak-table-list"><table><thead><tr>${header.map(c=>`<th>${c}</th>`).join('')}</tr></thead></table><table><tbody>${table}</tbody></table></div><p id="count">共2条</p>`;
  await page.route('https://erp.lingxing.com/**', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('https://erp.lingxing.com/erp/msupply/removeInbound');
  await page.addScriptTag({content:script});
  const collect = () => page.evaluate(() => collectLingxingRemoval({orderNo:'TEST-ORDER',fnsku:'X011111111'}));
  const first = await collect();
  const queryPage=await browser.newPage();
  await queryPage.route('https://erp.lingxing.com/**',route=>route.fulfill({body:html,contentType:'text/html'}));
  await queryPage.goto('https://erp.lingxing.com/erp/msupply/removeInbound');
  await queryPage.evaluate(()=>{
    const field=document.querySelector('.field-select'), label=field.querySelector('.fake-select-label');
    const menu=document.createElement('div');menu.className='el-select-dropdown';menu.hidden=true;
    menu.innerHTML='<ul><li class="el-select-dropdown__item"><span></span><span>移除单号</span></li></ul>';field.append(menu);
    field.querySelector('input').onclick=()=>{document.body.append(menu);menu.hidden=false;};
    menu.querySelector('li').onclick=()=>{label.textContent='移除单号';menu.hidden=true;};
    const reset=document.createElement('button');reset.textContent='重置';
    reset.onclick=()=>{label.textContent='入库单号';document.querySelector('.search-input input').value='';};document.body.prepend(reset);
    const unrelated=document.createElement('span');unrelated.textContent='移除单号';unrelated.onclick=()=>{window.wrongTypeClick=true;};document.body.append(unrelated);
  });
  await queryPage.addScriptTag({content:script});
  const cancelled = await queryPage.evaluate(async()=>{
    const controller=new AbortController();
    const collecting=queryLingxingRemoval({orderNo:'TEST-ORDER',fnsku:'X011111111'},{signal:controller.signal}).catch(error=>error.message);
    controller.abort(new Error('受控取消物流'));
    return await collecting;
  });
  assert.equal(cancelled,'受控取消物流');checks.push('物流等待可取消并清理，后续同文档查询重新正常取数');
  const queried=await queryPage.evaluate(()=>queryLingxingRemoval({orderNo:'TEST-ORDER',fnsku:'X011111111'}));
  assert.deepEqual(queried.shipments,first.shipments);
  assert.equal(await queryPage.locator('.el-select-dropdown').evaluate(el=>el.parentElement===document.body),true);
  assert.equal(await queryPage.evaluate(()=>!!window.wrongTypeClick),false);
  checks.push('实际下拉展开后移到body，仍正确选择移除单号并查询目标包裹，不点击同名说明');
  await queryPage.evaluate(()=>{
    const menu=document.querySelector('.el-select-dropdown');menu.hidden=false;document.body.append(menu.cloneNode(true));
  });
  await assert.rejects(()=>queryPage.evaluate(()=>queryLingxingRemoval({orderNo:'TEST-ORDER',fnsku:'X011111111'})),/移除单号选项（找到 2 个）/);
  checks.push('出现多个可见移除单号选项时仍拒绝猜选，不保存不确定结果');
  await queryPage.close();
  await page.locator('.fake-select-label').evaluate(el=>el.textContent='入库单号');
  await assert.rejects(collect,/请先按此移除单号查询/); checks.push('订单文本相同时仍核对真实字段标签，不把入库单号当作移除单号');
  await page.locator('.fake-select-label').evaluate(el=>el.textContent='移除单号');
  assert.equal(await page.locator('.field-select input').inputValue(),''); checks.push('查询字段以真实显示标签判断，空 input 值不造成误报');
  await assert.rejects(()=>page.evaluate(()=>collectLingxingRemoval({orderNo:'TEST-ORDER',fnsku:'TEST-FNSKU-HOST-01'})), /移除单 TEST-ORDER 中未找到 FNSKU TEST-FNSKU-HOST-01，请核对移除单号和升级来源/);
  checks.push('订单有其他商品时准确提示目标FNSKU不匹配，不误报整个订单没有发货');
  assert.equal(first.shipments.reduce((n,r)=>n+r.quantity,0),5); checks.push('只取目标FNSKU的2+3，排除其他商品9');
  assert.equal(first.source.allProductQuantity,14); checks.push('整单14不能作为目标FNSKU的5');
  assert.equal(first.shipments.length,2); checks.push('多包裹分别保留承运商和运单');
  assert.notEqual(first.shipments[0].externalId,first.shipments[1].externalId); checks.push('不同包裹商品身份不同');
  // 按用户 2026-09-09T06:51:11.209Z 真实 DOM 诊断搭建结构；数值仍为模拟样例。
  const vxePage = await browser.newPage();
  await vxePage.route('https://erp.lingxing.com/**', route => route.fulfill({body:html,contentType:'text/html'}));
  await vxePage.goto('https://erp.lingxing.com/erp/msupply/removeInbound');
  await vxePage.evaluate(() => {
    const old = document.querySelector('.ak-table-list');
    const [head,body] = old.querySelectorAll('table');
    head.className = 'vxe-table--header'; body.className = 'vxe-table--body';
    for (const row of [...head.querySelectorAll('tr'),...body.querySelectorAll('tr')]) {
      [...row.children].forEach((cell,index) => cell.classList.add('col_'+(364+index)));
      if (row.textContent.trim().startsWith('OWR')) {
        row.className = 'vxe-body--row special-row';
        row.children[1].colSpan = 10;
        row.children[1].textContent = row.children[1].textContent.replaceAll(' : ', '\n');
      } else {
        row.className = 'vxe-body--row normal-row';
        row.lastElementChild.remove();
      }
    }
    // 真实表头多 gutter，商品行没有此格；表底统计值不能替代包裹商品。
    const gutter=document.createElement('th'); gutter.className='vxe-header--gutter';head.querySelector('tr').append(gutter);
    const main=document.createElement('div');main.className='vxe-table--main-wrapper';
    for (const [kind,table] of [['header',head],['body',body]]) {
      const wrapper=document.createElement('div');wrapper.className='vxe-table--'+kind+'-wrapper body--wrapper';wrapper.append(table);main.append(wrapper);
    }
    const footer=document.createElement('div');footer.className='vxe-table--footer-wrapper body--wrapper';
    footer.innerHTML='<table><tbody><tr><td>总计</td><td>999999</td></tr></tbody></table>';main.append(footer);
    const fixed=document.createElement('div');fixed.className='fixed-left--wrapper';fixed.append(head.cloneNode(true),body.cloneNode(true));
    old.replaceWith(main,fixed);
  });
  await vxePage.addScriptTag({content:script});
  const collectVxe=()=>vxePage.evaluate(()=>collectLingxingRemoval({orderNo:'TEST-ORDER',fnsku:'X011111111'}));
  const vxeCapture=await collectVxe();
  assert.deepEqual(vxeCapture.shipments,first.shipments); checks.push('真实vxe结构无旧容器、父字段无冒号时读取相同包裹商品');
  assert.equal(vxeCapture.source.allProductQuantity,14);assert.equal(vxeCapture.source.selectedProductQuantity,5); checks.push('排除vxe固定列副本与底部总计，不重复计量');
  await vxePage.evaluate(() => {
    for(const row of document.querySelectorAll('.vxe-table--main-wrapper .vxe-table--body .normal-row')) row.append(row.querySelector('.col_366'));
  });
  assert.deepEqual((await collectVxe()).shipments,first.shipments); checks.push('按主表列标识对应MSKU/FNSKU/申报量，gutter和单元格位置变化不混列');
  await vxePage.evaluate(() => {
    document.querySelector('.vxe-table--main-wrapper .vxe-table--body .normal-row .col_370').remove();
  });
  await assert.rejects(collectVxe,/缺少 MSKU 或申报量列/); checks.push('商品缺申报量列时拒绝取相邻可用量代替');
  await vxePage.close();
  await page.locator('td').filter({ hasText: /^OWR20260001 / }).evaluate(el => el.textContent = el.textContent.replace('TEST-US','RENAMED-US').replace('T1','T1-NEW'));
  const renamed = await collect();
  assert.deepEqual(renamed.shipments.map(r=>[r.storeId,r.externalId]),first.shipments.map(r=>[r.storeId,r.externalId])); checks.push('改店名或运单不生成新商品额度');
  await page.locator('#count').evaluate(el => el.textContent='共3条');
  await assert.rejects(collect,/全部包裹/); checks.push('缺少后续页包裹时拒绝宣称完整');
  await page.locator('#count').evaluate(el => el.textContent='共2条');
  await page.locator('td').filter({hasText:'9 '}).evaluate(el=>el.textContent='—');
  await assert.rejects(collect,/有效申报量/); checks.push('缺失数量不补零');
  const output={at:new Date().toISOString(),kind:'isolated DOM fixture',realLingxing:false,passed:checks.length,checks,capture:first};
  if(process.env.ASTER_REMOVAL_RESULT) await fs.writeFile(process.env.ASTER_REMOVAL_RESULT,JSON.stringify(output,null,2));
  console.log(JSON.stringify(output,null,2));
} finally { await browser.close(); }
