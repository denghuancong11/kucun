import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { completeDirectUpgrade, createDirectUpgrade, fetchUpgradeDashboard, formatNumber, initiateRelocationUpgrade, type ApiError } from "../api";
import { Badge, EmptyState, Notice, Panel, Segmented, SkeletonTable } from "../components/ui";
import { UpgradeFlows } from '../components/UpgradeFlows';
import { InquiryBackups } from '../components/InquiryBackups';
import type { DirectUpgrade, NoticeMessage, Role } from "../types";
import { createRequestId } from "../utils/ids";

type PendingRequest = { payloadKey:string; requestId:string };
type CompleteDraft = { sourceLineId?:number; quantity:string; version:string; warehouse?:string };
type CompletionRequest = { sourceLineId?:number; completedQuantity:number; newVersion:string; targetWarehouse:string; expectedRevision:number; requestId:string };
const ROLE_LABELS:Record<Role,string>={admin:'管理员','assistant-1':'助理-一团','assistant-2':'助理-二团','operation-1':'运营·一团','operation-2':'运营·二团',purchasing:'采购',business:'商务',alan:'Alan',logistics:'物流'};
function requestFor(ref:React.MutableRefObject<PendingRequest|null>,prefix:string,payload:unknown) {
  const payloadKey=JSON.stringify(payload);
  if(ref.current?.payloadKey===payloadKey) return ref.current.requestId;
  ref.current={payloadKey,requestId:createRequestId(prefix)};return ref.current.requestId;
}

export function Requirement4View({role}:{role:Role}) {
  const [mode,setMode]=useState<'relocation'|'transfer'|'direct'|'backups'>('relocation');
  return <div className="upgrade-page"><Panel><Segmented ariaLabel="升级业务类型" role="tablist" value={mode} onChange={setMode} items={[
    {value:'relocation',label:'移仓升级'},{value:'transfer',label:'转仓升级'},{value:'direct',label:'在库升级'},{value:'backups',label:'询库备份'}]}/></Panel>
    {mode==='relocation'&&<><RelocationSources role={role}/><UpgradeFlows role={role} kind="relocation"/></>}
    {mode==='transfer'&&<UpgradeFlows role={role} kind="transfer"/>}
    {mode==='backups'&&<InquiryBackups role={role}/>}{mode==='direct'&&<DirectView role={role}/>}
  </div>;
}

function RelocationSources({role}:{role:Role}) {
  const query=useQuery({queryKey:['upgrades',role],queryFn:()=>fetchUpgradeDashboard(role)}),client=useQueryClient();
  const [search,setSearch]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const requests=useRef(new Map<string,string>());
  return <Panel title="发起移仓升级"><label className="field"><span>筛选来源单号或型号</span><input value={search} onChange={e=>setSearch(e.target.value)}/></label>
    {query.error&&<p role="alert">{query.error.message}</p>}{error&&<p role="alert">{error}</p>}
    <div className="table-wrap"><table className="data-table"><thead><tr><th>来源单号</th><th>型号 / 原版本</th><th>店铺 / 团队</th><th>移仓来源余量</th><th>操作</th></tr></thead><tbody>
    {(query.data?.relocationCandidates||[]).filter(r=>!search||[r.documentNo,r.model].some(v=>v.includes(search))).map(r=><tr key={r.documentNo}>
      <td>{r.documentNo}</td><td>{r.model} / {r.sourceVersion}</td><td>{r.store||'待补录'} / {r.department}</td><td>{r.fbaRemainingQuantity}</td>
      <td>{!['business','alan'].includes(role)&&<button className="btn btn-primary btn-sm" disabled={busy} onClick={()=>{
        const source=r.sourceKind==='fba'?{fbaArchiveId:r.fbaArchiveId!}:r.sourceKind==='inquiry'?{inquiryId:r.inquiryId!}:{allocationId:r.allocationId!};
        const requestId=requests.current.get(r.documentNo)||createRequestId('initiate-relocation');requests.current.set(r.documentNo,requestId);
        setBusy(true);setError('');void initiateRelocationUpgrade(role,{...source,requestId}).then(async()=>{requests.current.delete(r.documentNo);await client.invalidateQueries();}).catch(e=>setError(e.message)).finally(()=>setBusy(false));
      }}>发起移仓升级</button>}</td></tr>)}
    </tbody></table></div></Panel>;
}

