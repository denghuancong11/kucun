// 文案依赖真实数量、岗位和操作结果的隔离回归；不访问正式数据或领星。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright-core';
import {build} from 'esbuild';
import {createInventoryDatabase,InventoryDatabase} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'../..'),output=path.join(root,'.test-output');
await fs.mkdir(output,{recursive:true});
const state=await fs.mkdtemp(path.join(output,'inventory-copy-'));
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),port=await freePort(),base='http://127.0.0.1:'+port,instanceId=createTestInstanceId('inventory-copy');
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
const checks=[],errors=[];let browser,page,failure;
const check=name=>{checks.push(name);console.log('PASS '+name);};
const csvHeader='ITEM,数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n';
const csvRow=(model,quantity,method,plan)=>[model,quantity,1,'XCOPY001',method,plan,'2026-09-30','一团','V1'].join(',');
const upload=async(selector,body,name='copy-硒鼓.csv')=>page.locator(selector).setInputFiles({name,mimeType:'text/csv',buffer:Buffer.from(body)});
const nav=name=>page.locator('.sidebar .nav-item',{hasText:name}).click();
const exact=text=>page.getByText(text,{exact:true});
const saved=async(text)=>page.getByRole('status').getByText(text,{exact:true}).waitFor();
const api=async(route)=>{const r=await fetch(base+route,{headers:{'x-role':'admin'}});assert.equal(r.status,200);return r.json();};
const modelPage=async()=>{await page.goto(base+'/?q=COPY-TONER&model=COPY-TONER&tab=transit');await page.getByRole('tab',{name:/在途明细/}).waitFor();await page.getByRole('tab',{name:/在途明细/}).click();};
try{
 await waitForOwnedServer({base,child,instanceId});
 browser=await chromium.launch({headless:true,executablePath:process.env.ASTER_BROWSER_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 page=await browser.newPage({viewport:{width:1500,height:1000}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await exact('暂无库存记录').waitFor();
 await page.route('**/api/inventory/catalog',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'隔离库存查询失败'})}));
 await page.reload();await exact('库存数据加载失败').waitFor();assert.equal(await exact('暂无库存记录').count(),0);assert.equal(await exact('未找到匹配型号').count(),0);
 await page.unroute('**/api/inventory/catalog');await page.reload();
 check('成功空库与查询失败分别显示，不把读取失败写成暂无库存');

 await nav('在途库存');
 await upload('#transit-import-file',csvHeader+csvRow('COPY-TONER',1,'SyntheticWarehouseA','COPY-W'),'copy.csv');
 await saved('请在文件名中注明‘硒鼓’或‘墨盒’，只保留其中一种。');
 for(const header of ['数量','订单数量']){
  await upload('#transit-import-file',csvHeader.replace('数量',header)+csvRow('COPY-TONER','bad','SyntheticWarehouseA','COPY-W'));
  const message='第 2 行‘'+header+'’须为正整数。';await exact(message).waitFor();assert.equal(await exact(message).count(),1);
  assert.equal(await page.getByRole('button',{name:'确认导入',exact:true}).isDisabled(),true);
 }
 check('导入错误只显示一次，数量错误指向文件实际列名');
 for(const [body,column]of [['计划号\nCOPY-W','物流状态'],['物流状态\n已到港','计划编号']]){
  await upload('#transit-status-file',body,'物流.csv');await saved('物流表缺少必需列：'+column+'。请补全后重新上传。');
 }
 check('物流缺列逐项指出缺失列，既有计划号与状态别名仍被识别');

 const inbound=csvHeader+[csvRow('COPY-TONER',5,'SyntheticWarehouseA','COPY-W'),csvRow('COPY-TONER',7,'SyntheticWarehouseA','COPY-W'),csvRow('COPY-TONER',3,'直发FBA','COPY-F')].join('\n');
 await upload('#transit-import-file',inbound);await page.locator('.transit-preview-table tbody tr').last().waitFor();
 assert.equal(await page.locator('.transit-preview-table tbody tr').count(),3);
 assert.deepEqual(await page.locator('.transit-preview-table th').allTextContents(),['型号','数量','套/箱','FNSKU','发货方式','发货计划号','发货日期','团队','店铺','版本号']);
 await page.getByRole('button',{name:'确认导入',exact:true}).click();await saved('导入完成，涉及 2 条在途记录。');
 assert.equal(db.db.prepare('SELECT COUNT(*) n FROM transit_batches').get().n,2);
 assert.equal(db.getCatalog().models.find(m=>m.model==='COPY-TONER').inTransit,15);
 check('原始模板列名可导入，三行合并为两条记录，提示使用实际记录数');

 await upload('#transit-status-file','发货计划号,状态\nCOPY-W,运输中\nCOPY-W,已到港\nUNKNOWN,运输中','物流.csv');
 await exact('文件数据 3 行').waitFor();await exact('已匹配 1 个计划').waitFor();await exact('未匹配 1 个计划').waitFor();
 await exact('计划号 COPY-W：第 2、3 行重复，采用第 3 行。').waitFor();
 await page.getByRole('button',{name:'确认更新物流',exact:true}).click();
 await saved('物流状态已保存，涉及 1 条在途记录。 1 个计划未匹配，未更新。');
 assert.equal(db.db.prepare("SELECT logistics_status FROM transit_batches WHERE plan='COPY-W'").get().logistics_status,'已到港');
 check('物流预览区分行数和计划数，重复计划取最后状态，未匹配计划未写入');
 const beforeRevision=db.db.prepare("SELECT revision FROM transit_batches WHERE plan='COPY-W'").get().revision;
 await upload('#transit-status-file','计划编号,物流状态\nCOPY-W,已到港','物流.csv');
 await page.getByRole('button',{name:'确认更新物流',exact:true}).click();await saved('物流状态已保存，涉及 1 条在途记录。');
 assert.equal(db.db.prepare("SELECT revision FROM transit_batches WHERE plan='COPY-W'").get().revision,beforeRevision+1);
 check('重复保存相同物流状态仍准确报告涉及记录，省略零个未匹配');
 await upload('#transit-status-file','计划号,物流状态\nUNKNOWN,运输中','物流.csv');
 await exact('没有可更新的在途明细').waitFor();assert.equal(await page.getByRole('button',{name:'确认更新物流',exact:true}).isDisabled(),true);
 await upload('#transit-status-file','计划号,物流状态\nEMPTY,\nEMPTY,','物流.csv');
 await exact('计划号 EMPTY：第 2、3 行均未填写物流状态。').waitFor();
 assert.equal(await exact('第 2 行物流状态不能为空').count(),1);assert.equal(await page.getByRole('button',{name:'确认更新物流',exact:true}).isDisabled(),true);
 check('无匹配及重复空状态都不能提交，不显示虚假的最终行号或成功零条');

 for(const [plan,button,message]of [['COPY-W','确认上架','已上架，页面刷新失败，请刷新页面。'],['COPY-F','确认 FBA 上架','直发 FBA 已归档，页面刷新失败，请刷新页面。']]){
  await modelPage();const record=db.db.prepare('SELECT * FROM transit_batches WHERE plan=?').get(plan);
  let failRead=false;
  await page.route('**/api/inventory/catalog',route=>failRead?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'隔离刷新失败'})}):route.continue());
  const writePath='**/api/transit/'+record.id+'/on-shelf';
  await page.route(writePath,async route=>{const response=await route.fetch();assert.equal(response.status(),200);failRead=true;await route.fulfill({response});});
  await page.locator('.pane-transit tbody tr').filter({hasText:plan}).getByRole('button',{name:button,exact:true}).click();
  await exact(message).waitFor();assert.equal(db.getTransit(record.id).status,'on_shelf');
  failRead=false;await page.unroute('**/api/inventory/catalog');await page.unroute(writePath);
 }
 await modelPage();
 await page.locator('.pane-transit tbody tr').filter({hasText:'COPY-W'}).getByText('已上架',{exact:true}).waitFor();
 await page.locator('.pane-transit tbody tr').filter({hasText:'COPY-F'}).getByText('已归档',{exact:true}).waitFor();
 const quantities=db.getCatalog().models.find(m=>m.model==='COPY-TONER');assert.equal(quantities.inStock,12);assert.equal(quantities.inTransit,0);
 check('上架已保存但刷新失败保留真实结果，FBA归档不增加普通在库');

 await page.getByLabel('切换当前操作角色',{exact:true}).selectOption('business');await page.locator('.inventory-summary-row').click();
 const toggle=page.getByRole('button',{name:'查看批次库存',exact:true});await toggle.waitFor();assert.equal(await toggle.getAttribute('title'),'查看批次库存（可用 12 件）');
 await toggle.click();assert.equal(await page.locator('.allocation-panel form').count(),0);assert.equal(await toggle.getAttribute('title'),'收起批次库存');
 check('无调拨表单的岗位只显示查看批次库存，不改变操作权限');

 await nav('库存流水');await page.getByLabel('选择库存操作类型',{exact:true}).selectOption('transit_on_shelf');
 await page.locator('.audit-table tbody tr').first().waitFor();
 const audit=await api('/api/audit?action=transit_on_shelf&limit=200');assert.equal(audit.records.length,2);assert.equal(audit.records[0].result,'直发 FBA 已归档');assert.equal(audit.records[0].onHandDelta,0);assert.equal(audit.records[0].inTransitDelta,-3);
 await page.getByRole('button',{name:'查看',exact:true}).first().click();await page.getByRole('dialog').getByText('直发 FBA 已归档',{exact:true}).waitFor();
 await page.getByRole('button',{name:'关闭',exact:true}).click();await exact('已显示 2 条。').waitFor();
 const limitRows=Array.from({length:200},(_,i)=>({...audit.records[0],eventId:10000+i}));
 await page.route('**/api/audit?*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...audit,records:limitRows})}));
 await page.getByLabel('按型号查询库存流水',{exact:true}).fill('COPY');await page.getByRole('button',{name:'查询',exact:true}).click();
 await exact('已显示最近 200 条，可缩小日期或型号范围查询。').waitFor();
 await page.getByRole('button',{name:'清除筛选',exact:true}).click();assert.equal(await page.getByLabel('按型号查询库存流水',{exact:true}).inputValue(),'');
 await page.unroute('**/api/audit?*');
 check('流水FBA结果与库存影响一致，显示上限和清除筛选不改流水数据');

 // 在途页面正常只使缓存过期；用隔离的活动查询验证已保存后的刷新失败分支，
 // 不给正式应用新增查询，也不把模拟查询当成正式运行路径。
 const harness=await build({stdin:{contents:[
  "import React from 'react';import{createRoot}from'react-dom/client';",
  "import{QueryClient,QueryClientProvider,QueryObserver}from'@tanstack/react-query';",
  "import{Requirement3View}from'./src/views/Requirement3';",
  "const client=new QueryClient({defaultOptions:{queries:{retry:false}}});",
  "const observer=new QueryObserver(client,{queryKey:['inventory','catalog','admin'],queryFn:async()=>{const r=await fetch('/api/inventory/catalog',{headers:{'x-role':'admin'}});const j=await r.json();if(!r.ok)throw new Error(j.error);return j;}});",
  "const unsubscribe=observer.subscribe(()=>{});window.addEventListener('pagehide',unsubscribe);",
  "createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(Requirement3View,{role:'admin'})));"
 ].join('\n'),resolveDir:path.join(root,'web'),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
 await page.route('**/copy-harness',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div><script src="/copy-harness.js"></script>'}));
 await page.route('**/copy-harness.js',route=>route.fulfill({contentType:'application/javascript',body:harness.outputFiles[0].text}));
 for(const kind of ['import','status']){
  await page.goto(base+'/copy-harness');
  let failRead=false;
  await page.route('**/api/inventory/catalog',route=>failRead?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'隔离活动查询失败'})}):route.continue());
  if(kind==='import')await upload('#transit-import-file',csvHeader+csvRow('COPY-REFRESH',2,'SyntheticWarehouseA','COPY-REFRESH'),'refresh-硒鼓.csv');
  else await upload('#transit-status-file','计划号,物流状态\nCOPY-REFRESH,已到港','刷新物流.csv');
  const writePath=kind==='import'?'**/api/transit/import':'**/api/transit/status/apply';
  await page.route(writePath,async route=>{const response=await route.fetch();assert.equal(response.status(),200);failRead=true;await route.fulfill({response});});
  await page.getByRole('button',{name:kind==='import'?'确认导入':'确认更新物流',exact:true}).click();
  await saved((kind==='import'?'导入完成，涉及 1 条在途记录。':'物流状态已保存，涉及 1 条在途记录。')+' 页面刷新失败，请刷新页面。');
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM transit_batches WHERE plan='COPY-REFRESH'").get().n,1);
  failRead=false;await page.unroute('**/api/inventory/catalog');await page.unroute(writePath);
 }
 assert.equal(db.db.prepare("SELECT logistics_status FROM transit_batches WHERE plan='COPY-REFRESH'").get().logistics_status,'已到港');
 check('隔离组件活动查询失败时，导入和物流更新都保留已保存结果');
 assert.deepEqual(errors,[]);db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);
 check('页面无运行错误，库存数量和外键约束一致');
}catch(error){failure=error.stack;throw error;}
finally{await browser?.close();if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}db.close();await fs.writeFile(path.join(state,'result.json'),JSON.stringify({state,checks,errors,failure},null,2));console.log(JSON.stringify({state,checks:checks.length,failure}));}
