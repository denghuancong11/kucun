// Targeted, no-network checks for approved spreadsheet copy and unchanged callers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const requireWeb=createRequire(path.join(root,'web','package.json'));
const ts=requireWeb('typescript'),React=requireWeb('react');
const {renderToStaticMarkup}=requireWeb('react-dom/server');
const at=relative=>path.join(root,relative);
function load(entry,mocks={},globals={},extra={}){
 const cache=new Map();
 function visit(file){
  const relative=path.relative(root,file).replaceAll('\\','/');
  if(Object.hasOwn(mocks,relative))return mocks[relative];
  if(cache.has(file))return cache.get(file).exports;
  const module={exports:{}};cache.set(file,module);
  const source=fs.readFileSync(file,'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const localRequire=specifier=>{
   if(Object.hasOwn(mocks,specifier))return mocks[specifier];
   if(!specifier.startsWith('.'))return requireWeb(specifier);
   const start=path.resolve(path.dirname(file),specifier);
   const found=[start,start+'.ts',start+'.tsx',start+'.js'].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
   assert(found,`${relative}: ${specifier}`);return visit(found);
  };
  vm.runInNewContext(code+'\n'+(extra[relative]??''),{module,exports:module.exports,require:localRequire,console,Error,crypto:webcrypto,URL,URLSearchParams,AbortSignal,setTimeout,clearTimeout,...globals},{filename:file});
  return module.exports;
 }
 return visit(at(entry));
}
const noAction={perform:async()=>{},busy:false,uncertain:false,error:null,setError:()=>{},disabled:false};
const passiveReact={...React,useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useRef:initial=>({current:initial}),useEffect:()=>{},useMemo:fn=>fn(),useCallback:fn=>fn};
const apiStub=new Proxy({formatNumber:n=>Number(n).toLocaleString('zh-CN')},{get:(object,key)=>object[key]??(()=>Promise.resolve({ok:true}))});
const checks=[];

const pending=load('web/src/components/PendingBusinessRequests.tsx',{'web/src/api.ts':apiStub},{},{'web/src/components/PendingBusinessRequests.tsx':'exports.describeForCheck=describe;'});
const pendingCases=[
 ['/api/transfer-upgrades/update/import?stage=rma','转仓升级 RMA 更新'],
 ['/api/transfer-upgrades/update/import?stage=count','转仓升级实际清点数量更新'],
 ['/api/transfer-upgrades/update/import?stage=progress','转仓升级进度更新'],
 ['/api/approvals/inquiries/clear','隐藏已完成或已拒绝的询库'],
 ['/api/inquiries/1/alan-review','询库 Alan 审核'],
 ['/api/allocations/2/alan-review','调拨 Alan 审核'],
 ['/api/allocations/2/reply','提交调拨供应商库存回复'],
 ['/api/upgrades/relocation-work-items/3/procurement','保存移仓 RMA 与地址'],
 ['/api/upgrades/relocation-work-items/3/operation','保存移仓订单号'],
 // Explicitly retained decisions and pre-existing unrelated recovery entries.
 ['/api/inquiries/1/reply','询库采购回复'],
 ['/api/allocations/2/archive','调拨采购归档'],
 ['/api/upgrades/relocation-waybills/confirm','运单文件已下载。'],
 ['/api/transfer-upgrades/update/import','转仓升级办理'],
];
for(const [url,label] of pendingCases){
 assert.equal(pending.describeForCheck({url,body:JSON.stringify({quantity:23}),context:'SYNTHETIC-CONTEXT'}),url==='/api/upgrades/relocation-waybills/confirm'?label:`${label} · SYNTHETIC-CONTEXT · 数量 23`);
}
checks.push('FW-001—007/010/011 recovery names; FW-008/009 and other recovery entries retained');

