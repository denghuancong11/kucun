// Real Edge fault injection against the current workspace and an explicit candidate build.
// Only owned synthetic databases/configuration/ports are used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {chromium} from '../node_modules/playwright-core/index.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'../..');
assert.ok(process.env.ASTER_WEB_DIST,'必须显式指定本轮候选前端');
const dist=path.resolve(process.env.ASTER_WEB_DIST);await fs.access(path.join(dist,'index.html'));
const parent=path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/transit-global-recovery'));
await fs.mkdir(parent,{recursive:true});const out=await fs.mkdtemp(path.join(parent,'run-'));
process.env.ASTER_RUNTIME_CONFIG=path.join(out,'runtime.synthetic.json');
process.env.ASTER_WAREHOUSE_ACCOUNTS=path.join(out,'accounts.synthetic.json');
process.env.ASTER_OVERSEAS_WAREHOUSES='SyntheticWarehouseA;SyntheticWarehouseB';
await fs.writeFile(process.env.ASTER_RUNTIME_CONFIG,JSON.stringify({schemaVersion:1,overseasWarehouses:['SyntheticWarehouseA','SyntheticWarehouseB']}));
await fs.writeFile(process.env.ASTER_WAREHOUSE_ACCOUNTS,JSON.stringify({accounts:[{account:'AUS',shortName:'SYNTH',room:'TEST-101'}]}));
const {createInventoryDatabase,InventoryDatabase}=await import(pathToFileURL(path.join(root,'inventory-db.mjs')));
const state=path.join(out,'state-a'),stateB=path.join(out,'state-b');
for(const s of [state,stateB])createInventoryDatabase({databasePath:path.join(s,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),dbB=new InventoryDatabase(stateB);
const port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('transit-global-recovery');
const checks=[],requests=[],lost=[],screenshots=[],errors=[],receipts=[];let server,browser,page,failure,logs='';
const rid=()=>crypto.randomUUID();
const check=(name,detail={})=>{checks.push({name,...detail});console.log('PASS '+name);};
async function wait(fn){let error;for(let end=Date.now()+12000;Date.now()<end;){try{return await fn();}catch(e){error=e;}await new Promise(r=>setTimeout(r,100));}throw error;}
async function start(s){server=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ASTER_STATE_ROOT:s,ASTER_WEB_DIST:dist,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});server.stdout.on('data',x=>logs+=x);server.stderr.on('data',x=>logs+=x);await waitForOwnedServer({base,child:server,instanceId});}
async function stop(){if(server?.exitCode===null&&server?.signalCode===null){const exited=once(server,'exit');server.kill();await exited;}}
async function api(route,role='assistant-1',body){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'x-role':role,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;}
const headers='ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号';
async function file(label,plan,quantity=40,team='一团三部',newline=''){const f=path.join(out,label+'硒鼓.csv');await fs.writeFile(f,headers+`\nRECOVERY-STOCK,${quantity},5,000RECOVERY,SyntheticWarehouseA,${plan},2026-10-21,${team},V1`+newline);return f;}
async function previewFile(f,role='assistant-1'){const r=await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':role,'x-file-name':encodeURIComponent(path.basename(f))},body:await fs.readFile(f)});const p=await r.json();assert.equal(r.status,200);assert.equal(p.validation.canImport,true,JSON.stringify(p));return p;}
const payload=p=>({previewToken:p.previewToken,fileName:p.fileName,fileHash:p.fileSha256,templateHash:p.templateSha256,rows:p.rows,requestId:rid()});
async function seed(f){return api('/api/transit/import','assistant-1',payload(await previewFile(f)));}
async function role(value){await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(value);}
async function nav(view='在途库存',value='assistant-1'){await role(value);await page.locator('.sidebar .nav-item',{hasText:view}).click();if(view==='在途库存')await wait(async()=>assert.equal(await page.locator('#transit-import-file').count(),1));}
const importCount=plan=>Number(db.db.prepare('SELECT COUNT(*) n FROM transit_batches WHERE plan=?').get(plan).n);
const quantity=plan=>Number(db.db.prepare('SELECT COALESCE(SUM(remaining_quantity),0) n FROM transit_batches WHERE plan=?').get(plan).n);
const statusEvents=id=>Number(db.db.prepare("SELECT COUNT(*) n FROM transit_events WHERE transit_id=? AND event_type='status_updated'").get(id).n);
async function shot(name){const target=path.join(out,name+'.png');await page.screenshot({path:target,fullPage:true,animations:'disabled'});screenshots.push(target);}
async function uploadsReady(){await wait(async()=>{assert.equal(await page.locator('#transit-import-file').isDisabled(),false);assert.equal(await page.locator('#transit-status-file').isDisabled(),false);});}
async function draft(value='assistant-1'){return page.evaluate(value=>{const raw=sessionStorage.getItem('aster-draft:'+value+':transit-preview');return raw?JSON.parse(raw):null;},value);}
async function upload(f,kind='import'){await uploadsReady();await page.locator(kind==='import'?'#transit-import-file':'#transit-status-file').setInputFiles(f);const button=page.getByRole('button',{name:kind==='import'?'确认导入在途库存':'确认更新物流状态',exact:true});await wait(async()=>assert.equal(await button.isEnabled(),true));return button;}
async function lose(f,kind='import'){const url=kind==='import'?'/api/transit/import':'/api/transit/status/apply';const button=await upload(f,kind);let captured;await page.route('**'+url,async route=>{const response=await route.fetch();const data=await response.json();assert.equal(response.status(),200,JSON.stringify(data));captured={url,role:route.request().headers()['x-role'],body:route.request().postDataJSON(),data};lost.push(captured);await route.abort('failed');},{times:1});await button.click();await page.getByRole('button',{name:'请重试确认',exact:true}).waitFor();assert.ok(captured);assert.equal(await page.locator('#transit-import-file').isDisabled(),true);return captured;}
async function confirmGlobal(original){const waitResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===original.url);const button=page.getByRole('button',{name:'确认本次提交',exact:true});await wait(async()=>assert.equal(await button.isEnabled(),true));await button.click();const response=await waitResponse,data=await response.json();assert.equal(response.status(),200,JSON.stringify(data));assert.equal(data.deduped,true);assert.deepEqual(response.request().postDataJSON(),original.body);receipts.push({url:original.url,body:response.request().postDataJSON(),data});await wait(async()=>assert.ok((await page.locator('.pending-business').innerText()).includes('原提交结果已确认')));}

