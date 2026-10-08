import { useState, type FormEvent } from "react";
import { formatNumber } from "../api";
import { useBusinessAction } from "../hooks/useBusinessAction";
import type { AllocationEntry, AllocationBatchTotals, Category, Role } from "../types";
import { createRequestId } from "../utils/ids";
import { operationGroups } from "../utils/roles";

export interface AllocationBatchContext {
  key: string; model: string; category: Category; quantity: number; plan: string; date: string; version: string; fnsku: string;
}
type Failure = { error: string; code?: string; status?: number } | null;
export function AllocationPanel({batch, totals, role, actionsAllowed, busy, onEntry}: {
  batch: AllocationBatchContext; totals: AllocationBatchTotals; role: Role; actionsAllowed: boolean; busy: boolean;
  onEntry: (batch: AllocationBatchContext, entry: AllocationEntry) => Promise<Failure>;
}) {
  const group = operationGroups[role];
  const [quantity, setQuantity] = useState("");
  const [department, setDepartment] = useState(group ?? "一团");
  const [store, setStore] = useState("");
  const [operator, setOperator] = useState("");
  const [fnsku, setFnsku] = useState("");
  const [asin, setAsin] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const storeValid = store.includes("US") && !store.includes("-");
  const storeInvalid = store.length > 0 && !storeValid;
  const action = useBusinessAction(async () => {}, text => { setMessage(text); setQuantity(""); });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!storeValid) return;
    const entry = { quantity: Number(quantity), department: group ?? department, store, operator: operator.trim(), fnsku: fnsku.trim(), asin: asin.trim(), operatorNote: note.trim(), requestId: createRequestId("allocation") };
    void action.perform({ execute: async () => {
      const failure = await onEntry(batch, entry);
      if (failure) throw Object.assign(new Error(failure.error), {status:failure.status, code:failure.code});
    }, message:"已预锁定库存，等待商务审核。可在审批中心查看进度。" });
  };
  return <div className="allocation-panel">
    <div className="approval-quantities"><span>在库 <strong>{formatNumber(totals.onHand)}</strong></span><span>预锁定 <strong>{formatNumber(totals.locked)}</strong></span><span>可用 <strong>{formatNumber(totals.available)}</strong></span></div>
    {actionsAllowed && ["admin","operation-1","operation-2"].includes(role) && <form className="approval-action-form" onSubmit={submit}>
      <label className="field"><span>调拨数量</span><input autoFocus required type="number" min="1" max={totals.available} step="1" value={quantity} disabled={busy || action.disabled} onChange={event => setQuantity(event.target.value)} /></label>
      <label className="field"><span>调拨部门</span><select value={department} disabled={Boolean(group) || busy || action.disabled} onChange={event => setDepartment(event.target.value)}>{(group ? [group] : ["一团","二团"]).map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>调拨店铺</span><input required pattern={"[^\\x2d]*US[^\\x2d]*"} title="店铺名称须包含大写 US，且不能包含‘-’。" aria-invalid={storeInvalid} value={store} disabled={busy || action.disabled} onChange={event => setStore(event.target.value)} />{storeInvalid && <span className="field-error">店铺名称须包含大写 US，且不能包含‘-’。</span>}</label>
      <label className="field"><span>调拨运营</span><input required value={operator} disabled={busy || action.disabled} onChange={event => setOperator(event.target.value)} /></label>
      <label className="field"><span>已贴 FNSKU</span><input required value={fnsku} disabled={busy || action.disabled} onChange={event => setFnsku(event.target.value)} /></label>
      <label className="field"><span>ASIN（必填）</span><input required value={asin} disabled={busy || action.disabled} onChange={event => setAsin(event.target.value)} /></label>
      <label className="field"><span>运营备注（选填）</span><input value={note} disabled={busy || action.disabled} onChange={event => setNote(event.target.value)} /></label>
      <button className="btn btn-primary" type="submit" disabled={busy || action.disabled}>录入并预锁定</button>
    </form>}
    {message && <p role="status">{message}</p>}{action.error && <p className="dialog-error" role="alert">{action.error}</p>}
    {action.uncertain && <button className="btn btn-primary" disabled={action.busy} onClick={() => void action.perform()}>重试确认</button>}
  </div>;
}