for(const role of ['admin','assistant-1','assistant-2','purchasing','logistics']){
 for(const url of ['/api/upgrades/relocation-waybills/confirm','/api/inquiries/1/reply']){
  const record={url,role,body:JSON.stringify({requestId:'SYNTH-ORIGINAL-REQUEST',exportToken:'SYNTH-TOKEN',quantity:23}),requestId:'SYNTH-ORIGINAL-REQUEST',databaseId:'synthetic-db',context:'SYNTHETIC-CONTEXT'};
  const values=[[record.requestId],[record],[],'synthetic-db',null,''];let cursor=0;const calls=[];
  const react={...passiveReact,useState:()=>{const index=cursor++;return [values[index],next=>{values[index]=next;}];}};
  const view=load('web/src/components/PendingBusinessRequests.tsx',{'react':react,'web/src/api.ts':{...apiStub,confirmPendingBusinessRequest:async input=>{calls.push(input);}}});
  const element=view.PendingBusinessRequests({role}),button=findElement(element,'button');assert(button&&!button.props.disabled);
  const before=renderToStaticMarkup(element);assert(before.includes('有提交尚未确认'));assert(before.includes('确认本次提交'));
  if(url.endsWith('/relocation-waybills/confirm'))assert(before.includes('<span>运单文件已下载。</span>'));
  button.props.onClick();await Promise.resolve();await Promise.resolve();await Promise.resolve();
  assert.equal(calls.length,1);assert.equal(calls[0],record);assert.equal(calls[0].body,record.body);
  const expected=url.endsWith('/relocation-waybills/confirm')?'运单文件已下载。':'询库采购回复 · SYNTHETIC-CONTEXT · 数量 23：原提交结果已确认。';
  assert.equal(values[5],expected);
  values[1]=[];cursor=0;const after=renderToStaticMarkup(view.PendingBusinessRequests({role}));assert(after.includes('<p role="status">'+expected+'</p>'));
  if(url.endsWith('/relocation-waybills/confirm'))assert(!after.includes('原提交结果已确认'));
  values[1]=[record];values[3]='different-db';cursor=0;assert.equal(findElement(view.PendingBusinessRequests({role}),'button').props.disabled,true);
 }
}
checks.push('A014 all five export roles: pending and successful waybill confirmation show only approved sentence; other operations retain context/quantity/success suffix; same request and database guard retained');

let state=[],effects=[];
const memory=new Map();let rejectSet=false;
const storage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>{if(rejectSet)throw new Error('synthetic storage failure');memory.set(key,value);}};
const hookReact={useRef:initial=>({current:initial}),useCallback:fn=>fn,useState:initial=>{const index=state.length;state.push(initial);return [initial,value=>{state[index]=value;}];},useEffect:fn=>effects.push(fn)};
const hook=load('web/src/hooks/useSessionDraft.ts',{'react':hookReact,'web/src/api.ts':{fetchSync:async()=>({databaseId:'synthetic-db'})}},{sessionStorage:storage});
for(const [name,message] of [['old-form','未保存内容无法恢复，请重新核对并填写。'],['transit','无法恢复在途导入或物流更新内容，请确认提交结果并重核上传文件'],['transfer','无法恢复未保存转仓更新内容，请确认提交结果并重核上传文件']]){
 state=[];effects=[];memory.set(`aster-draft:purchasing:${name}`,'{bad-json');
 const args=['purchasing',name,null];if(name!=='old-form')args.push(message);
 hook.useSessionDraft(...args);effects.forEach(fn=>fn());
 await Promise.resolve();await Promise.resolve();await Promise.resolve();
 assert.equal(state[2],message);
}
state=[];effects=[];memory.clear();
const [, ,draftCache]=hook.useSessionDraft('purchasing','rollback',null,'synthetic approved recovery');
effects.forEach(fn=>fn());await Promise.resolve();await Promise.resolve();await Promise.resolve();
const restore=draftCache.persist({test:'new'});rejectSet=true;restore();rejectSet=false;
assert.equal(state[2],'synthetic approved recovery');
checks.push('Draft recovery read and rollback use caller copy; original three-argument form unchanged');

