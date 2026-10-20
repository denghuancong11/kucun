import type { Allocation, FinalQuantitySource, InkWorkflowStage, Inquiry } from "../types";

export function isNewInkAllocation(row: Allocation | Inquiry): row is Allocation & { inkWorkflowStage: InkWorkflowStage } {
  return "workflowMode" in row && row.workflowMode === "ink-v2" && row.inkWorkflowStage !== null;
}

export function allocationProgressLabel(row: Allocation): string {
  if (row.statusCode === "confirmed") return "已完成";
  if (row.zeroAvailableConfirmed && row.lockedQuantity === 0 && row.statusCode === "pending" && row.approvalStatus === "pending" && !row.tonerConversionStatus && (!isNewInkAllocation(row) || row.inkWorkflowStage === "pending_business")) return "待商务分配（未预锁）";
  if (row.category !== "硒鼓") return row.statusText;
  if (row.tonerConversionStatus === "pending_confirmation") return "转询库，待运营确认";
  if (row.tonerConversionStatus === "accepted") return "已转询库";
  if (row.tonerConversionStatus === "rejected" || row.approvalStatus === "rejected") return "已拒绝";
  if (row.statusCode === "pending") return row.approvalStatus === "approved" ? "待助理确认" : "待商务审核";
  return row.status;
}

export function inquiryProgressLabel(row: Inquiry): string {
  if (row.status === "archived") return row.category === "硒鼓" || ["assistant", "assistant-1", "assistant-2", "purchasing", "logistics"].includes(row.archivedByRole ?? "") ? "已完成" : "";
  if (row.category === "硒鼓" && row.status === "pending_assistant") return "待采购归档";
  return row.statusText;
}

export function finalQuantityLabel(source: FinalQuantitySource, businessTimedOut = false): string {
  return source === "alan" ? "采用 Alan" : source === "business" ? businessTimedOut ? "5h 到期采用商务" : "采用商务" : source === "purchasing" ? "采用采购回复" : "";
}
