import { useEffect, useRef, useState } from "react";
import { confirmPendingBusinessRequest, fetchSync, readPendingBusinessRequests, type PendingBusinessRequest } from "../api";
import type { Role } from "../types";
import { settleConfirmedTransitDraft } from "../utils/transitDraft";

const roleNames: Record<Role, string> = { admin: "管理员", "assistant-1": "助理-一团", "assistant-2": "助理-二团", "operation-1": "运营·一团", "operation-2": "运营·二团", purchasing: "采购", logistics: "物流", alan: "Alan", business: "商务" };
const actionNames: Array<[RegExp, string]> = [
  [/^\/api\/upgrades\/relocation-waybills\/confirm$/, "运单文件已下载。"],
  [/^\/api\/upgrades\/relocation-update\/import(?:\?|$)/, "移仓RMA和地址批量更新"],
  [/^\/api\/transfer-upgrades\/update\/import\?stage=rma(?:&|$)/, "转仓升级 RMA 更新"],
  [/^\/api\/transfer-upgrades\/update\/import\?stage=count(?:&|$)/, "转仓升级实际清点数量更新"],
  [/^\/api\/transfer-upgrades\/update\/import\?stage=progress(?:&|$)/, "转仓升级进度更新"],
  [/^\/api\/transfer-upgrades\/update\/import(?:\?|$)/, "转仓升级办理"],
  [/^\/api\/transfer-upgrades\/import$/, "转仓升级导入"],
  [/^\/api\/approvals\/inquiries\/clear$/, "隐藏已完成或已拒绝的询库"],
  [/\/inquiries\/\d+\/alan-review$/, "询库 Alan 审核"],
  [/\/allocations\/\d+\/alan-review$/, "调拨 Alan 审核"],
  [/\/allocations\/\d+\/transfer-inquiry$/, "商务转询库"],
  [/\/allocations\/\d+\/conversion-decision$/, "运营确认转询库"],
  [/\/allocations\/\d+\/reply$/, "提交调拨供应商库存回复"], [/\/allocations\/\d+\/archive$/, "调拨采购归档"], [/\/allocations\/\d+\/recall$/, "调拨回撤"],
  [/\/inquiries\/\d+\/recall$/, "询库回撤"], [/^\/api\/inquiries$/, "询库申请"], [/\/inquiries\/\d+\/review$/, "询库审核"], [/\/inquiries\/\d+\/reply$/, "询库采购回复"], [/\/inquiries\/\d+\/archive$/, "询库归档"],
  [/^\/api\/allocations$/, "调拨录入"], [/\/allocations\/\d+\/review$/, "调拨审核"], [/\/allocations\/\d+\/confirm$/, "调拨完成"],
  [/^\/api\/upgrades\/direct$/, "在库升级发起"], [/\/upgrades\/direct\/\d+\/complete$/, "在库升级入库"], [/\/upgrades\/relocations\/\d+\/complete$/, "移仓升级入库"],
  [/^\/api\/upgrades\/relocation-work-items$/, "移仓升级发起"], [/\/procurement$/, "保存移仓 RMA 与地址"], [/\/operation$/, "保存移仓订单号"], [/\/ship$/, "移仓发货"],
  [/^\/api\/transit\/import$/, "在途导入"], [/\/transit\/status\/apply$/, "在途物流更新"], [/\/on-shelf$/, "在途上架／直发FBA确认"],
];
function describe(record: PendingBusinessRequest) {
  const payload = JSON.parse(record.body);
  const action = record.url === "/api/allocations" && payload.zeroAvailableConfirmed === true ? "调拨需求（未预锁）" : actionNames.find(([pattern]) => pattern.test(record.url))?.[1] ?? "业务提交";
  if (record.url === "/api/upgrades/relocation-waybills/confirm") return action;
  const document = record.context || [payload.model, payload.store, payload.plan, payload.version || payload.sourceVersion || payload.newVersion, payload.removalOrderNo, payload.fileName].filter(Boolean).join(" / ");
  const quantity = payload.quantity ?? payload.completedQuantity ?? payload.supplierQuantity ?? payload.approvedQuantity ?? payload.alanQuantity;
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
  const [busy, setBusy] = useState<string|null>(null);
  const running=useRef(false);
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
    if (running.current) return;
    running.current=true;setBusy(record.requestId); setMessage("");
    try { const result = await confirmPendingBusinessRequest(record); settleConfirmedTransitDraft(record, result); setMessage(describe(record)+(record.url === "/api/upgrades/relocation-waybills/confirm" ? "" : "：原提交结果已确认。")); }
    catch (failure) { setMessage((failure as Error).message); }
    finally { running.current=false;setBusy(null); }
  };
  if (!records.length && !otherRoles.length && !message) return null;
  return <section className="pending-business" aria-label="待确认业务提交">
    {otherRoles.length > 0 && <p>其他角色待确认提交：{otherRoles.map(original => roleNames[original]).join("、")}。</p>}
    {records.length > 0 && <><strong>有提交尚未确认</strong>
      {records.map(record => <div className="pending-business-row" key={record.requestId}>
        <span>{describe(record)}</span>
        <button className="btn-primary" disabled={!!busy || !databaseId || databaseId !== record.databaseId} onClick={() => void confirm(record)}>{busy===record.requestId ? "正在确认…" : "确认本次提交"}</button>
        {databaseId && databaseId !== record.databaseId && <span role="alert">当前数据库与原提交不一致，请先核对运行系统。</span>}
      </div>)}</>}
    {message && <p role="status">{message}</p>}
  </section>;
}
