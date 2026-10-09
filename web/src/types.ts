export type RequirementKey = "req1" | "req3" | "req4" | "approvals" | "audit";

/* 助理与运营分别按团队办理；硒鼓库存明细和公开调拨摘要保持跨团可见。 */
export type Role = "admin" | "assistant-1" | "assistant-2" | "operation-1" | "operation-2" | "purchasing" | "business";

/** 在途导入、物流更新及页面访问角色；助理数据范围仍由服务端按团队复核。 */
export const TRANSIT_ROLES: readonly Role[] = ["admin", "assistant-1", "assistant-2", "purchasing"];
export const TRANSIT_SHELF_ROLES: readonly Role[] = ["admin", "assistant-1", "assistant-2"];

/* 有效权限：由服务端按类目与角色下发，供库存页面控制字段、展开和操作。 */
export type PermissionFunctionKey = "summary" | "detail" | "expand" | "actions";

export type RolePermissions = Record<PermissionFunctionKey, boolean>;

export interface EffectivePermissions {
  role: Role;
  permissions: Record<string, RolePermissions>;
}

export type Tone = "neutral" | "brand" | "green" | "amber" | "red" | "blue" | "accent";

/* 类目：权限矩阵的维度之一。null 表示类目缺失（未维护）。 */
export type Category = "硒鼓" | "墨盒";

export interface ModelSummary {
  model: string;
  category: Category | null;
  inStock: number;
  locked: number | null;
  available: number | null;
  inTransit: number;
  plan: string;
  shipDate: string;
  version: string;
  fnsku: string;
  revision: number;
  updatedAt: string;
}

export interface StockDetail {
  warehouse: string;
  sourceTeam?: string | null;
  quantity: number;
  baseQuantity: number;
  locked: number;
  available: number;
  plan: string | null;
  date: string | null;
  version: string | null;
  fnsku: string | null;
  packPerBox?: string | null;
  batchKey: string;
  revision: number;
  isLegacyPlaceholder?: boolean;
}

export interface TransitDetail {
  id: number;
  quantity: number;
  originalQuantity?: number;
  plan: string | null;
  date: string | null;
  version: string | null;
  fnsku: string | null;
  packPerBox?: string | null;
  brand?: string;
  transportMethod?: string;
  shippingMethod?: string;
  team?: string;
  status: string;
  statusCode?: "in_transit" | "on_shelf";
  onShelf: string;
  revision: number;
  updatedAt?: string;
  importBatchId?: number | null;
  isLegacyPlaceholder?: boolean;
}

export interface TransitImportRow {
  sourceRow: number;
  data: {
    model: string;
    quantity: number;
    fnsku: string;
    shippingMethod: string;
    plan: string;
    date: string;
    rawDate?: string;
    team: string;
    version: string;
    packPerBox: string;
  };
  errors?: TransitValidationError[];
}

export interface TransitValidationError {
  row: number;
  field: string;
  code?: string;
  message: string;
}

export interface TransitImportPreview {
  fileName: string;
  rows: TransitImportRow[];
  validation: { canPreview?: boolean; canImport: boolean; errorCount: number; errors: TransitValidationError[] };
  fileSha256: string;
  templateSha256: string;
  previewToken?: string;
  previewExpiresAt?: string;
}

export interface TransitStatusRow {
  sourceRow: number;
  data: {
    plan: string;
    status: string;
  };
}

export interface TransitStatusUpdate {
  sourceRow: number;
  id: number;
  revision: number;
  model: string;
  plan: string;
  date: string;
  version: string;
  fnsku: string;
  currentStatus: string;
  status: string;
  quantity: number;
}

export interface TransitStatusPreview {
  fileName: string;
  rows: TransitStatusRow[];
  updates: TransitStatusUpdate[];
  totalRows: number;
  distinctPlanCount: number;
  duplicatePlanCount: number;
  duplicatePlans: Array<{ plan: string; sourceRows: number[]; finalSourceRow: number | null }>;
  matchedPlanCount: number;
  unmatchedPlanCount: number;
  unmatchedPlans: string[];
  errors: TransitValidationError[];
  validation: { canPreview?: boolean; errorCount: number; errors: TransitValidationError[] };
  canApply: boolean;
  fileSha256: string;
  templateSha256: string;
  previewToken?: string;
  previewExpiresAt?: string;
}

export interface TransitStatusResult {
  ok: true;
  rowCount: number;
  processedPlanCount: number;
  matchedPlanCount: number;
  updatedDetailCount: number;
  unmatchedPlanCount: number;
  unmatchedPlans: string[];
  updated: TransitStatusUpdate[];
}

export interface TransitImportResult {
  ok: true;
  importId: number;
  rowCount: number;
  inventoryApplied: boolean;
  rows: Array<Record<string, unknown>>;
  sync: SyncState;
}

