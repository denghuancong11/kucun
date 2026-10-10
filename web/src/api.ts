import type {
  TransferUpgradePreview,
  TransferUpgradeRow,
  TransferUpgradesPayload,
  AllocationsPayload,
  AllocationEntry,
  ApprovalsPayload,
  ApprovalReview,
  AuditPayload,
  AuditQuery,
  DocumentHistory,
  EffectivePermissions,
  InventoryCatalogPayload,
  InquiryExportFilters,
  Role,
  SyncState,
  TransitImportListPayload,
  TransitImportPreview,
  TransitImportResult,
  TransitStatusRow,
  TransitStatusPreview,
  TransitStatusResult,
  UpgradeDashboardPayload,
} from "./types";

export type ApiError = Error & { code?: string; status?: number; details?: unknown };
import type { LingxingJob, LingxingJobs, LingxingTarget } from "./lingxing-sync";

export function requestLingxingSync(role: Role, target: LingxingTarget, requestId: string): Promise<{ok: true; job: LingxingJob}> {
  return requestJson('/api/lingxing/jobs', role, {method:"POST", headers:{"content-type":"application/json"},
    signal: AbortSignal.timeout(30000),
    body:JSON.stringify({...target, requestId}),
  });
}
export function fetchLingxingJobs(role:Role,target:LingxingTarget,requestId:string):Promise<LingxingJobs> {
  return requestJson(`/api/lingxing/jobs?action=${target.action}&requestId=${encodeURIComponent(requestId)}${target.action==='logistics'?`&workId=${target.workId}`:''}`,role);
}



export type PendingBusinessRequest = { url: string; role: Role; body: string; requestId: string; databaseId: string };
const pendingStorageKey = "aster-pending-business-requests";
const activeRequests = new Set<string>();
let currentDatabaseId: string | null = null;

export function readPendingBusinessRequests(includeActive = false): PendingBusinessRequest[] {
  const raw = sessionStorage.getItem(pendingStorageKey);
  const records = raw ? JSON.parse(raw) as PendingBusinessRequest[] : [];
  if (!Array.isArray(records)) throw new Error("待确认提交记录无法读取，请先核对浏览器保存的提交信息。");
  return records.filter(record => includeActive || !activeRequests.has(record.requestId));
}
function savePendingBusinessRequests(records: PendingBusinessRequest[]) {
  if (records.length) sessionStorage.setItem(pendingStorageKey, JSON.stringify(records));
  else sessionStorage.removeItem(pendingStorageKey);
  window.dispatchEvent(new Event("aster-pending-business"));
}
function pendingRequestError(message: string): ApiError {
  const error = new Error(message) as ApiError;
  error.status = 409;
  return error;
}
export async function confirmPendingBusinessRequest(record: PendingBusinessRequest): Promise<unknown> {
  const sync = await fetchSync(record.role);
  if (sync.databaseId !== record.databaseId) throw pendingRequestError("当前数据库与原提交不一致，请先核对运行系统；本次未重发。");
  return requestJson(record.url, record.role, { method: "POST", headers: { "content-type": "application/json" }, body: record.body });
}

