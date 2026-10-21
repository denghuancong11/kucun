import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';

// Render source components with in-memory hook/API fixtures; no browser, server, or database.
const web = path.resolve(import.meta.dirname, '..');
const checks = [];
const noop = () => {};
const forbidden = () => { throw new Error('Business/network action was not authorized by this render-only check'); };
let state = [], cursor = 0, effects = [], query = {}, draft = null, draftError = false;
let action = {busy:false,uncertain:false,error:null,disabled:false,perform:forbidden,setError:noop};
const draftCalls = [];
const react = {...React,
  useState(initial) {
    const index = cursor++;
    const value = index in state ? state[index] : typeof initial === 'function' ? initial() : initial;
    return [value, next => {state[index] = typeof next === 'function' ? next(value) : next;}];
  },
  useRef: initial => ({current:initial}),
  useMemo: factory => factory(),
  useEffect: effect => {effects.push(effect);},
};
const shell = ({children}) => React.createElement('section', null, children);
const ui = {
  Panel:shell, Notice:()=>null, SkeletonTable:()=>null,
  EmptyState:({title})=>React.createElement('p', {'data-empty-state':true}, title),
  FeedbackButton:({label})=>React.createElement('button', null, label),
  Badge:({label})=>React.createElement('span', null, label),
  FlashNum:({value})=>React.createElement('span', null, String(value)),
  Clip:({text})=>React.createElement('span', null, text),
  Segmented:()=>null, Spinner:()=>null, displayTime:value=>value,
};
const defaults = {
  react, 'react/jsx-runtime':jsxRuntime,
  '@tanstack/react-query':{useQuery:()=>query,useQueryClient:()=>({invalidateQueries:forbidden})},
  '../api':{formatNumber:value=>Number(value).toLocaleString('en-US'),createInquiry:forbidden,
    applyTransitStatus:forbidden,importTransit:forbidden,previewTransitImport:forbidden,previewTransitStatus:forbidden,
    fetchLingxingJobs:forbidden,requestLingxingSync:forbidden},
  '../utils/ids':{createRequestId:forbidden},
  '../utils/roles':{operationGroups:{'operation-1':'一团','operation-2':'二团','assistant-1':'一团','assistant-2':'二团'}},
  '../utils/rowExpansion':{expandableRowProps:()=>({}),preserveSummarySelection:noop},
  '../hooks/useBusinessAction':{useBusinessAction:()=>action},
  '../hooks/useSessionDraft':{useSessionDraft:(...args)=>{
    draftCalls.push(args);
    return [draft??args[2],noop,{ready:true,storageError:draftError?args[3]:null,persist:()=>noop}];
  }},
  './ui':ui, '../components/ui':ui,
  './Icon':{Icon:()=>null}, '../components/Icon':{Icon:()=>null},
  './ApprovalDocumentDetails':{ApprovalDocumentButton:()=>null},
  './AllocationPanel':{AllocationPanel:()=>null},'./InquiryEntry':{InquiryEntry:()=>null},
  '../components/InventoryTable':{InventoryTable:()=>null},
  '../components/ModelDetailSection':{ModelDetailSection:()=>null},
  '../components/SearchBox':{SearchBox:()=>null},
  '../hooks/usePermissions':{useEffectivePermissions:()=>({isError:true,isLoading:false,refetch:forbidden})},
  '../hooks/useInventory':{useInventoryCatalog:()=>({data:{models:[]},isLoading:false,isError:false,refetch:forbidden})},
  '../hooks/useAllocations':{useAllocations:()=>({data:undefined,isError:false,createMutation:{isPending:false},refresh:forbidden})},
  '../hooks/useTransit':{useTransit:()=>({onShelfMutation:{isPending:false,mutateAsync:forbidden}})},
};
function load(relative, dependencies = defaults) {
  const filename = path.join(web, relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename,'utf8'),{
    fileName:filename, reportDiagnostics:true,
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  });
  assert.equal((compiled.diagnostics??[]).filter(item=>item.category===ts.DiagnosticCategory.Error).length,0,relative);
  const module = {exports:{}};
  new Function('require','module','exports',compiled.outputText)(name=>{
    assert(Object.hasOwn(dependencies,name),`Unexpected dependency ${name}`);
    return dependencies[name];
  },module,module.exports);
  return module.exports;
}
defaults['../types'] = load('src/types.ts',{});
defaults['../lingxing-sync'] = load('src/lingxing-sync.ts',{});
const {Requirement1View} = load('src/views/Requirement1.tsx');
const {Requirement3View} = load('src/views/Requirement3.tsx');
const {InventoryTable} = load('src/components/InventoryTable.tsx');
const {ModelDetailSection} = load('src/components/ModelDetailSection.tsx');
const {AllocationPanel} = load('src/components/AllocationPanel.tsx');
const {InquiryEntry} = load('src/components/InquiryEntry.tsx');
const {LingxingSync} = load('src/components/LingxingSync.tsx');
function render(component, props, overrides=[]) {
  state=overrides;cursor=0;effects=[];
  return renderToStaticMarkup(React.createElement(component,props));
}
function check(name, task) {task();checks.push(name);console.log('PASS '+name);}
const model = {model:'COPY-KC',category:'硒鼓',inStock:30,inTransit:10,locked:7,available:23};
const stock = {batchKey:'copy-batch',quantity:20,baseQuantity:20,locked:5,available:15,packPerBox:'5',plan:'PLAN-KEEP',date:'2026-10-16',version:'V1',fnsku:'FNSKU-KEEP',warehouse:'TestWarehouse',revision:1};
const baseProps = {model,stockRows:[stock],transitRows:[],role:'admin',perm:{summary:true,detail:true,expand:true,actions:true},permLoading:false,
  alloc:undefined,allocBusy:false,activeBatchKey:null,onSelectBatchKey:noop,tab:'stock',onTabChange:noop,onEntry:forbidden,
  onShelf:forbidden,onShelfRefresh:forbidden,onAllocationRefresh:forbidden,onNotice:noop};
