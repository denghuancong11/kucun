// Synthetic database and owned service only. Responses are delayed to exercise stale component callbacks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from '../node_modules/playwright-core/index.mjs';
import {createInventoryDatabase,InventoryDatabase} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'../..');
const out=path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/draft-race'));
await fs.mkdir(out,{recursive:true});const state=await fs.mkdtemp(path.join(out,'state-'));
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),port=await freePort(),base='http://127.0.0.1:'+port;
const checks=[],errors=[],releases=[];
const hookHash=createHash('sha256').update(await fs.readFile(path.join(root,'web/src/hooks/useSessionDraft.ts'))).digest('hex');
const buildMeta=JSON.parse(await fs.readFile(path.join(process.env.ASTER_WEB_DIST||path.join(root,'web/dist'),'build-meta.json'),'utf8'));
let child,browser,page,failure;
const check=(name,actual,expected)=>{checks.push({name,actual,expected});assert.deepEqual(actual,expected,name);console.log('PASS '+name);};
const csv=name=>'ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n'+name+',20,5,FNSKU-'+name+',SyntheticWarehouseA,PLAN-'+name+',2026-10-14,一团,V1';
const fileName=name=>name+'硒鼓.csv';
const nav=name=>page.locator('.sidebar .nav-item',{hasText:name}).click();
const cache=(role='admin')=>page.evaluate(role=>JSON.parse(sessionStorage.getItem('aster-draft:'+role+':transit-preview')||'null')?.value.preview?.fileName??null,role);
const waitCache=(name,role='admin')=>page.waitForFunction(({name,role})=>JSON.parse(sessionStorage.getItem('aster-draft:'+role+':transit-preview')||'null')?.value.preview?.fileName===name,{name:fileName(name),role});
async function fresh(){await page?.context().close();const context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await nav('在途库存');}
async function upload(name){await page.waitForFunction(()=>{const input=document.querySelector('#transit-import-file');return input&&!input.disabled;});await page.locator('#transit-import-file').setInputFiles({name:fileName(name),mimeType:'text/csv',buffer:Buffer.from(csv(name))});}
async function delayedPreview(name){let release,arrived;const held=new Promise(r=>{release=r}),ready=new Promise(r=>{arrived=r});releases.push(release);await page.route('**/api/transit/preview',async route=>{const response=await route.fetch();if(decodeURIComponent(route.request().headers()['x-file-name'])===fileName(name)){arrived();await held;}await route.fulfill({response});});await upload(name);await ready;return release;}
async function releaseAndSettle(release){release();await page.waitForLoadState('networkidle');}
try{
 const instanceId=createTestInstanceId('draft-race');child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId,ASTER_OVERSEAS_WAREHOUSES:'SyntheticWarehouseA;SyntheticWarehouseB'}});await waitForOwnedServer({base,child,instanceId});
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 await fresh();let release=await delayedPreview('RACE-A');await nav('库存汇总');await nav('在途库存');await upload('RACE-B');await waitCache('RACE-B');await releaseAndSettle(release);
 check('同角色旧预览晚返回不覆盖新页面B预览',await cache(),fileName('RACE-B'));await page.reload();await nav('在途库存');await waitCache('RACE-B');check('刷新仍恢复新页面B预览',await cache(),fileName('RACE-B'));await page.screenshot({path:path.join(out,'new-preview-preserved.png'),fullPage:true});

 await fresh();release=await delayedPreview('LEFT-A');await nav('库存汇总');await releaseAndSettle(release);check('未重新打开原页面时离页请求仍暂存',await cache(),fileName('LEFT-A'));await nav('在途库存');await waitCache('LEFT-A');check('返回页面能恢复离页后完成的原预览',await cache(),fileName('LEFT-A'));

 await fresh();release=await delayedPreview('ADMIN-A');await page.getByLabel('切换当前操作角色',{exact:true}).selectOption('logistics');await nav('在途库存');await upload('LOGISTICS-B');await waitCache('LOGISTICS-B','logistics');await releaseAndSettle(release);
 check('原角色晚预览与新角色预览分开保存',[await cache('admin'),await cache('logistics')],[fileName('ADMIN-A'),fileName('LOGISTICS-B')]);await page.getByLabel('切换当前操作角色',{exact:true}).selectOption('admin');await nav('在途库存');await waitCache('ADMIN-A');check('切回原角色恢复其自身预览',await cache(),fileName('ADMIN-A'));

 for(const reject of [false,true]){
  await fresh();const prefix=reject?'REJECT':'SUCCESS';await upload(prefix+'-A');await waitCache(prefix+'-A');const before=db.db.prepare('SELECT COUNT(*) n FROM transit_batches').get().n;
  let arrived;const ready=new Promise(r=>{arrived=r}),held=new Promise(r=>{release=r});releases.push(release);
  await page.route('**/api/transit/import',async route=>{const response=reject?null:await route.fetch();if(response)assert.equal(response.status(),200);arrived();await held;if(reject)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,error:'隔离的明确拒绝回执',requestNotApplied:true})});return route.fulfill({response});});
  await page.getByRole('button',{name:'确认导入',exact:true}).click();await ready;await nav('库存汇总');await nav('在途库存');await upload(prefix+'-B');await waitCache(prefix+'-B');await releaseAndSettle(release);
  check((reject?'明确4xx':'成功')+'旧提交回执不覆盖新预览',await cache(),fileName(prefix+'-B'));await page.reload();await nav('在途库存');await waitCache(prefix+'-B');
  check((reject?'拒绝回执不写业务':'成功回执仅导入A一条'),db.db.prepare('SELECT COUNT(*) n FROM transit_batches').get().n,before+(reject?0:1));
  check((reject?'拒绝':'成功')+'确认完成后无残留待确认请求',await page.evaluate(()=>JSON.parse(sessionStorage.getItem('aster-pending-business-requests')||'[]').length),0);
 }
 check('所有预览均未导入，只有成功回执场景A写入',db.db.prepare('SELECT plan FROM transit_batches').all().map(r=>r.plan),['PLAN-SUCCESS-A']);assert.deepEqual(errors,[]);db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);
}catch(error){failure=error;console.error(error);await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{releases.forEach(release=>release());await browser?.close();if(child?.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}db.close();await fs.writeFile(path.join(out,'result.json'),JSON.stringify({state,base,checks,errors,hookHash,buildMeta,failure:failure?.stack??null,productionWrites:0,realLingxingRequests:0,negativeResponse:'409由浏览器路由注入，未发送后台；用于只验证晚回调边界'},null,2));}
if(failure)process.exitCode=1;
