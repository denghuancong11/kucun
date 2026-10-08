import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {createInventoryDatabase,InventoryDatabase} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'../..'),state=fs.mkdtempSync(path.join(os.tmpdir(),'aster-flow-page-')),out=process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/flow-recovery-page');
fs.mkdirSync(out,{recursive:true});createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID();
function archive(n){let r=db.createInquiry({role:'operation-1',model:'SYNTH-TONER-001',quantity:20,department:'一团',store:'恢复页面US',operator:n,fnsku:'XPAGEFLOW1',asin:'BPAGEFLOW1',requestId:rid()}).record;r=db.reviewInquiry({id:r.id,role:'business',decision:'approve',approvedQuantity:20,expectedRevision:r.revision,requestId:rid()}).record;r=db.replyInquiry({id:r.id,role:'purchasing',supplierQuantity:20,shippingWarehouse:'仓',expectedRevision:r.revision,requestId:rid()}).record;return db.archiveInquiry({id:r.id,role:'assistant-1',plan:'PAGE-'+n,date:'2026-09-11',version:'V1',expectedRevision:r.revision,requestId:rid()}).record;}
function work(n,order){let w=db.initiateRelocationUpgrade({inquiryId:archive(n).id,role:'admin',requestId:rid()}).workItem;w=db.recordRelocationProcurement({id:w.id,role:'purchasing',rma:n,relocationAddress:'仓',expectedRevision:w.revision,requestId:rid()}).workItem;return db.recordRelocationOperation({id:w.id,role:'operation-1',removalOrderNo:order,expectedRevision:w.revision,requestId:rid()}).workItem;}
function sync(w){db.syncRelocationLogistics({id:w.id,role:'admin',shipments:['A','B'].map(n=>({externalId:w.removalOrderNo+n,storeId:'TEST',orderNo:w.removalOrderNo,fnsku:'XPAGEFLOW1',carrier:'UPS',trackingNo:n,quantity:10,shipDate:'2026-09-10'})),capturedAt:new Date().toISOString(),requestId:rid()});return db.getRelocationWorkItem(w.id);}
function ship(w,tracking){w=db.getRelocationWorkItem(w.id);db.shipRelocationUpgrade({id:w.id,role:'admin',fbaRemainingQuantity:10,externalItems:[{lineId:w.externalShipments.find(p=>p.trackingNo===tracking).lineId,quantity:10}],expectedRevision:w.revision,requestId:rid()});return db.getUpgradeRelocation(db.getRelocationWorkItem(w.id).relocationId);}
function complete(r){return db.completeRelocationUpgrade({id:r.id,role:'purchasing',completedQuantity:10,newVersion:'V2',targetWarehouse:'SyntheticWarehouseA',expectedRevision:r.revision,requestId:rid()});}
const waiting=sync(work('WAIT','CONCURRENT-PAGE')),other=work('OTHER','CONCURRENT-PAGE');
const port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('flow-page');
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,PORT:String(port),HOST:'127.0.0.1',PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
let browser,checks=0;const check=(name,c=true)=>{assert.ok(c,name);checks++;console.log('PASS '+name);};
async function api(route,payload,role='assistant-1'){const r=await fetch(base+route,{method:'POST',headers:{'x-role':role,'content-type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;}
try{
 await waitForOwnedServer({base,child,instanceId});
 // 两个不同实际批次，均从真实导入和上架入口建立。
 const body=Buffer.from('ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\nFLOW-DIRECT,10,4,XDPA,SyntheticWarehouseB,P-A,2026-09-01,一团,V1\nFLOW-DIRECT,10,4,XDPB,SyntheticWarehouseB,P-B,2026-09-01,一团,V1');
 const p=await (await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':'assistant-1','x-file-name':encodeURIComponent('批次恢复硒鼓.csv')},body})).json();
 const imp=await api('/api/transit/import',{previewToken:p.previewToken,fileName:'批次恢复硒鼓.csv',fileHash:p.fileSha256,templateHash:p.templateSha256,rows:p.rows.map(r=>({...r,data:{...r.data,version:'V1'}})),requestId:rid()});
 for(const row of imp.rows){const t=db.getTransit(row.id);await api(`/api/transit/${t.id}/on-shelf`,{yes:'YES',expectedRevision:t.revision,requestId:rid()});}
 let direct=db.createDirectUpgrade({role:'admin',model:'FLOW-DIRECT',sourceVersion:'V1',requestId:rid()}).upgrade;
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByLabel('切换当前操作角色',{exact:true}).selectOption('admin');await page.locator('.sidebar .nav-item',{hasText:'升级库存'}).click();
 await page.locator('.source-select').filter({hasText:waiting.documentNo}).click();
 const wr=page.locator(`[data-relocation-work-id="${waiting.id}"]`),a=wr.getByRole('checkbox',{name:new RegExp('采纳包裹 A ')}),b=wr.getByRole('checkbox',{name:new RegExp('采纳包裹 B ')});
 await a.check();await wr.getByLabel(waiting.workNo+' FBA 剩余库存',{exact:true}).fill('10');
 const consumed=ship(sync(other),'A');complete(consumed);
 await wr.getByText('所选包裹可用量已变化',{exact:false}).waitFor({timeout:15000});
 check('另一电脑使用已勾包裹后显示原因，允许取消旧选择',await a.isChecked()&&await a.isEnabled()&&await wr.getByRole('button',{name:'登记移仓发货',exact:true}).isDisabled());
 await wr.screenshot({path:path.join(out,'stale-package-recovery.png')});await a.uncheck();check('已用完包裹取消后禁止重新勾选',await a.isDisabled());await b.check();
 await wr.getByRole('button',{name:'登记移仓发货',exact:true}).click();await wr.waitFor({state:'detached'});
 const resumed=db.getUpgradeRelocation(db.getRelocationWorkItem(waiting.id).relocationId);complete(resumed);
 check('改选实际新包裹后发货回库完成，全局每包裹只用10件',db.getUpgradeRelocation(resumed.id).completed_quantity===10&&db.relocationExternalShipments('CONCURRENT-PAGE','XPAGEFLOW1').every(p=>p.usedQuantity===10));
 await page.getByLabel('切换当前操作角色',{exact:true}).selectOption('purchasing');await page.getByRole('tab',{name:'在库升级',exact:true}).click();
 const job=page.locator('.upgrade-job').filter({hasText:direct.upgradeNo}),select=job.getByLabel(direct.upgradeNo+' 完成来源批次',{exact:true}),button=job.getByRole('button',{name:'登记完成并转入新版本',exact:true});
 await select.selectOption(String(direct.lines[0].id));await job.getByLabel(direct.upgradeNo+' 升级完成数量',{exact:true}).fill('5');await job.getByLabel(direct.upgradeNo+' 升级完成版本号',{exact:true}).fill('V3');await job.getByLabel(direct.upgradeNo+' 目标海外仓',{exact:true}).selectOption('SyntheticWarehouseA');
 direct=db.completeDirectUpgrade({id:direct.id,role:'purchasing',sourceLineId:direct.lines[0].id,completedQuantity:10,newVersion:'V2',targetWarehouse:'SyntheticWarehouseA',expectedRevision:direct.revision,requestId:rid()}).upgrade;
 await page.waitForFunction(()=>document.querySelector('.upgrade-job')?.textContent.includes('V2 / SyntheticWarehouseA：10'),null,{timeout:15000});
 await job.getByText('所选批次已由其他操作完成，请重新选择实际来源批次。',{exact:true}).waitFor();check('所选升级批次耗尽后不悄悄改用另一批次，显示重选入口',await button.isDisabled()&&await select.inputValue()==='');
 await select.selectOption(String(direct.lines.find(l=>l.inProgressQuantity>0).id));await job.getByLabel(direct.upgradeNo+' 升级完成数量',{exact:true}).fill('11');check('数量超过所选批次时页面说明并禁止提交',await button.isDisabled());await job.getByLabel(direct.upgradeNo+' 升级完成数量',{exact:true}).fill('10');
 let dropDirect=true;await page.route(`**/api/upgrades/direct/${direct.id}/complete`,async route=>{if(!dropDirect)return route.continue();dropDirect=false;const result=await route.fetch();assert.equal(result.status(),200);await route.abort('failed');});await button.click();await job.getByRole('button',{name:'重试确认',exact:true}).waitFor();
 await job.getByText('V3 / SyntheticWarehouseA：10',{exact:true}).waitFor();check('最后一批已完成且回执丢失，仍保留重试确认和原批次',await job.getByRole('button',{name:'重试确认',exact:true}).isEnabled()&&await select.isDisabled()&&await select.inputValue()===String(direct.lines.find(l=>l.inProgressQuantity>0).id));
 await job.getByRole('button',{name:'重试确认',exact:true}).click();await job.getByRole('button',{name:'重试确认',exact:true}).waitFor({state:'detached'});check('最后一批重试只确认原结果，实际完成记录仍两笔',db.db.prepare("SELECT COUNT(*) n FROM upgrade_operations WHERE upgrade_id=? AND operation_type='direct_complete' AND status='active'").get(direct.id).n===2);
 await job.getByText('V3 / SyntheticWarehouseA：10',{exact:true}).waitFor();check('重选剩余实际批次完成后总20、锁定0且版本分别10',db.db.prepare("SELECT SUM(on_hand) n,SUM(locked) l FROM stock_balances WHERE model='FLOW-DIRECT'").get().n===20&&db.db.prepare("SELECT SUM(locked) n FROM stock_balances WHERE model='FLOW-DIRECT'").get().n===0);
 db.assertInventoryInvariants();check('页面无运行异常，库存及外键一致',errors.length===0&&db.db.prepare('PRAGMA foreign_key_check').all().length===0);
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({checks,errors,state,base},null,2));console.log(`FLOW_RECOVERY_PAGE_RESULT: ALL PASS (${checks}); isolated ${state}`);
}finally{await browser?.close();child.kill();db.close();}
