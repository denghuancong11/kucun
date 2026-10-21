import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatNumber } from "../api";
import { useBusinessAction } from "../hooks/useBusinessAction";
import { useSessionDraft } from "../hooks/useSessionDraft";
import type { AllocationEntry, AllocationBatchTotals, Category, Role } from "../types";
import { createRequestId } from "../utils/ids";
import { operationGroups } from "../utils/roles";

export interface AllocationBatchContext {
  key: string; model: string; category: Category; quantity: number; plan: string; date: string; version: string; fnsku: string; packPerBox?: string | null;
}
type Failure = { error: string; code?: string; status?: number } | null;
export function AllocationPanel({batch, totals, role, actionsAllowed, busy, onEntry, onRefresh}: {
  batch: AllocationBatchContext; totals: AllocationBatchTotals; role: Role; actionsAllowed: boolean; busy: boolean;
  onRefresh: () => Promise<unknown>;
  onEntry: (batch: AllocationBatchContext, entry: AllocationEntry) => Promise<Failure>;
}) {
  const group = operationGroups[role];
  const [draft, setDraft, draftCache] = useSessionDraft(role, `allocation-entry:${batch.key}`, {quantity:"",department:group??"一团",store:"",operator:"",fnsku:"",asin:"",note:""});
  const {quantity,department,store,operator,fnsku,asin,note} = draft;
  const setField = (field: keyof typeof draft, value: string) => setDraft(current => ({...current,[field]:value}));
  const setQuantity = (value: string) => setField("quantity", value);
  const setDepartment = (value: string) => setField("department", value);
  const setStore = (value: string) => setField("store", value);
  const setOperator = (value: string) => setField("operator", value);
  const setFnsku = (value: string) => setField("fnsku", value);
  const setAsin = (value: string) => setField("asin", value);
  const setNote = (value: string) => setField("note", value);
  const [quantityTouched, setQuantityTouched] = useState(false);
  const [quantityRequestError, setQuantityRequestError] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const confirmationRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (confirmationOpen) confirmationRef.current?.showModal();
  }, [confirmationOpen]);
  const storeValid = store.includes("US") && !store.includes("-");
  const storeInvalid = store.length > 0 && !storeValid;
  const packPerBox = Number(batch.packPerBox);
  const packError = Number.isInteger(packPerBox) && packPerBox > 0 ? "" : "该批次的套/箱须为正整数，核对后才能提交调拨。";
  const zeroAvailableDemand = totals.available === 0 && totals.locked > 0;
  const quantityLimit = zeroAvailableDemand ? totals.onHand : totals.available;
  const validateQuantity = (value: string) => {
    if (packError) return packError;
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount <= 0) return "调拨数量请填写大于 0 的整数。";
    if (amount % packPerBox !== 0) return `当前批次套/箱为 ${packPerBox}，调拨数量须为 ${packPerBox} 的整数倍。`;
    if (amount > quantityLimit) return zeroAvailableDemand ? `调拨需求不能超过该批次当前在库（${totals.onHand} 件）。` : `超出可用库存（当前可用 ${totals.available}）。`;
    return "";
  };
  const quantityError = packError || (quantityTouched ? validateQuantity(quantity) : "");
  const action = useBusinessAction(onRefresh, text => { setMessage(text); setQuantity(""); setQuantityTouched(false); setQuantityRequestError(false); });
  const formDisabled = !draftCache.ready || busy || action.disabled || confirmationOpen;
  const submitEntry = (zeroAvailableConfirmed = false) => {
    if (!draftCache.ready || busy || action.disabled) return;
    setConfirmationOpen(false);
    const entry = { quantity: Number(quantity), department: group ?? department, store, operator: operator.trim(), fnsku: fnsku.trim(), asin: asin.trim(), operatorNote: note.trim(), requestId: createRequestId("allocation"), ...(zeroAvailableConfirmed ? { zeroAvailableConfirmed: true } : {}) };
    const restoreDraft = draftCache.persist({...draft, quantity:""}, true);
    void action.perform({ execute: async () => {
      const failure = await onEntry(batch, entry);
      if (failure) {
        if (failure.status !== undefined && failure.status >= 400 && failure.status < 500) restoreDraft();
        setQuantityRequestError(["invalid_quantity", "allocation_quantity_multiple", "insufficient_available", "zero_available_condition_changed"].includes(failure.code ?? ""));
        if (failure.code === "zero_available_condition_changed") {
          try { await onRefresh(); }
          catch (refreshFailure) { throw Object.assign(new Error(failure.error + " 库存刷新失败：" + (refreshFailure instanceof Error ? refreshFailure.message : String(refreshFailure))), { status: failure.status, code: failure.code }); }
        }
        throw Object.assign(new Error(failure.error), {status:failure.status, code:failure.code});
      }
    }, message:batch.model+" · "+batch.plan+"："+(zeroAvailableConfirmed ? "调拨需求已提交，未新增预锁定，等待商务分配。" : "调拨已提交并预锁定库存，等待商务审核。") });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (formDisabled) return;
    setMessage("");
    setQuantityTouched(true);
    if (validateQuantity(quantity) || !storeValid) return;
    if (zeroAvailableDemand) setConfirmationOpen(true);
    else submitEntry();
  };
  return <div className="allocation-panel">
    {batch.category === "硒鼓" && <p className="workflow-schedule">运营周一／三上午提交；商务当天下午审核，助理周二／四确认实际发出。</p>}
    <div className="approval-quantities"><span>在库 <strong>{formatNumber(totals.onHand)}</strong></span><span>预锁定 <strong>{formatNumber(totals.locked)}</strong></span><span>可用 <strong>{formatNumber(totals.available)}</strong></span></div>
    {actionsAllowed && ["admin","operation-1","operation-2"].includes(role) && <form className="approval-action-form" onSubmit={submit}>
      <label className="field"><span>调拨数量</span><input autoFocus required type="number" min="1" max={quantityLimit} step="1" aria-label="调拨数量" aria-invalid={Boolean(quantityError)} value={quantity} disabled={formDisabled} onChange={event => { setQuantity(event.target.value); setQuantityTouched(true); if (quantityRequestError) { action.setError(null); setQuantityRequestError(false); } }} />{quantityError && <span className="field-error" role="alert">{quantityError}</span>}</label>
      <label className="field"><span>调拨团队</span><select value={group ?? department} disabled={Boolean(group) || formDisabled} onChange={event => setDepartment(event.target.value)}>{(group ? [group] : ["一团","二团"]).map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>调拨店铺</span><input required pattern={"[^\\x2d]*US[^\\x2d]*"} title="店铺名称须包含大写 US，且不能包含‘-’。" aria-invalid={storeInvalid} value={store} disabled={formDisabled} onChange={event => setStore(event.target.value)} />{storeInvalid && <span className="field-error">店铺名称须包含大写 US，且不能包含‘-’。</span>}</label>
      <label className="field"><span>调拨运营</span><input required value={operator} disabled={formDisabled} onChange={event => setOperator(event.target.value)} /></label>
      <label className="field"><span>已贴 FNSKU</span><input required value={fnsku} disabled={formDisabled} onChange={event => setFnsku(event.target.value)} /></label>
      <label className="field"><span>ASIN（必填）</span><input required value={asin} disabled={formDisabled} onChange={event => setAsin(event.target.value)} /></label>
      <label className="field"><span>运营备注（选填）</span><input value={note} disabled={formDisabled} onChange={event => setNote(event.target.value)} /></label>
      <button className="btn btn-primary" type="submit" disabled={formDisabled || Boolean(quantityError)}>{action.busy ? "正在提交…" : "提交调拨并预锁定"}</button>
    </form>}
    {confirmationOpen && <dialog ref={confirmationRef} className="dialog allocation-confirm-dialog" aria-label="继续提交调拨需求" onCancel={event => { event.preventDefault(); setConfirmationOpen(false); }}>
      <header className="dialog-title"><h3>继续提交调拨需求</h3><button type="button" className="btn btn-ghost btn-sm" aria-label="关闭弹窗" onClick={() => setConfirmationOpen(false)}>关闭</button></header>
      <p>该批次已有预锁定，目前可用件数0，是否仍继续提交调拨需求，参与分配？</p>
      <div className="dialog-actions"><button type="button" className="btn btn-ghost" onClick={() => setConfirmationOpen(false)}>否</button><button type="button" className="btn btn-primary" disabled={!draftCache.ready || busy || action.disabled} onClick={() => submitEntry(true)}>是</button></div>
    </dialog>}
    {message && <p role="status">{message}</p>}{action.error && <p className="dialog-error" role="alert">{action.error}</p>}
    {draftCache.storageError && <p className="dialog-error" role="alert">{draftCache.storageError}</p>}
    {action.uncertain && <button className="btn btn-primary" disabled={action.busy} onClick={() => void action.perform()}>{action.busy ? "正在确认…" : "请重试确认"}</button>}
  </div>;
}
