// Requirement13.1: actual Edge UI + owned fresh SQLite. No production, plugin, or ERP use.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright-core';
import {createInventoryDatabase,InventoryDatabase} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const out=path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/zero-available-allocation-page'));
assert(process.env.ASTER_WEB_DIST,'Explicit isolated ASTER_WEB_DIST required');
await fs.mkdir(out,{recursive:true});
const state=await fs.mkdtemp(path.join(out,'state-')),accounts=path.join(state,'synthetic-accounts.json');
await fs.writeFile(accounts,JSON.stringify({accounts:[{account:'AUS',shortName:'SYNTH',room:'R001',sourceCell:'synthetic'}]}));
process.env.ASTER_OVERSEAS_WAREHOUSES='SyntheticWarehouseA;SyntheticWarehouseB';
process.env.ASTER_WAREHOUSE_ACCOUNTS=accounts;
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID(),common=r=>({expectedRevision:r.revision,requestId:rid()});
const port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('zero-available-page');
const prompt='该批次已有预锁定，目前可用件数0，是否仍继续提交调拨需求，参与分配？';
const success='调拨需求已提交，未新增预锁定，等待商务分配。';
const statusText='待商务分配（未预锁）';
const startedAt=new Date().toISOString(),checks=[],requests=[],responses=[],errors=[],screenshots=[],comparisons=[];
let child,browser,page,failure,serial=0,serverLog='';const serviceStarts=[],serviceStops=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){let last;for(let n=0;n<100;n++){try{return await fn();}catch(e){last=e;await pause(75);}}throw last;}
const check=(name,detail={})=>{checks.push({name,...detail});console.log('PASS '+name);};
const json=(name,value)=>fs.writeFile(path.join(out,name+'.json'),JSON.stringify(value,null,2));
const record=id=>db.getDocument(typeof id==='number'?id:id.id);
const lock=id=>db.db.prepare('SELECT coalesce(sum(locked_delta),0) AS n FROM inventory_ledger WHERE document_id=?').get(typeof id==='number'?id:id.id).n;
const balance=batch=>{const b=db.getBalance(batch.batchKey);return {onHand:b.onHand,locked:b.locked,available:b.onHand-b.locked};};
const snapshot=()=>Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('system_meta','transit_preview_tokens') ORDER BY name").all().map(({name})=>[name,db.db.prepare('SELECT * FROM "'+name+'"').all()]));
function unchanged(name,before){const after=snapshot();assert.deepEqual(after,before,name);comparisons.push({name,before,after});}
function assertWaiting(r){const current=record(r);assert.equal(current.zeroAvailableConfirmed,true);assert.equal(current.lockedQuantity,0);assert.equal(lock(r),0);assert.equal(current.statusText,statusText);assert.equal(current.approvalStatus,'pending');return current;}
function seed(category,suffix,{quantity=100,pack=10,model,fnsku,warehouse='SyntheticWarehouseA'}={}){
 model??=`ZERO-${category==='墨盒'?'INK':'TONER'}-${suffix}`;fnsku??=`SOURCE-${++serial}`;
 const rows=[{sourceRow:2,data:{model,quantity,packPerBox:String(pack),fnsku,shippingMethod:warehouse,plan:'ZERO-SAME-PLAN',date:'2026-10-19',team:'一团',version:'V1'}}];
 const proof={kind:'import',role:'admin',fileName:`synthetic-${suffix}-${category}.csv`,fileHash:`synthetic-file-${rid()}`,templateHash:'synthetic-template',payload:{rows}};
 const t=db.transitImport({...proof,rows,previewToken:db.createTransitPreviewToken(proof).token,requestId:rid()}).rows[0];
 const shelf=db.markTransitOnShelf({id:t.id,role:'assistant-1',yes:'YES',...common(t)});
 const batch=db.getCatalog().stockDetails[model].find(b=>b.batchKey===shelf.batchKey);assert(batch);return {...batch,model,category};
}
async function api(route,body,role='admin',expected=200){
 const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const value=await response.json();responses.push({source:'fixture/api',path:route,status:response.status,body:value});assert.equal(response.status,expected,JSON.stringify(value));return value;
}
async function create(batch,quantity,{zero=false,operator,role='operation-1',department='一团'}={}){
 return(await api('/api/allocations',{model:batch.model,sourceBatchKey:batch.batchKey,plan:batch.plan,date:batch.date,version:batch.version,quantity,department,store:'AUS',operator:operator||`fixture-${rid()}`,fnsku:'DEST-ZERO',asin:'BZERO001',requestId:rid(),...(zero?{zeroAvailableConfirmed:true}:{})},role)).record;
}
async function review(r,quantity,decision='approve',expected=200){r=record(r);return api(`/api/allocations/${r.id}/review`,{decision,approvedQuantity:quantity,businessNote:'合成分配',...common(r)},'business',expected);}
async function alan(r,quantity,expected=200){r=record(r);return api(`/api/allocations/${r.id}/alan-review`,{alanQuantity:quantity,alanNote:'合成Alan',...common(r)},'alan',expected);}
async function issue(r){r=record(r);return api(`/api/allocations/${r.id}/confirm`,common(r),r.department==='一团'?'assistant-1':'assistant-2');}
async function newPage(){const p=await browser.newPage({viewport:{width:1500,height:1080}});p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));
 p.on('request',r=>{if(r.url().startsWith(base+'/api/')&&r.method()==='POST')requests.push({source:'browser',url:r.url(),path:new URL(r.url()).pathname,role:r.headers()['x-role'],body:r.headers()['content-type']?.includes('application/json')?r.postDataJSON():r.postData()});});
 // Forward the real server response unchanged; keep bytes before Edge inspector cache eviction.
 await p.route('**/api/**',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch(),bytes=await response.body();let body;try{body=JSON.parse(bytes.toString());}catch{body=bytes.toString();}responses.push({source:'browser',url:route.request().url(),path:new URL(route.request().url()).pathname,status:response.status(),body});await route.fulfill({response,body:bytes});});
 return p;
}
async function shot(name,p=page){const file=path.join(out,name+'.png');await p.screenshot({path:file,fullPage:!await p.getByRole('dialog').count(),animations:'disabled'});screenshots.push(file);assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
async function openBatch(batch,role='operation-1',p=page){
 await p.goto(base+'/?q='+encodeURIComponent(batch.model)+'&model='+encodeURIComponent(batch.model));await p.getByLabel('切换当前操作角色',{exact:true}).selectOption(role);
 const summary=p.locator('.inventory-summary-row').filter({has:p.getByText(batch.model,{exact:true})});await summary.waitFor();if(!await p.locator('.detail-stock-table').count())await summary.click();
 const row=p.locator('.detail-stock-table > tbody > tr').filter({has:p.getByText(batch.fnsku,{exact:true})}).filter({has:p.locator('.alloc-toggle')});
 await row.locator('.alloc-toggle').click();const form=p.locator('.allocation-panel');await form.waitFor();await until(async()=>assert.equal(await form.getByLabel('调拨数量',{exact:true}).isDisabled(),false));return form;
}
async function fill(form,quantity,operator='零可用页面运营'){
 for(const[label,value]of [['调拨数量',String(quantity)],['调拨店铺','AUS'],['调拨运营',operator],['已贴 FNSKU','DEST-ZERO'],['ASIN（必填）','BZERO001'],['运营备注（选填）','否和关闭均保留此稿']])await form.getByLabel(label,{exact:true}).fill(value);
}
const entryButton=form=>form.getByRole('button',{name:'提交调拨并预锁定',exact:true});
const confirm=p=>p.getByRole('dialog',{name:'继续提交调拨需求',exact:true});
async function ask(form,p=page){await entryButton(form).click();await confirm(p).waitFor();assert.equal(await confirm(p).getByText(prompt,{exact:true}).count(),1);return confirm(p);}
async function clickWrite(route,action,status=200,p=page){const pending=p.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===route);await action();const response=await pending;assert.equal(response.status(),status);return responses.findLast(r=>r.source==='browser'&&r.url===response.url())?.body;}
async function yes(form,{double=false,p=page}={}){const modal=await ask(form,p);return clickWrite('/api/allocations',()=>double?modal.getByRole('button',{name:'是',exact:true}).dblclick():modal.getByRole('button',{name:'是',exact:true}).click(),200,p);}
async function openApprovals(role,search,p=page){
 await p.getByLabel('切换当前操作角色',{exact:true}).selectOption(role);await p.locator('.sidebar .nav-item',{hasText:'审批中心'}).click();
 const mine=p.getByRole('button',{name:role.startsWith('operation-')?/^处理中/:/^我的待办/});if(await mine.getAttribute('aria-pressed')==='true')await mine.click();
 await p.getByLabel('搜索编号、型号、运营或 ASIN',{exact:true}).fill(search);await p.getByRole('button',{name:'刷新',exact:true}).click();
 await p.waitForLoadState('networkidle');while(await p.locator('.approval-model-row[aria-expanded="false"]').count())await p.locator('.approval-model-row[aria-expanded="false"]').first().click();
}
const card=(r,p=page)=>p.locator(`[data-document-key="allocation-${r.id}"]`);
async function uiReview(r,quantity,{expected=200,p=page,decision='approve'}={}){
 await openApprovals('business',r.model,p);if(quantity!==null)await card(r,p).getByLabel('审核数量',{exact:true}).fill(String(quantity));
 return clickWrite(`/api/allocations/${r.id}/review`,()=>card(r,p).getByRole('button',{name:decision==='reject'?'拒绝':'批准',exact:true}).click(),expected,p);
}
async function uiZero(batch,quantity,label){const form=await openBatch(batch);await fill(form,quantity,label);return(await yes(form)).record;}
async function startServer(){child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ASTER_STATE_ROOT:state,ASTER_WAREHOUSE_ACCOUNTS:accounts,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});child.stdout.on('data',d=>serverLog+=d);child.stderr.on('data',d=>serverLog+=d);await waitForOwnedServer({base,child,instanceId});serviceStarts.push({pid:child.pid,at:new Date().toISOString()});await json('environment',{base,state,instanceId,serviceStarts,dist:process.env.ASTER_WEB_DIST});}
async function stopServer(){
 if(!child)return;
 let code=child.exitCode,signal=child.signalCode;
 if(code===null&&signal===null){const stopped=once(child,'exit');child.kill();[code,signal]=await stopped;}
 const portClosed=await new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',error=>error.code==='ECONNREFUSED'?resolve(true):reject(error));});
 serviceStops.push({pid:child.pid,at:new Date().toISOString(),exitCode:code,signalCode:signal,portClosed});
 await json('service-stops',serviceStops);assert(portClosed,'Owned test server port still accepts connections after exit');
}
try{
 await startServer();browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 for(const category of ['硒鼓','墨盒']){
  const who=category==='硒鼓'?'operation-2':'operation-1',team=who==='operation-2'?'二团':'一团';
  // A zero-available batch must remain eligible even if another batch of the model is available.
  const source=seed(category,'BASIC'),other=seed(category,'OTHER',{model:source.model,quantity:80,pack:20,warehouse:'SyntheticWarehouseB'}),original=await create(source,100);
  page=await newPage();let form=await openBatch(source,who);await fill(form,30,category+'零可用需求');
  await form.getByLabel('调拨数量',{exact:true}).fill('120');assert(await entryButton(form).isDisabled());await form.getByLabel('调拨数量',{exact:true}).fill('35');assert(await entryButton(form).isDisabled());await form.getByLabel('调拨数量',{exact:true}).fill('30');
  const before=snapshot(),postCount=requests.length;let modal=await ask(form);await shot(category+'-00-explicit-confirmation');await modal.getByRole('button',{name:'否',exact:true}).click();await modal.waitFor({state:'detached'});assert.equal(await form.getByLabel('调拨数量',{exact:true}).inputValue(),'30');assert.equal(await form.getByLabel('运营备注（选填）',{exact:true}).inputValue(),'否和关闭均保留此稿');assert.equal(requests.length,postCount);unchanged(category+' 否不写',before);
  modal=await ask(form);await modal.getByRole('button',{name:'关闭弹窗',exact:true}).click();await modal.waitFor({state:'detached'});assert.equal(await form.getByLabel('调拨数量',{exact:true}).inputValue(),'30');assert.equal(requests.length,postCount);unchanged(category+' 关闭不写',before);await shot(category+'-01-close-preserves-draft');
  check(category+'：同批0可用可打开；其他批次80可用不掩盖；整箱/本批在库上限；否/关闭0POST并保稿');
  const receipt=await yes(form,{double:true}),demand=receipt.record;await form.getByRole('status').filter({hasText:success}).waitFor();assert.equal(await form.getByRole('status').innerText(),source.model+' · '+source.plan+'：'+success);assertWaiting(demand);assert.equal(demand.department,team);assert.equal(demand.batchKey,source.batchKey);assert.deepEqual(balance(source),{onHand:100,locked:100,available:0});assert.deepEqual(balance(other),{onHand:80,locked:0,available:80});
  const createdPosts=requests.slice(postCount).filter(r=>r.path==='/api/allocations');assert.equal(createdPosts.length,1);assert.equal(createdPosts[0].body.zeroAvailableConfirmed,true);assert.equal(createdPosts[0].body.quantity,30);
  await openApprovals(who,source.model);assert((await card(demand).innerText()).includes(statusText));assert.equal(await card(demand).locator('[data-field="当前调拨占用"]').innerText(),'0');await shot(category+'-02-demand-zero-lock');
  check(category+'：是/双击只建一笔真实0锁调拨，文案与占用0正确，同型号另一批次不变',{id:demand.id,batchKey:source.batchKey});
  await openApprovals('business',source.model);const sourceHint=await card(demand).locator('[data-field="来源批次"]').innerText();assert.equal(sourceHint,'来源批次：'+[source.plan,source.date,source.version].filter(Boolean).join(' · '));assert(!sourceHint.includes(source.batchKey));const beforeFail=snapshot();await uiReview(demand,30,{expected:409});unchanged(category+' 未释放旧单锁前审批失败',beforeFail);assertWaiting(demand);assert.equal(lock(original),100);
  await uiReview(original,70);assert.equal(lock(original),70);assert.equal(balance(source).available,30);await uiReview(demand,30);assert.equal(lock(demand),30);assert.equal(lock(original),70);assert.equal(balance(source).locked,100);
  check(category+'：先批新需求不抢原锁；原单先减100→70只释放30，再逐单批准新30');
  if(category==='墨盒'){
   const beforeAlan=snapshot();await alan(demand,40,409);unchanged('Alan无实时可用不能加10',beforeAlan);await alan(original,60);await alan(demand,40);assert.equal(lock(original),60);assert.equal(lock(demand),40);
   await openApprovals('assistant-1',source.model);await card(demand).getByRole('button',{name:'确认全部发出',exact:true}).click();await clickWrite(`/api/allocations/${demand.id}/confirm`,()=>page.getByRole('dialog').getByRole('button',{name:'确认全部发出',exact:true}).click());assert.equal(balance(source).onHand,60);assert.equal(balance(source).locked,60);
   check('墨盒：Alan只有实时空余才可30→40；释放原单10后加量成功，助理实际发40');
  }else{
   await openApprovals('assistant-2',source.model);await card(demand).getByRole('button',{name:'确认全部发出',exact:true}).click();await clickWrite(`/api/allocations/${demand.id}/confirm`,()=>page.getByRole('dialog').getByRole('button',{name:'确认全部发出',exact:true}).click());assert.equal(balance(source).onHand,70);assert.equal(balance(source).locked,70);
   check('硒鼓：二团新需求批准后仍由二团助理实际发30，原单70锁不动');
  }
  assert.deepEqual(balance(other),{onHand:80,locked:0,available:80});db.assertInventoryInvariants();await page.close();

  // Real commit, dropped receipt, reload, and explicit same-body replay for both categories.
  const lostSource=seed(category,'LOST');await create(lostSource,100);page=await newPage();form=await openBatch(lostSource);await fill(form,40,category+'丢回执');const sent=[];let drop=true;
  await page.route('**/api/allocations',async route=>{if(route.request().method()!=='POST')return route.fallback();sent.push(route.request().postDataJSON());const response=await route.fetch();assert.equal(response.status(),200);if(drop){drop=false;return route.abort('failed');}return route.fulfill({response});});
  modal=await ask(form);await modal.getByRole('button',{name:'是',exact:true}).click();await form.getByRole('button',{name:'请重试确认',exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await form.getByLabel('调拨数量',{exact:true}).isDisabled(),true);
  const lost=db.db.prepare('SELECT id FROM allocation_documents WHERE operator_name=?').get(category+'丢回执');assert(lost);assertWaiting(lost);const committed=snapshot();await page.reload();await page.getByLabel('切换当前操作角色',{exact:true}).selectOption('operation-1');const resume=page.getByRole('region',{name:'待确认业务提交'}).getByRole('button',{name:'确认本次提交',exact:true});await resume.waitFor();await resume.click();await page.getByText(/原提交结果已确认/).waitFor();assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.equal(sent[0].zeroAvailableConfirmed,true);unchanged(category+' 原键恢复不重复记账',committed);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM allocation_documents WHERE operator_name=?').get(category+'丢回执').n,1);await shot(category+'-03-recovered-original-request');
  check(category+'：实际0锁落库丢回执不重弹，刷新后原角色/原body/原键确认一次');await page.close();

  // Qualification is frozen as explicit demand intent, not silently converted to an ordinary reservation.
  for(const mode of ['available-positive','lock-gone','onhand-shrank']){
   const s=seed(category,mode),oldA=await create(s,mode==='onhand-shrank'?60:100);if(mode==='onhand-shrank')await create(s,40);
   page=await newPage();form=await openBatch(s);await fill(form,mode==='onhand-shrank'?50:30,category+mode);modal=await ask(form);
   if(mode==='available-positive')await review(oldA,70);
   else if(mode==='lock-gone')await review(oldA,100,'reject');
   else{await review(oldA,60);if(category==='墨盒')await alan(oldA,60);await issue(oldA);assert.deepEqual(balance(s),{onHand:40,locked:40,available:0});}
   const changed=snapshot();const response=await clickWrite('/api/allocations',()=>modal.getByRole('button',{name:'是',exact:true}).click(),409);assert.equal(response.code,'zero_available_condition_changed');unchanged(category+' '+mode+'不降级普通建单',changed);assert.equal(await form.getByLabel('调拨数量',{exact:true}).inputValue(),mode==='onhand-shrank'?'50':'30');assert.equal(db.db.prepare('SELECT COUNT(*) n FROM allocation_documents WHERE operator_name=?').get(category+mode).n,0);await shot(category+'-qualification-'+mode);
   check(category+'：确认期间'+mode+'返回409，无新单/无新锁并保留数量');await page.close();
  }

  // Reject / explicit conversion of zero-lock demands must never release another document's locks.
  const conversionSource=seed(category,'CONVERT'),owner=await create(conversionSource,100);page=await newPage();const rejected=await uiZero(conversionSource,30,category+'0锁拒绝');await uiReview(rejected,30,{decision:'reject'});assert.equal(lock(rejected),0);assert.equal(lock(owner),100);assert.equal(balance(conversionSource).locked,100);
  const converted=await uiZero(conversionSource,40,category+'0锁转询库');await openApprovals('business',converted.model);await card(converted).getByLabel('审核数量',{exact:true}).fill('25');await clickWrite(`/api/allocations/${converted.id}/transfer-inquiry`,()=>card(converted).getByRole('button',{name:'转询库',exact:true}).click());assert.equal(lock(converted),0);assert.equal(lock(owner),100);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM inquiry_documents WHERE source_allocation_id=?').get(converted.id).n,0);
  await openApprovals('operation-1',converted.model);await clickWrite(`/api/allocations/${converted.id}/conversion-decision`,()=>card(converted).getByRole('button',{name:'接受转询库',exact:true}).click());const inquiry=db.db.prepare('SELECT id FROM inquiry_documents WHERE source_allocation_id=?').get(converted.id);assert(inquiry);assert.equal(db.getInquiry(inquiry.id).quantity,25);assert.equal(balance(conversionSource).locked,100);
  check(category+'：0锁拒绝和商务转询库不释放原单100锁；运营接受后才建25询库');await page.close();

  // Two business users allocate live free stock transactionally: one wins, no other lock is stolen.
  const raceSource=seed(category,'RACE'),old=await create(raceSource,100),a=await create(raceSource,60,{zero:true,operator:category+'并发A'}),b=await create(raceSource,60,{zero:true,operator:category+'并发B'});await review(old,100,'reject');
  const left=await newPage(),right=await newPage();await left.goto(base);await right.goto(base);await openApprovals('business',raceSource.model,left);await openApprovals('business',raceSource.model,right);await card(a,left).getByLabel('审核数量',{exact:true}).fill('60');await card(b,right).getByLabel('审核数量',{exact:true}).fill('60');
  const waits=[left.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/allocations/${a.id}/review`),right.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/allocations/${b.id}/review`)];
  await Promise.all([card(a,left).getByRole('button',{name:'批准',exact:true}).click(),card(b,right).getByRole('button',{name:'批准',exact:true}).click()]);const receipts=await Promise.all(waits);assert.deepEqual(receipts.map(r=>r.status()).sort(),[200,409]);assert.equal(lock(a)+lock(b),60);assert.deepEqual(balance(raceSource),{onHand:100,locked:60,available:40});const loser=lock(a)===0?a:b;assertWaiting(loser);await shot(category+'-race-left',left);await shot(category+'-race-right',right);check(category+'：两个真实商务页面各批60，一笔成功一笔409；只锁60、失败单仍0锁');await left.close();await right.close();
 }
 // Preserve all upgrade locks, including a mixed allocation/upgrade batch.
 for(const category of ['硒鼓','墨盒'])for(const mixed of [false,true]){
  const s=seed(category,mixed?'MIXED-UPGRADE':'PURE-UPGRADE'),owner=mixed?await create(s,60):null;
  const upgrade=db.createDirectUpgrade({role:'admin',model:s.model,sourceVersion:'V1',requestId:rid()}).upgrade,upgradeLocked=balance(s).locked-(owner?60:0);assert.equal(upgradeLocked,mixed?40:100);
  page=await newPage();const demand=await uiZero(s,20,mixed?'混合升级锁需求':'纯升级锁需求');assertWaiting(demand);const before=snapshot();await uiReview(demand,20,{expected:409});unchanged('升级锁不回收给0锁需求',before);
  if(owner){await review(owner,40);await uiReview(demand,20);assert.equal(lock(owner),40);assert.equal(lock(demand),20);assert.equal(balance(s).locked,100);assert.equal(db.upgradeRecord(upgrade.id).lines.reduce((sum,line)=>sum+line.inProgressQuantity,0),40);}
  else{await uiReview(demand,20,{decision:'reject'});assert.equal(balance(s).locked,100);}
  check(category+(mixed?'混合':'纯')+'升级锁可登记0锁需求，但审批不抢升级锁；仅原调拨明确释放后可分配');await page.close();
 }
 // New ink zero-lock demand retains the natural five-hour timeout without issuing goods.
 const timed=seed('墨盒','TIMEOUT'),old=await create(timed,100),demand=await create(timed,30,{zero:true,operator:'零锁5h'});await review(old,70);await review(demand,30);const current=record(demand);assert(current.alanDeadlineAt);db.db.prepare('UPDATE allocation_documents SET alan_deadline_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),demand.id);const beforeOnHand=balance(timed).onHand;
 // The service owns a pre-scheduled deadline timer: changing synthetic SQL while it runs cannot reschedule it.
 // Restart ONLY this owned test service so startup reads the persisted due deadline, like the existing v37 fixture.
 await stopServer();await startServer();page=await newPage();await page.goto(base);await openApprovals('assistant-1',timed.model);await until(()=>assert.equal(record(demand).inkWorkflowStage,'pending_assistant'));assert.equal(record(demand).alanQuantity,null);assert.equal(lock(demand),30);assert.equal(balance(timed).onHand,beforeOnHand);assert.equal(await card(demand).getByRole('button',{name:'确认全部发出',exact:true}).count(),1);await shot('ink-natural-5h-no-auto-issue');check('墨盒新需求批准后连续自然5h采用商务30，锁30不变且不自动发出；自有服务重启持久化');await page.close();
 db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(errors,[]);
 await json('database-final',{balances:db.db.prepare('SELECT * FROM stock_balances').all(),allocations:db.db.prepare('SELECT * FROM allocation_documents').all(),inventoryLedger:db.db.prepare('SELECT * FROM inventory_ledger').all(),upgradeLedger:db.db.prepare('SELECT * FROM upgrade_inventory_ledger').all(),events:db.db.prepare('SELECT * FROM document_events').all()});await json('owned-service-log',{text:serverLog});
 check('全部场景库存/外键/数据库一致，无浏览器异常、正式操作或真实ERP');
}catch(error){failure=error.stack;console.error(failure);await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{
 await browser?.close();await stopServer();db.close();
  await json('requests',requests);await json('responses',responses);await json('database-comparisons',comparisons);await json('result',{startedFor:'requirement13.1',startedAt,finishedAt:new Date().toISOString(),root,out,state,base,instanceId,serverPid:child?.pid,serverStopped:serviceStops.some(stop=>stop.pid===child?.pid&&stop.portClosed),serviceStops,node:{version:process.version,execPath:process.execPath},dist:process.env.ASTER_WEB_DIST,checks,errors,screenshots,failure,exitCode:failure?1:0,productionWrites:0,realERP:false});
}
