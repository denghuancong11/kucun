// Candidate-only 06/07 page acceptance. Does not use the active service or private configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from '../node_modules/playwright-core/index.mjs';
import { freePort, createTestInstanceId, waitForOwnedServer } from '../../scripts/test-server-ownership.mjs';
import { writeSyntheticTransitWorkbook } from '../../scripts/fixtures/generate-synthetic-workbook.mjs';

const root=path.resolve(import.meta.dirname,'../..');
assert.ok(process.env.ASTER_WEB_DIST,'须通过 ASTER_WEB_DIST 明确提供本轮候选构建');
const dist=path.resolve(process.env.ASTER_WEB_DIST);await fs.access(path.join(dist,'index.html'));
const parent=process.env.ASTER_ACCEPTANCE_OUTPUT||path.resolve(root,'../outputs/full-audit-20261021/repair-acceptance/inbound');
await fs.mkdir(parent,{recursive:true});const out=await fs.mkdtemp(path.join(parent,'page-')),state=path.join(out,'state');await fs.mkdir(state,{recursive:true});
const runtime=path.join(state,'runtime.synthetic.json'),accounts=path.join(state,'accounts.synthetic.json');
await fs.writeFile(runtime,JSON.stringify({schemaVersion:1,overseasWarehouses:['SyntheticWarehouseA','SyntheticWarehouseB']}));
await fs.writeFile(accounts,JSON.stringify({accounts:[{account:'AUS',shortName:'SYNTH',room:'SYNTH-101'}]}));
process.env.ASTER_RUNTIME_CONFIG=runtime;process.env.ASTER_WAREHOUSE_ACCOUNTS=accounts;process.env.ASTER_OVERSEAS_WAREHOUSES='SyntheticWarehouseA;SyntheticWarehouseB';
const {createInventoryDatabase,InventoryDatabase}=await import('../../inventory-db.mjs');
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});const db=new InventoryDatabase(state);
const port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('repair-inbound-page');
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ASTER_STATE_ROOT:state,ASTER_WEB_DIST:dist,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
let logs='',browser,page,failure;child.stdout.on('data',x=>{logs+=x;});child.stderr.on('data',x=>{logs+=x;});
const checks=[],errors=[],posts=[],responses=[];const check=name=>{checks.push(name);console.log('PASS '+name);};
const wait=async(fn)=>{let error;for(let until=Date.now()+9000;Date.now()<until;){try{await fn();return;}catch(e){error=e;}await new Promise(r=>setTimeout(r,100));}throw error;};
const source=changes=>({model:'PAGE-REPAIR-INK',quantity:30,packPerBox:'10',fnsku:'PAGE-REPAIR-FNSKU',shippingMethod:'SyntheticWarehouseA',plan:'PAGE-REPAIR-DEPT',date:'2026-10-01',team:'一团三部',version:'V1',...changes});
async function file(name,rows){const p=path.join(out,name);await writeSyntheticTransitWorkbook(p,{rows,sheetName:'普通在途',includeTitle:false});return p;}
async function nav(role,view){await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(role);await page.locator('.sidebar .nav-item',{hasText:view}).click();}
async function showDetail(tab){if(!await page.getByRole('tab',{name:/在库明细/}).count())await page.locator('.inventory-summary-row').filter({hasText:'PAGE-REPAIR-INK'}).click();await page.getByRole('tab',{name:tab==='transit'?/在途明细/:/在库明细/}).click();}
async function clickWrite(route,click){const pending=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===route);await click();const response=await pending,data=await response.json();assert.equal(response.status(),200,JSON.stringify(data));return data;}
try {
  await waitForOwnedServer({base,child,instanceId});browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});page=await browser.newPage({viewport:{width:1500,height:1050}});page.setDefaultTimeout(9000);
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push({route:new URL(r.url()).pathname,...(r.headers()['content-type']?.includes('application/json')?{body:r.postDataJSON()}:{})});});
  page.on('response',async r=>{if(r.request().method()==='POST'&&r.url().includes('/api/'))try{responses.push({route:new URL(r.url()).pathname,status:r.status(),data:await r.json()});}catch{}});
  await page.goto(base);await nav('assistant-1','在途库存');
  const invalid=await file('箱规错误墨盒.xlsx',['',0,'abc','2.5'].map((packPerBox,i)=>source({packPerBox,plan:'BAD-'+i})));
  await page.locator('#transit-import-file').setInputFiles(invalid);await page.locator('.transit-preview-table tbody tr').last().waitFor();
  assert.equal(await page.locator('.transit-preview-table tbody tr').count(),4);assert.equal(await page.getByRole('button',{name:'确认导入在途库存',exact:true}).isDisabled(),true);
  for(const row of [2,3,4,5])assert.ok((await page.getByRole('alert').allTextContents()).join(' ').includes('第 '+row+' 行“套/箱”须填写正整数'));
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM transit_batches').get().n,0);assert.equal(posts.filter(x=>x.route==='/api/transit/import').length,0);
  await page.screenshot({path:path.join(out,'01-invalid-pack-preview.png'),fullPage:true});check('07 实际XLSX四类无效箱规显示源行2至5，确认按钮不可用，未提交或入账');
  const unknown=await file('未知部门墨盒.xlsx',[source({team:'一团四部'})]);await page.locator('#transit-import-file').setInputFiles(unknown);
  await wait(async()=>assert.ok((await page.getByRole('alert').allTextContents()).join(' ').includes('团队“一团四部”尚未确认所属团队')));assert.equal(await page.getByRole('button',{name:'确认导入在途库存',exact:true}).isDisabled(),true);
  await page.screenshot({path:path.join(out,'02-unknown-department-preview.png'),fullPage:true});check('06 未确认部门在页面提示源行和部门原名，不能确认导入');
  const good=await file('一团三部30件墨盒.xlsx',[source()]);await page.locator('#transit-import-file').setInputFiles(good);await wait(async()=>assert.equal(await page.getByRole('button',{name:'确认导入在途库存',exact:true}).isDisabled(),false));
  assert.ok((await page.locator('.transit-preview-table').innerText()).includes('一团三部'));await page.screenshot({path:path.join(out,'03-department-preview.png'),fullPage:true});
  const imported=await clickWrite('/api/transit/import',()=>page.getByRole('button',{name:'确认导入在途库存',exact:true}).click());const transit=imported.rows[0];
  await nav('assistant-1','库存汇总');await showDetail('transit');const tr=page.locator('.pane-transit tbody tr').filter({hasText:'PAGE-REPAIR-DEPT'});await tr.getByRole('button',{name:'确认上架',exact:true}).waitFor();assert.ok((await tr.innerText()).includes('一团三部'));
  await page.screenshot({path:path.join(out,'04-assistant-before-shelf.png'),fullPage:true});
  const shelf=await clickWrite(`/api/transit/${transit.id}/on-shelf`,()=>tr.getByRole('button',{name:'确认上架',exact:true}).click());await wait(()=>assert.equal(db.getTransit(transit.id).status,'on_shelf'));
  await wait(async()=>assert.equal(await tr.getByRole('button',{name:'确认上架',exact:true}).count(),0));assert.equal(db.db.prepare('SELECT source_team FROM stock_batches WHERE batch_key=?').get(shelf.batchKey).source_team,'一团');assert.equal(db.getTransit(transit.id).team,'一团三部');
  await page.screenshot({path:path.join(out,'05-assistant-after-shelf.png'),fullPage:true});check('06 一团助理页面可见原一团三部并实际上架30，按钮消失、原部门保留、source_team为一团');
  await nav('operation-2','库存汇总');await wait(async()=>assert.equal(await page.locator('.inventory-summary-row').filter({hasText:'PAGE-REPAIR-INK'}).count(),0));await page.screenshot({path:path.join(out,'06-second-team-hidden.png'),fullPage:true});
  await nav('operation-1','库存汇总');await showDetail('stock');await wait(async()=>assert.equal((await page.locator('.inventory-summary-in-stock').innerText()).replaceAll(',',''),'30'));
  await page.locator('.alloc-toggle').first().click();const form=page.locator('.allocation-panel');
  for(const [label,value] of Object.entries({'调拨数量':'10','调拨店铺':'PAGEUS','调拨运营':'页面一团运营','已贴 FNSKU':'PAGE-REPAIR-FNSKU','ASIN（必填）':'PAGE000001'}))await form.getByLabel(label,{exact:true}).fill(value);
  const allocation=await clickWrite('/api/allocations',()=>form.getByRole('button',{name:'提交调拨并预锁定',exact:true}).click());assert.equal(allocation.record.requestedQuantity,10);assert.equal(allocation.record.department,'一团');await wait(()=>assert.equal(db.getBalance(shelf.batchKey).locked,10));
  await wait(async()=>assert.ok((await form.innerText()).includes('调拨已提交并预锁定库存')));await page.screenshot({path:path.join(out,'07-operation-allocate.png'),fullPage:true});
  assert.equal(posts.filter(x=>x.route==='/api/transit/import').length,1);assert.equal(posts.filter(x=>x.route===`/api/transit/${transit.id}/on-shelf`).length,1);assert.equal(posts.filter(x=>x.route==='/api/allocations').length,1);assert.deepEqual(errors,[]);db.assertInventoryInvariants();
  check('06 一团运营实际提交10件调拨并只锁10；二团页面不见此墨盒，导入/上架/提交各一次');console.log('INBOUND_REPAIR_PAGES_PASS '+checks.length+' '+out);
}catch(e){failure=e.stack;console.error(failure);if(page){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true});await fs.writeFile(path.join(out,'failure.txt'),await page.locator('body').innerText());}process.exitCode=1;}
finally{await fs.writeFile(path.join(out,'result.json'),JSON.stringify({checks,failure,errors,posts,responses,base,state,dist,databaseId:db.syncState().databaseId},null,2));await fs.writeFile(path.join(out,'server.log'),logs);await browser?.close();if(child.exitCode===null){child.kill();await once(child,'exit');}db.close();}
