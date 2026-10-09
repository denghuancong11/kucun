import { useMemo, useState } from "react";
import { confirmAllocation, downloadInquiryExport, formatNumber, reviewAllocation, reviewInquiry, type ApiError } from "../api";
import { Icon } from "../components/Icon";
import { LingxingSync } from "../components/LingxingSync";
import { InquiryFulfillment, InquiryProcurementCells } from "../components/InquiryFulfillment";
import { Badge, displayTime, EmptyState, Notice, Panel, Segmented, SkeletonTable } from "../components/ui";
import { useBusinessAction } from "../hooks/useBusinessAction";
import { useApprovals } from "../hooks/useApprovals";
import { useInventoryCatalog } from "../hooks/useInventory";
import type { Allocation, Category, Inquiry, LingxingMetrics, NoticeMessage, Role } from "../types";
import { createRequestId } from "../utils/ids";
import { operationGroups } from "../utils/roles";

type ApprovalItem = { kind: "allocation"; record: Allocation & { category: Category } } | { kind: "inquiry"; record: Inquiry };
type TypeFilter = "all" | ApprovalItem["kind"];
type ProgressFilter = "all" | "active";
function isActive(item: ApprovalItem) { return item.kind === "allocation" ? item.record.statusCode === "pending" && item.record.approvalStatus !== "rejected" : item.record.status.startsWith("pending_"); }
function isArchived(item: ApprovalItem) { return item.kind === "allocation" ? item.record.statusCode === "confirmed" : item.record.status === "archived"; }
function isMyTodo(item: ApprovalItem, role: Role) {
  if (!isActive(item)) return false;
  const group = operationGroups[role];
  if (role === "operation-1" || role === "operation-2") return item.record.department === group;
  const assistant = role === "assistant-1" || role === "assistant-2";
  if (item.kind === "allocation") return (role === "business" && item.record.approvalStatus !== "approved") || (assistant && item.record.approvalStatus === "approved");
  return (role === "business" && item.record.status === "pending_business") || ((role === "purchasing" || role === "alan" && item.record.category === "墨盒") && item.record.status === "pending_purchasing")
    || ((item.record.category === "墨盒" ? role === "purchasing" : assistant) && item.record.status === "pending_assistant");
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
function progressLabel(item: ApprovalItem) {
  if (isArchived(item)) return item.kind === "allocation" || (["assistant", "assistant-1", "assistant-2"].includes(item.record.archivedByRole ?? "") || item.record.category === "墨盒" && item.record.archivedByRole === "purchasing") ? "已完成" : "";
  if (item.kind === "inquiry") return item.record.statusText;
  if (item.record.approvalStatus === "rejected") return "已拒绝";
  if (item.record.statusCode === "pending") return item.record.approvalStatus === "approved" ? "待助理确认" : "待商务审核";
  return item.record.status;
}
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
  { label: "申请数量", width: 100 }, { label: "商务部审核数量", width: 140 }, { label: "套/箱", width: 100 }, { label: "商务部备注", width: 230 },
  { label: "供应商库存回复", width: 150 }, { label: "发货仓库", width: 130 }, { label: "采购备注", width: 250 },
  { label: "调拨部门", width: 100 }, { label: "调拨店铺", width: 160 }, { label: "调拨运营", width: 110 },
  { label: "已贴FNSKU", width: 145 }, { label: "ASIN", width: 130 }, { label: "运营备注", width: 230 },
  { label: "提交时间", width: 160 }, { label: "状况", width: 135 },
];
const COVERAGE_COLUMNS: ApprovalColumn[] = [{ label: "调货前倍数", width: 130 }, { label: "调货后倍数", width: 130 }];

function approvalDocumentColumns(role: Role) {
  const metrics = role === "assistant-1" || role === "assistant-2" || role === "purchasing" || role === "alan"
    ? METRIC_COLUMNS.filter(column => column.key !== "orderGrossProfit")
    : METRIC_COLUMNS;
  return [...DOCUMENT_COLUMNS, ...metrics, ...COVERAGE_COLUMNS];
}

