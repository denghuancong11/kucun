import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { exportUpgradeRows, importUpgradeFile, previewUpgradeFile } from '../api';
import { buildFlatWorkbook } from '../utils/inquiry-export';
import { createRequestId } from '../utils/ids';
import { TRANSFER_COLUMNS, UPGRADE_COLUMNS } from '../../../upgrade-template.mjs';
import type { Role, UpgradeFilePreview, UpgradeTemplateRow } from '../types';

export function downloadUpgradeWorkbook(rows:UpgradeTemplateRow[],transfer=false) {
  const columns=transfer?TRANSFER_COLUMNS:UPGRADE_COLUMNS;
  const book=buildFlatWorkbook([columns.map(c=>c[1]),...rows.map(r=>columns.map(([key])=>r[key]??null))],transfer?'转仓来源':'升级回填');
  const url=URL.createObjectURL(new Blob([book.bytes as BlobPart],{type:book.contentType}));
  const link=document.createElement('a');link.href=url;link.download=transfer?'转仓升级首次导入.xlsx':'升级数据流回填.xlsx';
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function UpgradeTemplates({role,ids=[],transfer=false}:{role:Role;ids?:number[];transfer?:boolean}) {
  const [preview,setPreview]=useState<UpgradeFilePreview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const request=useRef('');const client=useQueryClient();const kind=transfer?'transfer':'update';
  const act=async(task:()=>Promise<void>)=>{setBusy(true);setError('');try{await task();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const download=()=>act(async()=>{
    const rows=transfer?Array.from({length:20},()=>({importId:createRequestId('transfer-source')})):(await exportUpgradeRows(role,ids)).rows;
    downloadUpgradeWorkbook(rows,transfer);
  });
  const upload=(file?:File)=>{if(file) void act(async()=>{setPreview(null);setMessage('');const result=await previewUpgradeFile(role,kind,file);request.current=createRequestId('upgrade-import');setPreview(result);});};
  const commit=()=>act(async()=>{
    if(!preview) return;
    const result=await importUpgradeFile(role,kind,preview,request.current);
    setMessage(`已保存 ${result.flows.length} 个流程。${transfer?'请在“升级库存-转仓升级”继续填写RMA和清点数量。':''}`);setPreview(null);
    await client.invalidateQueries();
  });
  return <section className="upgrade-template-actions">
    <div className="page-actions"><button className="btn btn-ghost" disabled={busy||(!transfer&&!ids.length)} onClick={()=>void download()}>{transfer?'下载转仓升级模板':'导出所选数据流（回填模板）'}</button>
      {role==='logistics' && <label className="btn btn-primary">{transfer?'导入转仓升级表格':'导入回填模板'}<input className="visually-hidden" type="file" accept=".xlsx,.csv" disabled={busy} onChange={e=>{upload(e.target.files?.[0]);e.target.value='';}} /></label>}
    </div>
    <p className="form-hint">{transfer?'填写数量表示该批货已在第三方海外仓。带在途记录ID只转出对应数量；不带ID作为新增来源。保留首次导入ID，重复提交不会重复转出。':'数量单位为件；升级完数量是每条完成明细的累计值。请同时核对升级中数量，保留流程ID、完成明细ID和数据版本；新增一批先点击“新增完成明细”。'}</p>
    {!transfer&&<p className="form-hint">物流回填RMA、原始移仓地址、原文联系人/街道片段、清点和升级数量、完成版本、物理目标仓；店铺和套/箱仅补缺失资料。订单号由运营在页面填写，其余列用于核对来源。</p>}
    {error && <p className="callout callout-danger" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {preview && <div><p>文件：{preview.fileName}，共 {preview.rows.length} 行。提交时核对当前数据版本、来源额度及库存余额。</p>
      <div className="table-wrap scroll-x"><table className="data-table"><thead><tr>{(transfer?TRANSFER_COLUMNS:UPGRADE_COLUMNS).map(([key,label])=><th key={key}>{label}</th>)}</tr></thead><tbody>{preview.rows.map((row,index)=><tr key={index}>{(transfer?TRANSFER_COLUMNS:UPGRADE_COLUMNS).map(([key])=><td key={key}>{String(row[key]??'')}</td>)}</tr>)}</tbody></table></div>
      <button className="btn btn-primary" disabled={busy} onClick={()=>void commit()}>{busy?'提交中…':'确认导入'}</button><button className="btn btn-ghost" disabled={busy} onClick={()=>setPreview(null)}>取消</button>
    </div>}
  </section>;
}