try{
 await start(state);const health=await api('/api/health');assert.equal(health.schemaVersion,38);assert.equal(health.build.consistent,true);
 const initial=await seed(await file('初始物流','GLOBAL-STATUS',30));const transitId=initial.rows[0].id;
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});page=await browser.newPage({viewport:{width:1500,height:1050}});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.headers()['content-type']?.includes('application/json'))requests.push({url:new URL(r.url()).pathname,role:r.headers()['x-role'],body:r.postDataJSON()});});
 await page.goto(base);await nav();
 const statusFile=path.join(out,'物流已到港.csv');await fs.writeFile(statusFile,'计划号,物流状态\nGLOBAL-STATUS,已到港');
 const s=await lose(statusFile,'status');assert.equal(statusEvents(transitId),1);assert.equal(db.getTransit(transitId).logistics_status,'已到港');await shot('01-status-lost');
 await page.reload();await nav();assert.equal((await draft()).value.uncertainStatus,true);await confirmGlobal(s);await uploadsReady();assert.equal(await page.locator('.transit-status-preview').count(),0);const settled=await draft();assert.equal(settled.value.uncertainStatus,false);assert.equal(settled.value.statusRequest,null);assert.equal(statusEvents(transitId),1);await shot('02-status-global-confirmed');
 check('原物流路径：落库丢回执→刷新原岗位→顶部同键确认，一次物流事件，局部预览清除且两上传立即可用',{requestId:s.body.requestId});
 await fs.writeFile(statusFile,'计划号,物流状态\nGLOBAL-STATUS,待派送');await(await upload(statusFile,'status')).click();await uploadsReady();await wait(()=>assert.equal(db.getTransit(transitId).logistics_status,'待派送'));assert.equal(statusEvents(transitId),2);check('全局确认后可正常上传下一份物流文件，不需要局部再确认');

 const a=await lose(await file('真实新增40第一笔','GLOBAL-IMPORT',40));assert.equal(quantity('GLOBAL-IMPORT'),40);await nav('库存汇总');await confirmGlobal(a);assert.equal((await draft()).value.uncertainImport,false);assert.equal((await draft()).value.preview,null);await nav();await uploadsReady();assert.equal(await page.locator('.transit-import-preview').count(),0);assert.equal(importCount('GLOBAL-IMPORT'),1);await shot('03-import-cross-page-confirmed');
 await(await upload(await file('真实新增40第二笔','GLOBAL-IMPORT',40,'一团三部','\r\n'))).click();await uploadsReady();await wait(()=>assert.equal(quantity('GLOBAL-IMPORT'),80));assert.equal(importCount('GLOBAL-IMPORT'),1);check('普通导入丢回执→切库存汇总全局确认，返回无旧预览；下一次真实新增40正常累计80',{requestId:a.body.requestId});

 const local=await lose(await file('局部重试10','LOCAL-IMPORT',10));const localResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===local.url);await page.getByRole('button',{name:'请重试确认',exact:true}).click();const lr=await localResponse;assert.equal((await lr.json()).deduped,true);assert.deepEqual(lr.request().postDataJSON(),local.body);await uploadsReady();assert.equal(quantity('LOCAL-IMPORT'),10);check('既有普通导入局部重试保留原body/键，一次10入账且上传恢复');

 // Role isolation: keep a real unsubmitted preview for team two, then recover team one's request.
 await nav('在途库存','assistant-2');await upload(await file('二团待提交','ROLE-TWO',30,'二团'));const roleTwoRaw=await page.evaluate(()=>sessionStorage.getItem('aster-draft:assistant-2:transit-preview'));
 await nav();const isolated=await lose(await file('跨角色恢复15','ROLE-ONE',15));await page.reload();await nav('在途库存','assistant-2');assert.equal(await page.getByRole('button',{name:'确认本次提交',exact:true}).count(),0);assert.equal((await draft()).value.uncertainImport,true);assert.equal(await page.evaluate(()=>sessionStorage.getItem('aster-draft:assistant-2:transit-preview')),roleTwoRaw);
 await nav();await confirmGlobal(isolated);await uploadsReady();assert.equal(await page.evaluate(()=>sessionStorage.getItem('aster-draft:assistant-2:transit-preview')),roleTwoRaw);assert.equal(quantity('ROLE-ONE'),15);check('换岗不代确认、不清其他岗位真实预览；返回原岗位确认后仅结算原草稿');

 // A real later preview replaces the synthetic retained draft before old receipt consumption.
 const old=await lose(await file('旧提交20','NEW-DRAFT-OLD',20));const newerFile=await file('后来编辑的新预览','NEW-DRAFT-NEW',25),newer=await previewFile(newerFile);
 await page.evaluate(({newer})=>{const key='aster-draft:assistant-1:transit-preview',saved=JSON.parse(sessionStorage.getItem(key));saved.value={...saved.value,preview:newer,importRequest:null,uncertainImport:false,importFileName:newer.fileName};sessionStorage.setItem(key,JSON.stringify(saved));},{newer});
 await page.reload();await nav();const newerRaw=await page.evaluate(()=>sessionStorage.getItem('aster-draft:assistant-1:transit-preview'));await confirmGlobal(old);assert.equal(await page.evaluate(()=>sessionStorage.getItem('aster-draft:assistant-1:transit-preview')),newerRaw);assert.equal((await draft()).value.preview.previewToken,newer.previewToken);await uploadsReady();assert.ok((await page.locator('.transit-import-preview').innerText()).includes(newer.fileName));await shot('04-newer-preview-preserved');await page.getByRole('button',{name:'确认导入在途库存',exact:true}).click();await uploadsReady();await wait(()=>assert.equal(quantity('NEW-DRAFT-NEW'),25));assert.equal(quantity('NEW-DRAFT-OLD'),20);check('真实新预览替换合成保留草稿前提：旧成功确认不清后来编辑内容，新预览仍可一次入账');

 // Original-database guard: own service is switched to another empty synthetic database at the same origin.
 const otherDb=await lose(await file('跨数据库10','DB-ONE',10));const originalDraft=await page.evaluate(()=>sessionStorage.getItem('aster-draft:assistant-1:transit-preview'));const requestCount=requests.length;
 await stop();await start(stateB);await page.reload();await nav();const pendingButton=page.getByRole('button',{name:'确认本次提交',exact:true});await pendingButton.waitFor();assert.equal(await pendingButton.isDisabled(),true);assert.equal(await page.locator('.transit-import-preview').count(),0);assert.equal(await page.evaluate(()=>sessionStorage.getItem('aster-draft:assistant-1:transit-preview')),originalDraft);assert.equal(requests.length,requestCount);assert.equal(dbB.db.prepare('SELECT COUNT(*) n FROM transit_batches').get().n,0);await shot('05-other-database-blocked');
 await stop();await start(state);await page.reload();await nav();await confirmGlobal(otherDb);await uploadsReady();assert.equal(quantity('DB-ONE'),10);assert.equal((await draft()).value.preview,null);check('同源切至另一实际合成DB：不恢复预览、不重放、不清原DB草稿；恢复原DB才结算一次');

 // A response for the original database must not erase a later saved draft already belonging to another database.
 const savedDbGuard=await lose(await file('已替换DB草稿5','DB-GUARD',5));await nav('库存汇总');await page.evaluate(()=>{const key='aster-draft:assistant-1:transit-preview',saved=JSON.parse(sessionStorage.getItem(key));saved.databaseId='later-synthetic-database';sessionStorage.setItem(key,JSON.stringify(saved));});const otherRaw=await page.evaluate(()=>sessionStorage.getItem('aster-draft:assistant-1:transit-preview'));await confirmGlobal(savedDbGuard);assert.equal(await page.evaluate(()=>sessionStorage.getItem('aster-draft:assistant-1:transit-preview')),otherRaw);assert.equal(quantity('DB-GUARD'),5);check('成功回执与已保存草稿DB不匹配时不清，原请求仍仅入账一次（合成草稿身份前提）');
 assert.deepEqual(errors,[]);db.assertInventoryInvariants();dbB.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);check('最终库存恒等式/外键成立，真实Edge无pageerror');
 await fs.writeFile(path.join(out,'final-catalog.json'),JSON.stringify(db.getCatalog(),null,2));
}catch(e){failure=e.stack;console.error(e);process.exitCode=1;if(page){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(out,'failure.txt'),await page.locator('body').innerText()).catch(()=>{});}}
finally{await browser?.close();await stop();db.close();dbB.close();await fs.writeFile(path.join(out,'server.log'),logs);await fs.writeFile(path.join(out,'result.json'),JSON.stringify({out,root,dist,state,stateB,base,instanceId,checks,requests,lost,receipts,screenshots,errors,failure:failure??null,formalAccess:false,realERP:false,serverStopped:!!server&&(server.exitCode!==null||server.signalCode!==null)},null,2));console.log('Evidence: '+out);}
