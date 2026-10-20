// Approved-copy checks only: synthetic inputs, in-memory SQLite and mocked Chrome/DOM.
// This script never starts a server, reads a deployed database or contacts Lingxing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { runtime } from './extension-test-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outputRoot = path.join(root, '.test-output');
await fs.mkdir(outputRoot, { recursive: true });
const out = await fs.mkdtemp(path.join(outputRoot, 'copy-sheet-fw-'));
const runtimeFile = path.join(out, 'synthetic-runtime.json');
const accountFile = path.join(out, 'synthetic-accounts.json');
await fs.writeFile(runtimeFile, JSON.stringify({schemaVersion:1,overseasWarehouses:['SyntheticWarehouseA','SyntheticWarehouseB']}));
await fs.writeFile(accountFile, JSON.stringify({accounts:[{account:'COPYUS',shortName:'SYNTH',room:'COPY101',sourceCell:'synthetic-only'}]}));
Object.assign(process.env, {ASTER_RUNTIME_CONFIG:runtimeFile,ASTER_WAREHOUSE_ACCOUNTS:accountFile,ASTER_OVERSEAS_WAREHOUSES:'SyntheticWarehouseA;SyntheticWarehouseB'});
const { InventoryDatabase, BusinessError, transitCategoryFromFileName } = await import('../inventory-db.mjs');
const { LingxingHost } = await import('../lingxing-host.mjs');
const { processRelocationAddress } = await import('../relocation-address.mjs');
const sources = new Map();
const source = async file => {
  if(!sources.has(file))sources.set(file,(await fs.readFile(path.join(root,file),'utf8')).replace(/\r\n/g,'\n'));
  return sources.get(file);
};
const checks=[];
function check(ids,name) { checks.push({ids,name});console.log('PASS '+ids.join(',')+' '+name); }
function messageError(action, message, code) {
  assert.throws(action,error=>error.message===message&&(!code||error.code===code));
}
const prepareRow = row => ({db:{prepare:()=>({get:()=>row})},requireRevision(){},getModel:()=>({category:'墨盒'})});
const p=InventoryDatabase.prototype;

