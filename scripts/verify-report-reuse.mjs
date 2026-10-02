// 隔离标签API与超时取消验证；不连接用户浏览器或正式数据库。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {runtime} from './extension-test-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..');
const checks=[],check=x=>{checks.push(x);console.log('PASS '+x);};
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
assert.equal(r.local.connectionStatus,`领星同步页面未打开，请在部署电脑的 Edge 打开 ${metrics+marker}，然后重新同步。`);
assert.equal(r.tabs.size,1);assert.equal(r.tabs.get(41).url,metrics);
check('指定页关闭后通过原任务状态提示完整重开地址，零新页且不接管日常页');

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
assert.equal(context.asterReportState.payload.error,'BFIXTURE01：领星查询超时，请在部署电脑检查报表后重新同步。');assert.equal(context.asterReportState.settled,true);
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
assert.match(r.local.activeJob.lastTabState.value,/active=false.*frozen=true/);
finishCleanup();await inspected;
assert.equal(finishes.length,1);assert.equal(finishes[0].error,'BFIXTURE01：领星查询超时，请在部署电脑检查报表后重新同步。');
assert.equal(r.local.activeJob,undefined);assert.equal(r.tabs.get(42).url,metrics+marker);
assert.ok(progressMessages.includes('正在检查领星页面…'));
check('后台采样标签冻结状态但不激活；deadline超时仍先等待页内finally，再保存失败并保留同一报表');
r.tabs.set(42,{id:42,url:'https://login.example.invalid/',status:'complete'});
r.context.state.activeJob={job:{...request,id:5,requestId:'login-redirect'},workerId:null,databaseId:'isolated',tabId:42,started:true};
r.local.activeJob=structuredClone(r.context.state.activeJob);
r.context.chrome.scripting.executeScript=async()=>{throw new Error('不可向登录站点注入');};
await r.eval('inspect(state)');
assert.match(finishes.at(-1).error,/登录/);assert.equal(r.local.activeJob,undefined);
check('指定页跨站登录跳转沿用登录提示，旧文档已销毁时不注入无权限站点且正常结束任务');
const output=process.env.ASTER_CLEANUP_RESULT||path.join(root,'.test-output/cleanup-result.json');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify({kind:'isolated-vm-chrome-api-and-runner',checks,realLingxing:false},null,2));
