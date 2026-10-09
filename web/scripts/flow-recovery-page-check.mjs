import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {createInventoryDatabase,InventoryDatabase} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'../..'),state=fs.mkdtempSync(path.join(os.tmpdir(),'aster-flow-page-')),out=process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/flow-recovery-page');
fs.mkdirSync(out,{recursive:true});createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID();
function archive(n){let r=db.createInquiry({role:'operation-1',model:'SYNTH-TONER-001',quantity:20,department:'一团',store:'恢复页面US',operator:n,fnsku:'XPAGEFLOW1',asin:'BPAGEFLOW1',requestId:rid()}).record;r=db.reviewInquiry({id:r.id,role:'business',decision:'approve',approvedQuantity:20,expectedRevision:r.revision,requestId:rid()}).record;r=db.replyInquiry({id:r.id,role:'purchasing',supplierQuantity:20,shippingWarehouse:'CA',expectedRevision:r.revision,requestId:rid()}).record;return db.archiveInquiry({id:r.id,role:'assistant-1',plan:'PAGE-'+n,date:'2026-09-11',version:'V1',expectedRevision:r.revision,requestId:rid()}).record;}
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
 // 服务已提交，但2xx坏JSON或空回执不能被当作确定失败；重试必须复用原请求。
 await page.getByLabel('切换当前操作角色',{exact:true}).selectOption('operation-1');await page.locator('.sidebar .nav-item',{hasText:'库存汇总'}).click();await page.locator('.inventory-summary-row').filter({has:page.getByText('FLOW-DIRECT',{exact:true})}).click();
 for(const [label,body] of [['bad-json','{invalid'],['empty','']]){
  const operator='MALFORMED-'+label,submitted=[];let corrupt=true;
  await page.route('**/api/inquiries',async route=>{if(route.request().method()!=='POST')return route.continue();submitted.push(route.request().postDataJSON());const receipt=await route.fetch();assert.equal(receipt.status(),200);if(corrupt){corrupt=false;return route.fulfill({status:200,contentType:'application/json',body});}return route.fulfill({response:receipt});});
  await page.getByRole('button',{name:'询库',exact:true}).click();const form=page.getByRole('dialog');
  for(const [name,value] of Object.entries({'询库数量（必填）':3,'询库店铺（必填）':'隔离回执US','询库运营（必填）':operator,'ASIN（必填）':'BMALFORM01','FNSKU（必填）':'XMALFORM01'}))await form.getByLabel(name,{exact:true}).fill(String(value));
  await form.getByRole('button',{name:'提交询库',exact:true}).click();await form.getByRole('alert').waitFor();assert.equal(db.db.prepare('SELECT COUNT(*) n FROM inquiry_documents WHERE operator_name=?').get(operator).n,1);
  const retryLabel=await form.locator('.dialog-actions button.btn-primary').innerText(),disabled=await form.locator('fieldset').evaluate(element=>element.disabled);await form.locator('.dialog-actions button.btn-primary').click();await form.waitFor({state:'hidden'});
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM inquiry_documents WHERE operator_name=?').get(operator).n,1,'2xx '+label+' 回执重试不得重复创建询库');assert.equal(submitted.length,2);assert.equal(submitted[0].requestId,submitted[1].requestId);assert.equal(retryLabel,'重试确认');assert.equal(disabled,true);await page.unroute('**/api/inquiries');check('2xx '+label+' 已提交回执异常：保留草稿与原幂等键，重试只读取原询库结果');
 }

 // 跨刷新恢复只保存待确认提交，不恢复普通表单草稿或默认角色。
 const savedKey='aster-pending-business-requests',recoveryEvidence=[];
 async function openInquiry(p,operator){
  await p.getByLabel('切换当前操作角色',{exact:true}).selectOption('operation-1');
  await p.locator('.sidebar .nav-item',{hasText:'库存汇总'}).click();
  if(await p.getByRole('button',{name:'询库',exact:true}).count()===0)await p.locator('.inventory-summary-row').filter({has:p.getByText('FLOW-DIRECT',{exact:true})}).click();
  await p.getByRole('button',{name:'询库',exact:true}).click();const f=p.getByRole('dialog');
  for(const [name,value] of Object.entries({'询库数量（必填）':3,'询库店铺（必填）':'隔离恢复US','询库运营（必填）':operator,'ASIN（必填）':'BREFRESH01','FNSKU（必填）':'XREFRESH01'}))await f.getByLabel(name,{exact:true}).fill(String(value));
  return f;
 }
 const countInquiry=operator=>db.db.prepare('SELECT COUNT(*) n FROM inquiry_documents WHERE operator_name=?').get(operator).n;
 for(const mode of ['bad-json-refresh','inflight-refresh','abort-role']){
  const p=await browser.newPage({viewport:{width:1600,height:1100}}),operator='PERSIST-'+mode,submitted=[];
  p.on('pageerror',e=>errors.push(e.message));await p.goto(base);const f=await openInquiry(p,operator);
  let first=true,release,committed;const saved=new Promise(resolve=>committed=resolve);
  await p.route('**/api/inquiries',async route=>{
   if(route.request().method()!=='POST')return route.continue();
   submitted.push({role:route.request().headers()['x-role'],body:route.request().postDataJSON()});
   const receipt=await route.fetch();assert.equal(receipt.status(),200);
   if(first){first=false;committed();if(mode==='bad-json-refresh')return route.fulfill({status:200,contentType:'application/json',body:'{invalid'});
    if(mode==='abort-role')return route.abort('failed');
    await new Promise(resolve=>release=resolve);try{await route.fulfill({response:receipt});}catch{}return;
   }
   return route.fulfill({response:receipt});
  });
  await f.getByRole('button',{name:'提交询库',exact:true}).click();await saved;assert.equal(countInquiry(operator),1);
  if(mode!=='inflight-refresh')await f.getByRole('button',{name:'重试确认',exact:true}).waitFor();
  const pending=await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)),savedKey);assert.equal(pending.length,1);assert.equal(pending[0].role,'operation-1');assert.equal(pending[0].body,JSON.stringify(submitted[0].body));assert.equal(pending[0].databaseId,db.syncState().databaseId);
  if(mode==='abort-role'){
   await p.getByLabel('切换当前操作角色',{exact:true}).selectOption('business');assert.equal(await p.getByRole('button',{name:'确认本次提交',exact:true}).count(),0);
  }else{
   await p.reload();release?.();assert.equal(await p.getByLabel('切换当前操作角色',{exact:true}).inputValue(),'admin');assert.equal(await p.getByRole('button',{name:'确认本次提交',exact:true}).count(),0);
  }
  await p.getByText('另有未确认提交，请切换到原操作角色：运营·一团。',{exact:true}).waitFor();
  assert.equal(submitted.length,1,'刷新和切换角色不得自动重放');
  await p.getByLabel('切换当前操作角色',{exact:true}).selectOption('operation-1');
  const resume=p.getByRole('button',{name:'确认本次提交',exact:true});await resume.waitFor();await p.waitForFunction(()=>!document.querySelector('.pending-business-row button')?.disabled);
  if(mode==='bad-json-refresh'){
   // 已有未知提交时填写新单也不能生成第二次业务请求。
   const newForm=await openInquiry(p,operator+'-NEW');await newForm.getByRole('button',{name:'提交询库',exact:true}).click();await newForm.getByRole('alert').filter({hasText:'还有未确认的提交'}).waitFor();assert.equal(submitted.length,1);assert.equal(countInquiry(operator+'-NEW'),0);
   await newForm.getByRole('button',{name:'取消',exact:true}).click();
   // 当前恢复页面身份已验证后，恢复按钮仍需重新读取身份，不能只依赖显示时结果。
   let wrong=true;await p.route('**/api/sync',async route=>{const receipt=await route.fetch();const j=await receipt.json();if(wrong)j.sync.databaseId='WRONG-TARGET-DATABASE';await route.fulfill({response:receipt,json:j});});
   await resume.click();await p.getByRole('status').filter({hasText:'当前数据库与原提交不一致'}).waitFor();assert.equal(submitted.length,1);assert.equal(await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)).length,savedKey),1);
   wrong=false;await p.unroute('**/api/sync');
  }
  await resume.click();await p.getByRole('status').filter({hasText:'原提交结果已确认'}).waitFor();assert.equal(countInquiry(operator),1);assert.equal(submitted.length,2);assert.deepEqual(submitted[0],submitted[1]);assert.equal(await p.evaluate(k=>sessionStorage.getItem(k),savedKey),null);
  if(mode==='bad-json-refresh'){const newForm=await openInquiry(p,operator+'-NEW');await newForm.getByRole('button',{name:'提交询库',exact:true}).click();await newForm.waitFor({state:'hidden'});assert.equal(countInquiry(operator+'-NEW'),1);assert.notEqual(submitted[2].body.requestId,submitted[0].body.requestId);}
  recoveryEvidence.push({mode,operator,submissions:submitted,quantity:3,records:countInquiry(operator)});await p.screenshot({path:path.join(out,mode+'.png')});check(mode+'：实际保存后恢复原角色/原库/原参数/原键，一单且不自动提交');await p.close();
 }
 // 原表单的重试也必须绑定原数据库，不能将旧键重新标为新库。
 {
  const p=await browser.newPage({viewport:{width:1600,height:1100}});await p.goto(base);const operator='PERSIST-ORIGINAL-DB',f=await openInquiry(p,operator);let submissions=0;
  await p.route('**/api/inquiries',async route=>{submissions++;const receipt=await route.fetch();await route.fulfill({status:200,contentType:'application/json',body:'{invalid'});});
  await f.getByRole('button',{name:'提交询库',exact:true}).click();await f.getByRole('button',{name:'重试确认',exact:true}).waitFor();assert.equal(countInquiry(operator),1);
  await p.route('**/api/sync',async route=>{const receipt=await route.fetch();const j=await receipt.json();j.sync.databaseId='WRONG-TARGET-DATABASE';await route.fulfill({response:receipt,json:j});});
  await f.getByRole('button',{name:'重试确认',exact:true}).click();await f.getByRole('alert').filter({hasText:'当前数据库或操作内容与原提交不一致'}).waitFor();assert.equal(submissions,1);assert.equal((await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)),savedKey))[0].databaseId,db.syncState().databaseId);
  check('原表单重试遇到数据库身份变化：不发POST、不改原绑定');await p.close();
 }
 // 浏览器存储失败要在实际POST前阻止；确定权限拒绝后才清理待确认记录。
 {
  const p=await browser.newPage({viewport:{width:1600,height:1100}});await p.goto(base);const operator='PERSIST-STORAGE',f=await openInquiry(p,operator);let submissions=0;
  await p.route('**/api/inquiries',async route=>{submissions++;return route.continue();});
  await p.evaluate(k=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key===k)throw new DOMException('quota','QuotaExceededError');return window.originalSetItem.call(this,key,value);};},savedKey);
  await f.getByRole('button',{name:'提交询库',exact:true}).click();await f.getByRole('alert').filter({hasText:'本次未发送'}).waitFor();assert.equal(submissions,0);assert.equal(countInquiry(operator),0);
  await p.evaluate(()=>{Storage.prototype.setItem=window.originalSetItem;});await p.unroute('**/api/inquiries');
  await p.route('**/api/inquiries',async route=>{submissions++;const receipt=await route.fetch({headers:{...route.request().headers(),'x-role':'purchasing'}});assert.equal(receipt.status(),403);await route.fulfill({response:receipt});});
  await f.getByRole('button',{name:'提交询库',exact:true}).click();await f.getByRole('alert').waitFor();assert.equal(submissions,1);assert.equal(countInquiry(operator),0);assert.equal(await p.evaluate(k=>sessionStorage.getItem(k),savedKey),null);assert.equal(await f.locator('fieldset').evaluate(e=>e.disabled),false);
  check('存储失败不发POST；真实接口确定403后清理记录且可重新填写');await p.close();
 }

 // 原请求已经保存，授权收紧后的403只能说明当前不能核对，不能否认原提交结果。
 {
  const p=await browser.newPage({viewport:{width:1600,height:1100}}),operator='PERSIST-REPLAY-403',submitted=[];
  db.db.prepare("UPDATE catalog_models SET category='墨盒' WHERE model='FLOW-DIRECT'").run();
  const permissionFile=path.join(state,'data/permissions.json'),permissions={'墨盒':Object.fromEntries(['admin','assistant-1','assistant-2','operation-1','operation-2','purchasing','business'].map(role=>[role,{summary:true,detail:true,expand:true,actions:true}]))};
  fs.writeFileSync(permissionFile,JSON.stringify(permissions));
  await p.goto(base);const f=await openInquiry(p,operator);let first=true;
  await p.route('**/api/inquiries',async route=>{submitted.push({role:route.request().headers()['x-role'],body:route.request().postDataJSON()});const receipt=await route.fetch();
   if(first){first=false;assert.equal(receipt.status(),200);return route.fulfill({status:200,contentType:'application/json',body:'{invalid'});}
   await route.fulfill({response:receipt});
  });
  await f.getByRole('button',{name:'提交询库',exact:true}).click();await f.getByRole('button',{name:'重试确认',exact:true}).waitFor();assert.equal(countInquiry(operator),1);
  permissions['墨盒']['operation-1'].actions=false;fs.writeFileSync(permissionFile,JSON.stringify(permissions));
  await f.getByRole('button',{name:'重试确认',exact:true}).click();await f.getByRole('alert').filter({hasText:'原提交结果仍未核对'}).waitFor();
  assert.equal(submitted.length,2);assert.equal(countInquiry(operator),1);assert.equal(await f.locator('fieldset').evaluate(e=>e.disabled),true);assert.equal((await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)),savedKey)).length,1);
  permissions['墨盒']['operation-1'].actions=true;fs.writeFileSync(permissionFile,JSON.stringify(permissions));
  await f.getByRole('button',{name:'重试确认',exact:true}).click();await f.waitFor({state:'hidden'});assert.equal(submitted.length,3);assert.equal(countInquiry(operator),1);assert.deepEqual(submitted[0],submitted[1]);assert.deepEqual(submitted[1],submitted[2]);assert.equal(await p.evaluate(k=>sessionStorage.getItem(k),savedKey),null);
  check('已保存未知请求重放被真实权限403拒绝：保留原键与未知状态，权限恢复同键仍一单');await p.close();
  db.db.prepare("UPDATE catalog_models SET category='硒鼓' WHERE model='FLOW-DIRECT'").run();
 }


 // 500在事务中回滚后，缓存未命中的明确stale码可以证明原键未保存，允许继续按新状态办理。
 {
  const rollback=db.createDirectUpgrade({role:'admin',model:'FLOW-DIRECT',sourceVersion:'V3',requestId:rid()}).upgrade,p=await browser.newPage({viewport:{width:1600,height:1100}}),receipts=[],submitted=[];
  await p.goto(base);await p.getByLabel('切换当前操作角色',{exact:true}).selectOption('purchasing');await p.locator('.sidebar .nav-item',{hasText:'升级库存'}).click();await p.getByRole('tab',{name:'在库升级',exact:true}).click();
  const j=p.locator('.upgrade-job').filter({hasText:rollback.upgradeNo}),quantity=j.getByLabel(rollback.upgradeNo+' 升级完成数量',{exact:true}),button=j.getByRole('button',{name:'登记完成并转入新版本',exact:true});
  await j.getByLabel(rollback.upgradeNo+' 完成来源批次',{exact:true}).selectOption(String(rollback.lines[0].id));await quantity.fill('5');await j.getByLabel(rollback.upgradeNo+' 升级完成版本号',{exact:true}).fill('V5');await j.getByLabel(rollback.upgradeNo+' 目标海外仓',{exact:true}).selectOption('SyntheticWarehouseA');
  await p.route('**/api/upgrades/direct/'+rollback.id+'/complete',async route=>{submitted.push(route.request().postDataJSON());const receipt=await route.fetch();const payload=await receipt.json();receipts.push({status:receipt.status(),code:payload.code,requestNotApplied:payload.requestNotApplied===true});await route.fulfill({response:receipt});});
  const rollbackEvents=db.db.prepare("SELECT * FROM document_events ORDER BY id").all(),rollbackLedger=db.db.prepare("SELECT * FROM upgrade_inventory_ledger ORDER BY id").all();
  db.db.exec("CREATE TRIGGER flow_test_upgrade_rollback BEFORE INSERT ON upgrade_operations BEGIN SELECT RAISE(ABORT,'FLOW_TEST_ROLLBACK'); END");
  await button.click();await j.getByRole('button',{name:'重试确认',exact:true}).waitFor();assert.equal(receipts[0].status,500);assert.equal(db.upgradeRecord(rollback.id).revision,rollback.revision);assert.equal(db.db.prepare("SELECT COUNT(*) n FROM upgrade_operations WHERE upgrade_id=? AND operation_type='direct_complete'").get(rollback.id).n,0);assert.deepEqual(db.db.prepare('SELECT * FROM document_events ORDER BY id').all(),rollbackEvents);assert.deepEqual(db.db.prepare('SELECT * FROM upgrade_inventory_ledger ORDER BY id').all(),rollbackLedger);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM idempotency_requests WHERE request_id=?').get(submitted[0].requestId).n,0);
  db.db.exec('DROP TRIGGER flow_test_upgrade_rollback');
  db.completeDirectUpgrade({id:rollback.id,role:'purchasing',sourceLineId:rollback.lines[0].id,completedQuantity:1,newVersion:'V4',targetWarehouse:'SyntheticWarehouseA',expectedRevision:rollback.revision,requestId:rid()});
  await j.getByText('V4 / SyntheticWarehouseA：1',{exact:true}).waitFor();
  await j.getByRole('button',{name:'重试确认',exact:true}).click();await p.getByText('升级记录已被其他操作更新，请刷新后重试',{exact:true}).waitFor();assert.deepEqual(receipts[1],{status:409,code:'upgrade_stale_revision',requestNotApplied:true});assert.equal(submitted[0].requestId,submitted[1].requestId);assert.equal(await p.evaluate(k=>sessionStorage.getItem(k),savedKey),null);assert.equal(await quantity.isEnabled(),true);assert.equal(await j.getByRole('button',{name:'重试确认',exact:true}).count(),0);
  await quantity.fill('9');await button.click();await j.getByText('V4 / SyntheticWarehouseA：1、V5 / SyntheticWarehouseA：9',{exact:true}).waitFor();assert.deepEqual(db.completionVersions('direct_line',rollback.lines[0].id).map(row=>({...row})),[{version:'V4',warehouse:'SyntheticWarehouseA',quantity:1},{version:'V5',warehouse:'SyntheticWarehouseA',quantity:9}]);assert.equal(receipts[2].status,200);assert.notEqual(submitted[2].requestId,submitted[0].requestId);assert.equal(db.db.prepare("SELECT COUNT(*) n FROM upgrade_operations WHERE upgrade_id=? AND operation_type='direct_complete'").get(rollback.id).n,2);assert.equal(db.db.prepare('SELECT SUM(remaining_quantity) n FROM upgrade_stock_lines WHERE upgrade_id=?').get(rollback.id).n,0);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM idempotency_requests WHERE request_id=?').get(submitted[0].requestId).n,0);
  await p.reload();assert.equal(await p.getByRole('button',{name:'确认本次提交',exact:true}).count(),0);await p.close();
  recoveryEvidence.push({mode:'actual-500-rollback-other-write-stale-continue',receipts,requestIds:submitted.map(r=>r.requestId),upgradeId:rollback.id,actualOperations:2,originalIdempotencyRows:0});
  check('实际500事务回滚→其他同事办理1件→原键409升级stale清等待→新键完成9件，实际两笔且刷新无遗留');
 }


 // 原导入未到服务端后，缓存未命中的预览过期/失效可以确认未提交，重新预览仍正常一次导入。
 {
  const tokenEvidence=[];
  for(const mode of ['expired','invalid']){
   const p=await browser.newPage({viewport:{width:1600,height:1100}}),model='FLOW-TOKEN-'+mode.toUpperCase(),fileName='恢复令牌-'+mode+'-硒鼓.csv',file={name:fileName,mimeType:'text/csv',buffer:Buffer.from('ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n'+model+',2,4,XTOKEN'+mode.toUpperCase()+',SyntheticWarehouseB,TOKEN-'+mode+',2026-09-14,一团,V1')},submitted=[],receipts=[];
   await p.goto(base);await p.getByLabel('切换当前操作角色',{exact:true}).selectOption('assistant-1');await p.locator('.sidebar .nav-item',{hasText:'在途库存',hasNotText:'升级'}).click();
   await p.locator('#transit-import-file').setInputFiles(file);await p.locator('.transit-preview-table tbody tr').waitFor();
   let drop=true;await p.route('**/api/transit/import',async route=>{submitted.push(route.request().postDataJSON());if(drop){drop=false;return route.abort('failed');}const receipt=await route.fetch(),j=await receipt.json();receipts.push({status:receipt.status(),code:j.code,rowCount:j.rowCount,requestNotApplied:j.requestNotApplied===true});await route.fulfill({response:receipt});});
   await p.getByRole('button',{name:/^确认导入/}).click();await p.getByRole('status').filter({hasText:'尚未确认是否保存'}).waitFor();assert.equal(db.db.prepare('SELECT COUNT(*) n FROM transit_batches WHERE model=?').get(model).n,0);assert.equal((await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)),savedKey)).length,1);
   db.db.prepare("UPDATE transit_preview_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE file_name=?").run(fileName);
   if(mode==='invalid'){
    const clean=await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':'assistant-1','x-file-name':encodeURIComponent('清理已过期令牌硒鼓.csv'),'x-date-year':'2026'},body:file.buffer});assert.equal(clean.status,200);assert.equal((await clean.json()).ok,true);
   }
   await p.getByRole('button',{name:/^确认导入/}).click();await p.getByRole('status').filter({hasText:mode==='expired'?'文件预览已过期':'文件预览已失效'}).waitFor();assert.equal(receipts[0].status,422);assert.equal(receipts[0].code,'preview_token_'+mode);assert.equal(receipts[0].requestNotApplied,true);assert.equal(submitted[0].requestId,submitted[1].requestId);assert.equal(await p.evaluate(k=>sessionStorage.getItem(k),savedKey),null);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM transit_batches WHERE model=?').get(model).n,0);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM idempotency_requests WHERE request_id=?').get(submitted[0].requestId).n,0);
   await p.locator('#transit-import-file').setInputFiles(file);await p.locator('.transit-preview-table tbody tr').waitFor();await p.getByRole('button',{name:/^确认导入/}).click();await p.getByRole('status').filter({hasText:'已导入 1 条在途记录。'}).waitFor();assert.equal(receipts[1].status,200);assert.notEqual(submitted[2].requestId,submitted[0].requestId);assert.equal(db.db.prepare('SELECT COUNT(*) n,SUM(quantity) quantity,SUM(remaining_quantity) remaining FROM transit_batches WHERE model=?').get(model).n,1);assert.equal(db.db.prepare('SELECT SUM(quantity) n FROM transit_batches WHERE model=?').get(model).n,2);assert.equal(await p.evaluate(k=>sessionStorage.getItem(k),savedKey),null);
   tokenEvidence.push({mode,model,receipts,requestIds:submitted.map(r=>r.requestId),actualTransitRows:1,quantity:2,originalIdempotencyRows:0});await p.close();
  }
  recoveryEvidence.push({mode:'request-never-arrived-preview-expired-or-invalid-continue',variants:tokenEvidence});
  check('未到服务端的原导入→过期/清理失效令牌原键422清等待→同文件新预览一次导入，旧键无缓存');
 }


 // 采购未知提交未到服务端，另一采购已推进：事务内明确未应用的step错误可解除等待并继续运营。
 {
  const source=archive('COOP-RECOVERY'),w=db.initiateRelocationUpgrade({inquiryId:source.id,role:'operation-1',requestId:rid()}).workItem,p=await browser.newPage({viewport:{width:1600,height:1100}}),submitted=[],receipts=[],stockBefore=JSON.stringify(db.db.prepare('SELECT * FROM stock_balances ORDER BY batch_key').all());
  await p.goto(base);await p.getByLabel('切换当前操作角色',{exact:true}).selectOption('purchasing');await p.locator('.sidebar .nav-item',{hasText:'升级库存'}).click();await p.locator('.source-select').filter({hasText:source.documentNo}).click();
  const wr=p.locator('[data-relocation-work-id="'+w.id+'"]');await wr.getByLabel(w.workNo+' RMA',{exact:true}).fill('ORIGINAL-RMA');await wr.getByLabel(w.workNo+' 移仓地址',{exact:true}).fill('ORIGINAL-ADDRESS');
  let drop=true;await p.route('**/api/upgrades/relocation-work-items/'+w.id+'/procurement',async route=>{submitted.push(route.request().postDataJSON());if(drop){drop=false;return route.abort('failed');}const receipt=await route.fetch(),j=await receipt.json();receipts.push({status:receipt.status(),code:j.code,requestNotApplied:j.requestNotApplied===true});await route.fulfill({response:receipt});});
  await wr.getByRole('button',{name:'提交采购信息',exact:true}).click();await p.getByText(/尚未确认是否保存/).waitFor();assert.equal(db.getRelocationWorkItem(w.id).status,'awaiting_procurement');assert.equal((await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)),savedKey)).length,1);
  db.recordRelocationProcurement({id:w.id,role:'purchasing',rma:'OTHER-RMA',relocationAddress:'OTHER-ADDRESS',expectedRevision:w.revision,requestId:rid()});
  await p.reload();await p.getByLabel('切换当前操作角色',{exact:true}).selectOption('purchasing');const resume=p.getByRole('button',{name:'确认本次提交',exact:true});await resume.waitFor();await p.waitForFunction(()=>!document.querySelector('.pending-business-row button')?.disabled);await resume.click();
  await p.getByRole('status').filter({hasText:'当前移仓流程不在采购填写步骤'}).waitFor();assert.deepEqual(receipts,[{status:409,code:'invalid_relocation_step',requestNotApplied:true}]);assert.deepEqual(submitted[0],submitted[1]);assert.equal(await p.evaluate(k=>sessionStorage.getItem(k),savedKey),null);assert.equal(await resume.count(),0);assert.equal(db.getRelocationWorkItem(w.id).rma,'OTHER-RMA');assert.equal(db.db.prepare('SELECT COUNT(*) n FROM idempotency_requests WHERE request_id=?').get(submitted[0].requestId).n,0);
  await p.getByLabel('切换当前操作角色',{exact:true}).selectOption('operation-1');await p.locator('.sidebar .nav-item',{hasText:'升级库存'}).click();await p.locator('.source-select').filter({hasText:source.documentNo}).click();const op=p.locator('[data-relocation-work-id="'+w.id+'"]');await op.getByLabel(w.workNo+' 移除订单号',{exact:true}).fill('COOP-RECOVERY-ORDER');await op.getByRole('button',{name:'提交移除订单',exact:true}).click();await op.getByText('COOP-RECOVERY-ORDER',{exact:true}).waitFor();assert.equal(db.getRelocationWorkItem(w.id).status,'awaiting_shipping');assert.equal(db.getRelocationWorkItem(w.id).removalOrderNo,'COOP-RECOVERY-ORDER');assert.equal(JSON.stringify(db.db.prepare('SELECT * FROM stock_balances ORDER BY batch_key').all()),stockBefore);assert.equal(await p.evaluate(k=>sessionStorage.getItem(k),savedKey),null);
  recoveryEvidence.push({mode:'unknown-procurement-never-arrived-other-colleague-step-continues',workId:w.id,receipts,requestIds:submitted.map(r=>r.requestId),originalIdempotencyRows:0,finalStatus:'awaiting_shipping',stockUnchanged:true});
  check('采购原POST未到服务→另一采购推进→原键invalid_relocation_step明确未应用解除→运营页面继续保存订单，库存不变');await p.close();
 }

 fs.writeFileSync(path.join(out,'refresh-recovery-evidence.json'),JSON.stringify({recoveryEvidence,formalWrites:false,realLingxing:false},null,2));

 db.assertInventoryInvariants();check('页面无运行异常，库存及外键一致',errors.length===0&&db.db.prepare('PRAGMA foreign_key_check').all().length===0);
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({checks,errors,state,base},null,2));console.log(`FLOW_RECOVERY_PAGE_RESULT: ALL PASS (${checks}); isolated ${state}`);
}finally{await browser?.close();child.kill();db.close();}
