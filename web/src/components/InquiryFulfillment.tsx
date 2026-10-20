import { useState, type FormEvent } from "react";
import { archiveAllocation, archiveInquiry, confirmAllocation, formatNumber, replyAllocation, replyInquiry, reviewAllocationByAlan, reviewInquiryByAlan, type ApiError } from "../api";
import { useBusinessAction } from "../hooks/useBusinessAction";
import type { Allocation, Inquiry, NoticeMessage, Role } from "../types";
import { displayTime } from "./ui";
import { createRequestId } from "../utils/ids";
import { finalQuantityLabel, isNewInkAllocation } from "../utils/approvalWorkflow";
import { operationGroups } from "../utils/roles";

export type ApprovalFormDraft = { scope: string; quantity?: string; note?: string; warehouse?: string; plan?: string; date?: string; version?: string };
export type ApprovalDraftControls = {
  value: ApprovalFormDraft | null;
  ready: boolean;
  update: (patch: Omit<Partial<ApprovalFormDraft>, "scope">) => void;
  prepare: (execute: () => Promise<unknown>) => () => Promise<unknown>;
};

export function InquiryFulfillment({ row, role, onRefresh, onNotice, draft }: {
  row: Inquiry; role: Role; onRefresh: () => Promise<unknown>; onNotice: (notice: NoticeMessage) => void; draft: ApprovalDraftControls;
}) {
  const [open, setOpen] = useState(false);
  const plan = draft.value?.plan ?? "", date = draft.value?.date ?? "", version = draft.value?.version ?? "";
  const action = useBusinessAction(onRefresh, text => { setOpen(false); onNotice({ kind: "success", text }); });
  const archive = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.ready || action.disabled) return;
    const payload = { plan: plan.trim(), date, version: version.trim(), expectedRevision: row.revision, requestId: createRequestId("inquiry-archive") };
    void action.perform({ execute: draft.prepare(() => archiveInquiry(role, row.id, payload, [row.model,row.store,row.plan,row.fnsku,displayTime(row.createdAt)].filter(Boolean).join(" / "))), message: row.model + " · " + row.store + "：询库已完成归档。" });
  };
  const assistant = role === "assistant-1" || role === "assistant-2";
  const allowed = (row.category === "墨盒" ? ["purchasing", "logistics"].includes(role) : role === "purchasing") && row.status === "pending_assistant";
  const label = row.category === "墨盒" ? "采购归档" : "确认实际发出并归档";
  if (!allowed && !action.uncertain) return null;
  return <div className="inquiry-fulfillment"><button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>{label}</button>
    {open && <div className="dialog-mask"><div className="dialog" role="dialog" aria-modal="true" aria-label={`${label} ${row.model} · ${row.store}`}><h3>{row.category === "墨盒" ? "保存并备份" : "确认"}</h3>
    {allowed && <form className="approval-action-form" onSubmit={archive}>
      <p className="form-hint">确认本单 {formatNumber(row.finalQuantity ?? row.supplierQuantity ?? 0)} 件已全部实际发出，再提交归档。</p>
      <label className="field"><span>发货计划号</span><input required value={plan} disabled={!draft.ready || action.disabled} onChange={event => draft.update({ plan: event.target.value })} /></label>
      <label className="field"><span>发货时间</span><input required type="date" value={date} disabled={!draft.ready || action.disabled} onChange={event => draft.update({ date: event.target.value })} /></label>
      <label className="field"><span>原版本号</span><input required value={version} disabled={!draft.ready || action.disabled} onChange={event => draft.update({ version: event.target.value })} /></label>
      <button className="btn btn-primary" type="submit" disabled={!draft.ready || action.disabled}>{action.busy ? "正在归档…" : row.category === "硒鼓" ? "确认全部发出并归档" : "提交采购归档"}</button>
    </form>}
    {action.error && <p className="dialog-error" role="alert">{action.error}</p>}
    {action.uncertain && <button className="btn btn-primary" disabled={action.busy} onClick={() => void action.perform()}>{action.busy ? "正在确认…" : "重试确认"}</button>}
    <div className="dialog-actions"><button type="button" className="btn btn-ghost" disabled={action.disabled} onClick={() => setOpen(false)}>取消</button></div>
    </div></div>}
  </div>;
}

