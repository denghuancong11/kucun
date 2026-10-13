import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { completeDirectUpgrade, createDirectUpgrade, formatNumber, type ApiError } from "../api";
import type { DirectUpgrade, DirectUpgradeSource, Role } from "../types";
import { useEffectivePermissions } from "../hooks/usePermissions";
import { createRequestId } from "../utils/ids";
import { Badge, displayTime, EmptyState, Panel } from "./ui";

const roleNames: Record<Role, string> = { admin: "管理员", "assistant-1": "助理-一团", "assistant-2": "助理-二团", "operation-1": "运营·一团", "operation-2": "运营·二团", purchasing: "采购", logistics: "物流", business: "商务", alan: "Alan" };
type Draft = { sourceLineId?: number; quantity: string; version: string; warehouse: string };
type StartRequest = { model: string; sourceVersion: string; requestId: string };
type CompleteRequest = { sourceLineId: number; completedQuantity: number; newVersion: string; targetWarehouse: string; expectedRevision: number; requestId: string };
const blankDraft: Draft = { quantity: "", version: "", warehouse: "" };
const description = (job: DirectUpgrade) => [job.model, job.sourceVersion, displayTime(job.initiatedAt, true), roleNames[job.initiatedByRole]].join(" · ");

function DirectDialog({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className="dialog direct-upgrade-dialog" aria-labelledby="direct-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h3 id="direct-dialog-title">{title}</h3><button type="button" className="btn btn-ghost btn-sm" aria-label="关闭弹窗" disabled={busy} onClick={onClose}>关闭</button></header>
    {children}
  </dialog>;
}

export function DirectUpgradeBoard({ role, active, sources, jobs, warehouses, onBegin, onSaved }: {
  role: Role; active: boolean; sources: DirectUpgradeSource[]; jobs: DirectUpgrade[]; warehouses: string[]; onBegin: () => void; onSaved: (message: string) => Promise<void>;
}) {
  const permissions = useEffectivePermissions(role);
  const canAct = (category: string) => permissions.data?.permissions[category]?.actions === true;
  const canStart = !["business", "alan"].includes(role);
  const canComplete = ["purchasing", "logistics"].includes(role);
  const [model, setModel] = useState("");
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState("");
  const [expanded, setExpanded] = useState<number[]>([]);
  const [startOpen, setStartOpen] = useState(false);
  const [startModel, setStartModel] = useState("");
  const [startVersion, setStartVersion] = useState("");
  const [pendingStart, setPendingStart] = useState<StartRequest | null>(null);
  const [startError, setStartError] = useState("");
  const [completeId, setCompleteId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [pending, setPending] = useState<Record<number, CompleteRequest>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const models = [...new Set(jobs.map(job => job.model))];
  const versions = [...new Set(jobs.filter(job => !model || job.model === model).map(job => job.sourceVersion))];
  const visible = jobs.filter(job => (!model || job.model === model) && (!version || job.sourceVersion === version) && (!status || job.status === status));
  const source = sources.find(item => item.model === startModel && item.sourceVersion === startVersion);
  const startModels = [...new Set([...sources.map(item => item.model), ...(pendingStart ? [pendingStart.model] : [])])];
  const startVersions = [...new Set([...sources.filter(item => item.model === startModel).map(item => item.sourceVersion), ...(pendingStart ? [pendingStart.sourceVersion] : [])])];
  const selectedJob = jobs.find(job => job.id === completeId);
  const recovery = completeId === null ? undefined : pending[completeId];
  const draft = recovery ? { sourceLineId: recovery.sourceLineId, quantity: String(recovery.completedQuantity), version: recovery.newVersion, warehouse: recovery.targetWarehouse } : (completeId === null ? blankDraft : drafts[completeId] ?? blankDraft);
  const selectedLine = selectedJob?.lines.find(line => line.id === draft.sourceLineId);
  const quantity = Number(draft.quantity);
  const quantityError = draft.quantity !== "" && (!Number.isInteger(quantity) || quantity <= 0) ? "请填写大于0的整数。" : selectedLine && quantity > selectedLine.inProgressQuantity ? `完成数量不能超过所选批次剩余 ${formatNumber(selectedLine.inProgressQuantity)} 件。` : "";
  const versionError = draft.version.trim() && draft.version.trim() === selectedJob?.sourceVersion ? "升级完成版本必须与原版本不同。" : "";
  const batchUnavailable = draft.sourceLineId !== undefined && (!selectedLine || selectedLine.inProgressQuantity <= 0);
  const valid = !!selectedLine && selectedLine.inProgressQuantity > 0 && Number.isInteger(quantity) && quantity > 0 && quantity <= selectedLine.inProgressQuantity && !!draft.version.trim() && !versionError && warehouses.includes(draft.warehouse);
  const updateDraft = (patch: Partial<Draft>) => { if (completeId !== null) setDrafts(current => ({ ...current, [completeId]: { ...draft, ...patch } })); };

  const start = async () => {
    if (running.current || (!pendingStart && (!source || source.available <= 0 || !canStart || !canAct(source.category)))) return;
    const request = pendingStart ?? { model: startModel, sourceVersion: startVersion, requestId: createRequestId("upgrade-direct") };
    running.current = true; setBusy("start"); setPendingStart(request); setStartError(""); onBegin();
    try {
      const result = await createDirectUpgrade(role, request);
      setPendingStart(null); setStartOpen(false); setStartModel(""); setStartVersion("");
      await onSaved(`${request.model} · ${request.sourceVersion}：已锁定 ${formatNumber(result.upgrade.initialQuantity)} 件可用库存。`);
    } catch (failure) {
      const error = failure as ApiError;
      const rejected = error.status !== undefined && error.status >= 400 && error.status < 500;
      if (rejected) setPendingStart(null);
      setStartError(error.message + (rejected ? "" : " 本次发起结果待确认。"));
    } finally { running.current = false; setBusy(null); }
  };

  const finish = async () => {
    if (!selectedJob || running.current || (!recovery && (!valid || !canComplete || !canAct(selectedJob.category)))) return;
    const job = selectedJob;
    const request = recovery ?? { sourceLineId: selectedLine!.id, completedQuantity: quantity, newVersion: draft.version.trim(), targetWarehouse: draft.warehouse, expectedRevision: job.revision, requestId: createRequestId(`upgrade-direct-complete-${job.id}`) };
    running.current = true; setBusy(`complete-${job.id}`); setPending(current => ({ ...current, [job.id]: request })); setErrors(current => ({ ...current, [job.id]: "" })); onBegin();
    try {
      await completeDirectUpgrade(role, job.id, request, description(job));
      setPending(current => { const next = { ...current }; delete next[job.id]; return next; });
      setDrafts(current => ({ ...current, [job.id]: { ...blankDraft, version: request.newVersion } })); setCompleteId(null);
      await onSaved(`${job.model}：已将 ${formatNumber(request.completedQuantity)} 件从 ${job.sourceVersion} 转入 ${request.newVersion}，目标海外仓 ${request.targetWarehouse}。`);
    } catch (failure) {
      const error = failure as ApiError;
      const rejected = error.status !== undefined && error.status >= 400 && error.status < 500;
      if (rejected) setPending(current => { const next = { ...current }; delete next[job.id]; return next; });
      setErrors(current => ({ ...current, [job.id]: error.message + (rejected ? "" : " 本次完成结果待确认。") }));
    } finally { running.current = false; setBusy(null); }
  };

  return <section className="direct-upgrade" hidden={!active}>
    <Panel title="在库升级记录" badge={<span className="muted">{visible.length} 条</span>} actions={canStart ? <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => setStartOpen(true)}>发起在库升级</button> : undefined}>
      {pendingStart && !startOpen && <div className="direct-pending" role="status"><span>{pendingStart.model} · {pendingStart.sourceVersion}：发起结果待确认</span><button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => setStartOpen(true)}>重试确认</button></div>}
      {jobs.filter(job => pending[job.id] && completeId !== job.id).map(job => <div className="direct-pending" role="status" key={job.id}><span>{description(job)}：完成结果待确认</span><button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => setCompleteId(job.id)}>重试确认</button></div>)}
      <div className="direct-filters">
        <label className="field"><span>型号</span><select aria-label="筛选型号" value={model} onChange={event => { const next = event.target.value; setModel(next); if (version && !jobs.some(job => (!next || job.model === next) && job.sourceVersion === version)) setVersion(""); }}><option value="">全部型号</option>{models.map(item => <option key={item}>{item}</option>)}</select></label>
        <label className="field"><span>原版本</span><select aria-label="筛选原版本" value={version} onChange={event => setVersion(event.target.value)}><option value="">全部版本</option>{versions.map(item => <option key={item}>{item}</option>)}</select></label>
        <label className="field"><span>状况</span><select aria-label="筛选状况" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状况</option><option value="active">升级中，预锁定</option><option value="completed">升级完成</option><option value="cancelled">已撤销发起</option></select></label>
      </div>
      <div className="table-wrap"><table className="data-table direct-task-table" aria-label="在库升级任务"><thead><tr><th aria-label="批次明细" /><th>型号</th><th>原版本</th><th>发起时间</th><th>发起岗位</th><th className="num">初始锁定量</th><th className="num">升级完成量</th><th className="num">升级中／锁定量</th><th>状况</th><th>操作</th></tr></thead>
        <tbody>{visible.map(job => <Fragment key={job.id}>
          <tr data-upgrade-id={job.id} className={expanded.includes(job.id) ? "row-expanded" : undefined}>
            <td><button className="link-btn direct-expand" aria-label={`${expanded.includes(job.id) ? "收起" : "展开"}批次明细 ${description(job)}`} aria-expanded={expanded.includes(job.id)} onClick={() => setExpanded(current => current.includes(job.id) ? current.filter(id => id !== job.id) : [...current, job.id])}>{expanded.includes(job.id) ? "−" : "+"}</button></td>
            <td className="mono"><strong>{job.model}</strong></td><td><span className="ver-chip">{job.sourceVersion}</span></td><td className="direct-time">{displayTime(job.initiatedAt, true)}</td><td>{roleNames[job.initiatedByRole]}</td><td className="num">{formatNumber(job.initialQuantity)}</td><td className="num">{formatNumber(job.completedQuantity)}</td><td className="num strong">{formatNumber(job.inProgressQuantity)}</td><td><Badge label={job.statusText} tone={job.status === "completed" ? "green" : job.status === "cancelled" ? "neutral" : "blue"} /></td>
            <td>{canComplete && (pending[job.id] || (job.status === "active" && canAct(job.category))) && <button className="link-btn" disabled={busy !== null} onClick={() => setCompleteId(job.id)}>{pending[job.id] ? "重试确认" : "登记完成"}</button>}</td>
          </tr>
          {expanded.includes(job.id) && <tr className="direct-detail-row"><td colSpan={10}><div className="direct-batches" data-direct-batches={job.id}>
            <table className="data-table sub" aria-label="来源批次明细"><thead><tr><th>发货计划号</th><th>发货时间</th><th>FNSKU</th><th>来源仓库</th><th>来源团队</th><th className="num">发起时数量</th><th className="num">已完成量</th><th className="num">剩余升级量</th><th>各次完成（版本／目标仓库／数量）</th></tr></thead><tbody>{job.lines.map(line => <tr key={line.id} data-direct-line={line.id}><td>{line.plan}</td><td>{line.shipDate}{line.receivedAt && <div className="muted">入库 {displayTime(line.receivedAt, true)}</div>}</td><td className="mono">{line.fnsku}</td><td>{line.warehouse || "历史仓库未确定"}</td><td>{line.sourceTeam || "—"}</td><td className="num">{formatNumber(line.initialQuantity)}</td><td className="num">{formatNumber(line.completedQuantity)}</td><td className="num strong">{formatNumber(line.inProgressQuantity)}</td><td>{line.completions.length ? <ul className="direct-completions">{line.completions.map((item, index) => <li key={index}>{item.version} / {item.warehouse || "历史仓库未确定"}：{formatNumber(item.quantity)}</li>)}</ul> : "—"}</td></tr>)}</tbody></table>
          </div></td></tr>}
        </Fragment>)}</tbody></table></div>
      {!visible.length && <EmptyState title={jobs.length ? "暂无符合筛选条件的在库升级记录" : "暂无在库升级记录"} />}
    </Panel>
    {active && startOpen && <DirectDialog title="发起在库升级" busy={busy !== null} onClose={() => setStartOpen(false)}><form onSubmit={event => { event.preventDefault(); void start(); }}>
      <div className="direct-dialog-body"><div className="form-grid">
        <label className="field"><span>型号</span><select aria-label="发起型号" autoFocus value={startModel} disabled={!!pendingStart || busy !== null} onChange={event => { setStartModel(event.target.value); setStartVersion(""); setStartError(""); }}><option value="">请选择型号</option>{startModels.map(item => <option key={item}>{item}</option>)}</select></label>
        <label className="field"><span>原版本</span><select aria-label="发起原版本" value={startVersion} disabled={!startModel || !!pendingStart || busy !== null} onChange={event => { setStartVersion(event.target.value); setStartError(""); }}><option value="">请选择原版本</option>{startVersions.map(item => <option key={item}>{item}</option>)}</select></label>
      </div>{source && <dl className="direct-quantities">{[["在库", source.inStock], ["调拨锁定", source.allocationLocked], ["升级锁定", source.upgradeLocked], ["本次可锁数量", source.available]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatNumber(Number(value))}<small> 件</small></dd></div>)}</dl>}
        {!pendingStart && startVersion && (!source || source.available <= 0) && <p className="field-error">当前型号和原版本没有可锁定的可用库存。</p>}
        {source && !canAct(source.category) && <p className="field-error">当前角色无权办理该类目。</p>}
        {startError && <p className="dialog-error" role="alert">{startError}</p>}
      </div><footer className="dialog-actions"><button className="btn btn-ghost" type="button" disabled={busy !== null} onClick={() => setStartOpen(false)}>关闭</button><button className="btn btn-primary" disabled={busy !== null || (!pendingStart && (!source || source.available <= 0 || !canAct(source.category)))}>{busy === "start" ? "锁定中…" : pendingStart ? "重试确认" : source ? `锁定全部 ${formatNumber(source.available)} 件并发起升级` : "锁定全部可用库存并发起升级"}</button></footer>
    </form></DirectDialog>}
    {active && selectedJob && <DirectDialog title="登记在库升级完成" busy={busy !== null} onClose={() => setCompleteId(null)}><form onSubmit={event => { event.preventDefault(); void finish(); }}>
      <div className="direct-dialog-body"><div className="direct-task-summary"><strong>{selectedJob.model} · {selectedJob.sourceVersion}</strong><span>{displayTime(selectedJob.initiatedAt, true)} · {roleNames[selectedJob.initiatedByRole]}</span><Badge label={selectedJob.statusText} tone={selectedJob.status === "completed" ? "green" : "blue"} /></div>
        <fieldset className="direct-source-options" disabled={!!recovery || busy !== null}><legend>实际来源批次</legend>
          {selectedJob.lines.filter(line => line.inProgressQuantity > 0 || line.id === draft.sourceLineId).map(line => <label className={`direct-source-option${line.id === draft.sourceLineId ? " selected" : ""}`} key={line.id}>
            <input type="radio" name="direct-source" aria-label={[line.plan, line.shipDate, line.fnsku, line.warehouse, line.sourceTeam, line.receivedAt ? displayTime(line.receivedAt, true) : ""].filter(Boolean).join(" / ")} checked={line.id === draft.sourceLineId} disabled={line.inProgressQuantity <= 0 && !recovery} onChange={() => updateDraft({ sourceLineId: line.id })} value={line.id} />
            <div><div className="direct-source-title"><strong>{line.plan}</strong><span>剩余 <b>{formatNumber(line.inProgressQuantity)}</b> 件</span></div><dl>{[["发货时间", line.shipDate], ["FNSKU", line.fnsku], ["来源仓库", line.warehouse || "历史仓库未确定"], ["来源团队", line.sourceTeam || "—"], ...(line.receivedAt ? [["入库时间", displayTime(line.receivedAt, true)]] : [])].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>
          </label>)}
        </fieldset>
        {!recovery && batchUnavailable && <p className="field-error" role="alert">所选批次已由其他操作完成，请重新选择实际来源批次。</p>}
        <div className="direct-complete-fields">
          <label className="field"><span>本次完成数量</span><input aria-label="本次完成数量" inputMode="numeric" value={draft.quantity} disabled={!!recovery || busy !== null} aria-invalid={!!quantityError && !recovery} onChange={event => updateDraft({ quantity: event.target.value })} />{quantityError && !recovery && <span className="field-error">{quantityError}</span>}</label>
          <label className="field"><span>升级完成版本</span><input aria-label="升级完成版本" value={draft.version} disabled={!!recovery || busy !== null} aria-invalid={!!versionError && !recovery} onChange={event => updateDraft({ version: event.target.value })} />{versionError && !recovery && <span className="field-error">{versionError}</span>}</label>
          <label className="field"><span>目标海外仓</span><select aria-label="目标海外仓" value={draft.warehouse} disabled={!!recovery || busy !== null} onChange={event => updateDraft({ warehouse: event.target.value })}><option value="">选择目标海外仓</option>{warehouses.map(item => <option key={item}>{item}</option>)}</select></label>
        </div>{errors[selectedJob.id] && <p className="dialog-error" role="alert">{errors[selectedJob.id]}</p>}
      </div><footer className="dialog-actions"><button className="btn btn-ghost" type="button" disabled={busy !== null} onClick={() => setCompleteId(null)}>关闭</button><button className="btn btn-primary" disabled={busy !== null || (!recovery && (!valid || !canAct(selectedJob.category)))}>{busy === `complete-${selectedJob.id}` ? "提交中…" : recovery ? "重试确认" : "登记完成并转入新版本"}</button></footer>
    </form></DirectDialog>}
  </section>;
}
