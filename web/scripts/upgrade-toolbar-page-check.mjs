// All business writes use a fresh owned SQLite fixture and server; no production data or Lingxing worker.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from '../node_modules/playwright-core/index.mjs';
import {createInventoryDatabase,InventoryDatabase,ROLES} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';
import {transferWorkbook,transferSample} from '../../scripts/fixtures/transfer-workbook.mjs';
import {relocationAddressFixture as address} from '../../scripts/fixtures/relocation-workbook.mjs';

const root=path.resolve(import.meta.dirname,'../..');
const out=path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/upgrade-toolbar-cleanup/toolbar'));
await fs.mkdir(out,{recursive:true});
const state=await fs.mkdtemp(path.join(out,'state-')),accounts=path.join(state,'accounts.json');
await fs.writeFile(accounts,JSON.stringify({accounts:[{account:'AUS',shortName:'QA',room:'101'}]}));
process.env.ASTER_WAREHOUSE_ACCOUNTS=accounts;
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID(),common=row=>({expectedRevision:row.revision,requestId:rid()});
const checks=[],screenshots=[],errors=[],requests=[],roleEvidence=[],downloads=[],retryEvidence=[];
const python=process.env.ASTER_TEST_PYTHON||'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const port=await freePort(),base='http://127.0.0.1:'+port;
let browser,page,child,failure,serial=0;
const check=(name,evidence={})=>{checks.push({name,...evidence});console.log('PASS '+name);};
async function api(url,body,role='logistics'){
  const response=await fetch(base+url,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
}
const proof=preview=>({previewToken:preview.previewToken,fileName:preview.fileName,fileHash:preview.fileSha256,templateHash:preview.templateSha256,rows:preview.rows,requestId:rid()});
function inquiry(plan,model='SYNTH-TONER-001',version='V1'){
  let row=db.createInquiry({role:'operation-1',model,quantity:100,department:'一团',store:'AUS',operator:'隔离工具栏',fnsku:'000'+plan,asin:'BTOOLBAR01',requestId:rid()}).record;
  row=db.reviewInquiry({id:row.id,role:'business',decision:'approve',approvedQuantity:100,...common(row)}).record;
  row=db.replyInquiry({id:row.id,role:'purchasing',supplierQuantity:100,shippingWarehouse:'CA',...common(row)}).record;
  return db.archiveInquiry({id:row.id,role:'purchasing',plan,date:'2026-10-13',version,...common(row)}).record;
}
function move(row){return db.initiateRelocationUpgrade({inquiryId:row.id,sourceRevision:row.revision,role:'admin',requestId:rid()}).workItem;}
async function nav(role,tab='移仓升级'){
  await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(role);
  await page.locator('.sidebar .nav-item',{hasText:'升级库存'}).click();
  await page.getByRole('tab',{name:tab,exact:true}).click();await page.waitForLoadState('networkidle');
}
const board=kind=>page.locator(kind==='relocation'?'.relocation-upgrade':'.transfer-upgrade');
const panel=kind=>board(kind).locator('.panel').filter({has:page.getByRole('heading',{name:kind==='relocation'?'移仓升级记录':'转仓升级记录',exact:true})});
const dialog=()=>page.getByRole('dialog');
const close=()=>dialog().getByRole('button',{name:'关闭弹窗',exact:true}).click();
const labelFor=stage=>({rma:'RMA',count:'实际清点数量',progress:'升级进度'}[stage]);
function inspect(file){return JSON.parse(execFileSync(python,['-X','utf8',path.join(root,'scripts/fixtures/check-upgrade-template.py'),file,process.env.ASTER_UPGRADE_TEMPLATE||'','ordinary'],{encoding:'utf8',windowsHide:true}));}
function edit(file,changes){
  const target=path.join(out,'edited-'+(++serial)+'.xlsx');
  execFileSync(python,['-X','utf8','-c',`import openpyxl,json,sys
w=openpyxl.load_workbook(sys.argv[1]);s=w.active;changes=json.loads(sys.argv[3]);start=3 if s.title=='移仓升级' else 4
for row in range(s.max_row,start-1,-1):
 plan=str(s.cell(row,3).value)
 if plan not in changes:s.delete_rows(row);continue
 for col,value in changes[plan].items():s.cell(row,int(col),value)
w.save(sys.argv[2])`,file,target,JSON.stringify(changes)],{windowsHide:true});
  return target;
}
async function download(kind,label,expected){
  const responsePromise=page.waitForResponse(response=>response.url().includes(expected.path)&&response.request().method()==='GET');
  const downloadPromise=page.waitForEvent('download');await panel(kind).getByRole('button',{name:label,exact:true}).click();
  const response=await responsePromise,download=await downloadPromise,url=new URL(response.url());
  assert.equal(response.status(),200);for(const [key,value] of Object.entries(expected.params))assert.equal(url.searchParams.get(key),value,key);
  const file=path.join(out,(++serial)+'-'+download.suggestedFilename());await download.saveAs(file);
  const layout=inspect(file);assert.deepEqual(layout.rows.map(row=>row[2]).sort(),[...expected.plans].sort());
  downloads.push({file,url:url.pathname+url.search,filename:download.suggestedFilename(),layout});return file;
}
async function seedTransfer(stage,changes){
  const response=await fetch(base+'/api/transfer-upgrades/update/template?stage='+stage,{headers:{'x-role':'logistics'}});assert.equal(response.status,200);
  const file=path.join(out,'seed-'+(++serial)+'.xlsx');await fs.writeFile(file,Buffer.from(await response.arrayBuffer()));
  const previewResponse=await fetch(base+'/api/transfer-upgrades/update/preview?stage='+stage,{method:'POST',headers:{'x-role':'logistics','x-file-name':'seed.xlsx'},body:await fs.readFile(edit(file,changes))});
  assert.equal(previewResponse.status,200);const preview=await previewResponse.json();assert.deepEqual(preview.errors,[]);await api('/api/transfer-upgrades/update/import?stage='+stage,proof(preview));
}
async function toolbarOrder(kind,expected){
  const names=await panel(kind).locator('.panel-head-actions .btn').evaluateAll(elements=>elements.map(element=>element.getAttribute('aria-label')||element.textContent.trim()));
  assert.deepEqual(names,expected);return names;
}
async function layout(kind,width,name){
  await page.setViewportSize({width,height:1000});await panel(kind).scrollIntoViewIfNeeded();
  const result=await panel(kind).evaluate(element=>{
    const controls=[...element.querySelectorAll('.panel-head-actions .btn,.upgrade-filters > label')].filter(node=>node.getClientRects().length);
    const rects=controls.map(node=>{const r=node.getBoundingClientRect();return {label:node.getAttribute('aria-label')||node.textContent.trim(),x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};});
    const overlap=[];for(let a=0;a<rects.length;a++)for(let b=a+1;b<rects.length;b++){const x=Math.min(rects[a].right,rects[b].right)-Math.max(rects[a].x,rects[b].x),y=Math.min(rects[a].bottom,rects[b].bottom)-Math.max(rects[a].y,rects[b].y);if(x>1&&y>1)overlap.push([rects[a].label,rects[b].label]);}
    const titleRange=document.createRange();titleRange.selectNodeContents(element.querySelector('.panel-title-row h2'));
    const countRange=document.createRange();countRange.selectNodeContents(element.querySelector('.panel-title-row > .muted'));
    const lines=range=>new Set([...range.getClientRects()].map(rect=>Math.round(rect.top*100))).size;
    return {rects,overlap,titleLines:lines(titleRange),countLines:lines(countRange),scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth};
  });
  assert.equal(result.scrollWidth<=width,true,JSON.stringify(result));assert.deepEqual(result.overlap,[]);
  assert.equal(result.titleLines,1,'记录标题被工具栏挤压换行：'+JSON.stringify(result));
  assert.equal(result.countLines,1,'记录条数被工具栏挤压换行：'+JSON.stringify(result));
  assert(result.rects.every(rect=>rect.x>=0&&rect.right<=width+1&&rect.width>30),JSON.stringify(result));
  const file=path.join(out,name+'-'+width+'.png');await page.screenshot({path:file,fullPage:false,animations:'disabled'});screenshots.push(file);return result;
}
async function selectTransfer(model='',version='',status=''){
  await page.getByLabel('转仓筛选型号').selectOption(model);await page.getByLabel('转仓筛选原版本').selectOption(version);await page.getByLabel('转仓筛选状况').selectOption(status);
}
async function uploadAgain(kind,file,{stage,failFirst=false}={}){
  const input=page.locator(kind==='relocation'?'#relocation-update-file':'#transfer-update-file');
  const previewPath=kind==='relocation'?'/api/upgrades/relocation-update/preview':'/api/transfer-upgrades/update/preview?stage='+stage;
  if(failFirst){
    await page.route('**'+previewPath,route=>route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:'隔离验证：文件读取失败'})}),{times:1});
    await input.setInputFiles(file);await panel(kind).getByRole('alert').filter({hasText:'隔离验证：文件读取失败'}).waitFor();
    assert.equal(await input.inputValue(),'');assert.equal(await dialog().count(),0);
  }
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**'+previewPath,async route=>{await gate;await route.continue();},{times:1});
  await input.setInputFiles(file);await panel(kind).locator('label').filter({hasText:'正在预览…'}).waitFor();assert(await input.isDisabled());release();
  await dialog().getByText(/尚未保存/).waitFor();assert.equal(await input.inputValue(),'');
  await close();await panel(kind).getByRole('button',{name:kind==='relocation'?'查看 RMA 与地址更新预览':'查看'+labelFor(stage)+'更新预览',exact:true}).click();await dialog().getByText(/尚未保存/).waitFor();await close();
  const responsePromise=page.waitForResponse(response=>response.url().endsWith(previewPath)&&response.request().method()==='POST');
  await input.setInputFiles(file);assert.equal((await responsePromise).status(),200);await dialog().getByText(/尚未保存/).waitFor();assert.equal(await input.count(),1);
}
async function saveWithRecovery(kind,stage,assertSaved,{rejectFirst=false}={}){
  const endpoint=kind==='relocation'?'/api/upgrades/relocation-update/import':'/api/transfer-upgrades/update/import?stage='+stage;
  const confirm=kind==='relocation'?'确认更新 RMA 与地址':stage==='rma'?'确认更新 RMA':'确认更新'+labelFor(stage),sent=[];
  if(rejectFirst){
    await page.route('**'+endpoint,route=>route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:'隔离验证：本次未保存'})}),{times:1});
    await dialog().getByRole('button',{name:confirm,exact:true}).click();await dialog().getByRole('alert').filter({hasText:'隔离验证：本次未保存'}).waitFor();
    assert(await dialog().getByRole('button',{name:confirm,exact:true}).isEnabled());assert.equal(await dialog().getByRole('button',{name:'重试确认',exact:true}).count(),0);
  }
  let release;const gate=new Promise(resolve=>{release=resolve;});let first=true;
  await page.route('**'+endpoint,async route=>{
    sent.push(route.request().postDataJSON());
    if(first){first=false;await gate;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');}
    else {const response=await route.fetch();assert.equal(response.status(),200);await route.fulfill({response});}
  });
  await dialog().getByRole('button',{name:confirm,exact:true}).click();await dialog().getByRole('button',{name:'正在保存…',exact:true}).waitFor();
  assert(await dialog().getByRole('button',{name:'关闭弹窗',exact:true}).isDisabled());assert(await page.locator(kind==='relocation'?'#relocation-update-file':'#transfer-update-file').isDisabled());release();
  await dialog().getByRole('button',{name:'重试确认',exact:true}).waitFor();await assertSaved();await close();
  if(kind==='relocation')await page.getByLabel('移仓筛选型号').selectOption('SYNTH-TONER-002');
  else {await page.getByLabel('转仓筛选型号').selectOption('SYNTH-TONER-002');assert(await page.getByLabel('转仓办理阶段').isDisabled());}
  await page.getByRole('tab',{name:kind==='relocation'?'转仓升级':'移仓升级',exact:true}).click();
  await page.getByRole('tab',{name:kind==='relocation'?'移仓升级':'转仓升级',exact:true}).click();
  await panel(kind).getByRole('button',{name:kind==='relocation'?'查看 RMA 与地址更新预览':'查看'+labelFor(stage)+'更新预览',exact:true}).click();await dialog().getByRole('button',{name:'重试确认',exact:true}).waitFor();await close();
  await panel(kind).getByRole('button',{name:'重试确认',exact:true}).click();
  await panel(kind).getByRole('status').filter({hasText:kind==='relocation'?'已更新 1 条移仓记录':'已保存 1 条转仓升级更新'}).waitFor();
  assert.equal(await panel(kind).getByRole('button',{name:'重试确认',exact:true}).count(),0);
  assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);await assertSaved();await page.unroute('**'+endpoint);
  retryEvidence.push({kind,stage,requestId:sent[0].requestId,attempts:sent.length,samePayload:true});
}

