import { useEffect, useMemo, useState } from "react";
import { clearInquiryDisplay, decideAllocationConversion, downloadInquiryExport, formatNumber, readPendingBusinessRequests, recallAllocation, reviewAllocation, reviewInquiry, transferAllocationToInquiry, type ApiError } from "../api";
import { Icon } from "../components/Icon";
import { LingxingSync } from "../components/LingxingSync";
import { AlanReviewCells, AllocationFulfillment, ApprovalProcurementCells, InquiryFulfillment, type ApprovalDraftControls, type ApprovalFormDraft } from "../components/InquiryFulfillment";
import { Badge, displayTime, EmptyState, FeedbackButton, Notice, Panel, Segmented, SkeletonTable } from "../components/ui";
import { useBusinessAction } from "../hooks/useBusinessAction";
import { useSessionDraft } from "../hooks/useSessionDraft";
import { useApprovals } from "../hooks/useApprovals";
import { useInventoryCatalog } from "../hooks/useInventory";
import { useEffectivePermissions } from "../hooks/usePermissions";
import type { Allocation, Category, Inquiry, LingxingMetrics, NoticeMessage, Role } from "../types";
import { createRequestId } from "../utils/ids";
import { operationGroups } from "../utils/roles";
import { expandableRowProps } from "../utils/rowExpansion";
import { allocationProgressLabel, finalQuantityLabel, inquiryProgressLabel, isNewInkAllocation } from "../utils/approvalWorkflow";

import { ApprovalDocumentButton, ApprovalDocumentInline } from "../components/ApprovalDocumentDetails";
import { AllocationSourceBatch } from "../components/AllocationSourceBatch";

type ApprovalItem = { kind: "allocation"; record: Allocation & { category: Category } } | { kind: "inquiry"; record: Inquiry };
type TypeFilter = "all" | ApprovalItem["kind"];
type ProgressFilter = "all" | "active";
type RecallRetention = { requestId: string; message: string; uncertain: boolean; recallEventId: number };
function isActive(item: ApprovalItem) { if (item.kind === "allocation" && item.record.tonerConversionStatus) return item.record.tonerConversionStatus === "pending_confirmation"; return item.kind === "allocation" ? isNewInkAllocation(item.record) ? item.record.inkWorkflowStage?.startsWith("pending_") === true : item.record.statusCode === "pending" && item.record.approvalStatus !== "rejected" : item.record.status.startsWith("pending_"); }
function isMyTodo(item: ApprovalItem, role: Role) {
  if (!isActive(item)) return false;
  const group = operationGroups[role];
  if (role === "operation-1" || role === "operation-2") return item.record.department === group;
  const assistant = role === "assistant-1" || role === "assistant-2";
  if (item.record.category === "硒鼓") {
    if (item.kind === "allocation") {
      if (item.record.tonerConversionStatus === "pending_confirmation") return false;
      return role === "business" && item.record.approvalStatus !== "approved"
        || assistant && item.record.approvalStatus === "approved" && item.record.department === group;
    }
    return role === "business" && item.record.status === "pending_business"
      || role === "purchasing" && ["pending_purchasing", "pending_assistant"].includes(item.record.status);
  }
  if (item.kind === "allocation" && isNewInkAllocation(item.record)) return role === "business" && item.record.inkWorkflowStage === "pending_business"
    || role === "alan" && item.record.inkWorkflowStage === "pending_alan"
    || assistant && item.record.inkWorkflowStage === "pending_assistant" && item.record.department === group;
  if (item.kind === "allocation") return (role === "business" && item.record.approvalStatus !== "approved")
    || (item.record.category !== "墨盒" && assistant && item.record.approvalStatus === "approved")
    || (item.record.category === "墨盒" && (role === "alan" && item.record.procurementStatus === "pending_alan"
      || ["purchasing", "logistics"].includes(role) && ["pending_alan", "pending_purchasing", "pending_archive"].includes(item.record.procurementStatus ?? "")));
  return (role === "business" && item.record.status === "pending_business")
    || (role === "alan" && item.record.category === "墨盒" && item.record.status === "pending_alan")
    || (["purchasing", "logistics"].includes(role) && (item.record.status === "pending_purchasing" || item.record.category === "墨盒" && item.record.status === "pending_alan"))
    || ((item.record.category === "墨盒" ? ["purchasing", "logistics"].includes(role) : assistant) && item.record.status === "pending_assistant");
}
function metricCoverage(value: number | null, metrics: LingxingMetrics | null) {
  if (!metrics) return "—";
  if (metrics.sales30d === 0) return "无销量";
  return value === null ? "—" : `${value.toFixed(1)} 倍`;
}
function calculatedCoverage(quantity: string, metrics: LingxingMetrics | null) {
  if (!metrics) return "—";
  if (metrics.sales30d === 0) return "无销量";
  const approved = Number(quantity);
  if (!quantity.trim() || !Number.isInteger(approved) || approved <= 0 || !Number.isFinite(metrics.sales30d)) return "—";
  const fba = [metrics.fbaAvailable, metrics.fbaPendingTransfer, metrics.fbaTransferring, metrics.fbaInbound];
  if (fba.some(value => typeof value !== "number" || !Number.isFinite(value))) return "—";
  return `${((fba.reduce((sum, value) => sum + value, 0) + approved) / metrics.sales30d).toFixed(1)} 倍`;
}
function progressLabel(item: ApprovalItem) { return item.kind === "allocation" ? allocationProgressLabel(item.record) : inquiryProgressLabel(item.record); }
type MetricKey = "sales7d" | "sales30d" | "orderGrossProfit" | "fbaAvailable" | "fbaPendingTransfer" | "fbaTransferring" | "fbaInbound";
type ApprovalColumn = { label: string; width: number; key?: MetricKey; currency?: boolean };

