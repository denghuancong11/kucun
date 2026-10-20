// All business writes target an owned synthetic SQLite database and service. No production or Lingxing access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from '../node_modules/playwright-core/index.mjs';
import {createInventoryDatabase,InventoryDatabase} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';

const root=path.resolve(import.meta.dirname,'../..'),out=path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/approval-draft-recovery'));
await fs.mkdir(out,{recursive:true});const state=await fs.mkdtemp(path.join(out,'state-'));createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID(),common=r=>({expectedRevision:r.revision,requestId:rid()});
// A current valid one-team source is a business-created transit, not a synthetic SQL balance patch.
const sourceRows=[{sourceRow:2,data:{model:'SYNTH-INK-001',quantity:10,packPerBox:'10',fnsku:'V36-TEAM-SOURCE',shippingMethod:'SyntheticWarehouseA',plan:'V36-TEAM-SOURCE',date:'2026-10-19',team:'一团',version:'V36'}}];
const sourceProof={kind:'import',role:'admin',fileName:'synthetic-v36-墨盒.csv',fileHash:'synthetic-v36-source',templateHash:'synthetic-v36-template',payload:{rows:sourceRows}};
db.transitImport({...sourceProof,rows:sourceRows,previewToken:db.createTransitPreviewToken(sourceProof).token,requestId:rid()});
const batch=db.getCatalog().stockDetails['SYNTH-INK-001'].find(r=>!r.isLegacyPlaceholder);
db.db.prepare("UPDATE stock_batches SET pack_per_box='10',base_quantity=2000 WHERE batch_key=?").run(batch.batchKey);
const docs=[],checks=[],errors=[],requests=[];let child,browser,page,failure;
function fixture(kind,stage,model='SYNTH-INK-001'){
 const label=kind+'-'+stage+'-'+docs.length;
 let r=kind==='allocation'?db.createAllocation({role:'admin',model,sourceBatchKey:batch.batchKey,plan:batch.plan,date:batch.date,version:batch.version,quantity:100,department:'一团',store:label.replaceAll('-','')+'US',operator:label,fnsku:'DRAFT-'+label,asin:'BDRAFT001',requestId:rid()}).record:db.createInquiry({role:'operation-1',model,quantity:100,department:'一团',store:label.replaceAll('-','')+'US',operator:label,fnsku:'DRAFT-'+label,asin:'BDRAFT001',requestId:rid()}).record;
 if(kind==='allocation'&&stage==='procurement'){db.db.prepare('UPDATE allocation_documents SET ink_workflow_stage=NULL WHERE id=?').run(r.id);r=db.getDocument(r.id);}
 if(stage!=='business')r=db[kind==='allocation'?'reviewAllocation':'reviewInquiry']({id:r.id,role:'business',decision:'approve',approvedQuantity:80,...common(r)}).record;
 if(['procurement','archive'].includes(stage)&&model==='SYNTH-INK-001')r=db[kind==='allocation'?'reviewAlanAllocation':'reviewAlanInquiry']({id:r.id,role:'alan',alanQuantity:70,...common(r)}).record;
 if(stage==='archive')r=db.replyInquiry({id:r.id,role:'purchasing',supplierQuantity:60,shippingWarehouse:'CA',...common(r)}).record;
 const doc={...r,kind,stage};docs.push(doc);return doc;
}
const business=[fixture('inquiry','business','SYNTH-TONER-001'),fixture('allocation','business')];
const alan=[fixture('inquiry','alan'),fixture('allocation','alan')];
const procurement=[fixture('inquiry','procurement','SYNTH-TONER-001'),fixture('allocation','procurement')];
const archives=[fixture('inquiry','archive'),fixture('inquiry','archive','SYNTH-TONER-001')];
const port=await freePort(),base='http://127.0.0.1:'+port,instanceId=createTestInstanceId('approval-draft-recovery');
const buildMeta=JSON.parse(await fs.readFile(path.join(process.env.ASTER_WEB_DIST||path.join(root,'web/dist'),'build-meta.json'),'utf8'));
const check=(name,actual,expected)=>{const passed=JSON.stringify(actual)===JSON.stringify(expected);checks.push({name,actual,expected,passed});console.log((passed?'PASS ':'FAIL ')+name);};
const row=doc=>page.locator('[data-document-key="'+doc.kind+'-'+doc.id+'"]');
const record=doc=>doc.kind==='allocation'?db.getDocument(doc.id):db.getInquiry(doc.id);
const route=(doc,action)=>'/api/'+(doc.kind==='allocation'?'allocations':'inquiries')+'/'+doc.id+'/'+action;
const draftKey=(doc,role)=>'aster-draft:'+role+':approval-'+doc.kind+'-'+doc.id;
const cache=(doc,role)=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'null')?.value??null,draftKey(doc,role));
const snapshot=()=>JSON.stringify(['inquiry_documents','allocation_documents','inventory_ledger','stock_batches'].map(name=>db.db.prepare('SELECT * FROM '+name).all()));
async function nav(role){await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(role);await page.locator('.sidebar .nav-item',{hasText:'审批中心'}).click();await page.waitForLoadState('networkidle');while(await page.locator('.approval-model-row[aria-expanded="false"]').count())await page.locator('.approval-model-row[aria-expanded="false"]').first().click();}
async function leave(){await page.locator('.sidebar .nav-item',{hasText:'库存汇总'}).click();}
async function inputValues(doc,labels){const values=[];for(const label of labels)values.push(await row(doc).getByLabel(label,{exact:true}).inputValue());return values;}
async function retention(doc,role,labels,values){await nav(role);for(let i=0;i<labels.length;i++){const input=row(doc).getByLabel(labels[i],{exact:true});if(labels[i]==='发货仓库')await input.selectOption(values[i]);else await input.fill(values[i]);}await leave();await nav(role);check(doc.kind+' '+doc.stage+' 切页恢复',await inputValues(doc,labels),values);await page.reload();await nav(role);check(doc.kind+' '+doc.stage+' 刷新恢复',await inputValues(doc,labels),values);}
async function openArchive(doc,role){await nav(role);await row(doc).getByRole('button',{name:doc.category==='硒鼓'?'确认实际发出并归档':'采购归档',exact:true}).click();return page.getByRole('dialog');}
async function api(doc,action,role,payload){const response=await fetch(base+route(doc,action),{method:'POST',headers:{'x-role':role,'content-type':'application/json'},body:JSON.stringify({...payload,...common(record(doc))})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;}
async function waitFor(fn){let last;for(let i=0;i<100;i++){try{return await fn();}catch(error){last=error;}await new Promise(r=>setTimeout(r,50));}throw last;}
async function posted(doc,action,button){const pending=page.waitForResponse(r=>new URL(r.url()).pathname===route(doc,action)&&r.request().method()==='POST');await button.click();const response=await pending;assert.equal(response.status(),200,await response.text());await page.waitForLoadState('networkidle');}
async function lateReject(doc,editNew){
 let arrived,release;const ready=new Promise(r=>{arrived=r}),held=new Promise(r=>{release=r}),pattern='**'+route(doc,'review');
 await page.route(pattern,async request=>{arrived();await held;await request.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,error:'审批晚拒绝恢复',requestNotApplied:true})});});
 try{
  await row(doc).getByRole('button',{name:'批准',exact:true}).click();await ready;await leave();await page.locator('.sidebar .nav-item',{hasText:'审批中心'}).click();
  const group=page.locator('.approval-model-group[data-model="'+doc.model+'"]');await group.waitFor();if(await group.locator('.approval-model-row').getAttribute('aria-expanded')==='false')await group.locator('.approval-model-row').click();
  if(editNew){await row(doc).getByLabel('审核数量',{exact:true}).fill('6');await row(doc).getByLabel('商务备注',{exact:true}).fill('返回后新编辑');}
  release();await page.waitForLoadState('networkidle');await page.reload();await nav('business');
  check(editNew?'晚409不覆盖返回后新填写内容':'离页又返回后晚409恢复本次原稿',await inputValues(doc,['审核数量','商务备注']),editNew?['6','返回后新编辑']:['7','商务草稿-'+doc.id]);
 }finally{release();await page.unroute(pattern);}
}
try{
 const before=snapshot();child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ASTER_STATE_ROOT:state,HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});await waitForOwnedServer({base,child,instanceId});
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')requests.push({url:r.url(),body:r.postData()});});await page.goto(base);
 for(const doc of business)await retention(doc,'business',['审核数量','商务备注'],[doc.kind==='inquiry'?'7':'80','商务草稿-'+doc.id]);
 for(const doc of alan)await retention(doc,'alan',['Alan审核数量','Alan备注'],[doc.kind==='inquiry'?'0':'70','Alan草稿-'+doc.kind]);
 for(const doc of procurement)await retention(doc,'purchasing',doc.kind==='inquiry'?['供应商库存回复','发货仓库','采购备注']:['供应商库存回复','采购备注'],doc.kind==='inquiry'?['73','SC','采购询库草稿']:['60','采购调拨草稿']);
 for(const [i,doc] of archives.entries()){
  const role='purchasing';let dialog=await openArchive(doc,role);const expected=['DRAFT-PLAN-'+i,'2026-10-14','DRAFT-V2'];for(const [j,label] of ['发货计划号','发货时间','原版本号'].entries())await dialog.getByLabel(label,{exact:true}).fill(expected[j]);await dialog.getByRole('button',{name:'取消',exact:true}).click();await leave();dialog=await openArchive(doc,role);check(role+'归档切页恢复',await Promise.all(['发货计划号','发货时间','原版本号'].map(label=>dialog.getByLabel(label,{exact:true}).inputValue())),expected);await page.reload();dialog=await openArchive(doc,role);check(role+'归档刷新恢复',await Promise.all(['发货计划号','发货时间','原版本号'].map(label=>dialog.getByLabel(label,{exact:true}).inputValue())),expected);await dialog.getByRole('button',{name:'取消',exact:true}).click();
 }
 check('草稿检查没有审批或库存写入',snapshot(),before);check('草稿检查没有业务POST',requests.length,0);
 await nav('logistics');check('物流不能编辑硒鼓采购字段',await row(procurement[0]).getByLabel('供应商库存回复',{exact:true}).count(),0);await nav('purchasing');check('切回采购恢复其自身字段',await inputValues(procurement[0],['供应商库存回复','发货仓库','采购备注']),['73','SC','采购询库草稿']);
 await fs.writeFile(path.join(out,'retention-evidence.json'),JSON.stringify({checks,buildMeta,productionWrites:0},null,2));
 if(checks.every(c=>c.passed)){
  const doc=business[0];await nav('business');const pattern='**'+route(doc,'review');await page.route(pattern,r=>r.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,error:'审批草稿隔离拒绝',requestNotApplied:true})}));await row(doc).getByRole('button',{name:'批准',exact:true}).click();await row(doc).getByText('审批草稿隔离拒绝',{exact:true}).waitFor();await page.unroute(pattern);await page.reload();await nav('business');check('明确4xx后恢复数量和备注',await inputValues(doc,['审核数量','商务备注']),['7','商务草稿-'+doc.id]);assert.equal(snapshot(),before);
  await lateReject(doc,false);await lateReject(doc,true);await row(doc).getByLabel('审核数量',{exact:true}).fill('7');await row(doc).getByLabel('商务备注',{exact:true}).fill('商务草稿-'+doc.id);assert.equal(snapshot(),before);
  const oldRevision=record(doc).revision;db.db.prepare('UPDATE inquiry_documents SET revision=revision+1 WHERE id=?').run(doc.id);await page.reload();await nav('business');check('同阶段revision变化刷新后保留数量备注',await inputValues(doc,['审核数量','商务备注']),['7','商务草稿-'+doc.id]);
  await posted(doc,'review',row(doc).getByRole('button',{name:'批准',exact:true}));check('商务成功后清除草稿并使用已填数量',[record(doc).approvedQuantity,await cache(doc,'business')],[7,null]);check('保留草稿仍使用刷新后的最新revision提交',JSON.parse(requests.filter(r=>r.url.endsWith(route(doc,'review'))).at(-1).body).expectedRevision,oldRevision+1);
  const lost=alan[0];await nav('alan');const lostPattern='**'+route(lost,'alan-review');let first=true;await page.route(lostPattern,async r=>{const response=await r.fetch();assert.equal(response.status(),200);if(first){first=false;return r.abort('failed');}return r.fulfill({response});});await row(lost).getByRole('button',{name:'提交Alan审核',exact:true}).click();await row(lost).getByRole('button',{name:'重试确认',exact:true}).waitFor();check('Alan丢回执不保留可重新提交草稿',await cache(lost,'alan'),null);await page.reload();await nav('alan');await page.getByRole('region',{name:'待确认业务提交'}).getByRole('button',{name:'确认本次提交',exact:true}).click();await page.getByText(/原提交结果已确认/).waitFor();await page.unroute(lostPattern);check('Alan零原请求恢复不重复办理',[record(lost).alanQuantity,record(lost).events.filter(e=>e.type==='alan_review').length],[0,1]);const attempts=requests.filter(r=>r.url.endsWith(route(lost,'alan-review')));check('Alan恢复发送原完整参数',attempts[0].body,attempts[1].body);
  await nav('purchasing');await posted(procurement[0],'reply',row(procurement[0]).getByRole('button',{name:'提交采购回复',exact:true}));check('采购提交实际数量仓库备注且清除草稿',[record(procurement[0]).supplierQuantity,record(procurement[0]).shippingWarehouse,record(procurement[0]).procurementNote,await cache(procurement[0],'purchasing')],[73,'SC','采购询库草稿',null]);
  const old=procurement[1];await api(old,'reply','logistics',{supplierQuantity:20,procurementNote:'其他岗位办理'});await api(old,'archive','logistics',{});await api(old,'recall','purchasing',{});await page.reload();await nav('purchasing');check('实际办理并回撤后不恢复旧阶段采购草稿',await inputValues(old,['供应商库存回复','采购备注']),['','']);
  const archived=archives[0];let dialog=await openArchive(archived,'purchasing');const archivePattern='**'+route(archived,'archive');first=true;await page.route(archivePattern,async r=>{const response=await r.fetch();assert.equal(response.status(),200);if(first){first=false;return r.abort('failed');}return r.fulfill({response});});await dialog.getByRole('button',{name:'提交采购归档',exact:true}).click();await waitFor(()=>assert.equal(record(archived).status,'archived'));check('归档丢回执不保留旧发货资料草稿',await cache(archived,'purchasing'),null);await page.reload();await nav('purchasing');await page.getByRole('region',{name:'待确认业务提交'}).getByRole('button',{name:'确认本次提交',exact:true}).click();await page.getByText(/原提交结果已确认/).waitFor();await page.unroute(archivePattern);check('归档原请求恢复仅一条历史',record(archived).events.filter(e=>e.type==='archive').length,1);
  await api(archived,'recall','purchasing',{});await api(archived,'reply','purchasing',{supplierQuantity:50,shippingWarehouse:'CA'});await page.reload();dialog=await openArchive(archived,'purchasing');check('回撤重办后归档字段从空值开始',await Promise.all(['发货计划号','发货时间','原版本号'].map(label=>dialog.getByLabel(label,{exact:true}).inputValue())),['','','']);await dialog.getByRole('button',{name:'取消',exact:true}).click();
 }
 assert.deepEqual(errors,[]);db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);await page.screenshot({path:path.join(out,'final.png'),fullPage:true});
}catch(error){failure=error;console.error(error);await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await browser?.close();if(child?.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}db.close();await fs.writeFile(path.join(out,'result.json'),JSON.stringify({state,base,checks,errors,requests,buildMeta,failure:failure?.stack??null,productionWrites:0,realLingxingRequests:0,negativeResponse:'明确409由浏览器注入，仅用于表单失败恢复；其他成功与回撤均实际业务API'},null,2));}
if(failure||checks.some(c=>!c.passed))process.exitCode=1;
