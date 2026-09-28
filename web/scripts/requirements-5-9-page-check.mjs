// 新需求验收：真实隔离 HTTP、浏览器下载/上传；领星执行器使用明确标记的协议夹具。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {InventoryDatabase,createInventoryDatabase,OVERSEAS_WAREHOUSES} from '../../inventory-db.mjs';
import {TRANSFER_COLUMNS,UPGRADE_COLUMNS} from '../../upgrade-template.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'../..');
await fs.mkdir(path.join(root,'.test-output'),{recursive:true});
const state=await fs.mkdtemp(path.join(root,'.test-output/req59-page-')),out=path.join(state,'artifacts');
await fs.mkdir(out);createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID(),port=await freePort(),base=`http://127.0.0.1:${port}`;
const instanceId=createTestInstanceId('req59-page'),checks=[],calls=[],errors=[];
const check=name=>{checks.push(name);console.log('PASS '+name);};
let browser,server,workerId,page;
async function api(route,role='logistics',body,status=200,headers={}) {
  const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
  const value=await r.json();calls.push({route,status:r.status,value});assert.equal(r.status,status,JSON.stringify(value));return value;
}
async function uploadPreview(kind,bytes,name) {
  const r=await fetch(`${base}/api/${kind}/preview`,{method:'POST',headers:{'x-role':'logistics','x-file-name':encodeURIComponent(name),'x-date-year':'2026'},body:bytes});
  const p=await r.json();assert.equal(r.status,200,JSON.stringify(p));return p;
}
const col=i=>{let s='';for(let n=i+1;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function workbookRows(bytes) {
  const zip=unzipSync(bytes),text=strFromU8(zip['xl/worksheets/sheet1.xml']);
  const decode=s=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&amp;','&');
  return [...text.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(m=>[...m[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(c=>{
    if(!c[2])return null;const v=c[2].match(/<(?:v|t)(?: [^>]*)?>([\s\S]*?)<\/(?:v|t)>/)?.[1]??'';
    return c[1].includes('inlineStr')?decode(v):Number(v);
  }));
}
// 在浏览器实际下载的同一模板副本中回填；保留 ZIP 其余条目与稳定身份。
async function fillWorkbook(file,columns,patches,name) {
  const z=unzipSync(await fs.readFile(file));let sheet=strFromU8(z['xl/worksheets/sheet1.xml']);
  patches.forEach((patch,row)=>Object.entries(patch).forEach(([key,value])=>{
    const address=col(columns.findIndex(c=>c[0]===key))+(row+2);
    const cell=value===null?`<c r="${address}"/>`:typeof value==='number'?`<c r="${address}" t="n"><v>${value}</v></c>`:`<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    const re=new RegExp(`<c\\b(?=[^>]*r="${address}")[^>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)`);
    assert.match(sheet,re);sheet=sheet.replace(re,cell);
  }));
  z['xl/worksheets/sheet1.xml']=strToU8(sheet);const target=path.join(out,name);await fs.writeFile(target,zipSync(z));return target;
}
async function download(button,name) {const waiting=page.waitForEvent('download');await button.click();const d=await waiting;const file=path.join(out,name);await d.saveAs(file);assert.ok((await fs.stat(file)).size>0);return file;}
const nav=label=>page.locator('.sidebar .nav-item',{hasText:label}).click();
const mode=label=>page.getByRole('tab',{name:label,exact:true}).click();
async function importPage(file,expectedMessage='已保存') {
  await page.locator('.upgrade-template-actions input[type=file]').setInputFiles(file);
  await page.getByRole('button',{name:'确认导入',exact:true}).waitFor();await page.getByRole('button',{name:'确认导入',exact:true}).click();
  await page.locator('.upgrade-template-actions').getByText(new RegExp(expectedMessage)).waitFor();
}
const flow=async id=>(await api('/api/upgrades/flows')).flows.find(f=>f.id===id);
async function selectFlow(id) {const f=await flow(id);const checkbox=page.getByRole('checkbox',{name:new RegExp(f.flowId)});await checkbox.check();return f;}
async function exportFlow(id,name) {await selectFlow(id);return download(page.getByRole('button',{name:'导出所选数据流（回填模板）',exact:true}),name);}
const origin='chrome-extension://'+'a'.repeat(32);
const execute=(action,p={})=>api('/api/lingxing-worker/'+action,'admin',{workerId,...p},200,{origin});
try {
  server=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:['ignore',fsSync.openSync(path.join(state,'server.log'),'a'),fsSync.openSync(path.join(state,'server.log'),'a')],env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});
  await waitForOwnedServer({base,child:server,instanceId});
  browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  page=await browser.newPage({viewport:{width:1500,height:1000},locale:'zh-CN'});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.getByLabel('切换当前操作角色').selectOption('logistics');await nav('在途库存');
  const initial=await download(page.getByRole('button',{name:'下载转仓升级模板',exact:true}),'01-转仓首次模板.xlsx');
  const values=workbookRows(await fs.readFile(initial));assert.deepEqual(values[0],TRANSFER_COLUMNS.map(c=>c[1]));assert.equal(new Set(values.slice(1).map(r=>r[0])).size,20);
  const initialFilled=await fillWorkbook(initial,TRANSFER_COLUMNS,[{model:'SYNTH-TONER-001',quantity:60,plan:'SYNTH-BROWSER',date:'2026-09-28',version:'V1',fnsku:'X123456789',team:'一团',store:'AUS',packPerBox:4}],'02-转仓首次回填.xlsx');
  const beforeStock=db.getCatalog().models.find(m=>m.model==='SYNTH-TONER-001').inStock;
  await importPage(initialFilled);let t=(await api('/api/upgrades/flows')).flows.find(f=>f.plan==='SYNTH-BROWSER');
  assert.equal(t.status,'third_party');assert.equal(db.getCatalog().models.find(m=>m.model==='SYNTH-TONER-001').inStock,beforeStock);
  await importPage(initialFilled);assert.equal((await api('/api/upgrades/flows')).flows.filter(f=>f.plan==='SYNTH-BROWSER').length,1);
  check('浏览器实际下载首次模板、回填上传，首次重试只产生一条来源且未入普通在库');
  await nav('升级库存');await mode('转仓升级');
  let exported=await exportFlow(t.id,'03-升级回填原始.xlsx');assert.deepEqual(workbookRows(await fs.readFile(exported))[0],UPGRADE_COLUMNS.map(c=>c[1]));
  await importPage(await fillWorkbook(exported,UPGRADE_COLUMNS,[{rma:'RMA-BROWSER'}],'04-RMA.xlsx'));
  assert.equal((await flow(t.id)).status,'awaiting_count');
  exported=await exportFlow(t.id,'05-待清点导出.xlsx');
  await importPage(await fillWorkbook(exported,UPGRADE_COLUMNS,[{countedQuantity:55}],'06-清点55.xlsx'));
  assert.equal((await flow(t.id)).progressQuantity,55);assert.equal((await flow(t.id)).countDifference,-5);
  check('同模板RMA进入待清点，清点55形成升级中55及差额−5');
  exported=await exportFlow(t.id,'07-升级中导出.xlsx');
  const two=await fillWorkbook(exported,UPGRADE_COLUMNS,[{progressQuantity:53,completedQuantity:2,completedVersion:'V2',warehouse:OVERSEAS_WAREHOUSES[0]}],'08-累计2.xlsx');
  await importPage(two);await importPage(two);
  const p=await uploadPreview('upgrades/update',await fs.readFile(two),'08-累计2.xlsx');const replayPayload={...p,requestId:rid()};
  const replay=await api('/api/upgrades/update/import','logistics',replayPayload);assert.equal((await api('/api/upgrades/update/import','logistics',replayPayload)).deduped,true);
  assert.equal(replay.flows[0].completedQuantity,2);
  exported=await exportFlow(t.id,'09-完成2导出.xlsx');await importPage(await fillWorkbook(exported,UPGRADE_COLUMNS,[{progressQuantity:50,completedQuantity:5}],'10-累计5.xlsx'));
  t=await flow(t.id);assert.equal(t.completedQuantity,5);assert.equal(db.getBalance(t.details[0].batchKey).onHand,5);
  check('浏览器同模板2→2→5净入库5，提交回执重试不重放');
  const stale=await fillWorkbook(two,UPGRADE_COLUMNS,[{completedQuantity:3,progressQuantity:52}],'11-旧版本修改.xlsx');
  const staleP=await uploadPreview('upgrades/update',await fs.readFile(stale),'11-旧版本修改.xlsx');
  assert.equal((await api('/api/upgrades/update/import','logistics',{...staleP,requestId:rid()},409)).code,'completion_stale_revision');
  check('实际旧文件改成不同内容返回版本冲突，不覆盖5件');
  await page.screenshot({path:path.join(out,'转仓升级页面.png'),fullPage:true});

  // 普通在途导入的店铺和套/箱同时覆盖后续 FBA 与部分转仓。
  const headers='ITEM,数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号,店铺';
  const csv=Buffer.from(headers+'\nSYNTH-TONER-001,198,2,XTRANSIT001,Aster海外仓,PARTIAL-198,2026-09-28,一团,V1,AUS\nSYNTH-TONER-001,80,4,XTRANSIT002,直发FBA,FUTURE-FBA,2026-09-28,一团,V1,BUS');
  const transitP=await uploadPreview('transit',csv,'合成硒鼓在途.csv');assert.equal(transitP.rows[1].data.store,'BUS');
  const transitImport=await api('/api/transit/import','logistics',{previewToken:transitP.previewToken,fileName:transitP.fileName,fileHash:transitP.fileSha256,templateHash:transitP.templateSha256,rows:transitP.rows,requestId:rid()});
  const tr=transitImport.rows.find(r=>r.plan==='PARTIAL-198'),fb=transitImport.rows.find(r=>r.plan==='FUTURE-FBA');
  const partial=await fillWorkbook(initial,TRANSFER_COLUMNS,[{transitId:tr.id,quantity:60}],'12-部分转仓.xlsx');
  const partialP=await uploadPreview('upgrades/transfer',await fs.readFile(partial),'12-部分转仓.xlsx');
  // 初次模板已经用于其他来源；另一次发起必须使用未用行身份。
  partialP.rows[0].importId=values[2][0];
  const freshPartial=await fillWorkbook(partial,TRANSFER_COLUMNS,[{importId:values[2][0]}],'13-部分转仓新身份.xlsx');
  const pp=await uploadPreview('upgrades/transfer',await fs.readFile(freshPartial),'13-部分转仓新身份.xlsx');
  const partialResult=await api('/api/upgrades/transfer/import','logistics',{...pp,requestId:rid()});
  assert.equal(db.getTransit(tr.id).remaining_quantity,138);
  const repeatP=await uploadPreview('upgrades/transfer',await fs.readFile(freshPartial),'同一转仓另存.xlsx');await api('/api/upgrades/transfer/import','logistics',{...repeatP,requestId:rid()});
  assert.equal(db.getTransit(tr.id).remaining_quantity,138);
  const shelf=await api(`/api/transit/${tr.id}/on-shelf`,'assistant-1',{expectedRevision:db.getTransit(tr.id).revision,yes:'YES',requestId:rid()});
  assert.equal(shelf.after.inStock-shelf.before.inStock,138);
  const counted=db.upgradeTemplateRows([partialResult.flows[0].id]).map(r=>({...r,rma:'P-60',countedQuantity:65,progressQuantity:65}));
  db.updateUpgradeFlows({role:'logistics',rows:counted,requestId:rid()});assert.equal((await flow(partialResult.flows[0].id)).countDifference,5);
  check('在途198部分转出60，重传不再扣，余138普通上架；清点65差额+5不改原转出');
  const fba=await api(`/api/transit/${fb.id}/on-shelf`,'assistant-1',{expectedRevision:db.getTransit(fb.id).revision,yes:'YES',requestId:rid()});
  const fw=(await api('/api/upgrades/relocation-work-items','purchasing',{fbaArchiveId:fba.fbaArchiveId,requestId:rid()})).workItem;
  assert.equal((await flow(fw.id)).store,'BUS');assert.equal((await flow(fw.id)).packPerBox,'4');
  check('未来在途导入→FBA备份→升级启动完整传递真实店铺和套/箱');

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
  await mode('移仓升级');await page.getByLabel('切换当前操作角色').selectOption('operation-1');
  const card=page.locator('.upgrade-history-card').filter({has:page.getByRole('checkbox',{name:new RegExp(w.workNo)})});await card.getByText('AUTO-P3',{exact:false}).first().waitFor();
  await page.screenshot({path:path.join(out,'移仓自动任务与页面.png'),fullPage:true});check('任务保存后页面读取已发45、完成15及包裹信息');
  await page.getByLabel('切换当前操作角色').selectOption('purchasing');await nav('审批中心');
  const inquiryXlsx=await download(page.getByRole('button',{name:'导出询库',exact:true}),'14-询库实际导出.xlsx');
  const inquiryRows=workbookRows(await fs.readFile(inquiryXlsx));assert.equal(inquiryRows[1][1],100);assert.equal(inquiryRows[1][2],100);assert.equal(inquiryRows[1][10],'已完成');check('询库实际浏览器下载内容保持审核与供应商字段，状态已完成');
  await api('/api/inquiries/clear','alan',{requestId:rid()},403);
  await page.getByLabel('搜索运营姓名、型号或 ASIN').fill('不存在');await page.getByRole('button',{name:'询库数据流-手动清空',exact:true}).click();
  assert.ok(!(await api('/api/approvals','purchasing')).inquiries.some(i=>i.id===inquiry.id));
  await nav('升级库存');await mode('询库备份');await page.getByRole('button',{name:'回撤到待Alan或采购回复',exact:true}).click();
  assert.equal((await api('/api/approvals','purchasing')).inquiries.find(i=>i.id===inquiry.id).status,'pending_purchasing');check('搜索无结果仍清空权限内终态，备份可回撤后重新展示；Alan无清空权');
  assert.deepEqual(errors,[]);db.assertInventoryInvariants();check('浏览器无脚本错误，库存恒等式与外键保持一致');
} finally {
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify({state,base,checks,calls,errors,limitations:['领星任务使用协议夹具，不替代真实网页重新采集']},null,2));
  if(browser)await browser.close();if(server){const done=new Promise(r=>server.once('close',r));server.kill();await done;}db.close();
  console.log(JSON.stringify({state,checks:checks.length}));
}
