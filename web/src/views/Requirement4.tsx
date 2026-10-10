import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  exportUpgradeFlow,
  completeDirectUpgrade,
  completeRelocationUpgrade,
  createDirectUpgrade,
  fetchUpgradeDashboard,
  formatNumber,
  initiateRelocationUpgrade,
  recallInquiry,
  recordRelocationOperation,
  type ApiError,
} from "../api";
import { Badge, displayTime, EmptyState, Notice, Panel, Segmented, SkeletonTable } from "../components/ui";
import { RelocationExternalHistory, RelocationExternalShipments } from "../components/RelocationExternalShipments";
import { RelocationUpdate } from "../components/RelocationUpdate";
import { TransferUpgradeList } from "../components/TransferUpgrade";
import { LingxingSync } from "../components/LingxingSync";
import type { DirectUpgrade, NoticeMessage, RelocationCandidate, RelocationUpgrade, RelocationWorkItem, Role, UpgradeJob } from "../types";
import { useBusinessAction } from "../hooks/useBusinessAction";
import { createRequestId } from "../utils/ids";

type UpgradeMode = "relocation" | "direct" | "transfer";
type PendingRequest = { payloadKey: string; requestId: string };
type CompleteDraft = { sourceLineId?: number; quantity: string; version: string; warehouse?: string; progressing?: string; reversals?: Record<number,string> };
type CompletionRequest = { inProgressQuantity?: number; reversals?: {ledgerId:number;quantity:number}[]; sourceLineId?: number; completedQuantity: number; newVersion: string; targetWarehouse: string; expectedRevision: number; requestId: string };
type OperationDraft = { orderNo: string; sourceKey: string };

function workSourceKey(work: RelocationWorkItem) {
  return `${work.sourceKind}:${work.allocationId ?? work.inquiryId ?? work.fbaArchiveId}:${work.removalOrderNo ?? ''}:${work.fnsku}:${work.operationAt ?? ''}`;
}

const ROLE_LABELS: Record<Role, string> = {
  admin: "管理员",
  "assistant-1": "助理-一团",
  "assistant-2": "助理-二团",
  "operation-1": "运营·一团",
  "operation-2": "运营·二团",
  purchasing: "采购", logistics: "物流", alan: "Alan",
  business: "商务",
};

function requestFor(ref: React.MutableRefObject<PendingRequest | null>, prefix: string, payload: unknown): string {
  const payloadKey = JSON.stringify(payload);
  if (ref.current?.payloadKey === payloadKey) return ref.current.requestId;
  const requestId = createRequestId(prefix);
  ref.current = { payloadKey, requestId };
  return requestId;
}

function directJobs(rows: UpgradeJob[]): DirectUpgrade[] {
  return rows.filter((row): row is DirectUpgrade => row.kind === "direct");
}

function relocationJobs(rows: UpgradeJob[]): RelocationUpgrade[] {
  return rows.filter((row): row is RelocationUpgrade => row.kind === "relocation");
}

type RelocationSource = RelocationCandidate | RelocationWorkItem | RelocationUpgrade;
function candidateKey(row: RelocationSource): string {
  return `${row.sourceKind}:${row.allocationId ?? row.inquiryId ?? row.fbaArchiveId}`;
}