// A011 changes only initialization failure wording, not draft provenance or storage behavior.
let syncReadCount=0,storageReadCount=0,storageWriteCount=0;
const failedHook=load('web/src/hooks/useSessionDraft.ts',{'react':hookReact,'web/src/api.ts':{fetchSync:async()=>{syncReadCount++;throw new Error('synthetic disconnected');}}},{sessionStorage:{getItem:()=>{storageReadCount++;return null;},setItem:()=>{storageWriteCount++;}}});
state=[];effects=[];
failedHook.useSessionDraft('operation-1','A011-offline',{quantity:'20'},'caller JSON recovery copy');
effects.forEach(fn=>fn());await new Promise(resolve=>setImmediate(resolve));
assert.equal(state[2],'暂存内容尚未恢复，请恢复连接后刷新页面。');
assert.equal(state[1],true);assert.deepEqual(state[0],{quantity:'20'});
assert.equal(syncReadCount,1);assert.equal(storageReadCount,0);assert.equal(storageWriteCount,0);
for(const sameDatabase of [true,false]){
 state=[];effects=[];memory.clear();
 memory.set('aster-draft:operation-1:A011-provenance',JSON.stringify({databaseId:sameDatabase?'synthetic-db':'other-db',value:{quantity:'30'}}));
 hook.useSessionDraft('operation-1','A011-provenance',{quantity:'20'});effects.forEach(fn=>fn());await new Promise(resolve=>setImmediate(resolve));
 assert.equal(JSON.stringify(state[0]),JSON.stringify({quantity:sameDatabase?'30':'20'}));assert.equal(state[2],null);
}
state=[];effects=[];memory.clear();
const [,setDraftA011]=hook.useSessionDraft('operation-1','A011-write-error',{quantity:'20'});effects.forEach(fn=>fn());await new Promise(resolve=>setImmediate(resolve));
rejectSet=true;setDraftA011({quantity:'40'});rejectSet=false;
assert.equal(state[2],'未保存内容无法暂存，请保持当前页面，完成后再切页或刷新。');
checks.push('A011 initialization failure copy; no draft read/write on failed database check; same-database restoration, cross-database isolation and write-failure wording retained');

const base={id:1,model:'SYNTH-MODEL',category:'硒鼓',store:'SYNTHUS',department:'一团',operator:'合成运营',asin:'BSYNTH0001',fnsku:'SYNTH-FNSKU',events:[],documentNo:'ALLOC-SYNTH',createdAt:'2026-10-16T00:00:00Z',originalRequestedQuantity:30,businessReviewedQuantity:20,statusCode:'pending',approvalStatus:'approved',tonerConversionStatus:'pending_confirmation',finalQuantity:null,supplierQuantity:null,packPerBox:'10'};
const approvalMocks={
 'web/src/api.ts':apiStub,
 'web/src/hooks/useApprovals.ts':{useApprovals:()=>({data:{allocations:[base],inquiries:[],sync:{databaseId:'synthetic-db'}},refresh:async()=>{},isLoading:false,isError:false})},
 'web/src/hooks/useInventory.ts':{useInventoryCatalog:()=>({data:{models:[{model:base.model,inStock:100}]}})},
 'web/src/hooks/usePermissions.ts':{useEffectivePermissions:()=>({data:{permissions:{硒鼓:{actions:true},墨盒:{actions:true}}}})},
 'web/src/hooks/useBusinessAction.ts':{useBusinessAction:()=>noAction},
 'web/src/hooks/useSessionDraft.ts':{useSessionDraft:(_role,_name,initial)=>[initial,()=>{},{ready:true,storageError:null,persist:()=>()=>{}}]},
 'web/src/components/LingxingSync.tsx':{LingxingSync:()=>null},
 'web/src/components/ApprovalDocumentDetails.tsx':{ApprovalDocumentButton:()=>null,ApprovalDocumentInline:()=>null},
};
for(const role of ['operation-1','operation-2','business']){
 const view=load('web/src/views/ApprovalCenter.tsx',{...approvalMocks,react:passiveReact});
 const html=renderToStaticMarkup(React.createElement(view.ApprovalCenterView,{role}));
 assert(!html.includes('硒鼓业务安排：'));
 assert(html.includes('<th>商务审核数量</th>')&&html.includes('<th>商务备注</th>'));
 assert(html.includes('转询库数量：20 件，待运营确认；原调拨预锁定已全部释放。'));
 assert(role==='business'?html.includes('我的待办'):html.includes('>处理中 '));
}
for(const [count,expected] of [[0,'暂无处理中的记录'],[1,'当前筛选下没有处理中的记录']]){
 let calls=0;
 const react={...passiveReact,useState:initial=>{const index=calls++;return [index===3?'mine':index===5&&count===1?'NO-MATCH':typeof initial==='function'?initial():initial,()=>{}];}};
 const row=count?base:null;
 const useApprovals=()=>({data:{allocations:row?[row]:[],inquiries:[],sync:{databaseId:'synthetic-db'}},refresh:async()=>{},isLoading:false,isError:false});
 const view=load('web/src/views/ApprovalCenter.tsx',{...approvalMocks,'react':react,'web/src/hooks/useApprovals.ts':{useApprovals}});
 const html=renderToStaticMarkup(React.createElement(view.ApprovalCenterView,{role:'operation-1'}));
 assert(html.includes(expected),expected);
}
checks.push('SP-005/006/007/016/020 controlled render, both operation roles; other-role label retained');

