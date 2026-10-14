// Original-template acceptance. All writes use an isolated synthetic database and files.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {InventoryDatabase,createInventoryDatabase,ROLES} from '../inventory-db.mjs';
import {transferWorkbook,transferSample} from './fixtures/transfer-workbook.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from './test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'..'),out=process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/upgrade-template');
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-original-template-'));
await fs.mkdir(out,{recursive:true});createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});
const db=new InventoryDatabase(state),port=await freePort(),base='http://127.0.0.1:'+port,checks=[],files=[];
const python=process.env.ASTER_TEST_PYTHON||'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const rid=()=>crypto.randomUUID(),common=r=>({expectedRevision:r.revision,requestId:rid()});
const address='Supplier (RMA#: 000012)\n12000 Magnolia Ave, Suite#101\nRiverside, CA 92503 US\nTEL:555000000';
const snapshot=()=>JSON.stringify(['transfer_upgrade_rows','transfer_upgrade_imports','upgrade_relocation_work_items','upgrade_relocations','stock_batches','inventory_ledger','upgrade_inventory_ledger','document_events','idempotency_requests'].map(t=>db.db.prepare('SELECT * FROM '+t).all()));
const check=name=>{checks.push(name);console.log('PASS '+name);};
let child,serial=0,failure;
async function api(url,body,role='logistics',status=200){const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;}
async function preview(file,kind='transfer',stage='rma',status=200,role='logistics'){
  const r=await fetch(base+(kind==='transfer'?'/api/transfer-upgrades/update/preview?stage='+stage:'/api/upgrades/relocation-update/preview'),{method:'POST',headers:{'x-role':role,'x-file-name':encodeURIComponent(path.basename(file))},body:await fs.readFile(file)});
  const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;
}
const payload=p=>({previewToken:p.previewToken,fileName:p.fileName,fileHash:p.fileSha256,templateHash:p.templateSha256,rows:p.rows,requestId:rid()});
async function commit(p,kind='transfer',status=200,body=payload(p)){
  const before=snapshot(),j=await api(kind==='transfer'?'/api/transfer-upgrades/update/import?stage='+p.stage:'/api/upgrades/relocation-update/import',body,'logistics',status);
  if(status!==200)assert.equal(snapshot(),before);return j;
}
function inspect(file,waybill=false){
  return JSON.parse(execFileSync(python,['-X','utf8',path.join(root,'scripts/fixtures/check-upgrade-template.py'),file,process.env.ASTER_UPGRADE_TEMPLATE||'',waybill?'waybill':'ordinary'],{encoding:'utf8',windowsHide:true}));
}
async function download(url,method='GET'){
  const r=await fetch(base+url,{method,headers:{'x-role':'logistics'}});assert.equal(r.status,200,await(!r.ok?r.text():Promise.resolve('')));
  const file=path.join(out,`export-${++serial}.xlsx`);await fs.writeFile(file,Buffer.from(await r.arrayBuffer()));
  const layout=inspect(file,method==='POST');files.push({file,layout});return file;
}
async function edit(file,instructions){
  const target=path.join(out,`edited-${++serial}.xlsx`);
  execFileSync(python,['-X','utf8','-c',`import openpyxl,json,sys,datetime
from openpyxl.utils.datetime import CALENDAR_MAC_1904
w=openpyxl.load_workbook(sys.argv[1]);s=w.active;a=json.loads(sys.argv[3]);start=3 if s.title=='移仓升级' else 4
if a.get('date1904'): w.epoch=CALENDAR_MAC_1904
rows=[[c.value for c in r] for r in s.iter_rows(min_row=start)]
if 'only' in a: rows=[r for r in rows if r[2] in a['only']]
if a.get('reverse'): rows.reverse()
if a.get('duplicate'): rows.append(list(rows[0]))
for r in rows:
 for k,v in a.get('plans',{}).get(r[2],{}).items():
  while len(r)<int(k):r.append(None)
  r[int(k)-1]=v
 if a.get('dates'):r[3]=datetime.datetime(2026,10,10)
s.delete_rows(start,s.max_row)
for n,values in enumerate(rows,start):
 for c,v in enumerate(values,1):s.cell(n,c).value=v
if a.get('note'):s['A1']='不得添加说明'
if a.get('unmerge'):
 for m in list(s.merged_cells.ranges):s.unmerge_cells(str(m))
w.save(sys.argv[2])`,file,target,JSON.stringify(instructions)],{windowsHide:true});
  return target;
}
function makeRelocation(plan,model='SYNTH-TONER-001'){
  let r=db.createInquiry({role:'operation-1',model,quantity:100,department:'一团',store:'AUS',operator:'隔离模板验收',fnsku:'000012',asin:'BTEST001',requestId:rid()}).record;
  r=db.reviewInquiry({id:r.id,role:'business',decision:'approve',approvedQuantity:100,...common(r)}).record;
  r=db.replyInquiry({id:r.id,role:'purchasing',supplierQuantity:100,shippingWarehouse:'CA',...common(r)}).record;
  r=db.archiveInquiry({id:r.id,role:model==='SYNTH-INK-001'?'purchasing':'assistant-1',plan,date:'2026-10-10',version:'001',...common(r)}).record;
  return db.initiateRelocationUpgrade({role:'operation-1',inquiryId:r.id,sourceRevision:r.revision,requestId:rid()}).workItem;
}
async function makeTransfers(plans){
  const rows=plans.map(([plan,quantity])=>{const r=[...transferSample];r[0]='SYNTH-INK-001';r[2]=plan;r[3]='2026-10-10';r[4]='001';r[5]='000012';r[6]=quantity;return r;});
  const r=await fetch(base+'/api/transfer-upgrades/preview',{method:'POST',headers:{'x-role':'logistics','x-file-name':encodeURIComponent('合成首次.xlsx')},body:transferWorkbook(rows)}),p=await r.json();assert.equal(r.status,200);assert.deepEqual(p.errors,[]);await api('/api/transfer-upgrades/import',payload(p));
}
const relocationExport=w=>'/api/upgrades/relocation-update/export?'+new URLSearchParams({source:'inquiry:'+w.inquiryId});
const transferExport='/api/transfer-upgrades/update/export',relocationTemplate='/api/upgrades/relocation-update/template';
const transferRecord=plan=>db.getTransferUpgrades().find(r=>r.data.plan===plan);
async function rejected(file,kind,pattern,stage='rma'){
  const before=snapshot(),p=await preview(file,kind,stage);assert(!p.previewToken);assert(p.errors.some(e=>pattern.test(e.message)),JSON.stringify(p));assert.equal(snapshot(),before);return p;
}
try{
  const a=makeRelocation('000PLAN-A'),b=makeRelocation('000PLAN-B');
  const instanceId=createTestInstanceId('original-template');child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'pipe',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});child.stderr.on('data',d=>process.stderr.write(d));await waitForOwnedServer({base,child,instanceId});
  await makeTransfers([['000TRANSFER-A',100],['000TRANSFER-B',0]]);
  const rf=await download(relocationExport(a)),rt=await download(relocationTemplate),tf=await download(transferExport);
  for(const stage of ['rma','count','progress'])await download('/api/transfer-upgrades/update/template?stage='+stage);
  for(const [file,kind,count]of [[rf,'relocation',1],[rt,'relocation',2],[tf,'transfer',2]]){const before=snapshot(),p=await preview(file,kind);assert.deepEqual(p.errors,[]);assert.equal(p.unchangedCount,count);assert.equal(p.rows.length,0);assert(!p.previewToken);assert.equal(snapshot(),before);}
  check('所有普通导出与三阶段模板保持19/15列、空首行、原表头合并与样式；零记录模板无示例；原样回导不产生变更');
  for(const date1904 of [false,true]){
    const p=await preview(await edit(tf,{dates:true,date1904}));assert.deepEqual(p.errors,[]);assert.equal(p.unchangedCount,2);
    const q=await preview(await edit(rf,{dates:true,date1904}),'relocation');assert.deepEqual(q.errors,[]);assert.equal(q.unchangedCount,1);
  }
  assert.equal(inspect(tf).rows[0][5],'000012');assert.equal(inspect(tf).rows[0][4],'001');assert.equal(inspect(tf).rows[1][6],0);assert.equal(inspect(tf).rows[1][11],null);
  check('1900/1904日期单元格可回导；计划号、业务版本与FNSKU前导零、空白和真实0保持不同');
  let rp=await preview(await edit(rt,{reverse:true,plans:{'000PLAN-A':{11:'000RMA-A',12:address},'000PLAN-B':{11:'000RMA-B',12:address}}}),'relocation');assert.deepEqual(rp.errors,[]);assert.equal(rp.rows[0].data.workNo,b.workNo);assert.equal(rp.rows[1].data.workNo,a.workNo);const rbody=payload(rp);assert.equal((await commit(rp,'relocation',200,rbody)).rowCount,2);assert((await commit(rp,'relocation',200,rbody)).deduped);
  let tp=await preview(await edit(tf,{reverse:true,plans:{'000TRANSFER-A':{11:'000RMA-A'},'000TRANSFER-B':{11:'000RMA-B'}}}));assert.deepEqual(tp.errors,[]);assert.equal(tp.rows[0].data.documentNo,transferRecord('000TRANSFER-B').documentNo);const tbody=payload(tp);await commit(tp,'transfer',200,tbody);assert((await commit(tp,'transfer',200,tbody)).deduped);
  check('移仓与转仓调换行顺序后按业务资料更新正确原单；内部单号及预览版本仍在；重复确认只办理一次');
  const counts=await download('/api/transfer-upgrades/update/template?stage=count');
  await rejected(await edit(counts,{plans:{'000TRANSFER-A':{12:101},'000TRANSFER-B':{12:0}}}),'transfer',/数量/,'count');
  tp=await preview(await edit(counts,{plans:{'000TRANSFER-A':{12:80},'000TRANSFER-B':{12:0}}}),'transfer','count');assert.deepEqual(tp.errors,[]);await commit(tp);
  assert.equal(transferRecord('000TRANSFER-B').data.countedQuantity,'0');assert.equal(transferRecord('000TRANSFER-A').receiptBatches.length,0);
  await download('/api/transfer-upgrades/update/template?stage=progress');check('转仓阶段与数量上限保留；一行非法整批无写入；清点0是实际值且不新增库存');
  const fresh=await download(transferExport),oldEdit=await edit(fresh,{only:['000TRANSFER-A'],plans:{'000TRANSFER-A':{11:'OLDER-FILE-EDIT'}}});
  let newer=await preview(await edit(fresh,{only:['000TRANSFER-A'],plans:{'000TRANSFER-A':{11:'CURRENT-RMA'}}}));await commit(newer);
  const oldPreview=await preview(oldEdit);assert.deepEqual(oldPreview.errors,[]);assert.equal(oldPreview.rows[0].before.rma,'CURRENT-RMA');assert.equal(oldPreview.rows[0].after.rma,'OLDER-FILE-EDIT');
  newer=await preview(await edit(await download(transferExport),{only:['000TRANSFER-A'],plans:{'000TRANSFER-A':{11:'LATEST-RMA'}}}));await commit(newer);await commit(oldPreview,'transfer',409);
  check('旧文件不伪装成导出版本校验：预览展示最新系统值与文件值；预览后再变化，内部版本冲突拒绝提交');
  const current=await download(transferExport);
  for(const [instructions,pattern]of [[{plans:{'000TRANSFER-A':{1:'NO-SUCH-MODEL'}}},/未找到/],[{duplicate:true},/多行对应/],[{plans:{'000TRANSFER-A':{16:'新增字段'}}},/15列之外/]])await rejected(await edit(current,instructions),'transfer',pattern);
  for(const instructions of [{note:true},{unmerge:true}])await preview(await edit(current,instructions),'transfer','rma',422);
  await makeTransfers([['DUPLICATE',7],['DUPLICATE',7]]);const duplicateFile=await download(transferExport),before=snapshot();const dup=await rejected(duplicateFile,'transfer',/匹配到 2 条独立转仓记录/);assert.deepEqual(dup.errors.map(e=>e.sourceRow),[4,5]);assert.equal(snapshot(),before);assert.equal(db.getTransferUpgrades().filter(r=>r.data.plan==='DUPLICATE').length,2);
  check('无匹配、文件重复行、原单重复匹配、额外列、说明行及错误合并均拒绝；重复独立转仓记录保留并报告具体行，整批不写入');
  const c=makeRelocation('ATOMIC-C'),d=makeRelocation('ATOMIC-D'),pending=await download(relocationTemplate);
  rp=await preview(await edit(pending,{plans:{'ATOMIC-C':{11:'RMA-C',12:address},'ATOMIC-D':{11:'RMA-D',12:address}}}),'relocation');assert.deepEqual(rp.errors,[]);
  db.recordRelocationProcurement({id:c.id,role:'logistics',rma:'OTHER',relocationAddress:address,...common(c)});await commit(rp,'relocation',409);assert.equal(db.getRelocationWorkItem(d.id).status,'awaiting_procurement');
  await rejected(await edit(await download(relocationExport(d)),{plans:{'ATOMIC-D':{13:'ORDER-FORBIDDEN'}}}),'relocation',/订单号/);
  makeRelocation('DUPLICATE-RELOCATION');makeRelocation('DUPLICATE-RELOCATION');await rejected(await download(relocationTemplate),'relocation',/匹配到 2 条移仓记录/);
  check('移仓只允许RMA和原始地址；订单号仍只读；预览后其中一单被修改整批回滚；业务资料重复的移仓行不默认选择');
  await preview(current,'transfer','rma',403,'admin');await preview(rf,'relocation','rma',403,'admin');
  const ink=makeRelocation('PRIVATE-INK','SYNTH-INK-001'),inkFile=await download(relocationExport(ink));
  const inkPreview=await preview(await edit(inkFile,{plans:{'PRIVATE-INK':{11:'RMA-PRIVATE',12:address}}}),'relocation');assert.deepEqual(inkPreview.errors,[]);
  const matrix={墨盒:Object.fromEntries(ROLES.map(role=>[role,{summary:true,detail:true,expand:true,actions:true}]))};matrix.墨盒.purchasing.detail=false;matrix.墨盒.logistics.detail=false;
  await fs.writeFile(path.join(state,'data/permissions.json'),JSON.stringify(matrix));
  await rejected(inkFile,'relocation',/有权访问/);await commit(inkPreview,'relocation',403);matrix.墨盒.purchasing.detail=true;matrix.墨盒.logistics.detail=true;await fs.writeFile(path.join(state,'data/permissions.json'),JSON.stringify(matrix));
  check('仅物流可更新，匹配范围遵守类目可见权限；无权记录不会参与匹配');
  let w=db.getRelocationWorkItem(a.id);w=db.recordRelocationOperation({id:w.id,role:'operation-1',removalOrderNo:'000ORDER',...common(w)}).workItem;
  const shipment=(trackingNo,quantity)=>({externalId:trackingNo,storeId:'lingxing-remove-inbound',storeName:'A-US 美国',countryCode:'US',orderNo:'000ORDER',fnsku:'000012',quantity,carrier:'UPS',trackingNo,shipDate:'2026-10-10'});
  const sync=rows=>db.syncRelocationLogistics({id:w.id,role:'logistics',shipments:rows,capturedAt:new Date().toISOString(),requestId:rid()});
  sync([shipment('000TRACK-1',5)]);
  const waybillUrl='/api/upgrades/relocation-waybills/export?'+new URLSearchParams({source:'inquiry:'+w.inquiryId,status:'all'});
  const waybill=await download(waybillUrl,'POST'),ordinary=await download(relocationExport(w));assert.deepEqual(inspect(waybill,true).rows,inspect(ordinary).rows);
  assert.equal((await preview(waybill,'relocation','rma',422)).code,'waybill_view_only');
  const renamed=await edit(waybill,{plans:{'000PLAN-A':{11:'RENAMED'}}});assert.equal((await preview(renamed,'relocation','rma',422)).code,'waybill_view_only');
  sync([shipment('000TRACK-2',7)]);const split=await download(waybillUrl,'POST'),values=inspect(split,true).rows;
  assert.deepEqual(values.map(r=>r[15]),[5,7]);assert.deepEqual([6,7,16,17].map(i=>values[1][i]),[null,null,null,null]);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM relocation_waybill_exports').get().n,0);
  check('单运单与普通导出逐格相同时仍由内部用途属性拒绝；改名、Excel库编辑保存后属性保留；拆行数量/首行汇总正确，生成文件不标记已导出');
  db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
}catch(error){failure=error.stack;throw error;}
finally{await fs.writeFile(path.join(out,'result.json'),JSON.stringify({state,base,checks,files,failure,productionWrites:0,realLingxing:false},null,2));if(child?.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}db.close();}
console.log('UPGRADE_TEMPLATE_PASS '+checks.length);