export function Requirement4View({ role }: { role: Role }) {
  const [fbaAccount,setFbaAccount]=useState("");
  const [automaticSync,setAutomaticSync]=useState<Record<number,string>>({});
  const [mode, setMode] = useState<UpgradeMode>("relocation");
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const completing = useRef(false);
  const [relocationModel, setRelocationModel] = useState("");
  const [relocationVersion, setRelocationVersion] = useState("");
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null);
  const [directModel, setDirectModel] = useState("");
  const [directVersion, setDirectVersion] = useState("");
  const [directCompleteDrafts, setDirectCompleteDrafts] = useState<Record<number, CompleteDraft>>({});
  const [relocationCompleteDrafts, setRelocationCompleteDrafts] = useState<Record<number, CompleteDraft>>({});
  const [pendingDirect, setPendingDirect] = useState<Record<number, CompletionRequest>>({});
  const [pendingRelocation, setPendingRelocation] = useState<Record<number, CompletionRequest>>({});
  const [operationDrafts, setOperationDrafts] = useState<Record<number, OperationDraft>>({});
  const relocationRequest = useRef<PendingRequest | null>(null);
  const directRequest = useRef<PendingRequest | null>(null);
  const completionRequests = useRef(new Map<string, PendingRequest>());
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["upgrades", role],
    queryFn: () => fetchUpgradeDashboard(role),
  });


  useEffect(() => {
    setNotice(null);
    setAutomaticSync({});
    setFbaAccount("");
    setBusy(null);
    setSelectedSourceKey(null);
    setRelocationModel("");
    setRelocationVersion("");
    setDirectModel("");
    setDirectVersion("");
    setDirectCompleteDrafts({});
    setRelocationCompleteDrafts({});
    setPendingDirect({});
    setPendingRelocation({});
    setOperationDrafts({});
    relocationRequest.current = null;
    directRequest.current = null;
    completionRequests.current.clear();
  }, [role]);

  const dashboard = query.data;
  const sources = useMemo(() => {
    const map = new Map<string, RelocationSource>();
    for (const row of [...(dashboard?.relocationWorkItems ?? []), ...relocationJobs(dashboard?.upgrades ?? []), ...(dashboard?.relocationCandidates ?? [])]) map.set(candidateKey(row), row);
    return [...map.values()];
  }, [dashboard]);
  const relocationModels = useMemo(
    () => [...new Set(sources.map((row) => row.model))],
    [sources],
  );
  const relocationVersions = useMemo(
    () => [...new Set(sources.filter((row) => !relocationModel || row.model === relocationModel).map((row) => row.sourceVersion))],
    [sources, relocationModel],
  );
  const visibleCandidates = useMemo(
    () => sources.filter((row) => (!relocationModel || row.model === relocationModel) && (!relocationVersion || row.sourceVersion === relocationVersion)),
    [sources, relocationModel, relocationVersion],
  );
  const selectedSource = visibleCandidates.find(row => candidateKey(row) === selectedSourceKey) ?? sources.find(row => candidateKey(row) === selectedSourceKey) ?? visibleCandidates[0] ?? null;
  const selectedKey = selectedSource ? candidateKey(selectedSource) : null;
  const selectedCandidate = dashboard?.relocationCandidates.find(row => candidateKey(row) === selectedKey) ?? null;
  const directModels = useMemo(
    () => [...new Set((dashboard?.directSources ?? []).map((row) => row.model))],
    [dashboard],
  );
  const directVersions = useMemo(
    () => [...new Set((dashboard?.directSources ?? []).filter((row) => !directModel || row.model === directModel).map((row) => row.sourceVersion))],
    [dashboard, directModel],
  );
  const selectedDirectSource = dashboard?.directSources.find((row) => row.model === directModel && row.sourceVersion === directVersion) ?? null;
  const relocationWorkItems = dashboard?.relocationWorkItems ?? [];
  const relocationHistory = relocationJobs(dashboard?.upgrades ?? []);
  const directHistory = directJobs(dashboard?.upgrades ?? []);

  const refreshAfterWrite = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["upgrades"] }),
      queryClient.invalidateQueries({ queryKey: ["inventory"] }),
      queryClient.invalidateQueries({ queryKey: ["allocations"] }),
      queryClient.invalidateQueries({ queryKey: ["audit"] }),
      queryClient.invalidateQueries({ queryKey: ["approvals"] }),
    ]);
  };

  const chooseCandidate = (candidate: RelocationSource) => {
    setFbaAccount("");
    setSelectedSourceKey(candidateKey(candidate));
    relocationRequest.current = null;
  };

  const submitRelocation = async () => {
    if (!selectedCandidate || busy || role === "business" || role === "alan") return;
    const payload = selectedCandidate.sourceKind === "fba" ? {fbaArchiveId:selectedCandidate.fbaArchiveId!,account:fbaAccount} : selectedCandidate.sourceKind === "inquiry"
      ? { inquiryId: selectedCandidate.inquiryId!, sourceRevision: selectedCandidate.inquiryRecall?.revision }
      : { allocationId: selectedCandidate.allocationId! };
    const requestId = requestFor(relocationRequest, "upgrade-relocation-initiate", { role, ...payload });
    setBusy("relocation-initiate");
    setNotice(null);
    try {
      await initiateRelocationUpgrade(role, { ...payload, requestId });
      relocationRequest.current = null;
      await refreshAfterWrite();
      setNotice({ kind: "success", text: "移仓升级已发起。" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const submitOperation = async (work: RelocationWorkItem) => {
    const draft = operationDrafts[work.id]?.sourceKey === workSourceKey(work) ? operationDrafts[work.id] : { orderNo: "", sourceKey:workSourceKey(work) };
    if (!draft.orderNo.trim() || busy) return;
    const key = `relocation-operation-${work.id}`;
    const payload = { removalOrderNo: draft.orderNo.trim(), expectedRevision: work.revision };
    const requestId = completionRequestId(key, { role, ...payload });
    setBusy(key); setNotice(null);
    try {
      const result=await recordRelocationOperation(role, work.id, { ...payload, requestId });
      if(result.automaticSync)setAutomaticSync(current=>({...current,[work.id]:result.automaticSync!.requestId}));
      completionRequests.current.delete(key);
      await refreshAfterWrite();
      setNotice({ kind: "success", text: `${work.workNo} 的订单号已保存；已自动发起领星同步，结果请查看同步按钮。` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  };

  const submitDirect = async () => {
    if (!selectedDirectSource || selectedDirectSource.available <= 0 || busy || role === "business" || role === "alan") return;
    const payload = { model: selectedDirectSource.model, sourceVersion: selectedDirectSource.sourceVersion };
    const requestId = requestFor(directRequest, "upgrade-direct", { role, ...payload });
    setBusy("direct-create");
    setNotice(null);
    try {
      await createDirectUpgrade(role, { ...payload, requestId });
      directRequest.current = null;
      await refreshAfterWrite();
      setNotice({ kind: "success", text: `已锁定 ${formatNumber(selectedDirectSource.available)} 件可用库存，等待采购登记升级完成数量。` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const completionRequestId = (key: string, payload: unknown) => {
    const payloadKey = JSON.stringify(payload);
    const previous = completionRequests.current.get(key);
    if (previous?.payloadKey === payloadKey) return previous.requestId;
    const requestId = createRequestId(key);
    completionRequests.current.set(key, { payloadKey, requestId });
    return requestId;
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
      setNotice({ kind: "success", text: `已将 ${formatNumber(request.completedQuantity)} 件从 ${job.sourceVersion} 转入 ${request.newVersion}；型号在库总量不变。${refreshed ? "" : "已保存，但页面刷新失败，请重新加载查看。"}` });
    } catch (error) {
      const status = (error as ApiError)?.status;
      const rejected = status !== undefined && status >= 400 && status < 500;
      if (rejected) setPendingDirect((current) => { const next = { ...current }; delete next[job.id]; return next; });
      setNotice({ kind: "error", text: `${error instanceof Error ? error.message : String(error)}${rejected ? "" : " 请点击“重试确认”查看这笔完成记录的结果。"}` });
    } finally {
      completing.current = false;
      setBusy(null);
    }
  };

  const finishRelocation = async (job: RelocationUpgrade, relocationId: number, revision: number) => {
    if (busy || completing.current) return;
    const row=job.relocations.find(item=>item.id===relocationId)!;
    const draft = relocationCompleteDrafts[relocationId] ?? { quantity: String(row.completedQuantity), progressing:String(row.inProgressQuantity), version: row.newVersion ?? "" };
    const key = `upgrade-relocation-complete-${relocationId}`;
    let request = pendingRelocation[relocationId];
    if (!request) {
      const quantity = Number(draft.quantity);
      const version = draft.version.trim();
      const progressing=Number(draft.progressing??row.inProgressQuantity);
      if (draft.quantity.trim()==='' || !Number.isInteger(quantity) || quantity<0 || !Number.isInteger(progressing) || progressing<0 || quantity+progressing>row.shippedQuantity || (quantity>row.completedQuantity && (!version || !draft.warehouse))) return;
      request = { inProgressQuantity:progressing, reversals:Object.entries(draft.reversals??{}).filter(([,value])=>value.trim()!==""&&Number(value)!==0).map(([ledgerId,value])=>({ledgerId:Number(ledgerId),quantity:Number(value)})), completedQuantity: quantity, newVersion: version, targetWarehouse: draft.warehouse ?? "", expectedRevision: revision, requestId: createRequestId(key) };
      setPendingRelocation((current) => ({ ...current, [relocationId]: request }));
    }
    completing.current = true;
    setBusy(key);
    setNotice(null);
    try {
      await completeRelocationUpgrade(role, relocationId, request);
      setPendingRelocation((current) => { const next = { ...current }; delete next[relocationId]; return next; });
      setRelocationCompleteDrafts((current) => ({ ...current, [relocationId]: { quantity: String(request.completedQuantity), progressing:String(request.inProgressQuantity), version: request.newVersion } }));
      const refreshed = await refreshAfterWrite().then(() => true, () => false);
      setNotice({ kind: "success", text: `已保存累计升级完 ${formatNumber(request.completedQuantity)} 件及升级中 ${request.inProgressQuantity} 件。${refreshed ? "" : "已保存，但页面刷新失败，请重新加载查看。"}` });
    } catch (error) {
      const status = (error as ApiError)?.status;
      const rejected = status !== undefined && status >= 400 && status < 500;
      if (rejected) setPendingRelocation((current) => { const next = { ...current }; delete next[relocationId]; return next; });
      setNotice({ kind: "error", text: `${error instanceof Error ? error.message : String(error)}${rejected ? "" : " 请点击“重试确认”查看这笔完成记录的结果。"}` });
    } finally {
      completing.current = false;
      setBusy(null);
    }
  };

  if (query.isLoading) return <Panel><SkeletonTable rows={7} cols={8} /></Panel>;
  if (query.isError && !query.data) {
    return <Panel><EmptyState title="升级库存加载失败" hint={query.error instanceof Error ? query.error.message : String(query.error)} action={<button className="btn btn-ghost" type="button" onClick={() => void query.refetch()}>重试</button>} /></Panel>;
  }

  return (
    <div className="upgrade-page">
      {query.isError && <div className="callout callout-danger" role="alert">升级库存刷新失败，保留当前填写内容，连接恢复后自动更新。{query.error.message}</div>}
      <Panel>
        <Segmented
          role="tablist"
          ariaLabel="升级业务类型"
          value={mode}
          onChange={setMode}
          items={[
            { value: "relocation", label: "移仓升级" },
            { value: "direct", label: "在库升级" },
            { value: "transfer", label: "转仓升级" },
          ]}
        />
      </Panel>

      {mode === "transfer" ? <TransferUpgradeList role={role} /> : mode === "relocation" ? (
        <div className="relocation-board">
          <Panel title="升级来源" className="relocation-source-panel" actions={['admin','purchasing','logistics'].includes(role)?<button className="btn btn-ghost btn-sm" onClick={()=>void exportUpgradeFlow(role,'relocation',{model:relocationModel,version:relocationVersion,source:selectedKey??''}).catch(error=>setNotice({kind:'error',text:error.message}))}>导出移仓数据流</button>:undefined}>
            <div className="form-grid upgrade-filter">
              <label className="field"><span>型号</span><select value={relocationModel} onChange={event => { setRelocationModel(event.target.value); setRelocationVersion(""); setSelectedSourceKey(null); }}><option value="">全部型号</option>{relocationModels.map(value => <option key={value}>{value}</option>)}</select></label>
              <label className="field"><span>原版本号</span><select value={relocationVersion} onChange={event => { setRelocationVersion(event.target.value); setSelectedSourceKey(null); }}><option value="">全部版本</option>{relocationVersions.map(value => <option key={value}>{value}</option>)}</select></label>
            </div>
            <div className="upgrade-candidate-table"><table className="data-table"><thead><tr><th>来源单号</th><th>型号 / 版本</th><th>来源数量</th><th>来源剩余可移仓量</th></tr></thead><tbody>{visibleCandidates.map(row => <tr key={candidateKey(row)} className={selectedKey === candidateKey(row) ? "row-expanded" : undefined}>
              <td><button className="link-btn source-select" type="button" onClick={() => chooseCandidate(row)}>{row.documentNo}</button><div className="muted">{row.sourceKind === "fba" ? "直发FBA" : row.sourceKind === "inquiry" ? "询库" : "调拨"}</div></td><td><strong>{row.model}</strong><div>{row.sourceVersion}</div></td><td>{formatNumber(row.initialQuantity)}</td><td>{row.fbaRemainingQuantity === null ? "—" : formatNumber(row.fbaRemainingQuantity)}</td>
            </tr>)}</tbody></table></div>{!visibleCandidates.length && <EmptyState title="暂无对应来源" />}
          </Panel>
          <div className="relocation-documents">
            {role==="logistics"&&<RelocationUpdate role={role} onRefresh={refreshAfterWrite}/> }
            {selectedSource && <Panel title={selectedSource.documentNo + " · " + selectedSource.model} actions={selectedCandidate && role !== "business" && role !== "alan" ? <button className="btn btn-primary btn-sm" type="button" disabled={busy !== null || (selectedCandidate?.sourceKind === "fba" && !fbaAccount)} onClick={() => void submitRelocation()}>{busy === "relocation-initiate" ? "发起中…" : "发起移仓升级"}</button> : undefined}>
              {selectedCandidate?.sourceKind==='fba' && <label className="field"><span>本次移仓账号</span><select aria-label="本次移仓账号" value={fbaAccount} onChange={e=>setFbaAccount(e.target.value)}><option value="">请选择账号</option>{dashboard?.relocationAccounts.map(item=><option key={item.store} value={item.store}>{item.account} / {item.store}</option>)}</select></label>}
              <InquiryRecall key={`${selectedKey}-${role}`} source={selectedSource} role={role} onRefresh={refreshAfterWrite} onNotice={setNotice} />
              <dl className="relocation-fields">{[
                ["来源 FNSKU", selectedSource.fnsku], ["原版本", selectedSource.sourceVersion], ["ASIN", selectedSource.asin || "—"], ["发货计划号", selectedSource.plan], ["发货时间", selectedSource.shipDate],
                ["已用数量", selectedSource.fbaRemainingQuantity == null ? "—" : formatNumber(selectedSource.initialQuantity - selectedSource.fbaRemainingQuantity)],
                ["来源资格", selectedSource.sourceKind === "fba" ? "直发FBA：不受 90 天限制" : selectedSource.sourceKind === "inquiry" ? "询库来源：不受 90 天限制" : new Date(selectedSource.confirmedAt).getTime() >= Date.now() - 90 * 86400000 ? "近 90 天" : "超过 90 天"], ["店铺", selectedSource.store], ["团队", selectedSource.department]
              ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}</dl>
            </Panel>}
            <RelocationWorkflow role={role} rows={relocationWorkItems.filter(row => candidateKey(row) === selectedKey)} operationDrafts={operationDrafts} setOperationDrafts={setOperationDrafts} busy={busy} onOperation={submitOperation} onRefresh={refreshAfterWrite} automaticSync={automaticSync} />
            <RelocationHistory role={role} warehouses={dashboard?.overseasWarehouses ?? []} jobs={relocationHistory.filter(row => candidateKey(row) === selectedKey)} drafts={relocationCompleteDrafts} setDrafts={setRelocationCompleteDrafts} busy={busy} pending={pendingRelocation} onComplete={finishRelocation} onRefresh={refreshAfterWrite} />
          </div>
        </div>
      ) : (
        <>
          <Panel title="发起在库升级">
            <div className="form-grid upgrade-filter">
              <label className="field">
                <span>型号</span>
                <select value={directModel} onChange={(event) => { setDirectModel(event.target.value); setDirectVersion(""); directRequest.current = null; }}>
                  <option value="">请选择型号</option>
                  {directModels.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="field">
                <span>原版本号</span>
                <select value={directVersion} onChange={(event) => { setDirectVersion(event.target.value); directRequest.current = null; }} disabled={!directModel}>
                  <option value="">请选择原版本</option>
                  {directVersions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            </div>
            {selectedDirectSource && (
              <>
                <div className="upgrade-kpis">
                  <span>在库 <strong>{formatNumber(selectedDirectSource.inStock)}</strong></span>
                  <span>调拨锁定 <strong>{formatNumber(selectedDirectSource.allocationLocked)}</strong></span>
                  <span>升级锁定 <strong>{formatNumber(selectedDirectSource.upgradeLocked)}</strong></span>
                  <span className="primary">本次可锁 <strong>{formatNumber(selectedDirectSource.available)}</strong></span>
                </div>
                <div className="form-footer">
                  {role !== "alan" && <button className="btn btn-primary" type="button" disabled={selectedDirectSource.available <= 0 || busy !== null || role === "business"} onClick={() => void submitDirect()}>{busy === "direct-create" ? "锁定中…" : `锁定全部 ${formatNumber(selectedDirectSource.available)} 件并发起升级`}</button>}
                </div>
              </>
            )}
          </Panel>

          <DirectHistory role={role} warehouses={dashboard?.overseasWarehouses ?? []} jobs={directHistory} drafts={directCompleteDrafts} setDrafts={setDirectCompleteDrafts} busy={busy} pending={pendingDirect} onComplete={finishDirect} />
        </>
      )}
      <Notice notice={notice} onClose={() => setNotice(null)} />
    </div>
  );
}

function InquiryRecall({ source, role, onRefresh, onNotice }: { source: RelocationSource; role: Role; onRefresh: () => Promise<unknown>; onNotice: (notice: NoticeMessage) => void }) {
  const action = useBusinessAction(onRefresh, text => onNotice({ kind: "success", text }));
  if (!source.inquiryRecall || source.inquiryId == null || !["purchasing", "logistics", "business"].includes(role)) return null;
  const target = ["purchasing", "logistics"].includes(role) ? "待Alan或采购回复" : "待商务审核";
  const recall = () => {
    const payload = { expectedRevision: source.inquiryRecall!.revision, requestId: createRequestId("inquiry-recall") };
    void action.perform({ execute: () => recallInquiry(role, source.inquiryId!, payload), message: "询库已回撤至" + target + "。" });
  };
  return <div className="inquiry-recall">
    <button type="button" className="btn btn-ghost btn-sm" disabled={action.disabled || source.inquiryRecall.blockers.length > 0} onClick={recall}>回撤至{target}</button>
    {source.inquiryRecall.blockers.length > 0 && <p className="field-error" role="alert">不能回撤，已产生下游关联：{source.inquiryRecall.blockers.map(item => item.type + " " + item.number + "（" + item.status + "）").join("；")}</p>}
    {action.error && <p className="field-error" role="alert">{action.error}</p>}
    {action.uncertain && <button className="btn btn-primary btn-sm" type="button" disabled={action.busy} onClick={() => void action.perform()}>重试确认</button>}
  </div>;
}

function RelocationWorkflow({role,rows,operationDrafts,setOperationDrafts,busy,onOperation,onRefresh,automaticSync}: {
  role:Role;rows:RelocationWorkItem[];operationDrafts:Record<number,OperationDraft>;setOperationDrafts:React.Dispatch<React.SetStateAction<Record<number,OperationDraft>>>;busy:string|null;onOperation:(work:RelocationWorkItem)=>Promise<void>;onRefresh:()=>Promise<unknown>;automaticSync:Record<number,string>;
}) {
  return <div>{rows.map(work=>{
    const operation=operationDrafts[work.id]?.sourceKey===workSourceKey(work)?operationDrafts[work.id]:{orderNo:'',sourceKey:workSourceKey(work)};
    return <article className="relocation-document" key={work.id} data-relocation-work-id={work.id}>
      <header className="relocation-document-head"><strong>{work.workNo}</strong><span>{work.statusText}</span>{work.removalOrderNo&&<LingxingSync role={role} target={{action:'logistics',workId:work.id}} initialRequestId={automaticSync[work.id]} onSynced={onRefresh}/>}</header>
      <dl className="relocation-fields"><div><dt>来源剩余可移仓量</dt><dd>{formatNumber(work.fbaRemainingQuantity??0)}</dd></div><div><dt>账号</dt><dd>{work.store}</dd></div><div><dt>发起岗位</dt><dd>{ROLE_LABELS[work.initiatedByRole]}</dd></div><div><dt>RMA</dt><dd>{work.rma||'—'}</dd></div><div><dt>原始移仓地址</dt><dd style={{whiteSpace:'pre-wrap'}}>{work.originalRelocationAddress||'—'}</dd></div><div><dt>加工后移仓地址</dt><dd style={{whiteSpace:'pre-wrap'}}>{work.relocationAddress||'—'}</dd></div><div><dt>订单号</dt><dd>{work.removalOrderNo||'—'}</dd></div></dl>
      {work.status==='awaiting_procurement'&&<p>待物流通过更新模板填写 RMA 和原始移仓地址。</p>}
      {work.status==='awaiting_operation'&&['operation-1','operation-2'].includes(role)&&<div className="upgrade-inline-complete"><input aria-label={work.workNo+' 移除订单号'} value={operation.orderNo} placeholder="订单号" onChange={e=>setOperationDrafts(current=>({...current,[work.id]:{...operation,orderNo:e.target.value}}))}/><button className="btn btn-primary" disabled={busy!==null||!operation.orderNo.trim()} onClick={()=>void onOperation(work)}>保存订单号</button></div>}
      <RelocationExternalShipments workNo={work.workNo} rows={work.externalShipments??[]} selected={{}} disabled readOnly onChange={()=>{}}/>
    </article>;
  })}</div>;
}

function RelocationHistory({role,warehouses,jobs,drafts,setDrafts,busy,pending,onComplete,onRefresh}: {
  role:Role;warehouses:string[];jobs:RelocationUpgrade[];drafts:Record<number,CompleteDraft>;setDrafts:React.Dispatch<React.SetStateAction<Record<number,CompleteDraft>>>;busy:string|null;pending:Record<number,CompletionRequest>;onComplete:(job:RelocationUpgrade,id:number,revision:number)=>Promise<void>;onRefresh:()=>Promise<unknown>;
}) {
  return <div>{jobs.flatMap(job=>job.relocations.map(row=>{
    const recovery=pending[row.id],saved=drafts[row.id];
    const draft:CompleteDraft=recovery?{quantity:String(recovery.completedQuantity),progressing:String(recovery.inProgressQuantity),version:recovery.newVersion,warehouse:recovery.targetWarehouse,reversals:Object.fromEntries((recovery.reversals??[]).map(item=>[item.ledgerId,String(item.quantity)]))}:saved??{quantity:String(row.completedQuantity),progressing:String(row.inProgressQuantity),version:row.newVersion??'',warehouse:''};
    const quantity=Number(draft.quantity),progressing=Number(draft.progressing),decrease=row.completedQuantity-quantity;
    const returns=Object.entries(draft.reversals??{}).filter(([,v])=>v.trim()!==''&&Number(v)!==0);
    const issue=draft.quantity.trim()===''||draft.progressing?.trim()===''||!Number.isInteger(quantity)||quantity<0||!Number.isInteger(progressing)||progressing<0?'升级中数量和累计升级完数量须为非负整数。':quantity+progressing>row.shippedQuantity?'升级中数量＋升级完数量不能超过已发货 '+row.shippedQuantity+'。':decrease<0&&(!draft.version.trim()||!draft.warehouse)?'新增入库须填写升级完版本号并选择实际仓库。':decrease>0&&(returns.some(([id,v])=>!Number.isInteger(Number(v))||Number(v)<=0||!!row.receiptBatches.find(r=>r.ledgerId===Number(id))?.issue)||returns.reduce((sum,[,v])=>sum+Number(v),0)!==decrease)?'请选择未被占用的本单入库批次，扣回合计须为 '+decrease+'。':'';
    const update=(patch:Partial<CompleteDraft>)=>setDrafts(current=>({...current,[row.id]:{...draft,...patch}}));
    return <article className="relocation-document" key={row.id} data-relocation-id={row.id}>
      <header className="relocation-document-head"><strong>{row.relocationNo}</strong><span>{job.statusText}</span>{row.status==='active'&&row.workId&&<LingxingSync role={role} target={{action:'logistics',workId:row.workId}} onSynced={onRefresh}/>}</header>
      <dl className="relocation-fields">{[['来源剩余可移仓量',job.fbaRemainingQuantity],['移仓-已发货数量',row.shippedQuantity],['升级中数量',row.inProgressQuantity],['升级完数量',row.completedQuantity],['尚未开始升级',row.shippedQuantity-row.inProgressQuantity-row.completedQuantity],['历史其他减少',row.soldQuantity],['RMA',row.rma],['原始移仓地址',row.originalRelocationAddress],['加工后移仓地址',row.relocationAddress],['订单号',row.removalOrderNo],['承运商',row.carrier],['运单号',row.trackingNo]].map(([label,value])=><div key={label}><dt>{label}</dt><dd style={{whiteSpace:'pre-wrap'}}>{value}</dd></div>)}</dl>
      {row.completions.length>0&&<p>入库记录：{row.completions.map(item=>item.version+' / '+item.warehouse+'：'+item.quantity).join('、')}</p>}<RelocationExternalHistory items={row.externalItems??[]}/><RelocationExternalShipments workNo={row.relocationNo} rows={row.externalShipments??[]} selected={{}} disabled readOnly onChange={()=>{}}/>
      {row.status==='active'&&['purchasing','logistics'].includes(role)&&<div className="upgrade-inline-complete"><label className="field"><span>升级中数量</span><input aria-label={row.relocationNo+' 升级中数量'} value={draft.progressing} disabled={!!recovery||busy!==null} onChange={e=>update({progressing:e.target.value})}/></label><label className="field"><span>升级完数量（累计）</span><input aria-label={row.relocationNo+' 升级完数量'} value={draft.quantity} disabled={!!recovery||busy!==null} onChange={e=>update({quantity:e.target.value})}/></label><label className="field"><span>升级完，版本号</span><input aria-label={row.relocationNo+' 升级完成版本号'} value={draft.version} disabled={!!recovery||busy!==null} onChange={e=>update({version:e.target.value})}/></label><label className="field"><span>本次新增入库实际仓库</span><select aria-label={row.relocationNo+' 目标海外仓'} value={draft.warehouse??''} disabled={!!recovery||busy!==null} onChange={e=>update({warehouse:e.target.value})}><option value="">请选择</option>{warehouses.map(w=><option key={w}>{w}</option>)}</select></label><p className="form-hint">升级中＋升级完≤已发货；减少累计量时，指定下表入库批次扣回。</p>
        {issue&&<p className="dialog-error" role="alert">{issue}</p>}
        <button className="btn btn-primary" disabled={(!recovery&&!!issue)||busy!==null} onClick={()=>void onComplete(job,row.id,row.revision)}>{recovery?'重试确认':'保存升级数量'}</button></div>}
      <div className="table-wrap"><table className="data-table" aria-label={row.relocationNo+' 入库批次'}><thead><tr><th>入库批次</th><th>版本</th><th>实际仓库</th><th>有效入库量</th><th>当前占用</th><th>本次扣回</th></tr></thead><tbody>{row.receiptBatches.map(receipt=><tr key={receipt.ledgerId}><td>{receipt.batchKey}</td><td>{receipt.version}</td><td>{receipt.warehouse}</td><td>{receipt.quantity}</td><td>{receipt.issue||'无'}</td><td>{decrease>0&&['purchasing','logistics'].includes(role)&&<input aria-label={'扣回 '+receipt.batchKey} disabled={!!receipt.issue||!!recovery||busy!==null} value={draft.reversals?.[receipt.ledgerId]??''} onChange={e=>update({reversals:{...draft.reversals,[receipt.ledgerId]:e.target.value}})}/>}</td></tr>)}</tbody></table></div>
    </article>;
  }))}</div>;
}

function DirectHistory({
  role,
  warehouses,
  jobs,
  drafts,
  setDrafts,
  busy,
  pending,
  onComplete,
}: {
  role: Role;
  warehouses: string[];
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
              <span>初始锁定 <strong>{formatNumber(job.initialQuantity)}</strong></span>
              <span>升级完成 <strong>{formatNumber(job.completedQuantity)}</strong></span>
              <span className="primary">升级中 / 锁定 <strong>{formatNumber(job.inProgressQuantity)}</strong></span>

              <span>发起岗位 <strong>{ROLE_LABELS[job.initiatedByRole]}</strong></span>
            </div>
            {(job.status === "active" || recovery) && ["purchasing", "logistics"].includes(role) && (
              <div className="upgrade-inline-complete direct">
                <select aria-label={`${job.upgradeNo} 完成来源批次`} value={selectedLine?.id ?? (recovery?.sourceLineId ?? "")} disabled={Boolean(recovery) || busy !== null} onChange={event => setDrafts(current => ({...current, [job.id]: {...draft, sourceLineId: Number(event.target.value)}}))}>{!selectedLine&&!recovery&&<option value="">请重新选择实际来源批次</option>}{job.lines.filter(line => line.inProgressQuantity > 0 || line.id === recovery?.sourceLineId).map(line => <option key={line.id} value={line.id}>{line.sourceTeam ? line.sourceTeam + " / " : ""}{line.warehouse || "历史仓库未确定"} / {line.plan} / {line.shipDate} / {line.fnsku}（{line.inProgressQuantity}）</option>)}</select>
                <input aria-label={`${job.upgradeNo} 升级完成数量`} inputMode="numeric" placeholder="所选批次的完成数量" value={draft.quantity} disabled={Boolean(recovery) || busy !== null} onChange={(event) => setDrafts((current) => ({ ...current, [job.id]: { ...draft, quantity: event.target.value } }))} />
                <input aria-label={`${job.upgradeNo} 升级完成版本号`} placeholder="升级完成版本号" value={draft.version} disabled={Boolean(recovery) || busy !== null} onChange={(event) => setDrafts((current) => ({ ...current, [job.id]: { ...draft, version: event.target.value } }))} />
                <select aria-label={`${job.upgradeNo} 目标海外仓`} value={draft.warehouse ?? ""} disabled={Boolean(recovery) || busy !== null} onChange={event => setDrafts(current => ({...current, [job.id]: {...draft, warehouse:event.target.value}}))}><option value="">选择目标海外仓</option>{warehouses.map(warehouse => <option key={warehouse} value={warehouse}>{warehouse}</option>)}</select>
                          <button className="btn btn-primary" type="button" disabled={(!recovery && !valid) || busy !== null} onClick={() => void onComplete(job)}>{busy === `upgrade-direct-complete-${job.id}` ? "提交中…" : recovery ? "重试确认" : "登记完成并转入新版本"}</button>
                {!recovery&&!selectedLine&&<p className="form-hint">所选批次已由其他操作完成，请重新选择实际来源批次。</p>}
                {!recovery&&selectedLine&&quantity>selectedLine.inProgressQuantity&&<p className="form-hint">所选批次还剩 {selectedLine.inProgressQuantity} 件，请按这批货的实际完成量填写。</p>}
              </div>
            )}
            {job.status === "active" && !["purchasing", "logistics"].includes(role) && <div className="form-hint">等待采购登记完成数量和新版本。</div>}
            <div className="table-wrap">
              <table className="data-table sub">
                <thead><tr><th>型号</th><th>发货计划号</th><th>发货时间</th><th>原版本</th><th>已贴 FNSKU</th><th>来源海外仓</th><th className="num">发起时在库</th><th>状况</th><th className="num">升级完成</th><th className="num">升级中</th><th>升级完成版本</th></tr></thead>
                <tbody>{job.lines.map((line) => <tr key={line.id}><td className="mono">{job.model}</td><td className="mono">{line.plan}</td><td className="date-cell">{line.shipDate}</td><td><span className="ver-chip">{line.sourceVersion}</span></td><td className="mono">{line.fnsku}</td><td>{line.warehouse || "历史仓库未确定"}</td><td className="num">{formatNumber(line.initialQuantity)}</td><td><Badge label={line.inProgressQuantity > 0 ? "升级中，预锁定" : "升级完成"} tone={line.inProgressQuantity > 0 ? "blue" : "green"} /></td><td className="num">{formatNumber(line.completedQuantity)}</td><td className="num strong">{formatNumber(line.inProgressQuantity)}</td><td>{line.completions.map(item => `${item.version} / ${item.warehouse || "历史仓库未确定"}：${item.quantity}`).join("、") || "-"}</td></tr>)}</tbody>
              </table>
            </div>
          </article>
        );
      })}
    </Panel>
  );
}