const sourceInfo={warehouse:'合成来源仓',shippingMethod:'合成发货方式',origin:'current_batch'};
const sourceView=load('web/src/components/AllocationSourceBatch.tsx');
for(const origin of ['snapshot','current_batch','unrecorded']){
 const html=renderToStaticMarkup(React.createElement(sourceView.AllocationSourceBatch,{info:{...sourceInfo,origin}}));
 assert(!html.includes('当前批次信息（非提交快照）'));
 assert.equal(html.includes('<small class="approval-final-source">当前批次</small>'),origin==='current_batch');
 if(origin==='unrecorded')assert.equal(html,'未记录');
 else for(const text of [sourceInfo.warehouse,sourceInfo.shippingMethod])assert(html.includes(text));
}
for(const category of ['硒鼓','墨盒']){
 const row={...base,category,batchKey:'SYNTHETIC-INTERNAL-BATCH-KEY',plan:'SYNTHETIC-PLAN',date:'2026-10-20',version:'SYNTHETIC-V1',sourceBatchInfo:sourceInfo,
  approvalStatus:'pending',businessReviewedQuantity:null,tonerConversionStatus:null,lockedQuantity:10,issuedQuantity:0,
  ...(category==='墨盒'?{workflowMode:'ink-v2',inkWorkflowStage:'pending_business'}:{})};
 const approvals=load('web/src/views/ApprovalCenter.tsx',{...approvalMocks,react:passiveReact,'web/src/hooks/useApprovals.ts':{useApprovals:()=>({data:{allocations:[row],inquiries:[],sync:{databaseId:'synthetic-db'}},refresh:async()=>{},isLoading:false,isError:false})}});
 const list=renderToStaticMarkup(React.createElement(approvals.ApprovalCenterView,{role:'business'}));
 assert(list.includes('来源批次：'+[row.plan,row.date,row.version].join(' · ')));
 assert(!list.includes('批次标识：')&&!list.includes(row.batchKey));
 assert(list.includes(sourceInfo.warehouse)&&list.includes(sourceInfo.shippingMethod));
 const detail=load('web/src/components/ApprovalDocumentDetails.tsx',{'react':passiveReact,'@tanstack/react-query':{useQuery:()=>({data:{document:row,events:[]},isLoading:false,isError:false})},'web/src/api.ts':apiStub});
 for(const role of ['admin','assistant-1','assistant-2','operation-1','operation-2','business','purchasing','logistics','alan']){
  const html=renderToStaticMarkup(React.createElement(detail.ApprovalDocumentInline,{role,reference:{kind:'allocation',id:row.id}}));
  assert(!html.includes('<dt>来源批次</dt>')&&!html.includes(row.batchKey));
  for(const text of ['发货计划号',row.plan,'发货日期',row.date,'原版本号',row.version,'发货方式-所属海外仓',sourceInfo.warehouse,sourceInfo.shippingMethod])assert(html.includes(text),text);
  assert(html.includes('<small class="approval-final-source">当前批次</small>'));
 }
}
checks.push('A001/A002 shared source marker keeps origin conditions; both categories keep business source fields while removing internal key in business row and all-role shared details');

