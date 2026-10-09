// All fixtures and requests use a new empty temporary database and an owned random port.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInventoryDatabase,InventoryDatabase} from '../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from './test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'.test-output/allocation-pack');
await fs.mkdir(out,{recursive:true});
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-allocation-pack-'));
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('allocation-pack'),rid=()=>crypto.randomUUID();
const server=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
const checks=[],rejections=[];let failure;
const check=name=>{checks.push(name);console.log('PASS '+name);};
async function api(route,role,body,status=200){const res=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await res.json();assert.equal(res.status,status,JSON.stringify(result));return result;}
function snapshot(){return Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.db.prepare('SELECT * FROM "'+name+'"').all()]));}
const body=(batch,quantity,role='operation-1')=>({model:'PACK-TEST',sourceBatchKey:batch.batchKey,plan:batch.plan,date:batch.date,version:batch.version,quantity,department:role==='operation-2'?'二团':'一团',store:'PACKUS',operator:'隔离运营',fnsku:'OPERATOR-CODE',asin:'BPACK00001',operatorNote:'保留备注',requestId:rid()});
async function reject(role,payload,status,code){const before=snapshot(),result=await api('/api/allocations',role,payload,status);assert.equal(result.code,code);assert.equal(result.ok,false);assert.ok(!result.record&&!result.totals&&!result.deduped);assert.deepEqual(snapshot(),before);rejections.push({role,quantity:payload.quantity,status,code,allTablesUnchanged:true});return result;}
function rejectDirect(role,payload,code){const before=snapshot();assert.throws(()=>db.createAllocation({role,...payload}),e=>e.code===code);assert.deepEqual(snapshot(),before);}
try{
 await waitForOwnedServer({base,child:server,instanceId});
 const fileName='整箱调拨硒鼓.csv',csv='ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\nPACK-TEST,144,12,SOURCE-12,SyntheticWarehouseA,SAME,2026-10-09,一团,V1\nPACK-TEST,100,5,SOURCE-5,SyntheticWarehouseA,SAME,2026-10-09,二团,V1\nPACK-TEST,20,12,SOURCE-TAIL,SyntheticWarehouseA,TAIL,2026-10-09,一团,V1\nPACK-TEST,120,12,SOURCE-BAD,SyntheticWarehouseA,BAD,2026-10-09,一团,V1';
 const previewResponse=await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':'admin','x-file-name':encodeURIComponent(fileName)},body:csv});assert.equal(previewResponse.status,200);const p=await previewResponse.json();
 const imported=await api('/api/transit/import','admin',{previewToken:p.previewToken,fileName,fileHash:p.fileSha256,templateHash:p.templateSha256,rows:p.rows,requestId:rid()});
 for(const t of imported.rows)await api(`/api/transit/${t.id}/on-shelf`,db.getTransit(t.id).team==='二团'?'assistant-2':'assistant-1',{yes:'YES',expectedRevision:t.revision,requestId:rid()});
 const catalog=await api('/api/inventory/catalog','admin'),rows=catalog.stockDetails['PACK-TEST'],find=fnsku=>rows.find(b=>b.fnsku===fnsku),a=find('SOURCE-12'),b=find('SOURCE-5'),tail=find('SOURCE-TAIL'),bad=find('SOURCE-BAD');
 assert.notEqual(a.batchKey,b.batchKey);assert.equal(a.plan,b.plan);assert.equal(a.date,b.date);assert.equal(a.version,b.version);
 for(const role of ['operation-1','operation-2','admin']){
  for(const q of [0,-12,1.5]){await reject(role,body(a,q,role),400,'invalid_quantity');rejectDirect(role,body(a,q,role),'invalid_quantity');}
  await reject(role,body(a,13,role),400,'allocation_quantity_multiple');
  await reject(role,body(a,156,role),409,'insufficient_available');
  await reject(role,{...body(a,13,role),packPerBox:1},400,'allocation_quantity_multiple');
 }
 check('两团运营和管理员：零、负数、小数、非倍数和超库存全部拒绝；伪造客户端套/箱无效');
 await reject('operation-1',body(a,5),400,'allocation_quantity_multiple');await reject('operation-2',body(b,12,'operation-2'),400,'allocation_quantity_multiple');
 const bRecord=(await api('/api/allocations','operation-2',body(b,5,'operation-2'))).record;assert.equal(bRecord.batchKey,b.batchKey);assert.equal(db.getBalance(b.batchKey).locked,5);assert.equal(db.getBalance(a.batchKey).locked,0);
 check('同型号同计划日期版本的12/5两批次按实际批次校验与锁定，运营填写贴码不替换来源批次');
 for(const pack of [null,'','0','-12','1.5','abc','Infinity']){
  db.db.prepare('UPDATE stock_batches SET pack_per_box=? WHERE batch_key=?').run(pack,bad.batchKey);
  for(const role of ['operation-1','operation-2','admin']){const result=await reject(role,body(bad,12,role),400,'invalid_pack_per_box');assert.ok(result.error.includes('批次套/箱数据异常'));rejectDirect(role,body(bad,12,role),'invalid_pack_per_box');}
  assert.equal(db.db.prepare('SELECT pack_per_box FROM stock_batches WHERE batch_key=?').get(bad.batchKey).pack_per_box,pack);
 }
 check('套/箱缺失、空、零、负、小数或无效文本明确报批次数据异常；没有补值或借用同型号包装数');
 const correction=body(a,13);await reject('operation-1',correction,400,'allocation_quantity_multiple');correction.quantity=12;
 const first=(await api('/api/allocations','operation-1',correction)).record;assert.equal(first.requestedQuantity,12);assert.equal(first.operatorNote,correction.operatorNote);
 const beforeReplay=snapshot(),replay=await api('/api/allocations','operation-1',correction);assert.equal(replay.deduped,true);assert.equal(replay.record.id,first.id);assert.deepEqual(snapshot(),beforeReplay);
 const multi=(await api('/api/allocations','operation-2',body(a,24,'operation-2'))).record;assert.equal(multi.requestedQuantity,24);
 const adminBody=body(a,12,'admin'),concurrent=await Promise.all([api('/api/allocations','admin',adminBody),api('/api/allocations','admin',adminBody)]);assert.equal(concurrent.filter(r=>r.deduped).length,1);assert.equal(db.db.prepare("SELECT COUNT(*) n FROM inventory_ledger WHERE document_id=? AND entry_type='reserve'").get(concurrent[0].record.id).n,1);assert.equal(db.getBalance(a.batchKey).locked,48);
 check('一箱、多箱合法；修正后原请求可提交；重复和并发同请求均只建一单、预锁一次');
 await reject('admin',body(tail,20,'admin'),400,'allocation_quantity_multiple');await reject('admin',body(tail,24,'admin'),409,'insufficient_available');
 await api('/api/allocations','admin',body(tail,12,'admin'));assert.equal(db.getBalance(tail.batchKey).available,8);await reject('admin',body(tail,8,'admin'),400,'allocation_quantity_multiple');await reject('admin',body(tail,12,'admin'),409,'insufficient_available');
 check('套/箱12且可用20仅可申请12，余8无法从该入口提交');
 const inquiryBaseline={balance:db.getBalance(a.batchKey),ledger:db.db.prepare('SELECT * FROM inventory_ledger').all()},inquiry=(await api('/api/inquiries','operation-1',{...body(a,7),sourceBatchKey:undefined})).record;assert.equal(inquiry.quantity,7);assert.deepEqual({balance:db.getBalance(a.batchKey),ledger:db.db.prepare('SELECT * FROM inventory_ledger').all()},inquiryBaseline);
 const approved=(await api(`/api/allocations/${first.id}/review`,'business',{decision:'approve',approvedQuantity:12,expectedRevision:first.revision,requestId:rid()})).record;assert.equal(approved.requestedQuantity,12);assert.equal(approved.approvedQuantity,12);
 const confirmed=(await api(`/api/allocations/${first.id}/confirm`,'assistant-1',{expectedRevision:approved.revision,requestId:rid()})).record;assert.equal(confirmed.quantity,12);assert.equal(db.getBalance(a.batchKey).onHand,132);assert.equal(db.getBalance(a.batchKey).locked,36);
 check('询库7按原规则成功且不锁库存；调拨申请12按整箱批准12并由助理出库');
 for(const role of ['assistant-1','business','purchasing'])await reject(role,body(a,12),403,'entry_forbidden');
 await reject('operation-1',{...body(a,12),department:'二团'},403,'group_forbidden');
 db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
 check('既有角色和团队权限、库存恒等式及外键完整；每个拒绝均比对全部表含流水、序列和幂等回执不变');
}catch(e){failure=e.stack;throw e;}finally{await fs.writeFile(path.join(out,'result.json'),JSON.stringify({state,base,databaseId:db.syncState().databaseId,checks,rejections,failure},null,2));const ended=once(server,'exit');server.kill();await ended;db.close();}
console.log('ALLOCATION_PACK_PASS '+checks.length+' groups; '+rejections.length+' rejected requests unchanged');