check('KC-001 precise permission message',()=>{
  const html=render(Requirement1View,{role:'admin'});
  assert(html.includes('暂时无法查看库存明细，无法提交调拨、询库或确认入库。'));
});
check('KC-002 batch-only tooltip; other unknown tooltips preserved',()=>{
  const html=render(InventoryTable,{rows:[{model,batches:[],locked:null,available:null}],expandedModel:null,sortField:'model',sortOrder:'asc',onSort:noop,onExpand:noop,expandedDetail:null});
  assert.equal((html.match(/title="暂时无法取得批次数量"/g)??[]).length,1);
  assert.equal((html.match(/title="暂时无法取得预锁定和可用库存数量"/g)??[]).length,2);
});
check('KC-004 precise hidden fields; KC-003 header kept',()=>{
  assert(render(ModelDetailSection,{...baseProps,perm:{...baseProps.perm,detail:false}}).includes('当前角色无法查看套/箱、发货计划号、发货时间、版本号、已贴 FNSKU 和发货方式（所属海外仓）。'));
  assert(render(ModelDetailSection,baseProps).includes('发货方式（所属海外仓）'));
});
check('KC-005/006/007 mismatch reference quantities; quantities unchanged',()=>{
  const html=render(ModelDetailSection,baseProps);
  for(const text of ['与汇总在库库存不一致（汇总 30 件）','与汇总预锁定不一致（汇总 7 件）','与汇总可用库存不一致（汇总 23 件）']) assert(html.includes(text));
  assert(html.includes('PLAN-KEEP')&&html.includes('FNSKU-KEEP'));
});
const transit = {id:1,quantity:10,plan:'TRANSIT-KEEP',date:'2026-10-16',version:'V1',fnsku:'TRANSIT-FNSKU',shippingMethod:'直发FBA',team:'一团',status:'待到仓',statusCode:'in_transit',revision:1,onShelf:'NO'};
check('KC-009/010 kept; KC-008 header kept',()=>{
  const props={...baseProps,tab:'transit',transitRows:[transit]};
  assert(render(ModelDetailSection,props).includes('确认直发FBA'));
  assert(render(ModelDetailSection,props).includes('是否上架'));
  action={...action,busy:true};assert(render(ModelDetailSection,props).includes('正在确认直发FBA…'));action={...action,busy:false};
});
check('KC-011/012 exact retry wording for both transit branches',()=>{
  action={...action,uncertain:true};
  for(const shippingMethod of ['直发FBA','TestWarehouse']) assert(render(ModelDetailSection,{...baseProps,tab:'transit',transitRows:[{...transit,shippingMethod}]}).includes('请重试确认'));
  action={...action,uncertain:false};
});
check('KC-013/014 exact retry wording without changing submit/field restrictions',()=>{
  action={...action,uncertain:true,disabled:true};
  assert(render(AllocationPanel,{batch:{...stock,model:model.model,category:'硒鼓'},totals:{onHand:20,locked:5,available:15},role:'admin',actionsAllowed:true,busy:false,onEntry:forbidden,onRefresh:forbidden}).includes('请重试确认'));
  const html=render(InquiryEntry,{model,role:'admin',enabled:true},[true,null]);
  assert(html.includes('请重试确认'));assert(html.includes('<fieldset class="inquiry-fields" disabled=""'));
  action={...action,uncertain:false,disabled:false};
});
const preview = {fileName:'KEEP-FILE.csv',previewToken:'token',rows:[],validation:{errors:[]}};
const statusPreview = {fileName:'KEEP-STATUS.csv',totalRows:5,matchedPlanCount:2,unmatchedPlanCount:1,duplicatePlanCount:2,canApply:true,errors:[],updates:[],
  duplicatePlans:[{plan:'VALID-PLAN',sourceRows:[2,3],finalSourceRow:3},{plan:'EMPTY-PLAN',sourceRows:[4,5],finalSourceRow:null}],unmatchedPlans:['NO-MATCH']};
