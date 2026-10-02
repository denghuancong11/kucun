import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addUpgradeDetail, fetchUpgradeFlows, recordRelocationOperation } from '../api';
import { LingxingSync } from './LingxingSync';
import { UpgradeTemplates } from './UpgradeTemplates';
import { Panel, EmptyState } from './ui';
import { createRequestId } from '../utils/ids';
import type { Role, UpgradeFlow } from '../types';

export function UpgradeFlows({role,kind}:{role:Role;kind:'relocation'|'transfer'}) {
  const query=useQuery({queryKey:['upgrade-flows',role],queryFn:()=>fetchUpgradeFlows(role)});
  const [selected,setSelected]=useState<number[]>([]);
  const flows=(query.data?.flows||[]).filter(f=>f.kind===kind);
  return <Panel title={kind==='transfer'?'转仓升级记录':'移仓升级记录'}>
    {query.error && <p role="alert">{query.error.message}</p>}
    <UpgradeTemplates role={role} ids={selected.filter(id=>flows.some(f=>f.id===id))} />
    {query.isLoading && <p role="status">正在加载升级记录…</p>}
    {query.isSuccess && !flows.length && <EmptyState title={kind==='transfer'?'暂无转仓升级记录':'暂无移仓升级记录'} />}
    {flows.map(flow=><article className="upgrade-history-card" key={flow.id}>
      <label><input type="checkbox" checked={selected.includes(flow.id)} onChange={e=>setSelected(s=>e.target.checked?[...s,flow.id]:s.filter(id=>id!==flow.id))} /> {flow.flowId} · {flow.model} · {flow.statusText}</label>
      <FlowDetails key={`${flow.id}:${flow.revision}`} role={role} flow={flow} />
    </article>)}
  </Panel>;
}

function FlowDetails({flow:f,role}:{flow:UpgradeFlow;role:Role}) {
  const client=useQueryClient(),[order,setOrder]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [requestId]=useState(()=>createRequestId('flow-order'));
  const [detailRequestId]=useState(()=>createRequestId('completion-detail'));
  const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);try{await fn();await client.invalidateQueries();}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <>
    <dl className="relocation-fields">{[['来源单号',f.documentNo],['店铺',f.store||'待补录'],['团队',f.department],['发货计划号',f.plan],['发货日期',f.date],['原版本号',f.sourceVersion],['FNSKU',f.fnsku],['套/箱',f.packPerBox||'待补录'],['发起时来源数量',f.sourceQuantity],['RMA',f.rma],['订单号',f.orderNo],['移仓已发货数量',f.shippedQuantity],['FBA其他减少',f.otherReduction],[f.kind==='transfer'?'待安排升级数量':'移仓来源余量',f.sourceRemaining??'待清点'],['实际清点数量',f.countedQuantity??'未填写'],['清点差额',f.countDifference??'未清点'],['升级中数量',f.progressQuantity],['升级完成数量',f.completedQuantity],['承运商',f.carrier],['运单号',f.trackingNo]].map(([label,value])=><div key={String(label)}><dt>{label}</dt><dd>{value||value===0?value:'—'}</dd></div>)}</dl>
    {f.kind==='relocation' && <div className="form-grid"><div><strong>原始移仓地址</strong><pre className="address-text">{f.rawAddress||'待填写'}</pre></div><div><strong>处理后移仓地址</strong><pre className="address-text">{f.processedAddress||'尚未处理'}</pre>{f.processedAddress && <button className="btn btn-ghost" onClick={()=>void navigator.clipboard.writeText(f.processedAddress).then(()=>setMessage('地址已复制。')).catch(()=>setMessage('复制失败，请选中地址后手动复制。'))}>复制地址</button>}</div></div>}
    {f.addressIssue && <p role="alert">{f.addressIssue}</p>}
    {f.status==='awaiting_operation' && ['operation-1','operation-2'].includes(role) && <form className="form-grid" onSubmit={e=>{e.preventDefault();void run(()=>recordRelocationOperation(role,f.id,{removalOrderNo:order,expectedRevision:f.revision,requestId}));}}><label className="field"><span>订单号</span><input required value={order} disabled={busy} onChange={e=>setOrder(e.target.value)}/></label><button className="btn btn-primary" disabled={busy}>保存订单号并同步物流</button></form>}
    {f.kind==='relocation' && f.orderNo && <LingxingSync role={role} target={{action:'logistics',workId:f.id}} displayedTask={f.latestTask} onSynced={()=>client.invalidateQueries({}, {throwOnError:true})} />}
    {f.latestTask && <p role="status">最近物流同步：{f.latestTask.message}</p>}
    {f.externalItems.length>0 && <details><summary>已采纳包裹明细</summary><table className="data-table"><thead><tr><th>店铺</th><th>承运商</th><th>运单号</th><th>已采纳数量</th></tr></thead><tbody>{f.externalItems.map(p=><tr key={p.lineId}><td>{p.snapshot.storeName}</td><td>{p.snapshot.carrier}</td><td>{p.snapshot.trackingNo}</td><td>{p.quantity}</td></tr>)}</tbody></table></details>}
    <table className="data-table"><thead><tr><th>完成明细ID</th><th>累计完成数量</th><th>完成版本</th><th>入库仓库</th></tr></thead><tbody>{f.details.map(d=><tr key={d.id}><td>{d.id}</td><td>{d.quantity}</td><td>{d.version||'未填写'}</td><td>{d.warehouse||'未填写'}</td></tr>)}</tbody></table>
    {role==='logistics'&&!['cancelled','withdrawn'].includes(f.status)&&<button className="btn btn-ghost" disabled={busy} onClick={()=>void run(()=>addUpgradeDetail(role,f.id,f.revision,detailRequestId))}>新增完成明细</button>}
    {message&&<p role="status">{message}</p>}
  </>;
}