for(const file of ['a.xlsx','硒鼓墨盒.xlsx'])messageError(()=>transitCategoryFromFileName(file),'文件名须包含“硒鼓”或“墨盒”，且不能同时包含两者，请修改文件名后上传。','transit_category_unrecognized');
assert.equal(transitCategoryFromFileName('copy-硒鼓.xlsx'),'硒鼓');assert.equal(transitCategoryFromFileName('copy-墨盒.xlsx'),'墨盒');
check(['FW-019'],'文件名分类错误及原合法分类');
const allocation={id:1,model:'COPY-INK',revision:1,status:'pending',approval_status:'approved',procurement_status:'pending_alan',ink_workflow_stage:'pending_alan'};
messageError(()=>p.newInkAllocationForUpdate.call(prepareRow(allocation),1,1,['pending_assistant']),'当前不能办理此调拨操作，请刷新查看进度。','invalid_approval_status');
messageError(()=>p.inkAllocationForUpdate.call(prepareRow({...allocation,ink_workflow_stage:null}),1,1,['pending_archive']),'当前不能办理此调拨操作，请刷新查看进度。','invalid_approval_status');
check(['FW-020-A','FW-020-B'],'新旧墨盒链的阶段拒绝仍保留错误代码');
messageError(()=>p.inquiryForUpdate.call(prepareRow({id:2,revision:1,status:'pending_business'}),2,1,['pending_alan']),'当前不能办理此询库操作，请刷新查看进度。','invalid_inquiry_status');
check(['FW-021'],'询库阶段拒绝');
messageError(()=>p.recallAllocation.call(prepareRow(allocation),{id:1,role:'purchasing'}),'此调拨仅商务可回撤。','allocation_recall_forbidden');
check(['FW-022'],'新墨盒回撤权限仍拒绝采购');
messageError(()=>p.inkAllocationForUpdate.call(prepareRow(allocation),1,1,['pending_alan']),'此调拨由 Alan 审核、本团助理确认，无需采购回复或归档。','new_ink_procurement_forbidden');
check(['FW-023'],'新墨盒仍拒绝旧采购链办理');
const confirming={...allocation,department:'一团',quantity:10,toner_conversion_status:null,ink_workflow_stage:'pending_assistant'};
const confirmContext={...prepareRow(confirming),idempotent:(key,id,request,apply)=>apply(),db:{prepare:sql=>({get:()=>sql.includes('SUM(locked_delta)')?{locked:9}:confirming})}};
messageError(()=>p.confirmAllocation.call(confirmContext,{id:1,role:'assistant-1',expectedRevision:1,requestId:'copy-lock'}),'本次调拨的最终数量与预锁定数量不一致，无法确认发出。','allocation_lock_mismatch');
confirming.ink_workflow_stage=null;
messageError(()=>p.confirmAllocation.call(confirmContext,{id:1,role:'assistant-1',expectedRevision:1,requestId:'copy-legacy'}),'旧墨盒调拨由采购或物流归档完成','confirm_forbidden');
check(['FW-024','FW-025'],'锁定数量校验及明确保留的旧链提示');
messageError(()=>p.syncRelocationLogistics.call({requireUpgradeRole(){}},{id:1,role:'logistics',capturedAt:new Date().toISOString(),shipments:[{externalId:'SYNTH',storeId:'SYNTH',orderNo:'SYNTH',fnsku:'SYNTH',quantity:-1}]}),'领星包裹数量须为 0 或正整数，请在领星核对后重新同步。','invalid_external_shipment_quantity');
check(['FW-026'],'物流非法数量仍在写入前拒绝');
assert.ok((await source('inventory-db.mjs')).includes("if(row.quantity<used) throw new BusinessError(409,'shipment_quantity_decreased','领星包裹数量少于登记发货数量，本次未更新请核对包裹记录');"));
check(['FW-027'],'保留登记发货量比较和原错误代码，仅更换批准文字（源检查）');
const receipt={id:1,batch_key:'COPY',created_at:'2026-10-16T00:00:00.000Z',version:'V1',warehouse:'SyntheticWarehouseA',on_hand_delta:10,relocation_receipt_key:null};
let balance={locked:0,onHand:10};
const receiptContext={db:{prepare:()=>({all:()=>[receipt],get:()=>({quantity:0,n:0})})},getBalance:()=>balance};
assert.equal(p.relocationReceiptBatches.call(receiptContext,1)[0].issue,'此历史入库批次可能已与其他入库合并，当前无法确认可扣回数量，请先核对。');
receipt.relocation_receipt_key='COPY-KEY';balance={locked:1,onHand:10};
assert.equal(p.relocationReceiptBatches.call(receiptContext,1)[0].issue,'此入库批次存在预锁定或后续库存变动，当前不能扣回。');
assert.equal(p.transferReceiptBatches.call(receiptContext,1)[0].issue,'此入库批次存在预锁定或后续库存变动，当前不能扣回。');
balance={locked:0,onHand:10};assert.equal(p.relocationReceiptBatches.call(receiptContext,1)[0].issue,'');assert.equal(p.transferReceiptBatches.call(receiptContext,1)[0].issue,'');
check(['FW-028','FW-029','FW-030'],'历史批次、占用批次与正常可扣回分支');
const before={rma:'COPY-RMA',model:'COPY-MISSING',countedQuantity:'20',inProgressQuantity:'0',completedQuantity:'0',returnQuantity:'20'};
const transferContext={db:{prepare:()=>({get:()=>({id:1,revision:1,data_json:JSON.stringify(before)})})},getModel:()=>undefined};
messageError(()=>p.validateTransferUpdate.call(transferContext,{sourceRow:7,data:{documentNo:'COPY-ZC',revision:1,stage:'progress',inProgressQuantity:'0',completedQuantity:'1',completedVersion:'V2'}},'progress',{preview:true}),'工作表“转仓升级”第 7 行，“型号”：型号不在库存目录或类目非硒鼓墨盒，请核对库存目录','transfer_update_invalid');
check(['FW-031'],'保留工作表、源文件行及型号字段前缀；不把处理指令放进界面');
const inventorySource=await source('inventory-db.mjs');
const auditSource=inventorySource.slice(inventorySource.indexOf('function auditResult('),inventorySource.indexOf('\nfunction payloadModel('));
const audit=vm.runInNewContext('('+auditSource.trim()+')');
assert.equal(audit('alan_timeout'),'Alan 审核超时 5 小时，已取用商务审核数量，等待助理确认');
assert.equal(audit('transfer_upgrade_import',{rowCount:17}),'已导入 17 行转仓升级记录，在库与预锁定数量不变。');
assert.equal(audit('upgrade_direct_start'),'已预锁定在库库存，等待升级。');
check(['FW-034','FW-035','FW-036'],'执行原动态展示函数，保留行数；没有重写历史记录');

