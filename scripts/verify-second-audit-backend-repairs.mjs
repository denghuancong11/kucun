// Second-audit regressions. Synthetic configuration is set before any business import.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {freePort,createTestInstanceId,waitForOwnedServer} from './test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'..');
const output=path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/second-audit-backend'));
await fs.mkdir(output,{recursive:true});
const run=await fs.mkdtemp(path.join(output,'run-')),state=path.join(run,'state');
process.env.ASTER_RUNTIME_CONFIG=path.join(run,'runtime.json');
process.env.ASTER_WAREHOUSE_ACCOUNTS=path.join(run,'accounts.json');
process.env.ASTER_OVERSEAS_WAREHOUSES='SyntheticWarehouseA;SyntheticWarehouseB';
process.env.ASTER_PRIVATE_INBOUND_SOURCES=path.join(run,'unused-legacy.json');
await fs.writeFile(process.env.ASTER_RUNTIME_CONFIG,JSON.stringify({schemaVersion:1,overseasWarehouses:['SyntheticWarehouseA','SyntheticWarehouseB']}));
await fs.writeFile(process.env.ASTER_WAREHOUSE_ACCOUNTS,JSON.stringify({accounts:[{account:'SYNTHUS',shortName:'SYNTH',room:'TEST-ROOM'}]}));
const {InventoryDatabase,createInventoryDatabase,ROLES}=await import('../inventory-db.mjs');
const {transferWorkbook}=await import('./fixtures/transfer-workbook.mjs');
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('second-repair');
const python=process.env.ASTER_TEST_PYTHON||'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const rid=()=>crypto.randomUUID(),sql=(query,...args)=>db.db.prepare(query).all(...args);
const open={summary:true,detail:true,expand:true,actions:true},closed={summary:false,detail:false,expand:false,actions:false};
let matrix,child,browser,log='',failure;const checks=[],evidence=[],files=[],pageChecks=[];
async function permissions(changes={}){matrix={墨盒:Object.fromEntries(ROLES.map(role=>[role,{...open,...changes[role]}]))};await fs.writeFile(path.join(state,'data/permissions.json'),JSON.stringify(matrix));}
const snapshot=()=>JSON.stringify(Object.fromEntries(sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(({name})=>[name,sql('SELECT * FROM "'+name+'"')])));
function check(name){checks.push(name);console.log('PASS '+name);}
async function api(route,role='admin',body,status=200){const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'x-role':role,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();evidence.push({route,role,body,status:response.status,result,permissions:matrix});assert.equal(response.status,status,JSON.stringify(result));return result;}
async function upload(route,body,name,role='logistics',status=200){const response=await fetch(base+route,{method:'POST',headers:{'x-role':role,'x-file-name':encodeURIComponent(name)},body});const result=await response.json();evidence.push({route,role,fileName:name,status:response.status,result,permissions:matrix});assert.equal(response.status,status,JSON.stringify(result));return result;}
const commit=p=>({previewToken:p.previewToken,fileName:p.fileName,fileHash:p.fileSha256,templateHash:p.templateSha256,rows:p.rows,requestId:rid()});
async function denied(route,role,body,status=403){const before=snapshot(),result=await api(route,role,body,status);assert.equal(snapshot(),before);return result;}
async function download(route,role,name){const response=await fetch(base+route,{headers:{'x-role':role}});assert.equal(response.status,200);const file=path.join(run,name);await fs.writeFile(file,Buffer.from(await response.arrayBuffer()));const workbook=JSON.parse(execFileSync(python,['-X','utf8','-c',"import sys,json,openpyxl; w=openpyxl.load_workbook(sys.argv[1]); print(json.dumps({s.title:list(s.values) for s in w},ensure_ascii=False,default=str))",file],{encoding:'utf8',windowsHide:true}));files.push({route,role,file,workbook,permissions:matrix});return {file,workbook};}
async function edit(file,cells,name){const target=path.join(run,name);execFileSync(python,['-X','utf8','-c',"import sys,json,openpyxl; w=openpyxl.load_workbook(sys.argv[1]); s=w.active\nfor cell,value in json.loads(sys.argv[3]).items(): s[cell]=value\nw.save(sys.argv[2])",file,target,JSON.stringify(cells)],{windowsHide:true});return fs.readFile(target);}
const transferValues=(model,plan,quantity)=>[model,'第三方海外仓',plan,'2026-10-01','V1',model+'-FN',quantity,'SyntheticWarehouseA',model+'US','已在第三方海外仓','','','','',''];
async function transferImport(values,name='transfer.xlsx',role='logistics'){const p=await upload('/api/transfer-upgrades/preview',transferWorkbook(values),name,role);assert.deepEqual(p.errors,[]);assert(p.previewToken);const body=commit(p);return {p,body,result:await api('/api/transfer-upgrades/import',role,body)};}
async function updatePreview(record,stage,changes={},role='logistics'){const values=Object.values({...record.data,...changes});return upload('/api/transfer-upgrades/update/preview?stage='+stage,transferWorkbook([values]),stage+'.xlsx',role);}
async function update(record,stage,changes={}){const p=await updatePreview(record,stage,changes);assert.deepEqual(p.errors,[]);assert(p.previewToken);const body=commit(p);return {p,body,result:await api('/api/transfer-upgrades/update/import?stage='+stage,'logistics',body)};}
const transfer=plan=>db.getTransferUpgrades().find(row=>row.data.plan===plan);
async function inbound(name,lines){const p=await upload('/api/transit/preview','ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n'+lines.join('\n'),name,'admin');assert.deepEqual(p.validation.errors,[]);return api('/api/transit/import','admin',commit(p));}
const transit=(model,team,quantity,plan)=>`${model},${quantity},10,${model}-FN,SyntheticWarehouseA,${plan},2026-10-01,${team},V1`;
const address='Supplier (RMA#: TEST)\n12000 Magnolia Ave, Suite#101\nTEL:555000000';
async function archived(team,plan,model='S2-TONER',fnsku='SHARED-FNSKU'){
 const role=team==='一团'?'operation-1':'operation-2';let r=(await api('/api/inquiries',role,{model,quantity:20,department:team,store:'SYNTHUS',operator:'Synthetic '+team,fnsku,asin:'BTEST00001',requestId:rid()})).record;
 r=(await api('/api/inquiries/'+r.id+'/review','business',{decision:'approve',approvedQuantity:20,expectedRevision:r.revision,requestId:rid()})).record;
 r=(await api('/api/inquiries/'+r.id+'/reply','purchasing',{supplierQuantity:20,shippingWarehouse:'CA',expectedRevision:r.revision,requestId:rid()})).record;
 return (await api('/api/inquiries/'+r.id+'/archive','purchasing',{plan,date:'2026-10-01',version:team==='一团'?'TEAM1-SECRET-V17':'TEAM2-V1',expectedRevision:r.revision,requestId:rid()})).record;
}
async function workFor(source,role){let w=(await api('/api/upgrades/relocation-work-items',role,{inquiryId:source.id,sourceRevision:source.revision,requestId:rid()})).workItem;return (await api('/api/upgrades/relocation-work-items/'+w.id+'/procurement','logistics',{rma:'RMA',relocationAddress:address,expectedRevision:w.revision,requestId:rid()})).workItem;}
const order=(w,role,number,status=200)=>api('/api/upgrades/relocation-work-items/'+w.id+'/operation',role,{removalOrderNo:number,expectedRevision:w.revision,requestId:rid()},status);
const shipment=(w,id,quantity)=>({externalId:id,storeId:'synthetic',storeName:'SYNTH-US 美国',countryCode:'US',orderNo:w.removalOrderNo,fnsku:w.fnsku,quantity,carrier:'UPS',trackingNo:'TRACK-'+id,shipDate:'2026-10-01'});
try{
 await permissions();
 child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ASTER_STATE_ROOT:state,ASTER_WEB_DIST:process.env.ASTER_WEB_DIST||path.join(run,'no-dist'),HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);await waitForOwnedServer({base,child,instanceId});
 const pureInk=await inbound('first40墨盒.csv',[transit('S2-INK','一团',40,'INK-FIRST')]);
 const pureToner=await inbound('first硒鼓.csv',[transit('S2-TONER','一团',40,'TONER-FIRST')]);
 const mixed=await inbound('misnamed硒鼓.csv',[transit('S2-INK','一团',10,'MIX-INK-1'),transit('S2-INK','二团',10,'MIX-INK-2'),transit('S2-TONER','一团',10,'MIX-TONER-1'),transit('S2-TONER','二团',10,'MIX-TONER-2')]);
 const originals=await transferImport([transferValues('S2-INK','PRIVATE-TRANSFER',7),transferValues('S2-TONER','PUBLIC-TRANSFER',9)]);
 await permissions({purchasing:closed,logistics:open});
 assert(!(await api('/api/transfer-upgrades','logistics')).records.some(r=>r.data.model==='S2-INK'));
 for(const [route,name]of [['/api/transfer-upgrades/update/export','forbidden-export.xlsx'],...['rma','count','progress'].map(stage=>['/api/transfer-upgrades/update/template?stage='+stage,'forbidden-'+stage+'.xlsx'])])assert(!JSON.stringify((await download(route,'logistics',name)).workbook).includes('PRIVATE-TRANSFER'));
 let before=snapshot();await upload('/api/transfer-upgrades/preview',transferWorkbook([transferValues('S2-INK','DENIED-NEW',11)]),'misnamed硒鼓.xlsx','logistics',403);assert.equal(snapshot(),before);
 let p=await updatePreview(transfer('PRIVATE-TRANSFER'),'rma',{rma:'DENIED'});assert(!p.previewToken);assert(p.errors.some(e=>/有权访问/.test(e.message)));assert.equal(snapshot(),before);
 check('S2-01采购禁读/物流自身允许时，列表、导出和三阶段模板过滤；首次导入和更新预览拒绝，不签凭据、不写业务');
 await permissions();
 const newProof=await upload('/api/transfer-upgrades/preview',transferWorkbook([transferValues('S2-INK','OLD-PREVIEW',11)]),'old-preview.xlsx');
 const newBody=commit(newProof);
 p=await updatePreview(transfer('PRIVATE-TRANSFER'),'rma',{rma:'ALLOWED-RMA'});assert.deepEqual(p.errors,[]);const updateBody=commit(p);
 await permissions({purchasing:closed,logistics:open});
 await denied('/api/transfer-upgrades/import','logistics',newBody);
 await denied('/api/transfer-upgrades/update/import?stage=rma','logistics',updateBody);
 await permissions({purchasing:{...open,actions:false}});
 assert(JSON.stringify((await download('/api/transfer-upgrades/update/export','logistics','read-only-export.xlsx')).workbook).includes('PRIVATE-TRANSFER'));
 assert(JSON.stringify((await download('/api/transfer-upgrades/update/template?stage=rma','logistics','read-only-template.xlsx')).workbook).includes('PRIVATE-TRANSFER'));
 p=await updatePreview(transfer('PRIVATE-TRANSFER'),'rma',{rma:'DENIED-ACTION'});assert(!p.previewToken);assert(p.errors.some(e=>/有权访问/.test(e.message)));
 await denied('/api/transfer-upgrades/import','logistics',newBody);await denied('/api/transfer-upgrades/update/import?stage=rma','logistics',updateBody);
 check('S2-01旧预览撤去读取或仅actions均在确认阻止且凭据不消耗；只读导出/模板合法，更新预览拒绝');
 await permissions({purchasing:open,logistics:closed});
 const savedInitial=await api('/api/transfer-upgrades/import','logistics',newBody);assert.equal(savedInitial.rowCount,1);
 const savedUpdate=await api('/api/transfer-upgrades/update/import?stage=rma','logistics',updateBody);assert.equal(savedUpdate.rowCount,1);
 await permissions({purchasing:closed,logistics:open});before=snapshot();
 assert((await api('/api/transfer-upgrades/import','logistics',newBody)).deduped);assert((await api('/api/transfer-upgrades/update/import?stage=rma','logistics',updateBody)).deduped);assert.equal(snapshot(),before);
 await denied('/api/transfer-upgrades/import','logistics',{...newBody,fileName:'changed.xlsx'},409);
 check('S2-01采购允许/物流自身禁止合法确认；成功后撤权原键回放只返回原计数，改body仍409');
 await permissions();
 for(const [stage,changes]of [['count',{countedQuantity:'7'}],['progress',{inProgressQuantity:'0',completedQuantity:'7',completedVersion:'V2'}]]){
  p=await updatePreview(transfer('PRIVATE-TRANSFER'),stage,changes);assert.deepEqual(p.errors,[]);const body=commit(p);await permissions({purchasing:closed,logistics:open});await denied('/api/transfer-upgrades/update/import?stage='+stage,'logistics',body);await permissions();await api('/api/transfer-upgrades/update/import?stage='+stage,'logistics',body);
 }
 assert.equal(Number(sql("SELECT SUM(on_hand) n FROM stock_balances WHERE model='S2-INK'")[0].n),7);assert.equal(transfer('PRIVATE-TRANSFER').receiptBatches.length,1);
 check('S2-01清点/进度旧预览分别复核权限；恢复后原凭据可办，累计完成7仅入库一次');
 const mixedProof=await upload('/api/transfer-upgrades/update/preview?stage=rma',transferWorkbook([Object.values({...transfer('PUBLIC-TRANSFER').data,rma:'BATCH-TONER'}),Object.values({...transfer('OLD-PREVIEW').data,rma:'BATCH-INK'})]),'mixed-update.xlsx');assert.equal(mixedProof.rows.length,2);
 await permissions({purchasing:closed});await denied('/api/transfer-upgrades/update/import?stage=rma','logistics',commit(mixedProof));assert.equal(transfer('PUBLIC-TRANSFER').data.rma,'');
 await permissions();
 check('S2-01混合批次确认一行撤权整批无写，按凭据原单类目而非文件名');

 const s1=await archived('一团','TEAM1-SECRET-PLAN'),s2=await archived('二团','TEAM2-PLAN');
 let w1=await workFor(s1,'operation-1'),w2=await workFor(s2,'operation-2');w1=(await order(w1,'operation-1','SHARED-ORDER')).workItem;
 await api('/api/inquiries/'+s1.id+'/history','operation-2',undefined,403);assert(!(await api('/api/upgrades','operation-2')).relocationWorkItems.some(w=>w.id===w1.id));
 before=snapshot();let rejected=await order(w2,'operation-2','SHARED-ORDER',409);assert.equal(rejected.code,'ambiguous_shipment_owner');assert(!/TEAM1-SECRET|S2-TONER|\d{4}-\d{2}-\d{2}T/.test(rejected.error));assert.equal(snapshot(),before);
 w2=(await order(w2,'operation-2','OWN-ORDER')).workItem;before=snapshot();rejected=await api('/api/upgrades/relocation-work-items/'+w2.id+'/correct-order','operation-2',{removalOrderNo:'SHARED-ORDER',expectedRevision:w2.revision,requestId:rid()},409);assert(!/TEAM1-SECRET/.test(rejected.error));assert.equal(snapshot(),before);
 db.syncRelocationLogistics({id:w1.id,role:'operation-1',shipments:[shipment(w1,'OWN-10',10)],capturedAt:new Date().toISOString(),requestId:rid()});assert.equal(db.getRelocationWorkItem(w1.id).shippedQuantity,10);
 check('S2-04跨团保存及更正仍409且全表不变，不泄露一团资料；原流程继续采纳10');
 // Existing historical ambiguity is constructed only in this synthetic DB.
 db.db.prepare('UPDATE upgrade_relocation_work_items SET removal_order_no=? WHERE id=?').run('SHARED-ORDER',w2.id);
 before=snapshot();assert.throws(()=>db.syncRelocationLogistics({id:w2.id,role:'operation-2',shipments:[shipment({...w2,removalOrderNo:'SHARED-ORDER'},'LATE',1)],capturedAt:new Date().toISOString(),requestId:rid()}),e=>e.code==='ambiguous_shipment_owner'&&!/TEAM1-SECRET|S2-TONER|\d{4}-\d{2}-\d{2}T/.test(e.message));assert.equal(snapshot(),before);
 db.db.prepare('UPDATE upgrade_relocation_work_items SET removal_order_no=? WHERE id=?').run('OWN-ORDER',w2.id);
 check('S2-04既有错误归属的同步失败同样不披露来源，不保存包裹或改已采纳事实');

 await permissions({'assistant-1':closed,purchasing:closed,alan:open});before=snapshot();
 const imports1=(await api('/api/transit/imports','assistant-1')).imports;assert(!imports1.some(i=>i.id===pureInk.importId));assert(imports1.some(i=>i.id===pureToner.importId));assert.equal(imports1.find(i=>i.id===mixed.importId).rowCount,1);
 const importsAlan=(await api('/api/transit/imports','alan')).imports;assert(!importsAlan.some(i=>i.id===pureInk.importId));assert.equal(importsAlan.find(i=>i.id===mixed.importId).rowCount,2);assert.equal(snapshot(),before);
 await api('/api/transit/imports','operation-1',undefined,403);await api('/api/transit/imports','business',undefined,403);
 await permissions({'assistant-1':{...open,actions:false},purchasing:open,alan:closed});const allowed=(await api('/api/transit/imports','assistant-1')).imports;assert(allowed.some(i=>i.id===pureInk.importId));assert.equal(allowed.find(i=>i.id===mixed.importId).rowCount,2);assert.equal((await api('/api/transit/imports','alan')).imports.find(i=>i.id===mixed.importId).rowCount,4);
 check('S2-05按实际行类目和团队投影纯墨盒/混合文件及行数；Alan跟采购，actions不误挡只读，原凭证不变');
 for(const field of ['summary','detail','expand']){await permissions({'assistant-1':{...open,[field]:false}});assert(!(await api('/api/transit/imports','assistant-1')).imports.some(i=>i.id===pureInk.importId));}
 await permissions();assert.equal((await api('/api/transit/imports','admin')).imports.find(i=>i.id===mixed.importId).rowCount,4);
 check('S2-05三项读取任一关闭均隐藏纯墨盒批次；恢复后管理员和本团合法元信息完整');

 // A focused durable S2-02 check; the separate page suite covers all three source kinds.
 let source=await archived('一团','CANCEL-TEMPLATE','S2-TONER','CANCEL-FN');
 let old=(await api('/api/upgrades/relocation-work-items','operation-1',{inquiryId:source.id,requestId:rid()})).workItem;
 const oldFile=await download('/api/upgrades/relocation-update/template?source=inquiry:'+source.id,'logistics','old-template.xlsx');
 const oldBytes=await edit(oldFile.file,{K3:'RMA-OLD',L3:address},'old-template-filled.xlsx');
 const oldPreview=await upload('/api/upgrades/relocation-update/preview',oldBytes,'old-filled.xlsx');assert.equal(oldPreview.rows.length,1);
 await api('/api/upgrades/relocation-work-items/'+old.id+'/cancel','operation-1',{reason:'synthetic cancellation',expectedRevision:old.revision,requestId:rid()});
 await denied('/api/upgrades/relocation-update/import','logistics',commit(oldPreview),409);
 const fresh=(await api('/api/upgrades/relocation-work-items','operation-1',{inquiryId:source.id,requestId:rid()})).workItem;
 const both=await download('/api/upgrades/relocation-update/export?source=inquiry:'+source.id,'logistics','history-and-current.xlsx');
 p=await upload('/api/upgrades/relocation-update/preview',await fs.readFile(both.file),'both-unchanged.xlsx');assert.deepEqual(p.errors,[]);assert.equal(p.unchangedCount,2);assert(!p.previewToken);
 const freshFile=await download('/api/upgrades/relocation-update/template?source=inquiry:'+source.id,'logistics','fresh-template.xlsx');
 p=await upload('/api/upgrades/relocation-update/preview',await edit(freshFile.file,{K3:'RMA-FRESH',L3:address},'fresh-filled.xlsx'),'fresh-filled.xlsx');assert.deepEqual(p.errors,[]);assert.equal(p.rows.length,1);assert.equal(Number(p.rows[0].data.id),fresh.id);await api('/api/upgrades/relocation-update/import','logistics',commit(p));assert.equal(db.getRelocationWorkItem(old.id).status,'cancelled');assert.equal(db.getRelocationWorkItem(fresh.id).status,'awaiting_operation');
 check('S2-02取消历史不竞争新模板；旧签发确认拒绝；历史+当前原样19列回导2条unchanged，新模板只更新新流程');
 if(process.env.ASTER_WEB_DIST){
  const {chromium}=await import('../web/node_modules/playwright-core/index.mjs');
  browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
  const nav=async()=>{await page.goto(base);await page.getByLabel('切换当前操作角色',{exact:true}).selectOption('logistics');await page.locator('.sidebar .nav-item',{hasText:'升级库存'}).click();await page.getByRole('tab',{name:'转仓升级',exact:true}).click();await page.getByRole('table',{name:'转仓升级记录',exact:true}).getByText('S2-TONER',{exact:true}).waitFor();};
  async function pageDownload(label,name){const downloading=page.waitForEvent('download');await page.getByRole('button',{name:label,exact:true}).click();const downloaded=await downloading,file=path.join(run,name);await downloaded.saveAs(file);const workbook=JSON.parse(execFileSync(python,['-X','utf8','-c',"import sys,json,openpyxl; w=openpyxl.load_workbook(sys.argv[1]); print(json.dumps({s.title:list(s.values) for s in w},ensure_ascii=False,default=str))",file],{encoding:'utf8',windowsHide:true}));files.push({file,workbook,actualPage:true,permissions:matrix});return {file,workbook};}
  await permissions({purchasing:closed,logistics:open});await nav();assert(!(await page.getByRole('table',{name:'转仓升级记录',exact:true}).innerText()).includes('S2-INK'));
  assert(!JSON.stringify((await pageDownload('导出转仓升级','page-forbidden-export.xlsx')).workbook).includes('PRIVATE-TRANSFER'));assert(!JSON.stringify((await pageDownload('下载RMA更新模板','page-forbidden-template.xlsx')).workbook).includes('PRIVATE-TRANSFER'));
  await page.screenshot({path:path.join(run,'page-forbidden-transfer.png'),fullPage:true,animations:'disabled'});pageChecks.push('物流采购禁读时实际列表、导出、RMA下载均只含允许硒鼓，不再泄露墨盒');
  await permissions({purchasing:{...open,actions:false},logistics:open});await nav();
  const readOnlyTemplate=await pageDownload('下载RMA更新模板','page-readonly-template.xlsx');assert(JSON.stringify(readOnlyTemplate.workbook).includes('OLD-PREVIEW'));
  const values=readOnlyTemplate.workbook['转仓升级'],row=values.findIndex(row=>row?.[2]==='OLD-PREVIEW')+1;assert(row>=4);
  await edit(readOnlyTemplate.file,{['K'+row]:'UI-READONLY-RMA'},'page-readonly-edited.xlsx');await page.locator('#transfer-update-file').setInputFiles(path.join(run,'page-readonly-edited.xlsx'));
  const dialog=page.getByRole('dialog',{name:'转仓RMA更新预览',exact:true});await dialog.getByText(/有权访问/).first().waitFor();assert(await dialog.getByRole('button',{name:'确认更新 RMA',exact:true}).isDisabled());await page.screenshot({path:path.join(run,'page-readonly-preview-rejected.png'),fullPage:true,animations:'disabled'});await dialog.getByRole('button',{name:'关闭',exact:true}).click();pageChecks.push('读取允许/actions禁止时实际模板仍可下载，实际上传预览报拒绝且确认禁用');
  await permissions({purchasing:open,logistics:closed});await page.locator('#transfer-update-file').setInputFiles(path.join(run,'page-readonly-edited.xlsx'));await dialog.getByRole('button',{name:'确认更新 RMA',exact:true}).waitFor();assert(!(await dialog.getByRole('button',{name:'确认更新 RMA',exact:true}).isDisabled()));await dialog.getByRole('button',{name:'确认更新 RMA',exact:true}).click();await page.getByText('已保存 1 条转仓升级更新。',{exact:true}).waitFor();assert.equal(transfer('OLD-PREVIEW').data.rma,'UI-READONLY-RMA');await page.screenshot({path:path.join(run,'page-permitted-rma-saved.png'),fullPage:true,animations:'disabled'});pageChecks.push('反向采购允许/物流自身禁止时实际上传及确认RMA成功，只更新原目标记录');
  assert.deepEqual(pageErrors,[]);await browser.close();browser=null;
 }
 source=await archived('一团','REPEATED-CANCEL-TEMPLATE','S2-TONER','REPEATED-CANCEL-FN');
 for(let n=0;n<2;n++){
  const w=(await api('/api/upgrades/relocation-work-items','operation-1',{inquiryId:source.id,requestId:rid()})).workItem;
  await api('/api/upgrades/relocation-work-items/'+w.id+'/cancel','operation-1',{reason:'repeat cancellation '+n,expectedRevision:w.revision,requestId:rid()});
 }
 await api('/api/upgrades/relocation-work-items','operation-1',{inquiryId:source.id,requestId:rid()});
 const repeated=await download('/api/upgrades/relocation-update/export?source=inquiry:'+source.id,'logistics','two-identical-histories-and-current.xlsx');
 const historyRows=repeated.workbook['移仓升级'].filter(row=>row?.[9]==='已取消');assert.equal(historyRows.length,2);assert.deepEqual(historyRows[0],historyRows[1]);
 before=snapshot();p=await upload('/api/upgrades/relocation-update/preview',await fs.readFile(repeated.file),'repeated-history-unchanged.xlsx');assert.deepEqual(p.errors,[]);assert.equal(p.unchangedCount,3);assert(!p.previewToken);assert.equal(snapshot(),before);
 const duplicateCells=Object.fromEntries(historyRows[0].map((value,col)=>[String.fromCharCode(65+col)+'6',value]));
 p=await upload('/api/upgrades/relocation-update/preview',await edit(repeated.file,duplicateCells,'extra-repeated-history.xlsx'),'extra-history.xlsx');assert(p.errors.some(e=>/多行对应/.test(e.message)));assert(!p.previewToken);assert.equal(snapshot(),before);
 check('S2-02两条19列完全相同取消历史加当前行原样回导3条unchanged；超过实际历史数量的额外重复行仍拒绝');
 db.assertInventoryInvariants();assert.deepEqual(sql('PRAGMA foreign_key_check'),[]);assert.equal(sql('PRAGMA integrity_check')[0].integrity_check,'ok');
 check('隔离库存恒等式、外键、SQLite完整性通过，schema38不变');
}catch(error){failure=error.stack;throw error;}finally{
 await fs.writeFile(path.join(run,'result.json'),JSON.stringify({source:root,webDist:process.env.ASTER_WEB_DIST??null,state,base,checks,pageChecks,evidence,files,failure,realERP:false,productionWrites:0,at:new Date().toISOString()},null,2));
 await browser?.close();
 if(child?.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}db.close();await fs.writeFile(path.join(run,'server.log'),log);console.log('SECOND_BACKEND_RESULT '+run);
}