function DirectView({role}:{role:Role}) {
  const query=useQuery({queryKey:['upgrades',role],queryFn:()=>fetchUpgradeDashboard(role)}),queryClient=useQueryClient();
  const [notice,setNotice]=useState<NoticeMessage|null>(null),[busy,setBusy]=useState<string|null>(null);
  const [directModel,setDirectModel]=useState(''),[directVersion,setDirectVersion]=useState('');
  const [directCompleteDrafts,setDirectCompleteDrafts]=useState<Record<number,CompleteDraft>>({});
  const [pendingDirect,setPendingDirect]=useState<Record<number,CompletionRequest>>({});
  const completing=useRef(false),directRequest=useRef<PendingRequest|null>(null);
  const dashboard=query.data,overseasWarehouses=dashboard?.overseasWarehouses||[];
  const directModels=[...new Set((dashboard?.directSources||[]).map(r=>r.model))];
  const directVersions=[...new Set((dashboard?.directSources||[]).filter(r=>r.model===directModel).map(r=>r.sourceVersion))];
  const selectedDirectSource=dashboard?.directSources.find(r=>r.model===directModel&&r.sourceVersion===directVersion);
  const directHistory=(dashboard?.upgrades||[]).filter((r):r is DirectUpgrade=>r.kind==='direct');
  const refreshAfterWrite=()=>queryClient.invalidateQueries({}, {throwOnError:true});
  const submitDirect = async () => {
    if (!selectedDirectSource || selectedDirectSource.available <= 0 || busy || role === "business") return;
    const payload = { model: selectedDirectSource.model, sourceVersion: selectedDirectSource.sourceVersion };
    const requestId = requestFor(directRequest, "upgrade-direct", { role, ...payload });
    setBusy("direct-create");
    setNotice(null);
    try {
      const result = await createDirectUpgrade(role, { ...payload, requestId });
      directRequest.current = null;
      const refreshed = await refreshAfterWrite().then(() => true, () => false);
      setNotice({ kind: "success", text: `已锁定 ${formatNumber(result.upgrade.initialQuantity)} 件，待采购登记完成。${refreshed ? "" : " 页面刷新失败，请刷新页面。"}` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const finishDirect = async (job: DirectUpgrade) => {
    if (busy || completing.current) return;
    const draft = directCompleteDrafts[job.id] ?? { quantity: "", version: job.newVersion ?? "" };
    const key = `upgrade-direct-complete-${job.id}`;
    let request = pendingDirect[job.id];
    if (!request) {
      const quantity = Number(draft.quantity);
      const version = draft.version.trim();
      const sourceLineId = draft.sourceLineId ?? job.lines.find(line => line.inProgressQuantity > 0)?.id;
      const sourceLine = job.lines.find(line => line.id === sourceLineId && line.inProgressQuantity > 0);
      if (!sourceLine || !Number.isInteger(quantity) || quantity <= 0 || quantity > sourceLine.inProgressQuantity || !version || !draft.warehouse) return;
      request = { sourceLineId, completedQuantity: quantity, newVersion: version, targetWarehouse: draft.warehouse ?? "", expectedRevision: job.revision, requestId: createRequestId(key) };
      setPendingDirect((current) => ({ ...current, [job.id]: request }));
    }
    // 同步可能已读到本次完成；确认未知结果时仍原样重放，先于剩余数量校验。
    completing.current = true;
    setBusy(key);
    setNotice(null);
    try {
      await completeDirectUpgrade(role, job.id, request);
      setPendingDirect((current) => { const next = { ...current }; delete next[job.id]; return next; });
      setDirectCompleteDrafts((current) => ({ ...current, [job.id]: { quantity: "", version: request.newVersion } }));
      const refreshed = await refreshAfterWrite().then(() => true, () => false);
      setNotice({ kind: "success", text: `已登记 ${formatNumber(request.completedQuantity)} 件升级完成：${job.sourceVersion} → ${request.newVersion}。${refreshed ? "" : " 页面刷新失败，请刷新页面。"}` });
    } catch (error) {
      const status = (error as ApiError)?.status;
      const rejected = status !== undefined && status >= 400 && status < 500;
      if (rejected) setPendingDirect((current) => { const next = { ...current }; delete next[job.id]; return next; });
      setNotice({ kind: "error", text: rejected ? error instanceof Error ? error.message : String(error) : "本次操作结果尚未确认，请点击“重试确认”。" });
    } finally {
      completing.current = false;
      setBusy(null);
    }
  };


  if(query.isLoading) return <SkeletonTable/>;
  if(query.error) return <><p role="alert">{query.error.message}</p><Notice notice={notice} onClose={()=>setNotice(null)}/></>;
  return <><Panel title="发起在库升级"><div className="form-grid">
    <label className="field"><span>型号</span><select value={directModel} onChange={e=>{setDirectModel(e.target.value);setDirectVersion('');}}><option value="">请选择型号</option>{directModels.map(v=><option key={v}>{v}</option>)}</select></label>
    <label className="field"><span>原版本号</span><select value={directVersion} onChange={e=>setDirectVersion(e.target.value)}><option value="">请选择原版本</option>{directVersions.map(v=><option key={v}>{v}</option>)}</select></label>
    {selectedDirectSource&&<button className="btn btn-primary" disabled={busy!==null||selectedDirectSource.available<=0||['business','alan','logistics'].includes(role)} onClick={()=>void submitDirect()}>锁定全部 {selectedDirectSource.available} 件并发起升级</button>}
    </div></Panel><DirectHistory role={role} overseasWarehouses={overseasWarehouses} jobs={directHistory} drafts={directCompleteDrafts} setDrafts={setDirectCompleteDrafts} busy={busy} pending={pendingDirect} onComplete={finishDirect}/><Notice notice={notice} onClose={()=>setNotice(null)}/></>;
}
function DirectHistory({
  role,
  overseasWarehouses,
  jobs,
  drafts,
  setDrafts,
  busy,
  pending,
  onComplete,
}: {
  role: Role;
  overseasWarehouses: string[];
  jobs: DirectUpgrade[];
  drafts: Record<number, CompleteDraft>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<number, CompleteDraft>>>;
  busy: string | null;
  pending: Record<number, CompletionRequest>;
  onComplete: (job: DirectUpgrade) => Promise<void>;
}) {
  return (
    <Panel title="在库升级记录">
      {jobs.length === 0 ? <EmptyState title="暂无在库升级" /> : jobs.map((job) => {
        const recovery = pending[job.id];
        const draft = recovery
          ? { sourceLineId: recovery.sourceLineId, quantity: String(recovery.completedQuantity), version: recovery.newVersion, warehouse: recovery.targetWarehouse }
          : { sourceLineId: drafts[job.id]?.sourceLineId ?? job.lines.find(line => line.inProgressQuantity > 0)?.id, quantity: drafts[job.id]?.quantity ?? "", version: drafts[job.id]?.version ?? job.newVersion ?? "", warehouse: drafts[job.id]?.warehouse ?? "" };
        const quantity = Number(draft.quantity);
        const selectedLine = job.lines.find(line => line.id === draft.sourceLineId && line.inProgressQuantity > 0);
        const valid = Boolean(selectedLine) && Number.isInteger(quantity) && quantity > 0 && quantity <= selectedLine!.inProgressQuantity && Boolean(draft.version.trim()) && Boolean(draft.warehouse);
        return (
          <article className="upgrade-job" key={job.id}>
            <div className="upgrade-job-head">
              <div><strong className="mono">{job.upgradeNo}</strong><span>{job.model} · {job.sourceVersion}</span></div>
              <Badge label={job.statusText} tone={job.status === "completed" ? "green" : "blue"} />
            </div>
            <div className="upgrade-kpis compact">
              <span>发起时锁定 <strong>{formatNumber(job.initialQuantity)}</strong></span>
              <span>升级完成 <strong>{formatNumber(job.completedQuantity)}</strong></span>
              <span className="primary">升级中（已锁定） <strong>{formatNumber(job.inProgressQuantity)}</strong></span>

              <span>发起岗位 <strong>{ROLE_LABELS[job.initiatedByRole]}</strong></span>
            </div>
            {(job.status === "active" || recovery) && role === "purchasing" && (
              <div className="upgrade-inline-complete direct">
                <select aria-label={`${job.upgradeNo} 完成来源批次`} value={selectedLine?.id ?? (recovery?.sourceLineId ?? "")} disabled={Boolean(recovery) || busy !== null} onChange={event => setDrafts(current => ({...current, [job.id]: {...draft, sourceLineId: Number(event.target.value)}}))}>{!selectedLine&&!recovery&&<option value="">请重新选择实际来源批次</option>}{job.lines.filter(line => line.inProgressQuantity > 0 || line.id === recovery?.sourceLineId).map(line => <option key={line.id} value={line.id}>{line.sourceTeam ? line.sourceTeam + " / " : ""}{line.warehouse || "历史仓库未确定"} / {line.plan} / {line.shipDate} / {line.fnsku}（{line.inProgressQuantity}）</option>)}</select>
                <input aria-label={`${job.upgradeNo} 升级完成数量`} inputMode="numeric" placeholder="所选批次的完成数量" value={draft.quantity} disabled={Boolean(recovery) || busy !== null} onChange={(event) => setDrafts((current) => ({ ...current, [job.id]: { ...draft, quantity: event.target.value } }))} />
                <input aria-label={`${job.upgradeNo} 升级完成版本号`} placeholder="升级完成版本号" value={draft.version} disabled={Boolean(recovery) || busy !== null} onChange={(event) => setDrafts((current) => ({ ...current, [job.id]: { ...draft, version: event.target.value } }))} />
                <select aria-label={`${job.upgradeNo} 目标海外仓`} value={draft.warehouse ?? ""} disabled={Boolean(recovery) || busy !== null} onChange={event => setDrafts(current => ({...current, [job.id]: {...draft, warehouse:event.target.value}}))}><option value="">选择目标海外仓</option>{overseasWarehouses.map(warehouse => <option key={warehouse} value={warehouse}>{warehouse}</option>)}</select>
                          <button className="btn btn-primary" type="button" disabled={(!recovery && !valid) || busy !== null} onClick={() => void onComplete(job)}>{busy === `upgrade-direct-complete-${job.id}` ? "提交中…" : recovery ? "重试确认" : "登记完成并转入新版本"}</button>
                {!recovery&&!selectedLine&&<p className="form-hint">所选批次已由其他操作完成，请重新选择实际来源批次。</p>}
                {!recovery&&selectedLine&&quantity>selectedLine.inProgressQuantity&&<p className="form-hint">所选批次还剩 {selectedLine.inProgressQuantity} 件，请按这批货的实际完成量填写。</p>}
              </div>
            )}
            {job.status === "active" && role !== "purchasing" && <div className="form-hint">等待采购登记完成数量和新版本。</div>}
            <div className="table-wrap">
              <table className="data-table sub">
                <thead><tr><th>型号</th><th>发货计划号</th><th>发货时间</th><th>原版本</th><th>FNSKU</th><th>来源海外仓</th><th className="num">发起时在库</th><th>状态</th><th className="num">升级完成</th><th className="num">升级中</th><th>升级完成版本</th></tr></thead>
                <tbody>{job.lines.map((line) => <tr key={line.id}><td className="mono">{job.model}</td><td className="mono">{line.plan}</td><td className="date-cell">{line.shipDate}</td><td><span className="ver-chip">{line.sourceVersion}</span></td><td className="mono">{line.fnsku}</td><td>{line.warehouse || "历史仓库未确定"}</td><td className="num">{formatNumber(line.initialQuantity)}</td><td><Badge label={line.inProgressQuantity > 0 ? "升级中（已锁定）" : "升级完成"} tone={line.inProgressQuantity > 0 ? "blue" : "green"} /></td><td className="num">{formatNumber(line.completedQuantity)}</td><td className="num strong">{formatNumber(line.inProgressQuantity)}</td><td>{line.completions.map(item => `${item.version} / ${item.warehouse || "历史仓库未确定"}：${item.quantity}`).join("、") || "-"}</td></tr>)}</tbody>
              </table>
            </div>
          </article>
        );
      })}
    </Panel>
  );
}