const emptyDraft={preview:null,statusPreview:null,importRequest:null,statusRequest:null,uncertainImport:false,uncertainStatus:false};
check('KC-015/016/017/018/019/020 rendered preview copy and original plan/row data',()=>{
  draft={...emptyDraft,statusPreview};const html=render(Requirement3View,{role:'admin'});
  for(const text of ['文件记录 <strong>5</strong> 行','可更新的发货计划 <strong>2</strong> 个','无可更新记录的发货计划 <strong>1</strong> 个','文件中有 2 个发货计划重复出现。','采用第 3 行的物流状态','这些行均未填写物流状态。','确认更新物流状态','VALID-PLAN','文件行号 2、3','EMPTY-PLAN','文件行号 4、5']) assert(html.includes(text),text);
  assert(!html.includes('最终采用第'));
});
check('KC-021/022 retry text; existing defaults KC-023/024 unchanged',()=>{
  draft={...emptyDraft,statusPreview,uncertainStatus:true};assert(render(Requirement3View,{role:'admin'}).includes('请重试确认'));
  draft={...emptyDraft,preview,uncertainImport:true};assert(render(Requirement3View,{role:'admin'}).includes('请重试确认'));
  draft=emptyDraft;
  assert(render(Requirement3View,{role:'admin'}).includes('暂无导入或物流更新预览'));
  assert(render(Requirement3View,{role:'alan'}).includes('无法导入在途库存'));
});
check('FW-012/013 local recovery-error override; other draft callers keep three arguments',()=>{
  draft=emptyDraft;draftError=true;const html=render(Requirement3View,{role:'admin'});
  assert.equal(draftCalls.at(-1)[3],'无法恢复在途导入或物流更新内容，请确认提交结果并重核上传文件');
  assert(html.includes('无法恢复在途导入或物流更新内容，请确认提交结果并重核上传文件'));
  draft=null;draftError=false;render(InquiryEntry,{model,role:'admin',enabled:true});assert.equal(draftCalls.at(-1).length,3);
});
check('KC-035 virtual quantity dash; real quantities and original status preserved',()=>{
  const record={id:1,operator:'USER-KEEP',department:'一团',originalRequestedQuantity:20,businessReviewedQuantity:15,finalQuantity:12,lockedQuantity:0,issuedQuantity:0,status:'转询库，待运营确认'};
  const html=render(ModelDetailSection,{...baseProps,alloc:{totals:{},publicRecords:{'copy-batch':[{...record,isVirtual:true},{...record,id:2,isVirtual:false,status:'待确认发出'}]}}});
  assert(!html.includes('转询库需求'));assert(html.includes('转询库，待运营确认'));assert(html.includes('USER-KEEP'));
  assert(html.includes('<td class="num">—</td>'));assert(html.includes('<td class="num">12</td>'));
});

globalThis.sessionStorage={getItem:()=>null};globalThis.localStorage={getItem:()=>null};
for(const target of [{action:'metrics',documents:[{kind:'inquiry',id:1}]},{action:'logistics',workId:1}]) {
  const prefix=target.action==='metrics'?'KC-025/026/027/028/029':'KC-030/031/032/033/034';
  const props={role:'admin',target,initialRequestId:'same-request',onSynced:()=>Promise.reject(new Error('render-only refresh error'))};
  check(prefix+' labels and original disabled conditions',()=>{
    for(const [jobState,label] of [['queued','等待同步…'],['running','正在同步…'],['succeeded','同步完成，可以再次同步'],['failed','同步失败，请重试']]) {
      query={data:{jobs:[{id:1,requestId:'same-request',state:jobState,message:'ORIGINAL-JOB-ERROR'}]},isLoading:false};
      const html=render(LingxingSync,props);
      assert(html.includes(label),jobState);
      assert.equal(html.includes('disabled=""'),jobState==='queued'||jobState==='running');
      if(jobState==='failed')assert(html.includes('ORIGINAL-JOB-ERROR'));
    }
    query={data:{jobs:[]},isLoading:true};assert(render(LingxingSync,props).includes('正在查询同步结果…'));
    query={data:{jobs:[]},isLoading:false};assert(render(LingxingSync,props).includes('请重试确认'));
    assert(render(LingxingSync,props,[{requestId:'same-request',error:''},'same-request',true]).includes('正在提交同步…'));
    assert(render(LingxingSync,props,[{requestId:null,error:'storage error'},null,false,'storage error']).includes('同步失败，请重试'));
  });
  query={data:{jobs:[{id:1,requestId:'same-request',state:'succeeded'}]},isLoading:false};
  render(LingxingSync,props);
  effects[1]();await Promise.resolve();
  const expected=target.action==='metrics'?'领星指标已保存，但刷新页面数据时出错。':'领星物流已保存，但刷新页面数据时出错。';
  assert.equal(state[4],expected,prefix);
  assert(render(LingxingSync,props,[{requestId:'same-request',error:''},'same-request',false,'',expected]).includes(expected));
  checks.push(prefix+' save-success refresh-error wording');console.log('PASS '+prefix+' save-success refresh-error wording');
}
console.log(`COPY_SHEET_KC_STATIC_RESULT: ALL PASS (${checks.length} groups); no browser, network, service, or database used.`);