// 表格中的三个字段共用本单提交；不与其他单据或助理归档草稿混用。
export function ApprovalProcurementCells({ kind, row, quantity, onQuantityChange, role, onRefresh, onNotice, draft }: {
  kind: "allocation" | "inquiry"; row: Allocation | Inquiry; role: Role; onRefresh: () => Promise<unknown>; onNotice: (notice: NoticeMessage) => void;
  quantity: string; onQuantityChange: (value: string) => void;
  draft: ApprovalDraftControls;
}) {
  const warehouse = draft.value?.warehouse ?? "", note = draft.value?.note ?? "";
  const [attempted, setAttempted] = useState(false);
  const action = useBusinessAction(onRefresh, text => onNotice({ kind: "success", text }));
  const stage = kind === "allocation" ? (row as Allocation).procurementStatus : (row as Inquiry).status;
  const editable = !isNewInkAllocation(row) && (row.category === "硒鼓" ? role === "purchasing" : ["purchasing", "logistics"].includes(role)) && (stage === "pending_purchasing" || row.category === "墨盒" && stage === "pending_alan");
  const formId = `${kind}-reply-${row.id}`;
  const quantityError = quantity.trim() === "" ? (attempted ? "请填写供应商库存回复" : "")
    : !Number.isInteger(Number(quantity)) || Number(quantity) < 0 ? "供应商库存回复请填写 0 或正整数"
    : kind === "allocation" ? allocationQuantityError(quantity, (row as Allocation).packPerBox) : "";
  const warehouseError = kind === "inquiry" && attempted && !warehouse ? "请选择发货仓库（CA 或 SC）" : "";
  const reply = (event: FormEvent) => {
    event.preventDefault(); setAttempted(true);
    if (!draft.ready || action.disabled || !editable || !quantity.trim() || quantityError || kind === "inquiry" && !["CA", "SC"].includes(warehouse)) return;
    const payload = { supplierQuantity: Number(quantity), ...(kind === "inquiry" ? { shippingWarehouse: warehouse } : {}), procurementNote: note.trim(), expectedRevision: row.revision, requestId: createRequestId(`${kind}-reply`) };
    void action.perform({ execute: draft.prepare(() => kind === "allocation" ? replyAllocation(role, row.id, payload, [row.model,row.store,row.plan,row.fnsku,displayTime(row.createdAt)].filter(Boolean).join(" / ")) : replyInquiry(role, row.id, { ...payload, shippingWarehouse: warehouse }, [row.model,row.store,row.fnsku,displayTime(row.createdAt)].filter(Boolean).join(" / "))), message: (kind === "inquiry" || !isNewInkAllocation(row)) && row.category === "墨盒" && payload.supplierQuantity === 0 ? "已保存" : `${row.model} · ${row.store}：${row.category === "硒鼓" && payload.supplierQuantity === 0 ? "采购审核数量为 0，已拒绝。" : "已保存供应商库存回复 " + formatNumber(payload.supplierQuantity) + " 件。"}` });
  };
  return <>
    <td className="approval-procurement-cell" data-field="供应商库存回复">{editable
      ? <label className="field"><input form={formId} aria-label="供应商库存回复" required type="number" min="0" step="1" aria-invalid={Boolean(quantityError)} value={quantity} disabled={!draft.ready || action.disabled} onChange={event => { onQuantityChange(event.target.value); action.setError(null); }} /></label>
      : row.supplierQuantity === null ? "—" : formatNumber(row.supplierQuantity)}</td>
    <td className="approval-procurement-cell" data-field="发货仓库">{editable && kind === "inquiry"
      ? <label className="field"><select form={formId} aria-label="发货仓库" required aria-invalid={Boolean(warehouseError)} value={warehouse} disabled={!draft.ready || action.disabled} onChange={event => { draft.update({ warehouse: event.target.value }); action.setError(null); }}><option value="">请选择</option><option value="CA">CA</option><option value="SC">SC</option></select></label>
      : row.shippingWarehouse || "—"}</td>
    <td className="approval-procurement-cell" data-field="采购备注" title={!editable ? row.procurementNote ?? undefined : undefined}>{editable
      ? <form id={formId} className="inquiry-procurement-form field" aria-label={`采购回复 ${row.model} · ${row.store}`} noValidate onSubmit={reply}>
        <input aria-label="采购备注" value={note} disabled={!draft.ready || action.disabled} onChange={event => { draft.update({ note: event.target.value }); action.setError(null); }} />
        <button className="btn btn-primary btn-sm" type="submit" disabled={!draft.ready || action.disabled}>{action.busy ? "正在提交…" : "提交采购回复"}</button>
        {row.category === "墨盒" && stage === "pending_alan" && <span className="form-hint">提交后将跳过 Alan 审核，本次不记录 Alan 审核数量和备注。</span>}
      </form> : row.procurementNote || "—"}
      {editable && (quantityError || warehouseError) && <p className="field-error" role="alert">{quantityError || warehouseError}</p>}
      {action.error && <p className="dialog-error" role="alert">{action.error}</p>}
      {action.uncertain && <button className="btn btn-primary btn-sm" type="button" disabled={action.busy} onClick={() => void action.perform()}>{action.busy ? "正在确认…" : "重试确认"}</button>}
    </td>
  </>;
}


