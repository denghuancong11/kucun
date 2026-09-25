/* 人工在“移除入库单”按移除单号查询、展开全部父行后运行。
 * 只读当前完整结果，不调用私有接口，不提交/编辑/收货。
 * const capture = collectLingxingRemoval({ orderNo: 'rL5grhXpTx', fnsku: 'TEST-FNSKU-REMOVAL-001' });
 * 数量口径核实：官方 removeInbound 说明：按包裹推送，申报量为该 MSKU+FNSKU 的可售+不可售移除货件数量。
 */
function collectLingxingRemoval({ orderNo, fnsku }, pageOnly = false) {
  const url = 'https://erp.lingxing.com/erp/msupply/removeInbound';
  if (location.origin + location.pathname !== url) throw new Error('未打开领星移除入库单，请在部署电脑检查领星页面');
  if (!orderNo || !fnsku) throw new Error('请提供移除单号和 FNSKU');
  const visible = el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const clean = value => String(value).replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const types = [...document.querySelectorAll('.search-block .field-select .fake-select-label')].filter(visible);
  const searches = [...document.querySelectorAll('.search-block .search-input > input')].filter(visible);
  if (types.length !== 1 || clean(types[0].textContent) !== '移除单号' || searches.length !== 1 || searches[0].value.trim() !== orderNo) {
    throw new Error('请先按此移除单号查询并等待结果加载完成');
  }
  if ([...document.querySelectorAll('.el-loading-mask,.vxe-table--loading')].some(visible)) throw new Error('领星报表仍在加载，请稍后重新同步');
  const labels = ['MSKU', 'FNSKU', '申报量'];
  const hasColumns = cells => labels.every(label => cells.some(cell => clean(cell.innerText) === label));
  // 2026-09-09 真实页面：vxe 主表，表头多一个 gutter；固定列和底部总计不是商品。
  const mainTables = [...document.querySelectorAll('.vxe-table--main-wrapper')].filter(visible).map(main => ({
    header: [...main.querySelectorAll('.vxe-table--header-wrapper.body--wrapper tr:first-child > th')],
    body: main.querySelector('.vxe-table--body-wrapper.body--wrapper table'),
  })).filter(table => hasColumns(table.header));
  let tables, header, columnIds;
  if (mainTables.length) {
    if (mainTables.length !== 1 || !mainTables[0].body) throw new Error('无法确定移除入库单表格的位置，请在部署电脑检查报表');
    header = mainTables[0].header;
    tables = [mainTables[0].body];
    columnIds = Object.fromEntries(labels.map(label => {
      const cells = header.filter(cell => clean(cell.innerText) === label);
      const id = cells.length === 1 && [...cells[0].classList].find(value => /^col_\d+$/.test(value));
      if (!id) throw new Error(`未找到“${label}”列，请在部署电脑核对领星报表`);
      return [label, id];
    }));
  } else {
    tables = [...document.querySelectorAll('.ak-table-list table')].filter(visible);
    header = tables.map(table => [...table.querySelectorAll('tr:first-child > th')]).find(hasColumns);
  }
  if (!header) throw new Error('未找到 MSKU、FNSKU、申报量表头');
  const positions = Object.fromEntries(labels.map(label => [label, header.findIndex(cell => clean(cell.innerText) === label)]));
  const fieldCell = (cells, label) => columnIds ? cells.find(cell => cell.classList.contains(columnIds[label])) : cells[positions[label]];
  const packages = [];
  const allItems = [];
  let parent;
  const between = (text, start, end) => {
    const match = text.match(new RegExp(`${start}\\s*[:：]?\\s*(.*?)\\s*${end}`));
    if (!match || !match[1] || match[1] === '-') throw new Error(`包裹缺少${start}`);
    return match[1];
  };
  for (const table of tables) {
    for (const tr of table.querySelectorAll('tbody > tr')) {
      const cells = [...tr.querySelectorAll(':scope > td')];
      const text = clean(tr.innerText);
      if (/^OWR\d+\b/.test(text)) {
        const packageNo = text.match(/^OWR\d+/)[0];
        if (packages.some(p => p.packageNo === packageNo)) throw new Error('包裹重复，请保留一份主表');
        parent = {
          packageNo, store: between(text, '店铺', '移除单号'), orderNo: between(text, '移除单号', '入库仓库'),
          shipDate: between(text, '发货日期', '承运商'), carrier: between(text, '承运商', '运单号'),
          trackingNo: between(text, '运单号', '备注'), itemCount: 0,
        };
        if (parent.orderNo !== orderNo) throw new Error('结果中存在其他移除单号，请等本次查询完成');
        if (!/^\d{4}-\d{2}-\d{2}T/.test(parent.shipDate)) throw new Error('缺少包裹实际发货时间');
        packages.push(parent);
      } else if (parent && fieldCell(cells, 'FNSKU')) {
        const product = clean(fieldCell(cells, 'FNSKU').innerText);
        if (!/^X[0-9A-Z]{9}$/.test(product)) continue;
        if (!fieldCell(cells, 'MSKU') || !fieldCell(cells, '申报量')) throw new Error(`商品 ${product} 缺少 MSKU 或申报量列`);
        const msku = clean(fieldCell(cells, 'MSKU').innerText);
        const raw = clean(fieldCell(cells, '申报量').innerText);
        if (!/^[\d,]+$/.test(raw)) throw new Error(`商品 ${product} 缺少有效申报量`);
        const quantity = Number(raw.replaceAll(',', ''));
        if (!msku || !Number.isSafeInteger(quantity)) throw new Error('包裹商品缺少 MSKU 或有效数量');
        parent.itemCount++;
        allItems.push({ packageNo: parent.packageNo, msku, fnsku: product, rawQuantity: raw, quantity,
          store: parent.store, shipDate: parent.shipDate, carrier: parent.carrier, trackingNo: parent.trackingNo });
      }
    }
  }
  const counts = [...document.body.innerText.matchAll(/共\s*(\d+)\s*条/g)].map(m => Number(m[1]));
  if (!counts.length || new Set(counts).size !== 1 || (!pageOnly && counts[0] !== packages.length) || packages.some(p => p.itemCount === 0)) {
    throw new Error('当前页未包含查询的全部包裹及商品；请在部署电脑调整每页条数并展开包裹后重新同步');
  }
  const selected = allItems.filter(item => item.fnsku === fnsku);
  if (!pageOnly && !selected.length) throw new Error(`移除单 ${orderNo} 中未找到 FNSKU ${fnsku}，请核对移除单号和升级来源。`);
  const shipments = selected.map(item => ({
    // 入库单号是页面提供的包裹身份；MSKU+FNSKU是官方说明的商品聚合维度。
    // storeId作为此页面来源的固定命名空间，不能伪称领星内部店铺数字ID；改店名、运单号、排序不重建额度。
    storeId: 'lingxing-remove-inbound', externalId: JSON.stringify([item.packageNo, item.msku, item.fnsku]),
    storeName: item.store, countryCode: '', orderNo, fnsku, quantity: item.quantity,
    carrier: item.carrier, trackingNo: item.trackingNo, shipDate: item.shipDate,
  }));
  if (new Set(shipments.map(s => s.externalId)).size !== shipments.length) throw new Error('同一包裹商品行重复，未生成结果');
  return { shipments, capturedAt: new Date().toISOString(), source: {
    kind: 'lingxing_remove_inbound_browser_script', url, orderNo, fnsku,
    quantityDefinition: '按包裹、MSKU、FNSKU汇总移除货件可售和不可售数量',
    definitionUrl: 'https://www.lingxing.com/help/article/removeInbound',
    range: { startDate: inputs.find(i => i.placeholder === '开始日期')?.value, endDate: inputs.find(i => i.placeholder === '结束日期')?.value },
    packageCount: packages.length, ...(pageOnly ? {totalPackageCount:counts[0], packageNos:packages.map(p => p.packageNo)} : {}), allProductQuantity: allItems.reduce((sum, item) => sum + item.quantity, 0),
    selectedProductQuantity: selected.reduce((sum, item) => sum + item.quantity, 0), items: selected,
  } };
}

