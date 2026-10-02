// 隔离 SQLite、真实库存页面及模拟扩展协议；不访问正式库或真实领星。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright-core';
import {build} from 'esbuild';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'../..'),output=path.join(root,'.test-output');
await fs.mkdir(output,{recursive:true});
const state=await fs.mkdtemp(path.join(output,'request-sync-copy-')),accountsFile=path.join(state,'accounts.json');
const accounts={accounts:[{account:'TEST-A',stores:['AUS'],shortName:'COPY-A',room:'100'}]};
await fs.writeFile(accountsFile,JSON.stringify(accounts));
process.env.ASTER_WAREHOUSE_ACCOUNTS=accountsFile;
process.env.ASTER_OVERSEAS_WAREHOUSES='SyntheticWarehouseA;SyntheticWarehouseB';
const {createInventoryDatabase,InventoryDatabase}=await import('../../inventory-db.mjs');
const {accountForStore}=await import('../../warehouse-address.mjs');
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID();
db.db.prepare("INSERT INTO catalog_models(model,category,base_in_stock,in_transit,revision,updated_at) VALUES('COPY-SYNC','硒鼓',0,0,1,?)").run(new Date().toISOString());
let inquiry=db.createInquiry({role:'operation-1',model:'COPY-SYNC',quantity:100,department:'一团',store:'AUS',operator:'隔离文案',fnsku:'X123456789',asin:'B123456789',requestId:rid()}).record;
inquiry=db.reviewInquiry({id:inquiry.id,role:'business',decision:'approve',approvedQuantity:100,expectedRevision:inquiry.revision,requestId:rid()}).record;
inquiry=db.replyInquiry({id:inquiry.id,role:'purchasing',supplierQuantity:100,shippingWarehouse:'SC',expectedRevision:inquiry.revision,requestId:rid()}).record;
inquiry=db.archiveInquiry({id:inquiry.id,role:'purchasing',plan:'COPY-PLAN',date:'2026-09-30',version:'V1',expectedRevision:inquiry.revision,requestId:rid()}).record;
const work=db.initiateRelocationUpgrade({role:'purchasing',inquiryId:inquiry.id,requestId:rid()}).workItem;
db.updateUpgradeFlows({role:'logistics',rows:db.upgradeTemplateRows([work.id]).map(r=>({...r,rma:'COPY-RMA',rawAddress:'Test Contact\n100 Test Street, Suite 1\nTest City',packPerBox:'2'})),requestId:rid()});
db.recordRelocationOperation({id:work.id,role:'operation-1',removalOrderNo:'COPY-ORDER',expectedRevision:db.upgradeFlow(work.id).revision,requestId:rid()});

const port=await freePort(),base='http://127.0.0.1:'+port,checks=[],errors=[];
let child,browser,page,workerId;
const check=name=>{checks.push(name);console.log('PASS '+name);};
async function start(){
 const instanceId=createTestInstanceId('request-sync-copy');
 child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
 await waitForOwnedServer({base,child,instanceId});
}
async function stop(){const closed=once(child,'exit');child.kill();await closed;}
async function api(route,role='admin',body,worker=false){
 const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json',...(worker?{origin:'chrome-extension://'+'a'.repeat(32)}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();assert(response.ok,JSON.stringify(data));return data;
}
const execute=(action,body={})=>api('/api/lingxing-worker/'+action,'admin',{workerId,...body},true);
const nav=name=>page.locator('.sidebar .nav-item',{hasText:name}).click();
const role=value=>page.getByLabel('切换当前操作角色',{exact:true}).selectOption(value);
const card=()=>page.locator('.upgrade-history-card').first();
const button=()=>card().locator('.lingxing-sync button');
async function openFlows(){await page.goto(base);await role('admin');await nav('升级库存');await card().waitFor();}
async function submit(){
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/lingxing/jobs'&&r.request().method()==='POST');
 await button().click();const job=(await(await response).json()).job;
 assert.equal((await execute('claim')).job.id,job.id);return job;
}
const packageRow=(quantity,extra={})=>({externalId:'COPY-PACK',storeId:'COPY-STORE',storeName:'A-US 美国',countryCode:'US',orderNo:'COPY-ORDER',fnsku:'X123456789',quantity,carrier:'UPS',trackingNo:'COPY-TRACK',shipDate:'2026-09-30',...extra});
const finish=(job,shipments)=>execute('finish',{id:job.id,capture:{shipments,capturedAt:new Date().toISOString()}});
const latestMessage=message=>card().getByText('最近物流同步：'+message,{exact:true}).waitFor();

