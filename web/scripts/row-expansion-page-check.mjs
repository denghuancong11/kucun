// Browser interaction regression against a fresh, owned server only. Never writes production or calls Lingxing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from '../node_modules/playwright-core/index.mjs';
import {createInventoryDatabase,InventoryDatabase,ROLES} from '../../inventory-db.mjs';
import {freePort,createTestInstanceId,waitForOwnedServer} from '../../scripts/test-server-ownership.mjs';
import {transferWorkbook,transferSample} from '../../scripts/fixtures/transfer-workbook.mjs';
import {relocationAddressFixture as address} from '../../scripts/fixtures/relocation-workbook.mjs';

const root=path.resolve(import.meta.dirname,'../..');
const out=path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT||path.join(root,'.test-output/row-expansion/page'));
await fs.mkdir(out,{recursive:true});
const state=await fs.mkdtemp(path.join(out,'state-'));
const accounts=path.join(state,'accounts.json');
await fs.writeFile(accounts,JSON.stringify({accounts:[{account:'AUS',shortName:'QA',room:'101'}]}));
process.env.ASTER_WAREHOUSE_ACCOUNTS=accounts;
createInventoryDatabase({databasePath:path.join(state,'data/aster-inventory.sqlite')});
const db=new InventoryDatabase(state),rid=()=>crypto.randomUUID(),common=r=>({expectedRevision:r.revision,requestId:rid()});
const port=await freePort(),base='http://127.0.0.1:'+port,checks=[],screenshots=[],errors=[],requests=[];
let child,browser,page,failure;
const check=(name,evidence={})=>{checks.push({name,...evidence});console.log('PASS '+name);};
async function wait(fn){let error;for(let n=0;n<120;n++){try{return await fn();}catch(e){error=e;}await new Promise(resolve=>setTimeout(resolve,100));}throw error;}
async function api(url,body,role='admin'){const response=await fetch(base+url,{method:body?'POST':'GET',headers:{'x-role':role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;}
async function nav(role,view='升级库存',tab='移仓升级'){await page.getByLabel('切换当前操作角色',{exact:true}).selectOption(role);await page.locator('.sidebar .nav-item',{hasText:view}).click();if(view==='升级库存')await page.getByRole('tab',{name:tab,exact:true}).click();await page.waitForLoadState('networkidle');}
async function shot(name,resetScroll=true){if(resetScroll)await page.locator('.table-wrap').evaluateAll(elements=>elements.forEach(el=>el.scrollLeft=0));const file=path.join(out,name+'.png');await page.screenshot({path:file,fullPage:true,animations:'disabled'});screenshots.push(file);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
const source=id=>page.locator('[data-source-key="inquiry:'+id+'"]');
const sourceDetail=id=>page.locator('[data-relocation-source-detail="inquiry:'+id+'"]');
const task=id=>page.locator('[data-relocation-work-id="'+id+'"]');
const dialog=()=>page.getByRole('dialog');
const close=()=>dialog().getByRole('button',{name:'关闭弹窗',exact:true}).click();
async function expanded(row,value){await wait(async()=>assert.equal(await row.getAttribute('aria-expanded'),String(value)));}
async function clearSelection(){await page.evaluate(()=>getSelection()?.removeAllRanges());}
async function dragSelect(locator){
 await locator.scrollIntoViewIfNeeded();
 const box=await locator.evaluate(el=>{const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())){if(node.textContent.trim().length<2)continue;const range=document.createRange();range.selectNodeContents(node);const r=range.getBoundingClientRect();if(r.width>8&&r.height>4)return {x:r.x,y:r.y,width:r.width,height:r.height};}return null;});
 assert(box,'drag target must have readable text');
 await page.mouse.move(box.x+1,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width-1,box.y+box.height/2,{steps:8});await page.mouse.up();
 const selected=await page.evaluate(()=>getSelection()?.toString());assert(selected?.length,'actual mouse drag must select text');await page.keyboard.press('Control+c');return selected;
}
async function rowCycle({name,row,middle,plain,detail,columns}){
 const layout=await row.evaluate(el=>({headers:[...el.closest('table').querySelectorAll(':scope > thead > tr > th')].map(cell=>cell.textContent.trim()),cells:el.children.length,modelWidth:el.children[0].getBoundingClientRect().width}));
 assert.equal(layout.headers.length,columns);assert.equal(layout.cells,columns);assert.equal(layout.headers[0],'型号');assert(layout.headers.every(label=>label&&label!=='详情'));assert(layout.modelWidth>60,'型号不能沿用原展开图标列的窄宽度');
 assert.equal(await row.locator('.row-caret,.approval-expand,.direct-expand').count(),0);assert.equal(await row.getByRole('button',{name:/^(展开|收起)/}).count(),0);
 await expanded(row,false);
 await plain.click();await expanded(row,true);
 assert.equal(await detail.evaluate(el=>el.closest('tr').querySelector(':scope > td').colSpan),columns);
 await middle.click();await expanded(row,false);
 const right=row.locator(':scope > td').last();const box=await right.boundingBox();assert(box);await right.click({position:{x:box.width-4,y:box.height/2}});await expanded(row,true);
 await detail.locator('td,dd').first().click();await expanded(row,true);
 await row.focus();await page.keyboard.press('Space');await expanded(row,false);await page.keyboard.press('Enter');await expanded(row,true);
 const focused=await row.evaluate(el=>({active:document.activeElement===el,outline:getComputedStyle(el).outlineWidth}));assert(focused.active);assert.notEqual(focused.outline,'0px');
 const selected=await dragSelect(plain);await expanded(row,true);await clearSelection();
 check(name+'：无展开符号和专用空列；普通文字、中间、右空白及行键盘每次只切换一次，正文与拖选复制不误收起',{layout,selected,focusOutline:focused.outline});
}
async function summaryCycle(details,name){
 const summary=details.locator(':scope > summary');assert.equal(await details.getAttribute('open'),null);
 assert.equal(await summary.evaluate(el=>getComputedStyle(el).listStyleType),'none','折叠标题不能保留原生三角');
 const dimensions=await summary.evaluate(el=>({summary:el.getBoundingClientRect().width,parent:el.parentElement.getBoundingClientRect().width}));assert(dimensions.summary>dimensions.parent*.9);
 let box=await summary.boundingBox();await summary.click({position:{x:box.width-4,y:box.height/2}});assert.notEqual(await details.getAttribute('open'),null);
 await details.locator('tbody td').first().click();assert.notEqual(await details.getAttribute('open'),null);
 await summary.focus();await page.keyboard.press('Space');assert.equal(await details.getAttribute('open'),null);await page.keyboard.press('Enter');assert.notEqual(await details.getAttribute('open'),null);
 const selected=await dragSelect(summary);assert.notEqual(await details.getAttribute('open'),null);await clearSelection();
 box=await summary.boundingBox();await summary.click({position:{x:box.width/2,y:box.height/2}});assert.equal(await details.getAttribute('open'),null);
 check(name+'：无三角，标题整条与键盘可切换，正文和标题拖选不误收起',{dimensions,selected});
}
function inquiry(plan,model='SYNTH-TONER-001',version='V1'){
 let row=db.createInquiry({role:'operation-1',model,quantity:100,department:'一团',store:'AUS',operator:'交互隔离',fnsku:'000'+plan,asin:'BROWEXPAND1',requestId:rid()}).record;
 row=db.reviewInquiry({id:row.id,role:'business',decision:'approve',approvedQuantity:100,...common(row)}).record;
 row=db.replyInquiry({id:row.id,role:'purchasing',supplierQuantity:100,shippingWarehouse:'CA',...common(row)}).record;
 return db.archiveInquiry({id:row.id,role:'purchasing',plan,date:'2026-10-13',version,...common(row)}).record;
}
function pending(row){return db.initiateRelocationUpgrade({inquiryId:row.id,sourceRevision:row.revision,role:'admin',requestId:rid()}).workItem;}
function procurement(work){return db.recordRelocationProcurement({id:work.id,role:'logistics',rma:'000RMA-'+work.id,relocationAddress:address,...common(work)}).workItem;}
function shipped(row){let work=procurement(pending(row));work=db.recordRelocationOperation({id:work.id,role:'operation-1',removalOrderNo:'000ORDER-'+work.id,...common(work)}).workItem;return db.syncRelocationLogistics({id:work.id,role:'logistics',capturedAt:new Date().toISOString(),requestId:rid(),shipments:[8,12].map((quantity,index)=>({externalId:work.id+':'+index,trackingNo:'000TRACK-'+index,quantity,carrier:'UPS',storeId:'qa',storeName:'A-US 美国',countryCode:'US',orderNo:work.removalOrderNo,fnsku:work.fnsku,shipDate:'2026-10-13'}))}).workItem;}

try{
 db.db.prepare("UPDATE stock_batches SET pack_per_box='10' WHERE model='SYNTH-TONER-001'").run();
 const recallable=inquiry('000-RECALL','SYNTH-INK-001'),blocked=inquiry('000-BLOCKED','SYNTH-INK-001'),blockedWork=pending(blocked);
 const relocation=shipped(inquiry('000-SHIP')),operation=procurement(pending(inquiry('000-ORDER')));
 const directSource=db.getDirectUpgradeSources().find(row=>row.model==='SYNTH-TONER-001'&&row.sourceVersion==='V10'&&row.available>0);assert(directSource);
 const direct=db.createDirectUpgrade({role:'admin',model:directSource.model,sourceVersion:directSource.sourceVersion,requestId:rid()}).upgrade;
 const instanceId=createTestInstanceId('row-expansion');child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,stdio:'pipe',env:{...process.env,ASTER_STATE_ROOT:state,ASTER_WAREHOUSE_ACCOUNTS:accounts,ASTER_OVERSEAS_WAREHOUSES:'SyntheticWarehouseA;SyntheticWarehouseB',HOST:'127.0.0.1',PORT:String(port),PROD:'1',ASTER_TEST_INSTANCE_ID:instanceId}});child.stderr.on('data',data=>process.stderr.write(data));await waitForOwnedServer({base,child,instanceId});
 const batch=db.getCatalog().stockDetails['SYNTH-TONER-001'].find(row=>row.version==='V11');assert(batch);
 const allocation=(await api('/api/allocations',{model:'SYNTH-TONER-001',sourceBatchKey:batch.batchKey,plan:batch.plan,date:batch.date,version:batch.version,quantity:100,department:'一团',store:'AUS',operator:'交互隔离调拨',fnsku:'000ALLOCATION',asin:'BROWEXPAND1',requestId:rid()},'operation-1')).record;
 const upload=await fetch(base+'/api/transfer-upgrades/preview',{method:'POST',headers:{'x-role':'admin','x-file-name':encodeURIComponent('整行展开隔离.xlsx')},body:transferWorkbook()});assert.equal(upload.status,200);const preview=await upload.json();assert.deepEqual(preview.errors,[]);
 await api('/api/transfer-upgrades/import',{previewToken:preview.previewToken,fileName:preview.fileName,fileHash:preview.fileSha256,templateHash:preview.templateSha256,rows:preview.rows,requestId:rid()});const transfer=db.getTransferUpgrades()[0];
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')requests.push({url:request.url(),body:request.postData()});});await page.goto(base);

 await nav('operation-1','库存汇总');
 const inventory=page.locator('.inventory-model-row').filter({hasText:'SYNTH-TONER-001'}),inventoryDetail=page.locator('#inventory-detail-SYNTH-TONER-001');
 const inventoryAlignment=await inventory.evaluate(el=>({header:el.closest('table').querySelector('.inventory-summary-model-header .th-sort > span').getBoundingClientRect().left,model:el.querySelector('.model-cell').getBoundingClientRect().left}));assert(Math.abs(inventoryAlignment.header-inventoryAlignment.model)<1,'库存型号表头与正文起点应对齐');
 await rowCycle({name:'库存型号',row:inventory,columns:8,middle:inventory.locator(':scope > td').nth(2),plain:inventory.locator('.model-cell'),detail:inventoryDetail});
 checks.at(-1).textAlignment=inventoryAlignment;
 const allocationHistory=inventoryDetail.locator('.allocation-history[data-batch-key="'+batch.batchKey+'"]');await summaryCycle(allocationHistory,'调拨记录');
 const allocationButton=inventoryDetail.getByRole('button',{name:'调拨',exact:true}).first(),batchRow=allocationButton.locator('xpath=ancestor::tr[1]');
 await batchRow.locator(':scope > td').first().click();assert.equal(await inventoryDetail.locator('.allocation-panel').count(),0);await expanded(inventory,true);
 await allocationButton.click();await inventoryDetail.getByLabel('调拨数量',{exact:true}).fill('20');await inventoryDetail.getByLabel('调拨数量',{exact:true}).press('Space');await expanded(inventory,true);assert.equal(await allocationButton.getAttribute('aria-expanded'),'true');assert.equal(await inventoryDetail.getByLabel('调拨数量',{exact:true}).inputValue(),'20');
 const historyForForm=batchRow.locator('xpath=following-sibling::tr[contains(@class,"allocation-history-row")][1]').locator('summary');await historyForForm.click();await historyForForm.click();assert.equal(await inventoryDetail.getByLabel('调拨数量',{exact:true}).inputValue(),'20');
 check('库存批次整行不打开调拨；仅调拨按钮打开，输入与记录折叠不重置未提交数量');
 await shot('inventory-expansion');

 await nav('business','审批中心');
 const approval=page.locator('.approval-model-group[data-model="SYNTH-TONER-001"]'),approvalRow=approval.locator(':scope > .approval-model-row'),approvalDetail=approval.locator('.approval-model-details');
 await rowCycle({name:'审批型号汇总',row:approvalRow,columns:4,middle:approvalRow.locator(':scope > td').nth(1),plain:approvalRow.locator(':scope > td').first(),detail:approvalDetail});
 const approvalRecord=page.locator('[data-document-key="allocation-'+allocation.id+'"]');await approvalRecord.getByLabel('审核数量',{exact:true}).fill('50');await approvalRecord.getByLabel('审核数量',{exact:true}).press('Space');await expanded(approvalRow,true);await approvalRow.locator(':scope > td').nth(2).click();await expanded(approvalRow,false);await approvalRow.locator(':scope > td').nth(2).click();assert.equal(await approvalRecord.getByLabel('审核数量',{exact:true}).inputValue(),'50');
 const approvalOther=page.locator('.approval-model-group[data-model="SYNTH-INK-001"] > .approval-model-row');await approvalOther.locator(':scope > td').nth(2).click();await expanded(approvalOther,true);await expanded(approvalRow,true);check('审批保持多行展开，明细输入与父行收起重开不丢草稿');await shot('approval-expansion');

 // Both record kinds now use the existing inline document body; the allocation's old self-view region is removed.
 for(const [kind,record]of [['allocation',allocation],['inquiry',blocked]]){
  const card=page.locator('[data-document-key="'+kind+'-'+record.id+'"]'),dataRow=card.locator(':scope > .approval-data-row'),detail=card.locator('#approval-'+kind+'-detail-'+record.id);
  assert.equal(await card.locator('.approval-document-meta').count(),0);
  assert.equal(await card.getByRole('button',{name:'查看调拨',exact:true}).count(),0);
  await expanded(dataRow,false);await dataRow.locator(':scope > td').first().click();await expanded(dataRow,true);
  await detail.getByRole('heading',{name:(kind==='allocation'?'调拨':'询库')+'详情 · '+record.documentNo,exact:true}).waitFor();
  assert.equal(await detail.locator(':scope > td').getAttribute('colspan'),String(await dataRow.locator(':scope > td').count()));
  await detail.locator('dd').first().click();await expanded(dataRow,true);
  if(kind==='allocation'){
   for(const [label,value]of [['发货计划号',record.plan],['发货日期',record.date],['原版本号',record.version]])assert.equal(await detail.locator('.upgrade-fields > div').filter({has:page.locator('dt',{hasText:new RegExp('^'+label+'$')})}).locator('dd').innerText(),value);
   await card.getByLabel('审核数量',{exact:true}).fill('40');await expanded(dataRow,true);
  }
  await dataRow.focus();await page.keyboard.press('Enter');await expanded(dataRow,false);await page.keyboard.press('Space');await expanded(dataRow,true);
  const selected=await dragSelect(dataRow.locator(':scope > td').first());await expanded(dataRow,true);await clearSelection();
  await dataRow.locator(':scope > td').nth(1).click();await expanded(dataRow,false);
  check('审批'+(kind==='allocation'?'待商务调拨':'已完成询库')+'数据行：原详情及编号、鼠标与键盘展开和拖选保护保留，无重复主记录入口',{documentNo:record.documentNo,selected});
 }
 assert.equal(await approvalRecord.getByLabel('审核数量',{exact:true}).inputValue(),'40');await shot('approval-document-row-details');

 // Keep the read query mounted during real approval writes so stale detail-cache regressions are observable.
 const allocationDataRow=approvalRecord.locator(':scope > .approval-data-row'),allocationDetail=approvalRecord.locator('#approval-allocation-detail-'+allocation.id);
 const detailValue=label=>allocationDetail.locator('.upgrade-fields > div').filter({has:page.locator('dt',{hasText:new RegExp('^'+label+'$')})}).locator('dd');
 async function allocationState(status){
  await wait(async()=>{
   assert.equal(await allocationDataRow.getAttribute('aria-expanded'),'true');
   assert.equal(await allocationDataRow.locator('[data-field="商务审核数量"]').innerText(),'40');
   assert.equal(await detailValue('商务审核数量').innerText(),'40');
   assert.equal(await allocationDataRow.locator('.approval-progress').innerText(),status);
   assert.equal(await detailValue('状况').innerText(),status);
   assert.equal(await detailValue('最终执行数量').innerText(),'40');
   assert.equal((await allocationDataRow.locator('[data-field="最终执行数量"]').innerText()).split('\n')[0],'40');
  });
 }
 async function noAllocationActionGap(stage){
  const footprint=await approvalRecord.locator(':scope > .approval-action-row').evaluate(el=>({height:el.getBoundingClientRect().height,text:el.textContent.trim(),fulfillmentCount:el.querySelectorAll('.inquiry-fulfillment').length}));
  assert.equal(footprint.text,'',stage+' 无待办时不应保留操作内容');assert.equal(footprint.fulfillmentCount,0,stage+' 无待办时不应渲染空操作容器');assert(footprint.height<=1,stage+' 不应保留操作空行：'+JSON.stringify(footprint));
  return footprint;
 }
 await allocationDataRow.locator(':scope > td').first().click();await expanded(allocationDataRow,true);
 assert.equal(await detailValue('商务审核数量').innerText(),'—');assert.equal(await detailValue('状况').innerText(),'待商务审核');
 const approvalResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/allocations/'+allocation.id+'/review');
 await approvalRecord.getByRole('button',{name:'批准',exact:true}).click();assert.equal((await approvalResponse).status(),200);
 await allocationState('待助理确认');
 const afterApprovalGap=await noAllocationActionGap('商务批准后');
 assert.equal(db.getDocument(allocation.id).businessReviewedQuantity,40);
 check('调拨详情保持展开时批准：主行和原详情同步显示商务40、最终40及待助理确认；无操作空行',{documentNo:allocation.documentNo,actionRow:afterApprovalGap});

 await nav('assistant-1','审批中心');
 await page.locator('.approval-model-group[data-model="SYNTH-TONER-001"] > .approval-model-row').click();
 await allocationDataRow.locator(':scope > td').first().click();await allocationState('待助理确认');
 await approvalRecord.getByRole('button',{name:'确认全部发出',exact:true}).click();await expanded(allocationDataRow,true);
 const confirmResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/allocations/'+allocation.id+'/confirm');
 await dialog().getByRole('button',{name:'确认全部发出',exact:true}).click();assert.equal((await confirmResponse).status(),200);
 await dialog().waitFor({state:'hidden'});await allocationState('已完成');
 const afterConfirmationGap=await noAllocationActionGap('助理确认后');
 assert.equal(db.getDocument(allocation.id).statusCode,'confirmed');assert.equal(db.getDocument(allocation.id).finalQuantity,40);
 check('调拨详情保持展开时确认实际发出：主行和原详情同步完成及40件；结束后的操作行不占高度',{documentNo:allocation.documentNo,actionRow:afterConfirmationGap});await shot('approval-document-after-confirmation');

 await nav('purchasing','升级库存','在库升级');
 const directRow=page.locator('[data-upgrade-id="'+direct.id+'"]'),directDetail=page.locator('[data-direct-batches="'+direct.id+'"]');
 await rowCycle({name:'在库升级',row:directRow,columns:9,middle:directRow.locator(':scope > td').nth(1),plain:directRow.locator(':scope > td').first(),detail:directDetail});await shot('direct-expanded-details');
 await directRow.getByRole('button',{name:'登记完成',exact:true}).click();await expanded(directRow,true);await dialog().getByLabel('本次完成数量',{exact:true}).fill('3');await close();await directRow.getByRole('button',{name:'登记完成',exact:true}).focus();await page.keyboard.press('Enter');await dialog().waitFor();await expanded(directRow,true);assert.equal(await dialog().getByLabel('本次完成数量',{exact:true}).inputValue(),'3');await close();await directRow.locator(':scope > td').nth(2).click();await expanded(directRow,false);await directRow.getByRole('button',{name:'登记完成',exact:true}).focus();await page.keyboard.press('Space');await dialog().waitFor();await expanded(directRow,false);assert.equal(await dialog().getByLabel('本次完成数量',{exact:true}).inputValue(),'3');await close();check('登记完成鼠标/Enter/Space仅开弹窗，父行状态不切换；关闭和折叠后保留完成草稿');await shot('direct-expansion');

 await nav('purchasing');
 assert.equal(await page.getByRole('button',{name:'查看任务',exact:true}).count(),0);
 const sourceRow=source(recallable.id),details=sourceDetail(recallable.id);
 assert.equal(await sourceRow.getByRole('button',{name:recallable.model,exact:true}).count(),0);assert.equal(await sourceRow.getByRole('link').count(),0);
 await rowCycle({name:'移仓来源',row:sourceRow,columns:12,middle:sourceRow.locator(':scope > td').nth(1),plain:sourceRow.locator(':scope > td').first(),detail:details});
 assert((await details.innerText()).includes('BROWEXPAND1'));await sourceRow.locator(':scope > td').first().click();await expanded(sourceRow,false);assert.equal(await dialog().count(),0);await sourceRow.locator(':scope > td').first().click();await expanded(sourceRow,true);
 const sourceFilterBefore=await page.getByLabel('移仓筛选型号').inputValue();await sourceRow.getByRole('button',{name:'发起移仓升级',exact:true}).click();await expanded(sourceRow,true);await close();assert.equal(await page.getByLabel('移仓筛选型号').inputValue(),sourceFilterBefore);
 check('移仓来源型号为普通文字整行展开，查看任务已移除；ASIN、原始来源资料保留，展开不变任务筛选，发起按钮不触发行切换');await shot('relocation-source-expanded');
 const sourceLayouts=[];
 for(const width of [1366,1440]){
  await page.setViewportSize({width,height:1000});
  for(const side of ['left','right']){
   await details.evaluate((el,side)=>{const wrap=el.closest('.table-wrap');wrap.scrollLeft=side==='right'?wrap.scrollWidth:0;},side);
   const layout=await details.evaluate(el=>{const rect=el.closest('.table-wrap').getBoundingClientRect();return {viewport:{left:rect.left,right:rect.right},scrollLeft:el.closest('.table-wrap').scrollLeft,fields:[...el.querySelectorAll('dd,button')].map(field=>{const r=field.getBoundingClientRect();return {text:field.textContent,left:r.left,right:r.right,ellipsis:getComputedStyle(field).textOverflow};})};});
   assert(layout.fields.every(field=>field.left>=layout.viewport.left-1&&field.right<=layout.viewport.right+1),JSON.stringify(layout));assert(layout.fields.every(field=>field.ellipsis!=='ellipsis'));assert(layout.fields.some(field=>field.text==='BROWEXPAND1'));assert(layout.fields.some(field=>field.text==='回撤至待采购回复'));
   sourceLayouts.push({width,side,...layout});await shot('relocation-source-'+width+'-'+side,false);
  }
 }
 check('1366/1440来源表横滚至两端，原位详情全部字段及回撤按钮均保持在可视范围，未截断',{layouts:sourceLayouts});

 const workRow=task(relocation.id),workDetail=page.locator('[data-relocation-detail="'+relocation.id+'"]');
 await rowCycle({name:'移仓任务',row:workRow,columns:22,middle:workRow.locator(':scope > td').nth(2),plain:workRow.locator(':scope > td').first(),detail:workDetail});
 await summaryCycle(workDetail.locator('.relocation-external-history'),'领星包裹采纳明细');await expanded(workRow,true);await shot('relocation-expanded-details');
 await workRow.getByRole('button',{name:'更新升级数量',exact:true}).click();await expanded(workRow,true);await dialog().getByLabel('累计升级完成数量',{exact:true}).fill('4');await close();await workRow.locator(':scope > td').nth(3).click();await workRow.getByRole('button',{name:'更新升级数量',exact:true}).click();await expanded(workRow,false);assert.equal(await dialog().getByLabel('累计升级完成数量',{exact:true}).inputValue(),'0');assert.equal(db.getRelocationWorkItem(relocation.id).shippedQuantity,20);await close();check('更新升级数量独立于整行展开；显式重开按原行为读取当前累计量，未提交不落库');await shot('relocation-task-expanded');
 await nav('operation-1');const orderRow=task(operation.id);await orderRow.getByRole('button',{name:'填写移仓订单号',exact:true}).click();await expanded(orderRow,false);await dialog().getByLabel('移仓订单号').fill('DRAFT-ONLY');await close();await orderRow.locator(':scope > td').nth(3).click();await expanded(orderRow,true);await orderRow.getByRole('button',{name:'填写移仓订单号',exact:true}).click();await expanded(orderRow,true);assert.equal(await dialog().getByLabel('移仓订单号').inputValue(),'DRAFT-ONLY');await close();assert.equal(db.getRelocationWorkItem(operation.id).removalOrderNo,operation.removalOrderNo);check('填写订单号独立弹窗，原任务草稿不丢且未提交未落库');

 await nav('logistics','升级库存','转仓升级');const transferRow=page.locator('[data-transfer-id="'+transfer.id+'"]'),transferDetail=page.locator('[data-transfer-detail="'+transfer.id+'"]');
 await rowCycle({name:'转仓升级',row:transferRow,columns:15,middle:transferRow.locator(':scope > td').nth(4),plain:transferRow.locator(':scope > td').first(),detail:transferDetail});
 const secondTransfer=page.locator('[data-transfer-id]').filter({hasText:transferSample[0]}).nth(1);if(await secondTransfer.getAttribute('data-transfer-id')!==String(transfer.id)){await secondTransfer.locator(':scope > td').first().click();await expanded(secondTransfer,true);await expanded(transferRow,true);}await page.getByRole('button',{name:'刷新',exact:true}).last().click();await expanded(transferRow,true);check('转仓多行展开与正常刷新保持展开状态，有数据详情内数量和业务值完整');await shot('transfer-expansion');

 const roleVisibility=[];for(const role of ROLES){await nav(role);const row=source(recallable.id);const visible=await row.count();roleVisibility.push({role,sourceVisible:!!visible,recallExpected:!!visible&&['purchasing','logistics','business'].includes(role)});if(!visible)continue;if(await row.getAttribute('aria-expanded')!=='true')await row.locator(':scope > td').first().click();const detail=sourceDetail(recallable.id);assert.equal(await detail.getByRole('button',{name:/回撤至/}).count(),['purchasing','logistics','business'].includes(role)?1:0);assert.equal(await task(blockedWork.id).getByRole('button',{name:'更新升级数量',exact:true}).count(),0);assert.equal(await source(blocked.id).getByRole('button',{name:'发起移仓升级',exact:true}).count(),0);}
 check('九角色按原团队范围显示来源，扩大点击区未授予回撤或升级权限，同来源待处理限制保留',{roles:roleVisibility});
 await nav('logistics');if(await source(blocked.id).getAttribute('aria-expanded')!=='true')await source(blocked.id).locator(':scope > td').first().click();const blockedDetail=sourceDetail(blocked.id),blockedButton=blockedDetail.getByRole('button',{name:'回撤至待采购回复',exact:true});assert(await blockedButton.isDisabled());assert((await blockedDetail.innerText()).includes('无法回撤：'));assert((await blockedDetail.innerText()).includes('000-BLOCKED'));assert(await blockedButton.evaluate(el=>{el.focus();return document.activeElement!==el;}));await expanded(source(blocked.id),true);assert.equal(db.getInquiry(blocked.id).status,'archived');check('询库下游占用在原位详情保留阻止原因和业务定位信息，禁止按钮与键盘不办理');await shot('recall-blocked');

 // Reject once to verify an inline error remains visible, then lose a real committed response.
 if(await source(recallable.id).getAttribute('aria-expanded')!=='true')await source(recallable.id).locator(':scope > td').first().click();
 const recallUrl='**/api/inquiries/'+recallable.id+'/recall';await page.route(recallUrl,route=>route.fulfill({status:409,json:{ok:false,error:'隔离回撤拒绝：记录已更新',code:'revision_conflict'}}));
 await sourceDetail(recallable.id).getByRole('button',{name:'回撤至待采购回复',exact:true}).click();await page.getByRole('alert').filter({hasText:'隔离回撤拒绝：记录已更新'}).waitFor();await expanded(source(recallable.id),true);assert.equal(db.getInquiry(recallable.id).status,'archived');await page.unroute(recallUrl);check('原位回撤失败反馈保留且不折叠、不写业务');
 const sent=[];let lose=true;await page.route(recallUrl,async route=>{sent.push(route.request().postDataJSON());const response=await route.fetch();assert.equal(response.status(),200);if(lose){lose=false;return route.abort('failed');}return route.fulfill({response});});
 await sourceDetail(recallable.id).getByRole('button',{name:'回撤至待采购回复',exact:true}).click();await page.getByRole('button',{name:/^重试确认$/}).first().waitFor();assert.equal(db.getInquiry(recallable.id).status,'pending_purchasing');
 if(await source(recallable.id).count()&&await source(recallable.id).isVisible()&&await source(recallable.id).getAttribute('aria-expanded')==='true')await source(recallable.id).locator(':scope > td').first().click();
 await page.getByLabel('来源型号').selectOption('SYNTH-TONER-001');await page.getByRole('tab',{name:'转仓升级',exact:true}).click();await page.getByRole('tab',{name:'移仓升级',exact:true}).click();
 const retry=page.getByRole('button',{name:'重试确认',exact:true});await retry.first().click();await wait(()=>assert.equal(sent.length,2));await wait(async()=>assert((await page.locator('.notice-text').innerText()).includes('询库已回撤')));assert.deepEqual(sent[0],sent[1]);assert.equal(db.getInquiry(recallable.id).events.filter(e=>e.type==='recall').length,1);await page.unroute(recallUrl);check('询库回撤回执丢失后原位详情收起/来源消失、筛选隐藏和跨板块后仍确认原请求，仅回撤一次',{requests:sent.length});await shot('recall-confirmed');
 assert.equal(db.db.prepare('SELECT COUNT(*) n FROM lingxing_sync_jobs').get().n,0);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM relocation_waybill_exports').get().n,0);db.assertInventoryInvariants();assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.deepEqual(errors,[]);check('无真实领星、无运单导出状态写入，库存不变量/外键和浏览器错误检查通过');
}catch(error){failure=error;console.error(error);if(page)await shot('failure').catch(()=>{});}
finally{await browser?.close();db.close();if(child?.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}await fs.writeFile(path.join(out,'result.json'),JSON.stringify({state,base,checks,screenshots,errors,requests,exitCode:failure?1:0,failure:failure?.stack,productionWrites:0,realLingxing:false},null,2));}
if(failure)process.exitCode=1;
