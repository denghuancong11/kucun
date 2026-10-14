// Isolated synthetic inventory; browser phase is read-only and never connects to Lingxing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {createInventoryDatabase, InventoryDatabase, ROLES} from '../../inventory-db.mjs';
import {freePort, createTestInstanceId, waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'../..');
const out=process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/inventory-query-page');
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-inventory-query-page-'));
await fs.mkdir(out,{recursive:true});
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('inventory-query-page');
await fs.writeFile(path.join(state,'data/permissions.json'),JSON.stringify({墨盒:Object.fromEntries(ROLES.map(r=>[r,{summary:true,detail:true,expand:true,actions:true}]))}));
const clock=path.join(state,'clock.txt'),preload=path.join(state,'clock.mjs');
await fs.writeFile(clock,'2026-10-13T04:00:00.000Z');
await fs.writeFile(preload,`import fs from 'node:fs';const RealDate=Date;const now=()=>RealDate.parse(fs.readFileSync(${JSON.stringify(clock)},'utf8'));globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now()]));}static now(){return now();}};`);
const checks=[],errors=[],queries=[],sorts=[],writes=[],fixtureEvents=[],auditRequests=[];
let child,browser,page,failure,readBefore,readAfter;
const rid=()=>crypto.randomUUID(),check=name=>{checks.push(name);console.log('PASS '+name);};
const snapshot=()=>Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.db.prepare(`SELECT * FROM "${name}"`).all()]));
const expected=[
  {model:'QUERY-A-TONER',category:'硒鼓',inStock:90,locked:20,available:70,inTransit:50,total:140,batches:2},
  {model:'QUERY-B-INK',category:'墨盒',inStock:120,locked:30,available:90,inTransit:10,total:130,batches:3},
  {model:'QUERY-C-TONER',category:'硒鼓',inStock:60,locked:10,available:50,inTransit:100,total:160,batches:1},
  {model:'QUERY-D-INK',category:'墨盒',inStock:0,locked:0,available:0,inTransit:30,total:30,batches:0},
];
async function api(route,role='admin',body){
  const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();assert.equal(response.status,200,route+' '+JSON.stringify(result));return result;
}
async function importRows(category,rows){
  const fileName=`查询验收${category}.csv`,body='ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n'+rows.map(([model,quantity,code,team])=>[model,quantity,5,code,'SyntheticWarehouseA',code,'2026-10-13',team,'V1'].join(',')).join('\n');
  const response=await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':'admin','x-file-name':encodeURIComponent(fileName)},body});
  assert.equal(response.status,200);const p=await response.json();
  return (await api('/api/transit/import','admin',{previewToken:p.previewToken,fileName,fileHash:p.fileSha256,templateHash:p.templateSha256,rows:p.rows,requestId:rid()})).rows;
}
async function createAllocation(batch,quantity,role,operator,at){
  await fs.writeFile(clock,at);
  const r=(await api('/api/allocations',role,{model:batch.model,sourceBatchKey:batch.batchKey,plan:batch.plan,date:batch.date,version:batch.version,quantity,department:role==='operation-2'?'二团':'一团',store:'QUERYUS',operator,fnsku:batch.fnsku,asin:'BQUERY0001',requestId:rid()})).record;
  fixtureEvents.push({id:r.events[0].id,at,operator,role,model:batch.model,quantity});return r;
}
async function until(assertion){let last;for(let n=0;n<100;n++){try{await assertion();return;}catch(e){last=e;await new Promise(r=>setTimeout(r,50));}}throw last;}
async function table(){return page.locator('.inventory-summary-row').evaluateAll(rows=>rows.map(row=>Array.from(row.children).map(td=>td.textContent.trim())));}
async function assertRows(rows){await until(async()=>assert.deepEqual((await table()).map(c=>c[0]),rows.map(r=>r.model)));}
async function selectRole(role){await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(role);await until(async()=>assert.equal((await page.getByLabel('切换当前操作角色',{exact:true}).inputValue()),role));}
async function filters(model,from='',to=''){
  for(const [label,value]of [['按型号查询库存流水',model],['按开始日期查询库存流水',from],['按结束日期查询库存流水',to]])await page.getByLabel(label,{exact:true}).fill(value);
}
async function queryUi(expectedIds){
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/audit'&&r.request().method()==='GET');
  await page.getByRole('button',{name:'查询',exact:true}).click();
  const response=await pending,body=await response.json();assert.equal(response.status(),200,JSON.stringify(body));
  assert.deepEqual(body.records.map(r=>r.eventId).sort((a,b)=>a-b),[...expectedIds].sort((a,b)=>a-b));
  await until(async()=>assert.equal(await page.locator('.audit-table tbody tr').count(),expectedIds.length));
  queries.push({url:response.url(),ids:body.records.map(r=>r.eventId)});return body.records;
}
async function detailValue(label){return page.getByRole('dialog',{name:'流水详情',exact:true}).locator('dl > div').filter({has:page.locator('dt').getByText(label,{exact:true})}).locator('dd').innerText();}
try{
  child=spawn(process.execPath,['--import',pathToFileURL(preload).href,path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',TZ:'Asia/Shanghai',ASTER_TEST_INSTANCE_ID:instanceId,ASTER_OVERSEAS_WAREHOUSES:'SyntheticWarehouseA;SyntheticWarehouseB'}});
  await waitForOwnedServer({base,child,instanceId});
  const toner=await importRows('硒鼓',[
    ['QUERY-A-TONER',45,'A-STOCK-1','一团'],['QUERY-A-TONER',45,'A-STOCK-2','一团'],['QUERY-A-TONER',50,'A-TRANSIT','一团'],
    ['QUERY-C-TONER',60,'C-STOCK-1','二团'],['QUERY-C-TONER',100,'C-TRANSIT','二团'],
  ]);
  const ink=await importRows('墨盒',[
    ['QUERY-B-INK',40,'B-STOCK-1','一团'],['QUERY-B-INK',40,'B-STOCK-2','一团'],['QUERY-B-INK',40,'B-STOCK-3','一团'],['QUERY-B-INK',10,'B-TRANSIT','一团'],['QUERY-D-INK',30,'D-TRANSIT','二团'],
  ]);
  for(const t of [...toner,...ink].filter(r=>r.fnsku.includes('STOCK')))await api(`/api/transit/${t.id}/on-shelf`,t.team==='一团'?'assistant-1':'assistant-2',{yes:'YES',expectedRevision:t.revision,requestId:rid()});
  const c=await api('/api/inventory/catalog'),batch=model=>({...c.stockDetails[model][0],model});
  const times=['2026-10-13T15:59:59.999Z','2026-10-13T16:00:00.000Z','2026-10-14T15:59:59.999Z','2026-10-14T16:00:00.000Z'];
  for(const [i,at]of times.entries())await createAllocation(batch('QUERY-A-TONER'),5,'operation-1','边界'+i,at);
  const b=await createAllocation(batch('QUERY-B-INK'),40,'operation-1','墨盒测试','2026-10-14T04:00:00.000Z');
  await fs.writeFile(clock,'2026-10-14T04:01:00.000Z');
  await api(`/api/allocations/${b.id}/review`,'business',{decision:'approve',approvedQuantity:30,businessNote:'分类及角色核对',expectedRevision:b.revision,requestId:rid()});
  await createAllocation(batch('QUERY-C-TONER'),10,'operation-2','二团测试','2026-10-14T04:02:00.000Z');
  await fs.writeFile(clock,'2026-10-15T04:00:00.000Z');
  await api('/api/approvals'); // Establish existing scheduled-cleanup metadata before read-only assertions.
  const actual=await api('/api/inventory/catalog');
  for(const e of expected){const m=actual.models.find(m=>m.model===e.model);for(const k of ['inStock','locked','available','inTransit'])assert.equal(m[k],e[k],e.model+' '+k);assert.equal(actual.stockDetails[e.model]?.length||0,e.batches);}
  readBefore=snapshot();
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Shanghai'});page.setDefaultTimeout(10000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(new URL(r.url()).pathname==='/api/audit')auditRequests.push(r.url());});
  await page.route('**/*',async route=>{const req=route.request();if(!['GET','HEAD'].includes(req.method())){writes.push({method:req.method(),url:req.url()});await route.abort();}else await route.continue();});
  await page.goto(base);await selectRole('admin');await assertRows(expected);
  for(const role of ROLES){
    await selectRole(role);
    const rows=role.endsWith('-1')?expected.filter(e=>e.model!=='QUERY-D-INK'):role.endsWith('-2')?expected.filter(e=>e.model!=='QUERY-B-INK'):expected;
    await assertRows(rows);
    const cells=await table();for(const [i,e]of rows.entries())assert.deepEqual(cells[i],[e.model,e.category,...['inStock','locked','available','inTransit','total','batches'].map(k=>String(e[k]))]);
  }
  check('九角色库存汇总实值与独立合成预期一致：硒鼓跨团、墨盒按团队，含在库/锁定/可用/在途/总量/批次');
  await selectRole('admin');await assertRows(expected);
  for(const [field,label]of [['model','型号'],['inStock','在库库存'],['locked','预锁定'],['available','可用库存'],['inTransit','在途库存'],['total','库存总量'],['batches','批次']]){
    const th=page.locator('.inventory-summary-table thead th').filter({has:page.getByRole('button',{name:label,exact:true})});
    for(const order of ['ascending','descending']){
      if(await th.getAttribute('aria-sort')!==order)await th.getByRole('button',{name:label,exact:true}).click();
      const sorted=[...expected].sort((a,b)=>field==='model'?a.model.localeCompare(b.model):a[field]-b[field]);if(order==='descending')sorted.reverse();
      await assertRows(sorted);assert.equal(await th.getAttribute('aria-sort'),order);sorts.push({field,order,models:(await table()).map(r=>r[0])});
    }
  }
  check('七个可排序列各自双向排序，14组实际顺序及aria-sort均正确，数值用已知fixture核对');
  const search=page.getByLabel('按型号关键字搜索',{exact:true}),categories=page.getByRole('group',{name:'按类目筛选',exact:true});
  await categories.getByRole('button',{name:/^墨盒/}).click();await search.fill(' query-b ');await assertRows([expected[1]]);
  await search.fill('query-a');await page.getByText('未找到该型号',{exact:true}).waitFor();assert.equal(await page.locator('.inventory-summary-row').count(),0);
  await page.getByRole('button',{name:'清除搜索',exact:true}).click();await assertRows([expected[1],expected[3]]);
  await categories.getByRole('button',{name:/^全部类目/}).click();await search.fill('query-a');await page.getByRole('option',{name:/QUERY-A-TONER/}).waitFor();await search.press('ArrowDown');await search.press('Enter');
  await page.getByRole('region',{name:'QUERY-A-TONER 库存明细',exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('model'),'QUERY-A-TONER');
  await page.reload();await page.getByRole('region',{name:'QUERY-A-TONER 库存明细',exact:true}).waitFor();assert.equal(await search.inputValue(),'QUERY-A-TONER');
  await categories.getByRole('button',{name:/^硒鼓/}).click();await assertRows([expected[0]]);
  await categories.getByRole('button',{name:/^墨盒/}).click();await until(async()=>assert.equal(await search.inputValue(),''));assert.equal(await page.getByRole('region',{name:'QUERY-A-TONER 库存明细',exact:true}).count(),0);
  await page.screenshot({path:path.join(out,'inventory-filter-sort.png'),fullPage:true});
  check('搜索大小写/空格、类目组合、空结果与清除搜索、键盘候选、URL刷新恢复和切类目收起不匹配型号均正确');
  await page.locator('.sidebar .nav-item',{hasText:'库存流水'}).click();await page.getByLabel('选择库存操作分类',{exact:true}).waitFor();
  await filters('query-a-toner','2026-10-14','2026-10-14');
  const included=fixtureEvents.filter(e=>e.model==='QUERY-A-TONER').slice(1,3);
  const records=await queryUi(included.map(e=>e.id));
  for(const expectedEvent of included){
    const row=page.locator('.audit-table tbody tr').filter({hasText:expectedEvent.operator});assert.equal(await row.count(),1);
    const raw=db.db.prepare('SELECT role,occurred_at,event_type FROM document_events WHERE id=?').get(expectedEvent.id);
    assert.equal(raw.role,'operation-1');assert.equal(raw.occurred_at,expectedEvent.at);
    const cells=await row.locator('td').allTextContents();assert.equal(cells[1],'调拨录入');assert.equal(cells[3],'5');assert.equal(cells[5],'-5');assert.equal(cells[7],'运营·一团');
    assert.match(cells[4],/在库0预锁定\+5/);
    await row.getByRole('button',{name:'查看',exact:true}).click();
    assert.equal(await detailValue('型号'),'QUERY-A-TONER');assert.equal(await detailValue('数量'),'5');assert.equal(await detailValue('操作岗位'),'运营·一团');assert.equal(await detailValue('运营'),expectedEvent.operator);
    const d=records.find(r=>r.eventId===expectedEvent.id);assert.equal(d.at,expectedEvent.at);assert.equal(d.onHandDelta,0);assert.equal(d.lockedDelta,5);assert.equal(d.availableDelta,-5);
    assert.equal(await detailValue('时间'),new Date(expectedEvent.at).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}));
    await page.getByRole('dialog',{name:'流水详情',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
  }
  await page.screenshot({path:path.join(out,'audit-date-boundary.png'),fullPage:true});
  check('页面日期查询包含本地00:00与23:59:59.999、排除前后1ms；两条结果与详情核对实际岗位、时间和在库0/锁+5/可用-5');
  await filters('query-a-toner','2026-10-16','2026-10-16');await queryUi([]);await page.getByText('未找到符合条件的流水。',{exact:true}).waitFor();
  await filters('query-a-toner','2026-10-15','2026-10-14');
  const count=auditRequests.length;await page.getByRole('button',{name:'查询',exact:true}).click();await page.getByRole('alert').filter({hasText:'开始日期不能晚于结束日期'}).waitFor();assert.equal(auditRequests.length,count);
  await page.getByRole('button',{name:'清空',exact:true}).click();await until(async()=>assert.equal(await page.getByLabel('按开始日期查询库存流水',{exact:true}).inputValue(),''));
  await page.getByLabel('选择库存操作分类',{exact:true}).selectOption('review');await filters('QUERY-B-INK','2026-10-14','2026-10-14');
  const review=db.db.prepare("SELECT id FROM document_events WHERE event_type='review'").all();assert.equal(review.length,1);await queryUi(review.map(r=>r.id));
  const reviewRow=page.locator('.audit-table tbody tr');assert.equal(await reviewRow.locator('td').nth(7).innerText(),'商务');assert.equal(await reviewRow.locator('td').nth(5).innerText(),'+10');
  await reviewRow.getByRole('button',{name:'查看',exact:true}).click();assert.equal(await detailValue('操作岗位'),'商务');await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  check('流水空结果、反向日期反馈、清空及切换商务审核分类正确；独立DB事件唯一，缩量释放10与实际办理岗位一致');
  // Native date input rejects invalid calendar strings. Rewrite one outgoing GET to exercise the real server error in the actual page.
  let invalidResponse;
  const invalidRoute=async route=>{const url=new URL(route.request().url());url.searchParams.set('from','2026-02-30');const response=await route.fetch({url:url.href});invalidResponse={url:url.href,status:response.status(),body:await response.json()};await route.fulfill({response});};
  await page.route('**/api/audit?**',invalidRoute);await filters('QUERY-B-INK','2026-02-28','2026-10-14');
  await page.getByRole('button',{name:'查询',exact:true}).click();await page.getByRole('alert').filter({hasText:'开始时间不是有效时间'}).waitFor();
  assert.equal(invalidResponse.status,400);assert.equal(invalidResponse.body.code,'invalid_audit_time');queries.push({injectedInvalidCalendar:invalidResponse});
  await page.unroute('**/api/audit?**',invalidRoute);await filters('QUERY-B-INK','2026-10-14','2026-10-14');await queryUi(review.map(r=>r.id));
  check('非法日历请求经真实服务返回400后页面明确提示，未成功提示或丢失旧结果；恢复合法日期可继续查询（非法值用网络参数注入）');
  readAfter=snapshot();assert.deepEqual(readAfter,readBefore);assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);
  check('只读浏览器阶段全部数据库表逐项不变，无POST、无浏览器异常；库存不变量及外键通过');
}catch(error){failure=error.stack;if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{
  await browser?.close();if(child?.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}db.close();
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify({state,base,checks,errors,queries,sorts,fixtureEvents,expected,browserWrites:writes,allTablesUnchanged:!!readAfter,tableCount:readAfter?Object.keys(readAfter).length:null,failure:failure??null,productionWrites:0,realLingxing:false},null,2));
}
console.log('INVENTORY_QUERY_PAGE_PASS '+checks.length);