try{
 await start();workerId=(await execute('connect',{version:'copy-protocol-fixture'})).workerId;
 browser=await chromium.launch({headless:true,executablePath:process.env.ASTER_BROWSER_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 page=await browser.newPage({viewport:{width:1500,height:1100}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));

 const harness=await build({stdin:{contents:"import * as api from './src/api';window.copyApi=api;",resolveDir:path.join(root,'web'),loader:'ts'},bundle:true,write:false,format:'iife'});
 await page.route('**/copy-api-harness',r=>r.fulfill({contentType:'text/html',body:'<script src="/copy-api-harness.js"></script>'}));
 await page.route('**/copy-api-harness.js',r=>r.fulfill({contentType:'text/javascript',body:harness.outputFiles[0].text}));
 await page.goto(base+'/copy-api-harness');
 const apiChecks=await page.evaluate(async()=>{
  const api=window.copyApi,file=new File(['file'],'copy.csv'),original=window.fetch,results=[];
  const calls=[
   ['preview',()=>api.previewTransitImport('admin',file,{dateYear:2026})],
   ['preview',()=>api.previewTransitStatus('admin',file,{dateYear:2026})],
   ['preview',()=>api.previewUpgradeFile('logistics','update',file)],
   ['preview',()=>api.previewUpgradeFile('logistics','transfer',file)],
   ['export',()=>api.exportUpgradeRows('logistics',[1])],
   ['read',()=>api.fetchInventoryCatalog('admin')],
   ['save',()=>api.importTransit('admin',{previewToken:'test',rows:[],requestId:'copy-test'})]
  ];
  try{
   for(const mode of ['network','timeout','html','empty','invalid-json','business']){
    window.fetch=async()=>{
     if(mode==='network')throw new TypeError('Failed to fetch');
     if(mode==='timeout')throw new DOMException('test timeout','TimeoutError');
     return new Response(mode==='html'?'<html>TECHNICAL_RESPONSE</html>':mode==='empty'?'':mode==='invalid-json'?'{"ok":true,':JSON.stringify({ok:false,error:'请核对原始业务值',code:'unchanged_code',details:{quantity:7}}),{status:mode==='business'?409:200});
    };
    for(const[purpose,call]of calls)try{await call();throw new Error('Expected failure');}catch(e){results.push({purpose,mode,message:e.message,status:e.status,code:e.code,details:e.details});}
   }
  }finally{window.fetch=original;}
  return results;
 });
 for(const r of apiChecks){
  if(r.mode==='business'){assert.equal(r.message,'请核对原始业务值');assert.equal(r.status,409);assert.equal(r.code,'unchanged_code');assert.deepEqual(r.details,{quantity:7});continue;}
  if(['network','timeout'].includes(r.mode)){
   const reason=r.mode==='timeout'?'库存服务响应超时':'库存服务连接中断';
   if(r.purpose==='preview')assert.equal(r.message,reason+'，未能取得文件预览，请重新上传文件。');
   if(r.purpose==='export')assert.equal(r.message,reason+'，未能取得回填模板，请重新导出。');
   if(r.purpose==='save')assert(r.message.includes('尚未确认是否保存'));
  }else{
   assert.equal(r.status,200);
   assert.equal(r.message,{preview:'未能取得文件预览，请重新上传文件。',export:'未能取得回填模板，请重新导出。',read:'未能读取库存数据，请重新加载。',save:'尚未确认是否保存，请保留当前填写内容并核对记录。'}[r.purpose]);
  }
 }
 check('七个实际API调用在断网、超时和三类损坏响应下区分预览、导出、查询及提交');
 check('后端明确错误、状态码、业务码和详情原样保留');

 await page.goto(base);await nav('在途库存');
 for(const[selector,endpoint]of [['#transit-import-file','/api/transit/preview'],['#transit-status-file','/api/transit/status/preview']]){
  await page.route('**'+endpoint,r=>r.abort());
  await page.locator(selector).setInputFiles({name:'copy-硒鼓.csv',mimeType:'text/csv',buffer:Buffer.from('file')});
  await page.getByText('库存服务连接中断，未能取得文件预览，请重新上传文件。',{exact:true}).waitFor();
  await page.unroute('**'+endpoint);
 }
 await role('logistics');await nav('升级库存');
 await page.route('**/api/upgrades/update/preview',r=>r.abort());
 await page.locator('.upgrade-template-actions input[type=file]').setInputFiles({name:'copy.csv',mimeType:'text/csv',buffer:Buffer.from('file')});
 await page.getByRole('alert').getByText('库存服务连接中断，未能取得文件预览，请重新上传文件。',{exact:true}).waitFor();
 await page.unroute('**/api/upgrades/update/preview');
 await nav('在途库存');await page.route('**/api/upgrades/transfer/preview',r=>r.abort());
 await page.locator('.upgrade-template-actions input[type=file]').setInputFiles({name:'copy.csv',mimeType:'text/csv',buffer:Buffer.from('file')});
 await page.getByRole('alert').getByText('库存服务连接中断，未能取得文件预览，请重新上传文件。',{exact:true}).waitFor();
 await page.unroute('**/api/upgrades/transfer/preview');
 check('四种文件预览页面都显示上传重试，不提示业务数据可能已保存');
 await openFlows();await card().locator('input[type=checkbox]').check();
 await page.route('**/api/upgrades/template',r=>r.fulfill({status:200,body:'<html>TECHNICAL_RESPONSE</html>'}));
 await page.getByRole('button',{name:'导出回填模板',exact:true}).click();
 await page.getByRole('alert').getByText('未能取得回填模板，请重新导出。',{exact:true}).waitFor();
 assert.equal(await page.getByText('TECHNICAL_RESPONSE',{exact:false}).count(),0);await page.unroute('**/api/upgrades/template');
 check('回填模板导出异常不展示HTML，不误报保存失败');

 await openFlows();
 const failed=await submit();await execute('finish',{id:failed.id,error:'隔离同步失败'});
 await card().getByRole('alert').getByText('隔离同步失败',{exact:true}).waitFor();
 await openFlows();await latestMessage('隔离同步失败');
 assert.equal(await card().locator('.lingxing-sync [role=alert]').count(),0);
 assert.equal((await api('/api/upgrades/flows')).flows[0].latestTask.id,failed.id);
 check('同一失败任务已在最近物流同步显示时，按钮下不重复显示');
 const other=(await api('/api/lingxing/jobs','logistics',{action:'logistics',workId:work.id,requestId:rid()})).job;
 assert.equal((await execute('claim')).job.id,other.id);await execute('finish',{id:other.id,error:'隔离同步失败'});
 await openFlows();await latestMessage('隔离同步失败');await card().locator('.lingxing-sync [role=alert]').waitFor();
 assert.equal(await card().locator('p').filter({hasText:'隔离同步失败'}).count(),2);
 check('不同任务即使错误文字相同，也保留各自结果');
 const stale=await api('/api/upgrades/flows');stale.flows[0].latestTask={id:failed.id,state:'running',message:'部署电脑正在取数',createdAt:failed.createdAt};
 await page.route('**/api/upgrades/flows',r=>r.fulfill({json:stale}));await openFlows();
 await latestMessage('部署电脑正在取数');await card().locator('.lingxing-sync [role=alert]').getByText('隔离同步失败',{exact:true}).waitFor();
 await page.unroute('**/api/upgrades/flows');
 check('同一任务的旧进度不会遮住新失败消息');

 await openFlows();let job=await submit(),receipt=await finish(job,[packageRow(5,{trackingNo:''})]);
 assert.equal(receipt.job.state,'succeeded');assert.equal(receipt.job.result.businessApplied,false);
 const partial='已保存 1 条领星包裹商品记录；移仓已发货数量未更新。匹配包裹缺少承运商或运单号。';
 assert.equal(receipt.job.message,partial);assert.equal(db.upgradeFlow(work.id).shippedQuantity,0);
 assert.equal(db.db.prepare('SELECT quantity FROM lingxing_removal_shipments WHERE external_id=?').get('COPY-PACK').quantity,5);
 await button().getByText('数量未更新',{exact:true}).waitFor();await latestMessage(partial);
 check('包裹保存成功但业务未应用时保留真实状态，按钮显示数量未更新');
 job=await submit();receipt=await finish(job,[packageRow(5)]);
 assert.equal(receipt.job.result.businessApplied,true);assert.equal(receipt.job.result.shippedDelta,5);
 assert.equal(db.upgradeFlow(work.id).shippedQuantity,5);
 await button().getByText('同步完成',{exact:true}).waitFor();await latestMessage('物流已同步，移仓已发货增加 5 件，累计 5 件。');
 check('新增包裹数量与页面增加量、累计量一致');
 job=await submit();receipt=await finish(job,[packageRow(5)]);
 assert.equal(receipt.job.result.shippedDelta,0);assert.equal(db.upgradeFlow(work.id).shippedQuantity,5);
 await latestMessage('物流已同步，移仓已发货数量未变，累计 5 件。');await button().getByText('同步完成',{exact:true}).waitFor();
 const legacy=receipt.job;
 check('重复同步明确显示数量未变，不再次增加移仓已发货');

 job=await submit();receipt=await finish(job,[packageRow(-1,{externalId:'BAD-QUANTITY'})]);
 assert.equal(receipt.job.state,'failed');assert.equal(receipt.job.message,'领星包裹数量须为 0 或正整数，请在领星核对后重新同步。');
 assert.equal(db.db.prepare("SELECT COUNT(*) n FROM lingxing_removal_shipments WHERE external_id='BAD-QUANTITY'").get().n,0);
 await button().getByText('同步失败',{exact:true}).waitFor();check('领星无效数量指向领星核对，并且未保存包裹');
 job=await submit();receipt=await finish(job,[packageRow(101,{externalId:'OVER-SOURCE'})]);
 assert.equal(receipt.job.result.businessApplied,false);assert.equal(db.upgradeFlow(work.id).shippedQuantity,5);
 assert.equal(receipt.job.message,'已保存 1 条领星包裹商品记录；移仓已发货数量未更新。本次增加的移仓已发货数量超过来源余量，请核对来源单据和订单号。');
 await button().getByText('数量未更新',{exact:true}).waitFor();
 check('超过来源余量时缓存保留、业务数量不变，完整消息不重复说明保存');

 // 仅修改隔离夹具，触发当前流程步骤变化及初始额度不足的两个保存点回滚分支。
 const original=db.db.prepare('SELECT status,source_quantity_before,sold_quantity FROM upgrade_relocation_work_items WHERE id=?').get(work.id);
 db.db.prepare("UPDATE upgrade_relocation_work_items SET status='awaiting_operation' WHERE id=?").run(work.id);
 job=await submit();receipt=await finish(job,[packageRow(6)]);
 assert.equal(receipt.job.message,'已保存 1 条领星包裹商品记录；移仓已发货数量未更新。该记录不处于移仓和升级中，请刷新查看进度。');
 await button().getByText('数量未更新',{exact:true}).waitFor();
 db.db.prepare('UPDATE upgrade_relocation_work_items SET status=?,source_quantity_before=6,sold_quantity=2 WHERE id=?').run(original.status,work.id);
 job=await submit();receipt=await finish(job,[packageRow(6)]);
 assert.equal(receipt.job.message,'已保存 1 条领星包裹商品记录；移仓已发货数量未更新。累计移仓已发货和 FBA 其他减少超过发起时来源数量，请核对来源单据。');
 assert.equal(db.upgradeFlow(work.id).shippedQuantity,5);
 db.db.prepare('UPDATE upgrade_relocation_work_items SET source_quantity_before=?,sold_quantity=? WHERE id=?').run(original.source_quantity_before,original.sold_quantity,work.id);
 check('隔离步骤变化和初始额度不足时，原因与回滚后的数量一致');

 assert.equal(accountForStore('').issue,'请补充来源店铺。');
 assert.equal(accountForStore('UNKNOWNUS').issue,'店铺‘UNKNOWNUS’未配置公司账号，请联系管理员核对。');
 await fs.writeFile(accountsFile,JSON.stringify({accounts:[{...accounts.accounts[0],room:''}]}));
 assert.equal(accountForStore('AUS').issue,'账号 TEST-A 缺少英文简称或房间号，请联系管理员补充。');
 await fs.unlink(accountsFile);assert.equal(accountForStore('AUS').issue,'缺少海外仓账号资料，请联系管理员补充。');
 await fs.writeFile(accountsFile,JSON.stringify(accounts));
 check('缺店铺、缺账号映射、缺账号字段、缺配置文件分别提示正确操作');

 const legacyMessage='同步成功，已保存 70 条包裹商品记录';
 db.db.prepare('UPDATE lingxing_sync_jobs SET message=?,result_json=? WHERE id=?').run(legacyMessage,JSON.stringify({updated:70,capturedAt:legacy.result.capturedAt}),legacy.id);
 const historical=JSON.stringify(db.db.prepare('SELECT * FROM lingxing_sync_jobs WHERE id=?').get(legacy.id));
 await page.evaluate(({workId,requestId})=>{const key='aster-lingxing-request:admin:logistics:'+workId;sessionStorage.setItem(key,requestId);localStorage.setItem(key,requestId);},{workId:work.id,requestId:legacy.requestId});
 await openFlows();await button().getByText('同步完成',{exact:true}).waitFor();
 const restored=await api('/api/lingxing/jobs?action=logistics&workId='+work.id+'&requestId='+legacy.requestId);
 assert.equal(restored.jobs[0].message,legacyMessage);assert.equal(restored.jobs[0].result.businessApplied,undefined);
 await execute('disconnect');let disconnected=(await api('/api/lingxing/jobs','admin',{action:'logistics',workId:work.id,requestId:rid()})).job;
 assert.equal(disconnected.message,'领星扩展未连接，请在部署电脑检查 Edge 和扩展连接。');
 workerId=(await execute('connect')).workerId;
 const interrupted=(await api('/api/lingxing/jobs','admin',{action:'logistics',workId:work.id,requestId:rid()})).job;
 await stop();await start();
 const reopened=(await api('/api/lingxing/jobs?action=logistics&workId='+work.id+'&requestId='+interrupted.requestId)).jobs[0];
 assert.equal(reopened.state,'failed');assert.equal(reopened.message,'库存服务已重启，本次同步中断。扩展连接恢复后，请重新同步。');
 assert.equal(JSON.stringify(db.db.prepare('SELECT * FROM lingxing_sync_jobs WHERE id=?').get(legacy.id)),historical);
 check('缺少业务结果字段的历史任务不被推断改写，重启只更新未完成任务');
 db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.deepEqual(errors,[]);
 check('库存约束、外键和浏览器运行检查通过');
}finally{
 await browser?.close();if(child?.exitCode===null)await stop();db.close();
 console.log(JSON.stringify({state,checks:checks.length}));
}