const METRIC_COLUMNS: ApprovalColumn[] = [
  { label: "7 天销量", key: "sales7d", width: 110 },
  { label: "30 天销量", key: "sales30d", width: 110 },
  { label: "订单毛利润（USD）", key: "orderGrossProfit", width: 190, currency: true },
  { label: "FBA 可售", key: "fbaAvailable", width: 120 },
  { label: "FBA 待调仓", key: "fbaPendingTransfer", width: 120 },
  { label: "FBA 调仓中", key: "fbaTransferring", width: 120 },
  { label: "FBA 在途", key: "fbaInbound", width: 120 },
];

const DOCUMENT_COLUMNS: ApprovalColumn[] = [
  { label: "申请数量", width: 100 }, { label: "商务审核数量", width: 140 }, { label: "当前调拨占用", width: 140 }, { label: "最终执行数量", width: 180 }, { label: "套/箱", width: 100 }, { label: "发货方式-所属海外仓", width: 230 }, { label: "商务备注", width: 230 },
  { label: "Alan审核数量", width: 160 }, { label: "Alan备注", width: 250 },
  { label: "供应商库存回复", width: 150 }, { label: "发货仓库", width: 130 }, { label: "采购备注", width: 250 },
  { label: "团队", width: 100 }, { label: "店铺", width: 160 }, { label: "运营", width: 110 },
  { label: "已贴FNSKU", width: 145 }, { label: "ASIN", width: 130 }, { label: "运营备注", width: 230 },
  { label: "提交时间", width: 160 }, { label: "状况", width: 170 }, { label: "操作", width: 210 },
];
const COVERAGE_COLUMNS: ApprovalColumn[] = [{ label: "调货前倍数", width: 130 }, { label: "调货后倍数", width: 130 }];

function approvalDocumentColumns(role: Role) {
  const metrics = role === "assistant-1" || role === "assistant-2" || ["purchasing", "logistics"].includes(role) || role === "alan"
    ? METRIC_COLUMNS.filter(column => column.key !== "orderGrossProfit")
    : METRIC_COLUMNS;
  return [...DOCUMENT_COLUMNS, ...metrics, ...COVERAGE_COLUMNS];
}

