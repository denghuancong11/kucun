import type { AllocationSourceBatchInfo } from "../types";

export function AllocationSourceBatch({ info, inline = false }: { info?: AllocationSourceBatchInfo; inline?: boolean }) {
  if (!info || info.origin === "unrecorded") return <>未记录</>;
  return <div className={`allocation-source-batch${inline ? " allocation-source-batch-inline" : ""}`}>
    {inline && info.shippingMethod && <div>{info.shippingMethod}</div>}
    {info.warehouse && <div>{info.warehouse}</div>}
    {!inline && info.shippingMethod && <div>{info.shippingMethod}</div>}
    {!info.warehouse && !info.shippingMethod && "未记录"}
    {info.origin === "current_batch" && <small className="approval-final-source">当前批次</small>}
  </div>;
}