const oldDisconnected='部署电脑领星插件未连接。已启用的插件会自动恢复，请保持 Edge 运行；首次使用请在插件中连接库存服务。';
const taskDisconnected='部署领星电脑插件未连接，请保持 Edge 运行，首次使用需连接库存服务';
const db=new DatabaseSync(':memory:');
db.exec(`CREATE TABLE lingxing_sync_jobs(id INTEGER PRIMARY KEY,request_id TEXT,role TEXT,request_json TEXT,requested_from TEXT,target_json TEXT,state TEXT,message TEXT,created_at TEXT,finished_at TEXT,started_at TEXT,worker_id TEXT,capture_json TEXT,result_json TEXT);`);
const inventory={db,syncState:()=>({databaseId:'synthetic-only'})};
const host=new LingxingHost(inventory,{authorize:async(role,target)=>target,leaseMs:1000});
const request={socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:1',origin:'chrome-extension://'+'a'.repeat(32)}};
try {
  assert.equal(host.status().message,oldDisconnected);
  messageError(()=>host.authenticate(request,'missing'),oldDisconnected,'worker_disconnected');
  for(const action of ['metrics','logistics']) {
    const target=action==='metrics'?{action,asins:['BCOPY00001']}:{action,workId:1};
    const failed=(await host.submit('business','copy-'+action,target,'synthetic')).job;
    assert.equal(failed.state,'failed');assert.equal(failed.message,taskDisconnected);
  }
  const connected=host.connect(request,null,'synthetic');
  messageError(()=>host.connect(request,'other','synthetic'),'部署电脑已有另一个领星插件连接。原连接断开后将自动重试。','worker_connected');
  for(const action of ['metrics','logistics']) {
    const target=action==='metrics'?{action,asins:['BCOPY00001']}:{action,workId:1};
    const queued=(await host.submit('business','queued-'+action,target,'synthetic')).job;
    assert.equal(queued.state,'queued');
    await assert.rejects(()=>host.finish(queued.id,'other',{}),error=>error.message==='当前插件无法处理此同步任务，请在库存系统中查看同步结果。'&&error.code==='wrong_worker');
  }
  host.worker.seen=Date.now()-2000;host.expire();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lingxing_sync_jobs WHERE state='failed' AND message=?").get(taskDisconnected).n,4);
  assert.equal(host.status().message,oldDisconnected);
  assert.ok(connected.workerId);
} finally {clearInterval(host.timer);db.close();}
check(['FW-037','FW-038','FW-039','FW-040','FW-041'],'指标/物流任务新文案；连接状态和身份认证共用原文不变，权限及任务状态不变');

for(const action of ['metrics','logistics']) {
  const r=await runtime({local:{enabled:false,port:1}});
  const job={id:action==='metrics'?51:52,requestId:'copy-'+action,target:{action},state:'running',message:'synthetic'};
  r.context.testState={port:1,enabled:true,connection:{workerId:'copy-worker',databaseId:'synthetic'},activeJob:null};
  r.host.worker='copy-worker';r.context.testJob=job;
  r.context.fetch=async(url,options)=>{
    const body=JSON.parse(options.body),endpoint=url.split('/').at(-1);r.requests.push({action:endpoint,body});
    return {ok:true,status:200,json:async()=>({ok:true,job:endpoint==='resume'?job:{...job,state:'failed',message:body.error??job.message}})};
  };
  await r.eval('begin(testState,testJob)');
  assert.equal(r.requests.find(x=>x.action==='finish').body.error,'领星同步报表页未打开，请打开 https://erp.lingxing.com/erp/productExpressionNew#aster-sync='+'a'.repeat(32)+' 后重新同步。');
  r.requests.length=0;
  r.context.testState.activeJob={job,workerId:'copy-worker',databaseId:'synthetic',tabId:999};
  await r.eval('inspect(testState)');
  assert.equal(r.requests.find(x=>x.action==='finish').body.error,'领星同步报表页已关闭，本次同步未完成。请打开 https://erp.lingxing.com/erp/productExpressionNew#aster-sync='+'a'.repeat(32)+' 后重新同步。');
  const sample=r.requests.find(x=>x.action==='progress').body.message;
  assert.match(sample,/^扩展采样执行页状态：执行页不存在；采样时间=/);
  const text=action==='metrics'?'正在读取 BCOPY00001 的领星指标（1/2）。':'正在读取移除订单 COPY-ORDER、FNSKU COPY-FNSKU 的包裹及商品数量。';
  Object.assign(r.local,{enabled:true,connection:{workerId:'copy-worker',databaseId:'synthetic'},activeJob:{job,tabId:999}});
  const response=await new Promise(resolve=>r.events.message({type:'report-progress',key:job.requestId,text,pageAt:'synthetic-time',pageVisibility:'hidden'},{tab:{id:999}},resolve));
  assert.equal(response.ok,true);assert.equal(r.local.connectionStatus,`#${job.id} ${text}`);assert.equal(r.requests.at(-1).body.message,text);
  check(action==='metrics'?['FW-042','FW-044','FW-059','FW-060']:['FW-043','FW-045','FW-059','FW-061'],action+'：报表未打开/已关闭地址保留，进度仅去诊断尾注，任务编号和业务值保留，采样消息保留');
}

async function reportRuntime(action, ready) {
  const messages=[],timers=new Map();let timer=0;
  const element={getBoundingClientRect:()=>({width:10,height:10})};
  const table={...element,querySelectorAll:()=>['MSKU','FNSKU','申报量'].map(innerText=>({innerText}))};
  const fields=['.search-block .field-select input[readonly]','.search-block .field-select .fake-select-label'];
  const document={body:{},title:'Synthetic report',visibilityState:'hidden',querySelectorAll:selector=>{
    if(!ready)return [];
    if(fields.includes(selector))return [element];
    if(action==='metrics'&&['#tab-msku','.search-input > input'].includes(selector))return [element];
    if(action==='logistics'&&selector==='.vxe-table--main-wrapper')return [table];
    if(action==='logistics'&&selector==='.search-block .search-input > input')return [element];
    return [];
  }};
  const context=vm.createContext({document,console,AbortController,Date,MutationObserver:class{observe(){}disconnect(){}},setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),chrome:{runtime:{sendMessage:async message=>{messages.push(message);}}},asterLingxing:{collectAsins:async asins=>({items:asins.map(asin=>({asin})),source:{captures:['synthetic']},capturedAt:'synthetic'})},queryLingxingRemoval:async input=>({shipments:[input],capturedAt:'synthetic'})});
  vm.runInContext(await source('edge-extension/report-runner.js'),context);
  const target=action==='metrics'?{action,asins:['BCOPY00001','BCOPY00002']}:{action,orderNo:'COPY-ORDER',fnsku:'COPY-FNSKU'};
  context.job={requestId:'copy-'+action,target};vm.runInContext('asterStartReport(job)',context);
  if(!ready)for(const fn of [...timers.values()])fn();
  for(let turn=0;turn<100&&!context.asterReportState.settled;turn++)await Promise.resolve();
  assert.equal(context.asterReportState.settled,true,'mocked report must settle without real timers');
  await vm.runInContext('asterStopReport("synthetic cleanup")',context);
  return {context,messages,state:context.asterReportState};
}
for(const action of ['metrics','logistics']) {
  const timeout=await reportRuntime(action,false);
  assert.equal(timeout.state.payload.error,'领星报表的查询控件在30秒内未就绪，请在部署电脑检查报表后重新同步。');
  const ready=await reportRuntime(action,true),progress=ready.messages.filter(x=>x.type==='report-progress').map(x=>x.text);
  assert.equal(ready.state.payload.error,undefined);
  assert.deepEqual(progress,action==='metrics'?['正在读取 BCOPY00001 的领星指标（1/2）。','正在读取 BCOPY00002 的领星指标（2/2）。']:['正在读取移除订单 COPY-ORDER、FNSKU COPY-FNSKU 的包裹及商品数量。']);
  check(action==='metrics'?['FW-046','FW-057']:['FW-047','FW-058'],action+'：控件未就绪事实准确，正常采集进度保留标识/序号与总数');
}