async function requestJson<T>(url: string, role: Role, init?: RequestInit): Promise<T> {
  let pending: PendingBusinessRequest | null = null;
  let replaying = false;
  if (init?.method === "POST" && typeof init.body === "string" && url !== "/api/lingxing/jobs") {
    const payload = JSON.parse(init.body);
    if (payload.requestId) {
      if (!currentDatabaseId) await fetchSync(role);
      pending = { url, role, body: init.body, requestId: payload.requestId, databaseId: currentDatabaseId! };
      let records: PendingBusinessRequest[];
      try { records = readPendingBusinessRequests(true); }
      catch { throw pendingRequestError("无法读取本次提交的确认信息，请核对浏览器存储后再提交；本次未发送。"); }
      const original = records.find(record => record.requestId === pending!.requestId);
      if (original) {
        replaying = true;
        const sync = await fetchSync(role);
        if (original.databaseId !== sync.databaseId || original.role !== role || original.url !== url || original.body !== pending.body) {
          throw new Error("当前数据库或操作内容与原提交不一致，请先核对；本次未重发。");
        }
        pending.databaseId = original.databaseId;
        records = readPendingBusinessRequests(true);
      }
      const previous = records.find(record => record.url === url && record.role === role);
      if (previous && (previous.requestId !== pending.requestId || previous.body !== pending.body)) {
        throw pendingRequestError("此项操作还有未确认的提交，请先确认原提交结果，再填写新单。");
      }
      activeRequests.add(pending.requestId);
      try { savePendingBusinessRequests(previous ? records : [...records, pending]); }
      catch {
        activeRequests.delete(pending.requestId);
        throw pendingRequestError("无法保存本次提交的确认信息，请核对浏览器存储后再提交；本次未发送。");
      }
    }
  }
  const settle = (confirmed: boolean) => {
    if (!pending) return;
    activeRequests.delete(pending.requestId);
    if (confirmed) savePendingBusinessRequests(readPendingBusinessRequests(true).filter(record => record.requestId !== pending!.requestId));
    else window.dispatchEvent(new Event("aster-pending-business"));
  };
  let response: Response;
  let raw: string;
  try {
    response = await fetch(url, {
      cache: "no-store",
      ...(!init?.method || init.method === "GET" ? { signal: AbortSignal.timeout(10000) } : {}),
      ...init,
      headers: { "x-role": role, ...(init?.headers ?? {}) },
    });
    raw = await response.text();
  } catch (error) {
    settle(false);
    const reason = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
      ? "等待库存服务响应超时"
      : "与库存服务的连接中断";
    throw new Error(init?.method === "POST"
      ? `${reason}，尚未确认是否保存；重试时保留本次填写内容。`
      : `${reason}，请检查网络和部署电脑的库存服务后重新加载。`);
  }
  let result: any = null;
  try { result = raw ? JSON.parse(raw) : null; } catch { /* 非 JSON 响应由下方保留可诊断文本 */ }
  if (init?.method === "POST" && response.ok && result?.ok !== true) {
    settle(false);
    throw new Error("库存服务回执无法确认是否保存；请保留本次填写内容并重试确认。");
  }
  if (!response.ok || !result?.ok) {
    // 后端只有在幂等缓存未命中且事务已回滚时标记未应用；前置鉴权拒绝不能据此解除未知。
    if (replaying && response.status >= 400 && response.status < 500 && result?.requestNotApplied !== true) {
      settle(false);
      throw new Error("当前操作被拒绝，原提交结果仍未核对；已保留原提交，请恢复办理条件后再确认。" + (result?.error ? " " + result.error : ""));
    }
    settle(response.status >= 400 && response.status < 500);
    /* 服务端业务错误码（如 duplicate）随异常抛出，调用方据此走二次确认分支 */
    const error = new Error(result?.error || (raw.trim() ? `请求失败（HTTP ${response.status}）：${raw.trim().slice(0, 160)}` : `请求失败（HTTP ${response.status}）`)) as ApiError;
    if (result?.code) error.code = result.code;
    error.status = response.status;
    if (result?.details !== undefined) error.details = result.details;
    throw error;
  }
  if (result.sync?.databaseId) currentDatabaseId = result.sync.databaseId;
  settle(true);
  if (init?.method === "POST" && result.sync) window.dispatchEvent(new CustomEvent("aster-write", { detail: result.sync }));
  return result as T;
}

/** 查询当前角色自身的有效权限（按类目切片，不含完整矩阵）。 */
export function fetchEffectivePermissions(role: Role): Promise<EffectivePermissions> {
  return requestJson<EffectivePermissions>("/api/permissions/effective", role);
}

/** 查询某型号的调拨记录（记录行已由后端按团过滤；totals 按该角色的库存可见范围聚合）。 */
export function fetchAllocations(role: Role, model: string): Promise<AllocationsPayload> {
  return requestJson<AllocationsPayload>(`/api/allocations?model=${encodeURIComponent(model)}`, role);
}

