// 隔离 HTTP 执行器协议验收；不启动浏览器，不访问真实领星。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInventoryDatabase,InventoryDatabase,OVERSEAS_WAREHOUSES} from '../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from './test-server-ownership.mjs';
const root=path.resolve(import.meta.dirname,'..');
await fs.mkdir(path.join(root,'.test-output'),{recursive:true});
const state=await fs.mkdtemp(path.join(root,'.test-output/req59-http-'));
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID(),port=await freePort(),base=`http://127.0.0.1:${port}`;
const instanceId=createTestInstanceId('req59-http'),calls=[],checks=[];
let workerId;
async function api(route,role='logistics',body,status=200,headers={}) {
 const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
 const value=await r.json();calls.push({route,status:r.status,value});assert.equal(r.status,status,JSON.stringify(value));return value;
}
const flow=async id=>(await api('/api/upgrades/flows')).flows.find(f=>f.id===id);
const check=name=>{checks.push(name);console.log('PASS '+name);};
const origin='chrome-extension://'+'a'.repeat(32);
const execute=(action,p={})=>api('/api/lingxing-worker/'+action,'admin',{workerId,...p},200,{origin});
const server=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
try {
 await waitForOwnedServer({base,child:server,instanceId});
  // 一次自动任务及缓存到业务的完整链；包裹明示为合成协议输入。
  let inquiry=(await api('/api/inquiries','operation-1',{model:'SYNTH-TONER-001',quantity:100,department:'一团',store:'AUS',operator:'验收运营',fnsku:'XAUTO00001',asin:'BAUTO00001',requestId:rid()})).record;
  inquiry=(await api(`/api/inquiries/${inquiry.id}/review`,'business',{decision:'approve',approvedQuantity:100,expectedRevision:inquiry.revision,requestId:rid()})).record;
  inquiry=(await api(`/api/inquiries/${inquiry.id}/reply`,'alan',{supplierQuantity:100,shippingWarehouse:'CA',expectedRevision:inquiry.revision,requestId:rid()})).record;
  inquiry=(await api(`/api/inquiries/${inquiry.id}/archive`,'purchasing',{plan:'AUTO-SOURCE',date:'2026-09-28',version:'V1',expectedRevision:inquiry.revision,requestId:rid()})).record;
  const w=(await api('/api/upgrades/relocation-work-items','purchasing',{inquiryId:inquiry.id,requestId:rid()})).workItem;
  const raw='Mirella RW (RMA#: R616738)\n12000 Magnolia Ave, Suite#101\nRiverside CA 92503';
  db.updateUpgradeFlows({role:'logistics',rows:db.upgradeTemplateRows([w.id]).map(r=>({...r,rma:'R616738',rawAddress:raw,packPerBox:4})),requestId:rid()});
  workerId=(await execute('connect',{version:'protocol-fixture-req59'})).workerId;
  const orderPayload={removalOrderNo:'SYNTH-AUTO-ORDER',expectedRevision:(await flow(w.id)).revision,requestId:rid()};
  const order=await api(`/api/upgrades/relocation-work-items/${w.id}/operation`,'operation-1',orderPayload);
  const orderAgain=await api(`/api/upgrades/relocation-work-items/${w.id}/operation`,'operation-1',orderPayload);assert.equal(order.syncJob.id,orderAgain.syncJob.id);
  assert.equal((await execute('claim')).job.id,order.syncJob.id);assert.equal(order.syncJob.target.store,'AUS');
  const pkg=(qty,key='P1',store='A-US 美国',fnsku='XAUTO00001')=>({externalId:key,storeId:store,storeName:store,countryCode:'US',orderNo:'SYNTH-AUTO-ORDER',fnsku,quantity:qty,carrier:'UPS',trackingNo:'AUTO-'+key,shipDate:'2026-09-28'});
  const finish=(id,shipments,capturedAt=new Date().toISOString())=>execute('finish',{id,capture:{shipments,capturedAt,source:{kind:'protocol-fixture'}}});
  let finished=await finish(order.syncJob.id,[pkg(25),pkg(15,'P2')]);assert.equal(finished.job.state,'succeeded');assert.equal(finished.job.result.cacheSaved,true);assert.equal(finished.job.result.businessApplied,true);assert.equal((await flow(w.id)).shippedQuantity,40);
  db.updateUpgradeFlows({role:'logistics',rows:db.upgradeTemplateRows([w.id]).map(r=>({...r,progressQuantity:25,completedQuantity:15,completedVersion:'V2',warehouse:OVERSEAS_WAREHOUSES[0]})),requestId:rid()});
  check('保存订单号自动且仅一次任务；多包裹25+15缓存与业务40一致，完成15');
  const sync=async shipments=>{const job=(await api('/api/lingxing/jobs','logistics',{action:'logistics',workId:w.id,requestId:rid()},202)).job;await execute('claim');return finish(job.id,shipments);};
  finished=await sync([pkg(5,'P3')]);assert.equal(finished.job.result.shippedDelta,5);assert.equal((await flow(w.id)).shippedQuantity,45);assert.equal((await flow(w.id)).completedQuantity,15);
  await sync([pkg(5,'P3')]);assert.equal((await flow(w.id)).shippedQuantity,45);
  finished=await sync([pkg(8,'OTHER-STORE','BE-US 美国')]);assert.equal(finished.job.result.cacheSaved,true);assert.equal(finished.job.result.businessApplied,false);assert.equal((await flow(w.id)).shippedQuantity,45);
  finished=await sync([pkg(24)]);assert.equal(finished.job.state,'failed');assert.equal((await flow(w.id)).shippedQuantity,45);
  check('后续包裹只加5，旧包裹缺席不扣减，跨店仅缓存、已采纳下调明确失败');

  const current=await flow(w.id),template=db.upgradeTemplateRows([w.id]);
  // 不同FNSKU由采集端按目标筛选；后端收到串商品结果时拒绝整份而不混加。
  finished=await sync([pkg(6,'OTHER-GOODS','A-US 美国','XOTHER')]);assert.equal(finished.job.state,'failed');assert.equal((await flow(w.id)).shippedQuantity,45);
  const staleJob=(await api('/api/lingxing/jobs','logistics',{action:'logistics',workId:w.id,requestId:rid()},202)).job;await execute('claim');
  finished=await finish(staleJob.id,[pkg(26)],'2020-01-01T00:00:00.000Z');assert.equal(finished.job.state,'failed');assert.equal((await flow(w.id)).shippedQuantity,45);
  check('不同商品串入和较旧抓取均拒绝，不覆盖当前已发');
  const captureJob=(await api('/api/lingxing/jobs','logistics',{action:'logistics',workId:w.id,requestId:rid()},202)).job;await execute('claim');
  let recalled=(await api(`/api/inquiries/${inquiry.id}/recall`,'business',{expectedRevision:db.getInquiry(inquiry.id).revision,requestId:rid()})).record;
  await api(`/api/inquiries/${inquiry.id}/recall`,'purchasing',{expectedRevision:recalled.revision,requestId:rid()},409);
  finished=await finish(captureJob.id,[pkg(2,'P4')]);assert.equal(finished.job.result.shippedDelta,2);assert.equal((await flow(w.id)).shippedQuantity,47);assert.equal((await flow(w.id)).store,'AUS');
  assert.equal((await flow(w.id)).completedQuantity,15);
  assert.throws(()=>db.updateUpgradeFlows({role:'logistics',rows:template.map(r=>({...r,completedQuantity:16})),requestId:rid()}),e=>e.code==='upgrade_stale_revision');
  check('采集期间商务回撤不改既有流程固定来源，新增2仍入原流程，已导出旧版本拒绝');
  for(const role of ['purchasing','alan','logistics']) {
    const backups=await api('/api/inquiries/backups',role);
    assert.ok(backups.records.some(r=>r.id===inquiry.id));
    assert.ok(!JSON.stringify(backups).includes('orderGrossProfit'));
  }
  check('空指标归档快照可正常查看，新增岗位与采购的毛利润过滤一致');
  // 业务选择D4只禁止跳过重审；商务批准后采购可继续原回撤流程。
  recalled=(await api(`/api/inquiries/${inquiry.id}/review`,'business',{decision:'approve',approvedQuantity:100,expectedRevision:recalled.revision,requestId:rid()})).record;
  await api(`/api/inquiries/${inquiry.id}/recall`,'purchasing',{expectedRevision:recalled.revision,requestId:rid()});
  assert.equal(db.getInquiry(inquiry.id).status,'pending_purchasing');check('D4通过真实接口执行，重审后采购正常接续');
  db.assertInventoryInvariants();check('全部业务已发47、累计完成15与库存台账一致');
} finally {
 await fs.writeFile(path.join(state,'result.json'),JSON.stringify({state,checks,calls,realLingxing:false,browserUsed:false},null,2));
 const done=new Promise(resolve=>server.once('close',resolve));server.kill();await done;db.close();
}
console.log(JSON.stringify({state,checks:checks.length}));
