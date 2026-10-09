// R02-R06/R09: real import + shelf, HTTP permissions, stored replays, source locks and returns.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInventoryDatabase,InventoryDatabase} from '../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from './test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/source-scope');
await fs.mkdir(out,{recursive:true});
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-source-scope-'));
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID(),port=await freePort(),base=`http://127.0.0.1:${port}`;
const instanceId=createTestInstanceId('source-scope'),log=await fs.open(path.join(out,'server.log'),'w');
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
const checks=[],evidence=[];
function check(name){checks.push(name);console.log('PASS '+name);}
async function api(route,role,body,status=200){const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;}
function snapshot(){return JSON.stringify(Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.db.prepare(`SELECT * FROM "${name}"`).all()])));}
async function rejectUnchanged(route,role,body,status){const before=snapshot();await api(route,role,body,status);assert.equal(snapshot(),before);}
async function receive(model,category,team,quantity,plan='SAME'){
 const csv=`ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n${model},${quantity},4,XSAME,SyntheticWarehouseB,${plan},2026-09-24,${team},V1`;
 const p=await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':'admin','x-file-name':encodeURIComponent(`${rid()}-${category}.csv`)},body:csv});assert.equal(p.status,200);const preview=await p.json();
 const imported=await api('/api/transit/import','admin',{previewToken:preview.previewToken,fileName:preview.fileName,fileHash:preview.fileSha256,templateHash:preview.templateSha256,rows:preview.rows,requestId:rid()});
 const row=imported.rows[0],role=team==='一团'?'assistant-1':'assistant-2',body={yes:'YES',expectedRevision:row.revision,requestId:rid()};
 const result=await api(`/api/transit/${row.id}/on-shelf`,role,body);
 const before=snapshot(),replay=await api(`/api/transit/${row.id}/on-shelf`,role,body);assert.equal(replay.deduped,true);assert.equal(snapshot(),before);
 if(category==='墨盒'){assert.ok(!('before'in result)&&!('after'in result));assert.equal(result.inventory.inStock,quantity);assert.equal(replay.inventory.inStock,quantity);}
 return {key:result.batchKey,shelf:result,transitId:row.id,body,role};
}
const entry=(model,key,team,q)=>({model,sourceBatchKey:key,plan:'SAME',date:'2026-09-24',version:'V1',quantity:q,department:team,store:'REGRESSIONUS',operator:team+'运营',fnsku:'XSAME',asin:team==='一团'?'BFIXONE':'BFIXTWO',requestId:rid()});
try{
 await waitForOwnedServer({base,child,instanceId});
 const roles=['admin','business','purchasing','operation-1','operation-2','assistant-1','assistant-2'];
 for(const [category,model] of [['墨盒','FIX-INK'],['硒鼓','FIX-TONER']]){
  const one=await receive(model,category,'一团',100),two=await receive(model,category,'二团',60);assert.notEqual(one.key,two.key);
  for(const role of roles){const scoped=role.endsWith('-1')?100:role.endsWith('-2')?60:160,catalog=await api('/api/inventory/catalog',role);assert.equal(catalog.models.find(m=>m.model===model).inStock,category==='墨盒'?scoped:160);
   const view=await api('/api/upgrades',role);assert.equal(view.directSources.find(m=>m.model===model).available,scoped);
  }
  check(`${category} 同身份真实100/60上架，七角色库存及升级候选范围一致`);
  if(category==='墨盒'){
   for(const role of ['operation-1','assistant-1'])await rejectUnchanged('/api/allocations',role,entry(model,two.key,'一团',1),role==='operation-1'?403:403);
   const bad=entry(model,two.key,'一团',1);await rejectUnchanged('/api/allocations','operation-1',bad,403);await rejectUnchanged('/api/allocations','operation-1',bad,403);
   check('隐藏墨盒来源与重复拒绝：所有表及dataVersion完全不变');
  }
  const body1=entry(model,one.key,'一团',8),body2=entry(model,two.key,'二团',8);
  let d1=(await api('/api/allocations','operation-1',body1)).record,d2=(await api('/api/allocations','operation-2',body2)).record;
  const replay=await api('/api/allocations','operation-1',body1);assert.equal(replay.deduped,true);
  if(category==='墨盒'){assert.deepEqual(Object.keys(replay.totals),[one.key]);assert.ok(!JSON.stringify(replay).includes(two.key));}
  const saved=db.db.prepare("SELECT response_json FROM idempotency_requests WHERE scope='allocation:create' AND request_id=?").get(body1.requestId);assert.ok(JSON.parse(saved.response_json).totals[two.key]);
  await rejectUnchanged('/api/allocations','operation-2',body1,403);
  const tooMuch=entry(model,one.key,'一团',96);await rejectUnchanged('/api/allocations','operation-1',tooMuch,409);
  db.syncLingxing({role:'business',items:[{asin:d1.asin,sales7d:11,sales30d:33,orderGrossProfit:1234.5,fbaAvailable:4,fbaPendingTransfer:5,fbaTransferring:6,fbaInbound:7},{asin:d2.asin,sales7d:22,sales30d:66,orderGrossProfit:9876.5,fbaAvailable:8,fbaPendingTransfer:9,fbaTransferring:10,fbaInbound:11}],capturedAt:new Date().toISOString(),requestId:rid()});
  for(const role of roles){const response=await api('/api/allocations?model='+model,role),records=Object.values(response.records).flat(),publicRows=Object.values(response.publicRecords).flat();
   assert.equal(records.length,role.includes('-')?1:2);assert.equal(publicRows.length,category==='硒鼓'?2:role.includes('-')?1:2);
   if(role.endsWith('-1'))assert.ok(records.every(r=>r.department==='一团'));if(role.endsWith('-2'))assert.ok(records.every(r=>r.department==='二团'));
   for(const r of records)assert.equal('orderGrossProfit'in r.lingxing,!role.startsWith('assistant')&&role!=='purchasing');
   for(const r of publicRows)assert.ok(!('lingxing'in r)&&!('asin'in r)&&!('store'in r));
  }
  check(`${category} 完整记录/指标/毛利润按七角色过滤，公开摘要范围正确，存量响应重放受限`);
  d1=(await api(`/api/allocations/${d1.id}/review`,'business',{decision:'approve',approvedQuantity:4,expectedRevision:d1.revision,requestId:rid()})).record;
  d2=(await api(`/api/allocations/${d2.id}/review`,'business',{decision:'approve',approvedQuantity:4,expectedRevision:d2.revision,requestId:rid()})).record;
  await rejectUnchanged(`/api/allocations/${d2.id}/confirm`,'assistant-1',{expectedRevision:d2.revision,requestId:rid()},403);
  const stale=await api(`/api/allocations/${d1.id}/confirm`,'assistant-1',{expectedRevision:1,requestId:rid()},409);assert.ok(!JSON.stringify(stale).includes('orderGrossProfit'));if(category==='墨盒')assert.ok(!JSON.stringify(stale).includes(two.key));
  const confirmBody={expectedRevision:d1.revision,requestId:rid()};const confirm=await api(`/api/allocations/${d1.id}/confirm`,'assistant-1',confirmBody);assert.ok(!JSON.stringify(confirm).includes('orderGrossProfit'));
  assert.equal((await api(`/api/allocations/${d1.id}/confirm`,'assistant-1',confirmBody)).deduped,true);d1=confirm.record;
  if(category==='墨盒')assert.deepEqual(Object.keys(confirm.totals),[one.key]);
  const requests=[{model,sourceVersion:'V1',requestId:rid()},{model,sourceVersion:'V1',requestId:rid()}];
  const started=await Promise.all([api('/api/upgrades/direct','operation-1',requests[0]),api('/api/upgrades/direct','assistant-2',requests[1])]);
  assert.deepEqual(started.map(r=>r.upgrade.initialQuantity),[96,56]);assert.deepEqual(started[0].upgrade.lines.map(l=>l.sourceBatchKey),[one.key]);assert.deepEqual(started[1].upgrade.lines.map(l=>l.sourceBatchKey),[two.key]);
  assert.equal((await api('/api/upgrades/direct','operation-1',requests[0])).deduped,true);
  for(const role of ['operation-1','assistant-1','operation-2','assistant-2','admin','purchasing'])await rejectUnchanged('/api/upgrades/direct',role,{model,sourceVersion:'V1',requestId:rid()},409);
  const before=snapshot();const denied=await Promise.all([api('/api/upgrades/direct','operation-1',{model,sourceVersion:'V1',requestId:rid()},409),api('/api/upgrades/direct','assistant-1',{model,sourceVersion:'V1',requestId:rid()},409)]);assert.equal(denied.length,2);assert.equal(snapshot(),before);
  check(`${category} 两团同版本并行锁96/56，重放及各角色重复/并发申请不二次占用`);
  for(let i=0;i<2;i++){
   const job=started[i].upgrade,body={sourceLineId:job.lines[0].id,completedQuantity:i?30:20,newVersion:'V2',targetWarehouse:'SyntheticWarehouseA',expectedRevision:job.revision,requestId:rid()};
   const result=await api(`/api/upgrades/direct/${job.id}/complete`,'purchasing',body);assert.equal(result.upgrade.inProgressQuantity,i?26:76);
   const after=snapshot();assert.equal((await api(`/api/upgrades/direct/${job.id}/complete`,'purchasing',body)).deduped,true);assert.equal(snapshot(),after);
   const target=db.db.prepare('SELECT * FROM stock_batches WHERE model=? AND version=? AND source_team=?').get(model,'V2',i?'二团':'一团');assert.equal(target.pack_per_box,'4');assert.equal(db.getBalance(target.batch_key).onHand,i?30:20);
  }
  const targets=db.db.prepare("SELECT batch_key,source_team FROM stock_batches WHERE model=? AND version='V2'").all(model);assert.equal(targets.length,2);assert.notEqual(targets[0].batch_key,targets[1].batch_key);
  assert.equal(db.getDocument(d1.id).batchKey,one.key);assert.equal(db.getDocument(d2.id).batchKey,two.key);
  for(const role of ['operation-1','assistant-1','operation-2','assistant-2']){const dashboard=await api('/api/upgrades',role);const job=dashboard.upgrades.find(j=>j.model===model&&j.kind==='direct');assert.equal(job.lines.length,1);assert.equal(job.lines[0].sourceBatchKey,role.endsWith('-1')?one.key:two.key);assert.equal(dashboard.directSources.find(s=>s.model===model&&s.sourceVersion==='V1').available,0);}
  check(`${category} 分批回库保留本团身份/套箱/余额，角色切换与历史单据引用保持`);
  d2=(await api(`/api/allocations/${d2.id}/confirm`,'assistant-2',{expectedRevision:d2.revision,requestId:rid()})).record;
  for(const [index,document] of [d1,d2].entries()) {
   const suffix=String(index+1),assistant='assistant-'+suffix,operation='operation-'+suffix;
   let work=(await api('/api/upgrades/relocation-work-items',assistant,{allocationId:document.id,requestId:rid()})).workItem;
   work=(await api(`/api/upgrades/relocation-work-items/${work.id}/procurement`,'purchasing',{rma:'RMA'+work.id,relocationAddress:'回库验证仓',expectedRevision:work.revision,requestId:rid()})).workItem;
   work=(await api(`/api/upgrades/relocation-work-items/${work.id}/operation`,operation,{removalOrderNo:'ORDER'+work.id,expectedRevision:work.revision,requestId:rid()})).workItem;
   work=db.syncRelocationLogistics({id:work.id,role:assistant,shipments:[{externalId:'PACK'+work.id,storeId:'FIX',orderNo:'ORDER'+work.id,fnsku:'XSAME',quantity:4,carrier:'UPS',trackingNo:'TRACK'+work.id,shipDate:'2026-09-24'}],capturedAt:new Date().toISOString(),requestId:rid()}).workItem;
   const shipped=await api(`/api/upgrades/relocation-work-items/${work.id}/ship`,assistant,{fbaRemainingQuantity:0,externalItems:[{lineId:work.externalShipments[0].lineId,quantity:4}],expectedRevision:work.revision,requestId:rid()});
   let relocation=shipped.upgrade.relocations[0];
   for(const quantity of [2,2]) {
    const body={completedQuantity:quantity,newVersion:'V2',targetWarehouse:'SyntheticWarehouseA',expectedRevision:relocation.revision,requestId:rid()};
    const completed=await api(`/api/upgrades/relocations/${relocation.id}/complete`,'purchasing',body);
    const before=snapshot();assert.equal((await api(`/api/upgrades/relocations/${relocation.id}/complete`,'purchasing',body)).deduped,true);assert.equal(snapshot(),before);
    relocation=completed.upgrade.relocations[0];
   }
   const target=db.db.prepare("SELECT * FROM stock_batches WHERE model=? AND version='V2' AND source_team=?").get(model,index?'二团':'一团');
   assert.equal(db.getBalance(target.batch_key).onHand,index?34:24);assert.equal(target.pack_per_box,'4');assert.equal(relocation.completedQuantity,4);
  }
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM stock_batches WHERE model=? AND version='V2'").get(model).n,2);
  check(`${category} 两团移仓分次2/2回库沿原来源分别合入本团升级目标，重放不重复入账`);
  evidence.push({category,model,one,two,started,targets});
 }
 // An admin/purchasing initiator does not become the source owner.
 const adminOne=await receive('FIX-OWNER','硒鼓','一团',100);
 const adminJob=(await api('/api/upgrades/direct','purchasing',{model:'FIX-OWNER',sourceVersion:'V1',requestId:rid()})).upgrade;
 const adminTwo=await receive('FIX-OWNER','硒鼓','二团',60);
 const opJob=(await api('/api/upgrades/direct','operation-2',{model:'FIX-OWNER',sourceVersion:'V1',requestId:rid()})).upgrade;
 assert.equal(adminJob.lines[0].sourceBatchKey,adminOne.key);assert.equal(opJob.lines[0].sourceBatchKey,adminTwo.key);
 assert.throws(()=>db.db.prepare('INSERT INTO upgrade_stock_lines(upgrade_id,source_batch_key,initial_quantity,completed_quantity,remaining_quantity,revision,updated_at) VALUES(?,?,1,0,1,1,?)').run(opJob.id,adminOne.key,new Date().toISOString()),/UNIQUE constraint failed/);
 assert.throws(()=>db.db.prepare('UPDATE upgrade_stock_lines SET reservation_active=0 WHERE upgrade_id=?').run(adminJob.id),/占用状态/);
 check('采购发起仍按实际一团来源归属；二团独立办理；数据库唯一约束拒绝同源重复行');
 const otherOnly=await receive('FIX-ONLY-TWO','墨盒','二团',40);
 assert.ok(!(await api('/api/upgrades','operation-1')).directSources.some(r=>r.model==='FIX-ONLY-TWO'));
 await rejectUnchanged('/api/upgrades/direct','operation-1',{model:'FIX-ONLY-TWO',sourceVersion:'V1',requestId:rid()},409);
 assert.equal(db.getBalance(otherOnly.key).locked,0);check('对方独有40墨盒不出现候选；提交拒绝且无副作用');
 db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);check('全部账本余额及外键一致');
}finally{await fs.writeFile(path.join(out,'result.json'),JSON.stringify({state,base,checks,evidence},null,2));child.kill();await new Promise(resolve=>child.once('close',resolve));await log.close();db.close();}
console.log(`SOURCE_SCOPE_PASS ${checks.length}`);
