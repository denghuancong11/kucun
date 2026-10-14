import { useState, type FormEvent } from "react";
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
  const storeValid = store.includes("US") && !store.includes("-");
  const storeInvalid = store.length > 0 && !storeValid;
  const packPerBox = Number(batch.packPerBox);
  const packError = Number.isInteger(packPerBox) && packPerBox > 0 ? "" : "当前批次套/箱数据异常（须为有效正整数），无法提交调拨，请核对批次数据。";
  const validateQuantity = (value: string) => {
    if (packError) return packError;
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount <= 0) return "调拨数量请填写大于 0 的整数。";
    if (amount % packPerBox !== 0) return `当前批次套/箱为 ${packPerBox}，调拨数量须为 ${packPerBox} 的整数倍。`;
    if (amount > totals.available) return `超出可用库存（当前可用 ${totals.available}）。`;
    return "";
  };
  const quantityError = packError || (quantityTouched ? validateQuantity(quantity) : "");
  const action = useBusinessAction(onRefresh, text => { setMessage(text); setQuantity(""); setQuantityTouched(false); setQuantityRequestError(false); });
  const formDisabled = !draftCache.ready || busy || action.disabled;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draftCache.ready || busy || action.disabled) return;
    setMessage('');
    setQuantityTouched(true);
    if (validateQuantity(quantity)) return;
    if (!storeValid) return;
    const entry = { quantity: Number(quantity), department: group ?? department, store, operator: operator.trim(), fnsku: fnsku.trim(), asin: asin.trim(), operatorNote: note.trim(), requestId: createRequestId("allocation") };
    const restoreDraft = draftCache.persist({...draft, quantity:""}, true);
    void action.perform({ execute: async () => {
      const failure = await onEntry(batch, entry);
      if (failure) {
        if (failure.status !== undefined && failure.status >= 400 && failure.status < 500) restoreDraft();
        setQuantityRequestError(["invalid_quantity", "allocation_quantity_multiple", "insufficient_available"].includes(failure.code ?? ""));
        throw Object.assign(new Error(failure.error), {status:failure.status, code:failure.code});
      }
    }, message:batch.model+" · "+batch.plan+"：已预锁定库存，等待商务审核。" });
  };
  return <div className="allocation-panel">
    <div className="approval-quantities"><span>在库 <strong>{formatNumber(totals.onHand)}</strong></span><span>预锁定 <strong>{formatNumber(totals.locked)}</strong></span><span>可用 <strong>{formatNumber(totals.available)}</strong></span></div>
    {actionsAllowed && ["admin","operation-1","operation-2"].includes(role) && <form className="approval-action-form" onSubmit={submit}>
      <label className="field"><span>调拨数量</span><input autoFocus required type="number" min="1" max={totals.available} step="1" aria-label="调拨数量" aria-invalid={Boolean(quantityError)} value={quantity} disabled={formDisabled} onChange={event => { setQuantity(event.target.value); setQuantityTouched(true); if (quantityRequestError) { action.setError(null); setQuantityRequestError(false); } }} />{quantityError && <span className="field-error" role="alert">{quantityError}</span>}</label>
      <label className="field"><span>调拨部门</span><select value={group ?? department} disabled={Boolean(group) || formDisabled} onChange={event => setDepartment(event.target.value)}>{(group ? [group] : ["一团","二团"]).map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>调拨店铺</span><input required pattern={"[^\\x2d]*US[^\\x2d]*"} title="店铺名称须包含大写 US，且不能包含‘-’。" aria-invalid={storeInvalid} value={store} disabled={formDisabled} onChange={event => setStore(event.target.value)} />{storeInvalid && <span className="field-error">店铺名称须包含大写 US，且不能包含‘-’。</span>}</label>
      <label className="field"><span>调拨运营</span><input required value={operator} disabled={formDisabled} onChange={event => setOperator(event.target.value)} /></label>
      <label className="field"><span>已贴 FNSKU</span><input required value={fnsku} disabled={formDisabled} onChange={event => setFnsku(event.target.value)} /></label>
      <label className="field"><span>ASIN（必填）</span><input required value={asin} disabled={formDisabled} onChange={event => setAsin(event.target.value)} /></label>
      <label className="field"><span>运营备注（选填）</span><input value={note} disabled={formDisabled} onChange={event => setNote(event.target.value)} /></label>
      <button className="btn btn-primary" type="submit" disabled={formDisabled || Boolean(quantityError)}>{action.busy ? "正在提交…" : "录入并预锁定"}</button>
    </form>}
    {message && <p role="status">{message}</p>}{action.error && <p className="dialog-error" role="alert">{action.error}</p>}
    {draftCache.storageError && <p className="dialog-error" role="alert">{draftCache.storageError}</p>}
    {action.uncertain && <button className="btn btn-primary" disabled={action.busy} onClick={() => void action.perform()}>{action.busy ? "正在确认…" : "重试确认"}</button>}
  </div>;
}