const forceOpenReact={...passiveReact,useState:initial=>[initial===false?true:initial,()=>{}]};
const fulfillment=load('web/src/components/InquiryFulfillment.tsx',{'react':forceOpenReact,'web/src/api.ts':apiStub,'web/src/hooks/useBusinessAction.ts':{useBusinessAction:()=>noAction}});
const draft={value:{plan:'SYNTH',date:'2026-10-16',version:'V1',warehouse:'CA'},ready:true,update:()=>{},prepare:fn=>fn};
for(const [category,title] of [['墨盒','保存'],['硒鼓','确认']]){
 for(const role of ['purchasing','logistics']){
  const html=renderToStaticMarkup(React.createElement(fulfillment.InquiryFulfillment,{row:{...base,category,status:'pending_assistant'},role,draft,onRefresh:async()=>{},onNotice:()=>{}}));
  if(category==='硒鼓'&&role==='logistics'){assert.equal(html,'');continue;}
  assert(html.includes(`<h3>${title}</h3>`));
  assert(html.includes('<span>发货时间</span>'));
  assert(html.includes(category==='墨盒'?'提交采购归档':'确认全部发出并归档'));
 }
}
let success;
const replyModule=load('web/src/components/InquiryFulfillment.tsx',{'react':passiveReact,'web/src/api.ts':apiStub,'web/src/hooks/useBusinessAction.ts':{useBusinessAction:()=>({...noAction,perform:action=>{success=action.message;}})}});
function findElement(node,type){if(!node||typeof node!=='object')return null;if(node.type===type)return node;for(const item of [node.props?.children].flat(Infinity)){const found=findElement(item,type);if(found)return found;}return null;}
for(const kind of ['allocation','inquiry']){
 for(const quantity of ['0','20']){
  success=undefined;
  const element=replyModule.ApprovalProcurementCells({kind,row:{...base,category:'墨盒',tonerConversionStatus:null,procurementStatus:'pending_alan',status:'pending_alan'},quantity,onQuantityChange:()=>{},role:'purchasing',draft,onRefresh:async()=>{},onNotice:()=>{}});
  const form=findElement(element,'form');assert(form);
  const html=renderToStaticMarkup(element);assert(html.includes('提交后将跳过 Alan 审核，本次不记录 Alan 审核数量和备注。'));
  form.props.onSubmit({preventDefault:()=>{}});
  assert.equal(success,quantity==='0'?'已保存':`${base.model} · ${base.store}：已保存供应商库存回复 20 件。`);
 }
}
checks.push('A003 ink archive title 保存; SP-009 toner title and both action buttons unchanged; SP-010/011 date labels retained; SP-013/014/015 exact success and skip copy');

