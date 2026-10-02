import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchInquiryBackups, recallInquiry, formatNumber, type ApiError } from '../api';
import { Panel, displayTime } from './ui';
import { createRequestId } from '../utils/ids';
import type { Role } from '../types';

const eventNames:Record<string,string>={backup_snapshot:'备份',recall:'重新处理',archive:'采购归档',reply_no_stock_reject:'回复0，已拒绝',reply_no_stock_archive:'历史回复0归档'};
function Snapshot({payload}:{payload:Record<string,unknown>}) {
  const value=(payload.snapshot || payload) as Record<string,unknown>;
  const fields=[['供应商库存回复','supplier_quantity'],['商务审核数量','approved_quantity'],['发货仓库','shipping_warehouse'],['采购备注','purchase_note'],['发货计划号','plan'],['发货日期','ship_date'],['原版本号','version'],['店铺','store_name'],['FNSKU','fnsku']];
  return <dl className="relocation-fields">{fields.map(([label,key])=><div key={key}><dt>{label}</dt><dd>{String(value[key]??'—')}</dd></div>)}</dl>;
}

export function InquiryBackups({role}:{role:Role}) {
  const query=useQuery({queryKey:['inquiry-backups',role],queryFn:()=>fetchInquiryBackups(role)}),client=useQueryClient();
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <Panel title="询库备份">
    {role==='business'&&<p className="form-hint">重新审核会清空本次审核、库存回复和发货资料；已发起的升级保留。</p>}
    {role==='purchasing'&&<p className="form-hint">重新回复会清空本次库存回复和发货资料；已发起的升级保留。</p>}
    {query.error&&<p role="alert">{query.error.message}</p>}{error&&<p role="alert">{error}</p>}
    {query.isLoading&&<p role="status">正在加载询库备份…</p>}
    {query.isSuccess&&query.data.records.length===0&&<p>暂无询库备份。</p>}
    {(query.data?.records||[]).map(r=><article className="upgrade-history-card" key={r.id}>
      <strong>{r.documentNo} · {r.model} · {r.statusText}</strong><p>供应商回复：{r.supplierQuantity===null?'未回复':`${formatNumber(r.supplierQuantity)} 件`}；店铺：{r.store}；{r.hiddenAt?'已隐藏':'未隐藏'}</p>
      {r.sourceDeficit>0&&<p role="alert">移仓已发货量与其他减少量合计比供应商回复多 {r.sourceDeficit} 件。</p>}
      {(role==='business'||(role==='purchasing'&&r.status!=='pending_business'))&&<button className="btn btn-ghost" disabled={busy} onClick={()=>{setBusy(true);setError('');void recallInquiry(role,r.id,r.revision,createRequestId('inquiry-recall')).then(()=>client.invalidateQueries()).catch((e:ApiError)=>setError(e.status!==undefined&&e.status>=400&&e.status<500?e.message:'处理结果尚未确认，请刷新询库备份查看。')).finally(()=>setBusy(false));}}>{role==='business'?'重新审核':'重新回复库存'}</button>}
      <details><summary>备份与重新处理记录</summary>{r.events.filter(e=>e.type==='backup_snapshot'||e.type==='recall').map(e=><div key={e.id}><strong>{displayTime(e.at)} · {eventNames[e.type]} · {e.role==='purchasing'?'采购':e.role==='business'?'商务':e.role==='alan'?'Alan':e.role==='admin'?'管理员':'系统'}</strong>{e.type==='backup_snapshot' && <Snapshot payload={e.payload} />}</div>)}</details>
    </article>)}
  </Panel>;
}