function ApprovalRecord({ item, role, onRefresh, onNotice }: {
  item: ApprovalItem; role: Role; onRefresh: () => Promise<unknown>; onNotice: (notice: NoticeMessage) => void;
}) {
  const row = item.record;
  const [quantity, setQuantity] = useState(String(row.approvedQuantity ?? row.requestedQuantity));
  const [procurementQuantity, setProcurementQuantity] = useState("");
  const previewQuantity = item.kind === "inquiry" && (role === "purchasing" || role === "alan" && item.record.category === "墨盒") && item.record.status === "pending_purchasing"
    && procurementQuantity.trim() !== "" && Number.isInteger(Number(procurementQuantity)) && Number(procurementQuantity) >= 0
    ? Number(procurementQuantity) : null;
  const displayedRequested = previewQuantity ?? row.requestedQuantity;
  const displayedApproved = previewQuantity ?? row.approvedQuantity;
  const previewTitle = previewQuantity === null ? undefined : "采购数量预览（未提交）";
  const [businessNote, setBusinessNote] = useState(row.businessNote || "");
  const [quantityRequestError, setQuantityRequestError] = useState(false);
  const packPerBox = Number(item.kind === "allocation" ? item.record.packPerBox : null);
  const quantityError = item.kind !== "allocation" ? ""
    : !Number.isInteger(packPerBox) || packPerBox <= 0 ? "来源批次套/箱数据异常（须为有效正整数），无法批准调拨，请核对批次数据。"
    : !Number.isInteger(Number(quantity)) || Number(quantity) <= 0 ? `来源批次套/箱为 ${packPerBox}，审核数量请填写大于 0 的整数，且须为 ${packPerBox} 的整数倍。`
    : Number(quantity) % packPerBox !== 0 ? `来源批次套/箱为 ${packPerBox}，审核数量须为 ${packPerBox} 的整数倍。` : "";
  const { perform, busy, uncertain, error, setError } = useBusinessAction(onRefresh, text => onNotice({ kind: "success", text }));
  const needsReview = item.kind === "allocation" ? item.record.statusCode === "pending" && item.record.approvalStatus !== "approved" && item.record.approvalStatus !== "rejected" : item.record.status === "pending_business";
  const review = (decision: "approve" | "reject") => {
    const approvedQuantity = Number(quantity);
    if (decision === "approve" && quantityError) return;
    if (decision === "approve" && (!Number.isInteger(approvedQuantity) || approvedQuantity <= 0)) { setError("审核数量请填写大于 0 的整数"); return; }
    const payload = { decision, ...(decision === "approve" ? { approvedQuantity } : {}), businessNote: businessNote.trim(), expectedRevision: row.revision, requestId: createRequestId(`${item.kind}-review`) };
    setQuantityRequestError(false);
    void perform({ execute: async () => {
      try { return await (item.kind === "allocation" ? reviewAllocation(role, row.id, payload) : reviewInquiry(role, row.id, payload)); }
      catch (failure) {
        if (item.kind === "allocation") setQuantityRequestError(["invalid_quantity", "allocation_quantity_multiple", "insufficient_available"].includes((failure as ApiError).code ?? ""));
        throw failure;
      }
    }, message: decision === "approve" ? `${row.documentNo} 已批准 ${formatNumber(approvedQuantity)} 件。` : `${row.documentNo} 已拒绝。` });
  };
  const metrics = row.lingxing;
  const metricColumns = approvalDocumentColumns(role).filter(column => column.key);
  const progress = progressLabel(item);
  return <tbody className="approval-record" data-document-no={row.documentNo} data-document-key={`${item.kind}-${row.id}`} aria-label={`${item.kind === "allocation" ? "调拨" : "询库"} ${row.documentNo}`}>
    <tr className="approval-data-row">
      <td className="approval-requested approval-number" data-field="申请数量" title={previewTitle}>{formatNumber(displayedRequested)}</td>
      <td className="approval-number" data-field="商务审核数量" title={previewTitle}>{displayedApproved === null ? "—" : formatNumber(displayedApproved)}</td>
      <td className="approval-number" data-field="套/箱" title={item.kind === "allocation" ? item.record.packPerBox ?? "来源批次套/箱缺失" : undefined}>{item.kind === "allocation" ? item.record.packPerBox || "—" : "—"}</td>
      <td title={row.reviewedAt ? row.businessNote : undefined} data-field="商务备注">{row.reviewedAt ? row.businessNote || "—" : "—"}</td>
      {item.kind === "inquiry" ? <InquiryProcurementCells row={item.record} quantity={procurementQuantity} onQuantityChange={setProcurementQuantity} role={role} onRefresh={onRefresh} onNotice={onNotice} />
        : <><td data-field="供应商库存回复">—</td><td data-field="发货仓库">—</td><td data-field="采购备注">—</td></>}
      <td>{row.department || "—"}</td><td title={row.store}>{row.store || "—"}</td><td title={row.operator}>{row.operator || "—"}</td>
      <td title={row.fnsku}>{row.fnsku || "—"}</td><td title={row.asin}>{row.asin || "—"}</td><td title={row.operatorNote} data-field="运营备注">{row.operatorNote || "—"}</td>
      <td>{row.createdAt ? displayTime(row.createdAt) : "—"}</td>
      <td className="approval-progress">{progress && <Badge label={progress} tone={isActive(item) ? "amber" : "neutral"} dot={false} />}</td>
      {metricColumns.map(column => {
        const value = metrics?.[column.key!];
        return <td key={column.label} className="approval-metric-cell" data-field={column.label}><span className="approval-metric-value">{value == null ? "—" : column.currency ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : formatNumber(value)}</span></td>;
      })}
      <td className="approval-metric-cell" data-field="调货前倍数"><span className="approval-coverage-value">{metricCoverage(row.coverageBefore, metrics)}</span></td><td className="approval-metric-cell" data-field="调货后倍数"><span className="approval-coverage-value">{metricCoverage(row.coverageAfter, metrics)}</span></td>
    </tr>
    <tr className="approval-action-row"><td colSpan={DOCUMENT_COLUMNS.length + metricColumns.length + COVERAGE_COLUMNS.length}><div className="approval-row-actions">
      {role === "business" && (needsReview || uncertain) && <form className="approval-review-form" aria-label={`商务审核 ${row.documentNo}`} onSubmit={event => event.preventDefault()}>
        <label className="field"><span>审核数量</span><input required type="number" min="1" step="1" aria-label="审核数量" aria-invalid={Boolean(quantityError)} value={quantity} disabled={busy || uncertain} onChange={event => { setQuantity(event.target.value); if (quantityRequestError) { setError(null); setQuantityRequestError(false); } }} /></label>
        {item.kind === "allocation" && <label className="field approval-pack-per-box"><span>套/箱</span><output aria-label={`套/箱 ${row.documentNo}`}>{item.record.packPerBox || "—"}</output></label>}
        <label className="field approval-calculated-coverage"><span>计算-调货后倍数</span><output aria-label={`计算-调货后倍数 ${row.documentNo}`}>{calculatedCoverage(quantity, metrics ?? null)}</output></label>
        <label className="field approval-business-note"><span>商务备注</span><input value={businessNote} disabled={busy || uncertain} onChange={event => setBusinessNote(event.target.value)} /></label>
        <button className="btn btn-primary" type="button" disabled={busy || uncertain || Boolean(quantityError)} onClick={() => review("approve")}>批准</button>
        <button className="btn btn-ghost" type="button" disabled={busy || uncertain} onClick={() => review("reject")}>拒绝</button>
      </form>}
      {item.kind === "allocation" && item.record.statusCode === "pending" && item.record.approvalStatus === "approved" && (role === "assistant-1" || role === "assistant-2") && <button className="btn btn-primary btn-sm" type="button" disabled={busy || uncertain} onClick={() => { const requestId = createRequestId("allocation-confirm"); void perform({ execute: () => confirmAllocation(role, row.id, row.revision, requestId), message: `${row.documentNo} 已确认调拨。` }); }}>确认调拨完成</button>}
      {item.kind === "inquiry" && <InquiryFulfillment row={item.record} role={role} onRefresh={onRefresh} onNotice={onNotice} />}
      {role === "business" && needsReview && quantityError && <p className="field-error" role="alert">{quantityError}</p>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {uncertain && <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void perform()}>重试确认</button>}
    </div></td></tr>
  </tbody>;
}

