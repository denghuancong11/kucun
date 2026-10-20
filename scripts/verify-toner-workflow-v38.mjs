// Synthetic state roots and owned random-port servers only. Never connects to deployed inventory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {freePort,createTestInstanceId,waitForOwnedServer} from './test-server-ownership.mjs';
import {restoreSchema37Fixture} from './fixtures/schema37-fixture.mjs';

process.env.ASTER_OVERSEAS_WAREHOUSES='SyntheticWarehouseA;SyntheticWarehouseB';
const {createInventoryDatabase,InventoryDatabase,migrateInventoryDatabaseToCurrent,INVENTORY_SCHEMA_VERSION,ROLES}=await import('../inventory-db.mjs');
const root=path.resolve(import.meta.dirname,'..'),out=process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/toner-workflow-v38/api');
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-toner-v38-')),databasePath=path.join(state,'data/aster-inventory.sqlite');
await fs.mkdir(out,{recursive:true});createInventoryDatabase({databasePath});
let db=new InventoryDatabase(state),server,failure,diagnostics='';
const port=await freePort(),base=`http://127.0.0.1:${port}`,checks=[],rejections=[],migrationEvidence=[],downloads=[];
const rid=()=>crypto.randomUUID(),common=r=>({expectedRevision:r.revision,requestId:rid()});
const snapshot=(connection=db.db)=>Object.fromEntries(connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,connection.prepare(`SELECT * FROM "${name}"`).all()]));
const inventory=()=>Object.fromEntries(['stock_batches','stock_receipts','inventory_ledger','upgrade_inventory_ledger'].map(name=>[name,db.db.prepare(`SELECT * FROM ${name}`).all()]));
const check=label=>{checks.push(label);console.log('PASS '+label);};
async function start(){const instanceId=createTestInstanceId('toner-v38');diagnostics='';server=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ASTER_STATE_ROOT:state,ASTER_TEST_INSTANCE_ID:instanceId,HOST:'127.0.0.1',PORT:String(port),PROD:'1'}});server.stdout.on('data',v=>diagnostics+=v);server.stderr.on('data',v=>diagnostics+=v);try{await waitForOwnedServer({base,child:server,instanceId});}catch(e){throw new Error(e.message+'\n'+diagnostics);}}
async function stop(){if(server?.exitCode===null){const ended=once(server,'exit');server.kill();await ended;}server=null;}
// Synchronous XLSX readers may outlive keepalive; business assertions do not exercise pooled sockets.
async function api(route,role='admin',body,status=200){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{connection:'close','x-role':role,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const j=await r.json();if(status!==null)assert.equal(r.status,status,`${role} ${route}: ${JSON.stringify(j)}`);return {...j,httpStatus:r.status};}
async function reject(route,role,body,status=403,code){const before=snapshot(),j=await api(route,role,body,status);if(code)assert.equal(j.code,code);assert.deepEqual(snapshot(),before);rejections.push({route,role,status,code:j.code});return j;}
const batch=()=>db.db.prepare("SELECT * FROM stock_batches WHERE model='SYNTH-TONER-001' ORDER BY ship_date LIMIT 1").get();
async function allocation(q=100){const b=batch();return(await api('/api/allocations','operation-1',{model:b.model,sourceBatchKey:b.batch_key,plan:b.plan,date:b.ship_date,version:b.version,quantity:q,department:'一团',store:'TONERUS',operator:'硒鼓隔离验收',fnsku:'000TONER',asin:'BTONER38',operatorNote:'原运营备注',requestId:rid()})).record;}
async function inquiry(q=100,operator=rid()){return(await api('/api/inquiries','operation-1',{model:'SYNTH-TONER-001',quantity:q,department:'一团',store:'TONERUS',operator,fnsku:'000TONER',asin:'BTONER38',operatorNote:'原询库备注',requestId:rid()})).record;}
async function review(r,kind='allocations',q=80,decision='approve'){return(await api(`/api/${kind}/${r.id}/review`,'business',{...common(r),decision,approvedQuantity:q,businessNote:'商务备注'})).record;}
const replyBody=(r,q=60)=>({...common(r),supplierQuantity:q,shippingWarehouse:'CA',procurementNote:'采购独立备注'});
async function reply(r,q=60){return(await api(`/api/inquiries/${r.id}/reply`,'purchasing',replyBody(r,q))).record;}
const archiveBody=r=>({...common(r),plan:'NEW-PLAN-'+r.id,date:'2026-10-16',version:'NEW-V38'});
async function archive(r){return(await api(`/api/inquiries/${r.id}/archive`,'purchasing',archiveBody(r))).record;}
async function transfer(r,q=83){return(await api(`/api/allocations/${r.id}/transfer-inquiry`,'business',{...common(r),approvedQuantity:q,businessNote:'商务转询库备注'})).record;}
async function decide(r,decision='accept',role='operation-1',body){return api(`/api/allocations/${r.id}/conversion-decision`,role,body||{...common(r),decision});}
const ledger=r=>db.db.prepare('SELECT * FROM inventory_ledger WHERE document_id=? ORDER BY id').all(r.id);
const candidate=r=>db.getRelocationCandidates().find(c=>c.inquiryId===r.id);
async function exportRows(role,filters,name){const before=snapshot(),r=await fetch(base+'/api/approvals/inquiries/export?'+new URLSearchParams(filters),{headers:{connection:'close','x-role':role}});assert.equal(r.status,200);const file=path.join(out,name+'.xlsx');await fs.writeFile(file,Buffer.from(await r.arrayBuffer()));const read=JSON.parse(execFileSync(process.env.ASTER_TEST_PYTHON||'python',[path.join(root,'scripts/fixtures/read-inquiry-export.py'),file],{encoding:'utf8',windowsHide:true}));assert.equal(read.maxColumn,13);assert.deepEqual(snapshot(),before);downloads.push({file,rows:read.maxRow-1});return read.rows;}

async function migrationTest(){
  const legacyState=await fs.mkdtemp(path.join(os.tmpdir(),'aster-toner-v37-to-v38-')),legacyPath=path.join(legacyState,'data/aster-inventory.sqlite');
  createInventoryDatabase({databasePath:legacyPath});const old=new InventoryDatabase(legacyState);
  const b=old.db.prepare("SELECT * FROM stock_batches WHERE model='SYNTH-TONER-001' LIMIT 1").get();old.db.prepare("UPDATE stock_batches SET pack_per_box='10' WHERE batch_key=?").run(b.batch_key);
  const make=()=>old.createAllocation({role:'operation-1',model:b.model,sourceBatchKey:b.batch_key,plan:b.plan,date:b.ship_date,version:b.version,quantity:100,department:'一团',store:'OLDUS',operator:'原待商务',fnsku:'000OLD',asin:'BOLD38',requestId:rid()}).record;
  const pending=[make(),make()],later=old.reviewAllocation({id:make().id,role:'business',decision:'approve',approvedQuantity:80,expectedRevision:1,requestId:rid()}).record;
  const makeInquiry=()=>old.createInquiry({role:'operation-1',model:b.model,quantity:100,department:'一团',store:'OLDUS',operator:'原询库',fnsku:'000OLD',asin:'BOLD38',requestId:rid()}).record;
  const ready=()=>{const r=makeInquiry();return old.reviewInquiry({id:r.id,role:'business',decision:'approve',approvedQuantity:80,...common(r)}).record;};
  const denied=makeInquiry();old.reviewInquiry({id:denied.id,role:'business',decision:'reject',businessNote:'原拒绝',...common(denied)});
  // Exact historical v37 facts: supplier replies overwrote current quantities, including zero;
  // assistants archived positive/zero replies. Insert source facts without invoking v38 actions.
  const historicalReply=(r,q)=>{const at='2026-10-01T01:00:00.000Z';old.db.prepare(`UPDATE inquiry_documents SET requested_quantity=?,approved_quantity=?,supplier_quantity=?,
    shipping_warehouse='CA',status='pending_assistant',replied_by_role='purchasing',replied_at=?,revision=revision+1 WHERE id=?`).run(q,q,q,at,r.id);
    old.db.prepare("INSERT INTO inquiry_events(inquiry_id,event_type,role,occurred_at,payload_json) VALUES(?,'reply','purchasing',?,?)").run(r.id,at,JSON.stringify({supplierQuantity:q,shippingWarehouse:'CA',procurementNote:''}));};
  for(const q of [60,0]){const r=ready();historicalReply(r,q);const at='2026-10-01T02:00:00.000Z';old.db.prepare(`UPDATE inquiry_documents SET status='archived',plan=?,ship_date='2026-10-01',version='OLD',
    archived_by_role='assistant-1',archived_at=?,revision=revision+1 WHERE id=?`).run('OLD-'+q,at,r.id);
    old.db.prepare("INSERT INTO inquiry_events(inquiry_id,event_type,role,occurred_at,payload_json) VALUES(?,'archive','assistant-1',?,?)").run(r.id,at,JSON.stringify({plan:'OLD-'+q,date:'2026-10-01',version:'OLD',quantity:q}));}
  const zeroPending=ready();historicalReply(zeroPending,0);
  // Simulate schema37 without v38 terminal projections before exercising the migration.
  const noDeleteTrigger=old.db.prepare("SELECT sql FROM sqlite_master WHERE name='document_events_no_delete'").get().sql;
  old.db.exec("DROP TRIGGER document_events_no_delete; DELETE FROM document_events WHERE event_type IN ('inquiry_completed','inquiry_rejected');");
  old.db.exec(noDeleteTrigger);
  restoreSchema37Fixture(old.db);
  const before=snapshot(old.db),oldColumns=old.db.prepare('PRAGMA table_info(allocation_documents)').all().map(c=>'"'+c.name+'"').join(',');old.close();
  const result=JSON.parse(execFileSync(process.execPath,[path.join(root,'scripts/migrate-inventory-v3.mjs'),'--state-root',legacyState,
    '--backup-root',path.join(legacyState,'controlled-backups')],{cwd:root,encoding:'utf8',windowsHide:true}));assert.equal(result.fromVersion,37);assert.equal(result.toVersion,38);
  const backup=new DatabaseSync(path.join(result.backupPath,'data/aster-inventory.sqlite'),{readOnly:true});
  try{assert.equal(backup.prepare('PRAGMA user_version').get().user_version,37);assert.deepEqual(snapshot(backup),before);}finally{backup.close();}
  const migrated=new InventoryDatabase(legacyState);
  try{
    for(const [name,rows]of Object.entries(before)){
      if(['schema_migrations','system_meta','document_events'].includes(name))continue;
      if(name==='sqlite_sequence')continue;
      const actual=name==='allocation_documents'?migrated.db.prepare('SELECT '+oldColumns+' FROM allocation_documents').all():migrated.db.prepare('SELECT * FROM "'+name+'"').all();
      assert.deepEqual(actual,rows,name+' changed historical facts');
    }
    assert.deepEqual(migrated.db.prepare('SELECT * FROM document_events WHERE id<=? ORDER BY id').all(before.document_events.at(-1).id),before.document_events);
    const projected=migrated.db.prepare("SELECT * FROM document_events WHERE event_type IN ('inquiry_completed','inquiry_rejected')").all();assert.equal(projected.length,3);
    assert(!projected.some(e=>JSON.parse(e.payload_json).inquiryId===zeroPending.id));
    for(const e of projected){const p=JSON.parse(e.payload_json),original=migrated.db.prepare('SELECT * FROM inquiry_events WHERE id=?').get(p.sourceInquiryEventId);assert.equal(e.role,original.role);assert.equal(e.occurred_at,original.occurred_at);assert.equal(p.quantity,original.event_type==='archive'?JSON.parse(original.payload_json).quantity:100);assert.equal(p.onHandDelta,0);assert.equal(p.lockedDelta,0);}
    for(const r of [...pending,later]){assert.equal(migrated.getDocument(r.id).tonerConversionStatus,null);assert.equal(migrated.getDocument(r.id).statusCode,'pending');assert.equal(migrated.getDocument(r.id).lockedQuantity,r.quantity);}
    const repeat=snapshot(migrated.db);assert.equal(migrateInventoryDatabaseToCurrent({databasePath:legacyPath}).changed,false);assert.deepEqual(snapshot(migrated.db),repeat);
    const all=migrated.audit({limit:500});assert.deepEqual(all.map(x=>[x.at,x.eventId]),[...all].sort((a,b)=>b.at.localeCompare(a.at)||b.eventId-a.eventId).map(x=>[x.at,x.eventId]));
    assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(),[]);migrationEvidence.push({legacyState,result,projected:projected.length,unchangedPendingIds:pending.map(r=>r.id),unchangedLaterId:later.id});
  }finally{migrated.close();}
  check('schema37合成夹具→38受控迁移有完整备份；业务/旧事件/锁账不变，两待商及阶段漂移不重置，仅原archive/reject时刻角色数量投影');
}

