import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { confirmRelocationWaybills, downloadRelocationWaybills, fetchRelocationWaybills, type RelocationWaybillFilters } from "../api";
import { useBusinessAction } from "../hooks/useBusinessAction";
import type { Role } from "../types";
import { createRequestId } from "../utils/ids";
import { EmptyState, FeedbackButton, Panel } from "./ui";

export function RelocationWaybills({role,model,version,source}:{role:Role;model:string;version:string;source:string}) {
  const exportScope=useRef('');
  const [doneScope,setDoneScope]=useState('');
  const [status,setStatus]=useState<RelocationWaybillFilters['status']>('all');
  const [downloading,setDownloading]=useState(false),running=useRef(false);
  const [notice,setNotice]=useState(''),[downloadError,setDownloadError]=useState('');
  const [pending,setPending]=useState<{exportToken:string;requestId:string;count:number}|null>(null);
  const scopeKey=JSON.stringify([model,version,source,status]);
  const filters={model,version,source,status},client=useQueryClient();
  const query=useQuery({queryKey:['upgrades','waybills',role,filters],queryFn:()=>fetchRelocationWaybills(role,filters)});
  const action=useBusinessAction(()=>client.invalidateQueries({queryKey:['upgrades']}, {throwOnError:true}),message=>{setPending(null);setDoneScope(exportScope.current);setNotice(message);});
  const confirm=(confirmation:NonNullable<typeof pending>)=>action.perform({execute:()=>confirmRelocationWaybills(role,{exportToken:confirmation.exportToken,requestId:confirmation.requestId}),message:'导出完成：已触发文件下载，并确认本次 '+confirmation.count+' 个运单已导出；这不代表文件已保存到电脑。'});
  const download=async()=>{
    if(running.current||pending)return;
    exportScope.current=scopeKey;setDoneScope('');running.current=true;setDownloading(true);setNotice('');setDownloadError('');action.setError(null);
    try{
      const result=await downloadRelocationWaybills(role,filters);
      if(result.exportToken){const confirmation={exportToken:result.exportToken,count:result.count,requestId:createRequestId('waybill-export-confirm')};setPending(confirmation);await confirm(confirmation);}
      else {setDoneScope(scopeKey);setNotice('导出完成：当前范围没有匹配运单，已触发空表下载，未写入导出记录。');}
    }catch(error){setDownloadError('运单文件未完成下载，未确认导出状态：'+(error as Error).message);}
    finally{running.current=false;setDownloading(false);}
  };
  const canExport=['admin','purchasing','logistics','assistant-1','assistant-2'].includes(role);
  return <Panel title="移仓运单" actions={canExport?<button className="btn btn-ghost btn-sm" aria-label="运单号导出" disabled={downloading||!!pending||action.disabled} onClick={()=>void download()}>{pending?'下载已触发，待确认':downloading?'正在导出…':doneScope===scopeKey?'导出完成':'运单号导出'}</button>:undefined}>
    <div className="transit-toolbar"><label className="field"><span>导出状态</span><select aria-label="运单导出状态" value={status} disabled={downloading} onChange={event=>setStatus(event.target.value as typeof status)}><option value="all">全部</option><option value="exported">已导出</option><option value="unexported">未导出</option></select></label><FeedbackButton key={scopeKey} label="刷新运单" pendingLabel="正在刷新…" doneLabel="刷新完成" className="btn btn-ghost btn-sm" onAction={()=>query.refetch({throwOnError:true})}/></div>
    <p className="muted">按当前型号、原版本及来源导出。相同运单号全系统共享导出状态，即使仅导出当前可见部分，也会标记该运单。首次导出时间按北京时间显示。</p>
    {notice&&doneScope===scopeKey&&<p role="status">{notice}</p>}{downloadError&&exportScope.current===scopeKey&&<p className="dialog-error" role="alert">{downloadError}</p>}
    {pending&&<div className="callout"><p role="alert">文件已触发下载，导出状态尚未确认。{action.error}</p><button className="btn btn-primary" disabled={action.busy} onClick={()=>void confirm(pending)}>{action.busy?'正在确认…':'重试本次导出确认'}</button></div>}
    {query.isError&&<p className="dialog-error" role="alert">运单读取失败：{query.error.message}</p>}
    {query.isLoading?<p>加载中…</p>:query.data?.rows.length?<div className="table-wrap scroll-x"><table className="data-table" aria-label="移仓运单列表"><thead><tr><th>移仓单号</th><th>型号 / FNSKU</th><th>店铺 / 订单号</th><th>承运商</th><th>运单号</th><th>移仓-已发货数量</th><th>导出状态</th><th>首次导出时间（北京）</th></tr></thead><tbody>{query.data.rows.map(row=><tr key={JSON.stringify([row.workNo,row.trackingNo,row.model,row.fnsku])}><td>{row.workNo}</td><td>{row.model}<div>{row.fnsku}</div></td><td>{row.store}<div>{row.orderNo}</div></td><td>{row.carrier}</td><td className="mono">{row.trackingNo}</td><td>{row.quantity}</td><td>{row.firstExportedAt?'已导出':'未导出'}</td><td>{row.firstExportedAt?new Date(row.firstExportedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—'}</td></tr>)}</tbody></table></div>:!query.isError&&<EmptyState title="当前范围暂无匹配运单"/>}
  </Panel>;
}
