import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { applyTransitStatus, formatNumber, importTransit, previewTransitImport, previewTransitStatus } from "../api";
import { EmptyState } from "../components/ui";
import { TRANSIT_ROLES, type NoticeMessage, type Role, type TransitImportPreview, type TransitStatusPreview } from "../types";
import { UpgradeTemplates } from '../components/UpgradeTemplates';
import { createRequestId } from "../utils/ids";


type PendingRequest = { previewToken: string; payloadKey: string; requestId: string };

export function Requirement3View({ role }: { role: Role }) {
  const [preview, setPreview] = useState<TransitImportPreview | null>(null);
  const [statusPreview, setStatusPreview] = useState<TransitStatusPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | "status-preview" | "status-apply" | null>(null);
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const statusFileInput = useRef<HTMLInputElement>(null);
  const contextGeneration = useRef(0);
  const importRequestRef = useRef<PendingRequest | null>(null);
  const statusRequestRef = useRef<PendingRequest | null>(null);
  const queryClient = useQueryClient();
  const transitAccess = TRANSIT_ROLES.includes(role);

  useEffect(() => {
    contextGeneration.current += 1;
    importRequestRef.current = null;
    statusRequestRef.current = null;
    setPreview(null); setStatusPreview(null); setNotice(null);
    if (fileInput.current) fileInput.current.value = "";
    if (statusFileInput.current) statusFileInput.current.value = "";
  }, [role]);

  const blockingErrors = preview?.validation.errors ?? [];
  const canImport = Boolean(preview?.previewToken) && blockingErrors.length === 0 && busy === null;
  const isCurrentContext = (generation: number) => contextGeneration.current === generation;


  const upload = async (file?: File) => {
    if (!transitAccess || !file) return;
    importRequestRef.current = null;
    const generation = contextGeneration.current;
    setBusy("preview"); setPreview(null); setStatusPreview(null); setNotice(null);
    try {
      const result = await previewTransitImport(role, file, { dateYear: new Date().getFullYear() });
      if (!isCurrentContext(generation)) return;
      setPreview(result);
    } catch (error) {
      if (isCurrentContext(generation)) { setPreview(null); setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
    } finally { if (isCurrentContext(generation)) { setBusy(null); if (fileInput.current) fileInput.current.value = ""; } }
  };

  const uploadStatus = async (file?: File) => {
    if (!transitAccess || !file) return;
    statusRequestRef.current = null;
    const generation = contextGeneration.current;
    setBusy("status-preview"); setPreview(null); setStatusPreview(null); setNotice(null);
    try {
      const result = await previewTransitStatus(role, file, { dateYear: new Date().getFullYear() });
      if (!isCurrentContext(generation)) return;
      setStatusPreview(result);
    } catch (error) {
      if (isCurrentContext(generation)) { setStatusPreview(null); setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
    } finally {
      if (isCurrentContext(generation)) { setBusy(null); if (statusFileInput.current) statusFileInput.current.value = ""; }
    }
  };

  const applyStatus = async () => {
    if (!transitAccess || !statusPreview?.previewToken || !statusPreview.canApply || busy !== null) return;
    const generation = contextGeneration.current;
    setBusy("status-apply"); setNotice(null);
    try {
      const requestPayload = {
        previewToken: statusPreview.previewToken,
        rows: statusPreview.rows,
        fileName: statusPreview.fileName,
        fileHash: statusPreview.fileSha256,
        templateHash: statusPreview.templateSha256,
      };
      const payloadKey = JSON.stringify({ role, payload: requestPayload });
      const pending = statusRequestRef.current;
      const requestId = pending?.previewToken === requestPayload.previewToken && pending.payloadKey === payloadKey
        ? pending.requestId
        : createRequestId("transit-status");
      statusRequestRef.current = { previewToken: requestPayload.previewToken, payloadKey, requestId };
      const result = await applyTransitStatus(role, { ...requestPayload, requestId });
      if (!isCurrentContext(generation)) return;
      statusRequestRef.current = null;
      setStatusPreview(null);
      const message = `物流状态已保存，涉及 ${result.updatedDetailCount} 条在途记录。${result.unmatchedPlanCount > 0 ? ` ${result.unmatchedPlanCount} 个计划未匹配，未更新。` : ""}`;
      setNotice({ kind: "success", text: message });
      try {
        await Promise.all([queryClient.invalidateQueries({ queryKey: ["inventory", "catalog"] }, { throwOnError: true }), queryClient.invalidateQueries({ queryKey: ["audit"] }, { throwOnError: true })]);
      } catch {
        if (isCurrentContext(generation)) setNotice({ kind: "warning", text: `${message} 页面刷新失败，请刷新页面。` });
      }
    } catch (error) {
      if (isCurrentContext(generation)) { setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
    } finally { if (isCurrentContext(generation)) setBusy(null); }
  };

  const submit = async () => {
    if (!transitAccess || !preview?.previewToken || !canImport) return;
    const generation = contextGeneration.current;
    setBusy("import"); setNotice(null);
    const requestPayload = {
      previewToken: preview.previewToken,
      fileName: preview.fileName,
      fileHash: preview.fileSha256,
      templateHash: preview.templateSha256,
      rows: preview.rows,
    };
    const payloadKey = JSON.stringify({ role, payload: requestPayload });
    const pending = importRequestRef.current;
    const requestId = pending?.previewToken === requestPayload.previewToken && pending.payloadKey === payloadKey
      ? pending.requestId
      : createRequestId("transit-import");
    importRequestRef.current = { previewToken: requestPayload.previewToken, payloadKey, requestId };
    try {
      let result: Awaited<ReturnType<typeof importTransit>>;
      try {
        result = await importTransit(role, { ...requestPayload, requestId });
      } catch (error) {
        if (isCurrentContext(generation)) { setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
        return;
      }
      if (!isCurrentContext(generation)) return;
      const message = `导入完成，涉及 ${result.rowCount} 条在途记录。`;
      setNotice({ kind: "success", text: message });
      setPreview(null); 
      importRequestRef.current = null;
      try {
        await Promise.all([queryClient.invalidateQueries({ queryKey: ["inventory", "catalog"] }, { throwOnError: true }), queryClient.invalidateQueries({ queryKey: ["audit"] }, { throwOnError: true })]);
      } catch {
        if (isCurrentContext(generation)) {
          setNotice({ kind: "warning", text: `${message} 页面刷新失败，请刷新页面。` });
        }
      }
    } finally {
      if (isCurrentContext(generation)) setBusy(null);
    }
  };

  if (!transitAccess) return null;

  return (
    <div className="transit-page">
      {role==='logistics' && <UpgradeTemplates role={role} transfer />}
      {notice && <div className={`callout callout-${notice.kind === "error" ? "danger" : notice.kind === "warning" ? "warn" : "success"}`} role="status">{notice.text}</div>}
      <div className="transit-toolbar">
        <label className="btn btn-primary" htmlFor="transit-import-file">{busy === "preview" ? "读取中…" : "导入在途表格"}</label>
        <input ref={fileInput} id="transit-import-file" className="visually-hidden" type="file" accept=".xlsx,.csv" disabled={busy !== null || !transitAccess} onChange={(event) => void upload(event.target.files?.[0])} />
        <label className="btn btn-ghost" htmlFor="transit-status-file">{busy === "status-preview" ? "读取中…" : "导入物流状态表"}</label>
        <input ref={statusFileInput} id="transit-status-file" className="visually-hidden" type="file" accept=".xlsx,.csv" disabled={busy !== null || !transitAccess} onChange={(event) => void uploadStatus(event.target.files?.[0])} />
      </div>

      {statusPreview && <section className="transit-status-section" aria-labelledby="transit-status-title">
        <div className="transit-status-header">
          <div>
            <h2 id="transit-status-title">物流状态更新</h2>
          </div>

        </div>
        {statusPreview && <div className="transit-status-preview">
          {statusPreview.errors.length > 0 && <div className="callout callout-danger" role="alert"><ul>{statusPreview.errors.map((error, index) => <li key={`${error.row}-${error.code}-${index}`}>{error.message}</li>)}</ul></div>}
          <div className="transit-status-summary" aria-label="物流状态预览统计">
            <span>文件数据 <strong>{statusPreview.totalRows}</strong> 行</span>
            <span>已匹配 <strong>{statusPreview.matchedPlanCount}</strong> 个计划</span>
            <span>未匹配 <strong>{statusPreview.unmatchedPlanCount}</strong> 个计划</span>
          </div>
          {statusPreview.duplicatePlanCount > 0 && <div className="callout callout-warn">
            <div>{statusPreview.duplicatePlanCount} 个计划重复，将采用各计划最后一条非空物流状态。</div>
            <ul>{statusPreview.duplicatePlans.map((item) => <li key={item.plan}>{item.finalSourceRow == null
              ? `计划号 ${item.plan}：第 ${item.sourceRows.join("、")} 行均未填写物流状态。`
              : `计划号 ${item.plan}：第 ${item.sourceRows.join("、")} 行重复，采用第 ${item.finalSourceRow} 行。`}</li>)}</ul>
          </div>}
          {statusPreview.unmatchedPlanCount > 0 && <div className="callout callout-warn">
            <div>以下 {statusPreview.unmatchedPlanCount} 个计划没有可更新的在途记录</div>
            <ul>{statusPreview.unmatchedPlans.map((plan) => <li key={plan}>{plan}</li>)}</ul>
          </div>}
          <div className="table-wrap scroll-x transit-preview-scroll">
            <table className="data-table transit-status-table">
              <thead><tr><th>文件行号</th><th>发货计划号</th><th>型号</th><th>发货日期</th><th>版本号</th><th>FNSKU</th><th>当前物流状态</th><th>更新为</th><th>在途件数</th></tr></thead>
              <tbody>{statusPreview.updates.length === 0
                ? <tr><td colSpan={9}>没有可更新的在途明细</td></tr>
                : statusPreview.updates.map((update) => <tr key={`${update.sourceRow}-${update.id}`}>
                  <td className="num">{update.sourceRow}</td>
                  <td>{update.plan}</td>
                  <td>{update.model}</td>
                  <td>{update.date}</td>
                  <td>{update.version}</td>
                  <td className="mono">{update.fnsku}</td>
                  <td className="transit-status-value">{update.currentStatus}</td>
                  <td className="transit-status-value">{update.status}</td>
                  <td className="num">{formatNumber(update.quantity)}</td>
                </tr>)}</tbody>
            </table>
          </div>
          <div className="transit-actions"><button type="button" className="btn btn-primary" disabled={!statusPreview.canApply || busy !== null} onClick={() => void applyStatus()}>{busy === "status-apply" ? "更新中…" : "确认更新物流"}</button></div>
        </div>}
      </section>}


      {preview && <section className="transit-import-preview"><h2>{preview.fileName}</h2><p>{preview.rows.length} 条记录</p>{preview.validation.errors.length > 0 && <div className="callout callout-danger" role="alert"><ul>{preview.validation.errors.map((error, index) => <li key={index}>{error.message}</li>)}</ul></div>}
        <div className="table-wrap scroll-x transit-preview-scroll"><table className="data-table transit-preview-table"><thead><tr><th>型号</th><th>数量</th><th>套/箱</th><th>FNSKU</th><th>发货方式</th><th>发货计划号</th><th>发货日期</th><th>团队</th><th>店铺</th><th>版本号</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.sourceRow}><td>{row.data.model}</td><td>{formatNumber(row.data.quantity)}</td><td>{row.data.packPerBox || "—"}</td><td>{row.data.fnsku}</td><td>{row.data.shippingMethod}</td><td>{row.data.plan}</td><td>{row.data.date}</td><td>{row.data.team}</td><td>{row.data.store || "待补录"}</td><td>{row.data.version}</td></tr>)}</tbody></table></div>
      <div className="transit-actions"><button type="button" className="btn btn-primary" disabled={!canImport} onClick={() => void submit()}>{busy === "import" ? "导入中…" : "确认导入"}</button></div></section>}
      {!preview && !statusPreview && !notice && <EmptyState title="选择表格开始导入" hint="XLSX / CSV" />}
    </div>
  );
}
