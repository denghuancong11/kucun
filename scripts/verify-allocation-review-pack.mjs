// Isolated HTTP approval checks: no production state or requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInventoryDatabase,InventoryDatabase} from '../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from './test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'.test-output/allocation-review-pack');
await fs.mkdir(out,{recursive:true});
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-allocation-review-pack-'));
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite'),seedCatalogData:false});
const db=new InventoryDatabase(state),port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('review-pack'),rid=()=>crypto.randomUUID();
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
const checks=[],rejections=[];let failure;
const check=name=>{checks.push(name);console.log('PASS '+name);};
async function api(route,role,body,status=200){const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;}
const snapshot=()=>Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.db.prepare('SELECT * FROM "'+name+'"').all()]));
const entry=(batch,quantity)=>({model:'REVIEW-PACK',sourceBatchKey:batch.batchKey,plan:batch.plan,date:batch.date,version:batch.version,quantity,department:'一团',store:'REVIEWUS',operator:'隔离运营',fnsku:'OPERATOR-CODE',asin:'BREVIEW001',requestId:rid()});
const create=async(batch,quantity=12)=>(await api('/api/allocations','admin',entry(batch,quantity))).record;
const reviewBody=(row,quantity,decision='approve')=>({decision,approvedQuantity:quantity,businessNote:'保留商务备注',expectedRevision:row.revision,requestId:rid()});
const approve=async(row,quantity)=>(await api(`/api/allocations/${row.id}/review`,'business',reviewBody(row,quantity))).record;
async function rejectUnchanged(row,body,status,code,role='business'){const before=snapshot();const result=await api(`/api/allocations/${row.id}/review`,role,body,status);assert.equal(result.code,code);assert.equal(result.ok,false);assert.ok(!result.record&&!result.deduped);assert.deepEqual(snapshot(),before);rejections.push({id:row.id,role,quantity:body.approvedQuantity,code,allTablesUnchanged:true});return result;}
function rejectDirect(row,q,code){const before=snapshot();assert.throws(()=>db.reviewAllocation({id:row.id,role:'business',...reviewBody(row,q)}),e=>e.code===code);assert.deepEqual(snapshot(),before);}
const ledger=(id,type)=>db.db.prepare('SELECT * FROM inventory_ledger WHERE document_id=? AND entry_type=?').all(id,type);
try{
 await waitForOwnedServer({base,child,instanceId});
 const fileName='商务整箱硒鼓.csv',csv='ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\nREVIEW-PACK,360,12,SOURCE-12,SyntheticWarehouseA,SAME,2026-10-09,一团,V1\nREVIEW-PACK,100,5,SOURCE-5,SyntheticWarehouseA,SAME,2026-10-09,一团,V1\nREVIEW-PACK,24,12,SOURCE-GROW,SyntheticWarehouseA,GROW,2026-10-09,一团,V1\nREVIEW-PACK,24,12,SOURCE-SHRINK,SyntheticWarehouseA,SHRINK,2026-10-09,一团,V1\nREVIEW-PACK,240,12,SOURCE-BAD,SyntheticWarehouseA,BAD,2026-10-09,一团,V1';
 const pRes=await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':'admin','x-file-name':encodeURIComponent(fileName)},body:csv});assert.equal(pRes.status,200);const p=await pRes.json();
 const imported=await api('/api/transit/import','admin',{previewToken:p.previewToken,fileName,fileHash:p.fileSha256,templateHash:p.templateSha256,rows:p.rows,requestId:rid()});
 for(const t of imported.rows)await api(`/api/transit/${t.id}/on-shelf`,'assistant-1',{yes:'YES',expectedRevision:t.revision,requestId:rid()});
 const rows=(await api('/api/inventory/catalog','admin')).stockDetails['REVIEW-PACK'],find=fnsku=>rows.find(b=>b.fnsku===fnsku),a=find('SOURCE-12'),b=find('SOURCE-5'),grow=find('SOURCE-GROW'),shrink=find('SOURCE-SHRINK'),bad=find('SOURCE-BAD');
 const first=await create(a),other=await create(b,5);
 const approvals=(await api('/api/approvals','business')).allocations;assert.equal(approvals.find(r=>r.id===first.id).packPerBox,'12');assert.equal(approvals.find(r=>r.id===other.id).packPerBox,'5');assert.notEqual(first.batchKey,other.batchKey);assert.equal(a.plan,b.plan);
 for(const q of [13,0,-12,1.5]){const code=q===13?'allocation_quantity_multiple':'invalid_quantity';const result=await rejectUnchanged(first,reviewBody(first,q),400,code);if(q===13)assert.ok(result.error.includes('12 的整数倍'));rejectDirect(first,q,code);}
 await rejectUnchanged(first,{...reviewBody(first,13),packPerBox:1},400,'allocation_quantity_multiple');await rejectUnchanged(other,reviewBody(other,12),400,'allocation_quantity_multiple');
 const corrected=await approve(first,12);assert.equal(corrected.approvedQuantity,12);assert.equal(corrected.businessNote,'保留商务备注');assert.equal(ledger(first.id,'review_adjustment')[0].locked_delta,0);await approve(other,10);assert.equal(db.getBalance(b.batchKey).locked,10);
 check('来源批次12/5逐单返回；13、零、负数、小数及伪造包装数全部拒绝且所有表不变；修正12、另批10通过');
 const increase=await create(grow);assert.equal(db.getBalance(grow.batchKey).available,12);const payload=reviewBody(increase,24),increased=(await api(`/api/allocations/${increase.id}/review`,'business',payload)).record;assert.equal(increased.quantity,24);assert.equal(db.getBalance(grow.batchKey).locked,24);assert.equal(ledger(increase.id,'review_adjustment')[0].locked_delta,12);
 const after=snapshot();assert.equal((await api(`/api/allocations/${increase.id}/review`,'business',payload)).deduped,true);assert.deepEqual(snapshot(),after);await rejectUnchanged(increased,{...payload,approvedQuantity:12},409,'idempotency_conflict');
 const issued=(await api(`/api/allocations/${increase.id}/confirm`,'assistant-1',{expectedRevision:increased.revision,requestId:rid()})).record;assert.equal(issued.quantity,24);assert.equal(db.getBalance(grow.batchKey).onHand,0);assert.equal(db.getBalance(grow.batchKey).locked,0);assert.equal(ledger(increase.id,'issue')[0].on_hand_delta,-24);
 check('申请12、仅余可用12仍可增批24：只加锁差额12；重放不重复；助理按24出库');
 const reduction=await create(shrink,24);assert.equal(db.getBalance(shrink.batchKey).available,0);await rejectUnchanged(reduction,reviewBody(reduction,36),409,'insufficient_available');const reduced=await approve(reduction,12);assert.equal(reduced.requestedQuantity,24);assert.equal(reduced.quantity,12);assert.equal(db.getBalance(shrink.batchKey).available,12);assert.equal(ledger(reduction.id,'review_adjustment')[0].locked_delta,-12);
 await api(`/api/allocations/${reduced.id}/confirm`,'assistant-1',{expectedRevision:reduced.revision,requestId:rid()});assert.equal(db.getBalance(shrink.batchKey).onHand,12);assert.equal(db.getBalance(shrink.batchKey).locked,0);
 check('超库存增批36失败无写入；可用0时缩批24→12释放12，后续出库账本正确');
 for(const pack of [null,'',' ','0','-12','1.5','abc','Infinity']){
  db.db.prepare('UPDATE stock_batches SET pack_per_box=? WHERE batch_key=?').run('12',bad.batchKey);const row=await create(bad);db.db.prepare('UPDATE stock_batches SET pack_per_box=? WHERE batch_key=?').run(pack,bad.batchKey);
  const view=(await api('/api/approvals','business')).allocations.find(r=>r.id===row.id);assert.equal(view.packPerBox,pack);const result=await rejectUnchanged(row,reviewBody(row,12),400,'invalid_pack_per_box');assert.ok(result.error.includes('来源批次套/箱数据异常'));rejectDirect(row,12,'invalid_pack_per_box');
  const before=db.getBalance(bad.batchKey),body=reviewBody(row,13,'reject'),rejected=(await api(`/api/allocations/${row.id}/review`,'business',body)).record;assert.equal(rejected.approvalStatus,'rejected');assert.equal(db.getBalance(bad.batchKey).locked,before.locked-12);assert.equal(ledger(row.id,'release_reservation')[0].locked_delta,-12);
  const after=snapshot();assert.equal((await api(`/api/allocations/${row.id}/review`,'business',body)).deduped,true);assert.deepEqual(snapshot(),after);assert.equal(db.db.prepare('SELECT pack_per_box FROM stock_batches WHERE batch_key=?').get(bad.batchKey).pack_per_box,pack);
 }
 check('缺失、空、零及异常包装数明确阻止批准；拒绝仍释放原锁定且重放不二次释放，不补数据');
 const old=await create(a);db.db.prepare("UPDATE stock_batches SET pack_per_box='5' WHERE batch_key=?").run(a.batchKey);assert.equal((await api('/api/approvals','business')).allocations.find(r=>r.id===old.id).packPerBox,'5');await rejectUnchanged(old,reviewBody(old,12),400,'allocation_quantity_multiple');const adjusted=await approve(old,10);assert.equal(adjusted.requestedQuantity,12);assert.equal(ledger(old.id,'review_adjustment')[0].locked_delta,-2);db.db.prepare("UPDATE stock_batches SET pack_per_box='12' WHERE batch_key=?").run(a.batchKey);
 check('现存待审申请12在来源变为5时不追改申请；此后批准须修改为10，按差额释放2');
 const replayRow=await create(a),replayBody=reviewBody(replayRow,24),concurrent=await Promise.all([api(`/api/allocations/${replayRow.id}/review`,'business',replayBody),api(`/api/allocations/${replayRow.id}/review`,'business',replayBody)]);assert.equal(concurrent.filter(r=>r.deduped).length,1);assert.equal(ledger(replayRow.id,'review_adjustment').length,1);
 for(const role of ['admin','operation-1','operation-2','assistant-1','assistant-2','purchasing'])await rejectUnchanged(replayRow,reviewBody(replayRow,12),403,'review_forbidden',role);
 const stale=await create(a);await rejectUnchanged(stale,{...reviewBody(stale,12),expectedRevision:stale.revision-1},409,'stale_revision');const approvedStale=await approve(stale,12);await rejectUnchanged(approvedStale,reviewBody(approvedStale,12),409,'invalid_approval_status');
 check('既有商务权限、版本冲突、重复请求和并发幂等保留；成功仅一笔审核差额流水');
 const historical=await create(a),at=new Date().toISOString(),reserve=ledger(historical.id,'reserve')[0];
 // Fixture represents a previously approved non-box quantity; no new approval bypass is exposed.
 db.db.prepare("UPDATE allocation_documents SET quantity=7,approved_quantity=7,approval_status='approved',reviewed_at=?,reviewed_by_role='business',revision=revision+1 WHERE id=?").run(at,historical.id);db.addLedger(historical.id,a.batchKey,'review_adjustment',0,-5,'business',at,reserve.id,null,{approvedQuantity:7});
 const beforeHistorical=snapshot(),view=(await api('/api/approvals','business')).allocations.find(r=>r.id===historical.id);assert.equal(view.approvedQuantity,7);assert.deepEqual(snapshot(),beforeHistorical);await api(`/api/allocations/${view.id}/confirm`,'assistant-1',{expectedRevision:view.revision,requestId:rid()});assert.equal(db.getDocument(view.id).quantity,7);assert.equal(ledger(view.id,'issue')[0].on_hand_delta,-7);
 check('历史已批7不追溯改写，助理仍按既有批准量7出库');
 const inquiry=(await api('/api/inquiries','operation-1',{model:'REVIEW-PACK',quantity:7,department:'一团',store:'REVIEWUS',operator:'询库隔离',fnsku:'INQUIRY-CODE',asin:'BREVIEWINQ',requestId:rid()})).record;const beforeInquiry=db.db.prepare('SELECT * FROM inventory_ledger').all();const inquiryApproved=(await api(`/api/inquiries/${inquiry.id}/review`,'business',reviewBody(inquiry,13))).record;assert.equal(inquiryApproved.approvedQuantity,13);assert.equal(inquiryApproved.status,'pending_purchasing');assert.deepEqual(db.db.prepare('SELECT * FROM inventory_ledger').all(),beforeInquiry);
 check('询库申请7、审核13不受套箱限制且不锁库存');
 db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
}catch(e){failure=e.stack;throw e;}finally{await fs.writeFile(path.join(out,'result.json'),JSON.stringify({state,base,checks,rejections,failure},null,2));if(child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}db.close();}
console.log('ALLOCATION_REVIEW_PACK_PASS '+checks.length+' groups; '+rejections.length+' rejected requests unchanged');