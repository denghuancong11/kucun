// Isolated synthetic service: tests pending-request recovery, without production data or Lingxing.
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
const out=path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/direct-pending-draft'));
await fs.mkdir(out,{recursive:true});
const state=await fs.mkdtemp(path.join(out,'state-'));
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});
const db=new InventoryDatabase(state),port=await freePort(),base='http://127.0.0.1:'+port;
const checks=[],errors=[],requests=[],rid=()=>crypto.randomUUID();
const jobs=['V11','V12'].map(sourceVersion=>db.createDirectUpgrade({role:'admin',model:'SYNTH-TONER-001',sourceVersion,requestId:rid()}).upgrade);
const sourceHash=createHash('sha256').update(await fs.readFile(path.join(root,'web/src/components/DirectUpgrade.tsx'))).digest('hex');
const webDist=process.env.ASTER_WEB_DIST||path.join(root,'web/dist');
const buildMeta=JSON.parse(await fs.readFile(path.join(webDist,'build-meta.json'),'utf8'));
let child,browser,page,failure;
const check=(name,actual,expected)=>{checks.push({name,actual,expected});assert.deepEqual(actual,expected,name);console.log('PASS '+name);};
const cache=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('aster-draft:purchasing:direct-completion'))?.value);
const pending=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('aster-pending-business-requests')||'[]'));
async function nav(){await page.getByLabel('切换当前操作角色',{exact:true}).selectOption('purchasing');await page.locator('.sidebar .nav-item',{hasText:'升级库存'}).click();await page.getByRole('tab',{name:'在库升级',exact:true}).click();await page.waitForLoadState('networkidle');}
const open=job=>page.locator('[data-upgrade-id="'+job.id+'"]').getByRole('button',{name:'登记完成',exact:true}).click();
const close=()=>page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
async function fill(quantity){await page.getByRole('dialog').locator('input[type=radio]').first().check();await page.getByLabel('本次完成数量',{exact:true}).fill(quantity);await page.getByLabel('升级完成版本',{exact:true}).fill('RECOVERY-V2');await page.getByLabel('目标海外仓',{exact:true}).selectOption('SyntheticWarehouseA');}
try{
 const instanceId=createTestInstanceId('direct-pending-drafts');
 child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId,ASTER_OVERSEAS_WAREHOUSES:'SyntheticWarehouseA;SyntheticWarehouseB'}});
 await waitForOwnedServer({base,child,instanceId});
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/upgrades/direct/'))requests.push({url:r.url(),body:r.postData()});});
 await page.goto(base);await nav();await open(jobs[0]);await fill('3');
 let lose=true;const route='**/api/upgrades/direct/'+jobs[0].id+'/complete';
 await page.route(route,async r=>{const response=await r.fetch();assert.equal(response.status(),200);if(lose){lose=false;return r.abort('failed');}return r.fulfill({response});});
 await page.getByRole('button',{name:'登记完成并转入新版本',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'重试确认',exact:true}).waitFor();
 check('A丢回执只完成3件且原请求持久保留',[db.upgradeRecord(jobs[0].id).completedQuantity,(await pending()).length],[3,1]);
 await close();await open(jobs[1]);await fill('4');await close();
 const beforeReload=await cache();
 await page.reload();await nav();await page.getByRole('button',{name:'确认本次提交',exact:true}).click();
 await page.getByText(/原提交结果已确认/).waitFor();await page.unroute(route);
 await open(jobs[0]);const restoredQuantity=await page.getByLabel('本次完成数量',{exact:true}).inputValue();
 await page.screenshot({path:path.join(out,'A-after-confirm.png'),fullPage:true});
 await fs.writeFile(path.join(out,'reproduction.json'),JSON.stringify({steps:['A填写3件并提交，服务器成功后丢回执','关闭A，编辑B为4件','刷新后通过全局入口确认A原提交','重新打开A登记完成'],expectedAQuantity:'',actualAQuantity:restoredQuantity,cacheAfterEditingB:beforeReload,completedA:db.upgradeRecord(jobs[0].id).completedQuantity,pendingRequests:await pending(),requests,sourceHash,buildMeta},null,2));
 check('确认A原提交后不会恢复已提交旧数量',restoredQuantity,'');
 check('原请求重试不重复完成',db.upgradeRecord(jobs[0].id).completedQuantity,3);
 check('全局确认重用原请求',requests[0].body,requests[1].body);
 await close();await open(jobs[1]);check('B未提交草稿仍保留',await page.getByLabel('本次完成数量',{exact:true}).inputValue(),'4');await close();
 await open(jobs[0]);await fill('7');
 const beforeRejected=JSON.stringify(db.db.prepare('SELECT * FROM upgrade_operations ORDER BY id').all());
 await page.route(route,r=>r.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,error:'隔离验证明确拒绝',requestNotApplied:true})}));
 await page.getByRole('button',{name:'登记完成并转入新版本',exact:true}).click();await page.getByText('隔离验证明确拒绝',{exact:true}).waitFor();await close();await page.unroute(route);await page.reload();await nav();
 await open(jobs[0]);check('明确4xx拒绝后恢复A原草稿',await page.getByLabel('本次完成数量',{exact:true}).inputValue(),'7');await close();
 await open(jobs[1]);check('恢复A不覆盖B草稿',await page.getByLabel('本次完成数量',{exact:true}).inputValue(),'4');await close();
 check('明确拒绝未产生升级业务写入',JSON.stringify(db.db.prepare('SELECT * FROM upgrade_operations ORDER BY id').all()),beforeRejected);
 assert.deepEqual(errors,[]);db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);
}catch(error){failure=error;console.error(error);await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await browser?.close();if(child?.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}db.close();await fs.writeFile(path.join(out,'result.json'),JSON.stringify({base,state,checks,errors,requests,sourceHash,buildMeta,failure:failure?.stack??null,productionWrites:0,realLingxingRequests:0},null,2));}
if(failure)process.exitCode=1;
