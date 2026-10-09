import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {createInventoryDatabase,InventoryDatabase,INVENTORY_DATABASE_NAME} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';
import {writeSyntheticTransitWorkbook} from '../../scripts/fixtures/generate-synthetic-workbook.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-team-ui-'));
const out=process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(state,'artifacts');
const workbookPath=path.join(state,'synthetic-硒鼓-page-import.xlsx');
await fs.mkdir(path.join(state,'data'));await fs.mkdir(out,{recursive:true});
await writeSyntheticTransitWorkbook(workbookPath,{sheetName:'SyntheticPageImport',rows:[
 {model:'SYNTH-XLSX-001',quantity:12,packPerBox:'4',fnsku:'TEST-FNSKU-A',shippingMethod:'SyntheticWarehouse',plan:'SYNTH-PLAN-A',date:'2026-01-01',team:'一团',version:'TEST-V1'},
 {model:'SYNTH-XLSX-001',quantity:8,packPerBox:'4',fnsku:'TEST-FNSKU-B',shippingMethod:'直发FBA',plan:'SYNTH-PLAN-B',date:'2026-01-02',team:'一团',version:'TEST-V1'},
]});
createInventoryDatabase({databasePath:path.join(state,'data',INVENTORY_DATABASE_NAME)});const db=new InventoryDatabase(state);
db.db.prepare("UPDATE stock_batches SET pack_per_box='10' WHERE model='SYNTH-TONER-001'").run();
/* 页面验收使用有明确入库来源团队的墨盒型号，避免把无来源的历史演示库存混入本次范围测试。 */
const pageInk='PAGE-INK',pageAt=new Date().toISOString();
db.db.prepare("INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at,revision,created_by_import_id) VALUES(?,?,0,0,?,1,NULL)").run(pageInk,'墨盒',pageAt);
const insertPageBatch=db.db.prepare("INSERT INTO stock_batches(batch_key,model,plan,ship_date,version,fnsku,base_quantity,updated_at,revision,created_by_import_id,created_by_transit_id,is_legacy_placeholder,warehouse,pack_per_box) VALUES(?,?,?,?,?,?,0,?,1,NULL,NULL,0,?,?)");
const insertPageTransit=db.db.prepare("INSERT INTO transit_batches(model,quantity,remaining_quantity,plan,ship_date,version,fnsku,brand,transport_method,shipping_method,team,logistics_status,on_shelf_indicator,status,source_row,revision,created_at,updated_at,pack_per_box) VALUES(?,?,?,?,?,?,?,?,?,?,?,'已签收','已上架','on_shelf',1,1,?,?,?)");
const insertPageReceipt=db.db.prepare("INSERT INTO stock_receipts(transit_id,batch_key,quantity,created_by_role,created_at,request_id,ledger_watermark) VALUES(?,?,?,?,?,?,0)");
const insertPageActiveTransit=db.db.prepare("INSERT INTO transit_batches(model,quantity,remaining_quantity,plan,ship_date,version,fnsku,brand,transport_method,shipping_method,team,logistics_status,on_shelf_indicator,status,source_row,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
const pageBatches={};
for(const [team,warehouse] of [['一团','PAGE-ONE'],['二团','PAGE-TWO']]){
 const plan='PAGE-INK-PLAN',date='2026-09-01',version='V1',fnsku='XPAGEINK',batchKey=[pageInk,plan,date,version,warehouse].join('#');
 insertPageBatch.run(batchKey,pageInk,plan,date,version,fnsku,pageAt,warehouse,5);
 const transit=insertPageTransit.run(pageInk,500,0,plan,date,version,fnsku,'','','整柜',team,pageAt,pageAt,5);
 insertPageReceipt.run(Number(transit.lastInsertRowid),batchKey,500,'assistant',pageAt,`page-ink-${team}`);
 pageBatches[team]={batchKey,plan,date,version,fnsku};
}
insertPageActiveTransit.run(pageInk,40,40,'PAGE-INK-TRANSIT-ONE','2026-09-02','V2','XPAGE-TRANSIT-ONE','','','整柜','一团','运输中','尚未确认','in_transit',2,1,pageAt,pageAt);
insertPageActiveTransit.run(pageInk,60,60,'PAGE-INK-TRANSIT-TWO','2026-09-02','V2','XPAGE-TRANSIT-TWO','','','整柜','二团','运输中','尚未确认','in_transit',3,1,pageAt,pageAt);
db.db.prepare("UPDATE catalog_models SET in_transit=100 WHERE model=?").run(pageInk);
const pageToner='PAGE-TONER';db.db.prepare("INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at,revision,created_by_import_id) VALUES(?,?,0,0,?,1,NULL)").run(pageToner,'硒鼓',pageAt);const tonerBatches={};
for(const [team,warehouse] of [['一团','PAGE-TONER-ONE'],['二团','PAGE-TONER-TWO']]){
 const plan='PAGE-TONER-PLAN',date='2026-09-01',version='V1',fnsku='XPAGETONER',batchKey=[pageToner,plan,date,version,warehouse].join('#');
 insertPageBatch.run(batchKey,pageToner,plan,date,version,fnsku,pageAt,warehouse,5);
 const transit=insertPageTransit.run(pageToner,50,0,plan,date,version,fnsku,'','','整柜',team,pageAt,pageAt,5);
 insertPageReceipt.run(Number(transit.lastInsertRowid),batchKey,50,'assistant',pageAt,`page-toner-${team}`);
 tonerBatches[team]={batchKey,plan,date,version,fnsku};
}
const tonerTransitIds={};
for(const [team,suffix,quantity] of [['一团','ONE',7],['二团','TWO',9]]){
 tonerTransitIds[team]=Number(insertPageActiveTransit.run(pageToner,quantity,quantity,`PAGE-TONER-TRANSIT-${suffix}`,'2026-09-02','V2',`XPAGE-TONER-${suffix}`,'','','整柜',team,'运输中','尚未确认','in_transit',10+(team==='二团'?1:0),1,pageAt,pageAt).lastInsertRowid);
}
db.db.prepare("UPDATE catalog_models SET in_transit=16 WHERE model=?").run(pageToner);
const hiddenInk='PAGE-HIDDEN-INK',hiddenPlan='PAGE-HIDDEN-PLAN',hiddenDate='2026-09-01',hiddenVersion='V1',hiddenFnsku='XHIDDENINK',hiddenBatch=[hiddenInk,hiddenPlan,hiddenDate,hiddenVersion,'PAGE-HIDDEN'].join('#');
db.db.prepare("INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at,revision,created_by_import_id) VALUES(?,?,0,0,?,1,NULL)").run(hiddenInk,'墨盒',pageAt);
insertPageBatch.run(hiddenBatch,hiddenInk,hiddenPlan,hiddenDate,hiddenVersion,hiddenFnsku,pageAt,'PAGE-HIDDEN',4);
const hiddenTransit=insertPageTransit.run(hiddenInk,80,0,hiddenPlan,hiddenDate,hiddenVersion,hiddenFnsku,'','','整柜','一团',pageAt,pageAt,4);
insertPageReceipt.run(Number(hiddenTransit.lastInsertRowid),hiddenBatch,80,'assistant',pageAt,'page-hidden-ink');
db.createAllocation({role:'operation-2',model:'SYNTH-TONER-001',plan:'TEST-PLAN-TONER',date:'2026-02-10',version:'V11',quantity:100,department:'二团',store:'BUS',operator:'二团专属运营',fnsku:'XSECOND',asin:'BTEAM00002',requestId:crypto.randomUUID()});
const pageFirstAllocation=db.createAllocation({role:'operation-1',model:pageInk,...pageBatches['一团'],sourceBatchKey:pageBatches['一团'].batchKey,quantity:10,department:'一团',store:'AUS',operator:'一团页面测试',asin:'BPAGE00001',requestId:crypto.randomUUID()}).record;
db.createAllocation({role:'operation-2',model:pageInk,...pageBatches['二团'],sourceBatchKey:pageBatches['二团'].batchKey,quantity:20,department:'二团',store:'BUS',operator:'二团页面测试',asin:'BPAGE00002',requestId:crypto.randomUUID()});
for(const [team,role,store,quantity,asin] of [['一团','operation-1','AUS',10,'BPAGETONER01'],['二团','operation-2','BUS',20,'BPAGETONER02']]) db.createAllocation({role,model:pageToner,...tonerBatches[team],sourceBatchKey:tonerBatches[team].batchKey,quantity,department:team,store,operator:`${team}硒鼓页面测试`,asin,requestId:crypto.randomUUID()});
const upgradedBatch=[pageInk,'PAGE-INK-PLAN','2026-09-01','V2','XPAGEINK','PAGE-ONE-UPGRADE'].join('#');
 insertPageBatch.run(upgradedBatch,pageInk,'PAGE-INK-PLAN','2026-09-01','V2','XPAGEINK',pageAt,'PAGE-ONE-UPGRADE',4);
const upgrade= db.db.prepare("INSERT INTO upgrade_jobs(upgrade_no,kind,allocation_document_id,model,source_version,new_version,status,initiated_by_role,initiated_at,revision,updated_at) VALUES(?,'relocation',?,?,?,?,?,'purchasing',?,1,?)").run('UPG-PAGE-INK',pageFirstAllocation.id,pageInk,'V1','V2','active',pageAt,pageAt);
db.db.prepare("INSERT INTO upgrade_inventory_ledger(upgrade_id,operation_id,source_type,source_id,batch_key,entry_type,on_hand_delta,locked_delta,created_by_role,created_at,request_id,metadata_json) VALUES(?,NULL,'relocation',1,?,'relocation_receipt',5,0,'purchasing',?,?,?)").run(Number(upgrade.lastInsertRowid),upgradedBatch,pageAt,'page-upgrade-ink','{}');
const port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('team-ui');
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
const checks=[],errors=[],check=name=>{checks.push(name);console.log('PASS '+name);};let browser;
const nav=async(page,name)=>{await page.locator('.sidebar .nav-item',{hasText:name}).click();await page.waitForLoadState('networkidle');};
const role=async(page,value)=>{await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(value);await page.waitForLoadState('networkidle');};
const rows=(model,team)=>Buffer.from(['Brand,ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号',`Aster,${model},15,4,XUI,整柜,PAGE-${model},2026-09-01,${team},V1`].join('\n'));
try {
 await waitForOwnedServer({base,child,instanceId});
 const roles=['admin','assistant-1','assistant-2','operation-1','operation-2','purchasing','business'];
 const readCatalog=async currentRole=>{const response=await fetch(base+'/api/inventory/catalog',{headers:{'x-role':currentRole}});assert.equal(response.status,200);return response.json();};
 const readAllocations=async(currentRole,model)=>{const response=await fetch(base+'/api/allocations?model='+encodeURIComponent(model),{headers:{'x-role':currentRole}});assert.equal(response.status,200);return response.json();};
 const catalogs=Object.fromEntries(await Promise.all(roles.map(async currentRole=>[currentRole,await readCatalog(currentRole)])));
 const tonerSignatures=roles.map(currentRole=>{const catalog=catalogs[currentRole],model=catalog.models.find(row=>row.model==='SYNTH-TONER-001');return {summary:[model.inStock,model.locked,model.available,model.inTransit],stock:(catalog.stockDetails['SYNTH-TONER-001']??[]).map(row=>row.batchKey).sort(),transit:(catalog.inTransitDetails['SYNTH-TONER-001']??[]).map(row=>row.team).sort()};});
 for(const signature of tonerSignatures.slice(1)) assert.deepEqual(signature,tonerSignatures[0]);
 const fullInkRoles=['admin','purchasing','business'];
 for(const currentRole of fullInkRoles){const catalog=catalogs[currentRole],model=catalog.models.find(row=>row.model===pageInk),stock=catalog.stockDetails[pageInk]??[],transit=catalog.inTransitDetails[pageInk]??[];assert.deepEqual([model.inStock,model.locked,model.available,model.inTransit],[1005,30,975,100]);assert.equal(stock.reduce((sum,row)=>sum+row.quantity,0),model.inStock);assert.equal(stock.reduce((sum,row)=>sum+row.locked,0),model.locked);assert.equal(transit.reduce((sum,row)=>sum+row.quantity,0),model.inTransit);assert.equal(catalog.stockDetails[pageInk].length,3);assert.deepEqual(transit.map(row=>row.team).sort(),['一团','一团','二团','二团'].sort());assert.ok(catalog.models.some(row=>row.model===hiddenInk));}
 const opOne=catalogs['operation-1'],opTwo=catalogs['operation-2'],opOneModel=opOne.models.find(row=>row.model===pageInk),opTwoModel=opTwo.models.find(row=>row.model===pageInk);
 assert.deepEqual([opOneModel.inStock,opOneModel.locked,opOneModel.available,opOneModel.inTransit],[505,10,495,40]);assert.equal((opOne.stockDetails[pageInk]??[]).reduce((sum,row)=>sum+row.quantity,0),opOneModel.inStock);assert.equal((opOne.stockDetails[pageInk]??[]).reduce((sum,row)=>sum+row.locked,0),opOneModel.locked);assert.equal((opOne.inTransitDetails[pageInk]??[]).reduce((sum,row)=>sum+row.quantity,0),opOneModel.inTransit);assert.ok(opOneModel.plan.includes('PAGE-INK-TRANSIT-ONE'));assert.ok(!opOneModel.plan.includes('PAGE-INK-TRANSIT-TWO'));assert.deepEqual([opTwoModel.inStock,opTwoModel.locked,opTwoModel.available,opTwoModel.inTransit],[500,20,480,60]);assert.equal((opTwo.stockDetails[pageInk]??[]).reduce((sum,row)=>sum+row.quantity,0),opTwoModel.inStock);assert.equal((opTwo.stockDetails[pageInk]??[]).reduce((sum,row)=>sum+row.locked,0),opTwoModel.locked);assert.equal((opTwo.inTransitDetails[pageInk]??[]).reduce((sum,row)=>sum+row.quantity,0),opTwoModel.inTransit);assert.ok(opTwoModel.plan.includes('PAGE-INK-TRANSIT-TWO'));assert.ok(!opTwoModel.plan.includes('PAGE-INK-TRANSIT-ONE'));
 assert.equal(opOne.stockDetails[pageInk].length,2);assert.equal(opTwo.stockDetails[pageInk].length,1);assert.ok(opOne.models.some(row=>row.model===hiddenInk));assert.equal(opTwo.models.some(row=>row.model===hiddenInk),false);
 for(const [currentRole,team,expected] of [['assistant-1','一团',[505,10,495,40]],['assistant-2','二团',[500,20,480,60]]]){
  const catalog=catalogs[currentRole],ink=catalog.models.find(row=>row.model===pageInk),toner=catalog.models.find(row=>row.model===pageToner);
  assert.deepEqual([ink.inStock,ink.locked,ink.available,ink.inTransit],expected);
  assert.equal(ink.stockDetails,undefined);
  assert.equal((catalog.stockDetails[pageInk]??[]).reduce((sum,row)=>sum+row.quantity,0),expected[0]);
  assert.equal((catalog.inTransitDetails[pageInk]??[]).reduce((sum,row)=>sum+row.quantity,0),expected[3]);
  const batchTeams=db.stockBatchSourceTeams();assert.ok((catalog.stockDetails[pageInk]??[]).every(row=>batchTeams.get(row.batchKey)?.size===1&&batchTeams.get(row.batchKey)?.has(team)));
  assert.ok((catalog.inTransitDetails[pageInk]??[]).every(row=>row.team===team));
  assert.deepEqual([toner.inStock,toner.locked,toner.available,toner.inTransit],[100,30,70,16]);
  assert.equal(catalog.stockDetails[pageToner].length,2);assert.deepEqual([...new Set(catalog.stockDetails[pageToner].flatMap(row=>[...(batchTeams.get(row.batchKey)??[])]))].sort(),['一团','二团']);
  assert.deepEqual([...new Set(catalog.inTransitDetails[pageToner].map(row=>row.team))].sort(),['一团','二团']);
  assert.equal(catalog.models.some(row=>row.model===hiddenInk),team==='一团');
  const allocation=await readAllocations(currentRole,pageInk);assert.equal(Object.values(allocation.records).flat().length,1);assert.equal(Object.values(allocation.publicRecords).flat().length,1);
 }
 for(const currentRole of roles){
  const catalog=catalogs[currentRole],summary=catalog.models.find(row=>row.model===pageToner),stock=catalog.stockDetails[pageToner]??[],transit=catalog.inTransitDetails[pageToner]??[],teams=db.stockBatchSourceTeams();
  assert.deepEqual([summary.inStock,summary.locked,summary.available,summary.inTransit],[100,30,70,16]);
  assert.equal(stock.length,2);assert.equal(stock.reduce((sum,row)=>sum+row.quantity,0),summary.inStock);assert.equal(stock.reduce((sum,row)=>sum+row.locked,0),summary.locked);assert.equal(stock.reduce((sum,row)=>sum+row.available,0),summary.available);
  assert.deepEqual([...new Set(stock.flatMap(row=>[...(teams.get(row.batchKey)??[])]))].sort(),['一团','二团']);
  assert.deepEqual([...new Set(transit.map(row=>row.team))].sort(),['一团','二团']);assert.equal(transit.reduce((sum,row)=>sum+row.quantity,0),summary.inTransit);
  const allocations=await readAllocations(currentRole,pageToner),publicRows=Object.values(allocations.publicRecords).flat(),privateRows=Object.values(allocations.records).flat();assert.equal(publicRows.length,2);assert.deepEqual(publicRows.map(row=>row.department).sort(),['一团','二团']);
  assert.equal(privateRows.length,currentRole.includes('-')?1:2);if(currentRole.includes('-'))assert.ok(privateRows.every(row=>row.department===(currentRole.endsWith('-1')?'一团':'二团')));
 }
 for(const currentRole of fullInkRoles){const allocation=await readAllocations(currentRole,pageInk);assert.equal(Object.values(allocation.records).flat().length,2);assert.equal(Object.values(allocation.publicRecords).flat().length,2);assert.equal(Object.keys(allocation.totals).length,3);}
 const opOneAlloc=await readAllocations('operation-1',pageInk),opTwoAlloc=await readAllocations('operation-2',pageInk);assert.equal(Object.values(opOneAlloc.records).flat().length,1);assert.equal(Object.values(opOneAlloc.publicRecords).flat().length,1);assert.equal(Object.values(opTwoAlloc.records).flat().length,1);assert.equal(Object.values(opTwoAlloc.publicRecords).flat().length,1);assert.equal(Object.values(opOneAlloc.totals).length,2);assert.equal(Object.values(opTwoAlloc.totals).length,1);
 check('七种角色接口：硒鼓汇总、在库/在途明细及调拨摘要均全量一致；墨盒按来源批次、团队和部门隔离，批次锁定余额同步');
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.goto(base,{waitUntil:'networkidle'});
 const transitAllowed=['admin','assistant-1','assistant-2','purchasing'];
 for(const currentRole of transitAllowed){
  await role(page,currentRole);assert.equal(await page.locator('.sidebar .nav-item').filter({hasText:/^在途库存$/}).count(),1);
  await nav(page,'在途库存');assert.equal(await page.locator('.transit-page').count(),1);
  assert.equal(await page.locator('#transit-import-file').isDisabled(),false);assert.equal(await page.locator('#transit-status-file').isDisabled(),false);
 }
 await role(page,'operation-1');assert.equal(await page.locator('.transit-page').count(),0);assert.equal(await page.locator('.sidebar .nav-item').filter({hasText:/^在途库存$/}).count(),0);
 assert.equal(await page.locator('.tab-strip .top-tab').filter({hasText:'在途库存'}).count(),0);assert.ok((await page.locator('.breadcrumb').innerText()).includes('库存汇总'));
 for(const currentRole of ['operation-2','business']){await role(page,currentRole);assert.equal(await page.locator('.sidebar .nav-item').filter({hasText:/^在途库存$/}).count(),0);assert.equal(await page.locator('.transit-page').count(),0);}
 check('七种角色页面访问：管理员、两类助理和采购可见并启用两项导入；运营/商务不可见，切权关闭在途页签并返回库存汇总');

 await role(page,'admin');await nav(page,'在途库存');
 await page.locator('#transit-status-file').setInputFiles({name:'切换清理物流.csv',mimeType:'text/csv',buffer:Buffer.from('计划号,物流状态\nPAGE-INK-TRANSIT-ONE,已到港')});
 await page.locator('.transit-status-preview').waitFor();assert.equal(await page.locator('.transit-status-preview').count(),1);assert.equal(await page.locator('#transit-status-file').evaluate(el=>el.files.length),0);
 await role(page,'business');assert.equal(await page.locator('.transit-status-preview').count(),0);assert.equal(await page.locator('.transit-page').count(),0);assert.equal(await page.locator('.tab-strip .top-tab').filter({hasText:'在途库存'}).count(),0);
 check('切换无权角色时清除现有物流预览和已选文件，并关闭页面标签');

 await role(page,'assistant-1');await nav(page,'在途库存');
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 await page.route('**/api/transit/preview',async route=>{const response=await route.fetch();started();await gate;await route.fulfill({response});},{times:1});
 await page.locator('#transit-import-file').setInputFiles({name:'延迟硒鼓.csv',mimeType:'text/csv',buffer:rows('DELAYED','一团')});await ready;
 assert.equal(await page.locator('#transit-import-file').evaluate(el=>el.files.length),1);
 await page.getByLabel('切换当前操作角色',{exact:true}).selectOption('operation-2');release();await page.waitForLoadState('networkidle');
 assert.equal(await page.locator('.transit-page').count(),0);assert.equal(await page.locator('.tab-strip .top-tab').filter({hasText:'在途库存'}).count(),0);assert.equal(await page.locator('.transit-preview-table').count(),0);
 assert.equal(await page.locator('.sidebar .nav-item').filter({hasText:/^在途库存$/}).count(),0);assert.equal(db.db.prepare("SELECT COUNT(*) n FROM transit_batches WHERE model='DELAYED'").get().n,0);
 check('在途导入请求返回较晚且期间切换角色，文件/预览不恢复且没有提交库存');
 for(const [teamRole,team] of [['operation-1','一团'],['operation-2','二团']]) for(const [category,model] of [['硒鼓','SYNTH-TONER-001'],['墨盒',pageInk]]) {
  await role(page,teamRole);await nav(page,'库存汇总');await page.locator('.inventory-summary-row').filter({has:page.getByText(model,{exact:true})}).click();
  if(category==='墨盒'){
   const detail=page.getByRole('region',{name:model+' 库存明细',exact:true});await detail.waitFor();const expected=team==='一团'?['505','10','495']:['500','20','480'];const stockText=await detail.locator('.pane-stock').innerText();for(const value of expected)assert.ok(stockText.includes(value));
   await detail.getByRole('tab',{name:/在途明细/}).click();const transitText=await detail.locator('.pane-transit').innerText();assert.ok(transitText.includes(team==='一团'?'PAGE-INK-TRANSIT-ONE':'PAGE-INK-TRANSIT-TWO'));assert.ok(!transitText.includes(team==='一团'?'PAGE-INK-TRANSIT-TWO':'PAGE-INK-TRANSIT-ONE'));
   const transitTable=detail.locator('.pane-transit table'),packColumn=(await transitTable.locator('thead th').allTextContents()).indexOf('套/箱'),nullPackRow=transitTable.locator('tbody tr').filter({hasText:team==='一团'?'XPAGE-TRANSIT-ONE':'XPAGE-TRANSIT-TWO'});
   assert.ok(packColumn>=0);assert.equal(await nullPackRow.locator('td').nth(packColumn).innerText(),'—');await detail.getByRole('tab',{name:/在库明细/}).click();
  }
  if(teamRole==='operation-1'&&category==='硒鼓') await page.locator('.alloc-toggle[title*="400 件"]').first().click();else await page.locator('.alloc-toggle:not([disabled])').first().click();
  const panel=page.locator('.allocation-panel'),dept=panel.locator('label').filter({hasText:'调拨部门'}).locator('select');
  await dept.waitFor();
  assert.deepEqual(await dept.locator('option').allTextContents(),[team]);assert.equal(await dept.inputValue(),team);
  if(teamRole==='operation-1'&&category==='硒鼓') {assert.equal((await panel.locator('.approval-quantities').innerText()).replace(/\s/g,''),'在库500预锁定100可用400');await panel.screenshot({path:path.join(out,'shared-500-100-400.png')});}
  await panel.getByLabel('调拨数量',{exact:true}).fill('10');await panel.getByLabel('调拨店铺',{exact:true}).fill(team==='一团'?'AUS':'BUS');await panel.getByLabel('调拨运营',{exact:true}).fill(team+'运营');await panel.getByLabel('已贴 FNSKU',{exact:true}).fill('XUI');await panel.getByLabel('ASIN（必填）',{exact:true}).fill('BTEAM00001');
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/allocations'&&r.request().method()==='POST');await panel.getByRole('button',{name:'录入并预锁定',exact:true}).click();assert.equal((await(await response).json()).record.department,team);
  await page.getByRole('region',{name:model+' 库存明细',exact:true}).getByRole('button',{name:'询库',exact:true}).click();const dialog=page.getByRole('dialog');assert.deepEqual(await dialog.locator('label').filter({hasText:'询库部门'}).locator('select option').allTextContents(),[team]);
  for(const [label,value] of [['询库数量（必填）','10'],['询库店铺（必填）',team==='一团'?'AUS':'BUS'],['询库运营（必填）',team+'运营'],['ASIN（必填）','BTEAM00001'],['FNSKU（必填）','XUI']])await dialog.getByLabel(label,{exact:true}).fill(value);
  const inquiry=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/inquiries'&&r.request().method()==='POST');await dialog.getByRole('button',{name:'提交询库',exact:true}).click();assert.equal((await(await inquiry).json()).record.department,team);
  await nav(page,'审批中心');while(await page.locator('.approval-expand[aria-expanded="false"]').count())await page.locator('.approval-expand[aria-expanded="false"]').first().click();assert.ok(!(await page.locator('.approval-page').innerText()).includes(team==='一团'?'二团专属':'一团运营'));
  check(category+' '+team+'：调拨和询库只有本团选项、提交本团数据，审批只显示本团');
   assert.equal(await page.locator('.sidebar .nav-item').filter({hasText:/^在途库存$/}).count(),0);
   check(category+' '+team+'：库存汇总按原团队范围显示，运营侧栏不提供在途导入入口');
  }
 await nav(page,'库存汇总');await page.locator('.inventory-summary-row').filter({has:page.getByText('SYNTH-TONER-001',{exact:true})}).click();await page.getByRole('region',{name:'SYNTH-TONER-001 库存明细',exact:true}).getByRole('button',{name:'询库',exact:true}).click();await page.getByLabel('询库店铺（必填）',{exact:true}).fill('旧二团草稿');await role(page,'operation-1');assert.equal(await page.getByRole('dialog').count(),0);check('切换岗位后旧询库弹窗和草稿不继续显示');
 for(const [assistantRole,team] of [['assistant-1','一团'],['assistant-2','二团']]){
  await role(page,assistantRole);await nav(page,'库存汇总');
  const tonerRow=page.locator('.inventory-summary-row').filter({has:page.getByText(pageToner,{exact:true})});await tonerRow.waitFor();
  assert.deepEqual(await Promise.all(['in-stock','locked','available','in-transit','total'].map(name=>tonerRow.locator(`.inventory-summary-${name}`).innerText())),['100','30','70','16','116']);await tonerRow.click();
  const tonerDetail=page.getByRole('region',{name:pageToner+' 库存明细',exact:true});await tonerDetail.waitFor();
  const stockRows=tonerDetail.locator('.pane-stock .detail-stock-table > tbody > tr:not(.allocation-history-row):not(.alloc-row)');assert.equal(await stockRows.count(),2);assert.deepEqual((await stockRows.allInnerTexts()).map(text=>text.trim().split(/\s+/).slice(0,3)),[['50','10','40'],['50','20','30']]);
  for(const summary of await tonerDetail.locator('details.allocation-history > summary').all()) await summary.click();
  const publicAllocationRows=tonerDetail.locator('.allocation-history-table tbody tr[data-allocation-summary-id]');assert.equal(await publicAllocationRows.count(),2);assert.deepEqual((await publicAllocationRows.locator('td:nth-child(3)').allTextContents()).sort(),['一团','二团']);
  await tonerDetail.getByRole('tab',{name:/在途明细/}).click();const tonerTransit=tonerDetail.locator('.pane-transit tbody tr').filter({hasText:/PAGE-TONER-TRANSIT-/});assert.equal(await tonerTransit.count(),2);
  const ownTransit=tonerTransit.filter({hasText:team==='一团'?'PAGE-TONER-TRANSIT-ONE':'PAGE-TONER-TRANSIT-TWO'}),foreignTransit=tonerTransit.filter({hasText:team==='一团'?'PAGE-TONER-TRANSIT-TWO':'PAGE-TONER-TRANSIT-ONE'});assert.equal(await ownTransit.getByRole('button',{name:'确认上架',exact:true}).count(),1);assert.equal(await foreignTransit.getByRole('button',{name:'确认上架',exact:true}).count(),0);
  await role(page,assistantRole==='assistant-1'?'assistant-2':'assistant-1');
  assert.equal(await page.locator('.inventory-summary-row').filter({has:page.getByText(hiddenInk,{exact:true})}).count(),assistantRole==='assistant-1'?0:1);
 }
 check('两类助理硒鼓主行、批次余额、在途明细和调拨摘要跨团一致；仅显示本团单据详情与上架按钮，切换角色后墨盒范围更新');
  await role(page,'purchasing');await nav(page,'在途库存');
 await page.locator('#transit-import-file').setInputFiles(workbookPath);
 await page.locator('.transit-preview-table tbody tr').last().waitFor();
 assert.equal(await page.locator('.transit-preview-table tbody tr').count(),2);

 const xlsxImport=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/transit/import'&&r.request().method()==='POST');
 await page.getByRole('button',{name:'确认导入',exact:true}).click();const xlsxResult=await(await xlsxImport).json();assert.equal(xlsxResult.rows.length,2);
 const transit=db.db.prepare("SELECT * FROM transit_batches WHERE model='SYNTH-XLSX-001' ORDER BY plan").all();
 assert.deepEqual(transit.map(r=>[r.quantity,r.fnsku,r.shipping_method,r.plan,r.ship_date,r.team,r.version,r.pack_per_box]),[[12,'TEST-FNSKU-A','SyntheticWarehouse','SYNTH-PLAN-A','2026-01-01','一团','TEST-V1','4'],[8,'TEST-FNSKU-B','直发FBA','SYNTH-PLAN-B','2026-01-02','一团','TEST-V1','4']]);
 check('XLSX原图列结构两行是/否均导入，八字段含文件版本逐值一致，在途20');
 await page.locator('#transit-status-file').setInputFiles({name:'物流状态.csv',mimeType:'text/csv',buffer:Buffer.from('计划号,物流状态\nSYNTH-PLAN-A,已签收\nSYNTH-PLAN-B,清关中')});
 await page.getByRole('button',{name:'确认更新物流',exact:true}).click();
 await page.getByRole('status').filter({hasText:'更新 2 条在途记录'}).waitFor();
 await nav(page,'库存汇总');await page.locator('.inventory-summary-row').filter({has:page.getByText('SYNTH-XLSX-001',{exact:true})}).click();
 await page.getByRole('tab',{name:/在途明细/}).click();
 const detail=page.getByRole('region',{name:'SYNTH-XLSX-001 库存明细'});
 assert.ok((await detail.innerText()).includes('已签收'));assert.ok((await detail.innerText()).includes('清关中'));
 await detail.screenshot({path:path.join(out,'xlsx-transit-fields.png')});
 assert.equal(await detail.getByRole('button',{name:'确认上架',exact:true}).count(),0);
 await role(page,'assistant-1');
 await page.locator('.inventory-summary-row').filter({has:page.getByText('SYNTH-XLSX-001',{exact:true})}).click();
 await page.getByRole('tab',{name:/在途明细/}).click();
 await page.getByRole('region',{name:'SYNTH-XLSX-001 库存明细'}).waitFor();
 const assistantDetail=page.getByRole('region',{name:'SYNTH-XLSX-001 库存明细'});
 assert.equal(await assistantDetail.getByRole('button',{name:'确认上架',exact:true}).count(),1);
 await assistantDetail.getByRole('button',{name:'确认上架',exact:true}).first().click();
 await page.getByRole('tab',{name:/在库明细/}).waitFor();
 await page.waitForFunction(()=>document.querySelector('.pane-stock')?.textContent.includes('TEST-FNSKU-A'));
 assert.ok((await page.locator('.pane-stock').innerText()).includes('套/箱'));
 assert.equal(db.getCatalog().models.find(r=>r.model==='SYNTH-XLSX-001').inStock,12);assert.equal(db.getCatalog().models.find(r=>r.model==='SYNTH-XLSX-001').inTransit,8);
 check('在途专页更新物流后汇总明细显示套/箱并可查询，助理一次上架12：在途20→8、在库0→12');
 db.addEvent(null,'business_correction','admin',new Date().toISOString(),'历史凭证测试',{model:'SYNTH-XLSX-001',category:'硒鼓',actionLabel:'历史资料更正',kind:'transit',targetId:transit[0].id,onHandDelta:0,lockedDelta:0,inTransitDelta:0});
 await role(page,'admin');
 for(const name of ['库存汇总','在途库存','审批中心','升级库存','库存流水']) {
   await nav(page,name);
   assert.equal(await page.getByRole('button',{name:/更正|回退|退货|取消本次移仓|切换主题/}).count(),0);
 }
 assert.equal(await page.getByLabel('选择库存操作分类',{exact:true}).locator('option[value=business_correction]').count(),0);const history=await(await fetch(base+'/api/audit?action=business_correction&limit=200',{headers:{'x-role':'admin'}})).json();assert.equal(history.records.filter(r=>r.action==='business_correction'||r.eventType==='business_correction').length,1);await page.getByLabel('选择库存操作分类',{exact:true}).selectOption('transit_import');
 await page.setViewportSize({width:1280,height:1000});await page.screenshot({path:path.join(out,'historical-audit-readonly.png'),fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 check('五个一级入口均可用且无纠错/退货按钮，历史更正保留于原接口且没有筛选入口，1280桌面分类不溢出');
 assert.deepEqual(errors,[]);db.assertInventoryInvariants();
}finally{await browser?.close();child.kill();db.close();await fs.writeFile(path.join(out,'team-page-result.json'),JSON.stringify({checks,errors,state},null,2));}