try{
  const a=inquiry('000MOVE-A'),b=inquiry('000MOVE-B'),c=inquiry('000MOVE-C','SYNTH-TONER-001','V2'),d=inquiry('000MOVE-D','SYNTH-TONER-002','V1');
  const moveA=move(a),moveB=move(b);move(c);move(d);db.recordRelocationProcurement({id:moveB.id,role:'logistics',rma:'000RMA-B',relocationAddress:address,...common(moveB)});
  const instanceId=createTestInstanceId('upgrade-toolbar');
  child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'pipe',env:{...process.env,ASTER_STATE_ROOT:state,ASTER_WAREHOUSE_ACCOUNTS:accounts,ASTER_OVERSEAS_WAREHOUSES:'SyntheticWarehouseA;SyntheticWarehouseB',HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
  child.stderr.on('data',data=>process.stderr.write(data));await waitForOwnedServer({base,child,instanceId});
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.url().includes('/api/'))requests.push({method:request.method(),url:request.url(),...(request.method()==='POST'&&request.headers()['content-type']?.includes('application/json')?{body:request.postData()}:{} )});});await page.goto(base);
  for(const role of ROLES){
    await nav(role);const canExport=['admin','purchasing','logistics'].includes(role),logistics=role==='logistics',firstImport=['admin','assistant-1','assistant-2','purchasing','logistics'].includes(role);
    assert.equal(await panel('relocation').getByRole('button',{name:'导出移仓升级',exact:true}).count(),Number(canExport));
    assert.equal(await board('relocation').getByRole('button',{name:'下载移仓更新模板',exact:true}).count(),Number(logistics));assert.equal(await page.locator('#relocation-update-file').count(),Number(logistics));
    if(logistics)await toolbarOrder('relocation',['导出移仓升级','下载移仓更新模板','上传 RMA 与地址更新表格']);
    await page.getByRole('tab',{name:'转仓升级',exact:true}).click();await panel('transfer').waitFor();
    assert.equal(await panel('transfer').getByRole('button',{name:'导出转仓升级',exact:true}).count(),Number(canExport));assert.equal(await page.locator('#transfer-update-file').count(),Number(logistics));
    assert.equal(await page.getByLabel('转仓办理阶段').count(),Number(logistics));assert.equal(await page.locator('#transfer-upgrade-file').count(),Number(firstImport));assert.equal(await panel('transfer').getByRole('button',{name:'刷新',exact:true}).count(),1);
    if(logistics)await toolbarOrder('transfer',['导出转仓升级','下载RMA更新模板','上传 RMA 更新表格','上传转仓升级表格','刷新']);
    roleEvidence.push({role,canExport,logistics,firstImport,refresh:true});
  }
  check('九角色仅管理员/采购/物流导出，仅物流更新；首次导入五角色、刷新保留，按钮无重复',{roles:roleEvidence});
  await nav('logistics','转仓升级');
  const imported=[['000T-A','SYNTH-TONER-001','V1'],['000T-B','SYNTH-TONER-001','V1'],['000T-C','SYNTH-TONER-001','V2'],['000T-D','SYNTH-TONER-002','V1']].map(([plan,model,version])=>{const row=[...transferSample];row[0]=model;row[2]=plan;row[4]=version;row[6]=100;return row;});
  await page.locator('#transfer-upgrade-file').setInputFiles({name:'隔离首次转仓.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:transferWorkbook(imported)});
  await dialog().getByText(/将新增/).waitFor();await close();await panel('transfer').getByRole('button',{name:'查看转仓升级导入预览',exact:true}).click();await dialog().getByRole('button',{name:'确认新增转仓升级记录',exact:true}).click();await dialog().waitFor({state:'hidden'});assert.equal(db.getTransferUpgrades().length,4);
  await seedTransfer('rma',{'000T-B':{11:'000RMA-B'},'000T-C':{11:'000RMA-C'}});await seedTransfer('count',{'000T-C':{12:80}});await panel('transfer').getByRole('button',{name:'刷新',exact:true}).click();
  check('移动后的首次导入入口仍有独立预览、关闭重开与确认，隔离库新增四条记录');
  await layout('transfer',1440,'transfer-toolbar-before-download');

  await nav('logistics');await page.getByLabel('移仓筛选型号').selectOption('SYNTH-TONER-001');await page.getByLabel('移仓筛选原版本').selectOption('V1');
  await layout('relocation',1440,'relocation-toolbar-before-download');
  await download('relocation','导出移仓升级',{path:'/api/upgrades/relocation-update/export',params:{model:'SYNTH-TONER-001',version:'V1',source:''},plans:['000MOVE-A','000MOVE-B']});
  await page.getByLabel('移仓筛选来源').selectOption('inquiry:'+a.id);
  const moveTemplate=await download('relocation','下载移仓更新模板',{path:'/api/upgrades/relocation-update/template',params:{model:'SYNTH-TONER-001',version:'V1',source:'inquiry:'+a.id},plans:['000MOVE-A']});
  for(const width of [1366,1440,900])await layout('relocation',width,'relocation-toolbar');
  await page.setViewportSize({width:1440,height:1000});
  await uploadAgain('relocation',edit(moveTemplate,{'000MOVE-A':{11:'000RMA-TOOLBAR',12:address}}),{failFirst:true});
  await saveWithRecovery('relocation',undefined,async()=>assert.equal(db.getRelocationWorkItem(moveA.id).rma,'000RMA-TOOLBAR'),{rejectFirst:true});
  assert.equal(db.getRelocationWorkItem(moveA.id).status,'awaiting_operation');
  check('移仓三按钮相邻，筛选下载原19列；失败/处理中/重复同文件/预览重开/跨筛选待确认均保留，原请求只保存一次');

  await nav('logistics','转仓升级');
  assert.deepEqual(await panel('transfer').locator('.transfer-filters > label > span').allTextContents(),['型号','原版本','状况','物流更新步骤']);
  await selectTransfer('SYNTH-TONER-001','V1','待确认实际清点数量');
  for(const stage of ['rma','count','progress']){
    await page.getByLabel('转仓办理阶段').selectOption(stage);assert.equal(await page.getByLabel('转仓筛选状况').inputValue(),'待确认实际清点数量');
    await toolbarOrder('transfer',['导出转仓升级','下载'+labelFor(stage)+'更新模板',stage==='rma'?'上传 RMA 更新表格':'上传'+labelFor(stage)+'更新表格','上传转仓升级表格','刷新']);
    await download('transfer','下载'+labelFor(stage)+'更新模板',{path:'/api/transfer-upgrades/update/template',params:{stage,model:'SYNTH-TONER-001',version:'V1',status:'待确认实际清点数量'},plans:stage==='progress'?[]:['000T-B']});
  }
  await page.getByLabel('转仓筛选状况').selectOption('已在第三方海外仓');assert.equal(await page.getByLabel('转仓办理阶段').inputValue(),'progress');
  await page.getByLabel('转仓办理阶段').selectOption('rma');await download('transfer','导出转仓升级',{path:'/api/transfer-upgrades/update/export',params:{model:'SYNTH-TONER-001',version:'V1',status:'已在第三方海外仓'},plans:['000T-A']});
  for(const width of [1366,1440,900])await layout('transfer',width,'transfer-toolbar-rma');
  check('转仓四筛选顺序正确，状态与步骤互不联动；三阶段下载按型号/版本/状况后再限定可办范围，15列原模板保持');

  const steps=[['rma','已在第三方海外仓',{11:'000RMA-A'}],['count','待确认实际清点数量',{12:80}],['progress','转仓和升级中',{13:4,14:7,15:'UPG-V2'}]];
  for(const [stage,status,changes] of steps){
    await page.setViewportSize({width:1440,height:1000});await selectTransfer('SYNTH-TONER-001','V1',status);await page.getByLabel('转仓办理阶段').selectOption(stage);
    const plans=stage==='count'?['000T-A','000T-B']:['000T-A'];
    const file=await download('transfer','下载'+labelFor(stage)+'更新模板',{path:'/api/transfer-upgrades/update/template',params:{stage,model:'SYNTH-TONER-001',version:'V1',status},plans});
    await uploadAgain('transfer',edit(file,{'000T-A':changes}),{stage,failFirst:stage==='rma'});
    const screenshot=path.join(out,'transfer-'+stage+'-preview.png');await page.screenshot({path:screenshot,animations:'disabled'});screenshots.push(screenshot);
    await saveWithRecovery('transfer',stage,async()=>{const row=db.getTransferUpgrades().find(row=>row.data.plan==='000T-A');assert.equal(row.data[stage==='rma'?'rma':stage==='count'?'countedQuantity':'completedQuantity'],stage==='rma'?'000RMA-A':stage==='count'?'80':'7');},{rejectFirst:stage==='rma'});
    assert(await page.getByLabel('转仓办理阶段').isEnabled());
    for(const width of [1366,1440,900])await layout('transfer',width,'transfer-toolbar-'+stage+'-saved');
    check('转仓'+labelFor(stage)+'更新：单份文件输入/重复同文件/处理中/关闭/跨筛选及板块恢复，确认重试沿用原请求');
  }
  const upgraded=db.getTransferUpgrades().find(row=>row.data.plan==='000T-A');assert.equal(upgraded.history.length,3);assert.equal(upgraded.receiptBatches.length,1);assert.equal(upgraded.receiptBatches[0].quantity,7);assert.equal(upgraded.receiptBatches[0].warehouse,'Aster海外仓');
  assert.equal(db.db.prepare('SELECT count(*) n FROM relocation_waybill_exports').get().n,0);assert.equal(db.db.prepare('SELECT count(*) n FROM lingxing_sync_jobs').get().n,0);
  db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.deepEqual(errors,[]);
  check('三阶段各保存一次，累计完成7仅入库7；库存/外键不变量通过，未标记运单、未创建领星同步');
}catch(error){failure=error.stack;console.error(error);if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{
  await browser?.close();if(child?.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}db.close();
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify({base,state,checks,screenshots,roleEvidence,downloads,retryEvidence,errors,requests,failure,exitCode:failure?1:0,productionWrites:0,realLingxing:false},null,2));
}
