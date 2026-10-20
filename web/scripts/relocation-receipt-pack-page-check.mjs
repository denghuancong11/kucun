// Real Edge + owned synthetic HTTP/SQLite instance. No formal data, ERP or installed extension.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {chromium} from '../node_modules/playwright-core/index.mjs';

const root=path.resolve(import.meta.dirname,'../..');
const outputRoot=path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/relocation-receipt-pack'));
await fs.mkdir(outputRoot,{recursive:true});
const out=await fs.mkdtemp(path.join(outputRoot,'run-'));
process.env.ASTER_RUNTIME_CONFIG=path.join(out,'runtime.json');
process.env.ASTER_WAREHOUSE_ACCOUNTS=path.join(out,'accounts.json');
process.env.ASTER_OVERSEAS_WAREHOUSES='SyntheticWarehouseA;SyntheticWarehouseB';
await fs.writeFile(process.env.ASTER_RUNTIME_CONFIG,JSON.stringify({schemaVersion:1,overseasWarehouses:['SyntheticWarehouseA','SyntheticWarehouseB']}));
await fs.writeFile(process.env.ASTER_WAREHOUSE_ACCOUNTS,JSON.stringify({accounts:[{account:'A号',shortName:'SYNTH',room:'TEST-101'}]}));
const {createInventoryDatabase,InventoryDatabase}=await import(pathToFileURL(path.join(root,'inventory-db.mjs')));
const {freePort,createTestInstanceId,waitForOwnedServer}=await import(pathToFileURL(path.join(root,'scripts/test-server-ownership.mjs')));
const state=path.join(out,'state');
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID(),common=r=>({expectedRevision:r.revision,requestId:rid()});
const checks=[],requests=[],screenshots=[],errors=[],trace=[];
let browser,page,child,failure,serverLog='';
const base='http://127.0.0.1:'+await freePort(),instanceId=createTestInstanceId('relocation-pack-page');
const check=(name,evidence={})=>{checks.push({name,...evidence});console.log('PASS '+name);};
async function api(url,body,role='logistics',status=200){const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),j=await r.json();trace.push({url,body,role,status:r.status,result:j});assert.equal(r.status,status,JSON.stringify(j));return j;}
async function nav(role='logistics'){await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(role);await page.locator('.sidebar .nav-item',{hasText:'升级库存'}).click();await page.getByRole('tab',{name:'移仓升级',exact:true}).click();await page.waitForLoadState('networkidle');}
const dialog=()=>page.getByRole('dialog'),save=()=>dialog().getByRole('button',{name:'保存升级数量',exact:true});
const close=()=>page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
async function shot(name){const file=path.join(out,name+'.png');await page.screenshot({path:file,fullPage:!await dialog().count(),animations:'disabled'});screenshots.push(file);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
async function eventually(fn){let last;for(let n=0;n<120;n++){try{return await fn();}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}throw last;}

try{
 child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ASTER_STATE_ROOT:state,ASTER_TEST_INSTANCE_ID:instanceId,HOST:'127.0.0.1',PORT:base.split(':').at(-1),PROD:'1'}});
 child.stdout.on('data',d=>serverLog+=d);child.stderr.on('data',d=>serverLog+=d);
 await fs.writeFile(path.join(out,'owned.json'),JSON.stringify({runnerPid:process.pid,serverPid:child.pid,base,instanceId,state},null,2));
 await waitForOwnedServer({base,child,instanceId});
 const stockSnapshot=()=>db.db.prepare('SELECT batch_key,on_hand,locked,on_hand-locked AS available FROM stock_balances ORDER BY batch_key').all();
 const inquiryStockBefore=stockSnapshot();
 // Establish the actual inquiry -> purchasing -> archive -> relocation -> accepted shipment chain over HTTP.
 let q=(await api('/api/inquiries',{model:'SYNTH-TONER-001',quantity:100,department:'一团',store:'AUS',operator:'PACK-UI',fnsku:'000PACK',asin:'BPACKUI001',requestId:rid()},'operation-1')).record;
 q=(await api('/api/inquiries/'+q.id+'/review',{decision:'approve',approvedQuantity:80,...common(q)},'business')).record;
 q=(await api('/api/inquiries/'+q.id+'/reply',{supplierQuantity:100,shippingWarehouse:'CA',...common(q)},'purchasing')).record;
 q=(await api('/api/inquiries/'+q.id+'/archive',{plan:'PACK-UI-PLAN',date:'2026-10-19',version:'V0',...common(q)},'purchasing')).record;
 let w=(await api('/api/upgrades/relocation-work-items',{inquiryId:q.id,sourceRevision:q.revision,requestId:rid()},'operation-1')).workItem;
 w=(await api('/api/upgrades/relocation-work-items/'+w.id+'/procurement',{rma:'PACK-UI',relocationAddress:'Supplier (RMA#: PACK-UI)\n12000 Magnolia Ave, Suite#101\nTEL:555000000',...common(w)})).workItem;
 w=(await api('/api/upgrades/relocation-work-items/'+w.id+'/operation',{removalOrderNo:'PACK-UI-ORDER',...common(w)},'operation-1')).workItem;
 // Explicit synthetic protocol input, not real ERP. No stock or receipt columns are patched.
 db.syncRelocationLogistics({id:w.id,role:'logistics',requestId:rid(),capturedAt:new Date().toISOString(),shipments:[20,30].map((quantity,n)=>({externalId:'PACK-UI-PKG-'+n,storeId:'lingxing-remove-inbound',storeName:'A-US 美国',countryCode:'US',orderNo:w.removalOrderNo,fnsku:w.fnsku,carrier:'UPS',trackingNo:'000PACK-'+n,quantity,shipDate:'2026-10-19'}))});
 const inquiryStockAfter=stockSnapshot();assert.deepEqual(inquiryStockAfter,inquiryStockBefore);
 await fs.writeFile(path.join(out,'inquiry-stock-before-after.json'),JSON.stringify({before:inquiryStockBefore,afterArchiveAndShipment:inquiryStockAfter},null,2));
 const relocation=()=>db.getUpgrade(db.getRelocationWorkItem(w.id).upgradeId).relocations[0];
 const url='/api/upgrades/relocations/'+relocation().id+'/complete';
 check('真实询库归档→移仓资料/订单→两包裹50，无在库锁扣或自动入库',{inquiryId:q.id,workId:w.id,shipped:relocation().shippedQuantity,completed:relocation().completedQuantity});
 assert.equal(relocation().shippedQuantity,50);assert.equal(relocation().completedQuantity,0);
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await nav();
 const task=()=>page.locator('[data-relocation-work-id="'+w.id+'"]');
 const open=async()=>{await task().getByRole('button',{name:'更新升级数量',exact:true}).click();await dialog().waitFor();};
 await open();assert.equal(await page.getByLabel('本次入库套/箱',{exact:true}).count(),0);
 await page.getByLabel('累计升级完成数量',{exact:true}).fill('20');
 await page.getByLabel('升级完成版本号',{exact:true}).fill('PACK-V2');await page.getByLabel('目标海外仓',{exact:true}).selectOption('SyntheticWarehouseA');
 const pack=()=>page.getByLabel('本次入库套/箱',{exact:true});assert.equal(await pack().inputValue(),'');assert(await save().isDisabled());
 for(const value of ['0','-1','1.5','   ']){await pack().fill(value);assert(await save().isDisabled(),value);}
 check('仅询库正新增出现套/箱，空白/0/负数/小数不可提交，无默认1');
 await pack().fill('4');assert(await save().isEnabled());await shot('01-real-pack-required');
 await close();await page.locator('.sidebar .nav-item',{hasText:'库存汇总'}).click();await nav();await open();assert.equal(await pack().inputValue(),'4');await close();
 await page.reload();await nav();await open();assert.equal(await pack().inputValue(),'4');
 check('真实套/箱草稿关闭/切页/刷新仍为用户填写4');
 let drop=true;await page.route('**'+url,async route=>{requests.push({role:route.request().headers()['x-role'],body:route.request().postDataJSON()});const receipt=await route.fetch();assert.equal(receipt.status(),200);if(drop){drop=false;return route.abort('failed');}return route.fulfill({response:receipt});});
 await save().click();await dialog().getByRole('button',{name:'重试确认',exact:true}).waitFor();assert.equal(relocation().completedQuantity,20);assert(await pack().isDisabled());assert.equal(await pack().inputValue(),'4');await shot('02-unknown-keeps-pack');
 await dialog().getByRole('button',{name:'重试确认',exact:true}).click();await dialog().waitFor({state:'detached'});assert.deepEqual(requests[0],requests[1]);assert.equal(relocation().receiptBatches.length,1);assert.equal(relocation().receiptBatches[0].packPerBox,'4');
 check('保存成功丢回执→原角色/原pack/原键重试，仅一次20入库',{requests:requests.slice()});await page.unroute('**'+url);
 await open();await page.getByLabel('累计升级完成数量',{exact:true}).fill('35');assert.equal(await pack().inputValue(),'');assert(await save().isDisabled());await page.getByLabel('目标海外仓',{exact:true}).selectOption('SyntheticWarehouseB');await pack().fill('5');await save().click();await dialog().waitFor({state:'detached'});
 assert.deepEqual(relocation().receiptBatches.map(r=>({quantity:r.quantity,pack:r.packPerBox,warehouse:r.warehouse})),[{quantity:20,pack:'4',warehouse:'SyntheticWarehouseA'},{quantity:15,pack:'5',warehouse:'SyntheticWarehouseB'}]);
 await task().click();await page.getByRole('table',{name:'移仓入库批次',exact:true}).waitFor();
 const table=page.getByRole('table',{name:'移仓入库批次',exact:true});assert.deepEqual(await table.locator('tbody tr').evaluateAll(rows=>rows.map(row=>[...row.cells].slice(2,6).map(c=>c.textContent))),[['SyntheticWarehouseA','4','20','20'],['SyntheticWarehouseB','5','15','15']]);
 const history=page.getByRole('table',{name:'移仓办理历史',exact:true});assert.deepEqual(await history.locator('tbody tr').evaluateAll(rows=>rows.filter(r=>r.cells[2].textContent==='保存升级数量').map(r=>r.cells[10].textContent)),['4','5']);await shot('03-batches-and-history');
 check('第二次不沿用旧套/箱；20/4与15/5分别绑批次、页面及办理历史可追溯');
 await open();assert.equal(await pack().count(),0);await page.getByLabel('升级中数量',{exact:true}).fill('');assert(await save().isDisabled());await page.getByLabel('升级中数量',{exact:true}).fill('0');assert(await save().isEnabled());await save().click();await dialog().waitFor({state:'detached'});
 check('只改升级中数量无需套/箱，空不等于0，明确0可保存');
 const second=relocation().receiptBatches[1],b=db.db.prepare('SELECT * FROM stock_batches WHERE batch_key=?').get(second.batchKey);
 let a=(await api('/api/allocations',{model:b.model,plan:b.plan,date:b.ship_date,version:b.version,sourceBatchKey:b.batch_key,quantity:5,department:'一团',store:'AUS',operator:'PACK-DOWNSTREAM',fnsku:b.fnsku,asin:'BPACKUI001',requestId:rid()},'operation-1')).record;
 assert.equal(db.db.prepare('SELECT locked FROM stock_balances WHERE batch_key=?').get(b.batch_key).locked,5);
 await page.reload();await nav();await open();await page.getByLabel('累计升级完成数量',{exact:true}).fill('30');assert.equal(await pack().count(),0);
 const rev=()=>page.locator('input[data-receipt-id="'+second.ledgerId+'"]');assert(await rev().isDisabled());assert(await save().isDisabled());await shot('04-locked-receipt-refuses-reversal');await close();
 check('新回库15按真实套/箱5正常调拨，预锁5使指定批次扣回禁用');
 a=(await api('/api/allocations/'+a.id+'/review',{decision:'reject',reason:'isolated release',...common(a)},'business')).record;
 await page.reload();await nav();await open();await page.getByLabel('累计升级完成数量',{exact:true}).fill('30');assert.equal(await pack().count(),0);await rev().fill('5');await page.getByLabel('升级中数量',{exact:true}).fill('0');assert(await save().isEnabled());await save().click();await dialog().waitFor({state:'detached'});
 assert.deepEqual(relocation().receiptBatches.map(r=>[r.originalQuantity,r.quantity,r.packPerBox]),[[20,20,'4'],[15,10,'5']]);assert.equal(db.db.prepare('SELECT on_hand,locked FROM stock_balances WHERE batch_key=?').get(b.batch_key).on_hand,10);
 check('拒绝释放锁后，从选定第二批扣5；原入库15/有效10/套箱5，首批20不变');
 // Cross-refresh unknown recovery retains the new field in persisted request, and does not auto-replay it.
 await open();await page.getByLabel('累计升级完成数量',{exact:true}).fill('35');await page.getByLabel('目标海外仓',{exact:true}).selectOption('SyntheticWarehouseA');assert.equal(await pack().inputValue(),'');await pack().fill('2');
 const replay=[];let corrupt=true;await page.route('**'+url,async route=>{replay.push(route.request().postDataJSON());const r=await route.fetch();assert.equal(r.status(),200);if(corrupt){corrupt=false;return route.fulfill({status:200,contentType:'application/json',body:'{invalid'});}return route.fulfill({response:r});});
 await save().click();await dialog().getByRole('button',{name:'重试确认',exact:true}).waitFor();assert.equal(relocation().completedQuantity,35);await page.reload();await nav('purchasing');assert.equal(replay.length,1);assert.equal(await page.getByRole('button',{name:'确认本次提交',exact:true}).count(),0);
 await nav('logistics');const confirm=page.getByRole('button',{name:'确认本次提交',exact:true});await confirm.waitFor();await eventually(async()=>assert(await confirm.isEnabled()));await confirm.click();await page.getByRole('status').filter({hasText:'原提交结果已确认'}).waitFor();assert.deepEqual(replay[0],replay[1]);assert.equal(replay[0].packPerBox,2);assert.equal(relocation().receiptBatches.length,3);
 check('坏JSON后刷新/换岗不自动重放；恢复原物流含pack2的同键请求，仅新增5一次',{replay});await page.unroute('**'+url);
 for(const role of ['admin','assistant-1','assistant-2','operation-1','operation-2','business','alan']){await nav(role);assert.equal(await task().getByRole('button',{name:'更新升级数量',exact:true}).count(),0);}
 await nav('purchasing');assert.equal(await task().getByRole('button',{name:'更新升级数量',exact:true}).count(),1);
 check('更新数量入口仍限采购/物流，另外7岗位无按钮');
 db.assertInventoryInvariants();assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'final-receipts.json'),JSON.stringify(relocation(),null,2));
 check('最终schema38库存约束成立，浏览器无pageerror');
}catch(error){failure=error.stack;process.exitCode=1;console.error(error);if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await browser?.close();if(child?.exitCode===null&&child?.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}db.close();await fs.writeFile(path.join(out,'server.log'),serverLog);await fs.writeFile(path.join(out,'trace.json'),JSON.stringify(trace,null,2));await fs.writeFile(path.join(out,'requests.json'),JSON.stringify(requests,null,2));await fs.writeFile(path.join(out,'result.json'),JSON.stringify({at:new Date().toISOString(),out,state,base,checks,screenshots,errors,failure:failure??null,productionWrites:0,realERP:false,processExit:{code:child?.exitCode,signal:child?.signalCode},serverStopped:!!child&&(child.exitCode!==null||child.signalCode!==null)},null,2));console.log('Evidence: '+out);}