function ApprovalRecord({ item, role, onRefresh, onNotice, actionsAllowed, recallRetention, onRecallRetention }: {
  item: ApprovalItem; role: Role; onRefresh: () => Promise<unknown>; onNotice: (notice: NoticeMessage) => void;
  actionsAllowed: boolean; recallRetention?: RecallRetention; onRecallRetention: (value: RecallRetention | null) => void;
}) {
  const row = item.record;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailId = `approval-${item.kind}-detail-${row.id}`;
  const newAllocation = isNewInkAllocation(row);
  const pendingConversion = item.kind === "allocation" && (item.record.tonerConversionStatus === "pending_confirmation" || item.record.inkWorkflowStage === "pending_conversion_confirmation");
  const draftScope = `${item.kind === "inquiry" ? item.record.status : newAllocation ? row.inkWorkflowStage : [item.record.statusCode, item.record.approvalStatus, item.record.procurementStatus, item.record.tonerConversionStatus].join(":")}:${row.events.filter(event => event.type === "recall").slice(-1)[0]?.id ?? 0}`;
  const [savedDraft, setSavedDraft, draftCache] = useSessionDraft<ApprovalFormDraft | null>(role, `approval-${item.kind}-${row.id}`, null);
  const [submittedDraft, setSubmittedDraft] = useState<ApprovalFormDraft | null>(null);
  const currentDraft = savedDraft?.scope === draftScope ? savedDraft : submittedDraft?.scope === draftScope ? submittedDraft : null;
  const draft: ApprovalDraftControls = {
    value: currentDraft,
    ready: draftCache.ready && !recallRetention?.uncertain,
    update: patch => {
      setSubmittedDraft(null);
      setSavedDraft(current => ({ ...(current?.scope === draftScope ? current : {}), scope: draftScope, ...patch }));
    },
    prepare: execute => {
      const submitted = currentDraft ?? { scope: draftScope };
      setSubmittedDraft(submitted);
      const restoreDraft = draftCache.persist(null, true);
      return async () => {
        try {
          const result = await execute();
          setSubmittedDraft(current => current?.scope === submitted.scope ? null : current);
          return result;
        } catch (failure) {
          const status = (failure as ApiError).status;
          if (status !== undefined && status >= 400 && status < 500) {
            restoreDraft();
            setSubmittedDraft(current => current?.scope === submitted.scope ? null : current);
          }
          throw failure;
        }
      };
    },
  };
  const quantity = currentDraft?.quantity ?? String(row.businessReviewedQuantity ?? row.originalRequestedQuantity ?? "");
  const setQuantity = (value: string) => draft.update({ quantity: value });
  const procurementQuantity = currentDraft?.quantity ?? "";
  const setProcurementQuantity = (value: string) => draft.update({ quantity: value });
  const displayedRequested = row.originalRequestedQuantity;
  const displayedApproved = row.businessReviewedQuantity;
  const businessNote = currentDraft?.note ?? row.businessNote ?? "";
  const setBusinessNote = (value: string) => draft.update({ note: value });
  const [quantityRequestError, setQuantityRequestError] = useState(false);
  const packPerBox = Number(item.kind === "allocation" ? item.record.packPerBox : null);
  const basicQuantityInvalid = !quantity.trim() || !Number.isInteger(Number(quantity)) || Number(quantity) <= 0;
  const quantityError = item.kind !== "allocation" ? ""
    : !Number.isInteger(packPerBox) || packPerBox <= 0 ? "来源批次的套/箱须为正整数，核对后才能批准调拨。"
    : !Number.isInteger(Number(quantity)) || Number(quantity) <= 0 ? `来源批次套/箱为 ${packPerBox}，审核数量请填写大于 0 的整数，且须为 ${packPerBox} 的整数倍。`
    : Number(quantity) % packPerBox !== 0 ? `来源批次套/箱为 ${packPerBox}，审核数量须为 ${packPerBox} 的整数倍。` : "";
  const { perform, busy, uncertain: actionUncertain, error, setError } = useBusinessAction(onRefresh, text => onNotice({ kind: "success", text }));
  const uncertain = actionUncertain || recallRetention?.uncertain === true;
  const [recalling, setRecalling] = useState(false);
  const recallInfo = item.kind === "allocation" ? item.record.recallInfo : null;
  const canRecall = recallInfo?.canRecallByRole?.includes(role) === true;
  const recall = () => {
    if (item.kind !== "allocation" || !recallInfo || !canRecall || !actionsAllowed || recallInfo.blockers.length || busy || uncertain || recallRetention?.uncertain) return;
    const payload = { expectedRevision: recallInfo.revision, requestId: createRequestId("allocation-recall") };
    const recallEventId = row.events.filter(event => event.type === "recall").slice(-1)[0]?.id ?? 0;
    const target = role === "business" ? "待商务审核" : "待采购回复";
    setRecalling(true);
    void perform({ execute: async () => {
      onRecallRetention({ requestId: payload.requestId, message: "正在回撤…", uncertain: false, recallEventId });
      try { await recallAllocation(role, row.id, payload, [row.model,row.store,row.plan,row.fnsku].filter(Boolean).join(" / ")); onRecallRetention(null); }
      catch (failure) {
        const e = failure as ApiError;
        onRecallRetention({ requestId: payload.requestId, message: e.message, uncertain: e.status === undefined || e.status >= 500, recallEventId });
        throw failure;
      }
    }, message: `${row.model} · ${row.store} 调拨已回撤至${target}。` });
  };
  const [reviewing,setReviewing]=useState<"approve"|"reject"|"convert">("approve");
  const needsReview = item.kind === "allocation" ? newAllocation ? row.inkWorkflowStage === "pending_business" : item.record.statusCode === "pending" && !item.record.tonerConversionStatus && item.record.approvalStatus !== "approved" && item.record.approvalStatus !== "rejected" : item.record.status === "pending_business";
  const canConvert = item.kind === "allocation" && (newAllocation || row.category === "硒鼓") && needsReview;
  const review = (decision: "approve" | "reject") => {
    if (!draft.ready || busy || uncertain) return;
    const approvedQuantity = Number(quantity);
    if (decision === "approve" && quantityError) return;
    if (decision === "approve" && (!Number.isInteger(approvedQuantity) || approvedQuantity <= 0)) { setError("审核数量请填写大于 0 的整数"); return; }
    const payload = { decision, ...(decision === "approve" ? { approvedQuantity } : {}), businessNote: businessNote.trim(), expectedRevision: row.revision, requestId: createRequestId(`${item.kind}-review`) };
    setReviewing(decision);
    setQuantityRequestError(false);
    void perform({ execute: draft.prepare(async () => {
      try { return await (item.kind === "allocation" ? reviewAllocation(role, row.id, payload, [row.model,row.store,row.department,row.plan,row.fnsku,displayTime(row.createdAt)].filter(Boolean).join(" / ")) : reviewInquiry(role, row.id, payload, [row.model,row.store,row.department,row.fnsku,displayTime(row.createdAt)].filter(Boolean).join(" / "))); }
      catch (failure) {
        if (item.kind === "allocation") setQuantityRequestError(["invalid_quantity", "allocation_quantity_multiple", "insufficient_available"].includes((failure as ApiError).code ?? ""));
        throw failure;
      }
    }), message: decision === "approve" ? `${row.model} · ${row.store} 已批准 ${formatNumber(approvedQuantity)} 件。` : `${row.model} · ${row.store} 已拒绝。` });
  };
  const convert = () => {
    if (!draft.ready || busy || uncertain || !canConvert) return;
    const approvedQuantity = Number(quantity);
    if (!quantity.trim() || !Number.isInteger(approvedQuantity) || approvedQuantity <= 0) { setError("转询库时请填写大于 0 的整数商务审核数量"); return; }
    const payload = { approvedQuantity, businessNote: businessNote.trim(), expectedRevision: row.revision, requestId: createRequestId("allocation-transfer-inquiry") };
    setReviewing("convert");
    void perform({ execute: draft.prepare(() => transferAllocationToInquiry(role, row.id, payload, [row.model,row.store,row.department].join(" / "))), message: `${row.model} · ${row.store}：商务数量 ${formatNumber(approvedQuantity)} 件已转为询库需求，原预锁已全部释放，待本团运营确认。` });
  };
  const decideConversion = (decision: "accept" | "reject") => {
    const payload = { decision, expectedRevision: row.revision, requestId: createRequestId("allocation-conversion-decision") };
    void perform({ execute: () => decideAllocationConversion(role, row.id, payload, [row.model,row.store,row.department].join(" / ")), message: decision === "accept" ? `${row.model} · ${row.store}：已接受转询库，待采购确认。` : `${row.model} · ${row.store}：未接受转询库，原调拨已拒绝。` });
  };
  const metrics = row.lingxing;
  const metricColumns = approvalDocumentColumns(role).filter(column => column.key);
  const progress = progressLabel(item);
  return <tbody className="approval-record" data-document-no={row.documentNo} data-document-key={`${item.kind}-${row.id}`} aria-label={`${item.kind === "allocation" ? "调拨" : "询库"} ${row.model} · ${row.store}`}>
    <tr className={`approval-data-row expandable-row${detailsOpen ? " is-open" : ""}`} {...expandableRowProps(detailsOpen, () => setDetailsOpen(open => !open))} aria-controls={detailId}>
      <td className="approval-requested approval-number" data-field="申请数量">{displayedRequested == null ? "历史未记录" : formatNumber(displayedRequested)}{item.kind === "inquiry" && item.record.sourceAllocationId != null && <small className="approval-final-source">原调拨申请量 {item.record.sourceOriginalRequestedQuantity == null ? "历史未记录" : formatNumber(item.record.sourceOriginalRequestedQuantity)} · 本询库承接商务量</small>}</td>
      <td className="approval-number" data-field="商务审核数量">{displayedApproved == null ? "—" : formatNumber(displayedApproved)}</td>
      <td className="approval-number" data-field="当前调拨占用">{item.kind !== "allocation" ? "—" : item.record.lockedQuantity == null ? "未记录" : formatNumber(item.record.lockedQuantity)}</td>
      <td className="approval-number" data-field="最终执行数量">{row.finalQuantity == null ? "—" : formatNumber(row.finalQuantity)}{row.finalQuantitySource && <small className="approval-final-source">{finalQuantityLabel(row.finalQuantitySource, newAllocation)}</small>}</td>
      <td className="approval-number" data-field="套/箱" title={item.kind === "allocation" ? item.record.packPerBox ?? "来源批次套/箱缺失" : undefined}>{item.kind === "allocation" ? item.record.packPerBox || "—" : "—"}</td>
      <td className="approval-source-batch-cell" data-field="发货方式-所属海外仓">{item.kind === "allocation" ? <AllocationSourceBatch info={item.record.sourceBatchInfo} /> : "—"}</td>
      <td title={row.reviewedAt || displayedApproved != null ? row.businessNote : undefined} data-field="商务备注">{row.reviewedAt || displayedApproved != null ? row.businessNote || "—" : "—"}</td>
      <AlanReviewCells kind={item.kind} row={row} role={role} onRefresh={onRefresh} onNotice={onNotice} draft={draft} />
      {item.kind === "inquiry" || row.category === "墨盒" ? <ApprovalProcurementCells kind={item.kind} row={row} quantity={procurementQuantity} onQuantityChange={setProcurementQuantity} role={role} onRefresh={onRefresh} onNotice={onNotice} draft={draft} />
        : <><td data-field="供应商库存回复">—</td><td data-field="发货仓库">—</td><td data-field="采购备注">—</td></>}
      <td>{row.department || "—"}</td><td title={row.store}>{row.store || "—"}</td><td title={row.operator}>{row.operator || "—"}</td>
      <td title={row.fnsku}>{row.fnsku || "—"}</td><td title={row.asin}>{row.asin || "—"}</td><td title={row.operatorNote} data-field="运营备注">{row.operatorNote || "—"}</td>
      <td>{row.createdAt ? displayTime(row.createdAt) : "—"}</td>
      <td className="approval-progress">{progress && <Badge label={progress} tone={isActive(item) ? "amber" : "neutral"} dot={false} />}</td>
      <td className="approval-recall-cell" data-field="操作">{canRecall ? <><button type="button" className="btn btn-ghost btn-sm" disabled={!actionsAllowed || busy || uncertain || recallRetention?.uncertain || Boolean(recallInfo?.blockers.length)} onClick={recall}>{busy && recalling ? "正在回撤…" : "回撤至" + (role === "business" ? "待商务审核" : "待采购回复")}</button>{!!recallInfo?.blockers.length && <p className="field-error">无法回撤：{recallInfo.blockers.map(blocker => `${blocker.type} ${blocker.description}（${blocker.status}）`).join("；")}</p>}</> : "—"}</td>
      {metricColumns.map(column => {
        const value = metrics?.[column.key!];
        return <td key={column.label} className="approval-metric-cell" data-field={column.label}><span className="approval-metric-value">{value == null ? "—" : column.currency ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : formatNumber(value)}</span></td>;
      })}
      <td className="approval-metric-cell" data-field="调货前倍数"><span className="approval-coverage-value">{metricCoverage(row.coverageBefore, metrics)}</span></td><td className="approval-metric-cell" data-field="调货后倍数"><span className="approval-coverage-value">{metricCoverage(row.coverageAfter, metrics)}</span></td>
    </tr>
    <tr className="approval-action-row"><td colSpan={DOCUMENT_COLUMNS.length + metricColumns.length + COVERAGE_COLUMNS.length}><div className="approval-row-actions">
      {recallRetention && <div className="approval-recall-feedback" role={recallRetention.uncertain ? "alert" : "status"}><span>此单回撤尚未完成，已保留显示：{recallRetention.message}{recallRetention.uncertain && !actionUncertain ? " 请在顶部确认原回撤提交结果。" : ""}</span><button type="button" className="btn btn-ghost btn-sm" disabled={busy || uncertain || recallRetention.uncertain} onClick={() => { onRecallRetention(null); setError(null); setRecalling(false); }}>关闭回撤提示</button></div>}
      {item.kind === "allocation" && role === "business" && needsReview && <span className="form-hint" data-field="来源批次">来源批次：{[row.plan, row.date, row.version].filter(Boolean).join(" · ")}</span>}
      {role === "business" && (needsReview || uncertain) && <form className="approval-review-form" aria-label={`商务审核 ${row.model} · ${row.store}`} onSubmit={event => event.preventDefault()}>
        <label className="field"><span>审核数量</span><input required type="number" min="1" step="1" aria-label="审核数量" aria-invalid={item.kind === "allocation" ? Boolean(quantityError) : basicQuantityInvalid} value={quantity} disabled={!draft.ready || busy || uncertain} onChange={event => { setQuantity(event.target.value); if (quantityRequestError) { setError(null); setQuantityRequestError(false); } }} /></label>
        {item.kind === "allocation" && <label className="field approval-pack-per-box"><span>套/箱</span><output aria-label={`套/箱 ${row.model} · ${row.store}`}>{item.record.packPerBox || "—"}</output></label>}
        <label className="field approval-calculated-coverage"><span>调货后倍数</span><output aria-label={`调货后倍数 ${row.model} · ${row.store}`}>{calculatedCoverage(quantity, metrics ?? null)}</output></label>
        <label className="field approval-business-note"><span>商务备注</span><input value={businessNote} disabled={!draft.ready || busy || uncertain} onChange={event => setBusinessNote(event.target.value)} /></label>
        <button className="btn btn-primary" type="button" disabled={!draft.ready || busy || uncertain || Boolean(quantityError)} onClick={() => review("approve")}>{busy&&reviewing==="approve"?"正在批准…":"批准"}</button>
        <button className="btn btn-ghost" type="button" disabled={!draft.ready || busy || uncertain} onClick={() => review("reject")}>{busy&&reviewing==="reject"?"正在拒绝…":"拒绝"}</button>
        {canConvert && <button className="btn btn-ghost" type="button" disabled={!draft.ready || busy || uncertain} onClick={convert}>{busy&&reviewing==="convert"?"正在转询库…":"转询库"}</button>}
        {canConvert && <span className="form-hint">批准调拨须按来源批次整箱办理；转询库按商务数量整单转换，释放本单全部预锁，待本团运营确认。</span>}
      </form>}
      {pendingConversion && <div className="approval-conversion"><p>转询库数量：{displayedApproved == null ? "—" : formatNumber(displayedApproved)} 件，待运营确认；原调拨预锁定已全部释放。</p>{["operation-1","operation-2"].includes(role) && operationGroups[role] === row.department && <div className="approval-row-actions"><button type="button" className="btn btn-primary btn-sm" disabled={busy || uncertain} onClick={() => decideConversion("accept")}>接受转询库</button><button type="button" className="btn btn-ghost btn-sm" disabled={busy || uncertain} onClick={() => decideConversion("reject")}>不接受</button></div>}</div>}
      {item.kind === "allocation" && item.record.convertedInquiryId != null && <ApprovalDocumentButton role={role} reference={{ kind: "inquiry", id: item.record.convertedInquiryId }} label={"查看承接询库 · " + (item.record.convertedInquiryNo || "#" + item.record.convertedInquiryId)} showHistory={false} />}
      {item.kind === "inquiry" && item.record.sourceAllocationId != null && <ApprovalDocumentButton role={role} reference={{ kind: "allocation", id: item.record.sourceAllocationId }} label={"查看来源调拨 · " + (item.record.sourceAllocationNo || "#" + item.record.sourceAllocationId)} showHistory={false} />}
      {item.kind === "allocation" && <AllocationFulfillment row={item.record} role={role} onRefresh={onRefresh} onNotice={onNotice} />}
      {item.kind === "inquiry" && <InquiryFulfillment row={item.record} role={role} onRefresh={onRefresh} onNotice={onNotice} draft={draft} />}
      {role === "business" && needsReview && quantityError && <p className="field-error" role="alert">{canConvert ? "批准调拨：" : ""}{quantityError}</p>}
      {error && !recalling && <p className="dialog-error" role="alert">{error}</p>}
      {draftCache.storageError && <p className="dialog-error" role="alert">{draftCache.storageError}</p>}
      {actionUncertain && <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void perform()}>{busy?"正在确认…":"重试确认"}</button>}
    </div></td></tr>
    <tr className="approval-detail-row" id={detailId} hidden={!detailsOpen}><td colSpan={DOCUMENT_COLUMNS.length + metricColumns.length + COVERAGE_COLUMNS.length}>
      {detailsOpen && <ApprovalDocumentInline role={role} reference={{ kind: item.kind, id: row.id }} />}
    </td></tr>
  </tbody>;
}

