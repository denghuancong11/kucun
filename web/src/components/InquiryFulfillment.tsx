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
  const [purchaseNote, setPurchaseNote] = useState("");
  const [plan, setPlan] = useState("");
  const [date, setDate] = useState("");
  const [version, setVersion] = useState("");
  const action = useBusinessAction(onRefresh, text => { setOpen(false); onNotice({ kind: "success", text }); });
  const reply = (event: FormEvent) => {
    event.preventDefault();
    const payload = { supplierQuantity: Number(quantity), shippingWarehouse: warehouse, purchaseNote: purchaseNote.trim(), expectedRevision: row.revision, requestId: createRequestId("inquiry-reply") };
    void action.perform({ execute: () => replyInquiry(role, row.id, payload), message: payload.supplierQuantity === 0 ? "已回复 0 件，询库已拒绝。" : `已回复 ${formatNumber(payload.supplierQuantity)} 件，待采购归档。` });
  };
  const archive = (event: FormEvent) => {
    event.preventDefault();
    const payload = { plan: plan.trim(), date, version: version.trim(), expectedRevision: row.revision, requestId: createRequestId("inquiry-archive") };
    void action.perform({ execute: () => archiveInquiry(role, row.id, payload), message: "询库已归档。" });
  };
  const purchasing = ["purchasing","alan"].includes(role) && row.status === "pending_purchasing";
  const archiving = role === "purchasing" && row.status === "pending_procurement";
  if (!purchasing && !archiving && !action.uncertain) return null;
  return <div className="inquiry-fulfillment">
    {purchasing && <form className="approval-action-form inquiry-purchasing-form" aria-label={`库存回复 ${row.documentNo}`} onSubmit={reply}>
      <label className="field"><span>供应商库存回复</span><input required type="number" min="0" step="1" value={quantity} disabled={action.disabled} onChange={event => setQuantity(event.target.value)} /></label>
      <label className="field"><span>发货仓库</span><select aria-label="发货仓库" required={Number(quantity) > 0} value={warehouse} disabled={action.disabled} onChange={event => setWarehouse(event.target.value)}><option value="">选择仓库</option><option value="CA">CA</option><option value="SC">SC</option></select></label>
      <label className="field inquiry-purchase-note"><span>采购备注</span><input value={purchaseNote} disabled={action.disabled} onChange={event => setPurchaseNote(event.target.value)} /></label>
      <button className="btn btn-primary" type="submit" disabled={action.disabled}>保存回复</button>
    </form>}
    {row.sourceDeficit > 0 && <p role="alert" className="form-hint">移仓已发货量与其他减少量合计比供应商回复多 {row.sourceDeficit} 件，请核对后再归档。</p>}
    {archiving && <button type="button" className="btn btn-primary btn-sm" disabled={row.sourceDeficit > 0} onClick={() => setOpen(true)}>采购归档</button>}
    {open && archiving && <div className="dialog-mask"><div className="dialog" role="dialog" aria-modal="true" aria-label={`采购归档 ${row.documentNo}`}><h3>{row.documentNo} · {row.model}</h3>
    <form className="approval-action-form" onSubmit={archive}>
      <label className="field"><span>发货计划号</span><input required value={plan} disabled={action.disabled} onChange={event => setPlan(event.target.value)} /></label>
      <label className="field"><span>发货日期</span><input required type="date" value={date} disabled={action.disabled} onChange={event => setDate(event.target.value)} /></label>
      <label className="field"><span>原版本号</span><input required value={version} disabled={action.disabled} onChange={event => setVersion(event.target.value)} /></label>
      <button className="btn btn-primary" type="submit" disabled={action.disabled}>确认归档</button>
    </form>
    {action.error && <p className="dialog-error" role="alert">{action.error}</p>}
    {action.uncertain && <button className="btn btn-primary" disabled={action.busy} onClick={() => void action.perform()}>重试确认</button>}
    <div className="dialog-actions"><button type="button" className="btn btn-ghost" disabled={action.disabled} onClick={() => setOpen(false)}>取消</button></div>
    </div></div>}
    {action.error && !open && <p className="dialog-error" role="alert">{action.error}</p>}
    {action.uncertain && !open && <button className="btn btn-primary btn-sm" disabled={action.busy} onClick={() => void action.perform()}>重试确认</button>}
  </div>;
}
