// 06/07 repair acceptance. Synthetic configuration is installed before business imports.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { freePort, createTestInstanceId, waitForOwnedServer } from './test-server-ownership.mjs';
import { writeSyntheticTransitWorkbook } from './fixtures/generate-synthetic-workbook.mjs';

const root = path.resolve(import.meta.dirname, '..');
const parent = process.env.ASTER_ACCEPTANCE_OUTPUT || path.resolve(root, '../outputs/full-audit-20261021/repair-acceptance/inbound');
await fs.mkdir(parent, { recursive: true });
const out = await fs.mkdtemp(path.join(parent, 'run-'));
const state = path.join(out, 'state');
await fs.mkdir(state, { recursive: true });
const runtime = path.join(state, 'runtime.synthetic.json'), accounts = path.join(state, 'accounts.synthetic.json');
await fs.writeFile(runtime, JSON.stringify({ schemaVersion: 1, overseasWarehouses: ['SyntheticWarehouseA', 'SyntheticWarehouseB'] }));
await fs.writeFile(accounts, JSON.stringify({ accounts: [{ account: 'AUS', shortName: 'SYNTH', room: 'SYNTH-101' }] }));
process.env.ASTER_RUNTIME_CONFIG = runtime;
process.env.ASTER_WAREHOUSE_ACCOUNTS = accounts;
process.env.ASTER_OVERSEAS_WAREHOUSES = 'SyntheticWarehouseA;SyntheticWarehouseB';
const { createInventoryDatabase, InventoryDatabase, transitSourceTeam, validateTransitImportRows } = await import('../inventory-db.mjs');
const { transferWorkbook, transferSample } = await import('./fixtures/transfer-workbook.mjs');
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite'), seedCatalogData: false });
const db = new InventoryDatabase(state), rid = () => crypto.randomUUID();
const checks = [], evidence = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
const snapshot = () => JSON.stringify(Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name}) => [name, db.db.prepare('SELECT * FROM "' + name + '"').all()])));
const port = await freePort(), base = `http://127.0.0.1:${port}`, instanceId = createTestInstanceId('repair-inbound');
const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ASTER_STATE_ROOT: state, HOST: '127.0.0.1', PORT: String(port), PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId } });
let logs = '', failure;
child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
const headers = ['ITEM','订单数量','套/箱','FNSKU','发货方式','计划号','出货时间','团队','版本号'];
const source = (overrides = {}) => ({ model:'REPAIR-INK-DEPT',quantity:30,packPerBox:'10',fnsku:'REPAIR-FNSKU',shippingMethod:'SyntheticWarehouseA',plan:'REPAIR-DEPT',date:'2026-10-01',team:'一团三部',version:'V1',...overrides });
const csv = rows => Buffer.from([headers, ...rows.map(r => [r.model,r.quantity,r.packPerBox,r.fnsku,r.shippingMethod,r.plan,r.date,r.team,r.version])].map(r => r.join(',')).join('\n'));
async function api(route, role = 'admin', body, status = 200) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-role':role, 'content-type':'application/json' }, body:body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); evidence.push({route,role,status:response.status,data});
  assert.equal(response.status,status,JSON.stringify(data)); return data;
}
async function preview(rows, { role='assistant-1', name='合成墨盒.csv', buffer=csv(rows), route='/api/transit/preview', status=200 } = {}) {
  const response = await fetch(base + route, { method:'POST',headers:{'x-role':role,'x-file-name':encodeURIComponent(name)},body:buffer });
  const data = await response.json(); evidence.push({route,role,name,status:response.status,data});assert.equal(response.status,status,JSON.stringify(data));return data;
}
const importBody = p => ({previewToken:p.previewToken,fileName:p.fileName,fileHash:p.fileSha256,templateHash:p.templateSha256,rows:p.rows,requestId:rid()});
async function importRows(rows, options={}) { const p = await preview(rows, options); assert.equal(p.validation.canImport,true,JSON.stringify(p)); return api('/api/transit/import',options.role ?? 'assistant-1',importBody(p)); }
function oldPreview(rows, label) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.db.prepare('INSERT INTO transit_preview_tokens(token_hash,database_id,kind,role,file_name,file_sha256,template_sha256,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(crypto.createHash('sha256').update(token).digest('hex').toUpperCase(),db.syncState().databaseId,'import','assistant-1','合成墨盒.csv','old-'+label,'synthetic-template',JSON.stringify({rows}),new Date().toISOString(),new Date(Date.now()+60000).toISOString());
  return {previewToken:token,fileName:'合成墨盒.csv',fileHash:'old-'+label,templateHash:'synthetic-template',rows,requestId:rid()};
}
try {
  await waitForOwnedServer({base,child,instanceId});
  assert.deepEqual(['一团','二团','一团三部','一团四部'].map(transitSourceTeam),['一团','二团','一团','']);
  const good = source(), xlsx = path.join(out,'一团三部-墨盒.xlsx');
  await writeSyntheticTransitWorkbook(xlsx,{rows:[good],sheetName:'普通在途',includeTitle:false});
  const p = await preview([good],{name:path.basename(xlsx),buffer:await fs.readFile(xlsx)});
  assert.equal(p.validation.canImport,true); assert.equal(p.rows[0].data.team,'一团三部');
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM transit_batches').get().n,0);
  const body = importBody(p), imported = await api('/api/transit/import','assistant-1',body), t = imported.rows[0];
  const beforeReplay = snapshot(); assert.equal((await api('/api/transit/import','assistant-1',body)).deduped,true); assert.equal(snapshot(),beforeReplay);
  assert.equal(db.getTransit(t.id).team,'一团三部');
  for (const role of ['operation-1','assistant-1']) {
    const c = await api('/api/inventory/catalog',role); assert.equal(c.models.find(r=>r.model===good.model).inTransit,30);assert.equal(c.inTransitDetails[good.model][0].team,'一团三部');
  }
  for (const role of ['operation-2','assistant-2']) assert.ok(!(await api('/api/inventory/catalog',role)).models.some(r=>r.model===good.model));
  assert.equal((await api('/api/transit/imports','assistant-1')).imports.find(r=>r.id===imported.importId).rowCount,1);
  assert.ok(!(await api('/api/transit/imports','assistant-2')).imports.some(r=>r.id===imported.importId));
  const inquiry = {model:good.model,quantity:10,department:'一团',store:'REPAIRUS',operator:'合成运营',fnsku:good.fnsku,asin:'REPAIR0001',requestId:rid()};
  assert.ok((await api('/api/inquiries','operation-1',inquiry)).record.id);
  await api('/api/inquiries','operation-2',{...inquiry,department:'二团',requestId:rid()},403);
  check('06 XLSX预览和确认保留一团三部；一团可读/建询库，二团不可读/使用；请求重放不重复导入');

  const statusBuffer=Buffer.from('计划号,物流状态\n'+good.plan+',已到港');
  const status = await preview([],{name:'物流.csv',buffer:statusBuffer,route:'/api/transit/status/preview'});
  assert.equal(status.canApply,true);
  const foreignStatus=await preview([],{role:'assistant-2',name:'物流.csv',buffer:statusBuffer,route:'/api/transit/status/preview'});assert.equal(foreignStatus.canApply,false);
  await api('/api/transit/status/apply','assistant-1',{previewToken:status.previewToken,fileName:status.fileName,fileHash:status.fileSha256,templateHash:status.templateSha256,rows:status.rows,requestId:rid()});
  const shelfBody={expectedRevision:db.getTransit(t.id).revision,yes:'YES',requestId:rid()};
  let before=snapshot(); await api(`/api/transit/${t.id}/on-shelf`,'assistant-2',shelfBody,403);assert.equal(snapshot(),before);
  const shelf=await api(`/api/transit/${t.id}/on-shelf`,'assistant-1',shelfBody);
  before=snapshot();assert.equal((await api(`/api/transit/${t.id}/on-shelf`,'assistant-1',shelfBody)).deduped,true);assert.equal(snapshot(),before);
  const stock=db.db.prepare('SELECT * FROM stock_batches WHERE batch_key=?').get(shelf.batchKey);assert.equal(stock.source_team,'一团');assert.equal(db.getTransit(t.id).team,'一团三部');assert.deepEqual([...db.stockBatchSourceTeams().get(stock.batch_key)],['一团']);
  const c=await api('/api/inventory/catalog','operation-1'),m=c.models.find(r=>r.model===good.model);assert.deepEqual([m.inStock,m.inTransit,m.available],[30,0,30]);assert.equal(c.stockDetails[good.model][0].sourceTeam,'一团');
  assert.ok(!(await api('/api/inventory/catalog','operation-2')).models.some(r=>r.model===good.model));
  const alloc={model:good.model,sourceBatchKey:shelf.batchKey,plan:good.plan,date:good.date,version:good.version,quantity:10,department:'一团',store:'REPAIRUS',operator:'合成运营',fnsku:good.fnsku,asin:'REPAIR0002',requestId:rid()};
  await api('/api/allocations','operation-2',{...alloc,department:'二团',requestId:rid()},403);
  let a=(await api('/api/allocations','operation-1',alloc)).record;
  a=(await api(`/api/allocations/${a.id}/review`,'business',{decision:'approve',approvedQuantity:10,expectedRevision:a.revision,requestId:rid()})).record;
  a=(await api(`/api/allocations/${a.id}/alan-review`,'alan',{alanQuantity:10,expectedRevision:a.revision,requestId:rid()})).record;
  const confirm={expectedRevision:a.revision,requestId:rid()};await api(`/api/allocations/${a.id}/confirm`,'assistant-1',confirm);
  before=snapshot();assert.equal((await api(`/api/allocations/${a.id}/confirm`,'assistant-1',confirm)).deduped,true);assert.equal(snapshot(),before);assert.deepEqual(db.getBalance(shelf.batchKey),{base:30,onHand:20,locked:0,available:20});
  check('06 一团助理更新物流并上架30，一团运营调拨10完成；原部门不改、来源归一团；跨团拒绝和上架/发货重放均无额外入账');

  const fbaSource=source({model:'REPAIR-FBA-DEPT',plan:'FBA-DEPT',shippingMethod:'直发FBA'});
  const fbaImport=await importRows([fbaSource],{name:'直发FBA墨盒.csv'}),fbaTransit=fbaImport.rows[0];
  const fbaShelf=await api(`/api/transit/${fbaTransit.id}/on-shelf`,'assistant-1',{yes:'YES',expectedRevision:fbaTransit.revision,requestId:rid()});
  assert.equal(fbaShelf.disposition,'fba_archive');assert.equal(db.db.prepare('SELECT team FROM fba_archives WHERE id=?').get(fbaShelf.fbaArchiveId).team,'一团三部');
  assert.ok((await api('/api/upgrades','operation-1')).relocationCandidates.some(r=>r.fbaArchiveId===fbaShelf.fbaArchiveId&&r.department==='一团三部'));
  assert.ok(!(await api('/api/upgrades','operation-2')).relocationCandidates.some(r=>r.fbaArchiveId===fbaShelf.fbaArchiveId));
  await api('/api/upgrades/relocation-work-items','operation-2',{fbaArchiveId:fbaShelf.fbaArchiveId,account:'AUS',requestId:rid()},403);
  let work=(await api('/api/upgrades/relocation-work-items','operation-1',{fbaArchiveId:fbaShelf.fbaArchiveId,account:'AUS',requestId:rid()})).workItem;
  work=(await api(`/api/upgrades/relocation-work-items/${work.id}/procurement`,'logistics',{rma:'REPAIR-FBA-RMA',relocationAddress:'Synthetic contact\n12000 Magnolia Ave\nRiverside, CA 92503 US',expectedRevision:work.revision,requestId:rid()})).workItem;
  work=(await api(`/api/upgrades/relocation-work-items/${work.id}/operation`,'operation-1',{removalOrderNo:'REPAIR-FBA-ORDER',expectedRevision:work.revision,requestId:rid()})).workItem;
  db.syncRelocationLogistics({id:work.id,role:'logistics',shipments:[{externalId:'REPAIR-FBA-PACK',storeId:'synthetic-removal',storeName:'A-US 美国',orderNo:'REPAIR-FBA-ORDER',fnsku:fbaSource.fnsku,quantity:10,carrier:'SyntheticCarrier',trackingNo:'REPAIR-TRACK',shipDate:'2026-10-02'}],capturedAt:new Date().toISOString(),requestId:rid()});
  work=db.getRelocationWorkItem(work.id);const relocation=db.getUpgrade(work.upgradeId).relocations[0];
  await api(`/api/upgrades/relocations/${relocation.id}/complete`,'purchasing',{completedQuantity:10,inProgressQuantity:0,newVersion:'FBA-V2',targetWarehouse:'SyntheticWarehouseB',expectedRevision:relocation.revision,requestId:rid()});
  const fbaBatch=db.db.prepare("SELECT batch_key,source_team,pack_per_box FROM stock_batches WHERE model=? AND version='FBA-V2'").get(fbaSource.model);assert.equal(fbaBatch.source_team,'一团');assert.equal(fbaBatch.pack_per_box,'10');assert.equal(db.getBalance(fbaBatch.batch_key).onHand,10);
  assert.equal((await api('/api/inventory/catalog','operation-1')).models.find(r=>r.model===fbaSource.model).inStock,10);
  assert.ok(!(await api('/api/inventory/catalog','operation-2')).models.some(r=>r.model===fbaSource.model));
  check('06 一团三部直发FBA保留原部门，一团可发起移仓、物流更新、合成包裹发10并完成回库10；箱规继承10且仍只归一团');

  for (const [index,pack] of ['',0,'abc','2.5'].entries()) {
    const bad=source({model:'REPAIR-BAD-'+index,plan:'BAD-'+index,quantity:20,packPerBox:pack});
    before=snapshot();const invalid=await preview([bad]);assert.equal(invalid.validation.canImport,false);assert.ok(!invalid.previewToken);assert.ok(invalid.validation.errors.some(e=>e.code==='invalid_pack_per_box'&&e.row===2&&e.field==='套/箱'));assert.equal(snapshot(),before);
    await api('/api/transit/import','assistant-1',importBody(invalid),400);assert.equal(snapshot(),before);
    const legacy=oldPreview([{sourceRow:2,data:bad}],String(index));before=snapshot();const denied=await api('/api/transit/import','assistant-1',legacy,422);assert.equal(denied.code,'transit_import_validation_failed');assert.equal(denied.details.errors[0].row,2);assert.equal(snapshot(),before);
    assert.throws(()=>db.createTransitPreviewToken({kind:'import',role:'assistant-1',fileName:'合成墨盒.csv',fileHash:'blocked-'+index,templateHash:'synthetic',payload:{rows:[{sourceRow:2,data:bad}]}}),e=>e.status===422);
  }
  check('07 普通箱规空/0/文字/小数预览均报源行2且不签token；直调确认及旧签发token同样拒绝，全库无部分写入');
  const mixed=await preview([source({plan:'MIX-GOOD'}),source({plan:'MIX-BAD',packPerBox:'0'})]);assert.equal(mixed.validation.canImport,false);assert.ok(mixed.validation.errors.some(e=>e.row===3&&e.code==='invalid_pack_per_box'));assert.ok(!mixed.previewToken);
  const unknown=await preview([source({team:'一团四部'})],{role:'admin'});assert.equal(unknown.validation.canImport,false);assert.ok(unknown.validation.errors.some(e=>e.row===2&&e.code==='unsupported_transit_team'));
  const unknownBody=oldPreview([{sourceRow:2,data:source({team:'一团四部'})}],'unknown');before=snapshot();await api('/api/transit/import','assistant-1',unknownBody,403);assert.equal(snapshot(),before);
  check('06/07 混合文件一行箱规错误阻止整批；未确认的一团四部按源行提示，不按前缀猜归属');

  const additive=source({model:'REPAIR-REAL-ADDITIVE',plan:'ADDITIVE',quantity:40,packPerBox:'10'});
  const first=await importRows([additive],{name:'真实新增40-墨盒.csv'}),second=await importRows([additive],{name:'另一次真实新增40-墨盒.csv',buffer:Buffer.concat([csv([additive]),Buffer.from('\r\n')])});
  assert.equal(first.rows[0].id,second.rows[0].id);assert.equal(db.getTransit(first.rows[0].id).quantity,80);assert.equal(db.getTransit(first.rows[0].id).remaining_quantity,80);assert.equal(db.getTransit(first.rows[0].id).team,'一团三部');
  const s2=await api(`/api/transit/${first.rows[0].id}/on-shelf`,'assistant-1',{yes:'YES',expectedRevision:db.getTransit(first.rows[0].id).revision,requestId:rid()});assert.equal(db.getBalance(s2.batchKey).onHand,80);
  const invalidMultiple={...alloc,model:additive.model,sourceBatchKey:s2.batchKey,plan:additive.plan,quantity:15,requestId:rid()};before=snapshot();await api('/api/allocations','operation-1',invalidMultiple,400);assert.equal(snapshot(),before);
  check('已确认真实新增40+40累计80仍可合并上架；正整数箱规10保留，调拨15仍被整箱倍数校验拒绝');

  // Compatibility fixture represents a response saved by the former implementation.
  const replayRows=[{sourceRow:2,data:source({plan:'LEGACY-REPLAY',packPerBox:''})}], replayPayload={role:'assistant-1',previewToken:'already-consumed',fileName:'旧成功墨盒.csv',fileHash:'old-success',templateHash:'old-template',rows:replayRows};
  const replayId=rid();db.idempotent('transit:import',replayId,replayPayload,()=>({ok:true,importId:999999,rowCount:1,rows:[]}));before=snapshot();assert.equal((await api('/api/transit/import','assistant-1',{...replayPayload,requestId:replayId})).deduped,true);assert.equal(snapshot(),before);
  check('07 新校验不阻断旧成功请求按原键确认回执，也不重做入账');

  const transferRows=[{sourceRow:4,data:{model:good.model,source:'第三方海外仓',plan:'TRANSFER-EMPTY-PACK',date:'2026-10-01',version:'T1',fnsku:'TRANSFER-FNSKU',returnQuantity:'7',warehouse:'SyntheticWarehouseA',store:'TRANSFERUS'}}];
  const transferFile=transferWorkbook([[good.model,'第三方海外仓','TRANSFER-EMPTY-PACK','2026-10-01','T1','TRANSFER-FNSKU',7,'SyntheticWarehouseA','TRANSFERUS',...transferSample.slice(9)]]);
  const tp=await preview([],{role:'logistics',name:'转仓.xlsx',buffer:transferFile,route:'/api/transfer-upgrades/preview'});assert.ok(tp.previewToken);
  await api('/api/transfer-upgrades/import','logistics',importBody(tp));
  let tr=db.getTransferUpgrades().find(r=>r.data.plan==='TRANSFER-EMPTY-PACK');
  for (const [stage,fields] of [['rma',{rma:'REPAIR-RMA'}],['count',{countedQuantity:'7'}],['progress',{inProgressQuantity:'0',completedQuantity:'7',completedVersion:'T2'}]]) {
    const rows=[{sourceRow:4,data:{documentNo:tr.documentNo,revision:tr.revision,stage,...fields}}],fileName='合成转仓更新.xlsx',fileHash='synthetic-'+rid(),templateHash='synthetic-template';
    const proof=db.createTransitPreviewToken({kind:'transfer_update',role:'logistics',fileName,fileHash,templateHash,payload:{rows}});
    db.updateTransferUpgrades({role:'logistics',stage,previewToken:proof.token,fileName,fileHash,templateHash,rows,requestId:rid()});tr=db.getTransferUpgrades().find(r=>r.id===tr.id);
  }
  assert.equal(tr.receiptBatches[0].quantity,7);const transferKey=tr.receiptBatches[0].batchKey;assert.equal(db.db.prepare('SELECT pack_per_box FROM stock_batches WHERE batch_key=?').get(transferKey).pack_per_box,null);
  for (const [role,department] of [['operation-1','一团'],['operation-2','二团']]) {const cv=await api('/api/inventory/catalog',role);assert.ok(cv.stockDetails[good.model].some(r=>r.batchKey===transferKey&&r.quantity===7&&r.isPublic));before=snapshot();await api('/api/allocations',role,{...alloc,sourceBatchKey:transferKey,plan:'TRANSFER-EMPTY-PACK',version:'T2',quantity:1,department,requestId:rid()},400);assert.equal(snapshot(),before);}
  check('07 转仓仍可空箱规导入并完成7件公共入库，两团可见；箱规未补前两团调拨仍拒绝，不默认1');
  assert.deepEqual(validateTransitImportRows([{sourceRow:2,data:source({packPerBox:'10'})}]),[]);
  db.assertInventoryInvariants();
  await fs.writeFile(path.join(out,'catalog-final.json'),JSON.stringify({global:db.getCatalog(),one:db.getCatalog({visibleGroup:'一团'}),two:db.getCatalog({visibleGroup:'二团'})},null,2));
  console.log('INBOUND_REPAIR_PASS '+checks.length+' '+out);
} catch (error) {failure=error.stack;console.error(failure);process.exitCode=1;}
finally {
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify({checks,failure,evidence,base,state,databaseId:db.syncState().databaseId,configuration:{runtime,accounts},candidate:{inventory:path.join(root,'inventory-db.mjs'),server:path.join(root,'server.mjs')},realErp:false},null,2));
  await fs.writeFile(path.join(out,'server.log'),logs);if(child.exitCode===null){child.kill();await once(child,'exit');}db.close();
}
