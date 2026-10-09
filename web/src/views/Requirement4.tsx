import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  completeDirectUpgrade,
  completeRelocationUpgrade,
  createDirectUpgrade,
  fetchUpgradeDashboard,
  formatNumber,
  initiateRelocationUpgrade,
  recallInquiry,
  recordRelocationOperation,
  recordRelocationProcurement,
  shipRelocationUpgrade,
  type ApiError,
} from "../api";
import { Badge, displayTime, EmptyState, Notice, Panel, Segmented, SkeletonTable } from "../components/ui";
import { RelocationExternalHistory, RelocationExternalShipments } from "../components/RelocationExternalShipments";
import { LingxingSync } from "../components/LingxingSync";
import type { DirectUpgrade, NoticeMessage, RelocationCandidate, RelocationUpgrade, RelocationWorkItem, Role, UpgradeJob } from "../types";
import { useBusinessAction } from "../hooks/useBusinessAction";
import { createRequestId } from "../utils/ids";

type UpgradeMode = "relocation" | "direct";
type PendingRequest = { payloadKey: string; requestId: string };
type CompleteDraft = { sourceLineId?: number; quantity: string; version: string; warehouse?: string };
type CompletionRequest = { sourceLineId?: number; completedQuantity: number; newVersion: string; targetWarehouse: string; expectedRevision: number; requestId: string };
type ProcurementDraft = { rma: string; address: string; sourceKey: string };
type OperationDraft = { orderNo: string; sourceKey: string };
type ShippingDraft = { fba: string; external?: Record<number, string>; sourceKey: string };

function workSourceKey(work: RelocationWorkItem) {
  return `${work.sourceKind}:${work.allocationId ?? work.inquiryId ?? work.fbaArchiveId}:${work.removalOrderNo ?? ''}:${work.fnsku}:${work.operationAt ?? ''}`;
}

function currentShippingDraft(work: RelocationWorkItem, drafts: Record<number, ShippingDraft>): ShippingDraft {
  const sourceKey = workSourceKey(work);
  return drafts[work.id]?.sourceKey === sourceKey ? drafts[work.id] : {fba: "", sourceKey};
}

function shippingValues(work: RelocationWorkItem, draft: ShippingDraft) {
  const externalItems = Object.entries(draft.external ?? {}).map(([lineId, quantity]) => ({lineId:Number(lineId), quantity:Number(quantity)}));
  const rows = work.externalShipments ?? [];
  const selected = externalItems.map(item => rows.find(row => row.lineId === item.lineId));
  const shipped = externalItems.reduce((sum,item) => sum+item.quantity,0);
  const fba = Number(draft.fba);
  const valid = draft.fba.trim() !== "" && Number.isInteger(fba) && fba >= 0 && shipped > 0 && shipped+fba <= work.sourceQuantityBefore
    && externalItems.every((item,index) => Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= (selected[index]?.availableQuantity ?? 0));
  let issue = "";
  if (!rows.length) issue = "尚未取得可采纳包裹，请核对订单号和 FNSKU 后同步领星物流。";
  else if (externalItems.some((item,index) => item.quantity > (selected[index]?.availableQuantity ?? 0))) issue = "所选包裹可用量已变化，请减少本次采纳数量或取消勾选，再选择实际发出的包裹。";
  else if (!externalItems.length && rows.some(row => row.availableQuantity > 0)) issue = "请勾选本次实际发出的包裹并填写采纳数量。";
  else if (externalItems.length && externalItems.some(item => !Number.isInteger(item.quantity) || item.quantity <= 0)) issue = "本次采纳数量请填写大于0的整数；不采用的包裹请取消勾选。";
  else if (shipped > 0 && (draft.fba.trim() === "" || !Number.isInteger(fba) || fba < 0)) issue = "请填写本次发货后的实际FBA剩余，允许为0。";
  else if (shipped > 0 && shipped + fba > work.sourceQuantityBefore) issue = `本次采纳 ${shipped} 件加FBA剩余 ${fba} 件，超过来源 ${work.sourceQuantityBefore} 件，请核对这两项数量。`;
  return {externalItems, shipped, fba, valid, issue};
}

