import { Fragment, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchTransferUpgrades, importTransferUpgrade, previewTransferUpgrade } from "../api";
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
      <input id="transfer-upgrade-file" className="visually-hidden" type="file" accept=".xlsx" disabled={reading || action.disabled}
        onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
    </div>
    {notice && <div className="callout callout-success" role="status">{notice}</div>}
    {action.error && <div className="callout callout-danger" role="alert">{action.error}</div>}
    {action.uncertain && <button className="btn btn-primary" disabled={action.busy} onClick={() => void action.perform()}>重试确认</button>}
    {preview && <Panel title={`转仓升级导入预览 · ${preview.fileName}`}>
      <p>仅读取“转仓升级”工作表，共 {preview.rows.length} 行。确认后新增独立记录，内容相同的行也会保留。</p>
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
  return <Panel title="转仓升级记录" actions={<button className="btn btn-ghost btn-sm" disabled={query.isFetching} onClick={() => void query.refetch()}>刷新</button>}>
    {query.isError && <div className="callout callout-danger" role="alert">转仓升级读取失败：{query.error.message}</div>}
    {query.isLoading ? <p>加载中…</p> : rows.length === 0 ? <EmptyState title="暂无转仓升级记录" /> : <div className="table-wrap scroll-x">
      <table className="data-table transfer-upgrade-table" aria-label="转仓升级记录"><thead><tr>{TRANSFER_UPGRADE_FIELDS.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <Fragment key={row.id}>
          {(index === 0 || rows[index - 1].importId !== row.importId) && <tr><td colSpan={15}>导入批次 #{row.importId} · {row.fileName} · {roleNames[row.importedByRole]} · {displayTime(row.importedAt)}</td></tr>}
          <tr data-transfer-id={row.id}>{TRANSFER_UPGRADE_FIELDS.map(([key]) => <td key={key}>{row.data[key]}{key === "model" && <small className="muted">（{row.sheetName}第 {row.sourceRow} 行）</small>}</td>)}</tr>
        </Fragment>)}</tbody>
      </table>
    </div>}
  </Panel>;
}