const readonly=()=>{throw new Error('Component copy checks must not invoke business operations');};
const stockView=load('web/src/components/ModelDetailSection.tsx',{
 'react':passiveReact,'web/src/api.ts':apiStub,
 'web/src/hooks/useBusinessAction.ts':{useBusinessAction:()=>noAction},
 'web/src/components/ApprovalDocumentDetails.tsx':{ApprovalDocumentButton:()=>null},
 'web/src/components/AllocationPanel.tsx':{AllocationPanel:()=>null},
 'web/src/components/InquiryEntry.tsx':{InquiryEntry:()=>null},
});
for(const category of ['硒鼓','墨盒']){
 for(const role of ['admin','assistant-1','assistant-2','operation-1','operation-2','business','purchasing','logistics','alan']){
  for(const detail of [false,true]){
   const stock={batchKey:'A004-SYNTH',baseQuantity:100,quantity:100,locked:30,available:70,packPerBox:'10',plan:'A004-PLAN',date:'2026-10-20',version:'A004-V1',fnsku:'A004-FNSKU',warehouse:'SyntheticWarehouseA',revision:1};
   const props={model:{model:'A004-MODEL',category,inStock:100,inTransit:0,locked:30,available:70},stockRows:[stock],transitRows:[],role,
    perm:{summary:true,detail,expand:true,actions:true},permLoading:false,alloc:{totals:{},publicRecords:{}},allocBusy:false,activeBatchKey:null,
    onSelectBatchKey:readonly,tab:'stock',onTabChange:readonly,onEntry:readonly,onShelf:readonly,onShelfRefresh:readonly,onAllocationRefresh:readonly,onNotice:readonly};
   const html=renderToStaticMarkup(React.createElement(stockView.ModelDetailSection,props));
   assert(html.includes('<th class="num">预锁定</th>'));
   assert(html.includes('<td class="num strong">100</td><td class="num">30</td><td class="num">70</td>'));
   assert(!html.includes('预锁定 30')&&!html.includes('badge badge-blue'));
   assert.equal(html.includes('class="alloc-toggle'),['admin','operation-1','operation-2'].includes(role));
   assert.equal(html.includes('A004-PLAN'),detail);
  }
 }
}
checks.push('A004 both categories/all roles: remove only stock action-cell duplicate badge; quantity columns, detail scope and allocation-button role scope retained');

const transitView=load('web/src/views/Requirement3.tsx',{
 'react':passiveReact,'web/src/api.ts':apiStub,
 '@tanstack/react-query':{useQueryClient:()=>({invalidateQueries:readonly})},
 'web/src/hooks/useSessionDraft.ts':{useSessionDraft:(_role,_key,initial)=>[initial,readonly,{ready:true,storageError:null}]},
});
for(const role of ['admin','assistant-1','assistant-2','operation-1','operation-2','business','purchasing','logistics','alan']){
 const html=renderToStaticMarkup(React.createElement(transitView.Requirement3View,{role}));
 const access=['admin','assistant-1','assistant-2','purchasing','logistics'].includes(role);
 assert.equal(html.includes('暂无导入或物流更新预览'),access);
 assert.equal(html.includes('无法导入在途库存'),role==='alan');
 assert(!html.includes('未导入在途库存表格'));
 if(access)for(const text of ['导入在途表格','导入物流状态更新表'])assert(html.includes(text));
 else if(role!=='alan')assert.equal(html,'');
}
checks.push('A005 no-preview copy matches current import/update state for five authorized roles; Alan and unauthorized-role branches unchanged');

function allocationMarkup({category,role,packPerBox,quantity='10',totals={onHand:100,locked:30,available:70}}){
 let stateIndex=0;
 const touchedReact={...passiveReact,useState:initial=>[stateIndex++===0?true:typeof initial==='function'?initial():initial,()=>{}]};
 const panel=load('web/src/components/AllocationPanel.tsx',{
  'react':touchedReact,'web/src/api.ts':apiStub,
  'web/src/hooks/useBusinessAction.ts':{useBusinessAction:()=>noAction},
  'web/src/hooks/useSessionDraft.ts':{useSessionDraft:()=>[{quantity,department:'一团',store:'COPYUS',operator:'COPY-USER',fnsku:'COPY-FNSKU',asin:'BCOPY00001',note:''},readonly,{ready:true,storageError:null,persist:readonly}]},
 });
 return renderToStaticMarkup(React.createElement(panel.AllocationPanel,{batch:{key:'A006-SYNTH',model:'A006-MODEL',category,quantity:100,plan:'A006-PLAN',date:'2026-10-20',version:'V1',fnsku:'COPY-SOURCE',packPerBox},totals,role,actionsAllowed:true,busy:false,onEntry:readonly,onRefresh:readonly}));
}
for(const category of ['硒鼓','墨盒']){
 for(const role of ['admin','operation-1','operation-2']){
  for(const packPerBox of [undefined,null,'','0','-1','1.5','abc']){
   const html=allocationMarkup({category,role,packPerBox});
   assert(html.includes('该批次的套/箱须为正整数，核对后才能提交调拨。'));
   assert(html.includes('<button class="btn btn-primary" type="submit" disabled="">提交调拨并预锁定</button>'));
   for(const text of ['在库 <strong>100</strong>','预锁定 <strong>30</strong>','可用 <strong>70</strong>'])assert(html.includes(text));
  }
  for(const [quantity,expected] of [['0','调拨数量请填写大于 0 的整数。'],['1.5','调拨数量请填写大于 0 的整数。'],['15','当前批次套/箱为 10，调拨数量须为 10 的整数倍。'],['80','超出可用库存（当前可用 70）。']])assert(allocationMarkup({category,role,packPerBox:'10',quantity}).includes(expected));
  const ordinary=allocationMarkup({category,role,packPerBox:'10'});assert(!ordinary.includes('field-error'));assert(ordinary.includes('max="70"'));
  const zero=allocationMarkup({category,role,packPerBox:'10',quantity:'80',totals:{onHand:100,locked:100,available:0}});assert(!zero.includes('field-error'));assert(zero.includes('max="100"'));
  assert(allocationMarkup({category,role,packPerBox:'10',quantity:'110',totals:{onHand:100,locked:100,available:0}}).includes('调拨需求不能超过该批次当前在库（100 件）。'));
 }
}
checks.push('A006 both categories/all allocation roles: approved missing-pack wording; disabled submit and original integer/whole-box/live-capacity/13.1 rules retained; no default pack');