const ROLE_LABELS: Record<Role, string> = {
  admin: "管理员",
  "assistant-1": "助理-一团",
  "assistant-2": "助理-二团",
  "operation-1": "运营·一团",
  "operation-2": "运营·二团",
  purchasing: "采购", alan: "Alan",
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
  const [procurementDrafts, setProcurementDrafts] = useState<Record<number, ProcurementDraft>>({});
  const [operationDrafts, setOperationDrafts] = useState<Record<number, OperationDraft>>({});
  const [shippingDrafts, setShippingDrafts] = useState<Record<number, ShippingDraft>>({});
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
    setProcurementDrafts({});
    setOperationDrafts({});
    setShippingDrafts({});
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
    setSelectedSourceKey(candidateKey(candidate));
    relocationRequest.current = null;
  };

  const submitRelocation = async () => {
    if (!selectedCandidate || busy || role === "business" || role === "alan") return;
    const payload = selectedCandidate.sourceKind === "fba" ? {fbaArchiveId:selectedCandidate.fbaArchiveId!} : selectedCandidate.sourceKind === "inquiry"
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

  const submitProcurement = async (work: RelocationWorkItem) => {
    const draft = procurementDrafts[work.id]?.sourceKey === workSourceKey(work) ? procurementDrafts[work.id] : { rma: "", address: "", sourceKey:workSourceKey(work) };
    if (!draft.rma.trim() || !draft.address.trim() || busy) return;
    const key = `relocation-procurement-${work.id}`;
    const payload = { rma: draft.rma.trim(), relocationAddress: draft.address.trim(), expectedRevision: work.revision };
    const requestId = completionRequestId(key, { role, ...payload });
    setBusy(key); setNotice(null);
    try {
      await recordRelocationProcurement(role, work.id, { ...payload, requestId });
      completionRequests.current.delete(key);
      await refreshAfterWrite();
      setNotice({ kind: "success", text: `${work.workNo} 的采购信息已登记。` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  };

  const submitOperation = async (work: RelocationWorkItem) => {
    const draft = operationDrafts[work.id]?.sourceKey === workSourceKey(work) ? operationDrafts[work.id] : { orderNo: "", sourceKey:workSourceKey(work) };
    if (!draft.orderNo.trim() || busy) return;
    const key = `relocation-operation-${work.id}`;
    const payload = { removalOrderNo: draft.orderNo.trim(), expectedRevision: work.revision };
    const requestId = completionRequestId(key, { role, ...payload });
    setBusy(key); setNotice(null);
    try {
      await recordRelocationOperation(role, work.id, { ...payload, requestId });
      completionRequests.current.delete(key);
      await refreshAfterWrite();
      setNotice({ kind: "success", text: `${work.workNo} 的移除订单号已登记。` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  };

  const submitShipping = async (work: RelocationWorkItem) => {
    const draft = currentShippingDraft(work, shippingDrafts);
    const values = shippingValues(work, draft);
    if (!values.valid || busy) return;
    const key = `relocation-shipping-${work.id}`;
    const payload = {
      fbaRemainingQuantity: values.fba,
      externalItems: values.externalItems,
      expectedRevision: work.revision,
    };
    const requestId = completionRequestId(key, { role, ...payload });
    setBusy(key); setNotice(null);
    try {
      await shipRelocationUpgrade(role, work.id, { ...payload, requestId });
      completionRequests.current.delete(key);
      await refreshAfterWrite();
      setNotice({ kind: "success", text: `已确认移仓发货 ${formatNumber(values.shipped)} 件。` });
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

  const finishRelocation = async (job: RelocationUpgrade, relocationId: number, revision: number, remaining: number) => {
    if (busy || completing.current) return;
    const draft = relocationCompleteDrafts[relocationId] ?? { quantity: "", version: job.newVersion ?? "" };
    const key = `upgrade-relocation-complete-${relocationId}`;
    let request = pendingRelocation[relocationId];
    if (!request) {
      const quantity = Number(draft.quantity);
      const version = draft.version.trim();
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > remaining || !version || !draft.warehouse) return;
      request = { completedQuantity: quantity, newVersion: version, targetWarehouse: draft.warehouse ?? "", expectedRevision: revision, requestId: createRequestId(key) };
      setPendingRelocation((current) => ({ ...current, [relocationId]: request }));
    }
    completing.current = true;
    setBusy(key);
    setNotice(null);
    try {
      await completeRelocationUpgrade(role, relocationId, request);
      setPendingRelocation((current) => { const next = { ...current }; delete next[relocationId]; return next; });
      setRelocationCompleteDrafts((current) => ({ ...current, [relocationId]: { quantity: "", version: request.newVersion } }));
      const refreshed = await refreshAfterWrite().then(() => true, () => false);
      setNotice({ kind: "success", text: `已完成 ${formatNumber(request.completedQuantity)} 件并以 ${request.newVersion} 重新进入在库库存。${refreshed ? "" : "已保存，但页面刷新失败，请重新加载查看。"}` });
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
          ]}
        />
      </Panel>

      {mode === "relocation" ? (
        <div className="relocation-board">
          <Panel title="升级来源" className="relocation-source-panel">
            <div className="form-grid upgrade-filter">
              <label className="field"><span>型号</span><select value={relocationModel} onChange={event => { setRelocationModel(event.target.value); setRelocationVersion(""); setSelectedSourceKey(null); }}><option value="">全部型号</option>{relocationModels.map(value => <option key={value}>{value}</option>)}</select></label>
              <label className="field"><span>原版本号</span><select value={relocationVersion} onChange={event => { setRelocationVersion(event.target.value); setSelectedSourceKey(null); }}><option value="">全部版本</option>{relocationVersions.map(value => <option key={value}>{value}</option>)}</select></label>
            </div>
            <div className="upgrade-candidate-table"><table className="data-table"><thead><tr><th>来源单号</th><th>型号 / 版本</th><th>来源数量</th><th>当前 FBA 剩余</th></tr></thead><tbody>{visibleCandidates.map(row => <tr key={candidateKey(row)} className={selectedKey === candidateKey(row) ? "row-expanded" : undefined}>
              <td><button className="link-btn source-select" type="button" onClick={() => chooseCandidate(row)}>{row.documentNo}</button><div className="muted">{row.sourceKind === "fba" ? "直发FBA" : row.sourceKind === "inquiry" ? "询库" : "调拨"}</div></td><td><strong>{row.model}</strong><div>{row.sourceVersion}</div></td><td>{formatNumber("initialQuantity" in row ? row.initialQuantity : row.sourceQuantityBefore)}</td><td>{row.fbaRemainingQuantity === null ? "—" : formatNumber(row.fbaRemainingQuantity)}</td>
            </tr>)}</tbody></table></div>{!visibleCandidates.length && <EmptyState title="暂无对应来源" />}
          </Panel>
          <div className="relocation-documents">
            {selectedSource && <Panel title={selectedSource.documentNo + " · " + selectedSource.model} actions={selectedCandidate && role !== "business" && role !== "alan" ? <button className="btn btn-primary btn-sm" type="button" disabled={busy !== null} onClick={() => void submitRelocation()}>{busy === "relocation-initiate" ? "发起中…" : "发起移仓升级"}</button> : undefined}>
              <InquiryRecall key={`${selectedKey}-${role}`} source={selectedSource} role={role} onRefresh={refreshAfterWrite} onNotice={setNotice} />
              <dl className="relocation-fields">{[
                ["来源 FNSKU", selectedSource.fnsku], ["原版本", selectedSource.sourceVersion], ["ASIN", selectedSource.asin || "—"], ["发货计划号", selectedSource.plan], ["发货时间", selectedSource.shipDate],
                ["已用数量", "initialQuantity" in selectedSource ? formatNumber(selectedSource.initialQuantity - selectedSource.fbaRemainingQuantity) : "—"],
                ["来源资格", selectedSource.sourceKind === "fba" ? "直发FBA：不受 90 天限制" : selectedSource.sourceKind === "inquiry" ? "询库来源：不受 90 天限制" : new Date(selectedSource.confirmedAt).getTime() >= Date.now() - 90 * 86400000 ? "近 90 天" : "超过 90 天"], ["店铺", selectedSource.store], ["团队", selectedSource.department]
              ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}</dl>
            </Panel>}
            <RelocationWorkflow role={role} rows={relocationWorkItems.filter(row => candidateKey(row) === selectedKey)} procurementDrafts={procurementDrafts} setProcurementDrafts={setProcurementDrafts} operationDrafts={operationDrafts} setOperationDrafts={setOperationDrafts} shippingDrafts={shippingDrafts} setShippingDrafts={setShippingDrafts} busy={busy} onProcurement={submitProcurement} onOperation={submitOperation} onShipping={submitShipping} onRefresh={refreshAfterWrite} />
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
  if (!source.inquiryRecall || source.inquiryId == null || !["purchasing", "business"].includes(role)) return null;
  const target = role === "purchasing" ? "待Alan或采购回复" : "待商务审核";
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

function RelocationWorkflow({
  role,
  rows,
  procurementDrafts,
  setProcurementDrafts,
  operationDrafts,
  setOperationDrafts,
  shippingDrafts,
  setShippingDrafts,
  busy,
  onProcurement,
  onOperation,
  onShipping,
  onRefresh,
}: {
  role: Role;
  rows: RelocationWorkItem[];
  procurementDrafts: Record<number, ProcurementDraft>;
  setProcurementDrafts: React.Dispatch<React.SetStateAction<Record<number, ProcurementDraft>>>;
  operationDrafts: Record<number, OperationDraft>;
  setOperationDrafts: React.Dispatch<React.SetStateAction<Record<number, OperationDraft>>>;
  shippingDrafts: Record<number, ShippingDraft>;
  setShippingDrafts: React.Dispatch<React.SetStateAction<Record<number, ShippingDraft>>>;
  busy: string | null;
  onProcurement: (work: RelocationWorkItem) => Promise<void>;
  onOperation: (work: RelocationWorkItem) => Promise<void>;
  onShipping: (work: RelocationWorkItem) => Promise<void>;
  onRefresh: () => Promise<unknown>;
}) {
  return <div className="upgrade-workflow-table">{rows.map(work => {
    const procurement = procurementDrafts[work.id]?.sourceKey === workSourceKey(work) ? procurementDrafts[work.id] : { rma: "", address: "", sourceKey: workSourceKey(work) };
    const operation = operationDrafts[work.id]?.sourceKey === workSourceKey(work) ? operationDrafts[work.id] : { orderNo: "", sourceKey: workSourceKey(work) };
    const shipping = currentShippingDraft(work, shippingDrafts), values = shippingValues(work, shipping), shippingValid = values.valid;
    return <article className="relocation-document" key={work.id} data-relocation-work-id={work.id}>
      <header className="relocation-document-head"><strong className="mono">{work.workNo}</strong>{work.status === "awaiting_shipping" && work.removalOrderNo && <LingxingSync role={role} target={{action:"logistics", workId:work.id}} sourceKey={workSourceKey(work)} onSynced={onRefresh} disabled={busy !== null} />}</header>
      <dl className="relocation-fields"><div><dt>本次移仓前</dt><dd>{formatNumber(work.sourceQuantityBefore)}</dd></div><div><dt>发起岗位</dt><dd>{ROLE_LABELS[work.initiatedByRole]}</dd></div><div><dt>发起时间</dt><dd>{displayTime(work.initiatedAt)}</dd></div>
        {work.rma && <><div><dt>RMA</dt><dd>{work.rma}</dd></div><div><dt>移仓地址</dt><dd>{work.relocationAddress}</dd></div></>}{work.removalOrderNo && <div><dt>移除订单</dt><dd>{work.removalOrderNo}</dd></div>}{work.inquiryShipmentId && <div><dt>历史询库发货记录</dt><dd>#{work.inquiryShipmentId} · {work.shipDate}</dd></div>}
      </dl>
      <RelocationExternalShipments workNo={work.workNo} rows={work.externalShipments ?? []} selected={shipping.external ?? {}} disabled={busy !== null} readOnly={work.status !== "awaiting_shipping" || role !== work.initiatedByRole} onChange={external => setShippingDrafts(current => ({...current, [work.id]: {...shipping, external}}))} />
                    {work.status === "awaiting_procurement" && role === "purchasing" && (
                      <div className="upgrade-inline-complete relocation-procurement-form">
                        <input aria-label={`${work.workNo} RMA`} placeholder="RMA" value={procurement.rma} onChange={(event) => setProcurementDrafts((current) => ({ ...current, [work.id]: { ...procurement, rma: event.target.value } }))} />
                        <input aria-label={`${work.workNo} 移仓地址`} placeholder="移仓地址" value={procurement.address} onChange={(event) => setProcurementDrafts((current) => ({ ...current, [work.id]: { ...procurement, address: event.target.value } }))} />
                        <button className="btn btn-primary btn-sm" type="button" disabled={!procurement.rma.trim() || !procurement.address.trim() || busy !== null} onClick={() => void onProcurement(work)}>{busy === `relocation-procurement-${work.id}` ? "提交中…" : "提交采购信息"}</button>
                      </div>
                    )}
                    {work.status === "awaiting_operation" && (role === "operation-1" || role === "operation-2") && (
                      <div className="upgrade-inline-complete relocation-operation-form">
                        <input aria-label={`${work.workNo} 移除订单号`} placeholder="移除订单号" value={operation.orderNo} onChange={(event) => setOperationDrafts((current) => ({ ...current, [work.id]: { ...operation, orderNo: event.target.value } }))} />
                        <button className="btn btn-primary btn-sm" type="button" disabled={!operation.orderNo.trim() || busy !== null} onClick={() => void onOperation(work)}>{busy === `relocation-operation-${work.id}` ? "提交中…" : "提交移除订单"}</button>
                      </div>
                    )}
                    {work.status === "awaiting_shipping" && role === work.initiatedByRole && (
                      <div className="upgrade-inline-complete relocation-shipping-form">
                        {!!work.externalShipments?.length && work.externalShipments.every(row => row.availableQuantity === 0) && <p className="form-hint">这些包裹已全部登记，当前没有新的可用包裹。</p>}
                        <label className="field"><span>实际 FBA 剩余</span><input aria-label={`${work.workNo} FBA 剩余库存`} inputMode="numeric" placeholder="FBA 剩余" value={shipping.fba} onChange={(event) => setShippingDrafts((current) => ({ ...current, [work.id]: { ...shipping, fba: event.target.value } }))} /></label>
                        {values.issue && <p className="form-hint">{values.issue}</p>}
                        <button className="btn btn-primary btn-sm" type="button" disabled={!shippingValid || busy !== null} onClick={() => void onShipping(work)}>{busy === `relocation-shipping-${work.id}` ? "提交中…" : "登记移仓发货"}</button>
                      </div>
                    )}

    </article>;
  })}</div>;
}

function RelocationHistory({
  role,
  warehouses,
  jobs,
  drafts,
  setDrafts,
  busy,
  pending,
  onComplete,
  onRefresh,
}: {
  role: Role;
  warehouses: string[];
  jobs: RelocationUpgrade[];
  drafts: Record<number, CompleteDraft>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<number, CompleteDraft>>>;
  busy: string | null;
  pending: Record<number, CompletionRequest>;
  onComplete: (job: RelocationUpgrade, relocationId: number, revision: number, remaining: number) => Promise<void>;
  onRefresh: () => Promise<unknown>;
}) {
  return <div className="upgrade-history-table">{jobs.flatMap(job => job.relocations.map(row => {
    const recovery = pending[row.id];
    const draft = recovery ? { quantity: String(recovery.completedQuantity), version: recovery.newVersion, warehouse: recovery.targetWarehouse } : { quantity: drafts[row.id]?.quantity ?? "", version: drafts[row.id]?.version ?? job.newVersion ?? "", warehouse: drafts[row.id]?.warehouse ?? "" };
    const quantity = Number(draft.quantity), valid = Number.isInteger(quantity) && quantity > 0 && quantity <= row.inProgressQuantity && Boolean(draft.version.trim()) && Boolean(draft.warehouse);
    return <article className="relocation-document" key={row.id} data-relocation-id={row.id}>
      <header className="relocation-document-head"><div><strong className="mono">{row.relocationNo}</strong><span className="muted">{job.upgradeNo}</span></div>{role === "admin" && row.status === "active" && row.workId && <LingxingSync role={role} target={{action:"logistics",workId:row.workId}} sourceKey={job.documentNo + ":" + job.fnsku + ":" + row.removalOrderNo} onSynced={onRefresh} disabled={busy !== null} />}</header>
      <dl className="relocation-fields">{[["本次移仓前",formatNumber(row.sourceQuantityBefore)],["实际发货数量",formatNumber(row.shippedQuantity)],["实际 FBA 剩余",formatNumber(row.fbaRemainingQuantity)],["FBA 其他减少",formatNumber(row.soldQuantity)],["已入库数量",formatNumber(row.completedQuantity)],["可入库数量",formatNumber(row.inProgressQuantity)],["RMA",row.rma],["移仓地址",row.relocationAddress],["移除订单",row.removalOrderNo],["承运商",row.carrier],["运单号",row.trackingNo],["发货登记时间",displayTime(row.createdAt)]].map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}
        {row.inquiryShipmentId && <div><dt>历史询库发货记录</dt><dd>#{row.inquiryShipmentId} · {row.shipDate}</dd></div>}{row.completions.length > 0 && <div className="field-wide"><dt>入库记录</dt><dd>{row.completions.map(item => item.version + " / " + (item.warehouse || "历史仓库未确定") + "：" + item.quantity).join("、")}</dd></div>}
      </dl>
      <RelocationExternalHistory items={row.externalItems ?? []} />
      <RelocationExternalShipments workNo={row.relocationNo} rows={row.externalShipments} selected={{}} disabled={busy !== null} readOnly onChange={() => {}} />
                      {(recovery || (row.status !== "withdrawn" && row.inProgressQuantity > 0)) && role === "purchasing" ? (
                        <div className="upgrade-inline-complete">
                          <input aria-label={`${row.relocationNo} 升级完成数量`} inputMode="numeric" placeholder={`最多 ${row.inProgressQuantity}`} value={draft.quantity} disabled={Boolean(recovery) || busy !== null} onChange={(event) => setDrafts((current) => ({ ...current, [row.id]: { ...draft, quantity: event.target.value } }))} />
                          <input aria-label={`${row.relocationNo} 升级完成版本号`} placeholder="新版本" value={draft.version} disabled={Boolean(recovery) || busy !== null} onChange={(event) => setDrafts((current) => ({ ...current, [row.id]: { ...draft, version: event.target.value } }))} />
                          <select aria-label={`${row.relocationNo} 目标海外仓`} value={draft.warehouse ?? ""} disabled={Boolean(recovery) || busy !== null} onChange={event => setDrafts(current => ({...current, [row.id]: {...draft, warehouse:event.target.value}}))}><option value="">选择目标海外仓</option>{warehouses.map(warehouse => <option key={warehouse} value={warehouse}>{warehouse}</option>)}</select>
                          <button className="btn btn-primary btn-sm" type="button" disabled={(!recovery && !valid) || busy !== null} onClick={() => void onComplete(job, row.id, row.revision, row.inProgressQuantity)}>{busy === `upgrade-relocation-complete-${row.id}` ? "提交中…" : recovery ? "重试确认" : "完成入库"}</button>
                        </div>
                      ) : null}

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
            {(job.status === "active" || recovery) && role === "purchasing" && (
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
            {job.status === "active" && role !== "purchasing" && <div className="form-hint">等待采购登记完成数量和新版本。</div>}
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
