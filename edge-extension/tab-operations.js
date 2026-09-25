// Edge拖动标签页期间拒绝修改标签页；只重试这个明确错误，不重跑采集或保存。
async function editTab(method, ...args) {
  for (let attempt=0;;attempt++) {
    try {
      return await chrome.tabs[method](...args);
    } catch(error) {
      if(error.message !== 'Tabs cannot be edited right now (user may be dragging a tab).' || attempt===39) throw error;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
  }
}
