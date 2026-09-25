import { useState, type FormEvent } from "react";
import { archiveInquiry, formatNumber, replyInquiry } from "../api";
import { useBusinessAction } from "../hooks/useBusinessAction";
import type { Inquiry, NoticeMessage, Role } from "../types";
import { createRequestId } from "../utils/ids";

export function InquiryFulfillment({ row, role, onRefresh, onNotice }: {
  row: Inquiry; role: Role; onRefresh: () => Promise<unknown>; onNotice: (notice: NoticeMessage) => void;
}) {
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [plan, setPlan] = useState("");
  const [date, setDate] = useState("");
  const [version, setVersion] = useState("");
  const action = useBusinessAction(onRefresh, text => { setOpen(false); onNotice({ kind: "success", text }); });
  const reply = (event: FormEvent) => {
    event.preventDefault();
    const payload = { supplierQuantity: Number(quantity), shippingWarehouse: warehouse.trim(), expectedRevision: row.revision, requestId: createRequestId("inquiry-reply") };
    void action.perform({ execute: () => replyInquiry(role, row.id, payload), message: `已保存供应商库存回复 ${formatNumber(payload.supplierQuantity)} 件。` });
  };
  const archive = (event: FormEvent) => {
    event.preventDefault();
    const payload = { plan: plan.trim(), date, version: version.trim(), expectedRevision: row.revision, requestId: createRequestId("inquiry-archive") };
    void action.perform({ execute: () => archiveInquiry(role, row.id, payload), message: "发货资料已保存。" });
  };
  const assistant = role === "assistant-1" || role === "assistant-2";
  const allowed = role === "purchasing" && row.status === "pending_purchasing" || assistant && row.status === "pending_assistant";
  if (!allowed && !action.uncertain) return null;
  return <div className="inquiry-fulfillment"><button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>{role === "purchasing" ? "采购回复" : "助理归档"}</button>
    {open && <div className="dialog-mask"><div className="dialog" role="dialog" aria-modal="true" aria-label={`${role === "purchasing" ? "采购回复" : "助理归档"} ${row.documentNo}`}><h3>{row.documentNo} · {row.model}</h3>
    {role === "purchasing" && row.status === "pending_purchasing" && <form className="approval-action-form" onSubmit={reply}>
      <label className="field"><span>供应商库存回复</span><input required type="number" min="0" step="1" value={quantity} disabled={action.disabled} onChange={event => setQuantity(event.target.value)} /></label>
      <label className="field approval-note-field"><span>发货仓库</span><input required={Number(quantity) > 0} value={warehouse} disabled={action.disabled} onChange={event => setWarehouse(event.target.value)} /></label>
      <button className="btn btn-primary" type="submit" disabled={action.disabled}>提交</button>
    </form>}
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
