// Real React form and browser validation; all data lives in a new temporary state root.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright-core';
import {createInventoryDatabase,InventoryDatabase} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'../..'),out=path.join(root,'.test-output/allocation-pack-page');await fs.mkdir(out,{recursive:true});
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-allocation-pack-page-'));createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID(),port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('allocation-pack-page');
const server=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
let diagnostics='';server.stdout.on('data',chunk=>diagnostics+=chunk);server.stderr.on('data',chunk=>diagnostics+=chunk);
let browser,page,failure;const checks=[],errors=[],posts=[];
const check=name=>{checks.push(name);console.log('PASS '+name);};
async function api(route,role,body){const res=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await res.json();assert.equal(res.status,200,JSON.stringify(result));return result;}
const snapshot=()=>Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.db.prepare('SELECT * FROM "'+name+'"').all()]));
async function waitCheck(fn){let last;for(let i=0;i<80;i++){try{await fn();return;}catch(e){last=e;}await new Promise(r=>setTimeout(r,75));}throw last;}
async function openBatch(role,fnsku){await page.goto(base+'/?q=PACK-PAGE&model=PACK-PAGE');await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(role);if(!await page.locator('.detail-stock-table').count())await page.locator('.inventory-summary-row').click();const row=page.locator('.detail-stock-table > tbody > tr').filter({has:page.getByText(fnsku,{exact:true})}).filter({has:page.locator('.alloc-toggle')});await row.locator('.alloc-toggle').click();await page.locator('.allocation-panel').waitFor();return page.locator('.allocation-panel');}
async function fillFields(form,store='PACKUS'){for(const [label,value]of [['调拨店铺',store],['调拨运营','页面运营'],['已贴 FNSKU','OPERATOR-CODE'],['ASIN（必填）','BPACKPAGE1'],['运营备注（选填）','保持全部草稿']])await form.getByLabel(label,{exact:true}).fill(value);}
async function rejected(form,value,expected){const quantity=form.getByLabel('调拨数量',{exact:true}),before=snapshot(),postCount=posts.length;await quantity.fill(value);await waitCheck(async()=>{assert.ok((await form.locator('.field-error').allTextContents()).some(text=>text.includes(expected)));assert.equal(await quantity.getAttribute('aria-invalid'),'true');assert.equal(await form.getByRole('button',{name:'录入并预锁定',exact:true}).isDisabled(),true);});
 // Dispatch submit directly to also exercise the handler's second validation.
 await form.locator('form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(posts.length,postCount);assert.deepEqual(snapshot(),before);assert.equal(await quantity.inputValue(),value);
 for(const label of ['调拨运营','已贴 FNSKU','ASIN（必填）','运营备注（选填）'])assert.ok(await form.getByLabel(label,{exact:true}).inputValue());}
async function submit(form,route='/api/allocations',name='录入并预锁定'){const response=page.waitForResponse(r=>new URL(r.url()).pathname===route&&r.request().method()==='POST');await form.getByRole('button',{name,exact:true}).click();const res=await response,result=await res.json();assert.equal(res.status(),200,JSON.stringify(result));return result;}
try{
 await waitForOwnedServer({base,child:server,instanceId});
 const fileName='整箱页面硒鼓.csv',csv='ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\nPACK-PAGE,600,12,PAGE-12,SyntheticWarehouseA,SAME,2026-10-09,一团,V1\nPACK-PAGE,600,5,PAGE-5,SyntheticWarehouseA,SAME,2026-10-09,二团,V1\nPACK-PAGE,20,12,PAGE-TAIL,SyntheticWarehouseA,TAIL,2026-10-09,一团,V1\nPACK-PAGE,120,12,PAGE-BAD,SyntheticWarehouseA,BAD,2026-10-09,一团,V1';
 const preview=await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':'admin','x-file-name':encodeURIComponent(fileName)},body:csv});assert.equal(preview.status,200);const p=await preview.json();const imported=await api('/api/transit/import','admin',{previewToken:p.previewToken,fileName,fileHash:p.fileSha256,templateHash:p.templateSha256,rows:p.rows,requestId:rid()});for(const t of imported.rows)await api(`/api/transit/${t.id}/on-shelf`,db.getTransit(t.id).team==='二团'?'assistant-2':'assistant-1',{yes:'YES',expectedRevision:t.revision,requestId:rid()});
 const rows=(await api('/api/inventory/catalog','admin')).stockDetails['PACK-PAGE'],bad=rows.find(b=>b.fnsku==='PAGE-BAD');
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});page=await browser.newPage({viewport:{width:1500,height:1100}});page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&['/api/allocations','/api/inquiries'].includes(new URL(r.url()).pathname))posts.push({path:new URL(r.url()).pathname,body:r.postDataJSON()});});
 for(const role of ['operation-1','operation-2','admin']){
  const form=await openBatch(role,'PAGE-12');await fillFields(form);
  for(const [value,message]of [['13','12 的整数倍'],['0','大于 0 的整数'],['-12','大于 0 的整数'],['1.5','大于 0 的整数'],['612','超出可用库存']])await rejected(form,value,message);
  await form.getByLabel('调拨数量',{exact:true}).fill('12');assert.equal(await form.locator('.field-error').count(),0);assert.equal(await form.getByLabel('调拨数量',{exact:true}).evaluate(input=>input.checkValidity()),true);assert.equal(await form.getByLabel('运营备注（选填）',{exact:true}).inputValue(),'保持全部草稿');
  const result=await submit(form);assert.equal(result.record.requestedQuantity,12);assert.equal(result.record.batchKey,rows.find(b=>b.fnsku==='PAGE-12').batchKey);assert.equal(posts.at(-1).body.quantity,12);
  check(role+'：输入立即警告，按钮及提交处理均阻止无效数量；修正12后一箱通过浏览器及服务端，草稿保留');
 }
 const multi=await openBatch('admin','PAGE-12');await fillFields(multi);await multi.getByLabel('调拨数量',{exact:true}).fill('24');assert.equal((await submit(multi)).record.requestedQuantity,24);check('两箱24合法');
 const other=await openBatch('operation-2','PAGE-5');await fillFields(other);await rejected(other,'12','5 的整数倍');await other.getByLabel('调拨数量',{exact:true}).fill('5');assert.equal((await submit(other)).record.batchKey,rows.find(b=>b.fnsku==='PAGE-5').batchKey);check('切换同型号实际5套/箱批次后按5判定，12被拒绝、5通过');
 const tail=await openBatch('admin','PAGE-TAIL');await fillFields(tail);await rejected(tail,'20','12 的整数倍');await rejected(tail,'24','超出可用库存');await tail.getByLabel('调拨数量',{exact:true}).fill('12');await submit(tail);await rejected(tail,'8','12 的整数倍');check('可用20仅能申请12，余8输入保持原值并被阻止');
 for(const pack of [null,'','0','-1','1.5','abc']){db.db.prepare('UPDATE stock_batches SET pack_per_box=? WHERE batch_key=?').run(pack,bad.batchKey);const form=await openBatch('admin','PAGE-BAD');assert.ok((await form.locator('.field-error').innerText()).includes('批次套/箱数据异常'));await fillFields(form);await rejected(form,'12','批次套/箱数据异常');assert.equal(db.db.prepare('SELECT pack_per_box FROM stock_batches WHERE batch_key=?').get(bad.batchKey).pack_per_box,pack);}
 check('套/箱缺失及异常在打开表单时即提示批次数据问题；输入和提交不补值、不写业务');
 const correction=await openBatch('operation-1','PAGE-12');await fillFields(correction);await correction.getByLabel('调拨店铺',{exact:true}).fill('BAD');await correction.getByLabel('调拨数量',{exact:true}).fill('13');assert.equal(await correction.locator('.field-error').count(),2);await correction.getByLabel('调拨数量',{exact:true}).fill('12');assert.equal(await correction.locator('.field-error').count(),1);assert.ok((await correction.locator('.field-error').innerText()).includes('店铺名称'));assert.equal(await correction.getByLabel('运营备注（选填）',{exact:true}).inputValue(),'保持全部草稿');await correction.locator('input[pattern]').fill('PACKUS');await submit(correction);check('修正数量只清除对应错误，其他店铺错误和全部草稿保持，继续修正后成功');
 const serverCorrection=await openBatch('operation-1','PAGE-12');await fillFields(serverCorrection);await serverCorrection.getByLabel('调拨数量',{exact:true}).fill('12');const rejectedBaseline=snapshot();
 await page.route('**/api/allocations',async route=>{const payload=route.request().postDataJSON();await route.continue({postData:JSON.stringify({...payload,quantity:13})});},{times:1});
 const failedResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/allocations'&&r.request().method()==='POST');await serverCorrection.getByRole('button',{name:'录入并预锁定',exact:true}).click();assert.equal((await failedResponse).status(),400);await serverCorrection.locator('.dialog-error').waitFor();assert.ok((await serverCorrection.locator('.dialog-error').innerText()).includes('12 的整数倍'));assert.deepEqual(snapshot(),rejectedBaseline);
 await serverCorrection.getByLabel('调拨数量',{exact:true}).fill('24');assert.equal(await serverCorrection.locator('.dialog-error').count(),0);assert.equal(await serverCorrection.getByLabel('运营备注（选填）',{exact:true}).inputValue(),'保持全部草稿');assert.equal((await submit(serverCorrection)).record.requestedQuantity,24);
 check('服务端再次校验拒绝后，修正数量即时清除对应服务端错误，草稿保留并可正常提交');
 await page.getByRole('button',{name:'询库',exact:true}).click();const dialog=page.getByRole('dialog');for(const [label,value]of [['询库数量（必填）','7'],['询库店铺（必填）','PACKUS'],['询库运营（必填）','询库运营'],['ASIN（必填）','BINQUIRY7'],['FNSKU（必填）','INQUIRY-CODE']])await dialog.getByLabel(label,{exact:true}).fill(value);assert.equal((await submit(dialog,'/api/inquiries','提交询库')).record.quantity,7);check('询库页面非整箱7仍可按原规则提交');
 assert.deepEqual(errors,[]);db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);await page.screenshot({path:path.join(out,'verified.png'),fullPage:true});
}catch(e){failure=e.stack;await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});throw e;}finally{await fs.writeFile(path.join(out,'result.json'),JSON.stringify({state,base,databaseId:db.syncState().databaseId,checks,posts,errors,failure,diagnostics},null,2));await browser?.close();const ended=once(server,'exit');server.kill();await ended;db.close();}
console.log('ALLOCATION_PACK_PAGE_PASS '+checks.length);
