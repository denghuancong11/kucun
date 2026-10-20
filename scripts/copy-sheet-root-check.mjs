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
 ['/api/upgrades/relocation-waybills/confirm','运单文件已下载，待确认导出状态'],
 ['/api/transfer-upgrades/update/import','转仓升级办理'],
];
for(const [url,label] of pendingCases){
 assert.equal(pending.describeForCheck({url,body:JSON.stringify({quantity:23}),context:'SYNTHETIC-CONTEXT'}),`${label} · SYNTHETIC-CONTEXT · 数量 23`);
}
checks.push('FW-001—007/010/011 recovery names; FW-008/009 and other recovery entries retained');

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

const base={id:1,model:'SYNTH-MODEL',category:'硒鼓',store:'SYNTHUS',department:'一团',operator:'合成运营',asin:'BSYNTH0001',fnsku:'SYNTH-FNSKU',events:[],documentNo:'ALLOC-SYNTH',createdAt:'2026-10-16T00:00:00Z',originalRequestedQuantity:30,businessReviewedQuantity:20,statusCode:'pending',approvalStatus:'approved',tonerConversionStatus:'pending_confirmation',finalQuantity:null,supplierQuantity:null,packPerBox:'10'};
const approvalMocks={
 'web/src/api.ts':apiStub,
 'web/src/hooks/useApprovals.ts':{useApprovals:()=>({data:{allocations:[base],inquiries:[]},refresh:async()=>{},isLoading:false,isError:false})},
 'web/src/hooks/useInventory.ts':{useInventoryCatalog:()=>({data:{models:[{model:base.model,inStock:100}]}})},
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
 const react={...passiveReact,useState:initial=>{const index=calls++;return [index===2?'mine':index===4&&count===1?'NO-MATCH':typeof initial==='function'?initial():initial,()=>{}];}};
 const row=count?base:null;
 const useApprovals=()=>({data:{allocations:row?[row]:[],inquiries:[]},refresh:async()=>{},isLoading:false,isError:false});
 const view=load('web/src/views/ApprovalCenter.tsx',{...approvalMocks,'react':react,'web/src/hooks/useApprovals.ts':{useApprovals}});
 const html=renderToStaticMarkup(React.createElement(view.ApprovalCenterView,{role:'operation-1'}));
 assert(html.includes(expected),expected);
}
checks.push('SP-005/006/007/016/020 controlled render, both operation roles; other-role label retained');

const forceOpenReact={...passiveReact,useState:initial=>[initial===false?true:initial,()=>{}]};
const fulfillment=load('web/src/components/InquiryFulfillment.tsx',{'react':forceOpenReact,'web/src/api.ts':apiStub,'web/src/hooks/useBusinessAction.ts':{useBusinessAction:()=>noAction}});
const draft={value:{plan:'SYNTH',date:'2026-10-16',version:'V1',warehouse:'CA'},ready:true,update:()=>{},prepare:fn=>fn};
for(const [category,title] of [['墨盒','保存并备份'],['硒鼓','确认']]){
 const html=renderToStaticMarkup(React.createElement(fulfillment.InquiryFulfillment,{row:{...base,category,status:'pending_assistant'},role:'purchasing',draft,onRefresh:async()=>{},onNotice:()=>{}}));
 assert(html.includes(`<h3>${title}</h3>`));
 assert(html.includes('<span>发货时间</span>'));
 assert(html.includes(category==='墨盒'?'提交采购归档':'确认全部发出并归档'));
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
checks.push('SP-008/009 archive titles; SP-010/011 date labels retained; SP-013/014/015 exact success and skip copy');

const api=load('web/src/api.ts',{}, {fetch:async()=>{throw new Error('synthetic network reason');}});
await assert.rejects(api.downloadInquiryExport('purchasing',{}),{message:'询库明细导出失败：synthetic network reason'});
const waybillApi=load('web/src/api.ts',{}, {fetch:async()=>({ok:true,headers:{get:()=>null}})});
await assert.rejects(waybillApi.downloadRelocationWaybills('logistics',{}),{message:'未能确认移仓运单文件，导出状态未更新，请重新导出。'});
checks.push('FW-032/033 keep actual error reason and export state boundaries');

const auditSource=fs.readFileSync(at('web/src/views/AuditLog.tsx'),'utf8');
assert(auditSource.includes('label: "5 小时到期，采用商务审核数量"'));
assert(!auditSource.includes('{queryDone && <p'));
assert(auditSource.includes('queryDone?"查询完成":"查询"'));
assert(auditSource.includes('已显示 {records.length} 条。'));
checks.push('SP-017 repeated paragraph removed, query-button/record count retained; SP-018 label scoped to audit view');

const output=at('.test-output/copy-sheet-root-check');fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,checks},null,2));
console.log(`PASS approved copy root checks (${checks.length} groups)`);