export interface TransitImportRecord {
  id: number;
  fileName: string;
  fileSha256: string;
  templateSha256: string;
  status: "imported" | "staged" | "reverted";
  rowCount: number;
  inventoryApplied: boolean;
  active: boolean;
  createdByRole: Role;
  createdAt: string;
  replacesImportId: number | null;
}

export interface TransitImportListPayload {
  ok?: true;
  imports: TransitImportRecord[];
  sync: SyncState;
}

export type AllocationStatus = "待修改" | "调拨中，预锁定" | "调拨完成，已备份" | "已撤销" | "已撤回";
export type AllocationStatusCode = "draft" | "pending" | "confirmed" | "cancelled" | "withdrawn";

/* 调拨记录：由 /api/allocations 持久化。
   记录行可见性（两种类目均按团）已由后端过滤；totals 与库存可见范围一致：硒鼓公开、墨盒按来源团队过滤。
   审计字段（createdByRole 等）第十三轮起写入；历史记录没有这些字段，故全部可选。 */
export interface Allocation {
  plan: string;
  date: string;
  id: number;
  documentNo: string;
  model: string;
  batchKey: string;
  packPerBox: string | null;
  quantity: number;
  asin: string;
  operatorNote: string;
  requestedQuantity: number;
  approvedQuantity: number | null;
  businessNote: string;
  approvalStatus: "pending" | "approved" | "rejected" | "legacy";
  reviewedAt: string | null;
  reviewedByRole: string | null;
  category?: Category;
  lingxing: LingxingMetrics | null;
  coverageBefore: number | null;
  coverageAfter: number | null;
  version: string;
  fnsku: string;
  department: string;
  store: string;
  operator: string;
  time: string;
  status: AllocationStatus;
  statusCode: AllocationStatusCode;
  createdByRole?: string;
  createdAt?: string;
  confirmedByRole?: string;
  confirmedAt?: string;
  sourceDocument?: string;
  cancelledByRole?: string;
  cancelledAt?: string;
  cancelReason?: string;
  withdrawnByRole?: string;
  withdrawnAt?: string;
  withdrawReason?: string;
  externalSyncStatus: "not_synced" | "synced" | "cancel_pending";
  revision: number;
  updatedAt: string;
}

export interface AllocationEntry {
  quantity: number;
  department: string;
  store: string;
  operator: string;
  fnsku: string;
  asin: string;
  operatorNote: string;
  requestId: string;
}

export interface LingxingMetrics {
  sales7d: number;
  sales30d: number;
    orderGrossProfit?: number;
  fbaAvailable: number;
  fbaPendingTransfer: number;
  fbaTransferring: number;
  fbaInbound: number;
  capturedAt: string;
  scope: "all_stores";
}

export type InquiryStatus = "pending_business" | "pending_purchasing" | "pending_assistant" | "archived" | "rejected" | "cancelled";

export interface InquiryShipment {
  id: number;
  quantity: number;
  date: string;
  revision: number;
  usedQuantity: number;
  availableQuantity: number;
}

export interface Inquiry {
  id: number;
  documentNo: string;
  model: string;
  category: Category;
  quantity: number;
  requestedQuantity: number;
  approvedQuantity: number | null;
  supplierQuantity: number | null;
  department: string;
  store: string;
  operator: string;
  fnsku: string;
  asin: string;
  operatorNote: string;
  businessNote: string;
  shippingWarehouse: string;
  procurementNote: string;
  plan: string;
  date: string;
  version: string;
  status: InquiryStatus;
  statusText: string;
  createdAt: string;
  reviewedAt: string | null;
  archivedAt: string | null;
  archivedByRole: string | null;
  fbaShippedAt: string | null;
  shipments: InquiryShipment[];
  shippedQuantity: number;
  unshippedQuantity: number;
  events: DocumentEvent[];
  cancelReason: string | null;
  revision: number;
  lingxing: LingxingMetrics | null;
  coverageBefore: number | null;
  coverageAfter: number | null;
}

export interface InquiryExportFilters {
  type: "all" | "allocation" | "inquiry";
  category: "all" | Category;
  scope: "all" | "mine";
  progress: "all" | "active";
  search: string;
}

export interface ApprovalsPayload {
  allocations: Array<Allocation & { category: Category }>;
  inquiries: Inquiry[];
  sync: SyncState;
}

export interface ApprovalReview {
  decision: "approve" | "reject";
  approvedQuantity?: number;
  businessNote: string;
  expectedRevision: number;
  requestId: string;
}

export interface AllocationBatchTotals {
  base: number;
  onHand: number;
  locked: number;
  available: number;
  revision: number;
  updatedAt: string;
}

export interface SyncState {
  databaseId: string;
  dataVersion: number;
  updatedAt: string;
  schemaVersion: number;
  pollAfterMs: number;
}