// 自动查询仅改变筛选、展开和分页；不点击订单的提交、收货或其他写入操作。
async function queryLingxingRemoval({orderNo, fnsku}, {signal} = {}) {
  signal?.throwIfAborted();
  if (location.origin + location.pathname !== 'https://erp.lingxing.com/erp/msupply/removeInbound') throw new Error('请先在部署电脑的 Edge 登录领星。');
  const visible = el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const all = selector => [...document.querySelectorAll(selector)].filter(visible);
  const clean = el => el.innerText?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
  const pause = ms => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      signal?.aborted ? reject(signal.reason) : resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, {once:true});
  });
  const one = (elements, label) => { if (elements.length !== 1) throw new Error(`无法定位${label}（找到 ${elements.length} 个），请保留移除入库单列表后重试。`); return elements[0]; };
  const exact = text => all('button,[role="button"],li,span').filter(el => clean(el) === text && ![...el.children].some(child => visible(child) && clean(child) === text));
  const settle = async () => {
    let previous = '', stable = 0;
    for (let i=0; i<120; i++) {
      await pause(200);
      const text = all('.vxe-table--main-wrapper,.ak-table-list').map(el => el.innerText).join('');
      const loading = all('.el-loading-mask,.vxe-table--loading').length;
      stable = !loading && text && text === previous ? stable+1 : 0;
      previous = text;
      if (stable >= 5) return;
    }
    throw new Error('领星查询未完成，请检查网络后重试。');
  };
  one(exact('重置'), '重置按钮').click();
  await settle();
  // 2026-09-20 真实保存页：查询字段标签、匹配方式和订单输入框是并列控件。
  const type = one(all('.search-block .field-select input[readonly]'), '查询类型');
  const typeValue = () => clean(one(all('.search-block .field-select .fake-select-label'), '查询类型已选项'));
  if (typeValue() !== '移除单号') {
    // 真实下拉展开后位于 body 下，不再是 field-select 的后代。
    const options = () => all('.el-select-dropdown .el-select-dropdown__item').filter(el => clean(el) === '移除单号');
    if (!options().length) {
      type.focus();
      await pause(100);
      if (!options().length) type.click();
    }
    for (let i=0; i<25 && !options().length; i++) await pause(200);
    one(options(), '移除单号选项').click();
    for (let i=0; i<25 && typeValue() !== '移除单号'; i++) await pause(200);
    if (typeValue() !== '移除单号') throw new Error(`选择移除单号未生效，当前查询类型为“${typeValue()}”`);
  }
  const input = one(all('.search-block .search-input > input').filter(el => !el.readOnly), '订单查询输入框');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, orderNo);
  input.dispatchEvent(new Event('input', {bubbles:true}));
  input.dispatchEvent(new Event('change', {bubbles:true}));
  const query = exact('查询');
  if (query.length === 1) query[0].click();
  else for (const event of ['keydown','keypress','keyup']) input.dispatchEvent(new KeyboardEvent(event,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
  await settle();
  const first = all('.el-pagination .el-pager li').find(el => clean(el) === '1');
  if (first && !first.classList.contains('active')) { first.click(); await settle(); }
  const captures = [];
  const seen = new Set();
  for (;;) {
    // vxe 的展开按钮或页面文字“展开”，只展开尚未展开的商品列表。
    for (const row of all('.vxe-table--main-wrapper tr')) {
      if (!/^OWR\d+\b/.test(clean(row) || '')) continue;
      const expander = [...row.querySelectorAll('[aria-expanded="false"],.vxe-table--expand-btn:not(.is--active),button,span')]
        .find(el => visible(el) && (el.getAttribute('aria-expanded') === 'false' || el.classList.contains('vxe-table--expand-btn') || ['展开','展开商品'].includes(clean(el))));
      if (expander) { expander.click(); await settle(); }
    }
    const current = collectLingxingRemoval({orderNo,fnsku}, true);
    if (!current.source.packageCount) throw new Error('此查询范围没有移除包裹，请核对移除单号及领星的近 31 天来源范围。');
    for (const id of current.source.packageNos) {
      if (seen.has(id)) throw new Error('分页返回了重复包裹，未提交不完整结果。');
      seen.add(id);
    }
    captures.push(current);
    if (seen.size === current.source.totalPackageCount) break;
    const next = one(all('.el-pagination .btn-next'), '下一页按钮');
    if (next.disabled || next.getAttribute('aria-disabled') === 'true') throw new Error('分页已结束，但包裹数量不完整，未提交。');
    next.click();
    await settle();
  }
  const result = captures[0];
  result.shipments = captures.flatMap(capture => capture.shipments);
  result.source.items = captures.flatMap(capture => capture.source.items);
  result.source.allProductQuantity = captures.reduce((sum,capture) => sum+capture.source.allProductQuantity,0);
  result.source.selectedProductQuantity = result.shipments.reduce((sum,item) => sum+item.quantity,0);
  result.source.packageCount = seen.size;
  result.source.pageCount = captures.length;
  delete result.source.packageNos;
  delete result.source.totalPackageCount;
  result.capturedAt = new Date().toISOString();
  if (!result.shipments.length) throw new Error(`移除单 ${orderNo} 中未找到 FNSKU ${fnsku}，请核对移除单号和升级来源。`);
  if (new Set(result.shipments.map(item => item.externalId)).size !== result.shipments.length) throw new Error('包裹商品行重复，未提交。');
  return result;
}

// 只把页面取数送入已有缓存接口，采纳仍由升级流程发起人在库存系统操作。
