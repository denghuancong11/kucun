// Owned random-port server, synthetic transit receipts, real React/Edge. Never calls the formal service or Lingxing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from '../node_modules/playwright-core/index.mjs';
import {createInventoryDatabase, InventoryDatabase} from '../../inventory-db.mjs';
import {freePort, createTestInstanceId, waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'../..'),out=process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/direct-upgrade-redesign/page');
await fs.mkdir(out,{recursive:true});const state=await fs.mkdtemp(path.join(out,'state-'));
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID();
const port=await freePort(),base='http://127.0.0.1:'+port,instanceId=createTestInstanceId('direct-redesign');
const checks=[],screenshots=[],errors=[],requests=[];let child,browser,page,failure;
const check=(name,evidence={})=>{checks.push({name,...evidence});console.log('PASS '+name);};
const api=async(url,body,role='admin')=>{const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;};
const wait=async test=>{let error;for(let i=0;i<120;i++){try{return await test();}catch(e){error=e;await new Promise(r=>setTimeout(r,100));}}throw error;};
const task=id=>page.locator('[data-upgrade-id="'+id+'"]');
const details=id=>page.locator('[data-direct-batches="'+id+'"]');
const dialog=()=>page.getByRole('dialog');
const source=id=>dialog().locator('input[type=radio][value="'+id+'"]');
const totals=model=>({...db.db.prepare('SELECT SUM(on_hand) stock,SUM(locked) locked FROM stock_balances WHERE model=?').get(model)});
async function nav(role){await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(role);await page.locator('.sidebar .nav-item',{hasText:'升级库存'}).click();await page.getByRole('tab',{name:'在库升级',exact:true}).click();await page.waitForLoadState('networkidle');}
async function shot(name){const file=path.join(out,name+'.png');await page.screenshot({path:file,fullPage:true,animations:'disabled'});screenshots.push(file);}
async function openComplete(id){await task(id).getByRole('button',{name:'登记完成',exact:true}).click();await dialog().waitFor();}
async function fill(line,quantity,version,warehouse){await source(line.id).check();await dialog().getByLabel('本次完成数量',{exact:true}).fill(String(quantity));await dialog().getByLabel('升级完成版本',{exact:true}).fill(version);await dialog().getByLabel('目标海外仓',{exact:true}).selectOption(warehouse);}
async function submitComplete(id){const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===base+'/api/upgrades/direct/'+id+'/complete');await dialog().getByRole('button',{name:'登记完成并转入新版本',exact:true}).click();assert.equal((await response).status(),200);await dialog().waitFor({state:'detached'});return db.upgradeRecord(id);}
async function startJob(model,version){return (await api('/api/upgrades/direct',{model,sourceVersion:version,requestId:rid()})).upgrade;}
async function shelf(row){return api('/api/transit/'+row.id+'/on-shelf',{yes:'YES',expectedRevision:db.getTransit(row.id).revision,requestId:rid()},db.getTransit(row.id).team==='一团'?'assistant-1':'assistant-2');}
const warehouseA='SyntheticWarehouseA',warehouseB='SyntheticWarehouseB',model='DIRECT-UI-A';
try{
 child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,PORT:String(port),HOST:'127.0.0.1',PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});await waitForOwnedServer({base,child,instanceId});
 const longPlan='000PLAN-保留完整发货资料-ABCDEFGHIJKLMN-0123456789';
 const rows=[[model,200,1,'000FNSKU-A',warehouseA,longPlan,'2026-10-13','一团','V1'],[model,200,1,'000FNSKU-B',warehouseB,longPlan,'2026-10-13','二团','V1'],[model,100,1,'000FNSKU-A',warehouseB,longPlan,'2026-10-13','一团','V1'],[model,17,1,'000FNSKU-C',warehouseA,'PLAN-17','2026-10-13','一团','V1'],[model,12,1,'FNSKU-V5',warehouseA,'PLAN-V5','2026-10-13','一团','V5'],['DIRECT-UI-B',9,1,'FNSKU-B',warehouseA,'PLAN-B','2026-10-13','一团','V9'],['DIRECT-UI-C',8,1,'FNSKU-C',warehouseA,'PLAN-C','2026-10-13','一团','V0']];
 const csv=['ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号',...rows.map(row=>row.join(','))].join('\n'),fileName='在库改版隔离硒鼓.csv';
 const previewResponse=await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':'admin','x-file-name':encodeURIComponent(fileName)},body:csv});assert.equal(previewResponse.status,200);const preview=await previewResponse.json();
 const imported=await api('/api/transit/import',{previewToken:preview.previewToken,fileName,fileHash:preview.fileSha256,templateHash:preview.templateSha256,rows:preview.rows,requestId:rid()});
 for(const [i,row]of imported.rows.entries())if(i!==3)await shelf(row);
 const v5=await startJob(model,'V5'),b=await startJob('DIRECT-UI-B','V9'),c=await startJob('DIRECT-UI-C','V0');
 await api('/api/upgrades/direct/'+c.id+'/complete',{sourceLineId:c.lines[0].id,completedQuantity:8,newVersion:'V2',targetWarehouse:warehouseB,expectedRevision:c.revision,requestId:rid()},'purchasing');
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')requests.push({url:r.url(),body:r.postDataJSON()});});
 await page.goto(base);await nav('admin');
 assert.equal(await page.locator('[data-upgrade-id]').count(),3);assert.equal(await dialog().count(),0);assert.equal(await page.locator('.direct-batches').count(),0);
 assert.deepEqual(await page.getByRole('table',{name:'在库升级任务',exact:true}).locator(':scope > thead > tr > th').allTextContents(),['','型号','原版本','发起时间','发起岗位','初始锁定量','升级完成量','升级中锁定量','状况','操作']);
 await page.getByLabel('筛选型号',{exact:true}).selectOption(model);await page.getByLabel('筛选原版本',{exact:true}).selectOption('V5');assert.equal(await page.locator('[data-upgrade-id]').count(),1);
 await page.getByRole('button',{name:'发起在库升级',exact:true}).click();assert.equal(await dialog().locator('.field-error').count(),0);assert.equal(await page.getByLabel('发起型号',{exact:true}).inputValue(),'');
 await page.getByLabel('发起型号',{exact:true}).selectOption(model);await page.getByLabel('发起原版本',{exact:true}).selectOption('V1');assert((await dialog().innerText()).includes('500'));
 await shot('start-dialog-1440');
 const concurrent=async route=>{await shelf(imported.rows[3]);await route.continue();};await page.route('**/api/upgrades/direct',concurrent);
 await dialog().getByRole('button',{name:'锁定全部 500 件并发起升级',exact:true}).click();await page.locator('.notice-success').filter({hasText:'已锁定 517 件'}).waitFor();await page.unroute('**/api/upgrades/direct',concurrent);await dialog().waitFor({state:'detached'});
 let job=db.getUpgrades().find(j=>j.kind==='direct'&&j.model===model&&j.sourceVersion==='V1');assert.equal(job.initialQuantity,517);assert.equal(job.lines.length,4);assert.equal(await page.getByLabel('筛选原版本',{exact:true}).inputValue(),'V5');assert.equal(await page.locator('[data-upgrade-id]').count(),1);
 check('发起弹窗独立于筛选，500+17实际锁定和提示均517；多源未合并',{jobId:job.id,lines:4,locked:517});
 await page.getByLabel('筛选型号',{exact:true}).selectOption('DIRECT-UI-B');assert.equal(await page.getByLabel('筛选原版本',{exact:true}).inputValue(),'');await page.getByLabel('筛选型号',{exact:true}).selectOption('');
 await page.getByLabel('筛选状况',{exact:true}).selectOption('completed');assert.equal(await page.locator('[data-upgrade-id]').count(),1);await page.getByLabel('筛选状况',{exact:true}).selectOption('');
 const order=(await api('/api/upgrades')).upgrades.filter(j=>j.kind==='direct').map(j=>String(j.id));assert.deepEqual(await page.locator('[data-upgrade-id]').evaluateAll(els=>els.map(e=>e.dataset.upgradeId)),order);
 await task(job.id).getByRole('button',{name:/展开批次明细/}).click();assert.equal(await details(job.id).locator('[data-direct-line]').count(),4);
 assert.deepEqual(await details(job.id).locator('thead th').allTextContents(),['发货计划号','发货时间','入库时间','FNSKU','来源仓库','来源团队','初始锁定量','升级完成量','剩余升级量','升级完成版本','目标海外仓','本次完成数量']);
 const untouched=job.lines.find(line=>line.fnsku==='000FNSKU-A'&&line.warehouse===warehouseA),untouchedCells=await details(job.id).locator('[data-direct-line="'+untouched.id+'"] > td').allTextContents();assert.deepEqual(untouchedCells.slice(6),['200','0','200','—','—','—']);assert.equal(untouchedCells[0],longPlan);assert.equal(untouchedCells[3],'000FNSKU-A');
 for(const width of [1366,1440,1920]){await page.setViewportSize({width,height:1000});await shot('task-table-'+width);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 check('全部记录、型号/版本/状况筛选和原排序正确；1366/1440/1920表格及展开批次可读');
 for(const role of ['admin','operation-1','operation-2','assistant-1','assistant-2','purchasing','logistics','business','alan']){
  await nav(role);const payload=await api('/api/upgrades',null,role),expected=payload.upgrades.filter(j=>j.kind==='direct');assert.deepEqual(await page.locator('[data-upgrade-id]').evaluateAll(els=>els.map(e=>Number(e.dataset.upgradeId))),expected.map(j=>j.id));
  assert.equal(await page.getByRole('button',{name:'发起在库升级',exact:true}).count(),['business','alan'].includes(role)?0:1);
  assert.equal(await page.getByRole('button',{name:'登记完成',exact:true}).count(),['purchasing','logistics'].includes(role)?expected.filter(j=>j.status==='active').length:0);
  if(['operation-1','operation-2','assistant-1','assistant-2'].includes(role)){const team=role.endsWith('1')?'一团':'二团';assert(expected.every(j=>j.lines.every(l=>l.sourceTeam===team)));}
 }
 check('九角色沿用查看/发起/团队范围，仅采购和物流有完成入口，管理员无额外完成权限');
 await nav('purchasing');await task(job.id).getByRole('button',{name:/展开批次明细/}).click();await openComplete(job.id);assert.equal(await dialog().locator('.field-error').count(),0);assert.equal(await dialog().getByRole('radio').count(),4);assert.equal(await dialog().locator('input[type=radio]:checked').count(),0);
 assert.deepEqual(await dialog().locator('.direct-task-summary dt').allTextContents(),['型号','原版本','发起时间','发起岗位','状况']);assert.deepEqual((await dialog().locator('.direct-task-summary dd').allTextContents()).slice(0,2),[model,'V1']);
 assert.deepEqual(await dialog().locator('.direct-source-option').first().locator('dt').allTextContents(),['发货计划号','发货时间','入库时间','FNSKU','来源仓库','来源团队','初始锁定量','升级完成量','剩余升级量']);
 const line=job.lines.find(l=>l.fnsku==='000FNSKU-A'&&l.warehouse===warehouseA);await fill(line,'0','V1',warehouseA);assert((await dialog().innerText()).includes('大于0的整数'));assert((await dialog().innerText()).includes('必须与原版本不同'));assert(await dialog().getByRole('button',{name:'登记完成并转入新版本',exact:true}).isDisabled());
 await dialog().getByLabel('本次完成数量',{exact:true}).fill('201');assert((await dialog().innerText()).includes('剩余 200'));await dialog().getByLabel('本次完成数量',{exact:true}).fill('1.5');assert((await dialog().innerText()).includes('大于0的整数'));
 await fill(line,3,'V2',warehouseA);
 for(const width of [1366,1440]){await page.setViewportSize({width,height:900});await dialog().locator('.direct-dialog-body').evaluate(el=>el.scrollTop=0);await shot('complete-dialog-'+width);await dialog().locator('.direct-dialog-body').evaluate(el=>el.scrollTop=el.scrollHeight);await shot('complete-dialog-fields-'+width);const layout=await dialog().evaluate(el=>({rect:{x:el.getBoundingClientRect().x,right:el.getBoundingClientRect().right,bottom:el.getBoundingClientRect().bottom},overflow:[...el.querySelectorAll('.direct-source-option dd')].some(e=>e.scrollWidth>e.clientWidth),ellipsis:[...el.querySelectorAll('.direct-source-option dd')].some(e=>getComputedStyle(e).textOverflow==='ellipsis')}));assert(layout.rect.x>=0&&layout.rect.right<=width&&layout.rect.bottom<=900);assert(!layout.overflow&&!layout.ellipsis);}
 check('完成弹窗空表单不报错；完整业务资料选择批次，0/小数/超量/原版本均阻止提交');
 const initial=totals(model);
 job=await submitComplete(job.id);
 for(const [quantity,version,warehouse]of [[4,'V2',warehouseA],[5,'V3',warehouseB]]){await openComplete(job.id);await fill(line,quantity,version,warehouse);if(quantity===5)await page.route('**/api/upgrades',route=>route.fulfill({status:503,json:{ok:false,error:'隔离刷新失败'}}));job=await submitComplete(job.id);if(quantity===5){await page.locator('.notice-warning').filter({hasText:'已保存，但页面刷新失败'}).waitFor();await page.unroute('**/api/upgrades');check('完成已保存但列表读取失败时关闭弹窗，明确已保存，不误报业务失败');}}
 assert.deepEqual(job.lines.find(l=>l.id===line.id).completions.map(x=>({...x})),[{version:'V2',warehouse:warehouseA,quantity:3},{version:'V2',warehouse:warehouseA,quantity:4},{version:'V3',warehouse:warehouseB,quantity:5}]);
 const completionRows=details(job.id).locator('[data-direct-completion="'+line.id+'"]');await wait(async()=>assert.deepEqual(await completionRows.evaluateAll(rows=>rows.map(row=>[...row.querySelectorAll('td')].slice(-3).map(cell=>cell.textContent))),[['V2',warehouseA,'3'],['V2',warehouseA,'4'],['V3',warehouseB,'5']]));assert.deepEqual(await completionRows.evaluateAll(rows=>rows.map(row=>row.children.length)),[12,3,3]);assert.deepEqual(await completionRows.first().locator('td').evaluateAll(cells=>cells.slice(0,9).map(cell=>cell.rowSpan)),Array(9).fill(3));assert.deepEqual(totals(model),{stock:initial.stock,locked:initial.locked-12});await shot('partial-completions');await details(job.id).evaluate(el=>el.scrollLeft=el.scrollWidth);assert(await details(job.id).evaluate(el=>el.scrollLeft>0));await shot('partial-completions-right');await details(job.id).evaluate(el=>el.scrollLeft=0);
 check('同一来源3/4/5分次完成逐条保留，多版本和多仓库对应正确；库存守恒、锁定减少12');
 await openComplete(job.id);const other=job.lines.find(l=>l.fnsku==='000FNSKU-B');await fill(other,5,'V4',warehouseA);
 await api('/api/upgrades/direct/'+job.id+'/complete',{sourceLineId:other.id,completedQuantity:other.inProgressQuantity,newVersion:'V4',targetWarehouse:warehouseA,expectedRevision:job.revision,requestId:rid()},'logistics');
 await dialog().getByText('所选批次已由其他操作完成，请重新选择实际来源批次。',{exact:true}).waitFor();assert.equal(await dialog().locator('input[type=radio]:checked').inputValue(),String(other.id));assert(await dialog().getByRole('button',{name:'登记完成并转入新版本',exact:true}).isDisabled());await dialog().getByRole('button',{name:'关闭弹窗',exact:true}).click();
 check('另一人完成所选批次后保留原选择并要求重选，不改办其他批次');
 await openComplete(job.id);job=db.upgradeRecord(job.id);const pendingLine=job.lines.find(l=>l.fnsku==='000FNSKU-C');await fill(pendingLine,17,'V8',warehouseB);
 let drop=true;const sent=[];const lost=async route=>{sent.push(route.request().postDataJSON());if(drop){drop=false;const r=await route.fetch();assert.equal(r.status(),200);return route.abort('failed');}return route.continue();};await page.route('**/api/upgrades/direct/'+job.id+'/complete',lost);
 await dialog().getByRole('button',{name:'登记完成并转入新版本',exact:true}).click();await dialog().getByRole('button',{name:'重试确认',exact:true}).waitFor();assert(await source(pendingLine.id).isDisabled());
 await dialog().getByRole('button',{name:'关闭弹窗',exact:true}).click();await task(job.id).getByRole('button',{name:/收起批次明细/}).click();await page.getByLabel('筛选型号',{exact:true}).selectOption('DIRECT-UI-B');await page.locator('.direct-pending').getByRole('button',{name:'重试确认',exact:true}).click();assert.equal(await dialog().locator('input[type=radio]:checked').inputValue(),String(pendingLine.id));await dialog().getByRole('button',{name:'重试确认',exact:true}).click();await dialog().waitFor({state:'detached'});assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.equal(db.upgradeRecord(job.id).lines.find(l=>l.id===pendingLine.id).completedQuantity,17);await page.unroute('**/api/upgrades/direct/'+job.id+'/complete',lost);
 check('已保存回执丢失后关闭、折叠、筛选隐藏仍可确认；原参数原请求重放一次记账');
 await page.getByLabel('筛选型号',{exact:true}).selectOption('');await openComplete(b.id);await fill(b.lines[0],9,'V10',warehouseB);
 const lostLast=async route=>{const r=await route.fetch();assert.equal(r.status(),200);await route.abort('failed');};await page.route('**/api/upgrades/direct/'+b.id+'/complete',lostLast);await dialog().getByRole('button',{name:'登记完成并转入新版本',exact:true}).click();await dialog().getByRole('button',{name:'重试确认',exact:true}).waitFor();const saved=await page.evaluate(()=>sessionStorage.getItem('aster-pending-business-requests'));await page.unroute('**/api/upgrades/direct/'+b.id+'/complete',lostLast);await page.reload();await page.getByLabel('切换当前操作角色',{exact:true}).selectOption('purchasing');await page.getByRole('button',{name:'确认本次提交',exact:true}).waitFor();await page.getByRole('button',{name:'确认本次提交',exact:true}).click();await page.getByText(/原提交结果已确认/).waitFor();assert.equal(db.upgradeRecord(b.id).completedQuantity,9);assert.equal(await page.evaluate(()=>sessionStorage.getItem('aster-pending-business-requests')),null);assert(JSON.parse(saved)[0].requestId);
 check('最后一批完成但回执丢失，整页刷新后原有全局确认入口恢复，仍只记账一次');
 await nav('admin');await page.getByRole('button',{name:'发起在库升级',exact:true}).click();await page.getByLabel('发起型号',{exact:true}).selectOption('DIRECT-UI-C');await page.getByLabel('发起原版本',{exact:true}).selectOption('V2');
 const lostStart=async route=>{const r=await route.fetch();assert.equal(r.status(),200);await route.abort('failed');};await page.route('**/api/upgrades/direct',lostStart);await dialog().getByRole('button',{name:/锁定全部 8 件/}).click();await dialog().getByRole('button',{name:'重试确认',exact:true}).waitFor();await page.unroute('**/api/upgrades/direct',lostStart);await dialog().getByRole('button',{name:'关闭弹窗',exact:true}).click();await page.getByLabel('筛选型号',{exact:true}).selectOption('DIRECT-UI-B');await page.locator('.direct-pending').getByRole('button',{name:'重试确认',exact:true}).click();assert.equal(await page.getByLabel('发起型号',{exact:true}).inputValue(),'DIRECT-UI-C');assert(await page.getByLabel('发起型号',{exact:true}).isDisabled());await dialog().getByRole('button',{name:'重试确认',exact:true}).click();await dialog().waitFor({state:'detached'});assert.equal(db.getUpgrades().filter(j=>j.kind==='direct'&&j.model==='DIRECT-UI-C'&&j.sourceVersion==='V2').length,1);
 check('发起结果待确认时关闭弹窗和筛选不改变原型号版本，重新确认仅一条任务');
 const inkSource=db.getDirectUpgradeSources().find(source=>source.category==='墨盒'&&source.available>1);assert(inkSource);const inkJob=await startJob(inkSource.model,inkSource.sourceVersion);
 await api('/api/upgrades/direct/'+inkJob.id+'/complete',{sourceLineId:inkJob.lines[0].id,completedQuantity:1,newVersion:'V-PERM',targetWarehouse:warehouseA,expectedRevision:inkJob.revision,requestId:rid()},'purchasing');
 const permissionsPath=path.join(state,'data/permissions.json'),permissionRoles=['admin','operation-1','operation-2','assistant-1','assistant-2','purchasing','logistics','business','alan'];await fs.writeFile(permissionsPath,JSON.stringify({墨盒:Object.fromEntries(permissionRoles.map(role=>[role,{summary:true,detail:true,expand:true,actions:!['purchasing','logistics'].includes(role)}]))}));await page.reload();await nav('logistics');assert.equal(await task(inkJob.id).count(),1);assert.equal(await task(inkJob.id).getByRole('button',{name:'登记完成',exact:true}).count(),0);await page.getByRole('button',{name:'发起在库升级',exact:true}).click();await page.getByLabel('发起型号',{exact:true}).selectOption(inkSource.model);await page.getByLabel('发起原版本',{exact:true}).selectOption('V-PERM');assert(await dialog().getByRole('button',{name:/锁定全部 1 件/}).isDisabled());await dialog().getByRole('button',{name:'关闭弹窗',exact:true}).click();await fs.writeFile(permissionsPath,JSON.stringify({墨盒:Object.fromEntries(permissionRoles.map(role=>[role,{summary:true,detail:true,expand:true,actions:true}]))}));
 check('类目操作权限关闭时记录仍可查看，完成入口隐藏，发起提交禁止');
 db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.deepEqual(errors,[]);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM lingxing_sync_jobs').get().n,0);assert.equal(db.db.prepare("SELECT SUM(on_hand_delta) n FROM upgrade_inventory_ledger WHERE source_type='direct_line'").get().n,0);
 check('库存不变量、外键、直接升级流水净变化均正确；无真实领星请求');
}catch(error){failure=error;console.error(error);if(page)await shot('failure').catch(()=>{});}
finally{await browser?.close();db.close();if(child?.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}await fs.writeFile(path.join(out,'result.json'),JSON.stringify({state,base,checks,screenshots,errors,requests,exitCode:failure?1:0,failure:failure?.stack,productionWrites:0,realLingxing:false},null,2));}
if(failure)process.exitCode=1;
