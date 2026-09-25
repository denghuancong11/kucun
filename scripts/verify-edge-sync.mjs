// 真实 Edge 加载扩展；报表为隔离 DOM 样例，不作为真实领星取数验收。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from '../web/node_modules/playwright-core/index.mjs';
import {createInventoryDatabase,InventoryDatabase,INVENTORY_DATABASE_NAME} from '../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from './test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'..');
const output=path.resolve(process.env.ASTER_EDGE_RESULT || path.join(root,'.test-output/edge-result.json'));
await fs.mkdir(path.dirname(output),{recursive:true});
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aster-background-')),stateRoot=path.join(dir,'state');
await fs.mkdir(path.join(stateRoot,'data'),{recursive:true});createInventoryDatabase({databasePath:path.join(stateRoot,'data',INVENTORY_DATABASE_NAME)});
const db=new InventoryDatabase(stateRoot),rid=()=>crypto.randomUUID();
const common={model:'SYNTH-TONER-001',fnsku:'X011111111',department:'一团',store:'隔离US',operator:'后台验证',role:'operation-1',quantity:20};
const a=db.createInquiry({...common,asin:'BFIXTURE01',requestId:rid()}).record;
const b=db.createInquiry({...common,asin:'BFIXTURE00',requestId:rid()}).record;
const bad=db.createInquiry({...common,asin:'BFIXTURE02',requestId:rid()}).record;
let source=db.createAllocation({...common,asin:a.asin,plan:'TEST-PLAN-TONER',date:'2026-02-10',version:'V11',requestId:rid()}).record;
source=db.reviewAllocation({id:source.id,role:'business',decision:'approve',approvedQuantity:20,expectedRevision:source.revision,requestId:rid()}).record;
source=db.confirmAllocation({id:source.id,role:'assistant-1',expectedRevision:source.revision,requestId:rid()}).record;
let work=db.initiateRelocationUpgrade({allocationId:source.id,role:'operation-1',requestId:rid()}).workItem;
work=db.recordRelocationProcurement({id:work.id,role:'purchasing',rma:'TEST',relocationAddress:'隔离仓',expectedRevision:work.revision,requestId:rid()}).workItem;
work=db.recordRelocationOperation({id:work.id,role:'operation-1',removalOrderNo:'TEST-ORDER',expectedRevision:work.revision,requestId:rid()}).workItem;
const before=db.getCatalog(),port=await freePort(),base=`http://127.0.0.1:${port}`;
let server,context,background,extensionId,login=false,mode='normal';
const checks=[],errors=[],jobs=[],timings=[],queries=[],scrollTrace=[];
const check=s=>{checks.push(s);console.log('PASS '+s);};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,message,timeout=75000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await wait(200);}throw new Error(message);}
async function start(){const instanceId=createTestInstanceId('background-edge');server=spawn(process.execPath,[path.join(root,'server.mjs')],{windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:stateRoot,ASTER_TEST_INSTANCE_ID:instanceId,PORT:String(port),HOST:'127.0.0.1'}});await waitForOwnedServer({base,child:server,instanceId});}
async function stop(){const ended=new Promise(r=>server.once('close',r));server.kill();await ended;server=null;}
async function api(route,body,role='admin'){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
const metric={action:'metrics',documents:[{kind:'inquiry',id:a.id}]},logistic={action:'logistics',workId:work.id};
const submit=async(target,role='admin')=>(await api('/api/lingxing/jobs',{...target,requestId:rid()},role)).job;
async function done(job,state='succeeded',timeout=100000){const row=await until(()=>{const r=db.db.prepare('SELECT * FROM lingxing_sync_jobs WHERE id=?').get(job.id);return ['succeeded','failed'].includes(r.state)?r:null;},'job timeout '+job.id,timeout);jobs.push({id:row.id,state:row.state,message:row.message,startedAt:row.started_at,finishedAt:row.finished_at});assert.equal(row.state,state,row.message);await until(()=>background.evaluate(async()=>!(await chrome.storage.local.get('activeJob')).activeJob),'extension job not cleared');return row;}
async function wake(){await background.evaluate(()=>run(pulse));}
async function storage(){return background.evaluate(()=>chrome.storage.local.get(null));}
async function tabs(){return background.evaluate(()=>chrome.tabs.query({}));}
async function snapshot(){return background.evaluate(async()=>({tabs:(await chrome.tabs.query({active:true})).map(t=>({id:t.id,windowId:t.windowId,url:t.url})),windows:(await chrome.windows.getAll()).map(w=>({id:w.id,focused:w.focused,state:w.state}))}));}
try{
 await start();
 const extension=path.join(root,'edge-extension');
 context=await chromium.launchPersistentContext(path.join(dir,'profile'),{executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1366,height:900}});
 background=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');extensionId=new URL(background.url()).host;
 context.on('weberror',event=>errors.push(event.error().message));
 const metricSource=await fs.readFile(path.join(root,'scripts/verify-lingxing-page-collector.mjs'),'utf8');
 const metricFixture=metricSource.match(/const fixture = `([\s\S]*?)`;\r?\n/)[1].replace('const visible = columns.slice(offset,offset+3);',"void window.__scrollTrace({offset,left:select('.vxe-table--body-wrapper.body--wrapper').scrollLeft,visibility:document.visibilityState});const visible = columns.slice(offset,offset+3);").replaceAll("fixture.mode==='empty'","(fixture.mode==='empty'||(fixture.mode==='second-empty'&&asin==='BFIXTURE02'))");
 const removalFixture=await fs.readFile(path.join(root,'scripts/fixtures/removal-inbound.html'),'utf8');
 await context.exposeBinding('__scrollTrace',({page},data)=>{scrollTrace.push({url:page.url(),...data});});
 await context.exposeBinding('__traceQuery',({page},data)=>{queries.push({url:page.url(),...data});});
 await context.route('https://erp.lingxing.com/**',route=>{
  let body=login?'<input type="password">':route.request().url().includes('productExpressionNew')?metricFixture.replace('</script>',`fixture.mode=${JSON.stringify(mode)};</script>`).replace('fixture.events.push({asin, range:selectedRange, currency:',"void window.__traceQuery({report:'metrics',asin,range:selectedRange,currency:select('#currency').value});fixture.events.push({asin, range:selectedRange, currency:"):removalFixture.replace("q('#query').onclick=()=>{","q('#query').onclick=()=>{void window.__traceQuery({report:'logistics',order:q('#order').value,type:q('#typeLabel').textContent});");
  return route.fulfill({contentType:'text/html',body});
 });
 // 用户预先打开带插件标记的执行页；同步本身不创建标签页。
 context.on('page',page=>{page.on('pageerror',e=>errors.push(e.message));});
 const manual=await context.newPage();await manual.goto('https://erp.lingxing.com/erp/productExpressionNew');
 await manual.evaluate(()=>{globalThis.manualDocument='unchanged';document.querySelector('.search-input > input').value='MY-FILTER';});
 const manualBefore=await manual.evaluate(()=>({url:location.href,body:document.body.innerHTML}));
 const report=await context.newPage();await report.goto('https://erp.lingxing.com/erp/productExpressionNew#aster-sync='+extensionId);
 await report.evaluate(()=>{globalThis.originalDocument=true;});
 const navigations=[];report.on('framenavigated',frame=>{if(frame===report.mainFrame())navigations.push(frame.url());});
 const settings=await context.newPage();await settings.goto(`chrome-extension://${extensionId}/worker.html`);
 await settings.locator('#port').fill(String(port));await settings.locator('#connect').click();await until(async()=>(await api('/api/lingxing/jobs?action=metrics')).worker.connected,'not connected');
 await manual.bringToFront();await settings.close();const activeBefore=await snapshot(),initialTabCount=(await tabs()).length;
 check('首次配置后关闭设置页，执行连接仍有效');
 const m=await submit(metric,'business'),l=await submit(logistic,'operation-1');await wake();
 const mr=await done(m),lr=await done(l);assert.ok(lr.started_at>=mr.finished_at);
 const capture=JSON.parse(mr.capture_json);assert.equal(capture.items[0].sales7d,21);assert.equal(capture.items[0].sales30d,1234);assert.equal(capture.items[0].orderGrossProfit,123.45);assert.equal(capture.source.captures[0].totals30d['订单毛利润'],'$123.45');
 assert.deepEqual(JSON.parse(lr.capture_json).shipments.map(s=>s.quantity),[2,3]);assert.equal(JSON.parse(lr.capture_json).source.allProductQuantity,14);
 assert.equal(db.db.prepare('SELECT synced_by_role FROM lingxing_asin_metrics WHERE asin=?').get(a.asin).synced_by_role,'business');
 assert.deepEqual(await snapshot(),activeBefore);assert.deepEqual(await manual.evaluate(()=>({url:location.href,body:document.body.innerHTML})),manualBefore);
 assert.equal((await tabs()).length,initialTabCount);assert.equal(navigations.length,1);check('指标物流后台串行，只在指定页切换报表，零新增标签，原报表/当前标签/窗口焦点不变，取数正确');
 const owned=(await storage()).reportTab;assert.ok(owned);
 const again=await submit(metric);await wake();await done(again);assert.equal((await storage()).reportTab,owned);check('两种报表交替复用同一个插件页，不累积页面');
 const navigationCount=navigations.length;
 const repeat=await submit(metric);await wake();await done(repeat);assert.equal(navigations.length,navigationCount);assert.ok(report.url().includes('productExpressionNew#aster-sync='));check('连续指标直接复用原文档，完成后保留报表，不重新导航或清空');
 // HTTP临时失败注入在真实扩展SW，不替换任务或采集实现。
 await background.evaluate(()=>{const original=fetch;let failed=false;globalThis.fetch=async(...args)=>{if(!failed&&String(args[0]).endsWith('/heartbeat')){failed=true;throw new TypeError('isolated temporary network failure');}return original(...args);};});
 await background.evaluate(()=>run(pulse).catch(()=>{}));assert.match((await storage()).connectionStatus,/自动重试/);const id=(await storage()).connection.workerId;
 await wake();assert.equal((await storage()).connection.workerId,id);assert.match((await storage()).connectionStatus,/已恢复连接/);check('短暂心跳请求失败后自动恢复原身份，无需点击连接');
 // 领取响应丢失，下一周期恢复已领取的同一请求。
 await background.evaluate(()=>{const original=fetch;let failed=false;globalThis.fetch=async(...args)=>{const r=await original(...args);if(!failed&&String(args[0]).endsWith('/claim')){failed=true;await r.json();throw new TypeError('isolated lost claim response');}return r;};});
 const lostClaim=await submit(metric);await background.evaluate(()=>run(pulse).catch(()=>{}));await wake();await done(lostClaim);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM lingxing_sync_jobs WHERE request_id=?').get(lostClaim.requestId).n,1);check('领取回执丢失后恢复原任务，不双领');
 // 保存已提交但回执丢失；必须查询原结果，不重复取数和保存。
 await background.evaluate(()=>{const original=fetch;let failed=false;globalThis.finishAttempts=0;globalThis.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]).endsWith('/finish')){globalThis.finishAttempts++;if(!failed){failed=true;await r.json();throw new TypeError('isolated lost finish response');}}return r;};});
 const version=db.syncState().dataVersion,queryStart=queries.length,lostFinish=await submit(metric);await wake();await until(()=>db.db.prepare('SELECT state FROM lingxing_sync_jobs WHERE id=?').get(lostFinish.id).state==='succeeded','finish not saved');await wake();await done(lostFinish);assert.equal(await background.evaluate(()=>finishAttempts),1);assert.equal(db.syncState().dataVersion,version+1);assert.equal(queries.length-queryStart,2);check('保存回执丢失只核对成功状态，未重复取数或保存');
 login=true;await report.reload();const failed=await submit(metric);await wake();assert.match((await done(failed,'failed')).message,/登录/);assert.equal((await api('/api/lingxing/jobs?action=metrics')).worker.connected,true);assert.deepEqual(await snapshot(),activeBefore);login=false;await report.reload();const recovered=await submit(metric);await wake();await done(recovered);check('登录失效与连接状态分别显示，无登录弹窗；用户登录恢复后新请求正常保存');
 mode='second-empty';await report.evaluate(()=>{fixture.mode='second-empty';});const valuesBefore=db.db.prepare('SELECT * FROM lingxing_asin_metrics ORDER BY asin').all();const mixedBad=await submit({action:'metrics',documents:[{kind:'inquiry',id:a.id},{kind:'inquiry',id:bad.id}]});const mixedGood=await submit(logistic);await wake();assert.match((await done(mixedBad,'failed')).message,/BFIXTURE02/);await done(mixedGood);assert.deepEqual(db.db.prepare('SELECT * FROM lingxing_asin_metrics ORDER BY asin').all(),valuesBefore);mode='normal';check('一批指标任一ASIN失败不保存，后续物流继续按序执行');
 const logisticsNavigations=navigations.length;const repeatLogistics=await submit(logistic);await wake();await done(repeatLogistics);assert.equal(navigations.length,logisticsNavigations);assert.ok(report.url().includes('removeInbound#aster-sync='));check('连续物流复用同一文档且保留包裹报表');
 // 不用页面计时器唤醒：实际闲置超过原租期，依靠扩展alarms。
 const idleStart=Date.now();await wait(101000);assert.equal((await api('/api/lingxing/jobs?action=metrics')).worker.connected,true);const afterIdle=await submit(logistic);await done(afterIdle);timings.push({name:'idle-over-90-seconds',elapsedMs:Date.now()-idleStart});check('设置页关闭后真实闲置101秒，超过原90秒租期仍由闹钟维持并领取新任务');
 // 将一笔物流取数延迟310秒，验证超过MV3五分钟事件限制，且中途回收SW。
 await background.evaluate(()=>{const execute=chrome.scripting.executeScript.bind(chrome.scripting);let delayed=false;chrome.scripting.executeScript=async options=>{const result=await execute(options);if(!delayed&&options.files?.includes('lingxing-removal-page-collector.js')){delayed=true;await execute({target:options.target,func:()=>{const collect=queryLingxingRemoval;globalThis.queryLingxingRemoval=async options=>{await new Promise(r=>setTimeout(r,310000));return collect(options);};}});}return result;};});
 const longStart=Date.now(),longJob=await submit(logistic);await wake();await until(async()=>(await storage()).activeJob?.started,'long task did not start');
 // 关闭真实SW目标（非关闭浏览器），验证下一闹钟从存储恢复。
 const cdp=await context.newCDPSession(manual);const targets=(await cdp.send('Target.getTargets')).targetInfos;const sw=targets.find(t=>t.type==='service_worker'&&t.url.includes(extensionId));
 await cdp.send('Target.closeTarget',{targetId:sw.targetId});await wait(1000);const resumeStart=Date.now();
 background=await until(()=>context.serviceWorkers().find(w=>w.url().includes(extensionId)),'SW did not wake',50000);
 await until(async()=>(await api('/api/lingxing/jobs?action=metrics')).worker.connected,'lease lost');await done(longJob,'succeeded',360000);assert.ok(Date.now()-longStart>=310000);timings.push({name:'long-report-with-worker-recycle',elapsedMs:Date.now()-longStart});check('长采集实际超过五分钟且中途回收SW，原物流仍完成并只保存一次');const afterWorker=await submit(metric);await done(afterWorker);timings.push({name:'worker-recycle-recovery',elapsedMs:Date.now()-resumeStart});check('Service Worker回收后由闹钟唤醒，身份和串行执行恢复');
 const oldId=(await storage()).connection.workerId;await stop();await wait(3000);await start();await until(async()=>(await api('/api/lingxing/jobs?action=metrics')).worker.connected,'restart reconnect',65000);assert.notEqual((await storage()).connection.workerId,oldId);const afterRestart=await submit(logistic);await done(afterRestart);check('库存服务重启后无需设置页，自动建立新连接并完成后续物流');
 const setting2=await context.newPage();await setting2.goto(`chrome-extension://${extensionId}/worker.html`);await setting2.locator('#disconnect').click();await until(async()=>!(await storage()).enabled,'disconnect');await setting2.close();await background.evaluate(()=>run(initialize));assert.equal((await api('/api/lingxing/jobs?action=metrics')).worker.connected,false);check('主动断开持久生效，初始化和闹钟不会自动覆盖');
 assert.deepEqual(db.getCatalog().models,before.models);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM upgrade_relocations').get().n,0);db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.deepEqual(errors,[]);check('同步不采纳包裹、不登记发货、不修改库存，页面与脚本无错误');
 await manual.screenshot({path:path.join(path.dirname(output),'edge-user-report-unchanged.png')});
} finally {
 await fs.writeFile(output,JSON.stringify({kind:'isolated-real-edge-mock-reports',realLingxing:false,checks,errors,jobs,timings,queries,scrollTrace,stateRoot,at:new Date().toISOString()},null,2));
 await context?.close();if(server)await stop();db.close();
}

