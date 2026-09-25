// 隔离 SQLite、真实 HTTP/React 页面；仅测试子进程预加载受控时钟，正式服务不增加时间配置。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {createInventoryDatabase,InventoryDatabase} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'../..');
const output=process.env.ASTER_CLEAR_OUTPUT||path.join(root,'.test-output/approval-schedule');
const state=await fs.mkdtemp(path.join(os.tmpdir(),'aster-approval-clear-'));
await fs.mkdir(output,{recursive:true});
const clockFile=path.join(state,'clock.txt'),preload=path.join(state,'clock.mjs');
await fs.writeFile(preload,`import fs from 'node:fs';const RealDate=Date;const now=()=>RealDate.parse(fs.readFileSync(${JSON.stringify(clockFile)},'utf8'));globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now()]));}static now(){return now();}};`);
const setTime=at=>fs.writeFile(clockFile,at);
await setTime('2026-09-21T12:00:00.000Z');
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});
const db=new InventoryDatabase(state),port=await freePort(),base=`http://127.0.0.1:${port}`;
const checks=[],errors=[],posts=[],rid=()=>crypto.randomUUID();let server,browser;
const check=name=>{checks.push(name);console.log('PASS '+name);};
async function start(){const instanceId=createTestInstanceId('approval-clear');server=spawn(process.execPath,['--import',pathToFileURL(preload).href,path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,ASTER_TEST_INSTANCE_ID:instanceId,HOST:'127.0.0.1',PORT:String(port),PROD:'1',TZ:'America/Los_Angeles'}});await waitForOwnedServer({base,child:server,instanceId});}
async function stop(){if(server&&server.exitCode===null){const closed=once(server,'exit');server.kill();await closed;}}
async function api(route,role='admin',body,status=200){const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;}
const meta=key=>db.db.prepare('SELECT value FROM system_meta WHERE key=?').get(key)?.value;
function businessSnapshot(){return Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'system_meta' ORDER BY name").all().map(({name})=>{const rows=db.db.prepare('SELECT * FROM "'+name+'"').all().map(r=>JSON.stringify(r)).sort();return[name,{rows:rows.length,sha256:createHash('sha256').update(rows.join('\n')).digest('hex')}];}));}
const view=()=>api('/api/approvals');
async function inquiry(operator,quantity=10,team='一团'){return(await api('/api/inquiries',team==='一团'?'operation-1':'operation-2',{model:'SYNTH-TONER-001',quantity,department:team,store:'隔离US清空验证',operator,fnsku:'XCLEAR0001',asin:'BCLEAR0001',requestId:rid()})).record;}
async function review(r,kind='inquiries',decision='approve'){return(await api(`/api/${kind}/${r.id}/review`,'business',{decision,approvedQuantity:r.requestedQuantity,businessNote:'隔离审核',expectedRevision:r.revision,requestId:rid()})).record;}
async function reply(r,quantity){return(await api(`/api/inquiries/${r.id}/reply`,'purchasing',{supplierQuantity:quantity,shippingWarehouse:quantity?'验证仓':'',expectedRevision:r.revision,requestId:rid()})).record;}
async function page(who){const p=await browser.newPage({viewport:{width:1366,height:900},timezoneId:'Pacific/Honolulu'});p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});await p.goto(base);await p.getByLabel('切换当前操作角色',{exact:true}).selectOption(who);await p.locator('.sidebar .nav-item',{hasText:'审批中心'}).click();await p.locator('.approval-page').waitFor();return p;}
async function count(p,n){await p.waitForFunction(n=>document.querySelectorAll('.approval-record').length===n,n);}
async function shot(p,name){await p.evaluate(()=>window.scrollTo(0,0));await p.screenshot({path:path.join(output,name+'.png'),fullPage:true,animations:'disabled'});}

