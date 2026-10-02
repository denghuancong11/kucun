import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {createInventoryDatabase,InventoryDatabase} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'../..');
const output=process.env.ASTER_INQUIRY_OUTPUT||path.join(root,'.test-output/inquiry-entry');
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-inquiry-entry-'));
await fs.mkdir(output,{recursive:true});
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});
const db=new InventoryDatabase(state);
for(const [model,category] of [['ZERO-TONER','硒鼓'],['ZERO-INK','墨盒']])
  db.db.prepare('INSERT INTO catalog_models(model,category,base_in_stock,in_transit,revision,updated_at) VALUES(?,?,0,0,1,?)').run(model,category,new Date().toISOString());
const roles=['admin','operation-1','operation-2','assistant-1','assistant-2','business','purchasing'];
const matrix={墨盒:Object.fromEntries(roles.map(role=>[role,{summary:true,detail:true,expand:true,actions:true}]))};
await fs.writeFile(path.join(state,'data/permissions.json'),JSON.stringify(matrix));
const port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('inquiry-entry');
const server=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,PORT:String(port),HOST:'127.0.0.1',PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
const checks=[],layouts=[],errors=[],writes=[];
const check=name=>{checks.push(name);console.log('PASS '+name);};
let browser,page,failure;
const region=()=>page.locator('.detail-panel');
const button=()=>region().getByRole('button',{name:'询库',exact:true});
async function open(model,role='admin'){
  await page.goto(base,{waitUntil:'networkidle'});
  await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(role);
  await page.waitForLoadState('networkidle');
  await page.locator('.inventory-summary-row').filter({has:page.getByText(model,{exact:true})}).click();
  await page.getByRole('region',{name:model+' 库存明细',exact:true}).waitFor();
  await page.getByRole('tab',{name:/在途明细/}).waitFor();
}
async function fields(values){const dialog=page.getByRole('dialog');for(const [label,value] of Object.entries(values))await dialog.getByLabel(label,{exact:true}).fill(String(value));}
async function position(){
  const a=await page.getByRole('tab',{name:/在途明细/}).boundingBox(),b=await button().boundingBox();
  assert.ok(a&&b);assert.ok(b.x>=a.x+a.width);assert.ok(b.x-(a.x+a.width)<=24);
  assert.ok(Math.abs((a.y+a.height/2)-(b.y+b.height/2))<3);
  assert.equal(await page.getByRole('tab').count(),2);
  assert.equal(await page.locator('.inventory-summary-table > thead th').count(),8);
  assert.equal(await page.locator('.inventory-summary-row.row-expanded > td').count(),8);
  assert.equal(await page.locator('.model-detail-host-cell').getAttribute('colspan'),'8');
  assert.equal(await page.locator('.inventory-summary-row .inquiry-entry').count(),0);
  assert.equal(await page.locator('.pane-stock .inquiry-entry,.pane-transit .inquiry-entry').count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  return {width:await page.evaluate(()=>innerWidth),zoom:await page.evaluate(()=>visualViewport.scale),tab:a,button:b};
}
try{
  await waitForOwnedServer({base,child:server,instanceId});
  // A visible ink model uses real team import/shelf evidence; ZERO-INK intentionally has none.
  for(const [team,role] of [['一团','assistant-1'],['二团','assistant-2']]) {
    const body=`ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\nVISIBLE-INK,1,4,X${team},SyntheticWarehouseB,P${team},2026-09-24,${team},V1`;
    const preview=await (await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':role,'x-file-name':encodeURIComponent(team+'墨盒.csv')},body})).json();
    const importedResponse=await fetch(base+'/api/transit/import',{method:'POST',headers:{'x-role':role,'content-type':'application/json'},body:JSON.stringify({previewToken:preview.previewToken,fileName:preview.fileName,fileHash:preview.fileSha256,templateHash:preview.templateSha256,rows:preview.rows,requestId:crypto.randomUUID()})});
    assert.equal(importedResponse.status,200);const t=(await importedResponse.json()).rows[0];
    const shelf=await fetch(base+`/api/transit/${t.id}/on-shelf`,{method:'POST',headers:{'x-role':role,'content-type':'application/json'},body:JSON.stringify({yes:'YES',expectedRevision:t.revision,requestId:crypto.randomUUID()})});assert.equal(shelf.status,200);
  }
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  page=await browser.newPage({viewport:{width:1366,height:1000},deviceScaleFactor:1});
  page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST')writes.push({url:new URL(request.url()).pathname,body:request.postDataJSON()});});
  await open('SYNTH-TONER-001');
  for(const width of [1280,1366,1920]){
    await page.setViewportSize({width,height:1000});
    const positions=[];
    for(const [tab,name] of [['stock',/在库明细/],['transit',/在途明细/]]){
      await page.getByRole('tab',{name}).click();const p=await position();assert.equal(p.zoom,1);positions.push(p);layouts.push({tab,...p});
      await page.screenshot({path:path.join(output,`inventory-${tab}-${width}.png`),fullPage:true,animations:'disabled'});
      await button().click();assert.equal(await page.getByRole('dialog',{name:'提交询库 · SYNTH-TONER-001',exact:true}).count(),1);
      assert.equal(await page.getByRole('tab',{name}).getAttribute('aria-selected'),'true');
      await page.getByRole('button',{name:'取消',exact:true}).click();
      assert.equal(await page.getByRole('tab',{name}).getAttribute('aria-selected'),'true');
    }
    assert.equal(positions[0].button.x,positions[1].button.x);assert.equal(positions[0].button.y,positions[1].button.y);
    check(`${width}px：八列与展开跨度一致，询库紧邻在途标签，两标签切换位置不变且仍为按钮`);
  }
  for(const role of roles)for(const model of ['SYNTH-TONER-001','ZERO-TONER','ZERO-INK','VISIBLE-INK']){
    if(model==='ZERO-INK'&&role.includes('-')) {
      await page.goto(base,{waitUntil:'networkidle'});await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(role);await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('.inventory-summary-row').filter({has:page.getByText(model,{exact:true})}).count(),0);continue;
    }
    await open(model,role);const allowed=['admin','operation-1','operation-2'].includes(role);
    if(allowed)await button().waitFor();
    assert.equal(await button().count(),allowed?1:0);
    if(model.startsWith('ZERO')){assert.equal(await page.locator('.row-expanded .inventory-summary-in-stock').innerText(),'0');assert.equal(await page.locator('.row-expanded .inventory-summary-batch-count').innerText(),'0');}
  }
  check('七角色：有本团来源墨盒继续验证入口，无本团来源ZERO-INK隐藏；零库存硒鼓保留入口');
  for(const [role,flag] of [['operation-1','actions'],['operation-2','expand']]){
    matrix.墨盒[role][flag]=false;await fs.writeFile(path.join(state,'data/permissions.json'),JSON.stringify(matrix));
    await open('VISIBLE-INK',role);assert.equal(await button().count(),0);
    await open('ZERO-TONER',role);await button().waitFor();
    matrix.墨盒[role][flag]=true;await fs.writeFile(path.join(state,'data/permissions.json'),JSON.stringify(matrix));
  }
  check('墨盒类目动作/展开权限关闭时不显示入口，硒鼓权限不受影响');
  await open('ZERO-TONER');await page.setViewportSize({width:1366,height:1000});
  await page.screenshot({path:path.join(output,'inventory-empty-1366.png'),fullPage:true,animations:'disabled'});
  await button().click();const writeCount=writes.length;
  await page.getByRole('button',{name:'提交询库',exact:true}).click();assert.equal(writes.length,writeCount);
  await fields({'询库数量（必填）':0,'询库店铺（必填）':'不可串用草稿US','询库运营（必填）':'测试','ASIN（必填）':'BTEST00001','FNSKU（必填）':'XTEST'});
  await page.getByRole('button',{name:'提交询库',exact:true}).click();assert.equal(writes.length,writeCount);
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('tab',{name:/在途明细/}).click();await button().click();assert.equal(await page.getByLabel('询库店铺（必填）',{exact:true}).inputValue(),'不可串用草稿US');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  // 同一次页面生命周期切换型号，核对组件状态和最终提交目标。
  await page.evaluate(()=>{history.pushState(null,'','/?q=ZERO-INK&model=ZERO-INK');dispatchEvent(new PopStateEvent('popstate'));});
  await page.getByRole('region',{name:'ZERO-INK 库存明细',exact:true}).waitFor();await button().click();
  assert.equal(await page.getByLabel('询库店铺（必填）',{exact:true}).inputValue(),'');
  assert.equal(await page.getByRole('dialog',{name:'提交询库 · ZERO-INK',exact:true}).count(),1);
  check('必填及正整数校验保留；同型号切标签保留草稿，切换型号不串用草稿或弹窗');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  const inventoryBefore=db.getCatalog();
  for(const [role,model,team] of [['admin','ZERO-INK','二团'],['operation-1','ZERO-TONER','一团'],['operation-2','SYNTH-TONER-001','二团']]){
    await open(model,role);await button().click();
    const department=page.locator('.inquiry-fields label').filter({hasText:'询库部门'}).locator('select');
    if(role==='admin')await department.selectOption(team);else {assert.equal(await department.isDisabled(),true);assert.equal(await department.inputValue(),team);}
    await fields({'询库数量（必填）':7,'询库店铺（必填）':role.replaceAll('-','')+'店铺US','询库运营（必填）':role,'ASIN（必填）':'BTEST00001','FNSKU（必填）':'XINQUIRY','运营备注（选填）':'移动入口回归'});
    if(role==='admin')await page.screenshot({path:path.join(output,'inquiry-dialog-1366.png'),fullPage:true,animations:'disabled'});
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/inquiries'&&r.request().method()==='POST');
    await page.getByRole('button',{name:'提交询库',exact:true}).click();
    const received=await response;assert.equal(received.status(),200);const {record}=await received.json();
    assert.equal(record.model,model);assert.equal(record.department,team);assert.equal(record.quantity,7);assert.equal(record.operatorNote,'移动入口回归');
    await page.getByRole('dialog').waitFor({state:'hidden'});assert.match(await page.getByRole('status').filter({hasText:'询库已提交'}).innerText(),/商务审核/);
    const stored=db.db.prepare('SELECT model,department,requested_quantity FROM inquiry_documents WHERE id=?').get(record.id);
    assert.equal(stored.model,model);assert.equal(stored.department,team);assert.equal(stored.requested_quantity,7);
  }
  const inventoryAfter=db.getCatalog();
  const quantities=catalog=>({models:catalog.models.map(({model,inStock,inTransit,locked,available})=>({model,inStock,inTransit,locked,available})),stockDetails:catalog.stockDetails,inTransitDetails:catalog.inTransitDetails});
  assert.deepEqual(quantities(inventoryAfter),quantities(inventoryBefore));
  assert.equal(inventoryAfter.sync.dataVersion,inventoryBefore.sync.dataVersion+3);
  assert.equal(writes.filter(w=>w.url==='/api/inquiries').length,3);
  check('管理员及两团运营均通过原接口提交当前型号，归属和成功处理正确，询库不改变库存');
  assert.deepEqual(errors,[]);db.assertInventoryInvariants();
}catch(error){failure=error.stack;if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});throw error;}
finally{await fs.writeFile(path.join(output,'result.json'),JSON.stringify({checks,layouts,errors,failure,writes,base,state},null,2));await browser?.close();server.kill();db.close();}
