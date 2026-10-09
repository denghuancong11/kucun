import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { TextDecoder } from "node:util";
import { BusinessError, InventoryDatabase, INVENTORY_SCHEMA_VERSION, OVERSEAS_WAREHOUSES, OPERATION_GROUPS, ROLES, TRANSIT_ROLES, hashBuffer, hashTemplate, normalizeTransitPlan, requireValidStoreCode, transitCategoryFromFileName } from "./inventory-db.mjs";
import { LingxingHost } from './lingxing-host.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const webDist = process.env.ASTER_WEB_DIST ? path.resolve(process.env.ASTER_WEB_DIST) : path.join(root, "web", "dist");
/* 生产发布可把可变配置与数据放在版本目录之外；未设置时保持开发环境原路径。 */
const stateRoot = process.env.ASTER_STATE_ROOT ? path.resolve(process.env.ASTER_STATE_ROOT) : root;
const port = Number(process.env.PORT || 4173);
/* 监听地址：默认仅本机回环；局域网部署时通过环境变量 HOST=0.0.0.0 放开，
   配合 Windows 防火墙规则（仅专用网络 + 局域网网段）限制访问范围。 */
const host = process.env.HOST || "127.0.0.1";
/* 测试进程归属标识：仅测试脚本设置，生产环境不发送该响应头。 */
const testInstanceId = String(process.env.ASTER_TEST_INSTANCE_ID || "").trim();
const maxUploadBytes = 8 * 1024 * 1024;
/* 统一 SQLite 是库存业务数据的唯一权威来源。数据库缺失或版本不匹配时启动失败，
   禁止自动创建空库后继续运行。 */
const inventory = new InventoryDatabase(stateRoot);
inventory.refreshApprovalDisplay();
const lingxingHost = new LingxingHost(inventory, { authorize: authorizeLingxingTarget });

function fileSha256(filePath) {
  try {
    return crypto.createHash("sha256").update(fsSync.readFileSync(filePath)).digest("hex").toUpperCase();
  } catch {
    return null;
  }
}

const backendSourceSha256 = fileSha256(path.join(root, "server.mjs"));
const databaseSourceSha256 = fileSha256(path.join(root, "inventory-db.mjs"));
const lingxingHostSourceSha256 = fileSha256(path.join(root, "lingxing-host.mjs"));
const buildMetaPath = path.join(webDist, "build-meta.json");
function frontendBuildInfo() {
  try {
    const raw = fsSync.readFileSync(buildMetaPath, "utf8");
    const metadata = JSON.parse(raw);
    return { ...metadata, fileSha256: fileSha256(buildMetaPath) };
  } catch {
    return { fileSha256: null, backendSourceSha256: null, frontendBundleSha256: null };
  }
}

function healthPayload() {
  const frontend = frontendBuildInfo();
  return {
    ok: true,
    service: "aster-inventory",
    build: {
      backendSourceSha256,
      databaseSourceSha256,
      lingxingHostSourceSha256,
      frontendBundleSha256: frontend.frontendBundleSha256 ?? null,
      frontendMetaSha256: frontend.fileSha256,
      frontendBackendSourceSha256: frontend.backendSourceSha256 ?? null,
      consistent: Boolean(backendSourceSha256 && backendSourceSha256 === frontend.backendSourceSha256 && databaseSourceSha256 === frontend.databaseSourceSha256 && lingxingHostSourceSha256 === frontend.lingxingHostSourceSha256),
    },
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    sync: inventory.syncState(),
  };
}

/* ------------------------------------------------------------------ */
/* 权限矩阵：类目 × 角色 × 功能/字段，持久化在 data/permissions.json。   */
/* 服务端仅读取该矩阵；前端配置页已移除，实际鉴权链路继续使用它。       */
/* ------------------------------------------------------------------ */
/* 运营按团队拆分：operation-1=运营·一团，operation-2=运营·二团。 */
const roles = ROLES;
const transitRoleSet = new Set(TRANSIT_ROLES);
const permissionFunctions = ["summary", "detail", "expand", "actions"];
const permissionsFile = path.join(stateRoot, "data", "permissions.json");

/* 当前只配置墨盒权限；未列入矩阵的类目按全开放下发。 */
const allCategories = ["硒鼓", "墨盒"];
const controlledCategories = ["墨盒"];
const openPermissions = { summary: true, detail: true, expand: true, actions: true };

function defaultPermissions() {
  const byRole = (summary, detail, expand, actions) => ({ summary, detail, expand, actions });
  const matrix = {};
  for (const category of controlledCategories) {
    matrix[category] = {
      admin: byRole(true, true, true, true),
      "assistant-1": byRole(true, true, true, true),
      "assistant-2": byRole(true, true, true, true),
      /* 运营默认全量开放：录入调拨必须能看到批次行（批次行在 detail/expand 门内），
         只开 actions 不开 detail/expand 会导致 API 允许而 UI 不可达的自相矛盾。
         需要收紧时由受控部署流程维护 permissions.json；运行期不提供矩阵写入口。 */
      "operation-1": byRole(true, true, true, true),
      "operation-2": byRole(true, true, true, true),
      purchasing: byRole(true, true, true, true),
      alan: byRole(true, true, true, true),
      business: byRole(true, true, true, true),
    };
  }
  return matrix;
}

/** 严格校验权限矩阵结构，不合法时抛出带原因的错误。
    类目必须全部为受控类目（硒鼓不设权限，禁止写入矩阵）；
    每个类目的角色键必须与 roles 完全一致（旧角色键如 operation 判为未知角色）。 */
function validatePermissions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("权限矩阵必须是对象");
  for (const category of Object.keys(value)) {
    if (!controlledCategories.includes(category)) throw new Error(`类目“${category}”不设置权限，无需在权限矩阵中配置`);
  }
  for (const category of controlledCategories) {
    const byRole = value[category];
    if (!byRole || typeof byRole !== "object" || Array.isArray(byRole)) throw new Error(`缺少受控类目“${category}”的配置`);
    for (const key of Object.keys(byRole)) {
      if (!roles.includes(key)) throw new Error(`类目“${category}”含未知角色“${key}”`);
    }
    for (const role of roles) {
      const perms = byRole[role];
      if (!perms || typeof perms !== "object") throw new Error(`类目“${category}”缺少角色“${role}”的配置`);
      for (const fn of permissionFunctions) {
        if (typeof perms[fn] !== "boolean") throw new Error(`类目“${category}”角色“${role}”的“${fn}”必须是布尔值`);
      }
    }
  }
  return value;
}

/** 数据文件损坏/不可读：fail-closed 抛错（error.corrupt 标记，接口层转 500）。
    绝不回退默认数据——回退后下一次写入会用默认值覆盖真实文件，是主动数据丢失路径。 */
function corruptError(file, cause) {
  const error = new Error(`数据文件 ${path.basename(file)} 已损坏或不可读，已停止相关读写，请从 backups/ 还原（原因：${cause.message}）`);
  error.corrupt = true;
  return error;
}

async function loadPermissions() {
  let raw;
  try {
    raw = await fs.readFile(permissionsFile, "utf8");
  } catch (error) {
    /* 仅文件缺失（全新部署）回退内置默认；损坏则 fail-closed */
    if (error && error.code === "ENOENT") return defaultPermissions();
    throw corruptError(permissionsFile, error);
  }
  try {
    const parsed = JSON.parse(raw);
    /* v26 将助理权限按团队拆分；保留原助理矩阵到两个新角色，再移除旧配置键。 */
    for (const category of controlledCategories) {
      if (parsed?.[category] && typeof parsed[category] === "object" && !Array.isArray(parsed[category])) {
        if (Object.prototype.hasOwnProperty.call(parsed[category], "assistant")) {
          const legacy = parsed[category].assistant;
          parsed[category]["assistant-1"] ??= { ...legacy };
          parsed[category]["assistant-2"] ??= { ...legacy };
          delete parsed[category].assistant;
        }
      }
      if (parsed?.[category] && typeof parsed[category] === "object" && !Array.isArray(parsed[category])
        && !Object.prototype.hasOwnProperty.call(parsed[category], "purchasing")) {
        parsed[category].purchasing = { ...openPermissions };
      }
      if (parsed?.[category] && typeof parsed[category] === "object" && !Array.isArray(parsed[category])
        && !Object.prototype.hasOwnProperty.call(parsed[category], "business")) {
        parsed[category].business = { ...openPermissions };
      }
    }
    for (const category of controlledCategories) {
      if (parsed?.[category] && !Object.hasOwn(parsed[category], "alan")) parsed[category].alan = { ...parsed[category].purchasing };
    }
    return validatePermissions(parsed);
  } catch (error) {
    throw corruptError(permissionsFile, error);
  }
}

/** 从请求头解析当前角色；无效或缺失返回 null。正式环境应由登录会话替代。 */
function requestRole(request) {
  const role = String(request.headers["x-role"] || "");
  return roles.includes(role) ? role : null;
}

const grossProfitHiddenRoles = new Set(["assistant-1", "assistant-2", "purchasing", "alan"]);

function approvalDocumentForRole(document, role) {
  if (!document || !grossProfitHiddenRoles.has(role) || !document.lingxing
    || !Object.hasOwn(document.lingxing, "orderGrossProfit")) return document;
  const lingxing = { ...document.lingxing };
  delete lingxing.orderGrossProfit;
  return { ...document, lingxing };
}

function approvalResultForRole(result, role) {
  if (!result || !grossProfitHiddenRoles.has(role)) return result;
  return {
    ...result,
    ...(result.record ? { record: approvalDocumentForRole(result.record, role) } : {}),
    ...(result.document ? { document: approvalDocumentForRole(result.document, role) } : {}),
  };
}

function approvalErrorDetailsForRole(details, role) {
  if (!details || !grossProfitHiddenRoles.has(role) || !details.current) return details;
  return { ...details, current: approvalDocumentForRole(details.current, role) };
}