try{
 await start();assert.equal(meta('approval_first_clear_at'),'2026-09-22T13:00:00.000Z');assert.equal(meta('approval_clear_before'),undefined);
 const allocBody={model:'SYNTH-TONER-001',plan:'TEST-PLAN-TONER',date:'2026-02-10',version:'V11',quantity:10,department:'一团',store:'隔离US调拨',operator:'完成调拨',fnsku:'XCLEAR0001',asin:'BCLEAR0001',requestId:rid()};
 let finished=(await api('/api/allocations','operation-1',allocBody)).record;finished=await review(finished,'allocations');finished=(await api(`/api/allocations/${finished.id}/confirm`,'assistant-1',{expectedRevision:finished.revision,requestId:rid()})).record;
 const pending=(await api('/api/allocations','operation-1',{...allocBody,operator:'未审核调拨',requestId:rid()})).record;
 let completed=await reply(await review(await inquiry('助理办结')),8);completed=(await api(`/api/inquiries/${completed.id}/archive`,'assistant-1',{plan:'CLEAR-FBA',date:'2026-09-21',version:'V1',expectedRevision:completed.revision,requestId:rid()})).record;
 db.db.prepare('UPDATE inquiry_documents SET archived_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z',completed.id);
 const zero=await reply(await review(await inquiry('采购零回复')),0);
 const rejected=await review(await inquiry('拒绝记录'),'inquiries','reject');
 await reply(await review(await inquiry('待助理')),7);await review(await inquiry('待采购'));await inquiry('待商务二团',10,'二团');
 const initial=await view(),oldCount=initial.allocations.length+initial.inquiries.length;
 assert.equal(oldCount,8);assert.ok(initial.allocations.some(r=>r.id===pending.id));check('首次上线不清空：已完成、未完成、拒绝及零供货记录均保留');
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const a=await page('business'),b=await page('operation-1');await count(a,8);await count(b,7);
 await a.locator('.approval-expand').click();
 assert.equal(await a.locator(`[data-document-no="${finished.documentNo}"] .approval-progress`).innerText(),'已完成');
 assert.equal(await a.locator(`[data-document-no="${completed.documentNo}"] .approval-progress`).innerText(),'已完成');
 assert.equal(await a.locator(`[data-document-no="${zero.documentNo}"] .approval-progress`).innerText(),'');
 assert.equal(await a.locator(`[data-document-no="${rejected.documentNo}"] .approval-progress`).innerText(),'已拒绝');check('助理完成调拨和询库显示已完成，采购零回复及其他进度规则不变');
 for(const width of [1280,1366,1920]){await a.setViewportSize({width,height:900});const size=await a.locator('.sidebar').evaluate(e=>({width:e.getBoundingClientRect().width,brand:e.querySelector('.brand').textContent,clipped:[...e.querySelectorAll('.brand,.brand span')].some(n=>n.scrollWidth>n.clientWidth+1),page:document.documentElement.scrollWidth,window:innerWidth}));assert.equal(size.width,64);assert.equal(size.brand,'UUnismar耗材库存系统');assert.equal(size.clipped,false);assert.equal(size.page,size.window);assert.equal(await a.locator('.brand-mark').innerText(),'U');assert.equal(await a.locator('.rail-caption').count(),0);await shot(a,'before-clear-'+width);}
 check('三个桌面宽度均保留64px侧栏，U圆标与分行名称完整显示，无ASTER字样');
 const original=businessSnapshot(),catalog=db.getCatalog(),sources=db.getRelocationCandidates();
 await setTime('2026-09-22T12:59:59.999Z');await api('/api/sync');assert.equal((await view()).inquiries.length,6);assert.equal(meta('approval_clear_before'),undefined);
 const version=db.syncState().dataVersion;await setTime('2026-09-22T13:00:00.000Z');
 // 不主动请求审批接口：由两台已打开页面原有的 /api/sync 轮询触发及发现清空。
 await Promise.all([count(a,0),count(b,0)]);assert.equal(db.syncState().dataVersion,version+1);assert.equal(meta('approval_clear_before'),'2026-09-22T13:00:00.000Z');
 assert.deepEqual(businessSnapshot(),original);assert.deepEqual(db.getCatalog().models,catalog.models);assert.deepEqual(db.getRelocationCandidates(),sources);
 const clearedUpgradeSources=await api('/api/upgrades','assistant-1');const clearedInquirySource=clearedUpgradeSources.relocationCandidates.find(row=>row.inquiryId===completed.id);
 assert.ok(clearedInquirySource);assert.equal(clearedInquirySource.asin,'BCLEAR0001');assert.equal(clearedInquirySource.plan,'CLEAR-FBA');assert.equal(clearedInquirySource.initialQuantity,8);
 for(const p of [a,b]){assert.equal((await p.getByRole('button',{name:/^我的待办/}).innerText()).replace(/\s/g,''),'我的待办0');assert.equal(await p.locator('.approval-summary-table').count(),0);}assert.equal(await a.getByRole('button',{name:'同步领星指标',exact:true}).isDisabled(),true);
 await shot(a,'tuesday-cleared');check('周二北京时间21:00两个已打开客户端自动清空，合计/待办/同步范围退出，所有业务表与库存来源不变');
 await Promise.all([api('/api/sync'),api('/api/sync'),view()]);assert.equal(db.syncState().dataVersion,version+1);check('同一时间点多次查询只更新一次版本');
 const completedWork=await api('/api/upgrades/relocation-work-items','assistant-1',{inquiryId:completed.id,requestId:rid()});
 assert.equal(completedWork.workItem.asin,'BCLEAR0001');assert.equal(completedWork.workItem.plan,'CLEAR-FBA');assert.equal(completedWork.workItem.sourceQuantityBefore,8);
 check('审批中心清空后，超过90天的已完成询库仍以持久化来源读取ASIN及计划并可发起升级');
 const atBoundary=await inquiry('时间点新单',7);assert.equal(atBoundary.createdAt,'2026-09-22T13:00:00.000Z');await Promise.all([count(a,1),count(b,1)]);
 assert.equal(await a.locator('[data-field="申请数量合计"]').innerText(),'7');
 let syncTarget;await a.route('**/api/lingxing/jobs',async route=>{if(route.request().method()!=='POST')return route.continue();syncTarget=route.request().postDataJSON();await route.fulfill({status:409,json:{ok:false,error:'隔离验证不创建领星任务'}});});
 await a.getByRole('button',{name:'同步领星指标',exact:true}).click();await a.getByText('隔离验证不创建领星任务',{exact:false}).waitFor();assert.deepEqual(syncTarget.documents,[{kind:'inquiry',id:atBoundary.id}]);
 await api('/api/lingxing/jobs','business',{action:'metrics',documents:[{kind:'allocation',id:pending.id}],requestId:rid()},409);check('时间点及之后新建单据正常显示；同步请求只含新单，旧单提交目标被服务端拒绝');
 await b.reload();await b.getByLabel('切换当前操作角色',{exact:true}).selectOption('operation-1');await b.locator('.sidebar .nav-item',{hasText:'审批中心'}).click();await count(b,1);
 const metaBefore=meta('approval_first_clear_at');await stop();await start();assert.equal(meta('approval_first_clear_at'),metaBefore);assert.equal((await view()).inquiries.length,1);check('刷新、重新进入和服务重启后旧单仍隐藏，首次生效时间不重置');
 await setTime('2026-09-23T13:00:00.000Z');await api('/api/sync');assert.equal((await view()).inquiries.length,1);check('非周二周四不清空');
 await setTime('2026-09-24T12:59:59.999Z');await api('/api/sync');assert.equal((await view()).inquiries.length,1);
 const thursdaySnapshot=businessSnapshot(),thursdayVersion=db.syncState().dataVersion;await setTime('2026-09-24T13:00:00.000Z');await Promise.all([count(a,0),count(b,0)]);assert.equal(db.syncState().dataVersion,thursdayVersion+1);assert.deepEqual(businessSnapshot(),thursdaySnapshot);assert.equal(meta('approval_clear_before'),'2026-09-24T13:00:00.000Z');check('周四北京时间21:00按同一规则清空，21点前保持可见');
 await inquiry('周四之后',9);await Promise.all([count(a,1),count(b,1)]);
 await stop();await setTime('2026-10-01T14:00:00.000Z');
 // 模拟停机时已有迟于截止点的有效记录，验证恢复按计划时间而非恢复时间截断。
 const survivor=db.createInquiry({role:'operation-1',model:'SYNTH-TONER-001',quantity:6,department:'一团',store:'恢复US验证',operator:'截止点后新单',fnsku:'XCLEAR0001',asin:'BCLEAR0001',requestId:rid()}).record;
 db.db.prepare('UPDATE inquiry_documents SET created_at=?,updated_at=? WHERE id=?').run('2026-10-01T13:30:00.000Z','2026-10-01T13:30:00.000Z',survivor.id);
 const offlineSnapshot=businessSnapshot();await start();assert.equal(meta('approval_clear_before'),'2026-10-01T13:00:00.000Z');const recovered=await view();assert.deepEqual(recovered.inquiries.map(r=>r.id),[survivor.id]);assert.deepEqual(recovered.allocations,[]);assert.deepEqual(businessSnapshot(),offlineSnapshot);check('停机跨过多次时间点后使用最近计划截止点，保留截止点之后的新单，业务表不变');
 await Promise.all([a,b].map(p=>p.waitForFunction(no=>document.querySelector(`[data-document-no="${no}"]`)!==null,survivor.documentNo)));await Promise.all([count(a,1),count(b,1)]);assert.equal(await a.locator('[data-field="申请数量合计"]').innerText(),'6');await shot(a,'restart-recovered');
 const fresh=await page('business');await count(fresh,1);assert.equal(await fresh.locator('[data-field="申请数量合计"]').innerText(),'6');check('新客户端与恢复后的原客户端可见范围及合计一致');
 // 在清空时刻首次上线也不立即清空，第一次应为下一次计划时间。
 await stop();db.db.prepare("DELETE FROM system_meta WHERE key IN ('approval_first_clear_at','approval_clear_before')").run();await setTime('2026-10-06T13:00:00.000Z');await start();assert.equal(meta('approval_first_clear_at'),'2026-10-08T13:00:00.000Z');assert.equal(meta('approval_clear_before'),undefined);assert.equal((await view()).inquiries.length,9);check('恰在周二21:00首次上线不会立即清空，首次为周四21:00');
 db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.deepEqual(errors,[]);assert.deepEqual(posts,['/api/lingxing/jobs']);check('清空不产生客户端业务写入，库存约束和外键完整性通过');
}finally{await fs.writeFile(path.join(output,'result.json'),JSON.stringify({checks,errors,posts,state,base},null,2));await browser?.close();await stop();db.close();}