/** 每次直接读取服务器已保存明细，不使用审批缓存或采购草稿。 */
export async function downloadInquiryExport(role: Role, filters: InquiryExportFilters): Promise<void> {
  try {
    const response = await fetch("/api/approvals/inquiries/export?" + new URLSearchParams({ ...filters }), {
      cache: "no-store", signal: AbortSignal.timeout(10000), headers: { "x-role": role },
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || "请求失败（HTTP " + response.status + "）");
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url; link.download = "询库明细.xlsx";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    throw new Error("询库导出读取失败：" + (error instanceof Error ? error.message : "请检查网络后重试"));
  }
}

export function clearInquiryDisplay(role: Role, requestId: string): Promise<{ hiddenCount: number }> {
  return requestJson("/api/approvals/inquiries/clear", role, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId }),
  });
}

export function fetchApprovals(role: Role): Promise<ApprovalsPayload> {
  return requestJson<ApprovalsPayload>("/api/approvals", role);
}

export function reviewAllocation(role: Role, id: number, payload: ApprovalReview): Promise<unknown> {
  return requestJson(`/api/allocations/${id}/review`, role, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

export function createInquiry(role: Role, payload: AllocationEntry & { model: string }): Promise<unknown> {
  return requestJson("/api/inquiries", role, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

export function reviewInquiry(role: Role, id: number, payload: ApprovalReview): Promise<unknown> {
  return requestJson(`/api/inquiries/${id}/review`, role, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

export function replyInquiry(role: Role, id: number, payload: {
  supplierQuantity: number; shippingWarehouse: string; procurementNote: string; expectedRevision: number; requestId: string;
}): Promise<unknown> {
  return requestJson(`/api/inquiries/${id}/reply`, role, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

export function recallInquiry(role: Role, id: number, payload: { expectedRevision: number; requestId: string }): Promise<unknown> {
  return requestJson(`/api/inquiries/${id}/recall`, role, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

export function archiveInquiry(role: Role, id: number, payload: {
  plan: string; date: string; version: string; expectedRevision: number; requestId: string;
}): Promise<unknown> {
  return requestJson(`/api/inquiries/${id}/archive`, role, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

/** 统一数据库的数据版本。页面轮询只比较版本，变化后再按需重查业务数据。 */
export async function fetchSync(role: Role): Promise<SyncState> {
  const result = await requestJson<{ sync: SyncState }>("/api/sync", role);
  return result.sync;
}

/** 型号、在库批次与在途明细全部来自统一后端，不再使用浏览器静态库存作为权威值。 */
export function fetchInventoryCatalog(role: Role): Promise<InventoryCatalogPayload> {
  return requestJson<InventoryCatalogPayload>("/api/inventory/catalog", role);
}

export function fetchUpgradeDashboard(role: Role): Promise<UpgradeDashboardPayload> {
  return requestJson<UpgradeDashboardPayload>("/api/upgrades", role);
}

export function createDirectUpgrade(
  role: Role,
  payload: { model: string; sourceVersion: string; requestId: string },
): Promise<unknown> {
  return requestJson("/api/upgrades/direct", role, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function completeDirectUpgrade(
  role: Role,
  id: number,
  payload: { sourceLineId?: number; completedQuantity: number; newVersion: string; targetWarehouse: string; expectedRevision: number; requestId: string },
): Promise<unknown> {
  return requestJson(`/api/upgrades/direct/${id}/complete`, role, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function initiateRelocationUpgrade(
  role: Role,
  payload: ({ allocationId: number; inquiryId?: never; fbaArchiveId?: never } | { inquiryId: number; sourceRevision?: number; allocationId?: never; fbaArchiveId?: never } | { fbaArchiveId: number; allocationId?: never; inquiryId?: never }) & { requestId: string; account?: string },
): Promise<unknown> {
  return requestJson("/api/upgrades/relocation-work-items", role, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function recordRelocationProcurement(
  role: Role,
  id: number,
  payload: { rma: string; relocationAddress: string; expectedRevision: number; requestId: string },
): Promise<unknown> {
  return requestJson(`/api/upgrades/relocation-work-items/${id}/procurement`, role, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

export function recordRelocationOperation(
  role: Role,
  id: number,
  payload: { removalOrderNo: string; expectedRevision: number; requestId: string },
): Promise<{automaticSync?: {state:string;message:string;requestId:string}}> {
  return requestJson(`/api/upgrades/relocation-work-items/${id}/operation`, role, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

export function shipRelocationUpgrade(
  role: Role,
  id: number,
  payload: {
    fbaRemainingQuantity: number;
    externalItems: Array<{ lineId: number; quantity: number }>;
    expectedRevision: number;
    requestId: string;
  },
): Promise<unknown> {
  return requestJson(`/api/upgrades/relocation-work-items/${id}/ship`, role, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

export function completeRelocationUpgrade(
  role: Role,
  id: number,
  payload: { inProgressQuantity?: number; reversals?: {ledgerId:number;quantity:number}[]; sourceLineId?: number; completedQuantity: number; newVersion: string; targetWarehouse: string; expectedRevision: number; requestId: string },
): Promise<unknown> {
  return requestJson(`/api/upgrades/relocations/${id}/complete`, role, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function requestUpload<T>(url: string, role: Role, file: File, options: { dateYear: number }): Promise<T> {
  return requestJson<T>(url, role, {
    method: "POST",
    headers: {
      "x-file-name": encodeURIComponent(file.name), "content-type": file.type || "application/octet-stream",
      "x-date-year": String(options.dateYear),
    },
    body: file,
  });
}

export function previewTransitImport(role: Role, file: File, options: { dateYear: number }): Promise<TransitImportPreview> {
  return requestUpload<TransitImportPreview>("/api/transit/preview", role, file, options);
}

export function importTransit(
  role: Role,
  payload: { previewToken: string; rows: unknown[]; requestId: string; fileName?: string; fileHash?: string; templateHash?: string },
): Promise<TransitImportResult> {
  return requestJson<TransitImportResult>("/api/transit/import", role, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function fetchTransitImports(role: Role): Promise<TransitImportListPayload> {
  return requestJson<TransitImportListPayload>("/api/transit/imports", role);
}

export function previewTransitStatus(role: Role, file: File, options: { dateYear: number }): Promise<TransitStatusPreview> {
  return requestUpload<TransitStatusPreview>("/api/transit/status/preview", role, file, options);
}

export function applyTransitStatus(
  role: Role,
  payload: { previewToken: string; rows: TransitStatusRow[]; requestId: string; fileName?: string; fileHash?: string; templateHash?: string },
): Promise<TransitStatusResult> {
  return requestJson<TransitStatusResult>("/api/transit/status/apply", role, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function markTransitOnShelf(
  role: Role,
  id: number,
  payload: { expectedRevision: number; yes: string; requestId: string },
): Promise<unknown> {
  return requestJson(`/api/transit/${id}/on-shelf`, role, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** 录入并预锁定；成功或失败后调用方重新拉取整页数据保持口径一致。
    requestId 为幂等键：同一表单填写周期内复用，双击 / 网络重试不会产生重复记录；
    allowDuplicate 为复核弹窗确认“非重复录入”后的服务端警告豁免。 */
export function createAllocation(
  role: Role,
  batch: { key: string; model: string; plan: string; date: string; version: string },
  entry: AllocationEntry,
): Promise<unknown> {
  return requestJson("/api/allocations", role, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...batch, ...entry, sourceBatchKey: batch.key }),
  });
}

/** 确认调拨完成：弹窗内二次确认即可，记录转“调拨完成，已备份”。 */
export function confirmAllocation(role: Role, id: number, expectedRevision: number, requestId: string): Promise<unknown> {
  return requestJson(`/api/allocations/${id}/confirm`, role, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision, requestId }),
  });
}

export function fetchAllocationHistory(role: Role, id: number): Promise<DocumentHistory> {
  return requestJson<DocumentHistory>(`/api/allocations/${id}/history`, role);
}

export function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

/** 按单一业务操作分类查询库存流水；筛选和条数限制均由服务端执行。 */
export function fetchAuditLog(role: Role, query: AuditQuery): Promise<AuditPayload> {
  const params = new URLSearchParams({
    action: query.action,
    limit: String(query.limit ?? 200),
  });
  if (query.model?.trim()) params.set("model", query.model.trim());
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  return requestJson<AuditPayload>(`/api/audit?${params}`, role);
}

export function previewTransferUpgrade(role: Role, file: File): Promise<TransferUpgradePreview> {
  return requestJson("/api/transfer-upgrades/preview", role, { method: "POST",
    headers: { "x-file-name": encodeURIComponent(file.name), "content-type": "application/octet-stream" }, body: file });
}
export function importTransferUpgrade(role: Role, payload: { previewToken: string; fileName: string; fileHash: string; templateHash: string; rows: TransferUpgradeRow[]; requestId: string }): Promise<{ rowCount: number }> {
  return requestJson("/api/transfer-upgrades/import", role, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}
export function fetchTransferUpgrades(role: Role): Promise<TransferUpgradesPayload> {
  return requestJson("/api/transfer-upgrades", role);
}

export type RelocationUpdatePreview = {unchangedCount:number;fileName:string;fileSha256:string;templateSha256:string;previewToken?:string;errors:{sourceRow:number;message:string}[];rows:{sourceRow:number;data:{id:string;revision:string;workNo:string;rma:string;relocationAddress:string};processedAddress:string;before:{rma:string;relocationAddress:string;status:string};afterStatus:string}[]};
export function previewRelocationUpdate(role:Role,file:File):Promise<RelocationUpdatePreview> {
  return requestJson('/api/upgrades/relocation-update/preview',role,{method:'POST',headers:{'x-file-name':encodeURIComponent(file.name)},body:file});
}
export function importRelocationUpdate(role:Role,payload:unknown):Promise<unknown> {
  return requestJson('/api/upgrades/relocation-update/import',role,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
}
export async function downloadRelocationTemplate(role:Role) {
  const response=await fetch('/api/upgrades/relocation-update/template',{cache:'no-store',headers:{'x-role':role}});
  if(!response.ok)throw new Error((await response.json()).error || '更新模板读取失败');
  const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download='移仓升级-更新模板.xlsx';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export type TransferStage = 'rma'|'count'|'progress';
export const transferStageLabels:Record<TransferStage,string>={rma:'RMA',count:'实际清点数量',progress:'升级进度'};
export type TransferUpdatePreview = {unchangedCount:number;fileName:string;stage:TransferStage;fileSha256:string;templateSha256:string;previewToken?:string;errors:{sourceRow:number;message:string}[];rows:{sourceRow:number;data:{documentNo:string;revision:number;stage:TransferStage;reversals:{batchKey:string;quantity:number}[]};before:import('./types').TransferUpgradeData;after:import('./types').TransferUpgradeData;quantityDelta:number;receiptBatches:import('./types').TransferUpgradeRecord['receiptBatches']}[]};
export function previewTransferUpdate(role:Role,stage:TransferStage,file:File):Promise<TransferUpdatePreview>{return requestJson('/api/transfer-upgrades/update/preview?stage='+stage,role,{method:'POST',headers:{'x-file-name':encodeURIComponent(file.name)},body:file});}
export function importTransferUpdate(role:Role,stage:TransferStage,payload:unknown):Promise<unknown>{return requestJson('/api/transfer-upgrades/update/import?stage='+stage,role,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});}
export async function downloadTransferUpdate(role:Role,stage:TransferStage){
 const r=await fetch('/api/transfer-upgrades/update/template?stage='+stage,{cache:'no-store',headers:{'x-role':role}});if(!r.ok)throw new Error((await r.json()).error||'模板读取失败');
 const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;a.download='转仓升级-'+transferStageLabels[stage]+'更新模板.xlsx';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export async function exportUpgradeFlow(role:Role,kind:'relocation'|'transfer',filters?:{model:string;version:string;source:string}) {
 const query=filters?'?'+new URLSearchParams(filters).toString():'';
 const response=await fetch((kind==='relocation'?'/api/upgrades/relocation-update/export':'/api/transfer-upgrades/update/export')+query,{cache:'no-store',headers:{'x-role':role}});
 if(!response.ok)throw new Error((await response.json()).error||'数据流导出失败，请重新尝试');
 const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=(kind==='relocation'?'移仓升级':'转仓升级')+'-数据流.xlsx';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
