// 隔离标签API与超时取消验证；不连接用户浏览器或正式数据库。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {runtime} from './extension-test-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..');
const checks=[],copyTimeoutCases=[],check=x=>{checks.push(x);console.log('PASS '+x);};
const marker='#aster-sync='+'a'.repeat(32),metrics='https://erp.lingxing.com/erp/productExpressionNew',logistics='https://erp.lingxing.com/erp/msupply/removeInbound';
const tabs=new Map([[41,{id:41,url:metrics,windowId:1}],[42,{id:42,url:metrics+marker,windowId:1,status:'loading'}]]);
const r=await runtime({local:{enabled:false,port:4174,reportTab:999},tabs});
r.context.state={port:4174,connection:{workerId:null,databaseId:'isolated'},reportTab:999};
r.context.job={id:1,requestId:'first',target:{action:'metrics'}};
await r.eval('begin(state,job)');
assert.equal(r.local.reportTab,42);assert.equal(r.calls.filter(c=>c.method==='create').length,0);
assert.equal(r.calls.filter(c=>c.method==='update'&&c.args[1].url).length,0);
assert.equal(r.tabs.get(41).url,metrics);check('从本插件标记恢复指定页，同报表不导航、不新建，不占用日常页');
r.context.job={id:2,requestId:'second',target:{action:'logistics'}};r.failures.update=3;
await r.eval('begin(state,job)');
assert.equal(r.calls.filter(c=>c.method==='update'&&c.args[1].url).length,4);
assert.equal(r.tabs.get(42).url,logistics+marker);
assert.ok(r.calls.filter(c=>c.method==='update').every(c=>c.args[0]===42&&!('active' in c.args[1])));
check('跨报表只导航原标签，沿用拖动错误重试，不激活或聚焦');
let release;let stopping=false;
r.context.chrome.scripting.executeScript=async()=>{stopping=true;await new Promise(resolve=>{release=resolve;});return [{result:null}];};
const completing=r.eval('complete(state,{id:2,message:"完成"})');
await new Promise(resolve=>setImmediate(resolve));assert.equal(stopping,true);assert.ok(r.local.activeJob);
release();await completing;assert.equal(r.local.activeJob,undefined);assert.equal(r.tabs.get(42).url,logistics+marker);
check('清理未结束时保留activeJob，完成后保留最后报表');
r.context.chrome.scripting.executeScript=async()=>[{result:null}];
r.tabs.delete(42);r.context.chrome.tabs.create=async()=>{throw new Error('禁止新建');};
r.context.fetch=async(url,options)=>({ok:true,json:async()=>({job:{id:3,message:JSON.parse(options.body).error}})});
r.context.job={id:3,requestId:'missing',target:{action:'metrics'}};
await r.eval('begin(state,job)');
assert.match(r.local.connectionStatus,/领星同步报表页未打开.*请打开/s);assert.ok(r.local.connectionStatus.includes(metrics+marker));
assert.equal(r.tabs.size,1);assert.equal(r.tabs.get(41).url,metrics);
check('指定页关闭后通过原任务状态提示完整重开地址，零新页且不接管日常页');

// Tabs.url is the last committed address; pendingUrl is an uncommitted navigation target.
// Exact extension ownership remains required even while the dedicated report is loading.
for(const currentUrl of [undefined,'','about:blank',metrics]){
  const ordinary={id:41,url:metrics,status:'complete',windowId:1};
  const pending={id:42,...(currentUrl===undefined?{}:{url:currentUrl}),pendingUrl:metrics+marker,status:'loading',windowId:1};
  const next=await runtime({local:{enabled:false,port:4174},tabs:new Map([[41,ordinary],[42,pending]])});
  next.context.state={port:4174,connection:{workerId:null,databaseId:'isolated'}};
  next.context.job={id:10,requestId:'pending-url',target:{action:'metrics'}};
  await next.eval('begin(state,job)');
  assert.equal(next.local.reportTab,42);assert.equal(next.session.reportTab,42);assert.equal(next.local.activeJob.tabId,42);
  assert.equal(next.calls.filter(call=>call.method==='create').length,0);
  assert.equal(next.calls.filter(call=>call.method==='update'&&call.args[1].url).length,0,'same marked pending report must not be navigated again');
  assert.deepEqual(next.tabs.get(41),ordinary);assert.equal(next.tabs.size,2);
}
check('空URL/about:blank/旧已提交URL下精确marked pendingUrl识别原执行页，同报表待导航不重开，普通页不动');
for(const pendingUrl of [metrics,metrics+'#aster-sync='+'b'.repeat(32),metrics+marker+'&other=1',metrics+'?other=1'+marker]){
  const next=await runtime({local:{enabled:false,port:4174},tabs:new Map([[42,{id:42,url:'about:blank',pendingUrl,status:'loading'}]])});
  next.context.state={};assert.equal(await next.eval('ownedTab(state)'),null);
  assert.equal(next.calls.some(call=>['create','update','remove'].includes(call.method)),false);
}
check('普通页、其他扩展标记和非精确地址的pendingUrl不授予归属，零创建/接管/关闭');
{
  const ordinary={id:41,url:metrics,status:'complete',windowId:1};
  const next=await runtime({local:{enabled:false,port:4174},tabs:new Map([[41,ordinary],[42,{id:42,url:metrics+marker,pendingUrl:logistics+marker,status:'loading',windowId:1}]])});
  next.context.state={port:4174,connection:{workerId:null,databaseId:'isolated'}};
  next.context.job={id:11,requestId:'pending-switch',target:{action:'metrics'}};
  await next.eval('begin(state,job)');
  const navigations=next.calls.filter(call=>call.method==='update'&&call.args[1].url);
  assert.equal(navigations.length,1);assert.equal(navigations[0].args[0],42);assert.equal(navigations[0].args[1].url,metrics+marker);
  assert.equal(next.calls.filter(call=>call.method==='create').length,0);assert.deepEqual(next.tabs.get(41),ordinary);assert.equal(next.tabs.size,2);
}
check('自有页正在导航到另一报表时按pending目标切换原标签，不误沿用旧URL或操作普通页');