const api=load('web/src/api.ts',{}, {fetch:async()=>{throw new Error('synthetic network reason');}});
await assert.rejects(api.downloadInquiryExport('purchasing',{}),{message:'synthetic network reason'});
const nonErrorExport=load('web/src/api.ts',{}, {fetch:async()=>{throw 'synthetic non-Error';}});
await assert.rejects(nonErrorExport.downloadInquiryExport('purchasing',{}),{message:'请检查网络后重试'});
const failedExport=load('web/src/api.ts',{}, {fetch:async()=>({ok:false,status:500,json:async()=>({ok:false,error:'隔离导出读取失败'})})});
await assert.rejects(failedExport.downloadInquiryExport('purchasing',{}),{message:'隔离导出读取失败'});
const feedbackValues=['idle',''];let feedbackCursor=0;
const feedbackReact={...passiveReact,useState:()=>{const index=feedbackCursor++;return [feedbackValues[index],next=>{feedbackValues[index]=next;}];}};
const feedback=load('web/src/components/ui.tsx',{'react':feedbackReact,'web/src/api.ts':apiStub});
findElement(feedback.FeedbackButton({label:'导出询库',pendingLabel:'正在导出…',doneLabel:'导出完成',onAction:()=>failedExport.downloadInquiryExport('purchasing',{})}),'button').props.onClick();
for(let i=0;i<8;i++)await Promise.resolve();
assert.equal(feedbackValues[1],'导出询库失败：隔离导出读取失败');
checks.push('A015 Error reason/non-Error fallback retained; shared feedback adds one export-failure prefix only');
const waybillApi=load('web/src/api.ts',{}, {fetch:async()=>({ok:true,headers:{get:()=>null}})});
await assert.rejects(waybillApi.downloadRelocationWaybills('logistics',{}),{message:'未能确认移仓运单文件，导出状态未更新，请重新导出。'});
checks.push('FW-032/033 keep actual error reason and export state boundaries');

const auditSource=fs.readFileSync(at('web/src/views/AuditLog.tsx'),'utf8');
assert(auditSource.includes('label: "5 小时到期，采用商务审核数量"'));
assert(!auditSource.includes('{queryDone && <p'));
assert(auditSource.includes('queryDone?"查询完成":"查询"'));
assert(auditSource.includes('已显示 {records.length} 条。'));
checks.push('SP-017 repeated paragraph removed, query-button/record count retained; SP-018 label scoped to audit view');

const output=process.env.ASTER_ACCEPTANCE_OUTPUT?path.resolve(process.env.ASTER_ACCEPTANCE_OUTPUT):at('.test-output/copy-sheet-root-check');fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,checks},null,2));
console.log(`PASS approved copy root checks (${checks.length} groups)`);
