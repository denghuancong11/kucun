import type {
  AllocationsPayload,
  AllocationEntry,
  ApprovalsPayload,
  ApprovalReview,
  AuditPayload,
  AuditQuery,
  DocumentHistory,
  EffectivePermissions,
  InventoryCatalogPayload,
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
  payload: ({ allocationId: number; inquiryId?: never; fbaArchiveId?: never } | { inquiryId: number; allocationId?: never; fbaArchiveId?: never } | { fbaArchiveId: number; allocationId?: never; inquiryId?: never }) & { requestId: string },
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
): Promise<unknown> {
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
  payload: { sourceLineId?: number; completedQuantity: number; newVersion: string; targetWarehouse: string; expectedRevision: number; requestId: string },
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
