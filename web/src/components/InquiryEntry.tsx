import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createInquiry } from "../api";
import type { ModelSummary, Role } from "../types";
import { createRequestId } from "../utils/ids";
import { operationGroups } from "../utils/roles";
import { useBusinessAction } from "../hooks/useBusinessAction";

export function InquiryEntry({ model, role, enabled }: { model: ModelSummary; role: Role; enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState({quantity:"",department:"一团",store:"",operator:"",fnsku:"",asin:"",operatorNote:""});
  const queryClient = useQueryClient();
  const group = operationGroups[role];
  const storeValid = draft.store.includes("US") && !draft.store.includes("-");
  const storeInvalid = draft.store.length > 0 && !storeValid;
  const canEntry = enabled && ["admin","operation-1","operation-2"].includes(role);
  const {perform,busy,uncertain,error} = useBusinessAction(() => queryClient.invalidateQueries({queryKey:["approvals"]}, {throwOnError:true}), text => {
    setOpen(false);setMessage(text);setDraft({quantity:"",department:group??"一团",store:"",operator:"",fnsku:"",asin:"",operatorNote:""});
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!storeValid) return;
    const payload={...draft,quantity:Number(draft.quantity),department:group??draft.department,model:model.model,requestId:createRequestId("inquiry")};
    void perform({execute:()=>createInquiry(role,payload),message:"询库已提交，待商务审核。"});
  };
  if (!canEntry) return null;
  return <div className="inquiry-entry">
    <button className="btn btn-primary inquiry-trigger" type="button" onClick={() => { setOpen(true); setMessage(null); }}>询库</button>
    {message && <span className="form-hint" role="status">{message}</span>}
    {open && <div className="dialog-mask" onClick={() => !busy && !uncertain && setOpen(false)}>
      <form className="dialog inquiry-dialog" role="dialog" aria-modal="true" aria-labelledby="inquiry-title" onSubmit={(event) => void submit(event)} onClick={(event) => event.stopPropagation()}>
        <h3 id="inquiry-title">提交询库 · {model.model}</h3>
        <fieldset className="inquiry-fields" disabled={busy || uncertain}>
          <div className="form-grid">
            <label className="field"><span>询库数量（必填）</span><input autoFocus required type="number" min="1" step="1" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} /></label>
            <label className="field"><span>询库部门</span><select value={group ?? draft.department} disabled={Boolean(group)} onChange={(e) => setDraft({ ...draft, department: e.target.value })}>{(group ? [group] : ["一团", "二团"]).map((value) => <option key={value}>{value}</option>)}</select></label>
            <label className="field"><span>询库店铺（必填）</span><input required pattern={"[^\\x2d]*US[^\\x2d]*"} title="店铺名称须包含大写 US，且不能包含‘-’。" aria-invalid={storeInvalid} value={draft.store} onChange={(e) => setDraft({ ...draft, store: e.target.value })} />{storeInvalid && <span className="field-error">店铺名称须包含大写 US，且不能包含‘-’。</span>}</label>
            <label className="field"><span>询库运营（必填）</span><input required placeholder="运营姓名" value={draft.operator} onChange={(e) => setDraft({ ...draft, operator: e.target.value })} /></label>
            <label className="field"><span>ASIN（必填）</span><input required value={draft.asin} onChange={(e) => setDraft({ ...draft, asin: e.target.value.trim().toUpperCase() })} /></label>
            <label className="field"><span>FNSKU（必填）</span><input required value={draft.fnsku} onChange={(e) => setDraft({ ...draft, fnsku: e.target.value.trim().toUpperCase() })} /></label>
            <label className="field inquiry-note"><span>运营备注（选填）</span><input value={draft.operatorNote} onChange={(e) => setDraft({ ...draft, operatorNote: e.target.value })} /></label>
          </div>
        </fieldset>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" className="btn btn-ghost" disabled={busy || uncertain} onClick={() => setOpen(false)}>取消</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "提交中…" : uncertain ? "重试确认" : "提交询库"}</button></div>
      </form>
    </div>}
  </div>;
}