{
  const next=await runtime({local:{enabled:false,port:4174},tabs:new Map([[42,{id:42,url:metrics+marker,pendingUrl:'https://erp.lingxing.com/erp/unmarked-user-page',status:'loading'}]])});
  next.context.state={port:4174,connection:{workerId:null,databaseId:'isolated'}};
  next.context.job={id:12,requestId:'unmarked-pending',target:{action:'metrics'}};
  await next.eval('begin(state,job)');
  assert.equal(next.local.reportTab,42);
  assert.equal(next.calls.some(call=>['create','remove'].includes(call.method)),false);
  assert.equal(next.calls.filter(call=>call.method==='update'&&call.args[1].url).length,0);
}
check('pending导航切换仅依据两个精确本标记报表，未标记pending不改变旧已提交URL判定');

// 用真实runner复现：超时后采集仍在finally中，下一任务必须等待。
let finishCleanup,aborted=false;const messages=[];
const element={getBoundingClientRect:()=>({width:1,height:1})};
const context=vm.createContext({AbortController,Date,Error,console,
  setTimeout:(fn,ms)=>setTimeout(fn,ms===180000?10:ms),clearTimeout,
  chrome:{runtime:{sendMessage:async message=>{messages.push(message);}}},
  document:{title:'报表',querySelectorAll:selector=>selector.includes('password')||selector.includes('vxe-table')?[]:[element]},
  asterLingxing:{collectAsins:async(asins,{signal})=>{
    try {await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));}
    finally {await new Promise(resolve=>{finishCleanup=resolve;});}
  }},
});
vm.runInContext(await fs.readFile(new URL('../edge-extension/report-runner.js',import.meta.url),'utf8'),context);
const request={requestId:'timeout',target:{action:'metrics',asins:['BFIXTURE01']}};
context.asterStartReport(request);
await new Promise(resolve=>setTimeout(resolve,30));
assert.equal(aborted,true);assert.equal(context.asterReportState.payload,null);
const pageProgress=messages.find(message=>message.type==='report-progress');
assert.ok(pageProgress&&Number.isFinite(Date.parse(pageProgress.pageAt))&&pageProgress.pageVisibility==='unknown');
assert.equal(messages.filter(m=>m.type==='report-result').length,0);
assert.throws(()=>context.asterStartReport({...request,requestId:'next'}),/尚未结束/);
finishCleanup();await context.asterStopReport('停止');
assert.equal(context.asterReportState.payload.error,'BFIXTURE01：领星采集超过180秒仍未完成。最后进度：“正在读取 BFIXTURE01 的领星指标（1/1）。”；报表页状态：未知。');assert.equal(context.asterReportState.settled,true);
copyTimeoutCases.push({copy:'A007',action:'metrics',milliseconds:180000,visibility:null,error:context.asterReportState.payload.error});
context.asterLingxing.collectAsins=async()=>({items:[{asin:'BFIXTURE01'}],source:{captures:[]}});
context.asterStartReport({...request,requestId:'next'});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(context.asterReportState.payload.capture.items.length,1);assert.equal(context.document.title,'Aster后台查询 · 报表');
check('超时真实取消，finally未完成时不发布结果且拒绝重叠；清理后同文档下一笔成功');
// 后台闹钟发现deadline超时也须等待页内清理，不能提前finish。
context.setTimeout=setTimeout;
context.asterLingxing.collectAsins=async(asins,{signal})=>{
  try {await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
  finally {await new Promise(resolve=>{finishCleanup=resolve;});}
};
context.asterStartReport({...request,requestId:'alarm-timeout'});
await new Promise(resolve=>setImmediate(resolve));
context.document.visibilityState='hidden';
context.asterReportState.deadline=Date.now()-1;
r.tabs.set(42,{id:42,url:metrics+marker,status:'complete',active:false,discarded:false,frozen:true});
r.context.state.activeJob={job:{...request,id:4,requestId:'alarm-timeout'},workerId:null,databaseId:'isolated',tabId:42,started:true};
r.local.activeJob=structuredClone(r.context.state.activeJob);
const finishes=[],progressMessages=[];
r.context.fetch=async(url,options)=>({ok:true,json:async()=>{
  const body=JSON.parse(options.body);
  if(url.endsWith('/progress'))progressMessages.push(body.message);
  if(url.endsWith('/finish')){finishes.push(body);return {job:{id:4,message:body.error,state:'failed'}};}
  return {job:{...r.context.state.activeJob.job,state:'running'}};
}});
r.context.chrome.scripting.executeScript=async options=>{
  context.scriptArgs=options.args??[];
  return [{result:await vm.runInContext('('+options.func.toString()+')(...scriptArgs)',context)}];
};
const inspected=r.eval('inspect(state)');
await new Promise(resolve=>setImmediate(resolve));
assert.equal(finishes.length,0);assert.ok(r.local.activeJob);assert.equal(context.asterReportState.payload,null);
finishCleanup();await inspected;
assert.equal(finishes.length,1);assert.equal(finishes[0].error,'BFIXTURE01：领星报表执行超时。最后进度：“正在读取 BFIXTURE01 的领星指标（1/1）。”；上次记录的报表页状态：未知。');
copyTimeoutCases.push({copy:'A008',action:'metrics',currentVisibility:'hidden',lastVisibility:null,error:finishes[0].error});
assert.equal(r.local.activeJob,undefined);assert.equal(r.tabs.get(42).url,metrics+marker);
assert.ok(progressMessages.some(message=>message.includes('frozen=true')&&message.includes('active=false')));
check('后台采样标签冻结状态但不激活；deadline超时仍先等待页内finally，再保存失败并保留同一报表');
r.tabs.set(42,{id:42,url:'https://login.example.invalid/',status:'complete'});
r.context.state.activeJob={job:{...request,id:5,requestId:'login-redirect'},workerId:null,databaseId:'isolated',tabId:42,started:true};
r.local.activeJob=structuredClone(r.context.state.activeJob);
r.context.chrome.scripting.executeScript=async()=>{throw new Error('不可向登录站点注入');};
await r.eval('inspect(state)');
assert.match(finishes.at(-1).error,/登录/);assert.equal(r.local.activeJob,undefined);
check('指定页跨站登录跳转沿用登录提示，旧文档已销毁时不注入无权限站点且正常结束任务');

// A007/A008只改表达：使用实际runner与后台函数生成错误，保留期限、阶段和状态原值。
const visibilityCases=[['visible','可见'],['hidden','不可见'],['unknown','未知'],[undefined,'未知'],['prerender','prerender'],['constructor','constructor']];
const runnerSource=await fs.readFile(new URL('../edge-extension/report-runner.js',import.meta.url),'utf8');
for(const action of ['metrics','logistics'])for(const [visibility,label]of visibilityCases){
  const timers=new Map(),scheduled=[];let timerId=0;
  const page=vm.createContext({AbortController,Date,Error,console,
    setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});scheduled.push(ms);return id;},clearTimeout:id=>timers.delete(id),
    chrome:{runtime:{sendMessage:async()=>{}}},
    document:{title:'合成报表',visibilityState:'visible',querySelectorAll:selector=>{
      if(selector.includes('password'))return [];
      if(selector==='.vxe-table--main-wrapper')return action==='logistics'?[{...element,querySelectorAll:()=>['MSKU','FNSKU','申报量'].map(innerText=>({innerText}))}]:[];
      if(selector==='#tab-msku')return action==='metrics'?[element]:[];
      return [element];
    }},
    asterLingxing:{collectAsins:async(asins,{signal,onProgress})=>{onProgress('等待近30天报表刷新');await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}},
    queryLingxingRemoval:async(target,{signal})=>{await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},
  });
  vm.runInContext(runnerSource,page);
  page.asterStartReport({requestId:'copy-'+action+'-'+String(visibility),target:action==='metrics'?{action,asins:['BFIXTURE01']}:{action,orderNo:'SYNTHETIC-ORDER-1',fnsku:'SYNTHETIC-FNSKU-1'}});
  await new Promise(resolve=>setImmediate(resolve));
  const milliseconds=action==='metrics'?180000:600000,timer=[...timers.values()].find(item=>item.ms===milliseconds);
  assert.ok(timer,JSON.stringify({action,visibility,scheduled,state:page.asterReportState}));assert.deepEqual(scheduled,[milliseconds]);
  const progress=page.asterReportState.lastProgress;
  assert.equal(page.asterReportState.pageVisibility,'visible');
  if(visibility===undefined)delete page.document.visibilityState;else page.document.visibilityState=visibility;
  timer.fn();await new Promise(resolve=>setImmediate(resolve));
  const expected=(action==='metrics'?'BFIXTURE01：':'')+`领星采集超过${milliseconds/1000}秒仍未完成。最后进度：“${progress}”；报表页状态：${label}。`;
  assert.equal(page.asterReportState.payload.error,expected);assert.equal(page.asterReportState.settled,true);assert.equal(timers.size,0);
  assert.equal(progress,action==='metrics'?'BFIXTURE01：等待近30天报表刷新':'正在读取移除订单 SYNTHETIC-ORDER-1、FNSKU SYNTHETIC-FNSKU-1 的包裹及商品数量。');
  copyTimeoutCases.push({copy:'A007',action,milliseconds,visibility:visibility??null,progress,error:page.asterReportState.payload.error});
}
check('A007保持180/600秒期限、ASIN与具体进度；翻译visible/hidden/unknown/缺失，其他状态原值保留，读取超时时当前状态');
for(const [visibility,label]of visibilityCases){
  const next=await runtime({local:{enabled:false,port:4174},tabs:new Map([[42,{id:42,url:logistics+marker,status:'complete',active:false,discarded:false,frozen:true}]])});
  const progress='正在读取移除订单 SYNTHETIC-ORDER-1、FNSKU SYNTHETIC-FNSKU-1 的包裹及商品数量。';
  const page=vm.createContext({Date,document:{visibilityState:'current-state-not-last-sample'},asterReportState:{deadline:Date.now()-1,key:'copy-alarm',payload:null,lastProgress:progress,...(visibility===undefined?{}:{pageVisibility:visibility})}});
  page.asterStopReport=async message=>{if(!page.asterReportState.payload)page.asterReportState.payload={error:message};};
  next.context.state={port:4174,connection:{workerId:null,databaseId:'isolated'},reportTab:42,activeJob:{job:{id:6,requestId:'copy-alarm',target:{action:'logistics'}},workerId:null,databaseId:'isolated',tabId:42,started:true}};
  next.local.activeJob=structuredClone(next.context.state.activeJob);
  const receipts=[],samples=[];
  next.context.fetch=async(url,options)=>({ok:true,json:async()=>{
    const body=JSON.parse(options.body);
    if(url.endsWith('/progress'))samples.push(body.message);
    if(url.endsWith('/finish')){receipts.push(body);return {job:{id:6,message:body.error,state:'failed'}};}
    return {job:{...next.context.state.activeJob.job,state:'running'}};
  }});
  next.context.chrome.scripting.executeScript=async options=>{page.scriptArgs=options.args??[];return [{result:await vm.runInContext('('+options.func.toString()+')(...scriptArgs)',page)}];};
  await next.eval('inspect(state)');
  const expected=`领星报表执行超时。最后进度：“${progress}”；上次记录的报表页状态：${label}。`;
  assert.equal(receipts.length,1);assert.equal(receipts[0].error,expected);assert.equal(next.local.activeJob,undefined);
  assert.ok(next.local.connectionStatus.includes(expected));assert.ok(samples.some(message=>message.includes('frozen=true')&&message.includes('active=false')));
  assert.equal(next.calls.some(call=>['create','update','remove'].includes(call.method)),false);
  copyTimeoutCases.push({copy:'A008',action:'logistics',lastVisibility:visibility??null,currentVisibility:page.document.visibilityState,progress,error:receipts[0].error});
}
check('A008保留具体进度、后台冻结诊断与单次失败回执；使用上次记录状态而非当前状态，其他状态原值不丢失');
const output=process.env.ASTER_CLEANUP_RESULT||path.join(root,'.test-output/cleanup-result.json');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify({kind:'isolated-vm-chrome-api-and-runner',checks,copyTimeoutCases,realLingxing:false},null,2));
