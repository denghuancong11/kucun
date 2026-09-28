import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchInquiryBackups, recallInquiry } from '../api';
import { Panel, displayTime } from './ui';
import { createRequestId } from '../utils/ids';
import type { Role } from '../types';

const eventNames:Record<string,string>={backup_snapshot:'备份',recall:'回撤',archive:'采购归档',reply_no_stock_reject:'回复0，已拒绝',reply_no_stock_archive:'历史回复0归档'};
function Snapshot({payload}:{payload:Record<string,unknown>}) {
  const value=(payload.snapshot || payload) as Record<string,unknown>;
  const fields=[['供应商库存回复','supplier_quantity'],['商务审核数量','approved_quantity'],['发货仓库','shipping_warehouse'],['采购备注','purchase_note'],['发货计划号','plan'],['发货时间','ship_date'],['原版本号','version'],['店铺','store_name'],['FNSKU','fnsku']];
  return <dl className="relocation-fields">{fields.map(([label,key])=><div key={key}><dt>{label}</dt><dd>{String(value[key]??'—')}</dd></div>)}</dl>;
}

export function InquiryBackups({role}:{role:Role}) {
  const query=useQuery({queryKey:['inquiry-backups',role],queryFn:()=>fetchInquiryBackups(role)}),client=useQueryClient();
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <Panel title="询库备份"><p className="form-hint">手动清空不删除备份；回撤在原单重开，已启动升级保留。</p>
    {query.error&&<p role="alert">{query.error.message}</p>}{error&&<p role="alert">{error}</p>}
    {(query.data?.records||[]).map(r=><article className="upgrade-history-card" key={r.id}>
      <strong>{r.documentNo} · {r.model} · {r.statusText}</strong><p>供应商库存回复：{r.supplierQuantity??'待回复'}；店铺：{r.store}；{r.hiddenAt?'已从审批页隐藏':'审批页可见'}</p>
      {role==='purchasing'&&r.status==='pending_business'&&<p>待商务重审完成后，采购再接续处理。</p>}
      {r.sourceDeficit>0&&<p role="alert">来源差额 {r.sourceDeficit} 件，核对后再归档。</p>}
      {(role==='business'||(role==='purchasing'&&r.status!=='pending_business'))&&<button className="btn btn-ghost" disabled={busy} onClick={()=>{setBusy(true);setError('');void recallInquiry(role,r.id,r.revision,createRequestId('inquiry-recall')).then(()=>client.invalidateQueries()).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>{role==='business'?'回撤到待商务审核':'回撤到待Alan或采购回复'}</button>}
      <details><summary>归档快照与回撤记录</summary>{r.events.filter(e=>e.type==='backup_snapshot'||e.type==='recall').map(e=><div key={e.id}><strong>{displayTime(e.at)} · {eventNames[e.type]} · {e.role==='purchasing'?'采购':e.role==='business'?'商务':'历史接续'}</strong>{e.type==='backup_snapshot' && <Snapshot payload={e.payload} />}</div>)}</details>
    </article>)}
  </Panel>;
}