export function ApprovalCenterView({ role }: { role: Role }) {
  const [showHidden, setShowHidden] = useState(false);
  const [recallRetentions, setRecallRetentions, recallRetentionCache] = useSessionDraft<Record<number, RecallRetention>>(role, "allocation-recall-visible", {});
  const query = useApprovals(role, showHidden || Object.keys(recallRetentions).length > 0);
  const inventory = useInventoryCatalog(role);
  const permissions = useEffectivePermissions(role);
  const setRecallRetention = (id: number, value: RecallRetention | null) => setRecallRetentions(current => { const next = { ...current }; if (value) next[id] = value; else delete next[id]; return next; });
  useEffect(() => {
    if (!recallRetentionCache.ready) return;
    const syncPending = () => {
      const pending = readPendingBusinessRequests(true);
      setRecallRetentions(current => {
        let changed = false; const next = { ...current };
        for (const request of pending) {
          const match = /^\/api\/allocations\/(\d+)\/recall$/.exec(request.url);
          if (match && request.role === role && request.databaseId === query.data?.sync.databaseId && !next[Number(match[1])]) {
            next[Number(match[1])] = { requestId: request.requestId, message: "原调拨回撤结果待确认。", uncertain: true, recallEventId: 0 }; changed = true;
          }
        }
        for (const [id, value] of Object.entries(current)) if (value.uncertain && !pending.some(request => request.role === role && request.requestId === value.requestId)) {
          next[Number(id)] = { ...value, uncertain: false, message: "原回撤待确认流程已结束，请查看确认结果。" }; changed = true;
        }
        return changed ? next : current;
      });
    };
    syncPending();
    window.addEventListener("aster-pending-business", syncPending);
    return () => window.removeEventListener("aster-pending-business", syncPending);
  }, [role, recallRetentionCache.ready, setRecallRetentions, query.data?.sync.databaseId]);
  useEffect(() => {
    if (!query.data || query.isError) return;
    const pending = readPendingBusinessRequests(true);
    const completed = Object.keys(recallRetentions).filter(id => !pending.some(request => request.role === role && request.requestId === recallRetentions[Number(id)].requestId) && query.data.allocations.some(row => row.id === Number(id) && row.statusCode === "pending"));
    if (completed.length) setRecallRetentions(current => { const next = { ...current }; completed.forEach(id => delete next[Number(id)]); return next; });
  }, [query.data, query.isError, recallRetentions, role, setRecallRetentions]);
  const operationRole = role === "operation-1" || role === "operation-2";
  const [type, setType] = useState<TypeFilter>("all");
  const [category, setCategory] = useState<"all" | Category>("all");
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [progress, setProgress] = useState<ProgressFilter>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const clearAction = useBusinessAction(query.refresh, text => setNotice({ kind: "success", text }));
  const clearInquiries = () => {
    const requestId = createRequestId();
    const action = { message: "", execute: async () => {
      const result = await clearInquiryDisplay(role, requestId);
      action.message = result.hiddenCount > 0 ? `已从审批中心隐藏 ${result.hiddenCount} 条已完成或已拒绝的询库。` : "没有可清空的询库";
    } };
    void clearAction.perform(action);
  };
  const documentColumns = approvalDocumentColumns(role);
  const documentMinWidth = documentColumns.reduce((total, column) => total + column.width, 100);
  const items = useMemo<ApprovalItem[]>(() => [ ...(query.data?.allocations ?? []).map(record => ({ kind: "allocation" as const, record })), ...(query.data?.inquiries ?? []).map(record => ({ kind: "inquiry" as const, record })) ].sort((a, b) => (b.record.createdAt ?? "").localeCompare(a.record.createdAt ?? "")), [query.data]);
  const todoItems = useMemo(() => items.filter(item => isMyTodo(item, role)), [items, role]);
  const groups = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    const hiddenIds = query.data?.hiddenCompletedAllocationIds ?? [];
    const retained = (item: ApprovalItem) => !query.isError && item.kind === "allocation" && Boolean(recallRetentions[item.record.id]);
    const filtered = items.filter(item => retained(item) || (!(item.kind === "allocation" && hiddenIds.includes(item.record.id) && !showHidden) && (scope !== "mine" || todoItems.includes(item)) && (type === "all" || item.kind === type) && (category === "all" || item.record.category === category) && (progress === "all" || isActive(item)) && (!keyword || [item.record.operator, item.record.model, item.record.asin, item.record.documentNo].some(value => value.toLocaleLowerCase().includes(keyword)))));
    const grouped = new Map<string, ApprovalItem[]>();
    for (const item of filtered) grouped.set(item.record.model, [...(grouped.get(item.record.model) ?? []), item]);
    return [...grouped.entries()];
  }, [items, todoItems, type, category, scope, progress, search, query.data, query.isError, recallRetentions, showHidden]);
  const syncDocuments = groups.flatMap(([, records]) => records.filter(isActive).map(item => ({ kind: item.kind, id: item.record.id })));
  const toggle = (key: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  return <div className="approval-page"><Panel>
    <div className="approval-toolbar"><div className="filter-bar">
      <label className="search-input approval-search"><Icon name="search" size={15} /><input aria-label="搜索编号、型号、运营或 ASIN" placeholder="编号 / 型号 / 运营 / ASIN" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <select aria-label="按需求类型筛选" value={type} onChange={event => setType(event.target.value as TypeFilter)}><option value="all">全部类型</option><option value="allocation">调拨</option><option value="inquiry">询库</option></select>
      <Segmented<"all" | Category> ariaLabel="按类目筛选" value={category} onChange={setCategory} items={[{ value: "all", label: "全部类目" }, { value: "硒鼓", label: "硒鼓" }, { value: "墨盒", label: "墨盒" }]} />
      <select aria-label="筛选审批进度" value={progress} onChange={event => setProgress(event.target.value as ProgressFilter)}><option value="all">全部进度</option><option value="active">处理中</option></select>
      <label className="approval-hidden-toggle"><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />查看已隐藏完成调拨</label>
      <button className={`btn btn-ghost${scope === "mine" ? " active" : ""}`} type="button" aria-pressed={scope === "mine"} onClick={() => { setScope(scope === "mine" ? "all" : "mine"); setProgress("all"); }}>{operationRole ? "处理中" : "我的待办"} <span className="count-badge">{todoItems.length}</span></button>
    {(search || type !== "all" || category !== "all" || progress !== "all") && <button className="btn btn-ghost" type="button" onClick={() => { setSearch(""); setType("all"); setCategory("all"); setProgress("all"); }}>清除筛选</button>}
    </div><div className="page-actions">{(role === "admin" || ["purchasing", "logistics"].includes(role)) && <FeedbackButton key={JSON.stringify([type,category,scope,progress,search])} label="导出询库" pendingLabel="正在导出…" doneLabel="导出完成" onAction={()=>downloadInquiryExport(role,{type,category,scope,progress,search})} successText="询库明细导出完成。"/>}{(role === "admin" || ["purchasing", "logistics"].includes(role)) && <button className="btn btn-ghost" type="button" disabled={clearAction.disabled} onClick={clearInquiries}>{clearAction.busy?"正在清空…":"清空询库列表"}</button>}<LingxingSync role={role} target={{ action: "metrics", documents: syncDocuments }} onSynced={query.refresh} disabled={query.isLoading || query.isError || syncDocuments.length === 0} /><FeedbackButton key={"refresh-"+JSON.stringify([type,category,scope,progress,search])} label="刷新" pendingLabel="正在刷新…" doneLabel="刷新完成" onAction={query.refresh}/></div></div>
    {clearAction.error && <p className="dialog-error" role="alert">{clearAction.error}</p>}
    {recallRetentionCache.storageError && <p className="dialog-error" role="alert">{recallRetentionCache.storageError}</p>}
    {clearAction.uncertain && <button className="btn btn-primary btn-sm" type="button" disabled={clearAction.busy} onClick={() => void clearAction.perform()}>{clearAction.busy?"正在确认…":"重试确认"}</button>}
    {query.isError && <div className="callout callout-danger" role="alert">{query.error instanceof Error ? query.error.message : "审批记录加载失败"}<FeedbackButton label="重新加载" pendingLabel="正在刷新…" doneLabel="刷新完成" className="btn btn-ghost btn-sm" onAction={()=>query.refetch({throwOnError:true})} onResult={setNotice}/></div>}
    {query.isLoading ? <SkeletonTable /> : !query.data ? null : groups.length === 0 ? <EmptyState title={scope === "mine" ? todoItems.length === 0 ? operationRole ? "暂无处理中的记录" : "当前岗位暂无待办" : operationRole ? "当前筛选下没有处理中的记录" : "当前筛选下没有待办" : "暂无符合条件的审批记录"} /> : <table className="approval-summary-table" aria-label="审批型号汇总">
      <colgroup><col style={{ width: "36%" }} /><col /><col /><col /></colgroup>
      <thead><tr>{["型号", "在库库存", "申请数量合计", "商务审核数量合计"].map(label => <th key={label}>{label}</th>)}</tr></thead>
      {groups.map(([model, records]) => {
        const open = expanded.has(model);
        const stock = inventory.data?.models.find(item => item.model === model)?.inStock;
        const demandRecords = records.filter(item => item.kind !== "allocation" || (item.record.inkWorkflowStage !== "converted" && item.record.tonerConversionStatus !== "accepted"));
        const requestedValues = demandRecords.map(item => item.kind === "allocation" && (item.record.inkWorkflowStage === "pending_conversion_confirmation" || item.record.tonerConversionStatus === "pending_confirmation") ? item.record.businessReviewedQuantity : item.record.originalRequestedQuantity);
        const requested = requestedValues.some(value => value === null) ? null : requestedValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
        const conversionDemand = demandRecords.filter(item => item.kind === "allocation" && (item.record.inkWorkflowStage === "pending_conversion_confirmation" || item.record.tonerConversionStatus === "pending_confirmation")).reduce((sum, item) => sum + (item.record.businessReviewedQuantity ?? 0), 0);
        const approved = demandRecords.some(item => item.record.businessReviewedQuantity !== null) ? demandRecords.reduce((sum, item) => sum + (item.record.businessReviewedQuantity ?? 0), 0) : null;
        const detailId = `approval-model-${encodeURIComponent(model)}`;
        return <tbody className="approval-model-group" key={model} data-model={model}>
          <tr className={`approval-model-row expandable-row${open ? " is-open" : ""}`} {...expandableRowProps(open, () => toggle(model))} aria-controls={detailId}>
            <td className="approval-model-name"><span className="approval-model-toggle" title={model}>{model}</span></td>
            <td className="approval-number" data-field="在库库存">{stock === undefined ? "—" : formatNumber(stock)}</td>
            <td className="approval-number" data-field="申请数量合计" title={conversionDemand > 0 ? "待运营确认的转询库按商务数量计入，原调拨申请量仅留作历史。" : undefined}>{requested === null ? "—" : formatNumber(requested)}{conversionDemand > 0 && <small className="approval-final-source">含转询库待确认 {formatNumber(conversionDemand)} 件</small>}</td>
            <td className="approval-number" data-field="商务审核数量合计">{approved === null ? "—" : formatNumber(approved)}</td>
          </tr>
          <tr className="approval-model-details" id={detailId} hidden={!open}><td colSpan={4}><div className="approval-table-scroll">
            <table className="approval-document-table" aria-label={`${model} 审批记录`} style={{ minWidth: `${documentMinWidth}px` }}>
            <colgroup>{documentColumns.map((column, index) => <col key={index} style={{ width: column.width }} />)}</colgroup>
            <thead><tr>{documentColumns.map(column => <th key={column.label}>{column.label}</th>)}</tr></thead>
            {records.map(item => <ApprovalRecord key={`${item.kind}-${item.record.id}-${role}-${item.kind === "allocation" && recallRetentions[item.record.id] ? recallRetentions[item.record.id].recallEventId : item.record.events.filter(event => event.type === "recall").slice(-1)[0]?.id ?? 0}`} item={item} role={role} onRefresh={query.refresh} onNotice={setNotice} actionsAllowed={permissions.data?.permissions[item.record.category]?.actions === true && recallRetentionCache.ready} recallRetention={item.kind === "allocation" ? recallRetentions[item.record.id] : undefined} onRecallRetention={value => setRecallRetention(item.record.id, value)} />)}
          </table></div></td></tr>
        </tbody>;
      })}
    </table>}
  </Panel><Notice notice={notice} onClose={() => setNotice(null)} /></div>;
}
