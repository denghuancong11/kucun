importScripts('tab-operations.js');
const urls = {metrics:'https://erp.lingxing.com/erp/productExpressionNew',logistics:'https://erp.lingxing.com/erp/msupply/removeInbound'};
const alarmName = 'aster-lingxing-connection';
const marker = '#aster-sync=' + chrome.runtime.id;
let serial = Promise.resolve();
// 每次唤醒仅执行短调用；长时间报表采集在专用标签页运行。
function run(action) {
  const result = serial.then(action);
  serial = result.catch(async error=>{await chrome.storage.local.set({connectionStatus:`连接暂时不可用，将自动重试。\n${error.message}`});});
  return result;
}
async function api(state, action, body={}) {
  const response = await fetch(`http://127.0.0.1:${state.port}/api/lingxing-worker/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workerId:state.connection?.workerId,...body}),signal:AbortSignal.timeout(15000)});
  const value = await response.json();
  if(!response.ok) {const error=new Error(value.error);error.code=value.code;error.status=response.status;throw error;}
  return value;
}
async function connect(state) {
  if(state.connection) {
    try {
      await api(state,'heartbeat',{version:chrome.runtime.getManifest().version});
      const {connectionStatus}=await chrome.storage.local.get('connectionStatus');
      if(connectionStatus?.startsWith('连接暂时不可用'))await chrome.storage.local.set({connectionStatus:`已恢复连接，端口 ${state.port}\n后台等待库存系统的同步请求。`});
      return;
    }
    catch(error) {if(error.code!=='worker_disconnected')throw error;}
  }
  const connected=await api(state,'connect',{version:chrome.runtime.getManifest().version});
  state.connection={workerId:connected.workerId,databaseId:connected.databaseId,host:connected.host};
  await chrome.storage.local.set({connection:state.connection,connectionStatus:`已连接部署电脑 ${connected.host}，端口 ${state.port}\n后台等待库存系统的同步请求。`});
}
async function ownedTab(state) {
  let tab;
  if(state.reportTab) {
    try {tab=await chrome.tabs.get(state.reportTab);}
    catch(error) {if(!/No tab|Invalid tab/i.test(error.message))throw error;}
  }
  const session=await chrome.storage.session.get('reportTab');
  const url=tab?.url ?? tab?.pendingUrl ?? '';
  if(tab && !url.startsWith('about:blank') && (session.reportTab===tab.id ||
    (url.startsWith('https://erp.lingxing.com/') && url.endsWith(marker)))) return tab;
  // 只认本插件标记，不接管其他日常领星页，也不自动补建执行页。
  return (await chrome.tabs.query({})).find(tab=>Object.values(urls).some(url=>[tab.url,tab.pendingUrl].includes(url+marker))) ?? null;
}
async function stopReport(active, message) {
  if(!active?.tabId) return;
  let tab;
  try {tab=await chrome.tabs.get(active.tabId);}
  catch(error) {if(/No tab|Invalid tab/i.test(error.message))return;throw error;}
  // 已跳到其他站点（如登录站点）时旧报表文档已销毁，无须越权注入。
  if(!(tab.url ?? '').startsWith('https://erp.lingxing.com/')) return;
  // 等待采集的 finally 完成，才提交结果或领取下一笔；保留当前报表。
  await chrome.scripting.executeScript({target:{tabId:active.tabId},func:async message=>{await globalThis.asterStopReport?.(message);},args:[message ?? '本次采集已结束']});
}
async function begin(state, job) {
  const tab=await ownedTab(state);
  if(!tab) {
    const receipt=await api(state,'finish',{id:job.id,error:`领星执行页未打开，请重新打开 ${urls.metrics+marker} 后再次同步。`});
    await complete(state,receipt.job);
    return;
  }
  state.reportTab=tab.id;
  await chrome.storage.local.set({reportTab:tab.id});
  await chrome.storage.session.set({reportTab:tab.id});
  await stopReport({tabId:tab.id});
  state.activeJob={job,workerId:state.connection.workerId,databaseId:state.connection.databaseId,tabId:tab.id,started:false,openedAt:Date.now()};
  await chrome.storage.local.set({activeJob:state.activeJob});
  const pendingReportUrl=Object.values(urls).find(url=>tab.pendingUrl===url+marker);
  const switching=(pendingReportUrl ?? (tab.url ?? '').split(/[?#]/)[0])!==urls[job.target.action];
  await editTab('update',tab.id,{...(switching?{url:urls[job.target.action]+marker}:{}),autoDiscardable:false});
  await api(state,'progress',{id:job.id,message:switching?'正在原执行页切换领星报表':'正在复用已打开的领星报表'});
  if(!switching && tab.status==='complete') await inspect(state);
}
async function complete(state, job) {
  await stopReport(state.activeJob);
  await chrome.storage.local.remove('activeJob');
  state.activeJob=null;
  await chrome.storage.local.set({connectionStatus:`#${job.id} ${job.message}\n连接保持中，后台等待下一次请求。`});
}
async function recordTabState(state, active, tab) {
  const value=tab ? `status=${tab.status??'unknown'},active=${tab.active===true},discarded=${typeof tab.discarded==='boolean'?tab.discarded:'unknown'},frozen=${typeof tab.frozen==='boolean'?tab.frozen:'unknown'}` : '执行页不存在';
  if(active.lastTabState?.value===value)return;
  const sampledAt=new Date().toISOString();
  await api(state,'progress',{id:active.job.id,message:`扩展采样执行页状态：${value}；采样时间=${sampledAt}`});
  active.lastTabState={value,at:sampledAt};
  await chrome.storage.local.set({activeJob:active});
}
async function inspect(state) {
  const active=state.activeJob;
  if(active.databaseId!==state.connection.databaseId) throw new Error('库存数据库身份已改变，原任务结果未提交，请核对连接端口。');
  const {job}=await api(state,'resume',{id:active.job.id,jobWorkerId:active.workerId});
  if(job.state!=='running') {await complete(state,job);return;}
  const tab=await ownedTab(state);
  await recordTabState(state,active,tab);
  if(!tab || tab.id!==active.tabId) active.payload={error:`领星执行页已关闭，本次同步未完成。请重新打开 ${urls.metrics+marker} 后再次同步。`};
  if(!active.payload && tab.status==='complete') {
    if((tab.url ?? '').split(/[?#]/)[0]!==urls[job.target.action]) active.payload={error:'领星尚未登录、登录已过期或需要验证，请在部署电脑的 Edge 主动登录后重新同步。'};
    else if(!active.started) {
      await chrome.scripting.executeScript({target:{tabId:tab.id},files:[job.target.action==='metrics'?'lingxing-page-collector.js':'lingxing-removal-page-collector.js','report-runner.js']});
      await chrome.scripting.executeScript({target:{tabId:tab.id},func:job=>{globalThis.asterStartReport(job);},args:[job]});
      active.started=true;
      await chrome.storage.local.set({activeJob:active});
    } else {
      const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{
        const report=globalThis.asterReportState;
        if(report && !report.payload && Date.now()>report.deadline) await globalThis.asterStopReport(`页面执行期限已到；最后阶段“${report.lastProgress??'未知'}”；页面可见性${report.pageVisibility??'未知'}`);
        return report ?? null;
      }});
      const report=result.result;
      if(!report || report.key!==job.requestId) active.payload={error:'插件后台报表已刷新，本次采集中断，请重新发起。'};
      else if(report.payload) active.payload=report.payload;
    }
  } else if(!active.payload && Date.now()-active.openedAt>30000) active.payload={error:`执行页30秒内未就绪（status=${tab?.status??'unknown'}, discarded=${typeof tab?.discarded==='boolean'?tab.discarded:'unknown'}, frozen=${typeof tab?.frozen==='boolean'?tab.frozen:'unknown'}），未开始采集`};
  if(active.payload) {
    // 先保存同一次采集结果。回执丢失后先 resume，成功结果不重复写入。
    await chrome.storage.local.set({activeJob:active});
    await stopReport(active);
    const receipt=await api(state,'finish',{id:job.id,...active.payload});
    await complete(state,receipt.job);
  }
}
async function pulse() {
  const state=await chrome.storage.local.get(['port','enabled','connection','activeJob','reportTab']);
  if(!state.enabled) return;
  await connect(state);
  if(state.activeJob) await inspect(state);
  if(state.activeJob) return;
  // 领取回执丢失时先找已领取的任务，不重复领取或另建请求。
  const {job:running}=await api(state,'resume');
  const job=running ?? (await api(state,'claim')).job;
  if(job) await begin(state,job);
}
async function initialize() {
  const state=await chrome.storage.local.get(['port','enabled']);
  // 旧版已配置端口则迁移启用；新版主动断开保存 false，不被启动覆盖。
  if(state.enabled===undefined && state.port) await chrome.storage.local.set({enabled:true});
  if(!await chrome.alarms.get(alarmName)) await chrome.alarms.create(alarmName,{periodInMinutes:0.5});
  await pulse();
}
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===alarmName)void run(pulse);});
chrome.runtime.onStartup.addListener(()=>{void run(initialize);});
chrome.runtime.onInstalled.addListener(()=>{void run(async()=>{await chrome.scripting.unregisterContentScripts();await chrome.storage.local.remove('origins');await initialize();});});
chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='complete')void run(async()=>{const {activeJob}=await chrome.storage.local.get('activeJob');if(activeJob?.tabId===id)await pulse();});});
chrome.tabs.onRemoved.addListener(id=>{void run(async()=>{const {activeJob}=await chrome.storage.local.get('activeJob');if(activeJob?.tabId===id)await pulse();});});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message.type==='report-progress' || message.type==='report-result') {
    void run(async()=>{
      const state=await chrome.storage.local.get(['port','enabled','connection','activeJob']);
      if(!state.enabled || state.activeJob?.tabId!==sender.tab?.id || state.activeJob.job.requestId!==message.key) return;
      if(message.type==='report-progress') {
        const sample=state.activeJob.lastTabState;
        const tabState=sample ? `${sample.value}；采样时间=${sample.at}` : '未采样';
        const detail=`${message.text}（页面时间：${message.pageAt??'未记录'}；可见性：${message.pageVisibility??'未记录'}；标签状态：${tabState}）`;
        await chrome.storage.local.set({connectionStatus:`#${state.activeJob.job.id} ${detail}`});
        await api(state,'progress',{id:state.activeJob.job.id,message:detail});
      } else await pulse();
    }).then(()=>respond({ok:true}),error=>respond({error:error.message}));
    return true;
  }
  if(sender.url!==chrome.runtime.getURL('worker.html')) return;
  if(message.type==='connect') {
    void run(async()=>{
      if(!Number.isInteger(message.port)||message.port<1||message.port>65535)throw new Error('本机库存服务端口请填写 1 至 65535 之间的整数');
      const state=await chrome.storage.local.get(['enabled','port']);
      if(state.enabled && state.port!==message.port)throw new Error('请先断开当前服务，再修改端口。');
      await chrome.storage.local.set({port:message.port,enabled:true});
      await initialize();
    }).then(()=>respond({ok:true}),error=>respond({error:error.message}));return true;
  }
  if(message.type==='disconnect') {
    void run(async()=>{
      const state=await chrome.storage.local.get(['port','enabled','connection','activeJob']);
      if(state.activeJob)throw new Error('仍有同步任务正在执行，请等任务结束后再断开。');
      try {if(state.connection)await api(state,'disconnect');}
      catch(error) {if(error.status && error.code!=='worker_disconnected')throw error;}
      await chrome.storage.local.set({enabled:false,connectionStatus:'已主动断开，自动连接已停止。'});
      await chrome.storage.local.remove('connection');
    }).then(()=>respond({ok:true}),error=>respond({error:error.message}));return true;
  }
});
// 只有用户点击图标才显示设置页，自动运行路径没有激活或聚焦操作。
chrome.action.onClicked.addListener(async()=>{
  const url=chrome.runtime.getURL('worker.html');
  const existing=(await chrome.tabs.query({})).find(tab=>tab.url===url);
  if(existing) {await editTab('update',existing.id,{active:true});return;}
  await editTab('create',{url,active:true});
});
void run(initialize);
