import {restoreSchema32Fixture} from './fixtures/schema32-fixture.mjs';
// All writes target temporary SQLite and an owned random-port server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createInventoryDatabase,InventoryDatabase,migrateInventoryDatabaseToCurrent} from '../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from './test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'.test-output/inquiry-final-current');await fs.mkdir(out,{recursive:true});
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-procurement-api-')),databasePath=path.join(state,'data/aster-inventory.sqlite');
createInventoryDatabase({databasePath,seedCatalogData:false});let db=new InventoryDatabase(state),child;
const port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('procurement'),rid=()=>crypto.randomUUID(),checks=[],rejections=[];
const check=name=>{checks.push(name);console.log('PASS '+name);};
const snapshot=(connection=db.db)=>Object.fromEntries(connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,connection.prepare('SELECT * FROM "'+name+'"').all().map(r=>({...r})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
const stock=()=>({catalog:db.db.prepare('SELECT model,category,base_in_stock,in_transit FROM catalog_models ORDER BY model').all(),batches:snapshot().stock_batches,ledger:snapshot().inventory_ledger,upgradeLedger:snapshot().upgrade_inventory_ledger});
async function start(){child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});await waitForOwnedServer({base,child,instanceId});}
async function stop(){if(child?.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}child=null;}
async function api(route,role,body,status=200){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;}
async function ready(model,requested=7,approved=13){let r=(await api('/api/inquiries','operation-1',{model,quantity:requested,department:'一团',store:'PROCUS',operator:'隔离采购验收',fnsku:'PROC-FNSKU',asin:'BPROC001',operatorNote:'运营备注',requestId:rid()})).record;return (await api(`/api/inquiries/${r.id}/review`,'business',{decision:'approve',approvedQuantity:approved,businessNote:'商务备注',expectedRevision:r.revision,requestId:rid()})).record;}
const body=(r,q=7,w='CA',note='采购独立备注')=>({supplierQuantity:q,shippingWarehouse:w,procurementNote:note,expectedRevision:r.revision,requestId:rid()});
async function rejected(r,p,status,code,role='purchasing'){const before=snapshot(),result=await api(`/api/inquiries/${r.id}/reply`,role,p,status);assert.equal(result.code,code);assert.equal(result.ok,false);assert.deepEqual(snapshot(),before);rejections.push({quantity:p.supplierQuantity,warehouse:p.shippingWarehouse,code,allTablesUnchanged:true});}
let failure;
try{
 for(const [model,category]of [['PROC-TONER','硒鼓'],['PROC-INK','墨盒']])db.db.prepare('INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at) VALUES(?,?,0,0,?)').run(model,category,new Date().toISOString());
 assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,35);assert.ok(db.db.prepare('PRAGMA table_info(inquiry_documents)').all().some(c=>c.name==='procurement_note'&&c.notnull===1));check('新建v35库具有独立采购备注字段');
 await start();const beforeStock=stock(),a=await ready('PROC-TONER'),b=await ready('PROC-INK');
 for(const q of [0,7])for(const w of ['',null,'其他仓','ca','CA,SC'])await rejected(a,body(a,q,w),400,w?'invalid_shippingWarehouse':'missing_shippingWarehouse');
 for(const q of ['',null,-1,1.5])await rejected(a,body(a,q),400,q===''||q===null?'missing_supplier_quantity':'invalid_quantity');
 for(const w of ['', 'OTHER']){const before=snapshot();assert.throws(()=>db.replyInquiry({id:a.id,role:'purchasing',...body(a,0,w)}),e=>e.code===(w?'invalid_shippingWarehouse':'missing_shippingWarehouse'));assert.deepEqual(snapshot(),before);}
 check('0及正数必须选CA/SC，空值与其他仓库及非法数量前后端拒绝，失败所有表不变');
 for(const role of ['admin','business','operation-1','operation-2','assistant-1','assistant-2'])await rejected(a,body(a),403,'inquiry_action_forbidden',role);
 await rejected(a,{...body(a),expectedRevision:a.revision-1},409,'stale_revision');check('既有采购权限及记录版本检查保留');
 const pa=body(a,7,'CA','采购独立备注'),ra=(await api(`/api/inquiries/${a.id}/reply`,'purchasing',pa)).record;
 assert.equal((await api('/api/approvals','purchasing')).inquiries.find(r=>r.id===a.id).category,'硒鼓');assert.equal(ra.supplierQuantity,7);assert.equal(ra.requestedQuantity,7);assert.equal(ra.quantity,7);assert.equal(ra.approvedQuantity,7);assert.equal(ra.status,'pending_assistant');assert.equal(ra.procurementNote,pa.procurementNote);assert.equal(ra.businessNote,'商务备注');assert.equal(ra.operatorNote,'运营备注');assert.deepEqual(ra.events.at(-1).payload,{supplierQuantity:7,shippingWarehouse:'CA',procurementNote:pa.procurementNote});
 const originalEvents=ra.events.filter(e=>['entry','review'].includes(e.type));assert.deepEqual(originalEvents,db.getInquiry(a.id).events.filter(e=>['entry','review'].includes(e.type)));assert.equal(ra.events.find(e=>e.type==='review').payload.approvedQuantity,13);assert.equal(ra.events.find(e=>e.type==='entry').payload.requestedQuantity,7);
 const saved=snapshot();const concurrent=await Promise.all([api(`/api/inquiries/${a.id}/reply`,'purchasing',pa),api(`/api/inquiries/${a.id}/reply`,'purchasing',pa)]);assert.ok(concurrent.every(r=>r.deduped));assert.deepEqual(snapshot(),saved);await rejected(a,{...pa,procurementNote:'同键更改备注'},409,'idempotency_conflict');
 check('硒鼓CA非整箱7一次保存三字段，备注与其他备注分开；重复请求不多写，同键改备注冲突');
 const pb=body(b,0,'SC',''),rb=(await api(`/api/inquiries/${b.id}/reply`,'purchasing',pb)).record;assert.equal((await api('/api/approvals','purchasing')).inquiries.find(r=>r.id===b.id).category,'墨盒');assert.equal(rb.status,'rejected');assert.equal(rb.quantity,0);assert.equal(rb.approvedQuantity,0);assert.equal(rb.supplierQuantity,0);assert.equal(rb.requestedQuantity,0);assert.equal(rb.procurementNote,'');assert.equal(rb.shippingWarehouse,'SC');
 check('墨盒SC零回复和空备注成功，最终数量0并结束为已拒绝');
 for(const role of ['admin','purchasing','business','operation-1','assistant-1']){const rows=(await api('/api/approvals',role)).inquiries;assert.equal(rows.find(r=>r.id===a.id).procurementNote,pa.procurementNote);assert.equal(rows.find(r=>r.id===b.id).supplierQuantity,0);}
 await stop();db.close();db=new InventoryDatabase(state);await start();assert.equal((await api('/api/approvals','assistant-1')).inquiries.find(r=>r.id===a.id).procurementNote,pa.procurementNote);
 for(const r of [ra,rb]){if(r.id===rb.id){const before=snapshot();await api(`/api/inquiries/${r.id}/archive`,'purchasing',{plan:'ZERO',date:'2026-10-09',version:'V1',expectedRevision:r.revision,requestId:rid()},409);assert.deepEqual(snapshot(),before);assert.equal(db.getRelocationCandidates().some(c=>c.inquiryId===r.id),false);continue;}const archived=(await api(`/api/inquiries/${r.id}/archive`,'assistant-1',{plan:'PROC-PLAN-'+r.id,date:'2026-10-09',version:'V1',expectedRevision:r.revision,requestId:rid()})).record;assert.equal(archived.status,'archived');assert.equal(archived.procurementNote,r.procurementNote);assert.equal(archived.quantity,r.supplierQuantity);}
 assert.deepEqual(stock(),beforeStock);check('刷新跨角色、服务及数据库重启、助理归档均保留备注；最终数量沿用，实际库存不变');

 for(const model of ['PROC-TONER','PROC-INK'])for(const quantity of [60,80,120,0]){
  const source=await ready(model,100,80),history=source.events,metadata={createdByRole:source.createdByRole,createdAt:source.createdAt,reviewedByRole:source.reviewedByRole,reviewedAt:source.reviewedAt},p=body(source,quantity,quantity%2?'SC':'CA');
  const replied=(await api(`/api/inquiries/${source.id}/reply`,'purchasing',p)).record;
  for(const field of ['requestedQuantity','approvedQuantity','supplierQuantity','quantity'])assert.equal(replied[field],quantity,field);
  assert.deepEqual(replied.events.slice(0,-1),history);for(const [k,v]of Object.entries(metadata))assert.equal(replied[k],v,k);
  assert.deepEqual({...db.db.prepare('SELECT requested_quantity,approved_quantity,supplier_quantity FROM inquiry_documents WHERE id=?').get(source.id)},{requested_quantity:quantity,approved_quantity:quantity,supplier_quantity:quantity});
  const saved=snapshot();assert.equal((await api(`/api/inquiries/${source.id}/reply`,'purchasing',p)).deduped,true);assert.deepEqual(snapshot(),saved);assert.equal(replied.events.filter(e=>e.type==='reply').length,1);
  if(model==='PROC-INK'&&quantity===0){const before=snapshot();await api(`/api/inquiries/${source.id}/archive`,'purchasing',{plan:'ZERO',date:'2026-10-09',version:'V1',expectedRevision:replied.revision,requestId:rid()},409);assert.equal(replied.status,'rejected');assert.deepEqual(snapshot(),before);assert.equal(db.getRelocationCandidates().some(c=>c.inquiryId===source.id),false);continue;}
  const archived=(await api(`/api/inquiries/${source.id}/archive`,model==='PROC-INK'?'purchasing':'assistant-1',{plan:'FINAL-'+source.id,date:'2026-10-09',version:'V1',expectedRevision:replied.revision,requestId:rid()})).record;
  for(const field of ['requestedQuantity','approvedQuantity','supplierQuantity','quantity'])assert.equal(archived[field],quantity);
  const candidate=db.getRelocationCandidates({model}).find(c=>c.inquiryId===source.id);assert.equal(Boolean(candidate),quantity>0);if(candidate)assert.equal(candidate.initialQuantity,quantity);
 }
 check('硒鼓/墨盒采购60、80、120、0统一三项当前量及执行量，原100/80历史人员时间保留；归档及移仓来源正确，重放只一事件');
 const positive=await ready('PROC-TONER');const beforeInvalid=snapshot();assert.throws(()=>db.reviewInquiry({id:positive.id,role:'business',decision:'approve',approvedQuantity:0,expectedRevision:positive.revision,requestId:rid()}),/大于 0/);assert.deepEqual(snapshot(),beforeInvalid);
 const fresh=db.createInquiry({role:'operation-1',model:'PROC-INK',quantity:7,department:'一团',store:'PROCUS',operator:'零批准校验',fnsku:'PROC-ZERO',asin:'BPROCZERO',requestId:rid()}).record;const beforeReview=snapshot();await api(`/api/inquiries/${fresh.id}/review`,'business',{decision:'approve',approvedQuantity:0,expectedRevision:fresh.revision,requestId:rid()},400);assert.deepEqual(snapshot(),beforeReview);
 assert.throws(()=>db.createInquiry({role:'operation-1',model:'PROC-INK',quantity:0,department:'一团',store:'PROCUS',operator:'零申请',fnsku:'PROC-ZERO',asin:'BPROCZERO',requestId:rid()}),/大于 0/);assert.deepEqual(snapshot(),beforeReview);
 assert.deepEqual(stock(),beforeStock);check('新建询库和商务批准仍拒绝0，询库采购覆盖不改变实际库存或锁定');
 db.initiateRelocationUpgrade({role:'operation-1',inquiryId:a.id,requestId:rid()});
 await stop();db.assertInventoryInvariants();db.close();db=null;
 // Explicit synthetic schema29 history: restore original business quantities to represent the old behavior.
 const old=new DatabaseSync(databasePath);restoreSchema32Fixture(old);old.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
 for(const r of old.prepare('SELECT id FROM inquiry_documents WHERE supplier_quantity IS NOT NULL').all()){
  const original=JSON.parse(old.prepare("SELECT payload_json FROM inquiry_events WHERE inquiry_id=? AND event_type='review'").get(r.id).payload_json).approvedQuantity;
  old.prepare('UPDATE inquiry_documents SET approved_quantity=? WHERE id=?').run(original,r.id);
 }
 old.exec('ALTER TABLE inquiry_documents DROP COLUMN approval_hidden');
 const view=old.prepare("SELECT sql FROM sqlite_master WHERE name='relocation_sources'").get().sql,schema=old.prepare("SELECT sql FROM sqlite_master WHERE name='inquiry_documents'").get().sql;
 const related=old.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('index','trigger') AND (tbl_name='inquiry_documents' OR sql LIKE '%inquiry_documents%')").all(),seq=old.prepare("SELECT seq FROM sqlite_sequence WHERE name='inquiry_documents'").get()?.seq;
 old.exec('DROP VIEW relocation_sources');for(const r of related)old.exec(`DROP ${r.type} "${r.name}"`);
 old.exec(schema.replace('inquiry_documents','inquiry_documents_fixture29').replace('approved_quantity >= 0','approved_quantity > 0'));
 old.exec('INSERT INTO inquiry_documents_fixture29 SELECT * FROM inquiry_documents; DROP TABLE inquiry_documents; ALTER TABLE inquiry_documents_fixture29 RENAME TO inquiry_documents;');
 if(seq!=null)old.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='inquiry_documents'").run(seq);for(const r of related)old.exec(r.sql);old.exec(view);
 old.exec('DROP TABLE transfer_upgrade_rows; DROP TABLE transfer_upgrade_imports; DELETE FROM schema_migrations WHERE version>=30; PRAGMA user_version=29; COMMIT; PRAGMA foreign_keys=ON');
 old.prepare('UPDATE inquiry_documents SET shipping_warehouse=? WHERE id=?').run('历史自由文本供应仓',a.id);old.prepare('UPDATE inquiry_documents SET shipping_warehouse=? WHERE id=?').run('',b.id);
 const oldSnapshot=snapshot(old),oldColumns=old.prepare('PRAGMA table_info(inquiry_documents)').all().map(c=>'"'+c.name+'"').join(',');old.close();
 const migrationProcess=spawn(process.execPath,[path.join(root,'scripts/migrate-inventory-v3.mjs'),'--state-root',state,'--backup-root',path.join(state,'controlled-backups')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ASTER_PRIVATE_INBOUND_SOURCES:path.join(state,'missing-source.json')}});let migrationOutput='';migrationProcess.stdout.on('data',v=>migrationOutput+=v);migrationProcess.stderr.on('data',v=>migrationOutput+=v);const [code]=await once(migrationProcess,'exit');assert.equal(code,0,migrationOutput);
 db=new InventoryDatabase(state);const after=snapshot();for(const [name,rows]of Object.entries(oldSnapshot)){if(['schema_migrations','system_meta'].includes(name))continue;assert.deepEqual(name==='inquiry_documents'?db.db.prepare('SELECT '+oldColumns+' FROM inquiry_documents').all().map(r=>({...r})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):rows.length?db.db.prepare('SELECT '+Object.keys(rows[0]).map(k=>'"'+k+'"').join(',')+' FROM "'+name+'"').all().map(r=>({...r})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):after[name],rows,name);}
 assert.equal(db.getInquiry(a.id).shippingWarehouse,'历史自由文本供应仓');assert.equal(db.getInquiry(b.id).shippingWarehouse,'');assert.equal(db.getInquiry(a.id).procurementNote,pa.procurementNote);assert.equal(db.syncState().dataVersion,Number(oldSnapshot.system_meta.find(r=>r.key==='data_version').value)+1);
 const backupDirs=await fs.readdir(path.join(state,'controlled-backups'));assert.equal(backupDirs.length,1);const backup=new DatabaseSync(path.join(state,'controlled-backups',backupDirs[0],'data/aster-inventory.sqlite'),{readOnly:true});assert.equal(backup.prepare('PRAGMA user_version').get().user_version,29);assert.deepEqual(snapshot(backup),oldSnapshot);backup.close();
 const migratedZero=db.replyInquiry({id:positive.id,role:'purchasing',...body(db.getInquiry(positive.id),0,'SC','升级后零回复')}).record;
 for(const field of ['requestedQuantity','approvedQuantity','supplierQuantity','quantity'])assert.equal(migratedZero[field],0);assert.equal(migratedZero.procurementNote,'升级后零回复');
 assert.equal(migrateInventoryDatabaseToCurrent({databasePath}).changed,false);db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);check('受控v29→v35迁移有完整v29备份，历史自由文本和零回复空仓和旧审核量不覆盖；其他业务表原样，重复迁移无变化');
}catch(e){failure=e.stack;throw e;}finally{await stop();db?.close();await fs.writeFile(path.join(out,'api-result.json'),JSON.stringify({state,base,checks,rejections,failure},null,2));}
console.log(`INQUIRY_PROCUREMENT_API_PASS ${checks.length} groups; ${rejections.length} rejected requests unchanged`);