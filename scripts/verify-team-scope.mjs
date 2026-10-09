import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInventoryDatabase,InventoryDatabase,INVENTORY_DATABASE_NAME} from '../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from './test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/team-scope');
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-teams-'));await fs.mkdir(path.join(state,'data'));await fs.mkdir(out,{recursive:true});
createInventoryDatabase({databasePath:path.join(state,'data',INVENTORY_DATABASE_NAME)});
const db=new InventoryDatabase(state),port=await freePort(),base=`http://127.0.0.1:${port}`,instanceId=createTestInstanceId('team-scope');
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,PORT:String(port),HOST:'127.0.0.1',PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
const checks=[],check=name=>{checks.push(name);console.log('PASS '+name);},rid=()=>crypto.randomUUID();
const api=async(route,role='admin',body,status=200)=>{const res=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data;};
const headers=['Brand','ITEM','订单数量','套/箱','FNSKU','发货方式','计划号','出货时间','团队','版本号'];
const upload=async(rows,role,name,status=200,route='/api/transit/preview')=>{const res=await fetch(base+route,{method:'POST',headers:{'x-role':role,'x-file-name':encodeURIComponent(name)},body:Buffer.from(rows.map(row=>row.join(',')).join('\n'))});const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data;};
const payload=(p,name)=>({previewToken:p.previewToken,fileName:name,fileHash:p.fileSha256,templateHash:p.templateSha256,rows:p.rows.map(row=>({...row,data:{...row.data,version:'V1'}})),requestId:rid()});
const imp=async(rows,name,role='assistant-1')=>api('/api/transit/import',role,payload(await upload(rows,role,name),name));
const row=(model,team,fnsku,plan,quantity)=>['Aster',model,quantity,'4',fnsku,'整柜',plan,'2026-09-01',team,'V1'];
try {
 await waitForOwnedServer({base,child,instanceId});
 const transitSnapshot=()=>({batches:db.db.prepare('SELECT COUNT(*) n FROM transit_batches').get().n,imports:db.db.prepare('SELECT COUNT(*) n FROM import_batches').get().n,previews:db.db.prepare('SELECT COUNT(*) n FROM transit_preview_tokens').get().n,events:db.db.prepare('SELECT COUNT(*) n FROM transit_events').get().n,ledger:db.db.prepare('SELECT COUNT(*) n FROM inventory_ledger').get().n,dataVersion:db.syncState().dataVersion});
 const deniedTransitRoles=['operation-1','operation-2','business'];
 const deniedSnapshot=transitSnapshot();
 for(const role of deniedTransitRoles){
  await upload([headers,row('TEAM-TONER','一团','XDENIED','DENIED-'+role,1)],role,`拒绝${role}.csv`,403);
  await api('/api/transit/import',role,{},403);
  await upload([['计划号','物流状态'],['DENIED','到港']],role,'拒绝物流.csv',403,'/api/transit/status/preview');
  await api('/api/transit/status/apply',role,{},403);
  await api('/api/transit/imports',role,undefined,403);
  for(const action of [
   ()=>db.requireTransitImportTeams(role,[]),
   ()=>db.createTransitPreviewToken({kind:'import',role,fileName:'x.csv',fileHash:'x',templateHash:'x',payload:{rows:[]}}),
   ()=>db.consumeTransitPreviewToken({kind:'import',role,token:'x'}),
   ()=>db.transitImport({role,requestId:rid(),rows:[]}),
   ()=>db.previewTransitStatusUpdates([],role),
   ()=>db.updateTransitStatuses({role,requestId:rid(),rows:[]}),
   ()=>db.listTransitImports(role),
  ]) assert.throws(action,error=>error.status===403);
 }
 assert.deepEqual(transitSnapshot(),deniedSnapshot);
 check('运营两团、商务的在途预览/提交/导入记录接口及数据库方法均拒绝，库存、批次、预览令牌和流水不变');
 for(const role of ['admin','assistant-1','assistant-2','purchasing']) assert.ok(Array.isArray((await api('/api/transit/imports',role)).imports));
 check('管理员、两类助理和采购可查询在途导入记录');
 const entryCounts=()=>db.db.prepare('SELECT (SELECT COUNT(*) FROM allocation_documents) allocations,(SELECT COUNT(*) FROM inquiry_documents) inquiries,(SELECT COUNT(*) FROM inventory_ledger) ledger').get();
 const beforeAssistantEntry=entryCounts();for(const role of ['assistant-1','assistant-2']){await api('/api/allocations',role,{},403);await api('/api/inquiries',role,{},403);}assert.deepEqual(entryCounts(),beforeAssistantEntry);check('两类助理未获得运营专属的调拨/询库录入权限，没有新增单据或库存流水');
 for(const [category,model] of [['硒鼓','TEAM-TONER'],['墨盒','TEAM-INK']]) {
  const name=`隔离${category}.csv`,stock=await imp([headers,row(model,'一团','XTEAMSTOCK','STOCK-'+model,500)],name);
  const t=stock.rows[0];await api(`/api/transit/${t.id}/on-shelf`,'assistant-1',{yes:'YES',expectedRevision:t.revision,requestId:rid()});
  let secondBatchKey;
  if(category==='墨盒'){
   const teamTwoStock=await imp([headers,row(model,'二团','XTEAMSECOND','STOCK2-'+model,100)],`隔离${category}二团.csv`,'assistant-2'),teamTwoTransit=teamTwoStock.rows[0];
   await api(`/api/transit/${teamTwoTransit.id}/on-shelf`,'assistant-2',{yes:'YES',expectedRevision:teamTwoTransit.revision,requestId:rid()});
   secondBatchKey=db.db.prepare('SELECT batch_key FROM stock_batches WHERE model=? AND plan=? AND version=?').get(model,'STOCK2-'+model,'V1').batch_key;
  }
  const fields={model,plan:category==='墨盒'?'STOCK2-'+model:'STOCK-'+model,date:'2026-09-01',version:'V1',...(secondBatchKey?{sourceBatchKey:secondBatchKey}:{}),quantity:100,department:'二团',store:'AUS',operator:'二团运营',fnsku:category==='墨盒'?'XTEAMSECOND':'XTEAMSTOCK',asin:'BTEAM00002',requestId:rid()};
  let second=(await api('/api/allocations','operation-2',fields)).record;
  const firstView=await api('/api/allocations?model='+model,'operation-1');
  const restricted=category==='墨盒';
  assert.equal(Object.values(firstView.records).flat().length,0);
  const publicSecond=Object.values(firstView.publicRecords).flat();assert.equal(publicSecond.length,restricted?0:1);
  for(const [role,team] of [['assistant-1','一团'],['assistant-2','二团']]) {
   const assistantView=await api('/api/allocations?model='+model,role),publicRows=Object.values(assistantView.publicRecords).flat(),privateRows=Object.values(assistantView.records).flat();
   assert.equal(publicRows.length,restricted?(team==='二团'?1:0):1);
   if(!restricted) {
    assert.deepEqual(publicRows.map(row=>row.department),['二团']);
    assert.deepEqual(Object.keys(publicRows[0]).sort(),['id','documentNo','operator','department','requestedQuantity','approvedQuantity','lockedQuantity','issuedQuantity','status'].sort());
   }
   assert.equal(privateRows.length,team==='二团'?1:0);
   assert.ok(privateRows.every(row=>row.department===team));
  }
  if(!restricted){
   assert.equal(publicSecond[0].operator,'二团运营');assert.equal(publicSecond[0].lockedQuantity,100);
   assert.deepEqual(Object.keys(publicSecond[0]).sort(),['id','documentNo','operator','department','requestedQuantity','approvedQuantity','lockedQuantity','issuedQuantity','status'].sort());
  }
  assert.deepEqual(Object.values(firstView.totals).map(b=>[b.onHand,b.locked,b.available]),restricted?[[500,0,500]]:[[500,100,400]]);
  const catalog=(await api('/api/inventory/catalog','operation-1')).models.find(m=>m.model===model);assert.deepEqual([catalog.inStock,catalog.locked,catalog.available],restricted?[500,0,500]:[500,100,400]);
  check(category+'：库存按既定范围汇总，硒鼓跨团只公开摘要，完整单据按本团过滤');
  await api('/api/allocations','operation-1',{...fields,requestId:rid()},403);
  await api('/api/inquiries','operation-1',{...fields,requestId:rid()},403);
  await api(`/api/allocations/${second.id}/history`,'operation-1',undefined,403);
  const secondEvent=db.db.prepare("SELECT id FROM document_events WHERE document_id=? AND event_type='entry'").get(second.id).id;
  await api('/api/audit/'+secondEvent,'operation-1',undefined,403);assert.ok(!(await api('/api/audit?model='+model,'operation-1')).records.some(r=>r.documentId===second.id));
  assert.throws(()=>db.createInquiry({...fields,role:'operation-1',requestId:rid()}),e=>e.status===403);
  assert.throws(()=>db.createAllocation({...fields,role:'operation-1',requestId:rid()}),e=>e.status===403);
  check(category+'：伪造部门、跨团记录编号、流水详情均拒绝');
  const firstFields={...fields,plan:'STOCK-'+model,fnsku:'XTEAMSTOCK',...(category==='墨盒'?{sourceBatchKey:null}:{})};
  const first=(await api('/api/allocations','operation-1',{...firstFields,department:'一团',store:'BUS',quantity:20,operator:'一团运营',requestId:rid()})).record;
  let inquiry=(await api('/api/inquiries','operation-2',{...fields,quantity:20,requestId:rid()})).record;
  for(const [role,team] of [['operation-1','一团'],['operation-2','二团']]) {
   const approvals=await api('/api/approvals',role);for(const r of [...approvals.allocations,...approvals.inquiries])assert.equal(r.department,team);
  }
  second=(await api(`/api/allocations/${second.id}/review`,'business',{decision:'approve',approvedQuantity:100,expectedRevision:second.revision,requestId:rid()})).record;
  second=(await api(`/api/allocations/${second.id}/confirm`,'assistant-2',{expectedRevision:second.revision,requestId:rid()})).record;
  inquiry=(await api(`/api/inquiries/${inquiry.id}/review`,'business',{decision:'approve',approvedQuantity:20,expectedRevision:inquiry.revision,requestId:rid()})).record;
  inquiry=(await api(`/api/inquiries/${inquiry.id}/reply`,'purchasing',{supplierQuantity:20,shippingWarehouse:'CA',expectedRevision:inquiry.revision,requestId:rid()})).record;
  inquiry=(await api(`/api/inquiries/${inquiry.id}/archive`,'assistant-2',{plan:'ARCHIVE-'+model,date:'2026-09-10',version:'V1',expectedRevision:inquiry.revision,requestId:rid()})).record;
  for(const source of [{allocationId:second.id},{inquiryId:inquiry.id}]) {
   await api('/api/upgrades/relocation-work-items','operation-1',{...source,requestId:rid()},403);
   let work=(await api('/api/upgrades/relocation-work-items','operation-2',{...source,requestId:rid()})).workItem;
   work=(await api(`/api/upgrades/relocation-work-items/${work.id}/procurement`,'purchasing',{rma:'RMA',relocationAddress:'仓库',expectedRevision:work.revision,requestId:rid()})).workItem;
   await api(`/api/upgrades/relocation-work-items/${work.id}/operation`,'operation-1',{removalOrderNo:'TEAMORDER',expectedRevision:work.revision,requestId:rid()},403);
   await api(`/api/upgrades/relocation-work-items/${work.id}/operation`,'operation-2',{removalOrderNo:'TEAMORDER-'+work.id,expectedRevision:work.revision,requestId:rid()});
   await api('/api/lingxing/jobs','operation-1',{action:'logistics',workId:work.id,requestId:rid()},403);
   const own=(await api('/api/lingxing/jobs','operation-2',{action:'logistics',workId:work.id,requestId:rid()},202)).job;
   assert.deepEqual((await api(`/api/lingxing/jobs?action=logistics&workId=${work.id}&requestId=${own.requestId}`,'operation-1')).jobs,[]);
  }
  const upgrades=await api('/api/upgrades','operation-1');assert.ok(upgrades.relocationCandidates.every(r=>r.department==='一团'));assert.ok(upgrades.relocationWorkItems.every(r=>r.department==='一团'));
  check(category+'：商务、采购、助理处理后仍归原团；调拨/询库归档、移仓及物流任务不串团');
  const mixed=[headers,row(model,'一团','XTEAMONE','MIX-'+model,30),row(model,'二团','XTEAMTWO','MIX-'+model,40)];
  const good=[headers,row(model,'一团','XOWN','OWN-'+model,10)];const p=await upload(good,'assistant-1',name);const forged=payload(p,name);forged.rows[0].data.team='二团';await api('/api/transit/import','assistant-1',forged,403);
  // 旧版签发、包含其他团队的预览也不能通过篡改团队洗成自己的记录。
  const oldProof=crypto.randomUUID();const otherRows=[{sourceRow:2,data:{model,quantity:10,plan:'OLD',date:'2026-09-01',rawDate:'2026-09-01',fnsku:'XOLD',shippingMethod:'整柜',team:'二团',version:''}}];
  const cryptoModule=await import('node:crypto');
  db.db.prepare('INSERT INTO transit_preview_tokens(token_hash,database_id,kind,role,file_name,file_sha256,template_sha256,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(cryptoModule.createHash('sha256').update(oldProof).digest('hex').toUpperCase(),db.syncState().databaseId,'import','assistant-1',name,'oldfile-'+model,'template',JSON.stringify({rows:otherRows}),new Date().toISOString(),new Date(Date.now()+60000).toISOString());
  await api('/api/transit/import','assistant-1',{previewToken:oldProof,fileName:name,fileHash:'oldfile-'+model,templateHash:'template',rows:otherRows.map(r=>({...r,data:{...r.data,team:'一团',version:'V1'}})),requestId:rid()},403);
  check(category+'：助理仅可预览本团文件，提交及旧预览的团队篡改不能入账');
  const batch=await imp(mixed,name,'admin');const countFor=async role=>(await api('/api/transit/imports',role)).imports.find(i=>i.id===batch.importId).rowCount;
  await api('/api/transit/imports','operation-1',undefined,403);await api('/api/transit/imports','operation-2',undefined,403);await api('/api/transit/imports','business',undefined,403);
  assert.equal(await countFor('admin'),2);assert.equal(await countFor('purchasing'),2);assert.equal(await countFor('assistant-1'),1);assert.equal(await countFor('assistant-2'),1);
  for(const [role,team,q] of [['operation-1','一团',30],['operation-2','二团',40]]) {
   const c=await api('/api/inventory/catalog',role);const visibleTeams=new Set(c.inTransitDetails[model].map(r=>r.team));
   if(category==='墨盒'){assert.ok(c.inTransitDetails[model].every(r=>r.team===team));assert.equal(c.models.find(r=>r.model===model).inTransit,q);}
   else {assert.deepEqual([...visibleTeams].sort(),['一团','二团']);assert.equal(c.models.find(r=>r.model===model).inTransit,c.inTransitDetails[model].reduce((sum,r)=>sum+r.quantity,0));}
   const event=db.db.prepare("SELECT id FROM document_events WHERE event_type='transit_import' AND json_extract(payload_json,'$.importId')=?").get(batch.importId).id;
   const detail=await api('/api/audit/'+event,role);assert.equal(detail.record.quantity,q);assert.equal(detail.record.team,team);
   assert.equal(detail.events[0].payload.transitIds.length,1);assert.equal(detail.events[0].payload.sourceRowCount,1);
  }
  for(const [role,team,q] of [['assistant-1','一团',30],['assistant-2','二团',40]]) {
   const c=await api('/api/inventory/catalog',role),summary=c.models.find(r=>r.model===model);
   if(category==='墨盒') {
    const expected=team==='一团'?[500,20,480,30]:[0,0,0,40];
    assert.deepEqual([summary.inStock,summary.locked,summary.available,summary.inTransit],expected);
    assert.ok(c.inTransitDetails[model].every(r=>r.team===team));
   } else {
    assert.deepEqual([summary.inStock,summary.locked,summary.available,summary.inTransit],[400,20,380,70]);
    assert.deepEqual([...new Set(c.inTransitDetails[model].map(r=>r.team))].sort(),['一团','二团']);
    assert.equal(c.inTransitDetails[model].reduce((sum,r)=>sum+r.quantity,0),summary.inTransit);
   }
   assert.equal(c.inTransitDetails[model][0].packPerBox,'4');
   const imports=(await api('/api/transit/imports',role)).imports.find(r=>r.id===batch.importId);assert.equal(imports.rowCount,1);
  }
  if(category==='硒鼓') for(const [role,team] of [['assistant-1','一团'],['assistant-2','二团']]) {
   const foreign=batch.rows.find(row=>row.team!==(team)),before=db.db.prepare('SELECT status,remaining_quantity,revision FROM transit_batches WHERE id=?').get(foreign.id);
   await api(`/api/transit/${foreign.id}/on-shelf`,role,{yes:'YES',expectedRevision:foreign.revision,requestId:rid()},403);
   assert.deepEqual(db.db.prepare('SELECT status,remaining_quantity,revision FROM transit_batches WHERE id=?').get(foreign.id),before);
  }
  for(const transit of batch.rows) {
   const before=db.db.prepare('SELECT status,remaining_quantity,revision FROM transit_batches WHERE id=?').get(transit.id);
   await api(`/api/transit/${transit.id}/on-shelf`,'purchasing',{yes:'YES',expectedRevision:transit.revision,requestId:rid()},403);
   assert.deepEqual(db.db.prepare('SELECT status,remaining_quantity,revision FROM transit_batches WHERE id=?').get(transit.id),before);
  }
  check(category+'：采购不能确认上架，跨团队和本团在途余额均未改变');
  if(category==='硒鼓') check('助理在库存汇总可见两团硒鼓在途，但接口仍拒绝跨团上架且库存未变');
  const statusRows=[['计划号','物流状态'],['MIX-'+model,'到港']];
  const assistantMixedStatus=await upload(statusRows,'assistant-1','status.csv',200,'/api/transit/status/preview');assert.equal(assistantMixedStatus.canApply,false);assert.equal(assistantMixedStatus.updates.length,0);
  const assistantTwoMixedStatus=await upload(statusRows,'assistant-2','status.csv',200,'/api/transit/status/preview');assert.equal(assistantTwoMixedStatus.canApply,false);assert.equal(assistantTwoMixedStatus.updates.length,0);
  const sp=await upload(statusRows,'purchasing','status.csv',200,'/api/transit/status/preview');assert.equal(sp.canApply,true);assert.equal(sp.updates.length,2);
  const statusApplied=await api('/api/transit/status/apply','purchasing',{previewToken:sp.previewToken,rows:sp.rows,fileName:'status.csv',fileHash:sp.fileSha256,templateHash:sp.templateSha256,requestId:rid()});assert.equal(statusApplied.updated.length,2);
  const event=db.db.prepare("SELECT MAX(id) id FROM document_events WHERE event_type='transit_status'").get().id;assert.equal((await api('/api/audit/'+event,'operation-1')).events[0].payload.updatedDetailCount,1);
  const oldStatus={role:'operation-1',previewToken:'legacy-proof',rows:sp.rows,fileHash:sp.fileSha256,templateHash:sp.templateSha256,fileName:'status.csv'},oldRequest=rid();
  db.idempotent('transit:status',oldRequest,oldStatus,()=>({ok:true,updated:batch.rows.map(r=>({id:r.id})),rowCount:2}));
  await api('/api/transit/status/apply','operation-1',{...oldStatus,requestId:oldRequest},403);
  const collision=[headers,row(model,'一团','XTEAMTWO','MIX-'+model,3)];
  await upload(collision,'operation-1',name,403);
  const owned=await imp(good,name,'assistant-1');
  const ownStatus=await upload([['计划号','物流状态'],['OWN-'+model,'到港']],'assistant-1','status.csv',200,'/api/transit/status/preview');
  const applied=await api('/api/transit/status/apply','assistant-1',{previewToken:ownStatus.previewToken,rows:ownStatus.rows,fileName:'status.csv',fileHash:ownStatus.fileSha256,templateHash:ownStatus.templateSha256,requestId:rid()});
  assert.deepEqual(applied.updated.map(r=>r.id),owned.rows.map(r=>r.id));
  check(category+'：本团助理物流可更新；旧物流请求重放和跨团同批次合并均拒绝');
  check(category+'：采购可更新跨团物流；助理拒绝跨团计划，导入记录和库存汇总范围保持一致');
  await api('/api/transit/import','admin',payload(await upload(mixed,'admin',name),name),409);check(category+'：文件防重仍生效');
  for(const t of batch.rows) {const currentRevision=db.db.prepare('SELECT revision FROM transit_batches WHERE id=?').get(t.id).revision;await api(`/api/transit/${t.id}/on-shelf`,'admin',{yes:'YES',expectedRevision:currentRevision,requestId:rid()});}
  const direct=(await api('/api/upgrades/direct','assistant-1',{model,sourceVersion:'V1',requestId:rid()})).upgrade;
  const sourceTeams=new Set(direct.lines.map(line=>db.stockBatchSourceTeams().get(line.sourceBatchKey)?.values().next().value));assert.deepEqual([...sourceTeams],['一团']);
  const assistantTwo=(await api('/api/upgrades','assistant-2'));assert.ok(!assistantTwo.upgrades.some(r=>r.kind==='direct'&&r.id===direct.id));
  assert.equal(assistantTwo.directSources.find(r=>r.model===model&&r.sourceVersion==='V1').inStock,40);
  const secondView=await api('/api/inventory/catalog','assistant-2'),secondCatalog=secondView.models.find(r=>r.model===model);
  if(category==='墨盒') {assert.equal(secondCatalog.locked,0);assert.equal(secondCatalog.available,40);assert.equal(secondCatalog.inStock,40);assert.ok(secondView.stockDetails[model].every(r=>db.stockBatchSourceTeams().get(r.batchKey)?.has('二团')));}
  else {
   const stockRows=secondView.stockDetails[model],transitRows=secondView.inTransitDetails[model],teams=db.stockBatchSourceTeams();
   assert.equal(secondCatalog.inStock,stockRows.reduce((sum,r)=>sum+r.quantity,0));assert.equal(secondCatalog.locked,stockRows.reduce((sum,r)=>sum+r.locked,0));assert.equal(secondCatalog.available,stockRows.reduce((sum,r)=>sum+r.available,0));assert.equal(secondCatalog.inTransit,transitRows.reduce((sum,r)=>sum+r.quantity,0));
   assert.deepEqual([...new Set(stockRows.flatMap(r=>[...(teams.get(r.batchKey)??[])]))].sort(),['一团','二团']);
  }
  const de=db.db.prepare("SELECT MAX(id) id FROM document_events WHERE event_type='upgrade_direct_start'").get().id;await api('/api/audit/'+de,'assistant-1');await api('/api/audit/'+de,'assistant-2',undefined,403);
  check(category+'：助理在库升级只锁定本团来源批次；另一团库存余额和升级单/流水不外泄');

  for(const [role,team,otherTeam] of [['assistant-1','一团','二团'],['assistant-2','二团','一团']]){
   const ownRows=[headers,row(model,team,`X${role}` ,`ASSISTANT-${role}-${model}`,2)],ownName=`${role}-${category}.csv`;
   const ownPreview=await upload(ownRows,role,ownName);assert.ok(ownPreview.previewToken);
   const ownImport=await api('/api/transit/import',role,payload(ownPreview,ownName));assert.equal(ownImport.rows.every(r=>r.team===team),true);
   await upload([headers,row(model,otherTeam,`XFOREIGN${role}`,`FOREIGN-${role}-${model}`,2)],role,`${role}-跨团-${category}.csv`,403);
   const ownStatusPreview=await upload([['计划号','物流状态'],[`ASSISTANT-${role}-${model}`,'到港']],role,`${role}-物流.csv`,200,'/api/transit/status/preview');assert.equal(ownStatusPreview.canApply,true);
   const ownStatusResult=await api('/api/transit/status/apply',role,{previewToken:ownStatusPreview.previewToken,rows:ownStatusPreview.rows,fileName:ownStatusPreview.fileName,fileHash:ownStatusPreview.fileSha256,templateHash:ownStatusPreview.templateSha256,requestId:rid()});assert.deepEqual(ownStatusResult.updated.map(r=>r.id),ownImport.rows.map(r=>r.id));
  }
  check(category+'：两类助理均可导入和更新本团在途，预览、导入及物流更新拒绝跨团数据');

  const purchasingRows=[headers,row(model,'一团',`XPURCHASE1${category}`,`PURCHASE-ONE-${model}`,3),row(model,'二团',`XPURCHASE2${category}`,`PURCHASE-TWO-${model}`,4)],purchasingName=`采购权限${category}.csv`;
  const purchasingPreview=await upload(purchasingRows,'purchasing',purchasingName);assert.ok(purchasingPreview.previewToken);assert.equal(purchasingPreview.validation.errors.length,0);
  const purchasingImport=await api('/api/transit/import','purchasing',payload(purchasingPreview,purchasingName));assert.equal(purchasingImport.rows.length,2);assert.deepEqual(purchasingImport.rows.map(r=>r.team).sort(),['一团','二团']);
  const purchasingStatusRows=[['计划号','物流状态'],[`PURCHASE-ONE-${model}`,'已到港'],[`PURCHASE-TWO-${model}`,'已到港']];
  const purchasingStatusPreview=await upload(purchasingStatusRows,'purchasing',purchasingName,200,'/api/transit/status/preview');assert.equal(purchasingStatusPreview.canApply,true);assert.equal(purchasingStatusPreview.updates.length,2);
  const purchasingStatusResult=await api('/api/transit/status/apply','purchasing',{previewToken:purchasingStatusPreview.previewToken,rows:purchasingStatusPreview.rows,fileName:purchasingStatusPreview.fileName,fileHash:purchasingStatusPreview.fileSha256,templateHash:purchasingStatusPreview.templateSha256,requestId:rid()});assert.equal(purchasingStatusResult.updated.length,2);
  assert.equal((await api('/api/transit/imports','purchasing')).imports.find(r=>r.id===purchasingImport.importId).rowCount,2);
  check(category+'：采购完成两团在途导入、物流预览/更新与完整导入记录查询');
 }
 db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);
 check('全部隔离库存恒等式和外键通过');
}finally{child.kill();db.close();await fs.writeFile(path.join(out,'team-api-result.json'),JSON.stringify({checks,state},null,2));}

