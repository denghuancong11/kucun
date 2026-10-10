import {relocationAddressFixture} from '../../scripts/fixtures/relocation-workbook.mjs';
// 真实React页面、HTTP和隔离SQLite；领星执行端使用协议样例，不访问真实领星。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {createInventoryDatabase,InventoryDatabase,INVENTORY_DATABASE_NAME} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-sync-buttons-'));
const output=process.env.ASTER_SYNC_UI_OUTPUT || path.join(root,'.test-output/sync-buttons');
await fs.mkdir(path.join(state,'data'));await fs.mkdir(output,{recursive:true});
createInventoryDatabase({databasePath:path.join(state,'data',INVENTORY_DATABASE_NAME)});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID();
db.db.prepare("UPDATE stock_batches SET pack_per_box='10' WHERE model='SYNTH-TONER-001'").run();
const common={role:'operation-1',model:'SYNTH-TONER-001',fnsku:'XBUTTON001',department:'一团',store:'AUS',quantity:20};
const docs=['甲单','乙单'].map(operator=>db.createInquiry({...common,operator,asin:'BBUTTON001',requestId:rid()}).record);
const works=[];
for(let i=0;i<2;i++) {
 let row=db.createAllocation({...common,operator:`物流${i}`,asin:'BBUTTON001',plan:'TEST-PLAN-TONER',date:'2026-02-10',version:'V11',requestId:rid()}).record;
 row=db.reviewAllocation({id:row.id,role:'business',decision:'approve',approvedQuantity:20,expectedRevision:row.revision,requestId:rid()}).record;
 row=db.confirmAllocation({id:row.id,role:'assistant-1',expectedRevision:row.revision,requestId:rid()}).record;
 let work=db.initiateRelocationUpgrade({allocationId:row.id,role:'operation-1',requestId:rid()}).workItem;
 work=db.recordRelocationProcurement({id:work.id,role:"logistics",rma:'测试RMA',relocationAddress:relocationAddressFixture,expectedRevision:work.revision,requestId:rid()}).workItem;
 work=db.recordRelocationOperation({id:work.id,role:'operation-1',removalOrderNo:`BUTTON-ORDER-${i}`,expectedRevision:work.revision,requestId:rid()}).workItem;
 works.push(work);
}
const stockBefore=db.getCatalog(),syncBefore=db.syncState();
const port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('sync-buttons');
const server=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,ASTER_TEST_INSTANCE_ID:instanceId,HOST:'127.0.0.1',PORT:String(port),PROD:'1'}});
const checks=[],errors=[],posts=[],recoveryEvidence=[];
const check=name=>{checks.push(name);console.log('PASS '+name);};
let browser,workerId,heartbeat;
const api=async(route,role='business',body,worker=false)=>{
 const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json',...(worker?{origin:'chrome-extension://'+'a'.repeat(32)}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;
};
const execute=(action,body={})=>api('/api/lingxing-worker/'+action,'admin',{workerId,...body},true);
const metric=sales=>({asin:'BBUTTON001',sales7d:77,sales30d:sales,orderGrossProfit:51.2,fbaAvailable:115,fbaPendingTransfer:96,fbaTransferring:5,fbaInbound:160});
const finishMetric=(id,sales=777)=>execute('finish',{id,capture:{items:[metric(sales)],capturedAt:new Date().toISOString()}});
const label=async(container,text,enabled)=>{const button=container.getByRole('button',{name:text,exact:true});await button.waitFor();if(enabled!==undefined)assert.equal(await button.isEnabled(),enabled);};
const nav=async(page,name)=>{await page.locator('.sidebar .nav-item',{hasText:name}).click();await page.waitForLoadState('networkidle');};
const role=async(page,value)=>{await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(value);await page.waitForLoadState('networkidle');};
const filter=async(page,value)=>{await page.getByLabel('搜索运营姓名、型号或 ASIN',{exact:true}).fill(value);};
const submit=async(page,container,name)=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/lingxing/jobs'&&r.request().method()==='POST');await container.getByRole('button',{name,exact:true}).click();return (await(await response).json()).job;};
const newPage=async(context)=>{
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/lingxing/jobs')posts.push(request.postDataJSON());});
 // 冻结全局版本轮询，单独证明同步成功回调刷新了业务数据。
 await page.route('**/api/sync',route=>route.fulfill({json:{ok:true,sync:syncBefore}}));
 await page.goto(base,{waitUntil:'networkidle'});await role(page,'business');await nav(page,'审批中心');await filter(page,'甲单');return page;
};
try {
 await waitForOwnedServer({base,child:server,instanceId});workerId=(await execute('connect')).workerId;
 heartbeat=setInterval(()=>void execute('heartbeat').catch(error=>errors.push(error.message)),10000);
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),other=await browser.newContext();
 let a=await newPage(context),b=await newPage(other);
 const sync=page=>page.locator('.approval-page .lingxing-sync');
 assert.equal(await a.locator('.lingxing-latest').count(),0);assert.equal(await b.locator('.lingxing-latest').count(),0);check('审批页无最近同步记录区域，保留各自同步按钮');
 await label(sync(a),'同步领星指标',true);
 let releasePost,postStarted;const postGate=new Promise(resolve=>releasePost=resolve),started=new Promise(resolve=>postStarted=resolve);
 await a.route('**/api/lingxing/jobs',async route=>{postStarted();await postGate;await route.continue();},{times:1});
 const pending=submit(a,sync(a),'同步领星指标');await started;await label(sync(a),'正在同步…',false);releasePost();const j1=await pending;
 assert.equal(j1.state,'queued');await label(sync(a),'正在同步…',false);check('指标提交和排队期间均显示同步中且禁止重复点击');
 await label(sync(b),'同步领星指标',true);check('他人新任务不覆盖本机未发起的按钮');
 const j2=await submit(b,sync(b),'同步领星指标');assert.notEqual(j2.id,j1.id);
 
 assert.equal((await execute('claim')).job.id,j1.id);await label(sync(a),'正在同步…',false);check('真实任务进入running后仍显示同步中');
 await a.route('**/api/lingxing/jobs?**',route=>route.abort());
 await sync(a).getByRole('alert').filter({hasText:'暂时无法读取同步进度'}).waitFor();await label(sync(a),'正在同步…',false);
 
 assert.equal(posts.length,2);await a.unroute('**/api/lingxing/jobs?**');check('执行中暂时读不到状态时继续禁止重复提交，不误报结束');
 await execute('finish',{id:j1.id,error:'领星登录已过期，请在部署电脑重新登录。'});
 await label(sync(a),'同步失败',true);await label(sync(b),'正在同步…',false);assert.equal(await sync(a).getByRole('alert').innerText(),'领星登录已过期，请在部署电脑重新登录。');
 check('较早失败不覆盖另一窗口仍在排队的按钮');
 assert.equal((await execute('claim')).job.id,j2.id);await finishMetric(j2.id);
 await label(sync(b),'同步完成',true);await label(sync(a),'同步失败',true);check('同岗位、相同单据的两台客户端按各自任务显示失败和成功');
 
 const freshContext=await browser.newContext(),fresh=await newPage(freshContext);await label(sync(fresh),'同步领星指标',true);
 await fresh.reload({waitUntil:'networkidle'});await role(fresh,'business');await nav(fresh,'审批中心');await freshContext.close();check('新电脑未发起时保留初始按钮，不显示他人的任务历史');
 await b.locator('.approval-expand[aria-expanded="false"]').click();await b.locator('.approval-metric-value').filter({hasText:/^777$/}).waitFor();check('保存成功后刷新审批指标，无需全局版本轮询');
 for(const keyword of ['乙单','不存在型号','BBUTTON001']){await filter(a,keyword);}
 await a.getByRole('group',{name:'按类目筛选',exact:true}).getByRole('button',{name:'墨盒',exact:true}).click();
 await a.getByRole('group',{name:'按类目筛选',exact:true}).getByRole('button',{name:'全部类目',exact:true}).click();
 await a.getByLabel('按需求类型筛选',{exact:true}).selectOption('allocation');await a.getByLabel('按需求类型筛选',{exact:true}).selectOption('all');
 await a.getByRole('button',{name:/^我的待办/}).click();await a.getByRole('button',{name:/^我的待办/}).click();
 await a.getByLabel('筛选审批进度',{exact:true}).selectOption('active');await a.getByLabel('筛选审批进度',{exact:true}).selectOption('all');
 await filter(a,'甲单');await label(sync(a),'同步失败',true);
 await role(a,'admin');await filter(a,'甲单');await label(sync(a),'同步领星指标',true);
 await role(a,'business');await filter(a,'甲单');await label(sync(a),'同步失败',true);check('筛选与角色切换后按钮按本机请求及岗位恢复');
 await b.unroute('**/api/sync');
 const retry=await submit(a,sync(a),'同步失败');assert.notEqual(retry.id,j1.id);await label(sync(a),'正在同步…',false);
 assert.equal((await execute('claim')).job.id,retry.id);await finishMetric(retry.id,170);await label(sync(a),'同步完成',true);
 await b.locator('.approval-metric-value').filter({hasText:/^170$/}).waitFor();await b.locator('.approval-coverage-value').filter({hasText:'2.2 倍'}).waitFor();await b.locator('.approval-coverage-value').filter({hasText:'2.3 倍'}).waitFor();
 check('其他客户端保存后，现有全局刷新同时更新指标和调货前后计算结果');
 const again=await submit(a,sync(a),'同步完成');assert.notEqual(again.id,retry.id);await label(sync(a),'正在同步…',false);await execute('claim');await finishMetric(again.id,779);await label(sync(a),'同步完成',true);check('明确失败可重试，完成后保留按钮且再次点击创建新任务');
 const tab=await newPage(context);await label(sync(tab),'同步完成',true);const tabJob=await submit(tab,sync(tab),'同步完成');await label(sync(a),'同步完成',true);
 await label(sync(b),'同步完成',true);check('另一标签页发起任务不覆盖已完成按钮');
 await a.reload({waitUntil:'networkidle'});await role(a,'business');await nav(a,'审批中心');await filter(a,'甲单');await label(sync(a),'同步完成',true);
 await tab.close();await execute('claim');await finishMetric(tabJob.id,780);check('同浏览器两个标签页持有各自任务，刷新不会被另一标签页的新任务覆盖');
 await a.close();a=await newPage(context);await label(sync(a),'同步完成',true);check('关闭发起页面不影响执行，重新打开按服务端结果恢复');
 // 已保存超过30条以后仍可查自己的任务，且不能跨岗位或流程读取。
 for(let i=0;i<31;i++) db.db.prepare("INSERT INTO lingxing_sync_jobs(request_id,role,request_json,requested_from,target_json,state,message,created_at,finished_at) SELECT ?,role,request_json,requested_from,target_json,'failed','隔离历史样例',created_at,finished_at FROM lingxing_sync_jobs WHERE id=?").run(rid(),j1.id);
 const newest=db.db.prepare('SELECT MAX(id) id FROM lingxing_sync_jobs').get().id;
 
 assert.equal((await api(`/api/lingxing/jobs?action=metrics&requestId=${j1.requestId}`)).jobs[0].id,j1.id);
 assert.equal((await api(`/api/lingxing/jobs?action=metrics&requestId=${j1.requestId}`,'admin')).jobs.length,0);check('按请求查询不受最近30条限制，仍按岗位授权');
 // 同时丢失提交回执和状态读取，重试只重放原请求。
 let lost=true,blockStatus=true;
 await a.route('**/api/lingxing/jobs**',async route=>{if(route.request().method()==='GET'&&blockStatus)return route.abort();if(route.request().method()==='POST'&&lost){lost=false;await route.fetch();return route.abort();}return route.continue();});
 const postCount=posts.length;await sync(a).getByRole('button',{name:'同步完成',exact:true}).click();await label(sync(a),'重试确认',true);
 assert.ok((await sync(a).innerText()).includes('尚未取得'));const lostKey=posts.at(-1).requestId;assert.equal(posts.length,postCount+1);
 const confirmed=await submit(a,sync(a),'重试确认');assert.equal(confirmed.requestId,lostKey);await label(sync(a),'正在同步…',false);
 await execute('claim');await finishMetric(confirmed.id,781);blockStatus=false;await a.unroute('**/api/lingxing/jobs**');await label(sync(a),'同步完成',true);
 assert.equal(db.db.prepare('SELECT COUNT(*) n FROM lingxing_sync_jobs WHERE request_id=?').get(lostKey).n,1);check('网络未知结果不误报成功或失败，同一请求重试不重复执行');
 // 未送达服务器的请求也保留编号，重试才首次创建任务。
 let reject=true;await a.route('**/api/lingxing/jobs',route=>{if(reject){reject=false;return route.abort();}return route.continue();});
 await sync(a).getByRole('button',{name:'同步完成',exact:true}).click();await label(sync(a),'重试确认',true);const unsent=posts.at(-1).requestId;
 assert.equal(db.db.prepare('SELECT COUNT(*) n FROM lingxing_sync_jobs WHERE request_id=?').get(unsent).n,0);
 const delivered=await submit(a,sync(a),'重试确认');assert.equal(delivered.requestId,unsent);await a.unroute('**/api/lingxing/jobs');await execute('claim');await finishMetric(delivered.id);await label(sync(a),'同步完成',true);check('请求未送达时不自动新增任务，手动确认沿用原编号');
 await a.locator('.approval-expand[aria-expanded="false"]').click();await a.screenshot({path:path.join(output,'metrics-complete.png'),fullPage:true});
 await role(a,'operation-1');await nav(a,'升级库存');
 const row=i=>a.locator(db.getRelocationWorkItem(works[i].id).relocationId?'[data-relocation-id="'+db.getRelocationWorkItem(works[i].id).relocationId+'"]':'[data-relocation-work-id="'+works[i].id+'"]'),log=i=>row(i).locator('.lingxing-sync');
 const choose=async i=>{await a.locator('.source-select').filter({hasText:works[i].documentNo}).click();};
 const logLabel=async(i,text,enabled)=>{await choose(i);return label(log(i),text,enabled);};
 const logSubmit=async(i,text)=>{await choose(i);return submit(a,log(i),text);};
 for(const [who,syncAllowed,shipAllowed]of [['admin',true,false],['assistant-1',true,false],['assistant-2',false,false],['purchasing',true,false],['operation-1',true,true],['operation-2',false,false],['business',false,false]]) {
  await role(a,who);await nav(a,'升级库存');
  const source=a.locator('.source-select').filter({hasText:works[0].documentNo});
  if(await source.count())await source.click();
  assert.equal(await row(0).locator('.lingxing-sync button').count(),syncAllowed?1:0,who+'同步权限');
  assert.equal(await row(0).getByRole('button',{name:'登记移仓发货',exact:true}).count(),0,who+'无人工发货入口（原发货权限'+shipAllowed+'）');
  if(syncAllowed){const rect=await row(0).evaluate(e=>({card:e.getBoundingClientRect().right,button:e.querySelector('.relocation-document-head .lingxing-sync button').getBoundingClientRect().right}));assert.ok(rect.card-rect.button<30);}
 }
 check('六岗位同步与发货权限独立，同步按钮位于当前移仓单资料右上角');
 await role(a,'operation-1');await nav(a,'升级库存');
 const l1=await logSubmit(0,'同步领星物流'),l2=await logSubmit(1,'同步领星物流');await logLabel(0,'正在同步…',false);await logLabel(1,'正在同步…',false);check('两个移仓物流入口分别排队且不能重复提交');
 assert.equal((await execute('claim')).job.id,l1.id);await logLabel(0,'正在同步…',false);
 const finishLog=id=>execute('finish',{id,capture:{capturedAt:new Date().toISOString(),shipments:[{externalId:'BUTTON-PKG',storeId:'TEST',storeName:'A-US 美国',orderNo:works[0].removalOrderNo,fnsku:common.fnsku,carrier:'UPS',trackingNo:'TRACK-BUTTON',quantity:5,shipDate:'2026-09-10T00:00:00.000Z'}]}});
 await finishLog(l1.id);await logLabel(0,'同步完成',true);await row(0).getByText('TRACK-BUTTON',{exact:true}).first().waitFor();await logLabel(1,'正在同步…',false);check('物流保存成功即自动记入发货5，其他单的同步状态不变');
 await execute('claim');await execute('finish',{id:l2.id,error:'移除单 BUTTON-ORDER-1 中未找到 FNSKU XBUTTON001，请核对移除单号和升级来源。'});await logLabel(1,'同步失败',true);await logLabel(0,'同步完成',true);
 assert.equal((await api(`/api/lingxing/jobs?action=logistics&workId=${works[1].id}&requestId=${l1.requestId}`,'operation-1')).jobs.length,0);check('物流失败只影响对应流程，查询不能串用另一流程');
 const lAgain=await logSubmit(0,'同步完成');await logLabel(0,'正在同步…',false);assert.notEqual(lAgain.id,l1.id);await execute('claim');await finishLog(lAgain.id);await logLabel(0,'同步完成',true);check('物流完成可再次同步，创建独立任务');
 await a.setViewportSize({width:1280,height:1000});await choose(1);await log(1).scrollIntoViewIfNeeded();await log(1).screenshot({path:path.join(output,'logistics-button-narrow.png')});
 const layout=await log(1).evaluate(element=>{const button=element.querySelector('button'),error=element.querySelector('[role=alert]');return {button:button.scrollWidth<=button.clientWidth,error:error.scrollWidth<=error.clientWidth,height:button.getBoundingClientRect().height};});assert.ok(layout.button&&layout.error&&layout.height>20);check('1280桌面同步按钮完整显示，错误原因正常换行');
 await a.setViewportSize({width:1440,height:1000});await a.evaluate(()=>window.scrollTo(0,0));await a.screenshot({path:path.join(output,'logistics-states.png'),fullPage:true});
 for(const page of [a,b]){const body=await page.locator('body').innerText();for(const removed of ['本次范围：','由部署电脑执行。可关闭','批次调拨记录','领星：未同步','FBA 总库存 ÷'])assert.ok(!body.includes(removed),removed);assert.equal(await page.locator('.lingxing-sync details').count(),0);}
 for(const width of [1280,1366,1920]) {
  await b.setViewportSize({width,height:1000});await sync(b).screenshot({path:path.join(output,`sync-button-${width}.png`)});
  assert.equal(await b.locator('.lingxing-latest').count(),0);assert.ok(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
 await choose(1);assert.ok(await log(1).getByRole('button').evaluate(element=>parseFloat(getComputedStyle(element).fontSize)>=12),'物流共用按钮保持可读字号');
 check('三个窗口宽度无最近记录区域，审批和物流按钮仍可读');
 assert.deepEqual(db.getCatalog().models,stockBefore.models);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM upgrade_relocations').get().n,1);check('指标不改库存；物流自动记账发货，尚未升级时不回库');
 // 由当前发起岗位采纳已取得包裹，再由采购完成回库。
 await a.setViewportSize({width:1440,height:1000});
 await choose(0);assert.equal(db.getRelocationWorkItem(works[0].id).shippedQuantity,5);assert.equal(db.getRelocationWorkItem(works[0].id).fbaRemainingQuantity,15);
 const current=db.getRelocationWorkItem(works[0].id),relocation=db.getUpgradeRelocation(current.relocationId);
 assert.equal(relocation.shipped_quantity,5);assert.equal(relocation.fba_remaining_quantity,15);assert.deepEqual(db.getCatalog().models,stockBefore.models);check('包裹自动发货5后来源剩余15，本地在库不变');
 // 当前来源保留第一笔历史发货，再建立同来源第二笔待发货移仓。
 const created=a.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/upgrades/relocation-work-items');
 await a.getByRole('button',{name:'发起移仓升级',exact:true}).click();const secondResult=await(await created).json();assert.equal(secondResult.ok,true);let secondWork=secondResult.workItem;
 secondWork=db.recordRelocationProcurement({id:secondWork.id,role:"logistics",rma:'第二笔RMA',relocationAddress:relocationAddressFixture,expectedRevision:secondWork.revision,requestId:rid()}).workItem;
 secondWork=db.recordRelocationOperation({id:secondWork.id,role:'operation-1',removalOrderNo:'BUTTON-SECOND-SAME-SOURCE',expectedRevision:secondWork.revision,requestId:rid()}).workItem;
 await role(a,'admin');await nav(a,'升级库存');await choose(0);
 const historic=a.locator('[data-relocation-id="'+relocation.id+'"]'),secondCard=a.locator('[data-relocation-work-id="'+secondWork.id+'"]');
 await historic.waitFor();await secondCard.waitFor();assert.equal(await a.locator('.relocation-document').count(),2);
 assert.equal(await historic.locator('.relocation-document-head .lingxing-sync button').count(),1);
 assert.equal(await secondCard.locator('.relocation-document-head .lingxing-sync button').count(),1);
 const beforeHistorySync={stock:db.getCatalog().models,shipped:db.getUpgradeRelocation(relocation.id).shipped_quantity,completed:db.getUpgradeRelocation(relocation.id).completed_quantity};
 const historyJob=await submit(a,historic.locator('.lingxing-sync'),'同步领星物流');assert.equal(historyJob.target.workId,works[0].id);
 await execute('claim');await finishLog(historyJob.id);await label(historic.locator('.lingxing-sync'),'同步完成',true);
 await historic.locator('.package-quantities').filter({hasText:'已用 5'}).waitFor();
 assert.equal(db.relocationExternalShipments(works[0].removalOrderNo,common.fnsku)[0].usedQuantity,5);
 assert.deepEqual(db.getCatalog().models,beforeHistorySync.stock);assert.equal(db.getUpgradeRelocation(relocation.id).shipped_quantity,beforeHistorySync.shipped);assert.equal(db.getUpgradeRelocation(relocation.id).completed_quantity,beforeHistorySync.completed);
 assert.equal(await secondCard.getByText('TRACK-BUTTON',{exact:true}).count(),0);
 check('同来源两笔移仓各自展示；历史管理员同步绑定原单，已用5不清零、不发货、不入库、不串包裹');
 await a.screenshot({path:path.join(output,'same-source-two-relocations-history-sync.png'),fullPage:true});
 await role(a,'purchasing');await nav(a,'升级库存');
 await choose(0);assert.equal(await a.locator('[data-relocation-id="'+relocation.id+'"] .lingxing-sync').count(),1);const history=a.locator('[data-relocation-id="'+relocation.id+'"]');
 await history.getByLabel(relocation.relocation_no+' 升级完数量',{exact:true}).fill('5');await history.getByLabel(relocation.relocation_no+' 升级完成版本号',{exact:true}).fill('V21');await history.getByLabel(relocation.relocation_no+' 目标海外仓',{exact:true}).selectOption('SyntheticWarehouseA');
 const completion=a.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/upgrades/relocations/'+relocation.id+'/complete');await history.getByRole('button',{name:'保存升级数量',exact:true}).click();assert.equal((await completion).status(),200);await history.getByText('入库记录：V21 / SyntheticWarehouseA：5',{exact:true}).waitFor();await history.getByRole('button',{name:'完成入库',exact:true}).waitFor({state:'detached'});
 assert.equal(db.getUpgradeRelocation(relocation.id).completed_quantity,5);assert.equal(db.getCatalog().models.find(m=>m.model==='SYNTH-TONER-001').inStock,stockBefore.models.find(m=>m.model==='SYNTH-TONER-001').inStock+5);check('采购登记5件回库后在库仅增加5件，已用包裹仍为5件');
 // 存储与未知回执专项：实际React、HTTP、任务表；执行端仍是隔离协议样例。
 const recoveryStock=()=>{const catalog=db.getCatalog();return {models:catalog.models.map(({revision,updatedAt,...row})=>row),stockDetails:catalog.stockDetails,inTransitDetails:catalog.inTransitDetails};};
 const recoveryBefore={stock:recoveryStock(),ledger:db.db.prepare('SELECT * FROM inventory_ledger ORDER BY id').all()};
 const stored=page=>page.evaluate(()=>({session:Object.fromEntries(Object.keys(sessionStorage).filter(k=>k.startsWith('aster-lingxing-request:')).map(k=>[k,sessionStorage.getItem(k)])),local:Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('aster-lingxing-request:')).map(k=>[k,localStorage.getItem(k)]))}));
 for(const area of ['sessionStorage','localStorage']) {
  const faultContext=await browser.newContext(),fault=await newPage(faultContext);
  await fault.evaluate(area=>{window.asterOriginalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===window[area]&&key.startsWith('aster-lingxing-request:'))throw new DOMException('隔离存储写入拒绝','QuotaExceededError');return window.asterOriginalSet.call(this,key,value);};},area);
  const count=posts.length;await sync(fault).getByRole('button',{name:'同步领星指标',exact:true}).click();
  await label(sync(fault),'同步失败',true);assert.equal(posts.length,count);assert.match(await sync(fault).getByRole('alert').innerText(),/本次未发送/);
  const partial=await stored(fault);
  await fault.evaluate(()=>{Storage.prototype.setItem=window.asterOriginalSet;});
  let recovered;
  if(Object.values(partial.session).length) {
   await sync(fault).getByRole('button',{name:'同步失败',exact:true}).click();await label(sync(fault),'重试确认',true);assert.equal(posts.length,count);
   recovered=await submit(fault,sync(fault),'重试确认');assert.equal(recovered.requestId,Object.values(partial.session)[0]);
  } else recovered=await submit(fault,sync(fault),'同步失败');
  assert.equal(posts.length,count+1);assert.equal((await execute('claim')).job.id,recovered.id);await finishMetric(recovered.id,782);await label(sync(fault),'同步完成',true);
  recoveryEvidence.push({kind:area+' write rejection',postsWhileBlocked:0,partial,recovered,jobCount:db.db.prepare('SELECT COUNT(*) n FROM lingxing_sync_jobs WHERE request_id=?').get(recovered.requestId).n});
  check(area+'写失败明确未发送、0POST并解除busy；恢复存储后同页面只建1任务');await faultContext.close();
 }
 {
  const faultContext=await browser.newContext();
  await faultContext.addInitScript(()=>{window.asterOriginalGet=Storage.prototype.getItem;Storage.prototype.getItem=function(key){if(key.startsWith('aster-lingxing-request:'))throw new DOMException('隔离存储读取拒绝','SecurityError');return window.asterOriginalGet.call(this,key);};});
  const count=posts.length,fault=await newPage(faultContext);
  assert.equal(await fault.locator('.app').count(),1);await label(sync(fault),'同步失败',true);assert.match(await sync(fault).getByRole('alert').innerText(),/无法读取/);
  await sync(fault).getByRole('button',{name:'同步失败',exact:true}).click();await label(sync(fault),'同步失败',true);assert.equal(posts.length,count);assert.match(await sync(fault).getByRole('alert').innerText(),/本次未发送/);
  await fault.evaluate(()=>{Storage.prototype.getItem=window.asterOriginalGet;});
  const recovered=await submit(fault,sync(fault),'同步失败');assert.equal((await execute('claim')).job.id,recovered.id);await finishMetric(recovered.id,783);await label(sync(fault),'同步完成',true);
  recoveryEvidence.push({kind:'getItem rejected without saved task',appAlive:true,postsWhileBlocked:0,recovered});
  check('getItem拒绝不崩整页，提示读失败且0POST；恢复存储后同页面可继续同步');await faultContext.close();
 }
 {
  const originalId=rid(),created=(await api('/api/lingxing/jobs','business',{action:'metrics',documents:[{kind:'inquiry',id:docs[0].id}],requestId:originalId})).job;
  const key='aster-lingxing-request:business:metrics:inquiry:'+docs[0].id;
  const faultContext=await browser.newContext();
  await faultContext.addInitScript(({key,id})=>{sessionStorage.setItem(key,id);localStorage.setItem(key,id);window.asterOriginalGet=Storage.prototype.getItem;Storage.prototype.getItem=function(key){if(key.startsWith('aster-lingxing-request:'))throw new DOMException('隔离存储读取拒绝','SecurityError');return window.asterOriginalGet.call(this,key);};},{key,id:originalId});
  const count=posts.length,fault=await newPage(faultContext);await label(sync(fault),'同步失败',true);assert.equal(posts.length,count);
  await fault.evaluate(()=>{Storage.prototype.getItem=window.asterOriginalGet;});
  await sync(fault).getByRole('button',{name:'同步失败',exact:true}).click();await label(sync(fault),'正在同步…',false);
  assert.equal(posts.length,count);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM lingxing_sync_jobs WHERE request_id=?').get(originalId).n,1);
  assert.equal((await execute('claim')).job.id,created.id);await finishMetric(created.id,784);await label(sync(fault),'同步完成',true);
  recoveryEvidence.push({kind:'getItem restored existing task',originalId,created,postsDuringRecovery:0,pointer:await stored(fault)});
  check('读权限恢复先找回已保存原任务并查结果，0新POST、不覆盖原编号');await faultContext.close();
 }
 {
  const ink=db.createInquiry({...common,model:'SYNTH-INK-001',operator:'未知权限回归',asin:'BBUTTON001',requestId:rid()}).record;
  const matrix={墨盒:Object.fromEntries(['admin','assistant-1','assistant-2','operation-1','operation-2','purchasing','business'].map(role=>[role,{summary:true,detail:true,expand:true,actions:true}]))};
  const permissionFile=path.join(state,'data/permissions.json');await fs.writeFile(permissionFile,JSON.stringify(matrix));
  const faultContext=await browser.newContext(),fault=await newPage(faultContext);await filter(fault,ink.documentNo);
  let lost=true,blockStatus=true;
  await fault.route('**/api/lingxing/jobs**',async route=>{if(route.request().method()==='GET'&&blockStatus)return route.abort();if(route.request().method()==='POST'&&lost){lost=false;await route.fetch();return route.abort();}return route.continue();});
  const count=posts.length;await sync(fault).getByRole('button',{name:'同步领星指标',exact:true}).click();await label(sync(fault),'重试确认',true);
  const original=posts.at(-1),saved={...db.db.prepare('SELECT id,request_id,state FROM lingxing_sync_jobs WHERE request_id=?').get(original.requestId)};
  assert.equal(saved.state,'queued');matrix.墨盒.business.actions=false;await fs.writeFile(permissionFile,JSON.stringify(matrix));
  const deniedResponse=fault.waitForResponse(r=>new URL(r.url()).pathname==='/api/lingxing/jobs'&&r.request().method()==='POST');
  await sync(fault).getByRole('button',{name:'重试确认',exact:true}).click();const denied=await deniedResponse;assert.equal(denied.status(),403);const deniedBody=await denied.json();
  await label(sync(fault),'重试确认',true);assert.match(await sync(fault).getByRole('alert').innerText(),/原同步结果仍未核对/);
  assert.ok(Object.values((await stored(fault)).session).includes(original.requestId));assert.ok(Object.values((await stored(fault)).local).includes(original.requestId));
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM lingxing_sync_jobs WHERE request_id=?').get(original.requestId).n,1);
  await fault.reload({waitUntil:'networkidle'});assert.equal(await fault.getByLabel('切换当前操作角色',{exact:true}).inputValue(),'admin');
  await role(fault,'business');await nav(fault,'审批中心');await filter(fault,ink.documentNo);await label(sync(fault),'重试确认',true);
  assert.equal(posts.length,count+2);matrix.墨盒.business.actions=true;await fs.writeFile(permissionFile,JSON.stringify(matrix));
  const confirmed=await submit(fault,sync(fault),'重试确认');assert.equal(confirmed.requestId,original.requestId);assert.equal(confirmed.id,saved.id);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM lingxing_sync_jobs WHERE request_id=?').get(original.requestId).n,1);
  const submitted=posts.slice(count);assert.equal(submitted.length,3);assert.ok(submitted.every(post=>post.requestId===original.requestId));assert.deepEqual(submitted,[original,original,original]);
  blockStatus=false;await fault.unroute('**/api/lingxing/jobs**');assert.equal((await execute('claim')).job.id,saved.id);
  await finishMetric(saved.id,785);await label(sync(fault),'同步完成',true);
  recoveryEvidence.push({kind:'saved unknown replay forbidden then restore',original,saved,denied:deniedBody,confirmed,submitted,pointer:await stored(fault),jobCount:1});
  check('已排队丢回执→真实403保留原编号→刷新原岗位仍可确认→恢复权限3次同键只有1任务');await faultContext.close();
 }
 {
  const invalid=db.createInquiry({...common,operator:'非法ASIN回归',asin:'BAD',requestId:rid()}).record;
  const faultContext=await browser.newContext(),fault=await newPage(faultContext);await filter(fault,invalid.documentNo);
  const before=db.db.prepare('SELECT COUNT(*) n FROM lingxing_sync_jobs').get().n;
  const response=fault.waitForResponse(r=>new URL(r.url()).pathname==='/api/lingxing/jobs'&&r.request().method()==='POST');
  await sync(fault).getByRole('button',{name:'同步领星指标',exact:true}).click();const rejected=await response;assert.equal(rejected.status(),400);const body=await rejected.json();
  assert.equal(body.code,'invalid_sync_asin');await label(sync(fault),'同步失败',true);
  assert.deepEqual(await stored(fault),{session:{},local:{}});assert.equal(db.db.prepare('SELECT COUNT(*) n FROM lingxing_sync_jobs').get().n,before);
  await filter(fault,docs[0].documentNo);await label(sync(fault),'同步领星指标',true);const next=await submit(fault,sync(fault),'同步领星指标');
  assert.deepEqual(next.target.documents,[{kind:'inquiry',id:docs[0].id}]);assert.equal((await execute('claim')).job.id,next.id);await finishMetric(next.id,786);await label(sync(fault),'同步完成',true);
  recoveryEvidence.push({kind:'first definite400 clears and valid filter continues',rejected:body,next});
  check('首次明确坏ASIN400不建任务并清本机编号；过滤正确单可正常新同步');await faultContext.close();
 }
 {
  const sharedContext=await browser.newContext(),firstPage=await newPage(sharedContext),secondPage=await newPage(sharedContext);
  const count=posts.length;
  const first=await submit(firstPage,sync(firstPage),'同步领星指标');await label(sync(firstPage),'正在同步…',false);
  await label(sync(secondPage),'同步领星指标',true);
  const second=await submit(secondPage,sync(secondPage),'同步领星指标');assert.notEqual(first.requestId,second.requestId);assert.notEqual(first.id,second.id);
  await label(sync(secondPage),'正在同步…',false);assert.equal(posts.length,count+2);
  assert.ok(Object.values((await stored(firstPage)).session).includes(first.requestId));assert.ok(Object.values((await stored(secondPage)).session).includes(second.requestId));
  assert.equal((await execute('claim')).job.id,first.id);await finishMetric(first.id,787);await label(sync(firstPage),'同步完成',true);await label(sync(secondPage),'正在同步…',false);
  assert.equal((await execute('claim')).job.id,second.id);await finishMetric(second.id,788);await label(sync(secondPage),'同步完成',true);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM lingxing_sync_jobs WHERE request_id IN (?,?)').get(first.requestId,second.requestId).n,2);
  recoveryEvidence.push({kind:'two already open same browser tabs remain independent',first,second,posts:posts.slice(count)});
  check('同浏览器两个先打开页各自提交不同编号、2任务；他页local编号不接管本页按钮');await sharedContext.close();
 }

 assert.deepEqual(recoveryStock(),recoveryBefore.stock);assert.deepEqual(db.db.prepare('SELECT * FROM inventory_ledger ORDER BY id').all(),recoveryBefore.ledger);

 assert.equal(db.relocationExternalShipments(works[0].removalOrderNo,common.fnsku)[0].usedQuantity,5);assert.deepEqual(errors,[]);db.assertInventoryInvariants();
} finally {
 await fs.writeFile(path.join(output,'button-result.json'),JSON.stringify({kind:'isolated-http-worker-fixture-and-real-react',realLingxing:false,checks,errors,state,recoveryEvidence},null,2));
 clearInterval(heartbeat);await browser?.close();db.close();server.kill();
}
