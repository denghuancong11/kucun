/* 在已登录的领星产品表现页面执行；仅操作筛选、横滚和读取总计。
 * 由Edge扩展调用，只返回报表数据，不直接提交到库存服务。
 * await asterLingxing.collectAsins(['B08P18Q9WV'])
 */
(() => {
  "use strict";

  const PRODUCT_URL = "https://erp.lingxing.com/erp/productExpressionNew";
  const LABELS = {
    sales7d: "7天销量", sales30d: "30天销量", orderGrossProfit: "订单毛利润", fbaAvailable: "FBA可售",
    fbaPendingTransfer: "FBA待调仓", fbaTransferring: "FBA调仓中", fbaInbound: "FBA在途",
  };
  const MAIN = {
    body: ".vxe-table--body-wrapper.body--wrapper",
    header: ".vxe-table--header-wrapper.body--wrapper",
    footer: ".vxe-table--footer-wrapper.body--wrapper",
  };
  // 2026-09-09 真实产品表现页观察到的加载遮罩；不以列重排代替查询完成。
  const LOADING = ".vxe-table--loading.vxe-loading.ak-loading-mask";
  let signal;
  const waitForChange = (ms) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const currentSignal = signal;
    let timer, observer, finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      observer?.disconnect();
      document.removeEventListener("input", finish, true);
      document.removeEventListener("change", finish, true);
      currentSignal?.removeEventListener("abort", finish);
      currentSignal?.aborted ? reject(currentSignal.reason) : resolve();
    };
    observer = new MutationObserver(finish);
    observer.observe(document.body, {
      childList: true, characterData: true, subtree: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "value"],
    });
    document.addEventListener("input", finish, true);
    document.addEventListener("change", finish, true);
    timer = setTimeout(finish, ms);
    currentSignal?.addEventListener("abort", finish, { once: true });
  });
  const nextMicrotask = () => Promise.resolve();
  async function waitForCondition(check, timeoutMs) {
    const started = performance.now();
    while (true) {
      signal?.throwIfAborted();
      const current = check();
      if (current) return current;
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) return null;
      await waitForChange(remaining);
    }
  }
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  };
  const matches = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible);
  const normalizeLabel = (value) => String(value).replace(/[^\p{L}\p{N}]/gu, "");
  let running = false;

  function one(selector, name) {
    const elements = matches(selector);
    if (elements.length !== 1) throw new Error(`无法找到唯一的“${name}”，请在部署电脑检查领星报表`);
    return elements[0];
  }

  function textLeaves(text, selector = "button, li, span, div") {
    return matches(selector).filter((element) => element.textContent.trim() === text &&
      !Array.from(element.children).some((child) => child.matches(selector) && visible(child) && child.textContent.trim() === text));
  }

  function exactControl(text, selector) {
    const elements = textLeaves(text, selector);
    if (elements.length !== 1) throw new Error(`无法找到唯一的“${text}”，请在部署电脑检查领星报表`);
    return elements[0];
  }

  async function selectDropdown(input, value, readValue = () => input.value, optionSelector) {
    const openingStarted = performance.now();
    if (readValue() === value) return;
    if (!textLeaves(value, optionSelector).length) {
      // click() 不会给输入框焦点；与日期选择一样，先完成真实点击所需的聚焦。
      input.focus();
      await nextMicrotask();
      if (!textLeaves(value, optionSelector).length) input.click();
    }
    const started = performance.now();
    const deadline = started + 5000;
    let checks = 0, lastOptions = 0;
    const option = await waitForCondition(() => {
      checks += 1;
      if (readValue() === value) return { alreadySelected: true };
      const options = textLeaves(value, optionSelector);
      lastOptions = options.length;
      if (options.length > 1) throw new Error(`可见的“${value}”选项不唯一（找到 ${options.length} 个）`);
      return options.length === 1 ? { element: options[0] } : null;
    }, 5000);
    if (option?.alreadySelected) return;
    let selected = false, updateWaitMs = 0;
    if (option?.element) {
      selected = true;
      const clickedAt = performance.now();
      option.element.click();
      // 先让本次点击触发的微任务完成；回填继续使用本次下拉的同一5秒期限。
      await nextMicrotask();
      if (readValue() === value) return;
      const remaining = deadline - performance.now();
      const updated = remaining > 0 ? await waitForCondition(() => readValue() === value, remaining) : null;
      updateWaitMs = Math.round(performance.now() - clickedAt);
      if (updated) return;
    }
    // 只在失败时读取现场，区分旧轮询结果和结束时状态；不据此重试或点击。
    const finalOptions = textLeaves(value, optionSelector).length;
    const menus = [...document.querySelectorAll('.el-select-dropdown')].filter(menu =>
      [...menu.querySelectorAll('.el-select-dropdown__item')].some(option => option.textContent.trim() === value)
    ).map(menu => {
      const rect = menu.getBoundingClientRect(), style = getComputedStyle(menu);
      return `${menu.className}|${style.display}|${style.visibility}|${style.transform}|${Math.round(rect.width)}x${Math.round(rect.height)}`;
    });
    throw new Error(`选择“${value}”未完成：${selected ? `已点击，等待回填${updateWaitMs}毫秒后仍未更新` : '5秒内未找到可见选项'}，当前值“${readValue()}”；打开${Math.round(started - openingStarted)}毫秒，检查${checks}次/${Math.round(performance.now() - started)}毫秒，最后检查${lastOptions}个/结束可见${finalOptions}个；页面可见性${document.visibilityState ?? '未知'}；菜单${menus.join(';')}`);
  }

  // 2026-09-20 真实保存页：字段选择与搜索输入并列，当前字段由标签显示。
  function queryTypeValue() {
    return one('.search-block .field-select .fake-select-label', '查询类型已选项').textContent.trim();
  }

  function currencyInput() {
    const inputs = matches(".el-input > input[readonly]").filter((input) => /^(原币种|USD|CNY)$/.test(input.value));
    if (inputs.length !== 1) throw new Error("无法确定领星币种选项的位置，请在部署电脑检查报表页面");
    return inputs[0];
  }

  function setInput(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(input) {
    input.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
  }

  function readRange() {
    const startDate = one('input[placeholder="开始日期"]', "开始日期").value;
    const endDate = one('input[placeholder="结束日期"]', "结束日期").value;
    if (![startDate, endDate].every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) || startDate > endDate) {
      throw new Error(`领星日期范围无效：${startDate} 至 ${endDate}`);
    }
    return { startDate, endDate };
  }

  async function dateShortcut(days) {
    const label = `近${days}天`;
    const input = one('input[placeholder="开始日期"]', "开始日期");
    // 2026-09-20 真实日期面板：快捷范围为关联 popover 内的级联菜单叶子项。
    const reference = one('.el-popover__reference:has(input[placeholder="开始日期"])', '日期控件');
    // 后台关闭动画可能未结束，旧选项仍有尺寸；必须重新打开面板再选择。
    const selector = `#${CSS.escape(reference.getAttribute('aria-describedby'))}:not(.fade-in-linear-leave-active) .el-cascader-node.is-leaf-node`;
    if (!textLeaves(label, selector).length) {
      // HTMLElement.click() 不会像鼠标点击一样让输入框获得焦点。
      input.focus();
      await nextMicrotask();
      if (!textLeaves(label, selector).length) input.click();
    }
    const started = performance.now();
    let checks = 0;
    while (true) {
      checks += 1;
      const options = textLeaves(label, selector);
      if (options.length > 1) throw new Error(`可见的“${label}”日期选项不唯一（找到 ${options.length} 个）`);
      if (options.length === 1) return options[0];
      const remaining = 5000 - (performance.now() - started);
      if (remaining <= 0) break;
      await waitForChange(remaining);
    }
    throw new Error(`领星日期面板5秒内没有“${label}”选项（检查${checks}次，页面可见性${document.visibilityState ?? '未知'}），请检查报表状态`);
  }

  async function selectedRange(days) {
    const started = performance.now();
    let range;
    await nextMicrotask();
    while (true) {
      range = readRange();
      if ((Date.parse(range.endDate) - Date.parse(range.startDate)) / 86400000 + 1 === days) return range;
      const remaining = 5000 - (performance.now() - started);
      if (remaining <= 0) break;
      await waitForChange(remaining);
    }
    throw new Error(`领星“近${days}天”5秒内未完成日期回填，当前为 ${range.startDate} 至 ${range.endDate}，天数不符`);
  }

  function assertConditions(asin, range) {
    if (location.origin + location.pathname !== PRODUCT_URL) throw new Error("未打开领星产品表现页面，请在部署电脑的 Edge 登录领星后重新同步");
    if (one("#tab-msku", "MSKU维度").getAttribute("aria-selected") !== "true") throw new Error("领星维度不是 MSKU");
    if (one('input[placeholder="全部国家"][readonly]', "全部国家").value !== "" || textLeaves("全部店铺").length !== 1) {
      throw new Error("领星查询尚未确认全部国家、全部店铺；请检查筛选范围");
    }
    if (currencyInput().value !== "USD") throw new Error("领星币种不是 USD");
    if (queryTypeValue() !== "ASIN" ||
        one(".search-input > input", "ASIN查询").value.trim().toUpperCase() !== asin) {
      throw new Error("领星 ASIN 查询条件已改变");
    }
    if (range && JSON.stringify(readRange()) !== JSON.stringify(range)) throw new Error("查询期间领星日期范围已改变，请重新同步");
  }

  // 只观察主表的可见 DOM；不读取网页框架状态、请求参数或认证信息。
  function observeTable() {
    let lastChange = performance.now();
    let loadingSeen = false;
    let loadingNow = false;
    let lastLoadingAt = performance.now();
    let wake = null;
    const sampleLoading = () => {
      const loading = matches(LOADING).length > 0;
      const now = performance.now();
      if (loading && !loadingNow) { loadingSeen = true; lastLoadingAt = now; }
      if (!loading && loadingNow) lastLoadingAt = now;
      loadingNow = loading;
      return loading;
    };
    const observer = new MutationObserver((records) => {
      sampleLoading();
      const tableChanged = records.some((record) => {
        const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        return element && element.closest(Object.values(MAIN).join(","));
      });
      if (tableChanged) {
        if (records.some((record) => {
          if (record.type === "attributes") return false;
          const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
          return element && element.closest(Object.values(MAIN).join(","));
        })) lastChange = performance.now();
        wake?.();
      }
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    return {
      observer, sampleLoading,
      waitForChange(ms) {
        const currentSignal = signal;
        currentSignal?.throwIfAborted();
        return new Promise((resolve, reject) => {
          let timer, finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (wake === finish) wake = null;
            currentSignal?.removeEventListener('abort', finish);
            currentSignal?.aborted ? reject(currentSignal.reason) : resolve();
          };
          wake = finish;
          timer = setTimeout(finish, ms);
          currentSignal?.addEventListener('abort', finish, { once: true });
        });
      },
      get loadingSeen() { return loadingSeen; }, get lastLoadingAt() { return lastLoadingAt; }, get lastChange() { return lastChange; },
    };
  }

  async function settleControls(action, stage) {
    const state = observeTable();
    const started = performance.now();
    try {
      await action();
      await nextMicrotask();
      while (true) {
        const loading = state.sampleLoading();
        const now = performance.now();
        const elapsed = now - started;
        const stableFor = now - Math.max(state.lastChange, state.lastLoadingAt);
        if (!loading && elapsed >= 900 && stableFor >= 750) return;
        if (elapsed >= 20000) throw new Error(`领星${stage}后未能读取稳定结果（已等待${Math.round(elapsed)}毫秒，加载${loading ? '中' : '已结束'}，距最近变化${Math.round(stableFor)}毫秒，页面可见性${document.visibilityState ?? '未知'}）`);
        const remaining = 20000 - elapsed;
        const stableRemaining = Math.max(900 - elapsed, 750 - stableFor, 1);
        await state.waitForChange(loading ? remaining : Math.min(remaining, stableRemaining));
      }
    } finally { state.observer.disconnect(); }
  }

  function readResultCount() {
    const pane = matches("#pane-msku")[0] || document.body;
    const counts = [...pane.innerText.matchAll(/共\s*(\d+)\s*条/g)].map((match) => Number(match[1]));
    if (!counts.length || new Set(counts).size !== 1) throw new Error("领星查询尚未显示明确的结果数量");
    if (counts[0] === 0) throw new Error("领星未找到该 ASIN 的产品表现，请核对 ASIN 和店铺权限");
    return counts[0];
  }

  async function queryRange(asin, days, progress) {
    progress('复位表格横向位置');
    one(MAIN.body, "主表主体").scrollLeft = 0;
    await nextMicrotask();
    progress('填写ASIN');
    setInput(one(".search-input > input", "ASIN查询"), asin);
    await nextMicrotask();
    progress(`展开近${days}天日期选项`);
    const rangeButton = await dateShortcut(days);
    const state = observeTable();
    const started = performance.now();
    try {
      progress(`选择近${days}天并等待日期回填`);
      rangeButton.click();
      const range = await selectedRange(days);
      progress('提交查询并等待报表刷新');
      pressEnter(one(".search-input > input", "ASIN查询"));
      await nextMicrotask();
      while (true) {
        assertConditions(asin, range);
        const loading = state.sampleLoading();
        const now = performance.now();
        const stableFor = now - Math.max(state.lastChange, state.lastLoadingAt);
        if (state.loadingSeen && !loading && stableFor >= 750) {
          const resultCount = readResultCount();
          // 查询条件、完整加载周期和稳定结果共同确认完成，不要求用户显示ASIN列。
          return { range, resultCount };
        }
        const remaining = 20000 - (now - started);
        if (remaining <= 0) break;
        const stableRemaining = 750 - stableFor;
        await state.waitForChange(state.loadingSeen && !loading && stableRemaining > 0 ? Math.min(remaining, stableRemaining) : remaining);
      }
      throw new Error(`领星近${days}天报表未加载完成，请在部署电脑检查后重新同步。`);
    } finally { state.observer.disconnect(); }
  }

  function parseTotal(raw, key) {
    const label = LABELS[key];
    const cleaned = String(raw).trim().replace(/[\s,\u200e\u200f$¥￥€£]/g, "");
    if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) throw new Error(`领星底部“${label}”缺少有效数值：${String(raw)}`);
    const value = Number(cleaned);
    if (!Number.isFinite(value) || (key !== "orderGrossProfit" && (!Number.isSafeInteger(value) || value < 0))) {
      throw new Error(`领星底部“${label}”不是有效数量：${String(raw)}`);
    }
    return value;
  }

  async function readTotals(keys, asin, range, progress) {
    const body = one(MAIN.body, "主表主体");
    const originalLeft = body.scrollLeft;
    const max = Math.max(0, body.scrollWidth - body.clientWidth);
    const step = Math.max(200, Math.floor(body.clientWidth / 2));
    const labels = keys.map((key) => LABELS[key]);
    const raw = {};
    try {
      for (let position = 0; ; position = Math.min(max, position + step)) {
        progress(`读取底部总计（横向位置${position}/${max}）`);
        body.scrollLeft = position;
        // 逐位置通知虚拟表格更新列，并让Vue完成本次scroll事件后的微任务提交，无须等待绘制帧。
        body.dispatchEvent(new Event('scroll'));
        await nextMicrotask();
        assertConditions(asin, range);
        const headers = Array.from(one(MAIN.header, "主表表头").querySelectorAll("tr:first-child > th"));
        const totals = Array.from(one(MAIN.footer, "主表底部总计").querySelectorAll("tr:first-child > td"));
        if (!headers.length || headers.length !== totals.length) throw new Error("领星主表表头与底部总计列未对齐");
        for (let index = 0; index < headers.length; index += 1) {
          const label = normalizeLabel(headers[index].innerText);
          if (!labels.includes(label)) continue;
          const value = totals[index].innerText;
          if (Object.hasOwn(raw, label) && raw[label] !== value) throw new Error(`读取期间“${label}”总计发生改变，请重新同步`);
          raw[label] = value;
        }
        if (labels.every((label) => Object.hasOwn(raw, label)) || position === max) break;
      }
      const missing = labels.filter((label) => !Object.hasOwn(raw, label));
      if (missing.length) throw new Error(`领星报表缺少${missing.join("、")}列，请在部署电脑显示这些列后重试。`);
      return { raw, values: Object.fromEntries(keys.map((key) => [key, parseTotal(raw[LABELS[key]], key)])) };
    } finally { body.scrollLeft = originalLeft; body.dispatchEvent(new Event('scroll')); await nextMicrotask(); }
  }

  async function configure(progress) {
    if (location.origin + location.pathname !== PRODUCT_URL) throw new Error("未打开领星产品表现页面，请在部署电脑的 Edge 登录领星后重新同步");
    progress('重置筛选并等待表格稳定');
    await settleControls(async () => {
      const msku = one("#tab-msku", "MSKU维度");
      if (msku.getAttribute("aria-selected") !== "true") { msku.click(); await nextMicrotask(); }
      exactControl("重置", "button").click();
    }, '重置筛选');
    await settleControls(async () => {
      progress('选择ASIN查询类型');
      const type = one('.search-block .field-select input[readonly]', '查询类型');
      // 字段下拉展开后由领星移到 body 下；限定真实下拉选项，排除同名 ASIN 页签。
      await selectDropdown(type, 'ASIN', queryTypeValue, '.el-select-dropdown .el-select-dropdown__item');
      progress('选择USD币种');
      await selectDropdown(currencyInput(), "USD");
      progress('等待查询类型及币种切换稳定');
    }, '查询类型及币种切换');
  }

  async function collectAsins(asins, options = {}) {
    if (!Array.isArray(asins) || asins.length === 0) throw new Error("没有可查询的 ASIN，请核对待审核单据");
    const normalized = [...new Set(asins.map((asin) => {
      if (typeof asin !== "string" || !/^[A-Z0-9]{10}$/.test(asin.trim().toUpperCase())) throw new Error(`无效 ASIN：${String(asin)}`);
      return asin.trim().toUpperCase();
    }))];
    if (running) throw new Error("此报表正在查询，请等待本次同步完成");
    options.signal?.throwIfAborted();
    running = true;
    signal = options.signal;
    const progress = options.onProgress ?? (() => {});
    // 2026-09-22 真实后台记录：USD 弹层已打开，但缩放动画停在 scaleY(0)。
    // 只取消已打开下拉的入场缩放；display:none 和退场样式仍由领星控制。
    const dropdownMotion = document.createElement("style");
    dropdownMotion.textContent = ".el-select-dropdown.el-zoom-in-top-enter:not(.el-zoom-in-top-leave-active){opacity:1!important;transform:scaleY(1)!important;transition:none!important}";
    document.head.append(dropdownMotion);
    try {
      await configure(progress);
      const items = [];
      const captures = [];
      for (const asin of normalized) {
        const query30 = await queryRange(asin, 30, progress);
        // 7天销量和30天销量是独立报表列；“销量”只对应日期筛选区间，不能替代。
        const totals30 = await readTotals(Object.keys(LABELS), asin, query30.range, progress);
        const visibleRows30d = matches('.vxe-table--body-wrapper').map(body => body.innerText);
        items.push({ asin, ...totals30.values });
        captures.push({
          asin, range30d: query30.range, resultCount30d: query30.resultCount,
          visibleRows30d, totals30d: totals30.raw, capturedAt: new Date().toISOString(),
        });
      }
      return {
        items, capturedAt: new Date().toISOString(),
        source: {
          kind: "lingxing_product_performance_browser_script", url: PRODUCT_URL,
          conditions: { dimension: "MSKU", country: "all", stores: "all", currency: "USD" }, captures,
        },
      };
    } finally { dropdownMotion.remove(); running = false; signal = undefined; }
  }

  globalThis.asterLingxing = Object.freeze({ collectAsins });
})();