function allocationQuantityError(quantity: string, pack: string | null) {
  if (Number(quantity) === 0) return "";
  const packPerBox = Number(pack);
  if (!Number.isInteger(packPerBox) || packPerBox <= 0) return "来源批次套/箱数据异常（须为有效正整数），无法提交。";
  return Number(quantity) % packPerBox ? `来源批次套/箱为 ${packPerBox}，数量须为 ${packPerBox} 的整数倍。` : "";
}

export function AlanReviewCells({ kind, row, role, onRefresh, onNotice, draft }: {
  kind: "allocation" | "inquiry"; row: Allocation | Inquiry; role: Role;
  onRefresh: () => Promise<unknown>; onNotice: (notice: NoticeMessage) => void;
  draft: ApprovalDraftControls;
}) {
  const quantity = draft.value?.quantity ?? "", note = draft.value?.note ?? "";
  const [attempted, setAttempted] = useState(false);
  const action = useBusinessAction(onRefresh, text => onNotice({ kind: "success", text }));
  const newAllocation = isNewInkAllocation(row);
  const stage = newAllocation ? row.inkWorkflowStage : kind === "allocation" ? (row as Allocation).procurementStatus : (row as Inquiry).status;
  const editable = role === "alan" && row.category === "墨盒" && stage === "pending_alan";
  const formId = `${kind}-alan-${row.id}`;
  const quantityError = !quantity.trim() ? (attempted ? "请填写Alan审核数量" : "")
    : !Number.isInteger(Number(quantity)) || Number(quantity) < 0 ? "Alan审核数量请填写 0 或正整数"
    : kind === "allocation" ? allocationQuantityError(quantity, (row as Allocation).packPerBox) : "";
  const submitAlan = (decision?: "reject") => {
    if (!decision) setAttempted(true);
    if (!draft.ready || action.disabled || !editable || !decision && (!quantity.trim() || quantityError)) return;
    const common = { alanNote: note.trim(), expectedRevision: row.revision, requestId: createRequestId(`${kind}-alan-review`) };
    const context = [row.model,row.store,row.fnsku,displayTime(row.createdAt)].filter(Boolean).join(" / ");
    const rejected = newAllocation && (decision === "reject" || Number(quantity) === 0);
    void action.perform({ execute: draft.prepare(async () => {
      try {
        return kind === "allocation"
          ? await reviewAllocationByAlan(role, row.id, { ...common, ...(decision ? { decision } : { alanQuantity: Number(quantity) }) }, context)
          : await reviewInquiryByAlan(role, row.id, { ...common, alanQuantity: Number(quantity) }, context);
      } catch (failure) {
        if ((failure as ApiError).status === 409) await onRefresh().catch(refreshFailure => onNotice({ kind: "warning", text: "审批状态刷新失败：" + (refreshFailure as Error).message }));
        throw failure;
      }
    }), message: `${row.model} · ${row.store}：${rejected ? "已拒绝，预锁定库存已释放。" : newAllocation ? "Alan 审核已提交，待本团助理确认。" : "Alan审核已提交，待采购回复。"}` });
  };
  const submit = (event: FormEvent) => { event.preventDefault(); submitAlan(); };
  return <><td className="approval-procurement-cell" data-field="Alan审核数量">{editable ? <label className="field"><input form={formId} aria-label="Alan审核数量" type="number" min="0" step="1" value={quantity} aria-invalid={Boolean(quantityError)} disabled={!draft.ready || action.disabled} onChange={event => { draft.update({ quantity: event.target.value }); action.setError(null); }} /></label> : row.alanQuantity == null ? "—" : formatNumber(row.alanQuantity)}</td>
    <td className="approval-procurement-cell" data-field="Alan备注" title={!editable ? row.alanNote ?? undefined : undefined}>{editable ? <form id={formId} className="inquiry-procurement-form field" aria-label={`Alan审核 ${row.model} · ${row.store}`} noValidate onSubmit={submit}>
      <input aria-label="Alan备注" value={note} disabled={!draft.ready || action.disabled} onChange={event => { draft.update({ note: event.target.value }); action.setError(null); }} />
      <button className="btn btn-primary btn-sm" type="submit" disabled={!draft.ready || action.disabled}>{action.busy ? "正在提交…" : "提交Alan审核"}</button>
      {newAllocation && <button className="btn btn-ghost btn-sm" type="button" disabled={!draft.ready || action.disabled} onClick={() => submitAlan("reject")}>拒绝调拨</button>}
      {newAllocation && quantity.trim() !== "" && Number(quantity) === 0 && <span className="form-hint">数量 0 提交后将拒绝调拨，并释放本单全部预锁定。</span>}
    </form> : row.alanNote || "—"}
      {newAllocation && stage === "pending_alan" && row.alanDeadlineAt && <p className="form-hint" data-field="Alan审核截止">截止：{displayTime(row.alanDeadlineAt)}。到期未提交则采用商务数量。</p>}
      {editable && quantityError && <p className="field-error" role="alert">{quantityError}</p>}
      {action.error && <p className="dialog-error" role="alert">{action.error}</p>}
      {action.uncertain && <button className="btn btn-primary btn-sm" type="button" disabled={action.busy} onClick={() => void action.perform()}>{action.busy ? "正在确认…" : "重试确认"}</button>}
    </td></>;
}