async function handlePermissionsApi(request, response, pathname) {
  /* 当前角色的有效权限：只返回该角色自身的类目切片，不暴露完整矩阵。
     矩阵中不存在的类目（如硒鼓，按口径不设权限）下发全开放切片。
     库存汇总页据此控制明细字段与展开按钮。 */
  if (pathname === "/api/permissions/effective" && request.method === "GET") {
    const role = requestRole(request);
    if (!role) {
      sendJson(response, 403, { ok: false, error: "缺少有效角色，无法确定权限" });
      return true;
    }
    const matrix = await loadPermissions();
    const slice = {};
    for (const category of allCategories) slice[category] = matrix[category]?.[role === "alan" ? "purchasing" : role] ?? openPermissions;
    sendJson(response, 200, { ok: true, role, permissions: slice });
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 统一库存与调拨接口。角色仍来自可伪造的 x-role，仅用于演示流程，不是登录鉴权。 */
/* ------------------------------------------------------------------ */
const operationGroups = OPERATION_GROUPS;
const assistantRoleSet = new Set(["assistant-1", "assistant-2"]);
const entryRoles = new Set(["admin", "operation-1", "operation-2"]);
/* 在途导入、物流状态更新和 YES 上架均由四个现有角色执行；管理员撤回仍保持独立的管理员边界。 */
const confirmRoles = new Set(["assistant-1", "assistant-2"]);
const allocationDepartments = ["一团", "二团"];

async function parseJsonRequest(request) {
  try {
    const raw = (await readBody(request)).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw new BusinessError(400, "invalid_json", "提交内容无法读取，请重新打开表单后提交");
  }
}

async function categoryPermissions(role, category) {
  if (!controlledCategories.includes(category)) return openPermissions;
  const matrix = await loadPermissions();
  return matrix[category]?.[role === "alan" ? "purchasing" : role] ?? { summary: false, detail: false, expand: false, actions: false };
}

async function requireActions(role, category) {
  if (!(await categoryPermissions(role, category)).actions) {
    throw new BusinessError(403, "action_forbidden", `当前角色在“${category}”类目无后续操作权限`);
  }
}

async function requireTransitRowActions(role, fileName, rows) {
  const fallbackCategory = transitCategoryFromFileName(fileName);
  const categories = new Set(rows.map(item => {
    const data = item?.data ?? item;
    const model = String(data?.model ?? data?.ITEM ?? "").trim();
    return inventory.getModel(model)?.category ?? fallbackCategory;
  }));
  for (const category of categories) await requireActions(role, category);
}
function requireRole(request) {
  const role = requestRole(request);
  if (!role) throw new BusinessError(403, "invalid_demo_role", "缺少有效角色，无法执行该操作");
  return role;
}

function requireNonBlank(payload, field, label) {
  const value = String(payload?.[field] ?? "").trim();
  if (!value) throw new BusinessError(400, `missing_${field}`, `${field === "requestId" ? "本次提交信息不完整，请重新打开表单后提交" : `请填写${label}`}`);
  return value;
}

function requirePreviewToken(payload) {
  const token = String(payload?.previewToken ?? "").trim();
  if (!token) throw new BusinessError(400, "preview_token_missing", "请先上传文件并预览");
  return token;
}

function requirePositiveInteger(value, label = "数量") {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new BusinessError(400, "invalid_quantity", `${label}请填写大于 0 的整数`);
  return parsed;
}

function requireNonNegativeInteger(value, label = "数量") {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new BusinessError(400, "invalid_quantity", `${label}请填写 0 或正整数`);
  return parsed;
}

function normalizeAuditBoundary(value, label, endOfDay = false) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`).toISOString();
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BusinessError(400, "invalid_audit_time", `${label}不是有效时间`);
  }
  return parsed.toISOString();
}

function ensureDocumentVisibility(document, role) {
  const group = operationGroups[role];
  if (group && document.department !== group) {
    throw new BusinessError(403, "group_forbidden", `当前角色仅可查看或操作本团（${group}）记录`);
  }
}

async function getDocumentForRole(id, role, requireAction = true) {
  const document = inventory.getDocument(id);
  if (!document) throw new BusinessError(404, "not_found", `找不到调拨单据 ${id}`);
  const model = inventory.getModel(document.model);
  if (!model) throw new BusinessError(500, "catalog_missing", `单据 ${id} 对应型号不存在`);
  if (requireAction) await requireActions(role, model.category);
  ensureDocumentVisibility(document, role);
  return { document, category: model.category };
}

async function handleInventoryApi(request, response, pathname) {
  const role = requireRole(request);
  if (pathname === "/api/sync" && request.method === "GET") {
    inventory.refreshApprovalDisplay();
    sendJson(response, 200, { ok: true, sync: inventory.syncState() });
    return true;
  }
  if (pathname === "/api/inventory/catalog" && request.method === "GET") {
    const catalog = inventory.getCatalog({ visibleGroup: operationGroups[role] ?? null });
    const models = [];
    const stockDetails = {};
    const inTransitDetails = {};
    for (const model of catalog.models) {
      const permission = await categoryPermissions(role, model.category);
      if (!permission.summary) continue;
      const transit = catalog.inTransitDetails[model.model] ?? [];
      /* 墨盒运营和助理按来源团队裁剪；硒鼓库存明细保持两团公开。 */
      const visibleTransit = transit;
      const visibleIdentityRows = permission.detail
        ? [...(catalog.stockDetails[model.model] ?? []), ...visibleTransit].filter((row) => !row.isLegacyPlaceholder)
        : [];
      const identityValue = (field) => {
        const values = visibleIdentityRows.map((row) => String(row[field] ?? "").trim()).filter((value) => value && value !== "-");
        return [...new Set(values)].join("、") || "-";
      };
      /* 汇总余额与下发的可见明细来自同一读取结果，避免主行和展开合计不一致。 */
      models.push({
        ...model,
        plan: identityValue("plan"),
        shipDate: identityValue("date"),
        version: identityValue("version"),
        fnsku: identityValue("fnsku"),
        locked: permission.detail && permission.expand ? model.locked : null,
        available: permission.detail && permission.expand ? model.available : null,
        inTransit: model.inTransit,
      });
      if (permission.detail && permission.expand) {
        stockDetails[model.model] = catalog.stockDetails[model.model] ?? [];
        inTransitDetails[model.model] = visibleTransit;
      }
    }
    sendJson(response, 200, {
      ok: true,
      models,
      stockDetails,
      inTransitDetails,
      sync: catalog.sync,
      securityMode: "demo-role-header-not-authentication",
    });
    return true;
  }
  return false;
}




async function handleAllocationsApi(request, response, pathname) {
  const role = requireRole(request);

  if (pathname === "/api/allocations" && request.method === "GET") {
    const modelName = new URL(request.url, "http://localhost").searchParams.get("model") || "";
    const model = inventory.getModel(modelName);
    if (!model) throw new BusinessError(404, "unknown_model", `未知型号“${modelName}”`);
    const permission = await categoryPermissions(role, model.category);
    if (!permission.summary || !permission.detail || !permission.expand) {
      throw new BusinessError(403, "detail_forbidden", "当前角色无权查看该类目库存明细");
    }
    const visibleGroup = model.category === "墨盒" ? operationGroups[role] ?? null : null;
    // 硒鼓公开摘要跨团可见；完整单据和指标继续按当前角色所属团队过滤。
    const recordVisibleGroup = operationGroups[role] ?? null;
    if (visibleGroup && !inventory.getCatalog({ visibleGroup }).models.some((row) => row.model === modelName)) {
      throw new BusinessError(404, "unknown_model", `当前团队无型号“${modelName}”的可见库存明细`);
    }
    const result = inventory.getAllocations(modelName, { visibleGroup });
    const records = {};
    for (const [key, rows] of Object.entries(result.records)) {
      records[key] = rows.filter((row) => {
        if (!permission.actions) return false;
        /* 待修改草稿和已撤回历史只在管理员专用区域处理，普通业务列表不下发。 */
        if (["draft", "withdrawn"].includes(row.statusCode)) return false;
        if (recordVisibleGroup && row.department !== recordVisibleGroup) return false;
        try {
          if (!recordVisibleGroup) return true;
          ensureDocumentVisibility(row, role);
          return true;
        } catch {
          return false;
        }
      }).map((row) => approvalDocumentForRole(row, role));
    }
    const publicRecords = Object.fromEntries(Object.entries(result.publicRecords).map(([key, rows]) => [
      key,
      visibleGroup ? rows.filter((row) => row.department === visibleGroup) : rows,
    ]));
    sendJson(response, 200, { ok: true, ...result, records, publicRecords, securityMode: "demo-role-header-not-authentication" });
    return true;
  }

  if (pathname === "/api/allocations" && request.method === "POST") {
    if (!entryRoles.has(role)) throw new BusinessError(403, "entry_forbidden", "当前角色无录入权限");
    const payload = await parseJsonRequest(request);
    const modelName = requireNonBlank(payload, "model", "型号");
    const model = inventory.getModel(modelName);
    if (!model) throw new BusinessError(400, "unknown_model", `未知型号“${modelName}”`);
    await requireActions(role, model.category);
    const department = requireNonBlank(payload, "department", "调拨部门");
    if (!allocationDepartments.includes(department)) throw new BusinessError(400, "invalid_department", "调拨部门仅限一团 / 二团");
    const group = operationGroups[role];
    if (group && department !== group) throw new BusinessError(403, "group_forbidden", `运营仅可为本团（${group}）录入`);
    const result = inventory.createAllocation({
      role,
      model: modelName,
      sourceBatchKey: payload.sourceBatchKey == null ? undefined : String(payload.sourceBatchKey),
      plan: requireNonBlank(payload, "plan", "发货计划号"),
      date: requireNonBlank(payload, "date", "发货时间"),
      version: requireNonBlank(payload, "version", "版本"),
      quantity: requirePositiveInteger(payload.quantity),
      department,
      store: requireValidStoreCode(payload.store),
      operator: requireNonBlank(payload, "operator", "调拨运营"),
      fnsku: requireNonBlank(payload, "fnsku", "已贴 FNSKU"),
      asin: requireNonBlank(payload, "asin", "ASIN").toUpperCase(),
      operatorNote: String(payload.operatorNote ?? "").trim(),
      requestId: requireNonBlank(payload, "requestId", "提交编号"),
    });
    sendJson(response, 200, approvalResultForRole(result, role));
    return true;
  }

  const reviewMatch = pathname.match(/^\/api\/allocations\/(\d+)\/review$/);
  if (reviewMatch && request.method === "POST") {
    if (role !== "business") throw new BusinessError(403, "review_forbidden", "仅商务可审核调拨");
    const id = Number(reviewMatch[1]);
    await getDocumentForRole(id, role);
    const payload = await parseJsonRequest(request);
    sendJson(response, 200, approvalResultForRole(inventory.reviewAllocation({
      id, role,
      decision: requireNonBlank(payload, "decision", "审核结果"),
      approvedQuantity: payload.decision === "reject" ? null : requirePositiveInteger(payload.approvedQuantity, "审核数量"),
      businessNote: String(payload.businessNote ?? "").trim(),
      expectedRevision: Number(payload.expectedRevision),
      requestId: requireNonBlank(payload, "requestId", "提交编号"),
    }), role));
    return true;
  }

  const confirmMatch = pathname.match(/^\/api\/allocations\/(\d+)\/confirm$/);
  if (confirmMatch && request.method === "POST") {
    if (!confirmRoles.has(role)) throw new BusinessError(403, "confirm_forbidden", "仅助理角色可确认调拨完成");
    const id = Number(confirmMatch[1]);
    await getDocumentForRole(id, role);
    const payload = await parseJsonRequest(request);
    const result = inventory.confirmAllocation({
      id,
      role,
      expectedRevision: Number(payload.expectedRevision),
      requestId: requireNonBlank(payload, "requestId", "提交编号"),
    });
    sendJson(response, 200, approvalResultForRole(result, role));
    return true;
  }

  const historyMatch = pathname.match(/^\/api\/allocations\/(\d+)\/history$/);
  if (historyMatch && request.method === "GET") {
    const id = Number(historyMatch[1]);
    await getDocumentForRole(id, role, false);
    sendJson(response, 200, approvalResultForRole({ ok: true, ...inventory.history(id) }, role));
    return true;
  }

  throw new BusinessError(404, "route_not_found", "找不到此调拨操作，请刷新页面");
}

async function getInquiryForRole(id, role, requireAction = true) {
  const record = inventory.getInquiry(id);
  if (!record) throw new BusinessError(404, "not_found", `找不到询库单据 ${id}`);
  const model = inventory.getModel(record.model);
  if (requireAction) await requireActions(role, model.category);
  ensureDocumentVisibility(record, role);
  return record;
}


// 与审批中心的筛选及型号展开顺序一致；保留每一单，展开状态不参与导出。
function filteredInquiryExport(visible, role, query) {
  const type = query.get("type") || "all", category = query.get("category") || "all";
  const scope = query.get("scope") || "all", progress = query.get("progress") || "all";
  const keyword = (query.get("search") || "").trim().toLocaleLowerCase();
  if (!["all", "allocation", "inquiry"].includes(type) || !["all", ...allCategories].includes(category)
    || !["all", "mine"].includes(scope) || !["all", "active"].includes(progress)) throw new BusinessError(400, "invalid_export_filter", "询库导出筛选条件无效，请重新选择筛选");
  const active = item => item.kind === "allocation" ? item.record.statusCode === "pending" && item.record.approvalStatus !== "rejected" : item.record.status.startsWith("pending_");
  const items = [...visible.allocations.map(record => ({ kind: "allocation", record })), ...visible.inquiries.map(record => ({ kind: "inquiry", record }))]
    .sort((a, b) => (b.record.createdAt ?? "").localeCompare(a.record.createdAt ?? ""))
    .filter(item => (type === "all" || item.kind === type) && (category === "all" || item.record.category === category)
      && (progress === "all" || active(item))
      && (scope === "all" || role === "purchasing" && item.kind === "inquiry" && (item.record.status === "pending_purchasing" || item.record.category === "墨盒" && item.record.status === "pending_assistant"))
      && (!keyword || [item.record.operator, item.record.model, item.record.asin, item.record.documentNo].some(value => value.toLocaleLowerCase().includes(keyword))));
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.record.model)) groups.set(item.record.model, []);
    groups.get(item.record.model).push(item);
  }
  return [...groups.values()].flat().filter(item => item.kind === "inquiry").map(item => item.record);
}

function inquiryExportWorkbook(records) {
  const headers = ["型号", "商务部审核数量", "供应商库存回复", "发货仓库", "采购备注", "调拨部门", "调拨店铺", "调拨运营", "已贴FNSKU", "提交时间", "状况"];
  const rows = [headers, ...records.map(row => [row.model, row.approvedQuantity, row.supplierQuantity, row.shippingWarehouse, row.procurementNote,
    row.department, row.store, row.operator, row.fnsku, new Date(row.createdAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }),
    row.status === "archived" ? (["assistant", "assistant-1", "assistant-2"].includes(row.archivedByRole ?? "") || row.category === "墨盒" && row.archivedByRole === "purchasing") ? "已完成" : "" : row.statusText])];
  const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("\r", "&#13;");
  const sheetRows = rows.map((row, r) => '<row r="' + (r + 1) + '" ht="' + Math.max(20, ...row.map(value => typeof value === "string" ? value.split(/\r\n|\r|\n/).length * 16 : 20)) + '" customHeight="1">' + row.map((value, c) => {
    const ref = String.fromCharCode(65 + c) + (r + 1), style = r === 0 ? ' s="1"' : '';
    return value == null || value === "" ? '<c r="' + ref + '"/>' : typeof value === "number"
      ? '<c r="' + ref + '"><v>' + value + '</v></c>'
      : '<c r="' + ref + '" t="inlineStr"' + style + '><is><t xml:space="preserve">' + xml(value) + '</t></is></c>';
  }).join('') + '</row>').join('');
  const widths = [26, 20, 20, 14, 40, 14, 22, 18, 26, 26, 20];
  const entries = [
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ["_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="询库明细" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ["xl/styles.xml", '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ["xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:K' + rows.length + '"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><cols>' + widths.map((width, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + width + '" customWidth="1"/>').join('') + '</cols><sheetData>' + sheetRows + '</sheetData></worksheet>'],
  ];
  const locals = [], directory = []; let offset = 0;
  for (const [file, text] of entries) {
    const name = Buffer.from(file), source = Buffer.from(text), compressed = zlib.deflateRawSync(source), crc = crc32(source);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(source.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    locals.push(local, compressed); directory.push(central); offset += local.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

async function handleApprovalsApi(request, response, pathname) {
  const role = requireRole(request);
  if (pathname === "/api/approvals/inquiries/clear" && request.method === "POST") {
    if (!["admin", "purchasing"].includes(role)) throw new BusinessError(403, "inquiry_clear_forbidden", "仅管理员和采购可手动清空询库显示");
    const payload = await parseJsonRequest(request);
    sendJson(response, 200, inventory.clearInquiryDisplay({ role, requestId: payload.requestId }));
    return true;
  }
  const exporting = pathname === "/api/approvals/inquiries/export";
  if ((pathname === "/api/approvals" || exporting) && request.method === "GET") {
    if (exporting && !["admin", "purchasing"].includes(role)) throw new BusinessError(403, "inquiry_export_forbidden", "仅管理员和采购可导出询库明细");
    const result = inventory.approvalView({ refreshDisplay: !exporting });
    const sync = inventory.syncState();
    const visible = { allocations: [], inquiries: [] };
    for (const kind of ["allocations", "inquiries"]) {
      for (const record of result[kind]) {
        const model = inventory.getModel(record.model);
        const permission = await categoryPermissions(role, model.category);
        const group = operationGroups[role];
        if (!permission.summary || !permission.detail || !permission.expand) continue;
        if (group && record.department !== group) continue;
        if (record.statusCode === "draft" || (record.statusCode === "withdrawn" && role !== "admin")) continue;
        visible[kind].push(approvalDocumentForRole({ ...record, category: model.category }, role));
      }
    }
    if (exporting) {
      const filters = new URL(request.url, "http://localhost").searchParams;
      const content = inquiryExportWorkbook(filteredInquiryExport(visible, role, filters));
      response.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "cache-control": "no-store",
        "content-disposition": "attachment; filename=inquiries.xlsx; filename*=UTF-8''" + encodeURIComponent("询库明细.xlsx") });
      response.end(content);
    } else sendJson(response, 200, { ok: true, ...visible, sync });
    return true;
  }


  if (pathname === "/api/inquiries" && request.method === "POST") {
    if (!entryRoles.has(role)) throw new BusinessError(403, "entry_forbidden", "当前角色无询库录入权限");
    const payload = await parseJsonRequest(request);
    const modelName = requireNonBlank(payload, "model", "型号");
    const model = inventory.getModel(modelName);
    if (!model) throw new BusinessError(400, "unknown_model", `未知型号“${modelName}”`);
    await requireActions(role, model.category);
    const department = requireNonBlank(payload, "department", "调拨部门");
    if (!allocationDepartments.includes(department)) throw new BusinessError(400, "invalid_department", "调拨部门仅限一团 / 二团");
    ensureDocumentVisibility({ department }, role);
    sendJson(response, 200, approvalResultForRole(inventory.createInquiry({
      role, model: modelName, department,
      quantity: requirePositiveInteger(payload.quantity, "询库数量"),
      store: requireValidStoreCode(payload.store),
      operator: requireNonBlank(payload, "operator", "调拨运营"),
      fnsku: requireNonBlank(payload, "fnsku", "已贴 FNSKU"),
      asin: requireNonBlank(payload, "asin", "ASIN").toUpperCase(),
      operatorNote: String(payload.operatorNote ?? "").trim(),
      requestId: requireNonBlank(payload, "requestId", "提交编号"),
    }), role));
    return true;
  }

  const match = pathname.match(/^\/api\/inquiries\/(\d+)\/(review|reply|archive|recall)$/);
  if (match && request.method === "POST") {
    const id = Number(match[1]);
    const action = match[2];
    const allowedRoles = { review: ["business"], reply: ["purchasing", "alan"], archive: ["purchasing", ...assistantRoleSet], recall: ["purchasing", "business"] }[action];
    if (!allowedRoles.includes(role)) throw new BusinessError(403, "inquiry_action_forbidden", "当前角色不能执行此询库步骤");
    await getInquiryForRole(id, role);
    const payload = await parseJsonRequest(request);
    const common = {
      id, role, expectedRevision: Number(payload.expectedRevision),
      requestId: requireNonBlank(payload, "requestId", "提交编号"),
    };
    let result;
    if (action === "review") {
      result = inventory.reviewInquiry({
        ...common, decision: requireNonBlank(payload, "decision", "审核结果"),
        approvedQuantity: payload.decision === "reject" ? null : requirePositiveInteger(payload.approvedQuantity, "审核数量"),
        businessNote: String(payload.businessNote ?? "").trim(),
      });
    } else if (action === "reply") {
      if (payload.supplierQuantity == null || payload.supplierQuantity === "") {
        throw new BusinessError(400, "missing_supplier_quantity", "请填写供应商库存回复，有货填数量，无货填 0");
      }
      result = inventory.replyInquiry({
        ...common, supplierQuantity: requireNonNegativeInteger(payload.supplierQuantity, "供应商库存回复"),
        shippingWarehouse: String(payload.shippingWarehouse ?? "").trim(),
        procurementNote: String(payload.procurementNote ?? "").trim(),
      });
    } else if (action === "recall") {
      result = inventory.recallInquiry(common);
    } else if (action === "archive") {
      result = inventory.archiveInquiry({
        ...common,
        plan: requireNonBlank(payload, "plan", "发货计划号"),
        date: requireNonBlank(payload, "date", "发货日期"),
        version: requireNonBlank(payload, "version", "原版本号"),
      });
    }
    sendJson(response, 200, approvalResultForRole(result, role));
    return true;
  }
  throw new BusinessError(404, "route_not_found", "找不到此审批操作，请刷新页面");
}

async function requireRelocationSourceVisibility(source, role) {
  if (source.fbaArchiveId != null) {
    const archive = inventory.relocationSource(null, null, source.fbaArchiveId);
    if (!archive) throw new BusinessError(404, "fba_archive_not_found", "找不到直发FBA归档");
    const model = inventory.getModel(archive.model);
    await requireActions(role, model.category);
    ensureDocumentVisibility(archive, role);
  } else if (source.inquiryId != null) {
    await getInquiryForRole(source.inquiryId, role);
  } else {
    await getDocumentForRole(source.allocationId, role);
  }
}

async function handleUpgradesApi(request, response, pathname) {
  const role = requireRole(request);
  const visibleGroup = operationGroups[role] ?? null;
  const scopeDirectByTeam = Boolean(operationGroups[role]);

  if (pathname === "/api/upgrades" && request.method === "GET") {
    const dashboard = inventory.getUpgradeDashboard({ visibleGroup, scopeDirectByTeam });
    const permissions = await loadPermissions();
    const visible = item => { const p=permissions[item.category]?.[role] ?? openPermissions; return p.summary && p.detail && p.expand; };
    for (const key of ["directSources", "relocationCandidates", "relocationWorkItems", "upgrades"]) dashboard[key] = dashboard[key].filter(visible);

    sendJson(response, 200, {
      ok: true,
      ...dashboard,
      overseasWarehouses: OVERSEAS_WAREHOUSES,
      securityMode: "demo-role-header-not-authentication",
    });
    return;
  }

  if (pathname === "/api/upgrades/direct" && request.method === "POST") {
    const payload = await parseJsonRequest(request);
    const model = inventory.getModel(requireNonBlank(payload, "model", "型号"));
    if (!model) throw new BusinessError(404, "unknown_model", "未知型号");
    await requireActions(role, model.category);
    const result = inventory.createDirectUpgrade({
      role,
      model: requireNonBlank(payload, "model", "型号"),
      sourceVersion: requireNonBlank(payload, "sourceVersion", "原版本号"),
      requestId: requireNonBlank(payload, "requestId", "提交编号"),
    });
    sendJson(response, 200, result);
    return;
  }

  const directCompleteMatch = pathname.match(/^\/api\/upgrades\/direct\/(\d+)\/complete$/);
  if (directCompleteMatch && request.method === "POST") {
    const upgrade = inventory.getUpgrade(Number(directCompleteMatch[1]));
    if (!upgrade || upgrade.kind !== "direct") throw new BusinessError(404, "upgrade_not_found", `找不到在库升级单 ${directCompleteMatch[1]}`);
    await requireActions(role, upgrade.category);
    const payload = await parseJsonRequest(request);
    const result = inventory.completeDirectUpgrade({
      id: Number(directCompleteMatch[1]),
      role,
      sourceLineId: payload.sourceLineId,
      completedQuantity: requirePositiveInteger(payload.completedQuantity, "升级完成数量"),
      newVersion: requireNonBlank(payload, "newVersion", "升级完成版本号"),
      targetWarehouse: requireNonBlank(payload, "targetWarehouse", "目标海外仓"),
      expectedRevision: Number(payload.expectedRevision),
      requestId: requireNonBlank(payload, "requestId", "提交编号"),
    });
    sendJson(response, 200, result);
    return;
  }

  if (pathname === "/api/upgrades/relocation-work-items" && request.method === "POST") {
    const payload = await parseJsonRequest(request);
    const inquiryId = payload.inquiryId == null ? null : requirePositiveInteger(payload.inquiryId, "询库记录编号");
    const allocationId = payload.allocationId == null ? null : requirePositiveInteger(payload.allocationId, "调拨记录编号");
    const fbaArchiveId = payload.fbaArchiveId == null ? null : requirePositiveInteger(payload.fbaArchiveId, "直发FBA归档编号");
    if ([allocationId,inquiryId,fbaArchiveId].filter(value=>value!=null).length !== 1) throw new BusinessError(400,"invalid_upgrade_source","请选择一条归档来源");
    await requireRelocationSourceVisibility({allocationId,inquiryId,fbaArchiveId},role);
    const result = inventory.initiateRelocationUpgrade({role,allocationId,inquiryId,fbaArchiveId,sourceRevision:payload.sourceRevision,requestId:requireNonBlank(payload,"requestId","提交编号")});
    sendJson(response, 200, result);
    return;
  }

  const procurementMatch = pathname.match(/^\/api\/upgrades\/relocation-work-items\/(\d+)\/procurement$/);
  if (procurementMatch && request.method === "POST") {
    const workId = Number(procurementMatch[1]);
    const work = inventory.getRelocationWorkItem(workId);
    if (!work) throw new BusinessError(404, "relocation_work_not_found", `找不到移仓流程 ${workId}`);
    await requireRelocationSourceVisibility(work, role);
    const payload = await parseJsonRequest(request);
    const result = inventory.recordRelocationProcurement({
      id: workId,
      role,
      rma: requireNonBlank(payload, "rma", "RMA"),
      relocationAddress: requireNonBlank(payload, "relocationAddress", "移仓地址"),
      expectedRevision: Number(payload.expectedRevision),
      requestId: requireNonBlank(payload, "requestId", "提交编号"),
    });
    sendJson(response, 200, result);
    return;
  }

  const operationMatch = pathname.match(/^\/api\/upgrades\/relocation-work-items\/(\d+)\/operation$/);
  if (operationMatch && request.method === "POST") {
    const workId = Number(operationMatch[1]);
    const work = inventory.getRelocationWorkItem(workId);
    if (!work) throw new BusinessError(404, "relocation_work_not_found", `找不到移仓流程 ${workId}`);
    await requireRelocationSourceVisibility(work, role);
    const payload = await parseJsonRequest(request);
    const result = inventory.recordRelocationOperation({
      id: workId,
      role,
      removalOrderNo: requireNonBlank(payload, "removalOrderNo", "移除订单号"),
      expectedRevision: Number(payload.expectedRevision),
      requestId: requireNonBlank(payload, "requestId", "提交编号"),
    });
    sendJson(response, 200, result);
    return;
  }

  const shippingMatch = pathname.match(/^\/api\/upgrades\/relocation-work-items\/(\d+)\/ship$/);
  if (shippingMatch && request.method === "POST") {
    const workId = Number(shippingMatch[1]);
    const work = inventory.getRelocationWorkItem(workId);
    if (!work) throw new BusinessError(404, "relocation_work_not_found", `找不到移仓流程 ${workId}`);
    await requireRelocationSourceVisibility(work, role);
    const payload = await parseJsonRequest(request);
    if (payload.externalItems != null && !Array.isArray(payload.externalItems)) throw new BusinessError(400, "invalid_external_items", "请选择要用于本次移仓的领星包裹");
    const result = inventory.shipRelocationUpgrade({
      id: workId,
      role,
      fbaRemainingQuantity: requireNonNegativeInteger(payload.fbaRemainingQuantity, "FBA 剩余库存"),
      externalItems: payload.externalItems,
      expectedRevision: Number(payload.expectedRevision),
      requestId: requireNonBlank(payload, "requestId", "提交编号"),
    });
    sendJson(response, 200, result);
    return;
  }

  const relocationCompleteMatch = pathname.match(/^\/api\/upgrades\/relocations\/(\d+)\/complete$/);
  if (relocationCompleteMatch && request.method === "POST") {
    const relocationId = Number(relocationCompleteMatch[1]);
    const row = inventory.getUpgradeRelocation(relocationId);
    if (!row) throw new BusinessError(404, "relocation_not_found", `找不到移仓记录 ${relocationId}`);
    await requireRelocationSourceVisibility({ allocationId: row.allocation_document_id, inquiryId: row.inquiry_id, fbaArchiveId: row.fba_archive_id }, role);
    const payload = await parseJsonRequest(request);
    const result = inventory.completeRelocationUpgrade({
      id: relocationId,
      role,
      completedQuantity: requirePositiveInteger(payload.completedQuantity, "升级完成数量"),
      newVersion: requireNonBlank(payload, "newVersion", "升级完成版本号"),
      targetWarehouse: requireNonBlank(payload, "targetWarehouse", "目标海外仓"),
      expectedRevision: Number(payload.expectedRevision),
      requestId: requireNonBlank(payload, "requestId", "提交编号"),
    });
    sendJson(response, 200, result);
    return;
  }

  throw new BusinessError(404, "route_not_found", "找不到此升级操作，请刷新页面");
}

function sendJson(response, status, payload) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (testInstanceId) headers["x-aster-test-instance-id"] = testInstanceId;
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function attr(attrs, name) {
  const match = String(attrs).match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : "";
}

function columnNumber(column) {
  let number = 0;
  for (const char of column) number = number * 26 + char.charCodeAt(0) - 64;
  return number - 1;
}

const ZIP_MAX_ENTRIES = 2_000;
const ZIP_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const ZIP_MAX_RATIO = 500;
const XLSX_MAX_ROWS = 100_000;
const XLSX_MAX_COLUMNS = 4_096;
const XLSX_MAX_CELLS = 500_000;

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (offset >= 0 && buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new BusinessError(400, "invalid_xlsx_zip", "无法读取这个 XLSX 文件，请用 Excel 另存为 .xlsx 后重新上传");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseZipDirectory(buffer) {
  const end = findEndOfCentralDirectory(buffer);
  if (end + 22 > buffer.length) throw new BusinessError(400, "invalid_xlsx_zip", "XLSX 文件不完整，请重新保存后上传");
  const commentLength = buffer.readUInt16LE(end + 20);
  if (end + 22 + commentLength > buffer.length) throw new BusinessError(400, "invalid_xlsx_zip", "XLSX 文件内容不完整，请重新保存后上传");
  const entryCount = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new BusinessError(413, "xlsx_zip64_unsupported", "XLSX 文件使用了不支持的大文件格式，请拆分表格后上传");
  }
  if (entryCount > ZIP_MAX_ENTRIES || directoryOffset + directorySize > buffer.length || directoryOffset < 0) {
    throw new BusinessError(413, "xlsx_zip_structure_too_large", "XLSX 文件内部项目过多，请只保留需要导入的工作表后上传");
  }
  const entries = [];
  let cursor = directoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new BusinessError(400, "invalid_xlsx_zip", "XLSX 文件目录损坏，请用 Excel 重新保存后上传");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new BusinessError(413, "xlsx_zip64_unsupported", "XLSX 文件包含不支持的大文件内容，请拆分表格后上传");
    }
    const recordEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (recordEnd > directoryOffset + directorySize || recordEnd > buffer.length) throw new BusinessError(400, "invalid_xlsx_zip", "XLSX 文件目录不完整，请重新保存后上传");
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (!name || name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")) {
      throw new BusinessError(400, "invalid_xlsx_zip", "XLSX 文件内部路径不正确，请用 Excel 重新保存后上传");
    }
    if (uncompressedSize > ZIP_MAX_ENTRY_BYTES) throw new BusinessError(413, "xlsx_entry_too_large", `XLSX 文件中的“${name}”展开后超过 16MB，请拆分表格后上传`);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > ZIP_MAX_TOTAL_BYTES) throw new BusinessError(413, "xlsx_uncompressed_too_large", "XLSX 文件展开后超过 64MB，请拆分表格后上传");
    if (compressedSize > 0 && uncompressedSize / compressedSize > ZIP_MAX_RATIO) throw new BusinessError(413, "xlsx_compression_ratio_too_large", `XLSX 文件中的“${name}”压缩程度过高，无法读取，请用 Excel 重新保存后上传`);
    entries.push({ name, method, compressedSize, uncompressedSize, crc: buffer.readUInt32LE(cursor + 16), localOffset });
    cursor = recordEnd;
  }
  if (cursor !== directoryOffset + directorySize) throw new BusinessError(400, "invalid_xlsx_zip", "XLSX 文件目录不一致，请用 Excel 重新保存后上传");
  return entries;
}

function inflateZipEntry(buffer, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) throw new BusinessError(400, "invalid_xlsx_zip", `XLSX 文件中的“${entry.name}”损坏，请重新保存后上传`);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < 0 || dataEnd > buffer.length) throw new BusinessError(400, "invalid_xlsx_zip", `XLSX 文件中的“${entry.name}”内容不完整，请重新保存后上传`);
  const compressed = buffer.slice(dataStart, dataEnd);
  let content;
  try {
    if (entry.method === 0) content = compressed;
    else if (entry.method === 8) content = zlib.inflateRawSync(compressed, { maxOutputLength: ZIP_MAX_ENTRY_BYTES });
    else throw new BusinessError(400, "unsupported_xlsx_compression", `无法读取此 XLSX 压缩格式（${entry.method}），请用 Excel 另存为 .xlsx 后上传`);
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw new BusinessError(400, "invalid_xlsx_zip", `无法展开 XLSX 文件中的“${entry.name}”，请重新保存后上传`);
  }
  if (content.length !== entry.uncompressedSize) throw new BusinessError(400, "invalid_xlsx_zip", `XLSX 文件中的“${entry.name}”长度异常，请重新保存后上传`);
  if (crc32(content) !== entry.crc) throw new BusinessError(400, "invalid_xlsx_zip", `XLSX 文件中的“${entry.name}”内容损坏，请重新保存后上传`);
  return content;
}

function readZipEntries(buffer, requestedNames = undefined) {
  const directory = parseZipDirectory(buffer);
  const requested = requestedNames ? new Set(requestedNames) : null;
  const entries = new Map();
  for (const entry of directory) {
    if (requested && !requested.has(entry.name)) continue;
    entries.set(entry.name, inflateZipEntry(buffer, entry));
  }
  return entries;
}

function parseSharedStrings(xml) {
  const strings = [];
  for (const item of xml.match(/<(?:\w+:)?si\b[\s\S]*?<\/(?:\w+:)?si>/g) || []) {
    const parts = [...item.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((match) => decodeXml(match[1]));
    strings.push(parts.join(""));
  }
  return strings;
}

function parseSheet(xml, sharedStrings) {
  const parsedRows = [];
  let cellCount = 0;
  for (const rowXml of xml.match(/<(?:\w+:)?row\b[\s\S]*?<\/(?:\w+:)?row>/g) || []) {
    const cells = {};
    const rowNumber = Number(attr(rowXml.match(/^<(?:\w+:)?row\b([^>]*)>/)?.[1] || "", "r"));
    if (rowNumber > XLSX_MAX_ROWS) throw new BusinessError(413, "xlsx_rows_too_large", "XLSX 文件超过 100000 行，请拆分后上传");
    for (const match of rowXml.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = match[1];
      const body = match[2] || "";
      const reference = attr(attrs, "r");
      if (!reference) continue;
      const column = reference.replace(/\d+$/, "");
      const type = attr(attrs, "t");
      const valueMatch = body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/);
      const inlineMatch = body.match(/<(?:\w+:)?is\b[\s\S]*?<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>[\s\S]*?<\/(?:\w+:)?is>/);
      const rawValue = valueMatch ? decodeXml(valueMatch[1]) : inlineMatch ? decodeXml(inlineMatch[1]) : "";
      let value = rawValue;
      if (type === "s") value = sharedStrings[Number(rawValue)] ?? rawValue;
      if (type === "inlineStr") value = inlineMatch ? decodeXml(inlineMatch[1]) : "";
      cells[columnNumber(column)] = value;
      cellCount += 1;
      if (Object.keys(cells).length > XLSX_MAX_COLUMNS || cellCount > XLSX_MAX_CELLS) throw new BusinessError(413, "xlsx_cells_too_large", "工作表数据量过大，请只保留需要导入的区域后上传");
    }
    parsedRows.push({ rowNumber, cells });
    if (parsedRows.length > XLSX_MAX_ROWS) throw new BusinessError(413, "xlsx_rows_too_large", "XLSX 文件超过 100000 行，请拆分后上传");
  }

  const width = Math.max(0, ...parsedRows.flatMap((row) => Object.keys(row.cells).map(Number))) + 1;
  const rowCount = Math.max(parsedRows.length, ...parsedRows.map((row) => row.rowNumber || 0));
  if (width > XLSX_MAX_COLUMNS || rowCount > XLSX_MAX_ROWS || width * rowCount > XLSX_MAX_CELLS) throw new BusinessError(413, "xlsx_cells_too_large", "工作表单元格过多，请删除多余的空白行列或拆分表格后上传");
  const rows = Array.from({ length: rowCount }, () => Array.from({ length: width }, () => ""));
  parsedRows.forEach((row, index) => {
    const target = row.rowNumber > 0 ? row.rowNumber - 1 : index;
    rows[target] = Array.from({ length: width }, (_, column) => row.cells[column] ?? "");
  });
  return rows;
}

function decodeCsv(buffer) {
  if (buffer.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.slice(3)), encoding: "utf-8-bom" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "utf-8" };
  } catch {
    try {
      return { text: new TextDecoder("gb18030", { fatal: true }).decode(buffer), encoding: "gb18030" };
    } catch {
      throw new BusinessError(422, "unsupported_csv_encoding", "CSV 编码无法识别，请另存为 UTF-8 或 GB18030");
    }
  }
}

function parseCsv(buffer) {
  const { text, encoding } = decodeCsv(buffer);
  const rows = [];
  let cellCount = 0;
  let row = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  const pushRow = () => {
    if (row.length > XLSX_MAX_COLUMNS) throw new BusinessError(413, "csv_columns_too_large", "CSV 文件超过 4096 列，请删除多余列后上传");
    cellCount += row.length;
    if (rows.length >= XLSX_MAX_ROWS || cellCount > XLSX_MAX_CELLS) throw new BusinessError(413, "csv_cells_too_large", "CSV 文件数据量过大，请拆分后上传");
    rows.push(row);
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"' && quoted) {
      quoted = false;
      afterQuote = true;
    } else if (quoted) {
      /* 换行和逗号在引号内属于当前单元格内容。 */
      cell += char;
    } else if (afterQuote && char === ",") {
      row.push(cell); cell = ""; afterQuote = false;
    } else if (afterQuote && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      pushRow();
      row = []; cell = ""; afterQuote = false;
    } else if (afterQuote && /\s/.test(char)) {
      cell += char;
    } else if (afterQuote) {
      throw new BusinessError(422, "invalid_csv", "CSV 文件引号后的内容不正确，请用 Excel 重新保存为 CSV 后上传");
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === '"') throw new BusinessError(422, "invalid_csv", "CSV 文件的引号格式不正确，请用 Excel 重新保存为 CSV 后上传");
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      pushRow();
      row = [];
      cell = "";
    } else cell += char;
  }
  if (quoted) throw new BusinessError(422, "invalid_csv", "CSV 文件存在不成对的引号，请用 Excel 重新保存为 CSV 后上传");
  /* 结尾换行已经在上面的分支提交过一行；避免为正常的尾随换行
     额外制造一个空行，同时保留文件中间的空行以维持源行号。 */
  if (row.length > 0 || cell !== "" || afterQuote) {
    row.push(cell);
    pushRow();
  }
  return { rows, encoding };
}

function resolveWorkbookTarget(target) {
  const value = String(target || "").replaceAll("\\", "/");
  return value.startsWith("/") ? value.slice(1) : path.posix.normalize(path.posix.join("xl", value));
}

function readWorkbookSheets(entries) {
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8");
  const rels = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (!workbook || !rels) throw new BusinessError(400, "invalid_xlsx_workbook", "XLSX 缺少工作簿信息，请用 Excel 重新保存后上传");
  const relationships = new Map([...rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>(?:<\/(?:\w+:)?Relationship>)?/g)].map((match) => [attr(match[1], "Id"), resolveWorkbookTarget(attr(match[1], "Target"))]));
  return [...workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>(?:<\/(?:\w+:)?sheet>)?/g)].map((match) => ({
    name: attr(match[1], "name"), state: attr(match[1], "state") || "visible", path: relationships.get(attr(match[1], "r:id")) || "",
  })).filter((sheet) => sheet.name && sheet.path);
}

const TRANSIT_IMPORT_HEADER_GROUPS = [
  ["ITEM"], ["订单数量", "数量"], ["套/箱"], ["FNSKU"], ["发货方式"], ["计划号"], ["出货时间"], ["团队"], ["版本号"],
];
const STATUS_HEADER_GROUPS = [
  ["计划编号", "计划号", "发货计划号"], ["物流状态", "状态", "订单部更新物流状态", "物流部更新状态", "状态更新"],
];

function headerHas(headers, aliases) {
  return aliases.some((alias) => headers.some((header) => String(header).trim().toLowerCase() === String(alias).toLowerCase()));
}

function headerScore(row, groups) {
  const headers = row.map((value) => String(value ?? "").trim());
  return groups.reduce((score, group) => score + (headerHas(headers, group) ? 1 : 0), 0);
}

function selectHeaderRow(rows, groups, candidates = []) {
  const scored = rows.map((row, index) => ({ index, score: headerScore(row, groups), nonEmpty: row.filter((value) => String(value ?? "").trim() !== "").length })).filter((item) => item.nonEmpty > 0);
  const max = Math.max(0, ...scored.map((item) => item.score));
  if (max < groups.length) {
    if (groups === TRANSIT_IMPORT_HEADER_GROUPS) {
      const headers = rows[scored.find((item) => item.score === max)?.index] ?? [];
      const missing = groups.filter((group) => !headerHas(headers, group)).map((group) => group[0]);
      throw new BusinessError(422, "missing_headers", `缺少在途导入必需字段：${missing.join("、")}`, { required: groups.map((group) => group[0]), missing, candidates });
    }
    throw new BusinessError(422, "missing_headers", "未找到包含全部必需字段的表头", { required: groups.map((group) => group[0]), candidates });
  }
  const best = scored.filter((item) => item.score === max);
  if (best.length > 1) {
    throw new BusinessError(422, "ambiguous_headers", "文件中有多行表头，请只保留一行表头后重新上传", { rows: best.map((item) => item.index + 1), candidates });
  }
  return best[0].index;
}

function readTableRows(buffer, fileName, { sheetName = "", headerGroups = TRANSIT_IMPORT_HEADER_GROUPS } = {}) {
  const extension = path.extname(fileName).toLowerCase();
  if (!['.xlsx', '.csv'].includes(extension)) {
    throw new BusinessError(400, "unsupported_file_format", "当前版本仅支持 .xlsx 或 .csv；旧版 .xls 请先另存为 .xlsx");
  }
  try {
    if (extension === ".csv") {
      const parsed = parseCsv(buffer);
      return { rows: parsed.rows, sheetName: "", sheetCandidates: [], encoding: parsed.encoding, date1904: false };
    }
    const metadata = readZipEntries(buffer, ["xl/workbook.xml", "xl/_rels/workbook.xml.rels"]);
    const sheets = readWorkbookSheets(metadata).filter((sheet) => sheet.state === "visible");
    const workbookProperties = metadata.get("xl/workbook.xml").toString("utf8").match(/<(?:\w+:)?workbookPr\b([^>]*)>/)?.[1] || "";
    const date1904 = ["1", "true"].includes(attr(workbookProperties, "date1904"));
    if (sheets.length === 0) throw new BusinessError(422, "missing_visible_sheet", "XLSX 没有可见工作表");
    const requested = String(sheetName || "").trim();
    const selected = requested ? sheets.filter((sheet) => sheet.name === requested) : [];
    if (requested && selected.length === 0) throw new BusinessError(422, "unknown_sheet", `找不到可见工作表“${requested}”`, { sheetCandidates: sheets.map((sheet) => sheet.name) });
    const sharedEntry = readZipEntries(buffer, ["xl/sharedStrings.xml"]).get("xl/sharedStrings.xml");
    const shared = sharedEntry ? parseSharedStrings(sharedEntry.toString("utf8")) : [];
    const candidates = (selected.length ? selected : sheets).map((sheet) => {
      const sheetEntry = readZipEntries(buffer, [sheet.path]).get(sheet.path);
      if (!sheetEntry) throw new BusinessError(400, "invalid_xlsx_workbook", `工作表“${sheet.name}”的数据文件缺失，请用 Excel 重新保存后上传`);
      const rows = parseSheet(sheetEntry.toString("utf8"), shared);
      return { ...sheet, rows, score: Math.max(0, ...rows.map((row) => headerScore(row, headerGroups))) };
    });
    let chosen = candidates[0];
    if (!selected.length && candidates.length > 1) {
      const maxScore = Math.max(...candidates.map((candidate) => candidate.score));
      const best = candidates.filter((candidate) => candidate.score === maxScore && maxScore > 0);
      if (best.length > 1) throw new BusinessError(422, "sheet_selection_required", "文件中有多个数据工作表，请将需要导入的工作表单独保存后上传", { sheetCandidates: candidates.map((candidate) => ({ name: candidate.name, score: candidate.score })) });
      if (best.length === 1) chosen = best[0];
    }
    return { rows: chosen.rows, sheetName: chosen.name, sheetCandidates: sheets.map((sheet) => sheet.name), encoding: "xlsx", date1904 };
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw new BusinessError(400, "invalid_table_file", error instanceof Error ? error.message : "文件解析失败，请确认是有效的 XLSX/CSV");
  }
}

function dateFromParts(year, month, day) {
  const y = Number(year); const m = Number(month); const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return "";
  return date.toISOString().slice(0, 10);
}

function isShortTransitDate(value) {
  const raw = String(value ?? "").trim();
  return /^\d{1,2}[./-]\d{1,2}$/.test(raw) || /^\d{1,2}月\d{1,2}日$/.test(raw);
}

function normalizeTransitDate(value, dateYear = undefined, date1904 = false) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let match = raw.match(/^(\d{1,2})[./-](\d{1,2})$/) || raw.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (match) return dateYear ? dateFromParts(dateYear, match[1], match[2]) : "";
  match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/) || raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (match) {
    if (match[4] !== undefined) {
      const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6] ?? 0);
      if (hour > 23 || minute > 59 || second > 59) return "";
    }
    return dateFromParts(match[1], match[2], match[3]);
  }
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (Number.isFinite(serial) && serial >= (date1904 ? 0 : 1) && serial < 3_000_000) {
      /* Excel 1900 日期系统：序列 1 对应 1900-01-01；序列 60 是
         Excel 历史上虚构的 1900-02-29，不能静默归一到真实日期。 */
      const wholeDay = Math.floor(serial);
      if (!date1904 && wholeDay === 60) return "";
      const excelDay = !date1904 && wholeDay >= 60 ? wholeDay - 1 : wholeDay;
      /* 1904 日期系统以 1904-01-01 为第 0 天，没有 1900 系统的虚构闰日。 */
      const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
      const date = new Date(epoch + excelDay * 86400000);
      if (!Number.isNaN(date.getTime())) return dateFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
  }
  return "";
}

function findHeader(headers, names) {
  return headers.find((header) => names.some((name) => String(header).trim().toLowerCase() === String(name).toLowerCase())) || "";
}

function duplicateHeaderErrors(headers, rowNumber, groups, { allowAliasGroups = [] } = {}) {
  const errors = [];
  const seen = new Map();
  const aliasesAllowed = new Set(allowAliasGroups.map((group) => group[0]));
  headers.forEach((header, index) => {
    const value = String(header ?? "").trim();
    if (!value) return;
    const group = groups.find((aliases) => aliases.some((alias) => alias.toLowerCase() === value.toLowerCase()));
    /* “数量”和“订单数量”可以同时出现，后续按两列数值做冲突检测；
       同名列仍必须拒绝。其他语义别名同时出现则保持严格的重复表头错误。 */
    const key = group && !aliasesAllowed.has(group[0]) ? group[0] : value.toLowerCase();
    if (seen.has(key)) errors.push({ row: rowNumber, field: value, code: "duplicate_header", message: `表头“${value}”与第 ${seen.get(key)} 列重复` });
    else seen.set(key, index + 1);
  });
  return errors;
}

function parseTransitImportRows(buffer, fileName, { sheetName = "", dateYear = undefined } = {}) {
  const table = readTableRows(buffer, fileName, { sheetName, headerGroups: TRANSIT_IMPORT_HEADER_GROUPS });
  const rows = table.rows;
  const headerIndex = selectHeaderRow(rows, TRANSIT_IMPORT_HEADER_GROUPS, table.sheetCandidates);
  const headers = rows[headerIndex].map((value) => String(value ?? "").trim());
  const errors = duplicateHeaderErrors(headers, headerIndex + 1, TRANSIT_IMPORT_HEADER_GROUPS, { allowAliasGroups: [["订单数量", "数量"]] });
  const modelHeader = findHeader(headers, ["ITEM"]);
  const quantityHeader = findHeader(headers, ["订单数量", "数量"]);
  const checkQuantityHeader = findHeader(headers, ["数量"]);
  const packPerBoxHeader = findHeader(headers, ["套/箱"]);
  const fnskuHeader = findHeader(headers, ["FNSKU"]);
  const shippingHeader = findHeader(headers, ["发货方式"]);
  const planHeader = findHeader(headers, ["计划号"]);
  const dateHeader = findHeader(headers, ["出货时间"]);
  const teamHeader = findHeader(headers, ["团队"]);
  const versionHeader = findHeader(headers, ["版本号"]);
  if (!modelHeader || !quantityHeader || !packPerBoxHeader || !fnskuHeader || !shippingHeader || !planHeader || !dateHeader) {
    throw new BusinessError(422, "missing_headers", "未找到包含全部在途导入必需字段的表头", { required: TRANSIT_IMPORT_HEADER_GROUPS.map((group) => group[0]), sheetName: table.sheetName });
  }
  const filtered = [];
  const dataRows = rows.slice(headerIndex + 1);
  const indexOf = Object.fromEntries(headers.map((header, index) => [header, index]));
  const parseQuantity = (value) => Number(String(value ?? "").replaceAll(",", "").trim());
  dataRows.forEach((raw, offset) => {
    if (!raw.some((value) => String(value ?? "").trim() !== "")) return;
    const sourceRow = headerIndex + offset + 2;
    const valueAt = (header) => header ? String(raw[indexOf[header]] ?? "").trim() : "";
    const model = valueAt(modelHeader);
    const orderQuantity = parseQuantity(valueAt(quantityHeader));
    const rawDate = valueAt(dateHeader);
    const data = {
      model,
      quantity: Number.isInteger(orderQuantity) && orderQuantity > 0 ? orderQuantity : 0,
      packPerBox: valueAt(packPerBoxHeader),
      fnsku: valueAt(fnskuHeader), shippingMethod: valueAt(shippingHeader),
      plan: valueAt(planHeader),
      date: normalizeTransitDate(rawDate, dateYear, table.date1904), rawDate,
      team: valueAt(teamHeader), version: valueAt(versionHeader),
    };
    const rowErrors = [];
    for (const [field, value] of [["ITEM", data.model], ["FNSKU", data.fnsku], ["发货方式", data.shippingMethod], ["计划号", data.plan], ["出货时间", data.rawDate]]) {
      if (!value) rowErrors.push({ row: sourceRow, field, code: "missing_value", message: `第 ${sourceRow} 行“${field}”不能为空` });
    }
    if (!data.date && data.rawDate) rowErrors.push({ row: sourceRow, field: "出货时间", code: isShortTransitDate(data.rawDate) && !dateYear ? "date_year_required" : "invalid_date", message: isShortTransitDate(data.rawDate) && !dateYear ? `第 ${sourceRow} 行日期只有月日，请先选择年份` : `第 ${sourceRow} 行出货时间无效` });
    if (!Number.isInteger(orderQuantity) || orderQuantity <= 0) rowErrors.push({ row: sourceRow, field: "数量", code: "invalid_quantity", message: `第 ${sourceRow} 行订单数量请填写大于 0 的整数` });
    if (checkQuantityHeader && valueAt(checkQuantityHeader) !== "" && parseQuantity(valueAt(checkQuantityHeader)) !== orderQuantity) rowErrors.push({ row: sourceRow, field: "数量", code: "quantity_conflict", message: `第 ${sourceRow} 行“数量”与“订单数量”不一致` });
    if (!data.team) rowErrors.push({ row: sourceRow, field: "团队", code: "missing_team", message: `第 ${sourceRow} 行团队为空，请修改源文件后重新上传` });
    if (!data.version) rowErrors.push({ row: sourceRow, field: "版本号", code: "missing_version", message: `第 ${sourceRow} 行版本号为空，请修改源文件后重新上传` });
    errors.push(...rowErrors);
    filtered.push({ sourceRow, data, errors: rowErrors });
  });
  const fingerprints = new Map();
  for (const item of filtered) {
    const { sourceRow: _sourceRow, ...fingerprintData } = item.data;
    const fingerprint = JSON.stringify(fingerprintData);
    if (fingerprints.has(fingerprint)) errors.push({ row: item.sourceRow, field: "整行", code: "duplicate_row", message: `第 ${item.sourceRow} 行与第 ${fingerprints.get(fingerprint)} 行重复` });
    else fingerprints.set(fingerprint, item.sourceRow);
  }
  if (filtered.length === 0) errors.push({ row: headerIndex + 1, field: "整行", code: "no_match", message: "没有可导入的在途库存数据行" });
  return {
    fileName, sheetName: table.sheetName, sheetCandidates: table.sheetCandidates, encoding: table.encoding, dateYear: dateYear ?? null,
    dateYearRequired: dataRows.some((row) => isShortTransitDate(String(row[indexOf[dateHeader]] ?? "").trim()) && !dateYear),
    headers, totalRows: dataRows.filter((row) => row.some((value) => String(value ?? "").trim() !== "")).length,
    matchedRows: filtered.length, rows: filtered.map((item) => ({ sourceRow: item.sourceRow, data: item.data, errors: item.errors })),
    validation: { canPreview: true, canImport: errors.length === 0, errorCount: errors.length, errors },
  };
}

function parseTransitStatusRows(buffer, fileName, { sheetName = "", dateYear = undefined } = {}) {
  const table = readTableRows(buffer, fileName, { sheetName, headerGroups: STATUS_HEADER_GROUPS });
  const rows = table.rows;
  const headerIndex = selectHeaderRow(rows, STATUS_HEADER_GROUPS, table.sheetCandidates);
  const headers = rows[headerIndex].map((value) => String(value ?? "").trim());
  const indexOf = Object.fromEntries(headers.map((header, index) => [header, index]));
  const aliases = {
    plan: findHeader(headers, ["计划编号", "计划号", "发货计划号"]),
    status: findHeader(headers, ["物流状态", "状态", "订单部更新物流状态", "物流部更新状态", "状态更新"]),
  };
  const errors = duplicateHeaderErrors(headers, headerIndex + 1, STATUS_HEADER_GROUPS);
  if (Object.values(aliases).some((header) => !header)) throw new BusinessError(422, "missing_headers", "未找到包含全部物流状态更新必需字段的表头", { required: STATUS_HEADER_GROUPS.map((group) => group[0]), sheetName: table.sheetName });
  const rawEntries = [];
  const dataRows = rows.slice(headerIndex + 1);
  dataRows.forEach((raw, offset) => {
    if (!raw.some((value) => String(value ?? "").trim() !== "")) return;
    const sourceRow = headerIndex + offset + 2;
    const valueAt = (header) => header ? String(raw[indexOf[header]] ?? "").trim() : "";
    const plan = normalizeTransitPlan(raw[indexOf[aliases.plan]] ?? "");
    const status = valueAt(aliases.status);
    if (!plan) errors.push({ row: sourceRow, field: aliases.plan, code: "missing_plan", message: `第 ${sourceRow} 行“计划编号”不能为空` });
    if (!status) errors.push({ row: sourceRow, field: aliases.status, code: "empty_status", message: `第 ${sourceRow} 行物流状态不能为空` });
    rawEntries.push({ sourceRow, plan, status });
  });
  const byPlan = new Map();
  for (const entry of rawEntries) {
    if (!entry.plan) continue;
    const group = byPlan.get(entry.plan) ?? { plan: entry.plan, sourceRows: [], final: null };
    group.sourceRows.push(entry.sourceRow);
    if (entry.status) group.final = { sourceRow: entry.sourceRow, status: entry.status };
    byPlan.set(entry.plan, group);
  }
  const duplicatePlans = [];
  const result = [];
  for (const group of byPlan.values()) {
    if (group.sourceRows.length > 1) {
      duplicatePlans.push({ plan: group.plan, sourceRows: group.sourceRows, finalSourceRow: group.final?.sourceRow ?? null });
    }
    if (group.final) result.push({ sourceRow: group.final.sourceRow, data: { plan: group.plan, status: group.final.status } });
  }
  result.sort((left, right) => left.sourceRow - right.sourceRow);
  return {
    fileName, sheetName: table.sheetName, sheetCandidates: table.sheetCandidates, encoding: table.encoding,
    dateYear: dateYear ?? null, dateYearRequired: false, headers,
    totalRows: dataRows.filter((row) => row.some((value) => String(value ?? "").trim() !== "")).length,
    distinctPlanCount: byPlan.size, duplicatePlanCount: duplicatePlans.length, duplicatePlans,
    rows: result, validation: { canPreview: true, errors, errorCount: errors.length },
  };
}


async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxUploadBytes) throw new BusinessError(413, "upload_too_large", "上传文件超过 8MB 限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function decodeFileNameHeader(value, fallback) {
  const raw = String(value || fallback);
  try {
    const decoded = decodeURIComponent(raw).trim();
    if (!decoded || decoded.includes("\0") || decoded.includes("/") || decoded.includes("\\") || decoded === "." || decoded === "..") {
      throw new BusinessError(400, "invalid_filename", "文件名无效");
    }
    return decoded;
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw new BusinessError(400, "invalid_filename", "文件名编码无效");
  }
}

function dateYearHeader(request) {
  const raw = String(request.headers["x-date-year"] || "").trim();
  if (!raw) return undefined;
  if (!/^\d{4}$/.test(raw) || Number(raw) < 1900 || Number(raw) > 2200) throw new BusinessError(400, "invalid_date_year", "日期年份必须是 1900 至 2200 的四位数字");
  return Number(raw);
}

function sheetNameHeader(request) {
  const raw = String(request.headers["x-sheet-name"] || "").trim();
  if (raw.length > 600) throw new BusinessError(400, "invalid_sheet_name", "工作表名称过长");
  try {
    const decoded = raw.includes("%") ? decodeURIComponent(raw) : raw;
    if (decoded.length > 200) throw new BusinessError(400, "invalid_sheet_name", "工作表名称过长");
    return decoded;
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw new BusinessError(400, "invalid_sheet_name", "工作表名称编码无效");
  }
}


/* 静态资源仅来自允许的前端构建目录；任何模式都不回退到仓库根目录。 */
async function serveStatic(request, response) {
  const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const filePath = path.resolve(webDist, relative);
  if (filePath !== webDist && !filePath.startsWith(`${webDist}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, { "content-type": mime[path.extname(filePath).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    response.end(content);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

async function authorizeLingxingTarget(role, target, requireActive) {
  const readable = async record => {
    const category = inventory.getModel(record.model).category;
    const permission = await categoryPermissions(role,category);
    if (!permission.summary || !permission.detail || !permission.expand || !permission.actions) throw new BusinessError(403,'lingxing_scope_forbidden','当前岗位无权同步该类目单据');
    ensureDocumentVisibility(record,role);
  };
  if (target.action === 'metrics') {
    if (!['business','admin'].includes(role)) throw new BusinessError(403,'lingxing_sync_forbidden','仅商务或管理员可同步领星指标');
    if (!Array.isArray(target.documents) || !target.documents.length) throw new BusinessError(400,'empty_sync_scope','当前筛选下没有可同步单据');
    inventory.refreshApprovalDisplay();
    const documents = [], asins = new Set();
    for (const ref of target.documents) {
      if (!['allocation','inquiry'].includes(ref.kind) || !Number.isInteger(ref.id) || ref.id<=0) throw new BusinessError(400,'invalid_sync_document','同步范围中的单据编号无效');
      const record = ref.kind==='allocation' ? inventory.getDocument(ref.id) : inventory.getInquiry(ref.id);
      if (!record) throw new BusinessError(404,'sync_document_missing','同步单据不存在');
      await readable(record);
      if (requireActive && (ref.kind==='allocation' ? record.statusCode!=='pending' || record.approvalStatus==='rejected' : !['pending_business','pending_purchasing','pending_assistant'].includes(record.status))) throw new BusinessError(409,'sync_document_inactive','同步范围中的单据已结束，请刷新后重新同步');
      if (!/^[A-Z0-9]{10}$/.test(record.asin)) throw new BusinessError(400,'invalid_sync_asin',`${record.documentNo} 的 ASIN“${record.asin}”不是10位有效格式，请核对原单据`);
      documents.push({kind:ref.kind,id:ref.id});asins.add(record.asin);
    }
    return {action:'metrics',documents,asins:[...asins].sort()};
  }
  if (target.action === 'logistics') {
    inventory.requireUpgradeRole(role);
    const work = inventory.getRelocationWorkItem(Number(target.workId));
    if (!work) throw new BusinessError(404,'relocation_work_not_found','移仓流程不存在');
    await requireRelocationSourceVisibility(work,role); await readable(work);
    if (requireActive && ['cancelled','withdrawn'].includes(work.status)) throw new BusinessError(409,'relocation_cancelled','本次移仓已取消或撤销，不能再发起同步');
    if (!work.removalOrderNo || !work.fnsku) throw new BusinessError(400,'missing_removal_order','请先由运营填写移除订单号，并核对归档来源的 FNSKU');
    return {action:'logistics',workId:work.id,orderNo:work.removalOrderNo,fnsku:work.fnsku};
  }
  throw new BusinessError(400,'invalid_sync_action','未知领星同步类型');
}

async function handleLingxingApi(request,response,pathname) {
  if (pathname.startsWith('/api/lingxing-worker/')) {
    const origin = lingxingHost.local(request);
    response.setHeader('access-control-allow-origin',origin);
    response.setHeader('access-control-allow-methods','POST, OPTIONS');
    response.setHeader('access-control-allow-headers','content-type');
    if (request.method === 'OPTIONS') { response.writeHead(204);response.end();return; }
    if (request.method !== 'POST') throw new BusinessError(405,'method_not_allowed','连接方式不正确，请在部署电脑重新打开最新版领星同步扩展');
    const payload = await parseJsonRequest(request);
    if (pathname === '/api/lingxing-worker/connect') {sendJson(response,200,lingxingHost.connect(request,payload.workerId,payload.version));return;}
    lingxingHost.authenticate(request,payload.workerId);
    let result;
    if (pathname.endsWith('/claim')) result = await lingxingHost.claim(payload.workerId);
    else if (pathname.endsWith('/resume')) result = lingxingHost.resume(payload.workerId,Number(payload.id),payload.jobWorkerId);
    else if (pathname.endsWith('/disconnect')) result = lingxingHost.disconnect();
    else if (pathname.endsWith('/heartbeat')) result = lingxingHost.heartbeat(payload.version);
    else if (pathname.endsWith('/progress')) result = lingxingHost.progress(Number(payload.id),payload.workerId,payload.message);
    else if (pathname.endsWith('/finish')) result = await lingxingHost.finish(Number(payload.id),payload.workerId,payload);
    else throw new BusinessError(404,'route_not_found','找不到此同步操作，请在部署电脑重新打开最新版领星同步扩展');
    sendJson(response,200,result);return;
  }
  const role = requireRole(request);
  if (pathname === '/api/lingxing/jobs' && request.method==='POST') {
    const payload = await parseJsonRequest(request);
    let target;
    if (payload.action==='metrics') {
      const refs = Array.isArray(payload.documents) ? payload.documents.map(ref=>({kind:ref.kind,id:Number(ref.id)})) : [];
      const documents = [...new Map(refs.map(ref=>[`${ref.kind}:${ref.id}`,ref])).values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.id-b.id);
      target = {action:'metrics',documents};
    } else target = {action:payload.action,workId:Number(payload.workId)};
    sendJson(response,202,await lingxingHost.submit(role,payload.requestId,target,request.socket.remoteAddress));return;
  }
  if (pathname === '/api/lingxing/jobs' && request.method==='GET') {
    const query = new URL(request.url,'http://localhost').searchParams;
    sendJson(response,200,await lingxingHost.list(role,query.get('action'),Number(query.get('workId')),query.get('requestId'),query.get('latest')==='1'));return;
  }
  throw new BusinessError(404,'route_not_found','找不到此领星同步操作，请刷新库存页面');
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
    if (requestRole(request) === "alan" && request.method !== "GET" && !(request.method === "POST" && /^\/api\/inquiries\/\d+\/reply$/.test(pathname))) {
      throw new BusinessError(403, "alan_write_forbidden", "Alan仅可办理墨盒询库回复");
    }
    if (pathname.startsWith('/api/lingxing/') || pathname.startsWith('/api/lingxing-worker/')) { await handleLingxingApi(request,response,pathname); return; }
    if (pathname.startsWith("/api/permissions") && (await handlePermissionsApi(request, response, pathname))) return;
    if ((pathname === "/api/health" || pathname === "/api/version") && request.method === "GET") {
      sendJson(response, 200, healthPayload());
      return;
    }
    if ((pathname === "/api/sync" || pathname === "/api/inventory/catalog")
      && (await handleInventoryApi(request, response, pathname))) return;
    /* 调拨库存：统一 SQLite、事务、幂等键、修订号、角色动作与团隔离均在后端强制。 */
    if (pathname.startsWith("/api/approvals") || pathname.startsWith("/api/inquiries")) {
      await handleApprovalsApi(request, response, pathname);
      return;
    }

    if (pathname.startsWith("/api/allocations")) {
      await handleAllocationsApi(request, response, pathname);
      return;
    }
    /* 需求四：移仓跟踪与在库升级共用统一库存余额，写入独立升级流水。 */
    if (pathname.startsWith("/api/upgrades")) {
      await handleUpgradesApi(request, response, pathname);
      return;
    }
    /* 审计事件与业务写入使用同一事务；流水与业务记录采用相同的运营团级隔离。 */
    if (pathname.startsWith("/api/audit") && request.method === "GET") {
      const role = requireRole(request);
      const visibleGroup = operationGroups[role] ?? null;
      const scopeDirectByTeam = Boolean(operationGroups[role]);
      const detailMatch = pathname.match(/^\/api\/audit\/(\d+)$/);
      if (detailMatch) {
        sendJson(response, 200, approvalResultForRole({ ok: true, ...inventory.auditDetail(Number(detailMatch[1]), visibleGroup, { scopeDirectByTeam }) }, role));
        return;
      }
      if (pathname !== "/api/audit") {
        throw new BusinessError(404, "route_not_found", "库存流水接口未实现该路径");
      }
      const search = new URL(request.url, "http://localhost").searchParams;
      const from = normalizeAuditBoundary(search.get("from"), "开始时间");
      const to = normalizeAuditBoundary(search.get("to"), "结束时间", true);
      if (from && to && from > to) {
        throw new BusinessError(400, "invalid_audit_time_range", "开始时间不能晚于结束时间");
      }
      const requested = Number(search.get("limit") || 100);
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.trunc(requested), 500)) : 100;
      const records = inventory.audit({
        action: search.get("action") || search.get("operation") || "",
        businessNo: search.get("businessNo") || "",
        model: search.get("model") || "",
        from,
        to,
        limit,
        visibleGroup,
        scopeDirectByTeam,
      });
      sendJson(response, 200, { ok: true, records, sync: inventory.syncState() });
      return;
    }
    /* 需求三：在途导入、物流状态更新与上架。上传/转换写入均由服务端事务、幂等键和角色校验保障。 */
    if (request.method === "POST" && pathname === "/api/transit/preview") {
      const role = requireRole(request);
      if (!transitRoleSet.has(role)) throw new BusinessError(403, "transit_import_forbidden", "当前角色无权导入在途库存");
      const body = await readBody(request);
      const fileName = decodeFileNameHeader(request.headers["x-file-name"], "upload.xlsx");
      await requireActions(role, transitCategoryFromFileName(fileName));
      const parsed = parseTransitImportRows(body, fileName, { sheetName: sheetNameHeader(request), dateYear: dateYearHeader(request) });
      await requireTransitRowActions(role, fileName, parsed.rows);
      inventory.requireTransitImportTeams(role, parsed.rows);
      const fileSha256 = hashBuffer(body);
      const templateSha256 = hashTemplate(parsed.headers);
      /* 所有业务字段均来自文件，预览后不再允许补录或改写。 */
      const previewErrors = parsed.validation?.errors ?? [];
      const tokenEligible = parsed.matchedRows > 0 && previewErrors.length === 0;
      const proof = tokenEligible
        ? inventory.createTransitPreviewToken({ kind: "import", role, fileName, fileHash: fileSha256, templateHash: templateSha256, payload: { rows: parsed.rows } })
        : null;
      sendJson(response, 200, { ok: true, ...parsed, fileSha256, templateSha256, ...(proof ? { previewToken: proof.token, previewExpiresAt: proof.expiresAt } : {}) });
      return;
    }
    if (request.method === "POST" && pathname === "/api/transit/import") {
      const role = requireRole(request);
      if (!transitRoleSet.has(role)) throw new BusinessError(403, "transit_import_forbidden", "当前角色无权导入在途库存");
      const payload = await parseJsonRequest(request);
      await requireActions(role, transitCategoryFromFileName(payload.fileName));
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      await requireTransitRowActions(role, payload.fileName, rows);
      const result = inventory.transitImport({
        role,
        previewToken: requirePreviewToken(payload),
        fileName: payload.fileName,
        fileHash: payload.fileHash,
        templateHash: payload.templateHash,
        rows,
        requestId: requireNonBlank(payload, "requestId", "提交编号"),
      });
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && pathname === "/api/transit/status/preview") {
      const role = requireRole(request);
      if (!transitRoleSet.has(role)) throw new BusinessError(403, "transit_status_forbidden", "当前角色无权更新物流状态");
      const body = await readBody(request);
      const fileName = decodeFileNameHeader(request.headers["x-file-name"], "status.xlsx");
      const parsed = parseTransitStatusRows(body, fileName, { sheetName: sheetNameHeader(request), dateYear: dateYearHeader(request) });
      const matchPreview = inventory.previewTransitStatusUpdates(parsed.rows, role);
      for (const category of new Set(matchPreview.updates.map(row => inventory.getModel(row.model).category))) await requireActions(role, category);
      const errors = [...(parsed.validation?.errors ?? []), ...(matchPreview.errors ?? [])];
      const validation = { ...(parsed.validation ?? {}), errors, errorCount: errors.length };
      const fileSha256 = hashBuffer(body);
      const templateSha256 = hashTemplate(parsed.headers);
      const proof = errors.length === 0 && matchPreview.canApply
        ? inventory.createTransitPreviewToken({ kind: "status", role, fileName, fileHash: fileSha256, templateHash: templateSha256, payload: { rows: parsed.rows, updates: matchPreview.updates, unmatchedPlans: matchPreview.unmatchedPlans } })
        : null;
      sendJson(response, 200, {
        ok: true, ...parsed, ...matchPreview, errors, validation,
        canApply: errors.length === 0 && matchPreview.canApply,
        fileSha256, templateSha256, ...(proof ? { previewToken: proof.token, previewExpiresAt: proof.expiresAt } : {}),
      });
      return;
    }
    if (request.method === "POST" && pathname === "/api/transit/status/apply") {
      const role = requireRole(request);
      if (!transitRoleSet.has(role)) throw new BusinessError(403, "transit_status_forbidden", "当前角色无权更新物流状态");
      const payload = await parseJsonRequest(request);
      for (const category of new Set(inventory.previewTransitStatusUpdates(payload.rows, role).updates.map(row => inventory.getModel(row.model).category))) await requireActions(role, category);
      const result = inventory.updateTransitStatuses({ role, previewToken: requirePreviewToken(payload), rows: Array.isArray(payload.rows) ? payload.rows : [], fileHash: payload.fileHash, templateHash: payload.templateHash, fileName: payload.fileName, requestId: requireNonBlank(payload, "requestId", "提交编号") });
      // 旧版已保存的请求结果同样按当前归属检查，重试不能返回跨团明细。
      for (const row of result.updated) ensureDocumentVisibility({ department: inventory.getTransit(row.id)?.team }, role);
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && pathname === "/api/transit/imports") {
      const role = requireRole(request);
      if (!transitRoleSet.has(role) && role !== "alan") throw new BusinessError(403, "transit_import_forbidden", "当前角色无权查看导入批次");
      sendJson(response, 200, { ok: true, imports: inventory.listTransitImports(role), sync: inventory.syncState() });
      return;
    }
    const onShelfMatch = pathname.match(/^\/api\/transit\/(\d+)\/on-shelf$/);
    if (request.method === "POST" && onShelfMatch) {
      const role = requireRole(request);
      const transit = inventory.getTransit(Number(onShelfMatch[1]));
      if (!transit) throw new BusinessError(404, "transit_not_found", "找不到在途记录");
      ensureDocumentVisibility({ department: transit.team }, role);
      await requireActions(role, inventory.getModel(transit.model).category);
      const payload = await parseJsonRequest(request);
      const result = inventory.markTransitOnShelf({ id: Number(onShelfMatch[1]), role, expectedRevision: Number(payload.expectedRevision), yes: String(payload.yes ?? "").trim(), requestId: requireNonBlank(payload, "requestId", "提交编号") });
      sendJson(response, 200, result);
      return;
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      throw new BusinessError(404, "route_not_found", "找不到此操作，请刷新库存页面");
    }
    await serveStatic(request, response);
  } catch (error) {
    const business = error instanceof BusinessError;
    const status = business ? error.status : 500;
    if (status >= 500) console.error(`[aster] ${error instanceof Error ? error.stack || error.message : String(error)}`);
    sendJson(response, status, {
      ok: false,
      code: business ? error.code : "internal_error",
      error: business ? error.message : "库存服务处理出错，尚未确认本次操作结果。请重新加载查看记录；仍有问题时，请在部署电脑检查库存服务日志。",
      ...(business && error.details !== undefined ? { details: approvalErrorDetailsForRole(error.details, requestRole(request)) } : {}),
      ...(business && error.requestNotApplied === true ? { requestNotApplied: true } : {}),
    });
  }
});

server.listen(port, host, () => {
  console.log(`Aster validation prototype: http://${host}:${port}/`);
});
server.on("close", () => inventory.close());