export interface InventoryCatalogPayload {
  models: ModelSummary[];
  stockDetails: Record<string, StockDetail[]>;
  inTransitDetails: Record<string, TransitDetail[]>;
  sync: SyncState;
  securityMode: "demo-role-header-not-authentication";
}

export interface AllocationsPayload {
  model: string;
  category: Category;
  records: Record<string, Allocation[]>;
  publicRecords: Record<string, AllocationSummary[]>;
  totals: Record<string, AllocationBatchTotals>;
  sync: SyncState;
}

export interface AllocationSummary {
  id: number;
  documentNo: string;
  operator: string;
  department: string;
  requestedQuantity: number | null;
  approvedQuantity: number | null;
  lockedQuantity: number | null;
  issuedQuantity: number | null;
  status: string;
}

export interface DirectUpgradeSource {
  model: string;
  category: Category;
  sourceVersion: string;
  inStock: number;
  allocationLocked: number;
  upgradeLocked: number;
  available: number;
  batchCount: number;
}

export interface RelocationCandidate {
  allocationId: number | null;
  inquiryId: number | null;
  inquiryShipmentId: number | null;
  sourceKind: "allocation" | "inquiry" | "fba";
  fbaArchiveId: number | null;
  fbaShippedAt: string | null;
  documentNo: string;
  model: string;
  category: Category;
  asin: string | null;
  plan: string;
  shipDate: string;
  sourceVersion: string;
  fnsku: string;
  initialQuantity: number;
  soldQuantity: number;
  fbaRemainingQuantity: number;
  shippedQuantity: number;
  completedQuantity: number;
  inProgressQuantity: number;
  department: string;
  store: string;
  confirmedAt: string;
  upgradeId: number | null;
  upgradeNo: string | null;
}

export interface DirectUpgradeLine {
  warehouse: string;
  sourceTeam?: string | null;
  id: number;
  sourceBatchKey: string;
  completions: {version: string; warehouse: string; quantity: number}[];
  plan: string;
  shipDate: string;
  sourceVersion: string;
  fnsku: string;
  initialQuantity: number;
  completedQuantity: number;
  inProgressQuantity: number;
  revision: number;
  updatedAt: string;
}

export interface UpgradeRelocation {
  externalShipments: RelocationExternalShipment[];
  id: number;
  workId: number | null;
  completions: {version: string; warehouse: string; quantity: number}[];
  relocationNo: string;
  sequence: number;
  inquiryShipmentId: number | null;
  shipDate: string;
  sourceQuantityBefore: number;
  soldQuantity: number;
  fbaRemainingQuantity: number;
  shippedQuantity: number;
  completedQuantity: number;
  inProgressQuantity: number;
  rma: string;
  relocationAddress: string;
  removalOrderNo: string;
  carrier: string;
  trackingNo: string;
  externalSyncStatus: "not_synced" | "synced";
  externalItems?: RelocationExternalItem[];
  status: "active" | "withdrawn";
  statusText: string;
  newVersion: string | null;
  createdByRole: Role;
  createdAt: string;
  revision: number;
  updatedAt: string;
  withdrawnByRole: Role | null;
  withdrawnAt: string | null;
  withdrawReason: string | null;
}

export interface RelocationExternalShipment {
  lineId: number;
  externalId: string;
  storeId: string;
  storeName: string;
  countryCode: string;
  orderNo: string;
  fnsku: string;
  quantity: number;
  usedQuantity: number;
  availableQuantity: number;
  carrier: string;
  trackingNo: string;
  shipDate: string;
  capturedAt: string;
}

export interface RelocationExternalItem {
  lineId: number;
  quantity: number;
  snapshot: RelocationExternalShipment;
}

export interface RelocationWorkItem {
  id: number;
  workNo: string;
  allocationId: number | null;
  inquiryId: number | null;
  inquiryShipmentId: number | null;
  sourceKind: "allocation" | "inquiry" | "fba";
  fbaArchiveId: number | null;
  documentNo: string;
  upgradeId: number | null;
  upgradeNo: string | null;
  relocationId: number | null;
  relocationNo: string | null;
  model: string;
  category: Category;
  asin: string | null;
  sourceVersion: string;
  plan: string;
  shipDate: string;
  fnsku: string;
  department: string;
  store: string;
  confirmedAt: string;
  sourceQuantityBefore: number;
  soldQuantity: number | null;
  status: "awaiting_procurement" | "awaiting_operation" | "awaiting_shipping" | "shipped" | "withdrawn" | "cancelled";
  statusText: string;
  initiatedByRole: Role;
  initiatedAt: string;
  rma: string | null;
  relocationAddress: string | null;
  procurementByRole: Role | null;
  procurementAt: string | null;
  removalOrderNo: string | null;
  operationByRole: Role | null;
  operationAt: string | null;
  fbaRemainingQuantity: number | null;
  shippedQuantity: number | null;
  carrier: string | null;
  trackingNo: string | null;
  externalSyncStatus: "not_synced" | "synced";
  externalShipments?: RelocationExternalShipment[];
  externalItems?: RelocationExternalItem[];
  shippingByRole: Role | null;
  shippingAt: string | null;
  cancelledByRole: Role | null;
  cancelledAt: string | null;
  revision: number;
  updatedAt: string;
}

