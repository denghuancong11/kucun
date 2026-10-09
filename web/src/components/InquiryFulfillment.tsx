import { useState, type FormEvent } from "react";
import { archiveInquiry, formatNumber, replyInquiry } from "../api";
import { useBusinessAction } from "../hooks/useBusinessAction";
import type { Inquiry, NoticeMessage, Role } from "../types";
import { createRequestId } from "../utils/ids";

export function InquiryFulfillment({ row, role, onRefresh, onNotice }: {
  row: Inquiry; role: Role; onRefresh: () => Promise<unknown>; onNotice: (notice: NoticeMessage) => void;
}) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState("");
  const [date, setDate] = useState("");
  const [version, setVersion] = useState("");
  const action = useBusinessAction(onRefresh, text => { setOpen(false); onNotice({ kind: "success", text }); });
  const archive = (event: FormEvent) => {
    event.preventDefault();
    const payload = { plan: plan.trim(), date, version: version.trim(), expectedRevision: row.revision, requestId: createRequestId("inquiry-archive") };
    void action.perform({ execute: () => archiveInquiry(role, row.id, payload), message: "发货资料已保存。" });
  };
  const assistant = role === "assistant-1" || role === "assistant-2";
  const allowed = assistant && row.status === "pending_assistant";
  if (!allowed && !action.uncertain) return null;
  return <div className="inquiry-fulfillment"><button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>助理归档</button>
    {open && <div className="dialog-mask"><div className="dialog" role="dialog" aria-modal="true" aria-label={`助理归档 ${row.documentNo}`}><h3>{row.documentNo} · {row.model}</h3>
    {assistant && row.status === "pending_assistant" && <form className="approval-action-form" onSubmit={archive}>
      <label className="field"><span>发货计划号</span><input required value={plan} disabled={action.disabled} onChange={event => setPlan(event.target.value)} /></label>
      <label className="field"><span>发货时间</span><input required type="date" value={date} disabled={action.disabled} onChange={event => setDate(event.target.value)} /></label>
      <label className="field"><span>原版本号</span><input required value={version} disabled={action.disabled} onChange={event => setVersion(event.target.value)} /></label>
      <button className="btn btn-primary" type="submit" disabled={action.disabled}>提交</button>
    </form>}
    {action.error && <p className="dialog-error" role="alert">{action.error}</p>}
    {action.uncertain && <button className="btn btn-primary" disabled={action.busy} onClick={() => void action.perform()}>重试确认</button>}
    <div className="dialog-actions"><button type="button" className="btn btn-ghost" disabled={action.disabled} onClick={() => setOpen(false)}>取消</button></div>
    </div></div>}
  </div>;
}

// 表格中的三个字段共用本单提交；不与其他单据或助理归档草稿混用。
export function InquiryProcurementCells({ row, role, onRefresh, onNotice }: {
  row: Inquiry; role: Role; onRefresh: () => Promise<unknown>; onNotice: (notice: NoticeMessage) => void;
}) {
  const [quantity, setQuantity] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [note, setNote] = useState("");
  const [attempted, setAttempted] = useState(false);
  const action = useBusinessAction(onRefresh, text => onNotice({ kind: "success", text }));
  const editable = role === "purchasing" && row.status === "pending_purchasing";
  const formId = `inquiry-reply-${row.id}`;
  const quantityError = quantity.trim() === "" ? (attempted ? "请填写供应商库存回复，有货填数量，无货填 0" : "")
    : !Number.isInteger(Number(quantity)) || Number(quantity) < 0 ? "供应商库存回复请填写 0 或正整数" : "";
  const warehouseError = attempted && !warehouse ? "请选择发货仓库（CA 或 SC），回复 0 也须选择" : "";
  const reply = (event: FormEvent) => {
    event.preventDefault(); setAttempted(true);
    if (!quantity.trim() || quantityError || !["CA", "SC"].includes(warehouse)) return;
    const payload = { supplierQuantity: Number(quantity), shippingWarehouse: warehouse, procurementNote: note.trim(), expectedRevision: row.revision, requestId: createRequestId("inquiry-reply") };
    void action.perform({ execute: () => replyInquiry(role, row.id, payload), message: `已保存供应商库存回复 ${formatNumber(payload.supplierQuantity)} 件。` });
  };
  return <>
    <td className="approval-procurement-cell" data-field="供应商库存回复">{editable
      ? <label className="field"><input form={formId} aria-label="供应商库存回复" required type="number" min="0" step="1" aria-invalid={Boolean(quantityError)} value={quantity} disabled={action.disabled} onChange={event => { setQuantity(event.target.value); action.setError(null); }} /></label>
      : row.supplierQuantity === null ? "—" : formatNumber(row.supplierQuantity)}</td>
    <td className="approval-procurement-cell" data-field="发货仓库">{editable
      ? <label className="field"><select form={formId} aria-label="发货仓库" required aria-invalid={Boolean(warehouseError)} value={warehouse} disabled={action.disabled} onChange={event => { setWarehouse(event.target.value); action.setError(null); }}><option value="">请选择</option><option value="CA">CA</option><option value="SC">SC</option></select></label>
      : row.shippingWarehouse || "—"}</td>
    <td className="approval-procurement-cell" data-field="采购备注" title={!editable ? row.procurementNote : undefined}>{editable
      ? <form id={formId} className="inquiry-procurement-form field" aria-label={`采购回复 ${row.documentNo}`} noValidate onSubmit={reply}>
        <input aria-label="采购备注" value={note} disabled={action.disabled} onChange={event => { setNote(event.target.value); action.setError(null); }} />
        <button className="btn btn-primary btn-sm" type="submit" disabled={action.disabled}>提交采购回复</button>
      </form> : row.procurementNote || "—"}
      {editable && (quantityError || warehouseError) && <p className="field-error" role="alert">{quantityError || warehouseError}</p>}
      {action.error && <p className="dialog-error" role="alert">{action.error}</p>}
      {action.uncertain && <button className="btn btn-primary btn-sm" type="button" disabled={action.busy} onClick={() => void action.perform()}>重试确认</button>}
    </td>
  </>;
}
