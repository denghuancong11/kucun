import { useEffect, useState } from "react";
import { confirmPendingBusinessRequest, fetchSync, readPendingBusinessRequests, type PendingBusinessRequest } from "../api";
import type { Role } from "../types";

const roleNames: Record<Role, string> = { admin: "管理员", "assistant-1": "助理-一团", "assistant-2": "助理-二团", "operation-1": "运营·一团", "operation-2": "运营·二团", purchasing: "采购", alan: "Alan", business: "商务" };
const actionNames: Array<[RegExp, string]> = [
  [/\/inquiries\/\d+\/recall$/, "询库回撤"], [/^\/api\/inquiries$/, "询库申请"], [/\/inquiries\/\d+\/review$/, "询库审核"], [/\/inquiries\/\d+\/reply$/, "采购回复"], [/\/inquiries\/\d+\/archive$/, "询库归档"],
  [/^\/api\/allocations$/, "调拨录入"], [/\/allocations\/\d+\/review$/, "调拨审核"], [/\/allocations\/\d+\/confirm$/, "调拨完成"],
  [/^\/api\/upgrades\/direct$/, "在库升级发起"], [/\/upgrades\/direct\/\d+\/complete$/, "在库升级入库"], [/\/upgrades\/relocations\/\d+\/complete$/, "移仓升级入库"],
  [/^\/api\/upgrades\/relocation-work-items$/, "移仓升级发起"], [/\/procurement$/, "采购资料"], [/\/operation$/, "运营订单"], [/\/ship$/, "移仓发货"],
  [/^\/api\/transit\/import$/, "在途导入"], [/\/transit\/status\/apply$/, "物流更新"], [/\/on-shelf$/, "在途上架"],
];
function describe(record: PendingBusinessRequest) {
  const payload = JSON.parse(record.body);
  const action = actionNames.find(([pattern]) => pattern.test(record.url))?.[1] ?? "业务提交";
  const document = payload.model || payload.fileName || (record.url.match(/\/([0-9]+)\//)?.[1] ? "单据 #" + record.url.match(/\/([0-9]+)\//)![1] : "");
  const quantity = payload.quantity ?? payload.completedQuantity ?? payload.supplierQuantity ?? payload.approvedQuantity;
  return [action, document, quantity !== undefined ? "数量 " + quantity : ""].filter(Boolean).join(" · ");
}
export function PendingBusinessRequests({ role }: { role: Role }) {
  // 当前表单继续使用原来的重试入口；刷新、换页面或换角色后才提供恢复入口。
  const [inherited] = useState(() => {
    try { return readPendingBusinessRequests(true).map(record => record.requestId); } catch { return []; }
  });
  const [records, setRecords] = useState<PendingBusinessRequest[]>([]);
  const [otherRoles, setOtherRoles] = useState<Role[]>([]);
  const [databaseId, setDatabaseId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    const update = () => {
      try {
        const pending = readPendingBusinessRequests().filter(record => inherited.includes(record.requestId));
        setRecords(pending.filter(record => record.role === role));
        setOtherRoles([...new Set(pending.filter(record => record.role !== role).map(record => record.role))]);
      }
      catch (failure) { setMessage((failure as Error).message); }
    };
    const sync = () => { void fetchSync(role).then(next => { if (!cancelled) setDatabaseId(next.databaseId); }).catch(() => { if (!cancelled) setDatabaseId(null); }); };
    update(); sync();
    window.addEventListener("aster-pending-business", update);
    window.addEventListener("focus", sync);
    return () => { cancelled = true; window.removeEventListener("aster-pending-business", update); window.removeEventListener("focus", sync); };
  }, [role, inherited]);
  const confirm = async (record: PendingBusinessRequest) => {
    if (busy) return;
    setBusy(true); setMessage("");
    try { await confirmPendingBusinessRequest(record); setMessage("原提交结果已确认，请查看最新业务记录。"); }
    catch (failure) { setMessage((failure as Error).message); }
    finally { setBusy(false); }
  };
  if (!records.length && !otherRoles.length && !message) return null;
  return <section className="pending-business" aria-label="待确认业务提交">
    {otherRoles.length > 0 && <p>另有未确认提交，请切换到原操作角色：{otherRoles.map(original => roleNames[original]).join("、")}。</p>}
    {records.length > 0 && <><strong>有提交尚未确认</strong><p>以下提交已保留原参数。请确认本次结果后，再办理新的同类操作。</p>
      {records.map(record => <div className="pending-business-row" key={record.requestId}>
        <span>{describe(record)}</span>
        <button className="btn-primary" disabled={busy || !databaseId || databaseId !== record.databaseId} onClick={() => void confirm(record)}>{busy ? "正在确认…" : "确认本次提交"}</button>
        {databaseId && databaseId !== record.databaseId && <span role="alert">当前数据库与原提交不一致，请先核对运行系统。</span>}
      </div>)}</>}
    {message && <p role="status">{message}</p>}
  </section>;
}
