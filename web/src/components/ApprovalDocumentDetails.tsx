import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAllocationHistory, fetchInquiryHistory, formatNumber } from "../api";
import type { Allocation, DocumentHistory, Inquiry, InquiryHistory, Role } from "../types";
import { allocationProgressLabel, inquiryProgressLabel } from "../utils/approvalWorkflow";
import { ApprovalHistory } from "./ApprovalHistory";
import { UpgradeDialog } from "./UpgradeDialog";
import { displayTime } from "./ui";
import { AllocationSourceBatch } from "./AllocationSourceBatch";

export type ApprovalDocumentReference = { kind: "allocation" | "inquiry"; id: number };

function useDocumentHistory(role: Role, reference: ApprovalDocumentReference) {
  return useQuery<DocumentHistory | InquiryHistory>({ queryKey: ["approval-history", role, reference.kind, reference.id], queryFn: () => reference.kind === "allocation" ? fetchAllocationHistory(role, reference.id) : fetchInquiryHistory(role, reference.id) });
}

export function ApprovalDocumentButton({ role, reference, label, showHistory = true }: {
  role: Role; reference: ApprovalDocumentReference; label?: string; showHistory?: boolean;
}) {
  const [selected, setSelected] = useState<ApprovalDocumentReference | null>(null);
  return <><button type="button" className="link-btn" onClick={() => setSelected(reference)}>{label ?? (reference.kind === "allocation" ? "查看调拨" : "查看询库")}</button>
    {selected && <ApprovalDocumentDialog role={role} reference={selected} onNavigate={setSelected} onClose={() => setSelected(null)} showHistory={showHistory} />}
  </>;
}

function ApprovalDocumentDialog({ role, reference, onNavigate, onClose, showHistory }: {
  role: Role; reference: ApprovalDocumentReference; onNavigate: (reference: ApprovalDocumentReference) => void; onClose: () => void; showHistory: boolean;
}) {
  const query = useDocumentHistory(role, reference);
  const businessName = reference.kind === "allocation" ? "调拨" : "询库";
  return <UpgradeDialog title={`${businessName}详情${query.data ? " · " + query.data.document.documentNo : ""}`} busy={false} onClose={onClose} wide>
    <ApprovalDocumentBody reference={reference} query={query} onNavigate={onNavigate} showHistory={showHistory} />
  </UpgradeDialog>;
}

export function ApprovalDocumentInline({ role, reference }: { role: Role; reference: ApprovalDocumentReference }) {
  const [selected, setSelected] = useState(reference);
  const query = useDocumentHistory(role, selected);
  const businessName = selected.kind === "allocation" ? "调拨" : "询库";
  return <section className="approval-inline-detail" aria-label={`${businessName}详情`}>
    <h3>{businessName}详情{query.data ? " · " + query.data.document.documentNo : ""}</h3>
    <ApprovalDocumentBody reference={selected} query={query} onNavigate={setSelected} showHistory={false} />
  </section>;
}

function ApprovalDocumentBody({ reference, query, onNavigate, showHistory = true }: {
  reference: ApprovalDocumentReference; query: ReturnType<typeof useDocumentHistory>; onNavigate: (reference: ApprovalDocumentReference) => void; showHistory?: boolean;
}) {
  const row = query.data?.document;
  const allocation = row && reference.kind === "allocation" ? row as Allocation : null;
  const inquiry = row && reference.kind === "inquiry" ? row as Inquiry : null;
  const businessName = reference.kind === "allocation" ? "调拨" : "询库";
  const quantity = (value: number | null | undefined) => value == null ? "—" : formatNumber(value);
  const fields: Array<[string, ReactNode]> = row ? [
    ["状况", allocation ? allocationProgressLabel(allocation) : inquiryProgressLabel(inquiry!)],
    ["型号", row.model], ["类目", row.category], ["团队", row.department], ["店铺", row.store], ["运营", row.operator], ["ASIN", row.asin], ["FNSKU", row.fnsku],
    ["原申请数量", quantity(row.originalRequestedQuantity)], ["商务审核数量", quantity(row.businessReviewedQuantity)], ["最终执行数量", row.finalQuantity == null ? (allocation?.statusCode === "confirmed" || inquiry?.status === "archived" ? "历史未记录" : "—") : quantity(row.finalQuantity)],
    ...(allocation ? [["当前调拨占用", quantity(allocation.lockedQuantity)], ["实际调出", quantity(allocation.issuedQuantity)], ["来源批次", allocation.batchKey]] as Array<[string, string | null]> : []),
    ...(allocation ? [["发货方式-所属海外仓", <AllocationSourceBatch info={allocation.sourceBatchInfo} />]] as Array<[string, ReactNode]> : []),
    ...(inquiry ? [["供应商库存回复", quantity(inquiry.supplierQuantity)], ["发货仓库", inquiry.shippingWarehouse], ["采购备注", inquiry.procurementNote],
      ...(inquiry.sourceAllocationId != null ? [["原调拨申请量", quantity(inquiry.sourceOriginalRequestedQuantity)], ["商务转询库量", quantity(inquiry.originalRequestedQuantity)]] : [])] as Array<[string, string | null]> : []),
    ["商务备注", row.businessNote], ["运营备注", row.operatorNote], ["发货计划号", row.plan], ["发货日期", row.date], ["原版本号", row.version],
    ["提交时间", displayTime(row.createdAt)],
    ...(inquiry?.archivedAt ? [["归档时间", displayTime(inquiry.archivedAt)], ["归档岗位", ["assistant", "assistant-1", "assistant-2"].includes(inquiry.archivedByRole ?? "") ? "助理（历史归档）" : inquiry.archivedByRole === "purchasing" ? "采购" : inquiry.archivedByRole]] as Array<[string, string | null]> : []),
  ] : [];
  return <div className="upgrade-dialog-body approval-document-detail" data-document-reference={`${reference.kind}-${reference.id}`}>
      {query.isLoading && <p role="status">正在读取{businessName}记录…</p>}
      {query.isError && <p className="dialog-error" role="alert">{query.error.message}</p>}
      {row && <><dl className="upgrade-fields">{fields.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value == null || value === "" ? "—" : value}</dd></div>)}</dl>
        <div className="approval-row-actions">
          {allocation?.convertedInquiryId != null && <button type="button" className="link-btn" onClick={() => onNavigate({ kind: "inquiry", id: allocation.convertedInquiryId! })}>查看承接询库 · {allocation.convertedInquiryNo || `#${allocation.convertedInquiryId}`}</button>}
          {inquiry?.sourceAllocationId != null && <button type="button" className="link-btn" onClick={() => onNavigate({ kind: "allocation", id: inquiry.sourceAllocationId! })}>查看来源调拨 · {inquiry.sourceAllocationNo || `#${inquiry.sourceAllocationId}`}</button>}
        </div>
        {showHistory && <ApprovalHistory events={query.data!.events} category={row.category} />}
      </>}
    </div>;
}
