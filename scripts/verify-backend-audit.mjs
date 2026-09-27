// 隔离 HTTP 回归：升级流水查询、团队账本投影、写锁冲突和内部库存守恒。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInventoryDatabase,InventoryDatabase} from '../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from './test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'..');
const out=process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/backend-audit');
await fs.mkdir(out,{recursive:true});
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-backend-audit-'));
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID();
const port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('backend-audit');
const log=await fs.open(path.join(out,'server.log'),'w');
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
const checks=[],failures=[],calls=[];
async function api(route,role='admin',body,status=200){
 const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const result=await response.json();calls.push({route,role,body,status:response.status,result});
 if(status!==null)assert.equal(response.status,status,JSON.stringify(result));
 return {status:response.status,...result};
}
async function test(name,fn){try{await fn();checks.push(name);console.log('PASS '+name);}catch(e){failures.push({name,message:e.message,stack:e.stack});console.log('FAIL '+name+': '+e.message);}}
function snapshot(){return JSON.stringify(Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.db.prepare(`SELECT * FROM "${name}"`).all()])));}
async function receive({model='AUDIT-ITEM',team='一团',quantity=20,version='V1',pack=4,plan='AUDIT-PLAN',fnsku='AUDIT-FNSKU',warehouse='SyntheticWarehouseA',category='硒鼓'}={}){
 const csv=`ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n${model},${quantity},${pack},${fnsku},${warehouse},${plan},2026-09-24,${team},${version}`;
 const response=await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':'admin','x-file-name':encodeURIComponent(`${rid()}-${category}.csv`)},body:csv});
 assert.equal(response.status,200);const preview=await response.json();
 const result=await api('/api/transit/import','admin',{previewToken:preview.previewToken,fileName:preview.fileName,fileHash:preview.fileSha256,templateHash:preview.templateSha256,rows:preview.rows,requestId:rid()});
 return await api(`/api/transit/${result.rows[0].id}/on-shelf`,'admin',{yes:'YES',expectedRevision:result.rows[0].revision,requestId:rid()});
}
const direct=(model='AUDIT-ITEM',sourceVersion='V1',role='operation-1')=>api('/api/upgrades/direct',role,{model,sourceVersion,requestId:rid()}).then(r=>r.upgrade);
const complete=(job,quantity,newVersion='V2',line=job.lines[0])=>api(`/api/upgrades/direct/${job.id}/complete`,'purchasing',{sourceLineId:line.id,completedQuantity:quantity,newVersion,targetWarehouse:'SyntheticWarehouseA',expectedRevision:job.revision,requestId:rid()}).then(r=>r.upgrade);
try{
 await waitForOwnedServer({base,child,instanceId});
 await receive();const job=await direct();
 await test('升级单号筛选返回已有升级流水',async()=>{
   const all=await api('/api/audit?action=upgrade_direct_start');
   assert.ok(all.records.some(r=>r.businessNo===job.upgradeNo));
   const filtered=await api('/api/audit?businessNo='+encodeURIComponent(job.upgradeNo));
   assert.ok(filtered.records.some(r=>r.businessNo===job.upgradeNo),`已有 ${job.upgradeNo} 锁定流水，按该 businessNo 查询返回 ${filtered.records.length} 条`);
 });
 await test('目标套箱冲突拒绝后所有表、流水、幂等记录和数据版本不变',async()=>{
   await receive({version:'V2',pack:8,quantity:5});const before=snapshot();
   const result=await api(`/api/upgrades/direct/${job.id}/complete`,'purchasing',{sourceLineId:job.lines[0].id,completedQuantity:5,newVersion:'V2',targetWarehouse:'SyntheticWarehouseA',expectedRevision:job.revision,requestId:rid()},409);
   assert.equal(result.code,'pack_per_box_conflict');assert.equal(snapshot(),before);
 });
 await test('分次升级全部完成后释放来源互斥并可升级后来同批入库量',async()=>{
   await receive({quantity:3});let current=await complete(job,7,'V3');
   current=await complete(current,13,'V4');assert.equal(current.status,'completed');
   const source=db.db.prepare('SELECT * FROM upgrade_stock_lines WHERE upgrade_id=?').get(job.id);
   assert.equal(source.reservation_active,0);assert.equal(db.getBalance(source.source_batch_key).locked,0);
   const next=await direct();assert.equal(next.initialQuantity,3);await complete(next,3,'V4');
 });
 await test('同版本相同revision并发完成仅一笔成功，另一笔409，库存不超转',async()=>{
   await receive({model:'CONCURRENT',quantity:11});const current=await direct('CONCURRENT');
   const body={sourceLineId:current.lines[0].id,completedQuantity:7,newVersion:'V2',targetWarehouse:'SyntheticWarehouseA',expectedRevision:current.revision};
   const results=await Promise.all([api(`/api/upgrades/direct/${current.id}/complete`,'purchasing',{...body,requestId:rid()},null),api(`/api/upgrades/direct/${current.id}/complete`,'purchasing',{...body,requestId:rid()},null)]);
   assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(db.getUpgrade(current.id).completedQuantity,7);assert.equal(db.getUpgrade(current.id).inProgressQuantity,4);
 });
 await test('相同请求并发重放仅产生一次库存转换和一笔完成操作',async()=>{
   await receive({model:'REPLAY',quantity:9});const current=await direct('REPLAY');
   const body={sourceLineId:current.lines[0].id,completedQuantity:4,newVersion:'V2',targetWarehouse:'SyntheticWarehouseA',expectedRevision:current.revision,requestId:rid()};
   const route=`/api/upgrades/direct/${current.id}/complete`;
   const results=await Promise.all([api(route,'purchasing',body),api(route,'purchasing',body)]);
   assert.equal(results.filter(r=>r.deduped).length,1);assert.equal(db.getUpgrade(current.id).completedQuantity,4);
   assert.equal(db.db.prepare("SELECT COUNT(*) n FROM upgrade_operations WHERE upgrade_id=? AND operation_type='direct_complete'").get(current.id).n,1);
 });
 await test('跨团联合升级的流水明细不暴露另一团账本编号',async()=>{
   await receive({model:'MIXED-AUDIT',quantity:10});await receive({model:'MIXED-AUDIT',team:'二团',quantity:12});
   const current=await direct('MIXED-AUDIT','V1','admin');assert.equal(current.lines.length,2);
   const all=await api('/api/audit?action=upgrade_direct_start&model=MIXED-AUDIT','operation-1');
   const detail=await api('/api/audit/'+all.records[0].eventId,'operation-1');
   assert.equal(detail.ledger.length,1);assert.equal(detail.record.quantity,10);
   assert.deepEqual(detail.record.ledgerIds,detail.ledger.map(l=>l.id),'record.ledgerIds 应与本团可见 ledger 相同');
   assert.deepEqual(all.records[0].ledgerIds,detail.ledger.map(l=>l.id),'列表 ledgerIds 也应仅包含本团账本');
   const full=await api('/api/audit/'+all.records[0].eventId,'admin');
   assert.equal(full.ledger.length,2);assert.deepEqual(full.record.ledgerIds,full.ledger.map(l=>l.id));
 });
 await test('数据库被另一连接写占用时返回明确可重试409且不落任何业务记录',async()=>{
   await receive({model:'BUSY',quantity:6});const body={model:'BUSY',sourceVersion:'V1',requestId:rid()};
   const before=snapshot();db.db.exec('BEGIN IMMEDIATE');let result;
   try{result=await api('/api/upgrades/direct','operation-1',body,null);}finally{db.db.exec('ROLLBACK');}
   assert.equal(snapshot(),before);assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.code,'database_busy');
   const retry=await api('/api/upgrades/direct','operation-1',body);assert.equal(retry.upgrade.initialQuantity,6);
   const after=snapshot();assert.equal((await api('/api/upgrades/direct','operation-1',body)).deduped,true);assert.equal(snapshot(),after);
 });
 const relocationCases=[['allocation','REL-ALLOCATION'],['inquiry','REL-INQUIRY'],['fba','REL-FBA']];
 for(const [kind,model] of relocationCases){
 await test(`${kind}来源两次移仓、分次回库、岗位拒绝、幂等重放与原团队守恒`,async()=>{
   const shelf=await receive({model,team:kind==='allocation'?'一团':'二团',quantity:20,warehouse:kind==='fba'?'直发FBA':'SyntheticWarehouseA'});
   let source;
   if(kind==='allocation'){
     let record=(await api('/api/allocations','operation-2',{sourceBatchKey:shelf.batchKey,model,plan:'AUDIT-PLAN',date:'2026-09-24',version:'V1',quantity:20,department:'二团',store:'AUDITUS',operator:'合成运营',fnsku:'AUDIT-FNSKU',asin:'AUDITASIN',requestId:rid()})).record;
     record=(await api(`/api/allocations/${record.id}/review`,'business',{decision:'approve',approvedQuantity:20,expectedRevision:record.revision,requestId:rid()})).record;
     record=(await api(`/api/allocations/${record.id}/confirm`,'assistant-2',{expectedRevision:record.revision,requestId:rid()})).record;
     source={allocationId:record.id};
   }else if(kind==='inquiry'){
     let record=(await api('/api/inquiries','operation-2',{model,quantity:20,department:'二团',store:'AUDITUS',operator:'合成运营',fnsku:'AUDIT-FNSKU',asin:'AUDITASIN',requestId:rid()})).record;
     record=(await api(`/api/inquiries/${record.id}/review`,'business',{decision:'approve',approvedQuantity:20,expectedRevision:record.revision,requestId:rid()})).record;
     record=(await api(`/api/inquiries/${record.id}/reply`,'purchasing',{supplierQuantity:20,shippingWarehouse:'CA',expectedRevision:record.revision,requestId:rid()})).record;
     record=(await api(`/api/inquiries/${record.id}/archive`,'assistant-2',{plan:'AUDIT-PLAN',date:'2026-09-24',version:'V1',expectedRevision:record.revision,requestId:rid()})).record;
     source={inquiryId:record.id};
   }else source={fbaArchiveId:shelf.fbaArchiveId};
   const onHandBefore=db.getCatalog().models.find(m=>m.model===model).inStock;
   let finalUpgrade;
   for(const sequence of [1,2]){
     const startBody={...source,requestId:rid()};
     let work=(await api('/api/upgrades/relocation-work-items','assistant-2',startBody)).workItem;
     let before=snapshot();assert.equal((await api('/api/upgrades/relocation-work-items','assistant-2',startBody)).deduped,true);assert.equal(snapshot(),before);
     before=snapshot();await api('/api/upgrades/relocation-work-items','assistant-2',{...source,requestId:rid()},409);assert.equal(snapshot(),before);
     const procBody={rma:'RMA'+work.id,relocationAddress:'合成地址',expectedRevision:work.revision,requestId:rid()};
     before=snapshot();await api(`/api/upgrades/relocation-work-items/${work.id}/procurement`,'operation-2',procBody,403);assert.equal(snapshot(),before);
     work=(await api(`/api/upgrades/relocation-work-items/${work.id}/procurement`,'purchasing',procBody)).workItem;
     const opBody={removalOrderNo:'INTERNAL-'+work.id,expectedRevision:work.revision,requestId:rid()};
     before=snapshot();await api(`/api/upgrades/relocation-work-items/${work.id}/operation`,'operation-1',opBody,403);assert.equal(snapshot(),before);
     work=(await api(`/api/upgrades/relocation-work-items/${work.id}/operation`,'operation-2',opBody)).workItem;
     const shipQuantity=sequence===1?6:12,fbaRemaining=sequence===1?12:0;
     // 合成包裹只作为内部移仓夹具；不调用任何领星 HTTP/扩展/真实账户。
     work=db.syncRelocationLogistics({id:work.id,role:'assistant-2',shipments:[{externalId:'FIXTURE-'+work.id,storeId:'SYNTHETIC',orderNo:work.removalOrderNo,fnsku:'AUDIT-FNSKU',quantity:shipQuantity,carrier:'SYNTHETIC',trackingNo:'TRACK-'+work.id,shipDate:'2026-09-24'}],capturedAt:new Date().toISOString(),requestId:rid()}).workItem;
     const shipBody={fbaRemainingQuantity:fbaRemaining,externalItems:[{lineId:work.externalShipments[0].lineId,quantity:shipQuantity}],expectedRevision:work.revision,requestId:rid()};
     before=snapshot();await api(`/api/upgrades/relocation-work-items/${work.id}/ship`,'operation-2',shipBody,403);assert.equal(snapshot(),before);
     const ship=(await api(`/api/upgrades/relocation-work-items/${work.id}/ship`,'assistant-2',shipBody));
     before=snapshot();assert.equal((await api(`/api/upgrades/relocation-work-items/${work.id}/ship`,'assistant-2',shipBody)).deduped,true);assert.equal(snapshot(),before);
     let relocation=ship.upgrade.relocations.find(r=>r.sequence===sequence);
     const completeBody={completedQuantity:shipQuantity+1,newVersion:'V2',targetWarehouse:'SyntheticWarehouseB',expectedRevision:relocation.revision,requestId:rid()};
     before=snapshot();await api(`/api/upgrades/relocations/${relocation.id}/complete`,'purchasing',completeBody,409);assert.equal(snapshot(),before);
     for(const quantity of sequence===1?[2,4]:[12]){
       const body={completedQuantity:quantity,newVersion:quantity===2?'V3':'V2',targetWarehouse:'SyntheticWarehouseB',expectedRevision:relocation.revision,requestId:rid()};
       finalUpgrade=(await api(`/api/upgrades/relocations/${relocation.id}/complete`,'purchasing',body)).upgrade;
       before=snapshot();assert.equal((await api(`/api/upgrades/relocations/${relocation.id}/complete`,'purchasing',body)).deduped,true);assert.equal(snapshot(),before);
       relocation=finalUpgrade.relocations.find(r=>r.id===relocation.id);
     }
   }
   assert.equal(finalUpgrade.status,'completed');assert.equal(finalUpgrade.completedQuantity,18);assert.equal(finalUpgrade.soldQuantity,2);assert.equal(finalUpgrade.fbaRemainingQuantity,0);
   assert.equal(db.getCatalog().models.find(m=>m.model===model).inStock,onHandBefore+18);
   const returned=db.db.prepare("SELECT * FROM stock_balances WHERE model=? AND version IN ('V2','V3')").all(model);
   assert.ok(returned.every(b=>b.source_team===(kind==='allocation'?'一团':'二团')));
   assert.equal(returned.reduce((sum,b)=>sum+b.on_hand,0),18);
   const before=snapshot();await api('/api/upgrades/relocation-work-items','assistant-2',{...source,requestId:rid()},409);assert.equal(snapshot(),before);
 });
 }

 await test('全库库存余额及外键保持一致',async()=>{db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);});
}finally{
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify({state,base,checks,failures,calls},null,2));
 child.kill();if(child.exitCode===null)await once(child,'exit');await log.close();db.close();
}
console.log(JSON.stringify({passed:checks.length,failed:failures.length,state}));process.exitCode=failures.length?1:0;
