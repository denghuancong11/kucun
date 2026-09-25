import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {createInventoryDatabase,InventoryDatabase} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'../..'),out=process.env.ASTER_MULTI_SYNC_OUTPUT||path.join(root,'.test-output/multi-page-sync');
await fs.mkdir(out,{recursive:true});
const results=[],errors=[];
const appRoot=root;
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-multi-page-'));
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('multi-page');
const server=spawn(process.execPath,[path.join(appRoot,'server.mjs')],{cwd:appRoot,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,PORT:String(port),HOST:'127.0.0.1',PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
let browser;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,payload) {const res=await fetch(base+url,{method:payload?'POST':'GET',headers:{'x-role':'admin','content-type':'application/json'},body:payload?JSON.stringify(payload):undefined});const data=await res.json();assert.equal(res.status,200,JSON.stringify(data));return data;}
async function seed(model) {
 const fileName='双端硒鼓.csv',body=`Brand,ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\nAster,${model},12,4,X-${model},SyntheticWarehouseB,PLAN-${model},2026-09-01,一团,V1`;
 const res=await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':'admin','x-file-name':encodeURIComponent(fileName)},body});const p=await res.json();assert.equal(res.status,200,JSON.stringify(p));
 await json('/api/transit/import',{previewToken:p.previewToken,fileName,fileHash:p.fileSha256,templateHash:p.templateSha256,rows:p.rows.map(r=>({...r,data:{...r.data,version:'V1'}})),requestId:crypto.randomUUID()});
}
async function scenario(name) {
 const model='MULTI-'+name.toUpperCase();await seed(model);
 const ca=await browser.newContext(),cb=await browser.newContext();
 const a=await ca.newPage(),b=await cb.newPage();a.on('pageerror',e=>errors.push(e.message));b.on('pageerror',e=>errors.push(e.message));
 const log=[],url=base+`/?q=${model}&model=${model}&tab=transit`,initial=db.getCatalog();
 let fail=false,releaseSync,releaseCatalog,firstSync=true,lifecycle;
 if(['initial','initial-catalog','hung'].includes(name)) await b.route('**/api/sync',async route=>{
   if(!firstSync)return route.continue();firstSync=false;
   await new Promise(r=>releaseSync=r);await route.continue().catch(()=>{});
 });
 if(name==='initial-catalog')await b.route('**/api/inventory/catalog',async route=>{const response=await route.fetch();await new Promise(r=>releaseCatalog=r);await route.fulfill({response});},{times:1});
 if(name==='read-failure')await b.route('**/api/inventory/catalog',async route=>{if(fail)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'隔离注入目录读取失败'})});return route.continue();});
 b.on('response',async res=>{const pathname=new URL(res.url()).pathname;if(!['/api/sync','/api/inventory/catalog'].includes(pathname))return;try {const p=await res.json();log.push({at:Date.now(),path:pathname,status:res.status(),sync:p.sync,model:p.models?.find(m=>m.model===model),row:p.inTransitDetails?.[model]?.[0]});}catch{}});
 await Promise.all([a.goto(url,{waitUntil:'domcontentloaded'}),b.goto(url,{waitUntil:'domcontentloaded'})]);
 const row=b.locator('.pane-transit tbody tr').first();await a.getByRole('button',{name:'确认上架',exact:true}).waitFor();if(name!=='initial-catalog')await row.getByRole('button',{name:'确认上架',exact:true}).waitFor();else while(!releaseCatalog||!releaseSync)await sleep(10);
 if(!['initial','initial-catalog','hung'].includes(name))await b.waitForResponse(r=>new URL(r.url()).pathname==='/api/sync');
 if(name==='own-write') {
  await b.route('**/api/sync',async route=>{await new Promise(r=>releaseSync=r);await route.continue().catch(()=>{});},{times:1});
  while(!releaseSync)await sleep(20);
 }
 if(name==='background'){lifecycle=await cb.newCDPSession(b);await lifecycle.send('Page.setWebLifecycleState',{state:'frozen'});}
 const navigationCount=name==='background'?1:await b.evaluate(()=>performance.getEntriesByType('navigation').length);
 const post=a.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/on-shelf'));
 fail=name==='read-failure';await a.getByRole('button',{name:'确认上架',exact:true}).click();const save=await(await post).json();const started=Date.now();
 if(name==='background'){await sleep(1000);await lifecycle.send('Page.setWebLifecycleState',{state:'active'});await b.bringToFront();}
 if(name==='initial')releaseSync();
 if(name==='initial-catalog'){const sync=b.waitForResponse(r=>new URL(r.url()).pathname==='/api/sync');releaseSync();await sync;releaseCatalog();}
 if(name==='own-write') {
  await b.getByRole('button',{name:'询库',exact:true}).click();const dialog=b.getByRole('dialog');
  for(const [label,value] of [['询库数量（必填）','3'],['询库店铺（必填）','并行店铺US'],['询库运营（必填）','乙'],['ASIN（必填）','BMULTI0001'],['FNSKU（必填）','XMULTI0001']])await dialog.getByLabel(label,{exact:true}).fill(value);
  const receipt=b.waitForResponse(r=>r.url().endsWith('/api/inquiries')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'提交询库',exact:true}).click();await receipt;releaseSync();
 }
 if(name==='read-failure'){await sleep(3500);fail=false;}
 let updated=true;try {await row.getByText('YES',{exact:true}).waitFor({timeout:name==='hung'?14000:6500});}catch{updated=false;}
 const final=db.getCatalog(),summary=final.models.find(m=>m.model===model);
 assert.equal(summary.inStock,12);assert.equal(summary.inTransit,0);assert.equal(summary.inStock+summary.inTransit,12);
 const result={name,base,databaseId:initial.sync.databaseId,saveSync:save.sync,updated,elapsedMs:Date.now()-started,log,ui:await row.innerText(),url:b.url(),summary};
 if(updated){assert.equal(await row.locator('td').first().innerText(),'0');assert.equal(await row.getByRole('button',{name:'确认上架',exact:true}).count(),0);assert.ok(b.url().includes('tab=transit'));assert.ok(b.url().includes('q='+model));assert.equal(await b.evaluate(()=>performance.getEntriesByType('navigation').length),navigationCount);assert.equal(await a.locator('.pane-stock').count(),1);
 const summaryRow=b.locator('.inventory-summary-row');assert.equal(await summaryRow.locator('.inventory-summary-in-stock').innerText(),'12');assert.equal(await summaryRow.locator('.inventory-summary-in-transit').innerText(),'0');assert.equal(await summaryRow.locator('.inventory-summary-total').innerText(),'12');
 result.batch=final.stockDetails[model][0];assert.equal(result.batch.quantity,12);
 await b.screenshot({path:path.join(out,`after-${name}.png`),fullPage:true});}
 results.push(result);console.log(JSON.stringify({name,updated,elapsedMs:result.elapsedMs}));
 releaseSync?.();await ca.close();await cb.close();
 assert.ok(updated,name+'未自动更新');
}
async function sameRow() {
 const model='MULTI-SAME';await seed(model);const contexts=await Promise.all([browser.newContext(),browser.newContext()]);const pages=await Promise.all(contexts.map(c=>c.newPage())),held=[];
 for(const p of pages){await p.route('**/api/transit/*/on-shelf',async r=>{await new Promise(resolve=>held.push(resolve));await r.continue();});await p.goto(base+`/?model=${model}&tab=transit`);await p.getByRole('button',{name:'确认上架',exact:true}).waitFor();}
 const receipts=pages.map(p=>p.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/on-shelf')));await Promise.all(pages.map(p=>p.getByRole('button',{name:'确认上架',exact:true}).click()));while(held.length<2)await sleep(10);held.forEach(f=>f());
 const values=await Promise.all(receipts.map(async r=>(await r).json()));assert.equal(values.filter(v=>v.deduped).length,1);assert.equal(db.getCatalog().models.find(m=>m.model===model).inStock,12);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM stock_receipts s JOIN transit_batches t ON s.transit_id=t.id WHERE t.model=?').get(model).n,1);
 results.push({name:'same-row-two-submits',responses:values,stock:12,receipts:1});console.log('PASS same-row-two-submits');await Promise.all(contexts.map(c=>c.close()));
}
async function retainedWorkspaces() {
 const context=await browser.newContext(),p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));const writes=[];p.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname);});
 const nav=async text=>p.locator('.sidebar .nav-item',{hasText:text}).click();
 async function failAndRecover(endpoint,name,verify) {
  const pattern='**'+endpoint+(endpoint==='/api/audit'?'?*':'');let fail=true,failed=0;await p.route(pattern,route=>{if(!fail)return route.continue();failed++;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'隔离短暂读取失败'})});});
  await seed('CHANGE-'+name);while(failed<2)await sleep(50);await sleep(100);await verify();
  fail=false;const response=await p.waitForResponse(r=>new URL(r.url()).pathname===endpoint&&r.status()===200,{timeout:6500});const payload=await response.json();assert.equal(payload.sync.dataVersion,db.syncState().dataVersion);await sleep(100);await verify();await p.unroute(pattern);
  results.push({name:name+'-read-failure-draft-retained',failed,loaded:payload.sync});console.log('PASS '+name+'-read-failure-draft-retained');
 }
 await p.goto(base+'/?q=MULTI-ORDINARY&model=MULTI-ORDINARY');await p.locator('.alloc-toggle').first().click();const alloc=p.locator('.allocation-panel');await alloc.getByLabel('调拨数量',{exact:true}).fill('4');await alloc.getByLabel('运营备注（选填）',{exact:true}).fill('调拨草稿保留');
 await p.getByRole('button',{name:'询库',exact:true}).click();const dialog=p.getByRole('dialog');await dialog.getByLabel('询库数量（必填）',{exact:true}).fill('2');await dialog.getByLabel('运营备注（选填）',{exact:true}).fill('询库草稿保留');
 await failAndRecover('/api/inventory/catalog','inventory',async()=>{assert.equal(await alloc.getByLabel('调拨数量',{exact:true}).inputValue(),'4');assert.equal(await alloc.getByLabel('运营备注（选填）',{exact:true}).inputValue(),'调拨草稿保留');assert.equal(await dialog.getByLabel('询库数量（必填）',{exact:true}).inputValue(),'2');assert.equal(await dialog.getByLabel('运营备注（选填）',{exact:true}).inputValue(),'询库草稿保留');});await dialog.getByRole('button',{name:'取消',exact:true}).click();
 await nav('在途库存');await p.locator('#transit-import-file').setInputFiles({name:'预览硒鼓.csv',mimeType:'text/csv',buffer:Buffer.from('Brand,ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\nAster,DRAFT-ONLY,5,4,XDRAFT,SyntheticWarehouseB,PLAN-DRAFT,2026-09-01,一团,V1')});await p.locator('.transit-preview-table tbody tr').waitFor();
 await seed('CHANGE-transit');await sleep(2500);assert.match(await p.locator('.transit-preview-table').innerText(),/DRAFT-ONLY/);assert.equal(await p.locator('.transit-preview-table input').count(),0);assert.equal(await p.getByRole('button',{name:'导入记录',exact:true}).count(),0);results.push({name:'transit-preview-retained-across-other-write'});
 await nav('库存流水');await p.getByLabel('选择库存操作分类',{exact:true}).selectOption('transit_import');await p.locator('.audit-table tbody tr').first().waitFor();await p.getByLabel('按型号查询库存流水',{exact:true}).fill('未提交筛选');
 await failAndRecover('/api/audit','audit',async()=>{assert.equal(await p.getByLabel('按型号查询库存流水',{exact:true}).inputValue(),'未提交筛选');assert.equal(await p.getByLabel('选择库存操作分类',{exact:true}).inputValue(),'transit_import');assert.ok(await p.locator('.audit-table tbody tr').count()>0);});
 const upgrade=db.createDirectUpgrade({role:'admin',model:'MULTI-ORDINARY',sourceVersion:'V1',requestId:crypto.randomUUID()}).upgrade;
 await p.getByLabel('切换当前操作角色',{exact:true}).selectOption('purchasing');await nav('升级库存');await p.getByRole('tab',{name:'在库升级',exact:true}).click();
 const quantity=p.getByLabel(upgrade.upgradeNo+' 升级完成数量',{exact:true}),version=p.getByLabel(upgrade.upgradeNo+' 升级完成版本号',{exact:true});await quantity.fill('3');await version.fill('V-DRAFT');
 await failAndRecover('/api/upgrades','upgrade',async()=>{assert.equal(await quantity.inputValue(),'3');assert.equal(await version.inputValue(),'V-DRAFT');assert.equal(await p.getByRole('tab',{name:'在库升级',exact:true}).getAttribute('aria-selected'),'true');});
 assert.deepEqual(writes,['/api/transit/preview']);assert.equal(db.getCatalog().models.find(m=>m.model==='DRAFT-ONLY'),undefined);results.push({name:'automatic-refresh-only-reads',observedWrites:writes});
 await context.close();
}
async function approvalFailure() {
 const draft=(await json('/api/inquiries',{model:'MULTI-ORDINARY',quantity:10,department:'一团',store:'保留草稿USUS',operator:'测试',fnsku:'XNOTE00001',asin:'BNOTE00001',requestId:crypto.randomUUID()})).record;
 const context=await browser.newContext(),p=await context.newPage();const card=p.locator('[data-document-no="'+draft.documentNo+'"]');let fail=false;
 await p.route('**/api/approvals',route=>fail?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'隔离审批读取失败'})}):route.continue());
 await p.goto(base);await p.getByLabel('切换当前操作角色',{exact:true}).selectOption('business');await p.locator('.sidebar .nav-item',{hasText:'审批中心'}).click();await p.locator('.approval-model-group[data-model="MULTI-ORDINARY"] .approval-expand').click();await card.getByLabel('审核数量',{exact:true}).waitFor();
 await card.getByLabel('审核数量',{exact:true}).fill('7');await card.getByLabel('商务备注',{exact:true}).fill('乙尚未提交的备注');fail=true;
 await seed('MULTI-NOTE-CHANGE');await sleep(4500);
 const retained=await card.getByLabel('审核数量',{exact:true}).count()===1&&(await card.getByLabel('审核数量',{exact:true}).inputValue())==='7';
 fail=false;await sleep(4500);const recovered=await card.getByLabel('商务备注',{exact:true}).count()===1&&(await card.getByLabel('商务备注',{exact:true}).inputValue())==='乙尚未提交的备注';
 results.push({name:'approval-draft-failure',retained,recovered});console.log(JSON.stringify(results.at(-1)));await context.close();assert.ok(retained&&recovered);
}
try {
 await waitForOwnedServer({base,child:server,instanceId});browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 for(const name of ['ordinary','initial','initial-catalog','read-failure','hung','own-write','background'])await scenario(name);
 await approvalFailure();
 await sameRow();
 await retainedWorkspaces();
 db.assertInventoryInvariants();assert.deepEqual(errors,[]);
}finally{await browser?.close();server.kill();db.close();await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'after.json'),JSON.stringify({kind:'isolated-two-independent-browser-contexts',results,errors,state},null,2));}
