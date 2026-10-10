import { Fragment, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchTransferUpgrades, importTransferUpgrade, previewTransferUpgrade, downloadTransferUpdate,previewTransferUpdate,importTransferUpdate,transferStageLabels,type TransferStage,type TransferUpdatePreview } from "../api";
import { useBusinessAction } from "../hooks/useBusinessAction";
import { TRANSFER_UPGRADE_FIELDS, type Role, type TransferUpgradePreview } from "../types";
import { createRequestId } from "../utils/ids";
import { displayTime, EmptyState, Panel } from "./ui";

const roleNames: Record<Role, string> = { admin: "管理员", "assistant-1": "助理一团", "assistant-2": "助理二团", "operation-1": "运营一团", "operation-2": "运营二团", purchasing: "采购", logistics: "物流", business: "商务", alan: "Alan" };

export function TransferUpgradeImport({ role, children }: { role: Role; children: ReactNode }) {
  const [preview, setPreview] = useState<TransferUpgradePreview | null>(null);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState("");
  const client = useQueryClient();
  const action = useBusinessAction(async () => {
    await Promise.all([client.invalidateQueries({ queryKey: ["upgrades"] }), client.invalidateQueries({ queryKey: ["audit"] })]);
  }, message => { setPreview(null); setNotice(message); });
  const upload = async (file?: File) => {
    if (!file) return;
    setReading(true); setPreview(null); setNotice(""); action.setError(null);
    try { setPreview(await previewTransferUpgrade(role, file)); }
    catch (failure) { action.setError((failure as Error).message); }
    finally { setReading(false); }
  };
  const submit = () => {
    if (!preview?.previewToken || preview.errors.length) return;
    const payload = { previewToken: preview.previewToken, fileName: preview.fileName, fileHash: preview.fileSha256,
      templateHash: preview.templateSha256, rows: preview.rows, requestId: createRequestId("transfer-upgrade-import") };
    void action.perform({ execute: () => importTransferUpgrade(role, payload), message: `已导入 ${preview.rows.length} 条转仓升级记录，请在“升级库存 → 转仓升级”查看。` });
  };
  return <section aria-label="表格导入">
    <div className="transit-toolbar">
      {children}
      <label className="btn btn-ghost" htmlFor="transfer-upgrade-file">{reading ? "读取中…" : "导入转仓升级表格"}</label>
      <input id="transfer-upgrade-file" hidden type="file" accept=".xlsx" disabled={reading || action.disabled}
        onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
    </div>
    {notice && <div className="callout callout-success" role="status">{notice}</div>}
    {action.error && <div className="callout callout-danger" role="alert">{action.error}</div>}
    {action.uncertain && <button className="btn btn-primary" disabled={action.busy} onClick={() => void action.perform()}>重试确认</button>}
    {preview && <Panel title={`转仓升级导入预览 · ${preview.fileName}`}>
      <p>仅读取“转仓升级”工作表，共 {preview.rows.length} 行。首次只填写前9项，确认后为“已在第三方海外仓”。内容相同的行也会分别保留。</p>
      {preview.errors.length > 0 && <div className="callout callout-danger" role="alert"><ul>{preview.errors.map((error, index) => <li key={index}>{error.message}</li>)}</ul></div>}
      <div className="table-wrap scroll-x"><table className="data-table transfer-upgrade-table" aria-label="转仓升级导入预览">
        <thead><tr>{TRANSFER_UPGRADE_FIELDS.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead>
        <tbody>{preview.rows.map(row => <tr key={row.sourceRow}>{TRANSFER_UPGRADE_FIELDS.map(([key]) => <td key={key}>{row.data[key]}{key === "model" && <small className="muted">（第 {row.sourceRow} 行）</small>}</td>)}</tr>)}</tbody>
      </table></div>
      <div className="form-footer"><button className="btn btn-primary" disabled={!preview.previewToken || preview.errors.length > 0 || reading || action.disabled} onClick={submit}>确认导入转仓升级</button></div>
    </Panel>}
  </section>;
}

export function TransferUpgradeList({ role }: { role: Role }) {
  const query = useQuery({ queryKey: ["upgrades", "transfer", role], queryFn: () => fetchTransferUpgrades(role) });
  const rows = query.data?.records ?? [];
  return <>{role === "logistics" && <TransferUpdate role={role} />}<Panel title="转仓升级记录" actions={<button className="btn btn-ghost btn-sm" disabled={query.isFetching} onClick={() => void query.refetch()}>刷新</button>}>
    {query.isError && <div className="callout callout-danger" role="alert">转仓升级读取失败：{query.error.message}</div>}
    {query.isLoading ? <p>加载中…</p> : rows.length === 0 ? <EmptyState title="暂无转仓升级记录" /> : <div className="table-wrap scroll-x">
      <table className="data-table transfer-upgrade-table" aria-label="转仓升级记录"><thead><tr><th>转仓单号</th>{TRANSFER_UPGRADE_FIELDS.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <Fragment key={row.id}>
          {(index === 0 || rows[index - 1].importId !== row.importId) && <tr><td colSpan={16}>导入批次 #{row.importId} · {row.fileName} · {roleNames[row.importedByRole]} · {displayTime(row.importedAt)}</td></tr>}
          <tr data-transfer-id={row.id}><td>{row.documentNo}</td>{TRANSFER_UPGRADE_FIELDS.map(([key]) => <td key={key}>{row.data[key]}{key === "model" && <small className="muted">（{row.sheetName}第 {row.sourceRow} 行）</small>}</td>)}</tr>
          <tr><td colSpan={16}><details><summary>{row.documentNo} 入库批次与办理历史</summary>
          <p>升级后库存为公共库存，入库至Aster海外仓；缺少“套/箱”时不能调拨。</p>
          {row.receiptBatches.map(b=><p key={b.ledgerId}>{b.batchKey} · {b.version} · {b.warehouse} · 有效入库 {b.quantity} · 锁定 {b.locked}{b.issue&&' · '+b.issue}</p>)}
          {row.history.map((h,i)=><p key={i}>{displayTime(h.at)} · {roleNames[h.role]} · {transferStageLabels[h.stage as TransferStage]}：{TRANSFER_UPGRADE_FIELDS.filter(([key])=>h.before[key]!==h.after[key]).map(([key,label])=>label+' '+(h.before[key]===''?'未填':h.before[key])+' → '+(h.after[key]===''?'未填':h.after[key])).join('；')}</p>)}
          </details></td></tr>
        </Fragment>)}</tbody>
      </table>
    </div>}
  </Panel></>;
}

function TransferUpdate({role}:{role:Role}) {
 const [stage,setStage]=useState<TransferStage>('rma'),[preview,setPreview]=useState<TransferUpdatePreview|null>(null),[reading,setReading]=useState(false),[notice,setNotice]=useState('');
 const client=useQueryClient(),action=useBusinessAction(async()=>{await Promise.all(['upgrades','inventory','audit'].map(key=>client.invalidateQueries({queryKey:[key]})));},message=>{setPreview(null);setNotice(message);});
 async function upload(file?:File){if(!file)return;setReading(true);setPreview(null);setNotice('');action.setError(null);try{setPreview(await previewTransferUpdate(role,stage,file));}catch(e){action.setError((e as Error).message);}finally{setReading(false);}}
 return <Panel title="物流模板办理">
 <p>按RMA、实际清点数量、升级进度分步办理。下载当前记录，填写对应字段后预览确认；RMA与清点量可再次修正。</p>
 <div className="transit-toolbar"><select aria-label="转仓办理阶段" value={stage} disabled={reading||action.disabled} onChange={e=>{setStage(e.target.value as TransferStage);setPreview(null);setNotice('');action.setError(null);}}>{Object.entries(transferStageLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
 <button className="btn btn-ghost" disabled={reading||action.disabled} onClick={()=>void downloadTransferUpdate(role,stage).catch(e=>action.setError(e.message))}>下载{transferStageLabels[stage]}更新模板</button>
 <label className="btn btn-ghost" htmlFor="transfer-update-file">导入{transferStageLabels[stage]}更新</label><input hidden id="transfer-update-file" type="file" accept=".xlsx" disabled={reading||action.disabled} onChange={e=>{void upload(e.target.files?.[0]);e.target.value='';}}/></div>
 <p>升级中数量＋累计升级完数量≤实际清点数量≤退仓数量。减少累计完成量时，在模板“扣回明细”中逐批填写扣回数量。</p>
 {notice&&<p role="status">{notice}</p>}{action.error&&<p role="alert" className="dialog-error">{action.error}</p>}
 {action.uncertain&&<button className="btn btn-primary" disabled={action.busy} onClick={()=>void action.perform()}>重试确认</button>}
 {preview&&<><div role="alert" className="dialog-error">{preview.errors.map((e,i)=><p key={i}>{e.message}</p>)}</div><div className="table-wrap scroll-x"><table className="data-table" aria-label="转仓更新预览"><thead><tr><th>模板行</th><th>转仓单号</th><th>本次更新</th><th>库存变化</th><th>指定扣回</th><th>更新后状况</th></tr></thead><tbody>{preview.rows.map(r=><tr key={r.sourceRow}><td>{r.sourceRow}</td><td>{r.data.documentNo}</td><td>{TRANSFER_UPGRADE_FIELDS.filter(([key])=>r.before[key]!==r.after[key]).map(([key,label])=><div key={key}>{label}：{r.before[key]===''?'未填':r.before[key]} → {r.after[key]===''?'未填':r.after[key]}</div>)}</td><td>{r.quantityDelta}</td><td>{r.data.reversals.map(b=><div key={b.batchKey}>{b.batchKey}：{b.quantity}</div>)}</td><td>{r.after.status}</td></tr>)}</tbody></table></div><button className="btn btn-primary" disabled={action.disabled||reading||!preview.previewToken||preview.errors.length>0} onClick={()=>{const payload={previewToken:preview.previewToken,fileName:preview.fileName,fileHash:preview.fileSha256,templateHash:preview.templateSha256,rows:preview.rows,requestId:createRequestId('transfer-update')};void action.perform({execute:()=>importTransferUpdate(role,stage,payload),message:'已保存 '+preview.rows.length+' 条转仓升级更新。'});}}>确认更新转仓升级</button></>}
 </Panel>;
}