export function AllocationFulfillment({ row, role, onRefresh, onNotice }: {
  row: Allocation; role: Role; onRefresh: () => Promise<unknown>; onNotice: (notice: NoticeMessage) => void;
}) {
  const [open, setOpen] = useState(false);
  const action = useBusinessAction(onRefresh, text => { setOpen(false); onNotice({ kind: "success", text }); });
  const newAllocation = isNewInkAllocation(row);
  const toner = row.category === "硒鼓";
  const assistantAllowed = (newAllocation && row.inkWorkflowStage === "pending_assistant" || toner && !row.tonerConversionStatus && row.statusCode === "pending" && row.approvalStatus === "approved") && ["assistant-1", "assistant-2"].includes(role) && operationGroups[role] === row.department;
  const allowed = !newAllocation && row.category === "墨盒" && ["purchasing", "logistics"].includes(role) && row.statusCode === "pending" && row.procurementStatus === "pending_archive";
  if (newAllocation || toner) return assistantAllowed || open || action.error || action.uncertain ? <div className="inquiry-fulfillment">
    {assistantAllowed && <button type="button" className="btn btn-primary btn-sm" disabled={action.disabled} onClick={() => setOpen(true)}>确认全部发出</button>}
    {open && <div className="dialog-mask"><div className="dialog" role="dialog" aria-modal="true" aria-label={`确认实际发出 ${row.model} · ${row.store}`}><h3>确认实际发出</h3>
      <p>{row.model} · {row.store}</p><p>最终执行数量：<strong>{row.finalQuantity == null ? "—" : formatNumber(row.finalQuantity)}</strong> 件 · {finalQuantityLabel(row.finalQuantitySource, newAllocation)}</p>
      <p>确认以上数量已全部实际发出。</p>
      {action.error && <p className="dialog-error" role="alert">{action.error}</p>}
      <div className="dialog-actions"><button type="button" className="btn btn-ghost" disabled={action.disabled} onClick={() => setOpen(false)}>取消</button><button type="button" className="btn btn-primary" disabled={action.disabled || !assistantAllowed} onClick={() => {
        const requestId = createRequestId("allocation-confirm");
        void action.perform({ execute: () => confirmAllocation(role, row.id, row.revision, requestId, [row.model,row.store,row.plan,row.fnsku].filter(Boolean).join(" / ")), message: `${row.model} · ${row.store}：已确认全部发出，调拨已完成。` });
      }}>{action.busy ? "正在确认…" : "确认全部发出"}</button></div>
    </div></div>}
    {!open && action.error && <p className="dialog-error" role="alert">{action.error}</p>}
    {action.uncertain && <button type="button" className="btn btn-primary btn-sm" disabled={action.busy} onClick={() => void action.perform()}>{action.busy ? "正在确认…" : "重试确认"}</button>}
  </div> : null;
  if (!allowed && !action.uncertain && !action.error) return null;
  return <div className="inquiry-fulfillment">{allowed && <button type="button" className="btn btn-primary btn-sm" disabled={action.disabled} onClick={() => {
    const payload = { expectedRevision: row.revision, requestId: createRequestId("allocation-archive") };
    void action.perform({ execute: () => archiveAllocation(role, row.id, payload, [row.model,row.store,row.plan,row.date,row.version,row.fnsku].filter(Boolean).join(" / ")), message: `${row.model} · ${row.store}：调拨已完成归档。` });
  }}>{action.busy ? "正在归档…" : "采购归档"}</button>}
    {action.error && <p className="dialog-error" role="alert">{action.error}</p>}
    {action.uncertain && <button type="button" className="btn btn-primary btn-sm" disabled={action.busy} onClick={() => void action.perform()}>{action.busy ? "正在确认…" : "重试确认"}</button>}
  </div>;
}