interface UpgradeBase {
  id: number;
  upgradeNo: string;
  model: string;
  category: Category;
  sourceVersion: string;
  newVersion: string | null;
  status: "active" | "completed" | "cancelled";
  statusText: string;
  initiatedByRole: Role;
  initiatedAt: string;
  revision: number;
  updatedAt: string;
  initialQuantity: number;
  completedQuantity: number;
  inProgressQuantity: number;
  cancelledByRole?: Role | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
}

export interface DirectUpgrade extends UpgradeBase {
  kind: "direct";
  lines: DirectUpgradeLine[];
}

export interface RelocationUpgrade extends UpgradeBase {
  kind: "relocation";
  allocationId: number | null;
  inquiryId: number | null;
  inquiryShipmentId: number | null;
  sourceKind: "allocation" | "inquiry" | "fba";
  fbaArchiveId: number | null;
  documentNo: string;
  plan: string;
  shipDate: string;
  asin: string | null;
  fnsku: string;
  department: string;
  store: string;
  confirmedAt: string;
  fbaRemainingQuantity: number;
  soldQuantity: number;
  shippedQuantity: number;
  relocations: UpgradeRelocation[];
}

export type UpgradeJob = DirectUpgrade | RelocationUpgrade;

export interface UpgradeDashboardPayload {
  overseasWarehouses: string[];
  directSources: DirectUpgradeSource[];
  relocationCandidates: RelocationCandidate[];
  relocationWorkItems: RelocationWorkItem[];
  upgrades: UpgradeJob[];
  sync: SyncState;
  securityMode: "demo-role-header-not-authentication";
}

export interface DocumentEvent {
  id: number;
  type: string;
  role: string;
  at: string;
  reason?: string;
  payload: Record<string, unknown>;
}

export interface InventoryLedgerEntry {
  id: number;
  type: string;
  onHandDelta: number;
  lockedDelta: number;
  relatedLedgerId?: number;
  reversalGroup?: string;
  role: string;
  at: string;
}

export interface DocumentHistory {
  document: Allocation;
  events: DocumentEvent[];
  ledger: InventoryLedgerEntry[];
}

export type NoticeKind = "success" | "warning" | "error";

export interface NoticeMessage {
  kind: NoticeKind;
  text: string;
}

/* 后端保留的现有库存事件类型；具体页面可再收窄可见范围。 */
export type AuditAction = "business_correction" | "entry" | "review" | "reject" | "confirm" | "cancel" | "withdraw" | "import_stage" | "legacy_import" | "transit_import" | "transit_import_revert" | "transit_status" | "transit_on_shelf" | "transit_off_shelf" | "transit_merge" | "transit_delete" | "transit_manual" | "transit_team_corrected" | "upgrade_direct_start" | "upgrade_direct_complete" | "upgrade_relocation_started" | "upgrade_relocation_procurement" | "upgrade_relocation_operation" | "upgrade_relocation_corrected" | "upgrade_relocation_cancelled" | "upgrade_relocation_created" | "upgrade_relocation_complete";

export interface AuditQuery {
  action: AuditAction;
  model?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/* /api/audit 的列表行。兼容旧字段 action/recordId/batch，也接受扩展接口的
   eventType/businessNo/documentId 和真实库存增减字段。 */
export interface AuditRecord {
  inTransitDelta?: number;
  eventId?: number;
  eventType?: AuditAction;
  action?: AuditAction;
  at: string;
  role: string;
  recordId?: number;
  documentId?: number | null;
  businessNo?: string | null;
  documentNo?: string | null;
  model?: string | null;
  category?: string | null;
  batch?: string;
  quantity?: number | null;
  onHandDelta?: number | null;
  lockedDelta?: number | null;
  availableDelta?: number | null;
  effectKnown?: boolean;
  result?: string;
  correction?: {workNo: string; before: string; after: string};
  sourceAvailable?: boolean;
  ledgerIds?: number[];
  relatedLedgerIds?: number[];
  reversalGroup?: string | null;
  department?: string;
  team?: string;
  store?: string;
  operator?: string;
  requestId?: string;
  reason?: string;
}

export interface AuditPayload {
  records: AuditRecord[];
  sync: SyncState;
}
