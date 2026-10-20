import type { AllocationSourceBatchInfo } from "../types";

export function AllocationSourceBatch({ info }: { info?: AllocationSourceBatchInfo }) {
  if (!info || info.origin === "unrecorded") return <>未记录</>;
  return <div className="allocation-source-batch">
    {info.warehouse && <div>{info.warehouse}</div>}
    {info.shippingMethod && <div>{info.shippingMethod}</div>}
    {!info.warehouse && !info.shippingMethod && "未记录"}
    {info.origin === "current_batch" && <small className="approval-final-source">当前批次信息（非提交快照）</small>}
  </div>;
}
