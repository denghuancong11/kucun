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
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'.test-output/inquiry-procurement');await fs.mkdir(out,{recursive:true});
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-procurement-api-')),databasePath=path.join(state,'data/aster-inventory.sqlite');
createInventoryDatabase({databasePath,seedCatalogData:false});let db=new InventoryDatabase(state),child;
const port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('procurement'),rid=()=>crypto.randomUUID(),checks=[],rejections=[];
const check=name=>{checks.push(name);console.log('PASS '+name);};
const snapshot=(connection=db.db)=>Object.fromEntries(connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,connection.prepare('SELECT * FROM "'+name+'"').all().map(r=>({...r}))]));
const stock=()=>({catalog:db.db.prepare('SELECT model,category,base_in_stock,in_transit FROM catalog_models ORDER BY model').all(),batches:snapshot().stock_batches,ledger:snapshot().inventory_ledger,upgradeLedger:snapshot().upgrade_inventory_ledger});
async function start(){child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});await waitForOwnedServer({base,child,instanceId});}
async function stop(){if(child?.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}child=null;}
async function api(route,role,body,status=200){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;}
async function ready(model){let r=(await api('/api/inquiries','operation-1',{model,quantity:7,department:'一团',store:'PROCUS',operator:'隔离采购验收',fnsku:'PROC-FNSKU',asin:'BPROC001',operatorNote:'运营备注',requestId:rid()})).record;return (await api(`/api/inquiries/${r.id}/review`,'business',{decision:'approve',approvedQuantity:13,businessNote:'商务备注',expectedRevision:r.revision,requestId:rid()})).record;}
const body=(r,q=7,w='CA',note='采购独立备注')=>({supplierQuantity:q,shippingWarehouse:w,procurementNote:note,expectedRevision:r.revision,requestId:rid()});
async function rejected(r,p,status,code,role='purchasing'){const before=snapshot(),result=await api(`/api/inquiries/${r.id}/reply`,role,p,status);assert.equal(result.code,code);assert.equal(result.ok,false);assert.deepEqual(snapshot(),before);rejections.push({quantity:p.supplierQuantity,warehouse:p.shippingWarehouse,code,allTablesUnchanged:true});}
let failure;
try{
 for(const [model,category]of [['PROC-TONER','硒鼓'],['PROC-INK','墨盒']])db.db.prepare('INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at) VALUES(?,?,0,0,?)').run(model,category,new Date().toISOString());
 assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,29);assert.ok(db.db.prepare('PRAGMA table_info(inquiry_documents)').all().some(c=>c.name==='procurement_note'&&c.notnull===1));check('新建v29库具有独立采购备注字段');
 await start();const beforeStock=stock(),a=await ready('PROC-TONER'),b=await ready('PROC-INK');
 for(const q of [0,7])for(const w of ['',null,'其他仓','ca','CA,SC'])await rejected(a,body(a,q,w),400,w?'invalid_shippingWarehouse':'missing_shippingWarehouse');
 for(const q of ['',null,-1,1.5])await rejected(a,body(a,q),400,q===''||q===null?'missing_supplier_quantity':'invalid_quantity');
 for(const w of ['', 'OTHER']){const before=snapshot();assert.throws(()=>db.replyInquiry({id:a.id,role:'purchasing',...body(a,0,w)}),e=>e.code===(w?'invalid_shippingWarehouse':'missing_shippingWarehouse'));assert.deepEqual(snapshot(),before);}
 check('0及正数必须选CA/SC，空值与其他仓库及非法数量前后端拒绝，失败所有表不变');
 for(const role of ['admin','business','operation-1','operation-2','assistant-1','assistant-2'])await rejected(a,body(a),403,'inquiry_action_forbidden',role);
 await rejected(a,{...body(a),expectedRevision:a.revision-1},409,'stale_revision');check('既有采购权限及记录版本检查保留');
 const pa=body(a,7,'CA','采购独立备注'),ra=(await api(`/api/inquiries/${a.id}/reply`,'purchasing',pa)).record;
 assert.equal((await api('/api/approvals','purchasing')).inquiries.find(r=>r.id===a.id).category,'硒鼓');assert.equal(ra.supplierQuantity,7);assert.equal(ra.requestedQuantity,7);assert.equal(ra.quantity,7);assert.equal(ra.approvedQuantity,13);assert.equal(ra.status,'pending_assistant');assert.equal(ra.procurementNote,pa.procurementNote);assert.equal(ra.businessNote,'商务备注');assert.equal(ra.operatorNote,'运营备注');assert.deepEqual(ra.events.at(-1).payload,{supplierQuantity:7,shippingWarehouse:'CA',procurementNote:pa.procurementNote});
 const saved=snapshot();const concurrent=await Promise.all([api(`/api/inquiries/${a.id}/reply`,'purchasing',pa),api(`/api/inquiries/${a.id}/reply`,'purchasing',pa)]);assert.ok(concurrent.every(r=>r.deduped));assert.deepEqual(snapshot(),saved);await rejected(a,{...pa,procurementNote:'同键更改备注'},409,'idempotency_conflict');
 check('硒鼓CA非整箱7一次保存三字段，备注与其他备注分开；重复请求不多写，同键改备注冲突');
 const pb=body(b,0,'SC',''),rb=(await api(`/api/inquiries/${b.id}/reply`,'purchasing',pb)).record;assert.equal((await api('/api/approvals','purchasing')).inquiries.find(r=>r.id===b.id).category,'墨盒');assert.equal(rb.status,'pending_assistant');assert.equal(rb.quantity,0);assert.equal(rb.supplierQuantity,0);assert.equal(rb.requestedQuantity,0);assert.equal(rb.procurementNote,'');assert.equal(rb.shippingWarehouse,'SC');
 check('墨盒SC零回复和空备注成功，最终数量0并正常进入待助理归档');
 for(const role of ['admin','purchasing','business','operation-1','assistant-1']){const rows=(await api('/api/approvals',role)).inquiries;assert.equal(rows.find(r=>r.id===a.id).procurementNote,pa.procurementNote);assert.equal(rows.find(r=>r.id===b.id).supplierQuantity,0);}
 await stop();db.close();db=new InventoryDatabase(state);await start();assert.equal((await api('/api/approvals','assistant-1')).inquiries.find(r=>r.id===a.id).procurementNote,pa.procurementNote);
 for(const r of [ra,rb]){const archived=(await api(`/api/inquiries/${r.id}/archive`,'assistant-1',{plan:'PROC-PLAN-'+r.id,date:'2026-10-09',version:'V1',expectedRevision:r.revision,requestId:rid()})).record;assert.equal(archived.status,'archived');assert.equal(archived.procurementNote,r.procurementNote);assert.equal(archived.quantity,r.supplierQuantity);}
 assert.deepEqual(stock(),beforeStock);check('刷新跨角色、服务及数据库重启、助理归档均保留备注；最终数量沿用，实际库存不变');
 await stop();db.assertInventoryInvariants();db.close();db=null;
 // Represent real v28 history without mapping its free-text warehouses or empty zero-reply warehouse.
 const old=new DatabaseSync(databasePath);old.exec("ALTER TABLE inquiry_documents DROP COLUMN procurement_note; DELETE FROM schema_migrations WHERE version=29; PRAGMA user_version=28;");old.prepare('UPDATE inquiry_documents SET shipping_warehouse=? WHERE id=?').run('历史自由文本供应仓',a.id);old.prepare('UPDATE inquiry_documents SET shipping_warehouse=? WHERE id=?').run('',b.id);const oldSnapshot=snapshot(old),oldColumns=old.prepare('PRAGMA table_info(inquiry_documents)').all().map(c=>'"'+c.name+'"').join(',');old.close();
 const migrationProcess=spawn(process.execPath,[path.join(root,'scripts/migrate-inventory-v3.mjs'),'--state-root',state,'--backup-root',path.join(state,'controlled-backups')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ASTER_PRIVATE_INBOUND_SOURCES:path.join(state,'missing-source.json')}});let migrationOutput='';migrationProcess.stdout.on('data',v=>migrationOutput+=v);migrationProcess.stderr.on('data',v=>migrationOutput+=v);const [code]=await once(migrationProcess,'exit');assert.equal(code,0,migrationOutput);
 db=new InventoryDatabase(state);const after=snapshot();for(const [name,rows]of Object.entries(oldSnapshot)){if(['schema_migrations','system_meta'].includes(name))continue;assert.deepEqual(name==='inquiry_documents'?db.db.prepare('SELECT '+oldColumns+' FROM inquiry_documents').all().map(r=>({...r})):after[name],rows,name);}
 assert.equal(db.getInquiry(a.id).shippingWarehouse,'历史自由文本供应仓');assert.equal(db.getInquiry(b.id).shippingWarehouse,'');assert.equal(db.getInquiry(a.id).procurementNote,'');assert.equal(db.syncState().dataVersion,Number(oldSnapshot.system_meta.find(r=>r.key==='data_version').value)+1);
 const backupDirs=await fs.readdir(path.join(state,'controlled-backups'));assert.equal(backupDirs.length,1);const backup=new DatabaseSync(path.join(state,'controlled-backups',backupDirs[0],'data/aster-inventory.sqlite'),{readOnly:true});assert.equal(backup.prepare('PRAGMA user_version').get().user_version,28);assert.deepEqual(snapshot(backup),oldSnapshot);backup.close();
 assert.equal(migrateInventoryDatabaseToCurrent({databasePath}).changed,false);db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);check('受控v28→v29迁移有完整v28备份，历史自由文本和零回复空仓不覆盖；其他业务表原样，重复迁移无变化');
}catch(e){failure=e.stack;throw e;}finally{await stop();db?.close();await fs.writeFile(path.join(out,'api-result.json'),JSON.stringify({state,base,checks,rejections,failure},null,2));}
console.log(`INQUIRY_PROCUREMENT_API_PASS ${checks.length} groups; ${rejections.length} rejected requests unchanged`);