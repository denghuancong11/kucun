// User-confirmed rule: unfinished approvals remain visible and actionable across display cleanup.
// All service/data/time changes are confined to a temporary state root and owned random port.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {createInventoryDatabase, InventoryDatabase} from '../inventory-db.mjs';
import {freePort, createTestInstanceId, waitForOwnedServer} from './test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'..');
const output=process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/approval-pending');
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-approval-pending-'));
await fs.mkdir(output,{recursive:true});
const clockFile=path.join(state,'clock.txt'),preload=path.join(state,'clock.mjs');
await fs.writeFile(preload,`import fs from 'node:fs';const RealDate=Date;const now=()=>RealDate.parse(fs.readFileSync(${JSON.stringify(clockFile)},'utf8'));globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now()]));}static now(){return now();}};`);
const setTime=at=>fs.writeFile(clockFile,at);
await setTime('2026-09-21T12:00:00.000Z');
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});
const db=new InventoryDatabase(state),port=await freePort(),base=`http://127.0.0.1:${port}`;
db.db.prepare("UPDATE stock_batches SET pack_per_box='2' WHERE model='SYNTH-TONER-001'").run();
const checks=[],metricsAuthorization=[],requestProof=[],rid=()=>crypto.randomUUID();let server;let failure=null;
const check=name=>{checks.push(name);console.log('PASS '+name);};
const meta=key=>db.db.prepare('SELECT value FROM system_meta WHERE key=?').get(key)?.value;
const balance=()=>db.getBalance('SYNTH-TONER-001#TEST-PLAN-TONER#2026-02-10#V11');
const snapshot=()=>Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'system_meta' ORDER BY name").all().map(({name})=>[name,db.db.prepare('SELECT * FROM "'+name+'"').all()]));
async function start(failpoint=''){
 const instanceId=createTestInstanceId('approval-pending');
 server=spawn(process.execPath,['--import',pathToFileURL(preload).href,path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,ASTER_TEST_INSTANCE_ID:instanceId,HOST:'127.0.0.1',PORT:String(port),PROD:'1',TZ:'America/Los_Angeles',ASTER_TEST_FAILPOINT:failpoint}});
 await waitForOwnedServer({base,child:server,instanceId});
}
async function stop(){if(server&&server.exitCode===null){const closed=once(server,'exit');server.kill();await closed;}}
async function api(route,role='admin',body,status=200){
 const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
}
async function unchangedFailure(route,role,body,status,code,requestNotApplied){
 const before={tables:snapshot(),sync:db.syncState()};const data=await api(route,role,body,status);
 assert.equal(data.code,code);assert.equal(data.requestNotApplied===true,requestNotApplied);
 if(!requestNotApplied)assert.equal(Object.hasOwn(data,'requestNotApplied'),false);
 assert.equal(Object.hasOwn(data,'transactionRolledBack'),false);
 assert.deepEqual({tables:snapshot(),sync:db.syncState()},before);
 requestProof.push({route,role,status,code,requestId:body.requestId,requestNotApplied:requestNotApplied,allTablesAndSyncUnchanged:true});return data;
}
const view=()=>api('/api/approvals');
async function allocation(quantity,operator){return(await api('/api/allocations','operation-1',{model:'SYNTH-TONER-001',plan:'TEST-PLAN-TONER',date:'2026-02-10',version:'V11',quantity,department:'一团',store:'AUS',operator,fnsku:'XPENDING01',asin:'BPENDING01',requestId:rid()})).record;}
async function inquiry(operator,model='SYNTH-TONER-001'){return(await api('/api/inquiries','operation-1',{model,quantity:10,department:'一团',store:'AUS',operator,fnsku:'XPENDING01',asin:'BPENDING01',requestId:rid()})).record;}
async function review(r,kind='inquiries',decision='approve',quantity=10){return(await api(`/api/${kind}/${r.id}/review`,'business',{decision,approvedQuantity:quantity,businessNote:'隔离跨周期回归',expectedRevision:r.revision,requestId:rid()})).record;}
async function reply(r,quantity){return(await api(`/api/inquiries/${r.id}/reply`,'purchasing',{supplierQuantity:quantity,shippingWarehouse:'CA',expectedRevision:r.revision,requestId:rid()})).record;}
async function archive(r){return(await api(`/api/inquiries/${r.id}/archive`,'assistant-1',{plan:'PENDING-PLAN',date:'2026-09-24',version:'V1',expectedRevision:r.revision,requestId:rid()})).record;}
async function assertVisible(allocations,inquiries){const result=await view();assert.deepEqual(result.allocations.map(r=>r.id).sort((a,b)=>a-b),allocations.map(r=>r.id).sort((a,b)=>a-b));assert.deepEqual(result.inquiries.map(r=>r.id).sort((a,b)=>a-b),inquiries.map(r=>r.id).sort((a,b)=>a-b));return result;}
try{
 await start();
 let waitingBusiness=await allocation(10,'待商务'),waitingAssistant=await review(await allocation(8,'待助理'),'allocations','approve',8),toReject=await allocation(4,'待拒绝');
 let ended=await review(await allocation(4,'已完成'),'allocations','approve',4);ended=(await api(`/api/allocations/${ended.id}/confirm`,'assistant-1',{expectedRevision:ended.revision,requestId:rid()})).record;
 let qBusiness=await inquiry('待商务'),qPurchasing=await review(await inquiry('待采购')),qAssistant=await reply(await review(await inquiry('待助理')),7);
 let zero=await reply(await review(await inquiry('零回复')),0);const rejected=await review(await inquiry('已拒绝'),'inquiries','reject'),qDone=await archive(await reply(await review(await inquiry('已归档')),6));
 const inkPending=await inquiry('指标类目权限','SYNTH-INK-001');
 const initial=await view();assert.equal(initial.allocations.length,4);assert.equal(initial.inquiries.length,7);
 const before=snapshot(),version=db.syncState().dataVersion,lockedBefore=balance().locked;
 await setTime('2026-09-22T13:00:00.000Z');await Promise.all([api('/api/sync'),view(),api('/api/sync')]);
 assert.equal(meta('approval_clear_before'),'2026-09-22T13:00:00.000Z');assert.equal(db.syncState().dataVersion,version+1);assert.deepEqual(snapshot(),before);assert.equal(balance().locked,lockedBefore);
 await assertVisible([waitingBusiness,waitingAssistant,toReject],[qBusiness,qPurchasing,qAssistant,zero,inkPending,rejected,qDone]);
 check('周二清理保留未审核/已审核调拨及询库全部阶段；仅调拨终态退出；业务表和锁定不变');
 // Only an isolated protocol connection is used; no collector or external Lingxing session.
 const origin='chrome-extension://'+'a'.repeat(32);let workerId;
 async function worker(action,body={}){
   const response=await fetch(base+'/api/lingxing-worker/'+action,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({workerId,...body})});
   const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
 }
 workerId=(await worker('connect',{version:'isolated-approval-authorization'})).workerId;
 const beforeMetrics=snapshot(),metricsVersion=db.syncState().dataVersion;
 const oldTargets=[{kind:'allocation',id:waitingBusiness.id},{kind:'inquiry',id:qBusiness.id}];
 const queued=await api('/api/lingxing/jobs','business',{action:'metrics',documents:oldTargets,requestId:rid()},202);
 assert.equal(queued.job.state,'queued');assert.deepEqual(queued.job.target.documents,oldTargets);assert.deepEqual(queued.job.target.asins,['BPENDING01']);
 const claimed=await worker('claim');assert.equal(claimed.job.id,queued.job.id);
 // Finish with an explicit mock failure: authorization is tested without writing any metric.
 const closed=await worker('finish',{id:queued.job.id,error:'隔离授权回归：不运行真实领星或保存指标'});assert.equal(closed.job.state,'failed');
 await worker('disconnect');const afterMetrics=snapshot();
 assert.equal(afterMetrics.lingxing_sync_jobs.length,beforeMetrics.lingxing_sync_jobs.length+1);
 assert.equal(afterMetrics.sqlite_sequence.find(r=>r.name==='lingxing_sync_jobs').seq,queued.job.id);
 for(const snapshotValue of [beforeMetrics,afterMetrics]){delete snapshotValue.lingxing_sync_jobs;snapshotValue.sqlite_sequence=snapshotValue.sqlite_sequence.filter(r=>r.name!=='lingxing_sync_jobs');}
 assert.deepEqual(afterMetrics,beforeMetrics);assert.equal(db.syncState().dataVersion,metricsVersion);
 metricsAuthorization.push({case:'old_pending_across_cutoff',status:202,target:queued.job.target,jobId:queued.job.id,mockFinalState:closed.job.state,inventoryAndLedgerUnchanged:true});
 for(const ref of [{kind:'allocation',id:ended.id},{kind:'inquiry',id:qDone.id}]){
   const beforeDenied=snapshot();const denied=await api('/api/lingxing/jobs','business',{action:'metrics',documents:[ref],requestId:rid()},409);
   assert.equal(denied.code,'sync_document_inactive');assert.deepEqual(snapshot(),beforeDenied);
   metricsAuthorization.push({case:'terminal_document',status:409,document:ref,code:denied.code,allBusinessTablesUnchanged:true});
 }
 const permissionsPath=path.join(state,'data','permissions.json');
 const matrix={'墨盒':Object.fromEntries(['admin','assistant-1','assistant-2','operation-1','operation-2','purchasing','business'].map(role=>[role,{summary:true,detail:true,expand:true,actions:role!=='business'&&role!=='operation-1'}]))};
 await fs.writeFile(permissionsPath,JSON.stringify(matrix));
 try{
   // The original request is already committed. A later permission denial must not claim otherwise.
   const savedInkKey=db.db.prepare("SELECT request_id FROM idempotency_requests WHERE scope='inquiry:create' AND json_extract(response_json,'$.record.id')=?").get(inkPending.id).request_id;
   await unchangedFailure('/api/inquiries','operation-1',{model:'SYNTH-INK-001',quantity:10,department:'一团',store:'AUS',operator:'指标类目权限',fnsku:'XPENDING01',asin:'BPENDING01',requestId:savedInkKey},403,'action_forbidden',false);
   const beforeDenied=snapshot();const denied=await api('/api/lingxing/jobs','business',{action:'metrics',documents:[{kind:'inquiry',id:inkPending.id}],requestId:rid()},403);
   assert.equal(denied.code,'lingxing_scope_forbidden');assert.deepEqual(snapshot(),beforeDenied);
   metricsAuthorization.push({case:'old_pending_actions_forbidden',status:403,document:{kind:'inquiry',id:inkPending.id},code:denied.code,allBusinessTablesUnchanged:true});
 }finally{await fs.rm(permissionsPath);}
 await review(inkPending,'inquiries','reject');
 await assertVisible([waitingBusiness,waitingAssistant,toReject],[qBusiness,qPurchasing,qAssistant,zero,inkPending,rejected,qDone]);
 check('跨截止旧待办指标授权202；终态409、类目禁权403且业务/流水不变（执行端模拟）');
 await unchangedFailure(`/api/allocations/${waitingAssistant.id}/confirm`,'assistant-2',{expectedRevision:waitingAssistant.revision,requestId:rid()},403,'group_forbidden',false);
 check('跨周期保留不会绕过团队办理权限，拒绝不改任何业务表');
 // The original procurement POST never reached the service. Another purchaser advances it first.
 let work=(await api('/api/upgrades/relocation-work-items','operation-1',{inquiryId:qDone.id,requestId:rid()})).workItem;
 const oldProcurement={rma:'ORIGINAL-RMA',relocationAddress:'原采购地址',expectedRevision:work.revision,requestId:rid()};
 work=(await api(`/api/upgrades/relocation-work-items/${work.id}/procurement`,"logistics",{rma:'COLLEAGUE-RMA',relocationAddress:'Mirella RW (RMA#: R616738)\n12000 Magnolia Ave, Suite#101\nRiverside, CA 92503 US\nTEL:562-404-9315',expectedRevision:work.revision,requestId:rid()})).workItem;
 assert.equal(work.status,'awaiting_operation');
 await unchangedFailure(`/api/upgrades/relocation-work-items/${work.id}/procurement`,"logistics",oldProcurement,409,'invalid_relocation_step',true);
 assert.equal(db.db.prepare('SELECT COUNT(*) n FROM idempotency_requests WHERE request_id=?').get(oldProcurement.requestId).n,0);
 check('采购同岗推进后旧未提交请求获得成功回滚证据，已提交禁权403和团队403不误报未提交');
 const previewFileName='恢复证据硒鼓.csv',csv='ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\nSYNTH-TONER-001,7,4,XPROOF,SyntheticWarehouseB,PROOF-TOKEN,2026-09-22,一团,V1';
 async function previewProof(){const response=await fetch(base+'/api/transit/preview',{method:'POST',headers:{'x-role':'assistant-1','x-file-name':encodeURIComponent(previewFileName)},body:csv});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
 const previewed=await previewProof(),unsubmittedImport={previewToken:previewed.previewToken,fileName:previewed.fileName,fileHash:previewed.fileSha256,templateHash:previewed.templateSha256,rows:previewed.rows,requestId:rid()};
 await setTime('2026-09-22T13:16:00.000Z');
 await unchangedFailure('/api/transit/import','assistant-1',unsubmittedImport,422,'preview_token_expired',true);
 // A new preview normally removes expired tokens; the original request is still uncached.
 await previewProof();
 await unchangedFailure('/api/transit/import','assistant-1',unsubmittedImport,422,'preview_token_invalid',true);
 assert.equal(db.db.prepare('SELECT COUNT(*) n FROM idempotency_requests WHERE request_id=?').get(unsubmittedImport.requestId).n,0);
 check('原导入未到服务端时，预览过期及清除后的422给出未提交证据，预览/库存/流水与版本不变');

 waitingBusiness=await review(waitingBusiness,'allocations','approve',6);await review(toReject,'allocations','reject');assert.equal(balance().locked,14);
 const rejectionLedger=db.db.prepare('SELECT entry_type,on_hand_delta,locked_delta FROM inventory_ledger WHERE document_id=? ORDER BY id').all(toReject.id);assert.deepEqual(rejectionLedger.map(r=>[r.on_hand_delta,r.locked_delta]),[[0,4],[0,-4]]);
 qBusiness=await review(qBusiness);qPurchasing=await reply(qPurchasing,0);qAssistant=await archive(qAssistant);
 assert.equal(qPurchasing.status,'pending_assistant');assert.equal(qPurchasing.requestedQuantity,0);assert.equal(qAssistant.quantity,7);qPurchasing=await archive(qPurchasing);zero=await archive(zero);assert.equal(zero.quantity,0);
 check('旧调拨缩量/拒绝释放准确，旧询库商务/采购零回复/助理归档可继续');
 await setTime('2026-09-24T13:00:00.000Z');const secondBefore=snapshot();await api('/api/sync');assert.deepEqual(snapshot(),secondBefore);await assertVisible([waitingBusiness,waitingAssistant],[qBusiness,qPurchasing,qAssistant,zero,inkPending,rejected,qDone]);
 await stop();await setTime('2026-10-01T14:00:00.000Z');await start();assert.equal(meta('approval_clear_before'),'2026-10-01T13:00:00.000Z');await assertVisible([waitingBusiness,waitingAssistant],[qBusiness,qPurchasing,qAssistant,zero,inkPending,rejected,qDone]);
 check('周四和停机跨多次周期后未完成仍在，重启不丢状态或锁定');
 const confirmBody={expectedRevision:waitingAssistant.revision,requestId:rid()};
 await stop();await start('confirm-before-commit');const failedBefore=snapshot();const failed=await api(`/api/allocations/${waitingAssistant.id}/confirm`,'assistant-1',confirmBody,500);assert.equal(Object.hasOwn(failed,'requestNotApplied'),false);assert.deepEqual(snapshot(),failedBefore);assert.equal(balance().locked,14);
 await stop();await start();
 const confirms=await Promise.all([api(`/api/allocations/${waitingAssistant.id}/confirm`,'assistant-1',confirmBody),api(`/api/allocations/${waitingAssistant.id}/confirm`,'assistant-1',confirmBody)]);
 assert.equal(confirms.filter(r=>r.deduped).length,1);assert.equal(db.db.prepare("SELECT COUNT(*) n FROM inventory_ledger WHERE document_id=? AND entry_type='issue'").get(waitingAssistant.id).n,1);assert.equal(balance().locked,6);
 const responseLostReplay=await api(`/api/allocations/${waitingAssistant.id}/confirm`,'assistant-1',confirmBody);assert.equal(responseLostReplay.deduped,true);
 await unchangedFailure(`/api/allocations/${waitingAssistant.id}/confirm`,'assistant-1',{...confirmBody,expectedRevision:confirmBody.expectedRevision+1},409,'idempotency_conflict',false);
 await unchangedFailure(`/api/allocations/${waitingBusiness.id}/confirm`,'assistant-1',{expectedRevision:waitingBusiness.revision-1,requestId:rid()},409,'stale_revision',true);
 const competing=await Promise.all([1,2].map(async()=>{
   const response=await fetch(base+`/api/allocations/${waitingBusiness.id}/confirm`,{method:'POST',headers:{'x-role':'assistant-1','content-type':'application/json'},body:JSON.stringify({expectedRevision:waitingBusiness.revision,requestId:rid()})});
   return {status:response.status,payload:await response.json()};
 }));
 assert.deepEqual(competing.map(r=>r.status).sort(),[200,409]);assert.equal(competing.find(r=>r.status===409).payload.code,'stale_revision');assert.equal(competing.find(r=>r.status===409).payload.requestNotApplied,true);
 assert.equal(db.db.prepare("SELECT COUNT(*) n FROM inventory_ledger WHERE document_id=? AND entry_type='issue'").get(waitingBusiness.id).n,1);assert.equal(balance().locked,0);assert.equal(balance().onHand,482);
 check('提交前异常全部回滚，相同/不同请求并发和回执丢失重试只出库一次；旧版本失败后可正常继续');
 const stockBefore=JSON.stringify(db.db.prepare('SELECT * FROM stock_balances ORDER BY batch_key').all()),ledgerBefore=JSON.stringify(db.db.prepare('SELECT * FROM inventory_ledger ORDER BY id').all());
 qBusiness=await reply(qBusiness,12);assert.equal(qBusiness.requestedQuantity,12);assert.equal(qBusiness.approvedQuantity,12);await archive(qBusiness);
 assert.equal(JSON.stringify(db.db.prepare('SELECT * FROM stock_balances ORDER BY batch_key').all()),stockBefore);assert.equal(JSON.stringify(db.db.prepare('SELECT * FROM inventory_ledger ORDER BY id').all()),ledgerBefore);
 await assertVisible([],[qBusiness,qPurchasing,qAssistant,zero,inkPending,rejected,qDone]);const candidates=(await api('/api/upgrades')).relocationCandidates;assert.ok(candidates.some(r=>r.inquiryId===qBusiness.id&&r.initialQuantity===12));
 check('采购最终量可以大于商务量且不增实际在库，完成后退出待办并保留可用询库来源');
 const persisted=snapshot();await stop();await start();assert.deepEqual(snapshot(),persisted);await assertVisible([],[qBusiness,qPurchasing,qAssistant,zero,inkPending,rejected,qDone]);
 db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
 check('再次读取和重启后业务/流水/幂等回执相同，库存恒等式与外键完整');
}catch(error){failure={message:error.message,stack:error.stack};throw error;}finally{
 await fs.writeFile(path.join(output,'result.json'),JSON.stringify({kind:'isolated-http-db-ledger',checks,metricsAuthorization,requestProof,failure,state,base,realLingxing:false},null,2));await stop();db.close();
}
console.log(`APPROVAL_PENDING_PASS ${checks.length}`);