export function ApprovalCenterView({ role }: { role: Role }) {
  const query = useApprovals(role);
  const inventory = useInventoryCatalog(role);
  const [type, setType] = useState<TypeFilter>("all");
  const [category, setCategory] = useState<"all" | Category>("all");
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [progress, setProgress] = useState<ProgressFilter>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportInquiries = async () => {
    setExporting(true);
    try {
      await downloadInquiryExport(role, { type, category, scope, progress, search });
      setNotice({ kind: "success", text: "已导出当前筛选的询库明细（已保存数据）。" });
    } catch (failure) {
      setNotice({ kind: "error", text: failure instanceof Error ? failure.message : "询库导出失败，请重试。" });
    } finally { setExporting(false); }
  };
  const documentColumns = approvalDocumentColumns(role);
  const documentMinWidth = documentColumns.reduce((total, column) => total + column.width, 100);
  const items = useMemo<ApprovalItem[]>(() => [ ...(query.data?.allocations ?? []).map(record => ({ kind: "allocation" as const, record })), ...(query.data?.inquiries ?? []).map(record => ({ kind: "inquiry" as const, record })) ].sort((a, b) => (b.record.createdAt ?? "").localeCompare(a.record.createdAt ?? "")), [query.data]);
  const todoItems = useMemo(() => items.filter(item => isMyTodo(item, role)), [items, role]);
  const groups = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    const filtered = (scope === "mine" ? todoItems : items).filter(item => (type === "all" || item.kind === type) && (category === "all" || item.record.category === category) && (progress === "all" || isActive(item)) && (!keyword || [item.record.operator, item.record.model, item.record.asin, item.record.documentNo].some(value => value.toLocaleLowerCase().includes(keyword))));
    const grouped = new Map<string, ApprovalItem[]>();
    for (const item of filtered) grouped.set(item.record.model, [...(grouped.get(item.record.model) ?? []), item]);
    return [...grouped.entries()];
  }, [items, todoItems, type, category, scope, progress, search]);
  const syncDocuments = groups.flatMap(([, records]) => records.filter(isActive).map(item => ({ kind: item.kind, id: item.record.id })));
  const toggle = (key: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  return <div className="approval-page"><Panel>
    <div className="approval-toolbar"><div className="filter-bar">
      <label className="search-input approval-search"><Icon name="search" size={15} /><input aria-label="搜索运营姓名、型号或 ASIN" placeholder="型号 / 单号 / 运营 / ASIN" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <select aria-label="按需求类型筛选" value={type} onChange={event => setType(event.target.value as TypeFilter)}><option value="all">全部类型</option><option value="allocation">调拨</option><option value="inquiry">询库</option></select>
      <Segmented<"all" | Category> ariaLabel="按类目筛选" value={category} onChange={setCategory} items={[{ value: "all", label: "全部类目" }, { value: "硒鼓", label: "硒鼓" }, { value: "墨盒", label: "墨盒" }]} />
      <select aria-label="筛选审批进度" value={progress} onChange={event => setProgress(event.target.value as ProgressFilter)}><option value="all">全部进度</option><option value="active">处理中</option></select>
      <button className={`btn btn-ghost${scope === "mine" ? " active" : ""}`} type="button" aria-pressed={scope === "mine"} onClick={() => { setScope(scope === "mine" ? "all" : "mine"); setProgress("all"); }}>我的待办 <span className="count-badge">{todoItems.length}</span></button>
    {(search || type !== "all" || category !== "all" || progress !== "all") && <button className="btn btn-ghost" type="button" onClick={() => { setSearch(""); setType("all"); setCategory("all"); setProgress("all"); }}>清除筛选</button>}
    </div><div className="page-actions">{(role === "admin" || role === "purchasing") && <button className="btn btn-ghost" type="button" disabled={exporting} onClick={() => void exportInquiries()}>{exporting ? "导出中…" : "导出询库"}</button>}<LingxingSync role={role} target={{ action: "metrics", documents: syncDocuments }} onSynced={query.refresh} disabled={query.isLoading || query.isError || syncDocuments.length === 0} /><button className="btn btn-ghost" type="button" onClick={() => void query.refresh()}>刷新</button></div></div>
    {query.isError && <div className="callout callout-danger" role="alert">{query.error instanceof Error ? query.error.message : "审批记录加载失败"}<button className="btn btn-ghost btn-sm" onClick={() => void query.refetch()}>重新加载</button></div>}
    {query.isLoading ? <SkeletonTable /> : !query.data ? null : groups.length === 0 ? <EmptyState title={scope === "mine" ? todoItems.length === 0 ? "当前岗位暂无待办" : "当前筛选下没有待办" : "暂无符合条件的审批记录"} /> : <table className="approval-summary-table" aria-label="审批型号汇总">
      <colgroup><col style={{ width: 44 }} /><col style={{ width: "36%" }} /><col /><col /><col /></colgroup>
      <thead><tr><th aria-label="展开或收起型号" />{["型号", "在库库存", "申请数量合计", "商务审核数量合计"].map(label => <th key={label}>{label}</th>)}</tr></thead>
      {groups.map(([model, records]) => {
        const open = expanded.has(model);
        const stock = inventory.data?.models.find(item => item.model === model)?.inStock;
        const requested = records.reduce((sum, item) => sum + item.record.requestedQuantity, 0);
        const approved = records.some(item => item.record.approvedQuantity !== null) ? records.reduce((sum, item) => sum + (item.record.approvedQuantity ?? 0), 0) : null;
        const detailId = `approval-model-${encodeURIComponent(model)}`;
        return <tbody className="approval-model-group" key={model} data-model={model}>
          <tr className={`approval-model-row${open ? " is-open" : ""}`}>
            <td><button type="button" className="approval-expand" aria-label={`${open ? "收起" : "展开"} ${model}`} aria-expanded={open} aria-controls={detailId} onClick={() => toggle(model)}><Icon name="chevron" size={14} /></button></td>
            <td className="approval-model-name"><button type="button" className="approval-model-toggle" aria-expanded={open} aria-controls={detailId} title={model} onClick={() => toggle(model)}>{model}</button></td>
            <td className="approval-number" data-field="在库库存">{stock === undefined ? "—" : formatNumber(stock)}</td>
            <td className="approval-number" data-field="申请数量合计">{formatNumber(requested)}</td>
            <td className="approval-number" data-field="商务审核数量合计">{approved === null ? "—" : formatNumber(approved)}</td>
          </tr>
          <tr className="approval-model-details" id={detailId} hidden={!open}><td colSpan={5}><div className="approval-table-scroll">
            <table className="approval-document-table" aria-label={`${model} 审批单据`} style={{ minWidth: `${documentMinWidth}px` }}>
            <colgroup>{documentColumns.map((column, index) => <col key={index} style={{ width: column.width }} />)}</colgroup>
            <thead><tr>{documentColumns.map(column => <th key={column.label}>{column.label}</th>)}</tr></thead>
            {records.map(item => <ApprovalRecord key={`${item.kind}-${item.record.id}-${role}-${item.kind === "inquiry" ? item.record.events.filter(event => event.type === "recall").slice(-1)[0]?.id ?? 0 : 0}`} item={item} role={role} onRefresh={query.refresh} onNotice={setNotice} />)}
          </table></div></td></tr>
        </tbody>;
      })}
    </table>}
  </Panel><Notice notice={notice} onClose={() => setNotice(null)} /></div>;
}