try{
  assert.equal(INVENTORY_SCHEMA_VERSION,38);await migrationTest();
  db.db.prepare("UPDATE stock_batches SET pack_per_box='10' WHERE model='SYNTH-TONER-001'").run();await start();
  db.syncLingxing({role:'admin',items:[{asin:'BTONER38',sales7d:1,sales30d:2,orderGrossProfit:321,fbaAvailable:1,fbaPendingTransfer:0,fbaTransferring:0,fbaInbound:0}],capturedAt:new Date().toISOString(),requestId:rid()});
  let r=await allocation();assert.equal(r.lockedQuantity,100);assert.equal(r.statusText,'待商务审核');const b0=db.getBalance(r.batchKey);assert.equal(b0.onHand,800);
  await reject(`/api/allocations/${r.id}/review`,'operation-1',{...common(r),decision:'approve',approvedQuantity:80});
  r=await review(r);assert.equal(r.lockedQuantity,80);assert.equal(r.statusText,'待助理确认');assert.equal(r.finalQuantity,80);assert.equal(r.finalQuantitySource,'business');r=await review(await allocation(), 'allocations', 120);assert.equal(r.lockedQuantity,120);assert.equal(r.finalQuantity,120);
  await reject(`/api/allocations/${r.id}/confirm`,'assistant-2',common(r));
  const confirmRequest=common(r);r=(await api(`/api/allocations/${r.id}/confirm`,'assistant-1',confirmRequest)).record;assert.equal(r.issuedQuantity,120);assert.equal(r.lockedQuantity,0);assert.equal(db.getBalance(r.batchKey).onHand,680);assert.equal(r.statusText,'已完成');
  assert.equal((await api(`/api/allocations/${r.id}/confirm`,'assistant-1',confirmRequest)).deduped,true);assert.equal(ledger(r).filter(x=>x.entry_type==='issue').length,1);
  let denied=await allocation();denied=await review(denied,'allocations',80,'reject');assert.equal(denied.lockedQuantity,0);assert.equal(denied.issuedQuantity,0);assert.equal(denied.statusText,'已拒绝');
  check('正常调拨预锁、商务缩增量、助理全量发出、拒绝释放、跨团拒绝及幂等扣库');

  let converted=await allocation();const beforeConvert=db.getBalance(converted.batchKey);converted=await transfer(converted,833);
  assert.equal(converted.tonerConversionStatus,'pending_confirmation');assert.equal(converted.approvalStatus,'approved');assert.equal(converted.statusCode,'pending');assert.equal(converted.statusText,'转询库，待运营确认');assert.equal(converted.lockedQuantity,0);assert.equal(converted.issuedQuantity,0);assert.equal(converted.finalQuantity,null);assert(converted.isVirtual);assert.equal(converted.inkWorkflowStage,null);assert.equal(db.getBalance(converted.batchKey).onHand,beforeConvert.onHand);assert.equal(ledger(converted).at(-1).locked_delta,-100);
  await reject(`/api/allocations/${converted.id}/review`,'business',{...common(converted),decision:'approve',approvedQuantity:80},409);
  await reject(`/api/allocations/${converted.id}/confirm`,'assistant-1',common(converted),409);
  await reject(`/api/allocations/${converted.id}/conversion-decision`,'operation-2',{...common(converted),decision:'accept'});
  const publicSummary=(await api('/api/allocations?model='+converted.model,'operation-1')).publicRecords[converted.batchKey].find(x=>x.id===converted.id);assert.equal(publicSummary.lockedQuantity,0);assert.equal(publicSummary.tonerConversionStatus,'pending_confirmation');
  const acceptRequest={...common(converted),decision:'accept'},accepted=await decide(converted,'accept','operation-1',acceptRequest);converted=accepted.record;let child=accepted.inquiry;
  assert.equal(converted.statusText,'已转询库');assert.equal(converted.tonerConversionStatus,'accepted');assert.equal(converted.convertedInquiryId,child.id);assert.equal(converted.convertedInquiryNo,child.documentNo);assert.equal(child.sourceAllocationNo,converted.documentNo);assert.equal(child.sourceOriginalRequestedQuantity,100);assert.equal(child.originalRequestedQuantity,833);assert.equal(child.requestedQuantity,833);assert.equal(child.businessReviewedQuantity,833);assert.equal(child.reviewedByRole,'business');assert.equal(child.status,'pending_purchasing');assert.equal(child.plan,'');assert.equal(child.date,'');assert.equal(child.version,'');assert.equal(child.events.filter(e=>e.type==='review').length,0);
  assert.equal((await decide(converted,'accept','operation-1',acceptRequest)).deduped,true);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM inquiry_documents WHERE source_allocation_id=?').get(converted.id).n,1);assert(!db.getRelocationCandidates().some(c=>c.allocationId===converted.id));
  check('非整箱且超来源可用的商务转量可转；按实际净预锁释放、禁重复审/发、唯一直入采购，来源100与承接833分开');

  let refused=await transfer(await allocation(),83);refused=(await decide(refused,'reject')).record;assert.equal(refused.statusText,'已拒绝');assert.equal(refused.tonerConversionStatus,'rejected');assert.equal(refused.lockedQuantity,0);assert.equal(refused.convertedInquiryId,null);
  let race=await transfer(await allocation(),83);const raceBody=common(race);const results=await Promise.all(['accept','reject'].map(decision=>api(`/api/allocations/${race.id}/conversion-decision`,'operation-1',{...raceBody,requestId:rid(),decision},null)));assert.deepEqual(results.map(x=>x.httpStatus).sort(),[200,409]);race=db.getDocument(race.id);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM inquiry_documents WHERE source_allocation_id=?').get(race.id).n,race.tonerConversionStatus==='accepted'?1:0);assert.equal(race.lockedQuantity,0);
  check('运营不接受零扣库，接受/不接受并发只一终态与至多一承接单');

  const inventoryBeforeInquiry=inventory();let demand=await review(await inquiry(100,'TONER-COMPLETE'),'inquiries',80);assert.equal(demand.statusText,'待采购确认');
  for(const actor of ROLES.filter(x=>x!=='purchasing'))await reject(`/api/inquiries/${demand.id}/reply`,actor,replyBody(demand));
  demand=await reply(demand,61);assert.equal(demand.statusText,'待采购归档');assert.equal(demand.requestedQuantity,100);assert.equal(demand.approvedQuantity,80);assert.equal(demand.supplierQuantity,61);assert.equal(demand.originalRequestedQuantity,100);assert.equal(demand.businessReviewedQuantity,80);assert.equal(demand.shippingWarehouse,'CA');assert.equal(demand.procurementNote,'采购独立备注');
  for(const actor of ROLES.filter(x=>x!=='purchasing'))await reject(`/api/inquiries/${demand.id}/archive`,actor,archiveBody(demand));
  for(const field of ['plan','date','version'])await reject(`/api/inquiries/${demand.id}/archive`,'purchasing',{...archiveBody(demand),[field]:''},400);
  const beforeArchive=common(demand);demand=await archive(demand);assert.equal(demand.statusText,'已完成');assert.equal(demand.archivedByRole,'purchasing');assert.equal(demand.events.at(-1).payload.shipmentConfirmed,true);assert.equal(candidate(demand).initialQuantity,61);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM upgrade_relocation_work_items WHERE inquiry_id=?').get(demand.id).n,0);assert.deepEqual(inventory(),inventoryBeforeInquiry);
  await reject(`/api/inquiries/${demand.id}/archive`,'purchasing',{...archiveBody(demand),...beforeArchive,requestId:rid()},409);
  let more=await review(await inquiry(100,'TONER-MORE'),'inquiries',80);more=await reply(more,121);assert.equal(more.approvedQuantity,80);assert.equal(more.supplierQuantity,121);
  let zero=await review(await inquiry(100,'TONER-ZERO'),'inquiries',80);zero=await reply(zero,0);assert.equal(zero.status,'rejected');assert.equal(zero.requestedQuantity,100);assert.equal(zero.approvedQuantity,80);assert.equal(zero.supplierQuantity,0);assert(!candidate(zero));await reject(`/api/inquiries/${zero.id}/archive`,'purchasing',archiveBody(zero),409);
  let rejectedInquiry=await review(await inquiry(100,'TONER-REJECT'),'inquiries',80,'reject');assert.equal(rejectedInquiry.status,'rejected');
  check('硒鼓仅采购两步；最终61/121/0不覆盖原100和商务80，0拒绝、正数全量归档才入候选，库存始终不变');

  for(const r of [demand,zero,rejectedInquiry]){const e=db.db.prepare("SELECT * FROM document_events WHERE event_type IN ('inquiry_completed','inquiry_rejected') AND json_extract(payload_json,'$.inquiryId')=?").get(r.id);assert(e);const p=JSON.parse(e.payload_json);assert.equal(p.onHandDelta,0);assert.equal(p.lockedDelta,0);const detail=await api('/api/audit/'+e.id,'purchasing');assert.equal(detail.document.id,r.id);assert.equal(Object.hasOwn(detail.document.lingxing,'orderGrossProfit'),false);await reject('/api/audit/'+e.id,'operation-2',undefined,403);}
  const mine=await exportRows('purchasing',{category:'硒鼓',type:'inquiry',scope:'mine'},'purchasing-mine');assert(mine.some(x=>x[9]==='TONER-MORE'));assert(!mine.some(x=>x[9]==='TONER-COMPLETE'));
  const logisticsMine=await exportRows('logistics',{category:'硒鼓',type:'inquiry',scope:'mine'},'logistics-mine');assert.equal(logisticsMine.length,1);
  const all=await exportRows('logistics',{category:'硒鼓',type:'inquiry'},'logistics-all');const row=all.find(x=>x[9]==='TONER-COMPLETE');assert(row);assert.equal(row[1],80);assert.equal(row[4],61);assert.equal(row[12],'已完成');
  check('完成/商务拒绝/零拒绝写零变化流水且守团队/毛利；13列导出值正确，采购mine含归档待办，物流mine无办理项');

  child=await reply(child,72);child=await archive(child);const clear=await api('/api/approvals/inquiries/clear','logistics',{requestId:rid()});assert(clear.hiddenCount>=3);assert.equal(db.db.prepare('SELECT approval_hidden FROM inquiry_documents WHERE id=?').get(child.id).approval_hidden,1);
  const readBefore=snapshot();const history=await api(`/api/inquiries/${child.id}/history`,'purchasing');assert.equal(history.document.id,child.id);assert.equal(history.document.category,'硒鼓');assert.equal(history.document.sourceOriginalRequestedQuantity,100);assert.equal(history.document.sourceAllocationId,converted.id);assert.equal(history.document.sourceAllocationNo,converted.documentNo);assert.equal(Object.hasOwn(history.document.lingxing,'orderGrossProfit'),false);assert.deepEqual(snapshot(),readBefore);
  await reject(`/api/inquiries/${child.id}/history`,'operation-2',undefined,403);const original=await api(`/api/allocations/${converted.id}/history`,'operation-1');assert.equal(original.document.convertedInquiryId,child.id);assert.equal(original.document.convertedInquiryNo,child.documentNo);
  check('物流清空不删事实/候选；隐藏询库history只读可查、双向关联与来源数量完整、跨团拒绝及毛利裁剪');

  const ib=db.db.prepare("SELECT * FROM stock_batches WHERE model='SYNTH-INK-001' LIMIT 1").get();db.db.prepare("UPDATE stock_batches SET pack_per_box='10' WHERE batch_key=?").run(ib.batch_key);
  const ia=db.createAllocation({role:'admin',model:ib.model,sourceBatchKey:ib.batch_key,plan:ib.plan,date:ib.ship_date,version:ib.version,quantity:10,department:'一团',store:'INKUS',operator:'只读权限夹具',fnsku:'000READ',asin:'BREAD38',requestId:rid()}).record;
  const iq=db.createInquiry({role:'admin',model:ib.model,quantity:10,department:'一团',store:'INKUS',operator:'只读权限夹具',fnsku:'000READ',asin:'BREAD38',requestId:rid()}).record;
  const permissionFile=path.join(state,'data/permissions.json'),matrix={'墨盒':Object.fromEntries(ROLES.map(role=>[role,{summary:true,detail:true,expand:true,actions:true}]))};
  for(const field of ['summary','detail','expand']){matrix['墨盒'].business[field]=false;await fs.writeFile(permissionFile,JSON.stringify(matrix));
    await reject(`/api/allocations/${ia.id}/history`,'business',undefined,403,'allocation_read_forbidden');await reject(`/api/inquiries/${iq.id}/history`,'business',undefined,403,'inquiry_read_forbidden');matrix['墨盒'].business[field]=true;}
  matrix['墨盒'].business.actions=false;await fs.writeFile(permissionFile,JSON.stringify(matrix));const readOnlyBefore=snapshot();
  assert.equal((await api(`/api/allocations/${ia.id}/history`,'business')).document.id,ia.id);assert.equal((await api(`/api/inquiries/${iq.id}/history`,'business')).document.id,iq.id);assert.deepEqual(snapshot(),readOnlyBefore);
  await reject(`/api/allocations/${ia.id}/review`,'business',{...common(ia),decision:'approve',approvedQuantity:10},403,'action_forbidden');await fs.unlink(permissionFile);
  check('两类history均守summary/detail/expand；actions关闭仍可只读但不能审核，读取不写数据');

  const restart=snapshot();await stop();db.close();db=new InventoryDatabase(state);await start();assert.deepEqual(snapshot(),restart);db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
  check('隔离服务/数据库重启后事实与关联持久化、库存恒等式及外键正常');
}catch(e){failure=e.stack;throw e;}finally{await stop();db?.close();await fs.writeFile(path.join(out,'result.json'),JSON.stringify({state,base,schemaVersion:INVENTORY_SCHEMA_VERSION,checks,rejections,migrationEvidence,downloads,failure:failure??null,productionWrites:0},null,2));}
console.log(`TONER_WORKFLOW_V38_PASS ${checks.length} groups; ${rejections.length} rejected requests unchanged`);