const collector=await source('scripts/lingxing-page-collector.js');
const collectorChecks=[
  ['FW-048','未能确认领星${stage}后的报表结果，请在部署电脑检查报表后重新同步。'],
  ['FW-049','未能在领星中选择“${value}”，当前值为“${readValue()}”。请在部署电脑核对报表后重新同步。'],
  ['FW-050','未找到领星日期选项“${label}”，请在部署电脑检查报表后重新同步。'],
  ['FW-051','${asin} 近${days}天报表在 20 秒内未完成刷新，本次未取得数据，请重新同步。'],
  ['FW-062',"progress('正在读取领星报表汇总。')"],['FW-063',"progress('正在准备领星报表。')"],
  ['FW-064',"progress('正在重置领星查询条件。')"],['FW-065',"progress('正在应用查询类型和币种。')"],
];
for(const [id,text]of collectorChecks){assert.ok(collector.includes(text),id);check([id],'主采集源具体文本及动态参数（源检查）');}
assert.ok(collector.includes('没有可查询的 ASIN，请核对待审核单据'));
check(['FW-052-A','FW-052-B'],'未触达空ASIN保护原文保留');
const removalContext=vm.createContext({location:{origin:'https://erp.lingxing.com',pathname:'/erp/msupply/removeInbound'}});
vm.runInContext(await source('scripts/lingxing-removal-page-collector.js'),removalContext);
messageError(()=>vm.runInContext("collectLingxingRemoval({orderNo:'',fnsku:''})",removalContext),'请提供移除订单号和 FNSKU。');
check(['FW-053'],'真实物流参数检查函数，无网页/网络访问');
const worker=await source('edge-extension/worker.html');
for(const [id,text]of [['FW-054','请在库存系统部署电脑连接，保持 Edge 运行，中断可自动重连'],['FW-055','断开后不会自动重连，改端口前先断开，有同步任务需等待完成'],['FW-056','请保持领星同步报表页开启，登录异常需在部署电脑 Edge 登录后重新同步']]){
  assert.ok(worker.includes(text));check([id],'按用户意见原样写入设置页');
}
messageError(()=>processRelocationAddress('MISSINGUS',''),'店铺移仓地址信息配置不全，请核对账号、简称及房间号');
for(const raw of ['', 'XXX','填写项'])messageError(()=>processRelocationAddress('COPYUS',raw),'请填写供应商提供的原始移仓地址，不要填写模板说明或“XXX”。');
for(const raw of ['Synthetic Supplier\nUnknown Street','12000 Magnolia Ave'])messageError(()=>processRelocationAddress('COPYUS',raw),'未识别到支持的街道地址，或街道地址前缺少供应商联系人。请核对原始移仓地址（支持 12000 Magnolia Ave、323 Industrial Court）。');
assert.equal(processRelocationAddress('COPYUS','Synthetic Supplier\n12000 Magnolia Ave').address,'Synthetic Supplier-SYNTH\n12000 Magnolia Ave of COPY101');
check(['SJ-042','SJ-043','SJ-044'],'使用合成账号，错误仍准确区分；合法地址加工结果不变');
const server=await source('server.mjs');
const relocationCatch=server.match(/catch\(error\) \{ errors\.push\((\{sourceRow,message:'工作表“移仓升级”[^\n]+)\); \}/)?.[1];
assert.ok(relocationCatch);
const relocationError=vm.runInNewContext('('+relocationCatch+')',{sourceRow:9,error:new Error('COPY完整错误')});
assert.equal(relocationError.message,'工作表“移仓升级”第 9 行：COPY完整错误');
const transferCatch=server.match(/catch\(error\)\{errors\.push\((\{sourceRow,message:\(error\.message\.startsWith\('工作表'\)[^\n]+)\);\}/)?.[1];
assert.ok(transferCatch);
for(const stage of ['rma','count','progress'])for(const reason of ['COPY完整错误','工作表“转仓升级”第 9 行，“数量”：COPY完整错误']){
  const result=vm.runInNewContext('('+transferCatch+')',{sourceRow:9,error:new Error(reason)});
  assert.equal(result.message,reason.startsWith('工作表')?reason:'工作表“转仓升级”第 9 行：'+reason);
}
check(['SJ-045','SJ-046','SJ-047','SJ-048'],'运行现有错误格式化表达式，保留完整原因及原有定位，只删除批准尾句');

for(const name of ['lingxing-page-collector.js','lingxing-removal-page-collector.js'])assert.equal(await source('scripts/'+name),await source('edge-extension/'+name));
check(['FW-048','FW-049','FW-050','FW-051','FW-052-A','FW-052-B','FW-053','FW-062','FW-063','FW-064','FW-065'],'scripts 主源和扩展构建同步副本文本一致');
const covered=[...new Set(checks.flatMap(x=>x.ids))].sort();
assert.equal(covered.length,54);
const result={kind:'approved-copy-synthetic-and-vm',passed:true,checks,covered,coveredCount:covered.length,changedCount:50,kept:['FW-024','FW-052-A','FW-052-B','FW-059'],realLingxing:false,productionAccess:false,serversStarted:0};
await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));
console.log('COPY_SHEET_FW_RESULT '+JSON.stringify({out,checks:checks.length,covered:covered.length,passed:true}));
