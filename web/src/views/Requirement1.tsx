import { useEffect, useMemo, useState } from "react";
import type { AllocationBatchContext } from "../components/AllocationPanel";
import { Icon } from "../components/Icon";
import { InventoryTable, type ModelRow, type SortField, type SortOrder } from "../components/InventoryTable";
import { ModelDetailSection, type DetailTab } from "../components/ModelDetailSection";
import { SearchBox } from "../components/SearchBox";
import { EmptyState, Panel, Segmented, SkeletonTable } from "../components/ui";
import { useAllocations } from "../hooks/useAllocations";
import { useInventoryCatalog } from "../hooks/useInventory";
import { useEffectivePermissions } from "../hooks/usePermissions";
import { useTransit } from "../hooks/useTransit";
import type { AllocationEntry, Category, Role, RolePermissions, TransitDetail } from "../types";

type CategoryFilter = "all" | Category;

/* 权限未知时的兜底切片：只放行汇总数字，明细字段、明细展开与调拨一律关闭。
   接口失败绝不回落成“全开放”。 */
const strictPermissions: RolePermissions = { summary: true, detail: false, expand: false, actions: false };
/* 未受控类目（硒鼓不设权限）在有效权限切片中不出现，按全开放处理，与后端口径一致。 */
const openPermissions: RolePermissions = { summary: true, detail: true, expand: true, actions: true };

const SEARCH_DEBOUNCE_MS = 250;
const CATEGORY_SLUG: Record<Category, string> = { 硒鼓: "toner", 墨盒: "ink" };
const SLUG_CATEGORY: Record<string, Category> = { toner: "硒鼓", ink: "墨盒" };

interface UrlContext {
  query: string;
  category: CategoryFilter;
  model: string | null;
  tab: DetailTab;
}

function readUrlContext(): UrlContext {
  const fallback: UrlContext = { query: "", category: "all", model: null, tab: "stock" };
  if (typeof window === "undefined") return fallback;
  const p = new URLSearchParams(window.location.search);
  const slug = p.get("category");
  return {
    query: (p.get("q") ?? "").trim(),
    category: slug ? (SLUG_CATEGORY[slug] ?? "all") : "all",
    model: p.get("model") || null,
    tab: p.get("tab") === "transit" ? "transit" : "stock",
  };
}

export function Requirement1View({
  role,
}: {
  role: Role;
}) {
  const [urlCtx] = useState(readUrlContext);
  const [query, setQuery] = useState(urlCtx.query);
  const [keyword, setKeyword] = useState(urlCtx.query.trim().toLowerCase());
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>(urlCtx.category);
  const [sortField, setSortField] = useState<SortField>("model");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");

  /* 下钻：展开的型号 + 明细标签 + 展开的批次（三级） */
  const [expandedModel, setExpandedModel] = useState<string | null>(urlCtx.model);
  const [detailTab, setDetailTab] = useState<DetailTab>(urlCtx.tab);
  const [activeBatchKey, setActiveBatchKey] = useState<string | null>(null);

  const {
    data: effective,
    isLoading: permLoading,
    isError: permFailed,
    refetch: refetchPerms,
  } = useEffectivePermissions(role);

  const {
    data: catalog,
    isLoading: catalogLoading,
    isError: catalogHasError,
    error: catalogErrorObj,
    refetch: refetchCatalog,
  } = useInventoryCatalog(role);


  const catalogModels = useMemo(
    () => (catalog?.models ?? []).filter((model) => model.category !== null),
    [catalog],
  );

  const categoryCounts = useMemo(
    () => ({
      all: catalogModels.length,
      硒鼓: catalogModels.filter((m) => m.category === "硒鼓").length,
      墨盒: catalogModels.filter((m) => m.category === "墨盒").length,
    }),
    [catalogModels],
  );

  /* 有效权限切片按类目取用；切角色时旧切片必须立即失效，不得沿用上一个角色的结果 */
  const permsForCategory = (category: Category | null): RolePermissions => {
    if (permFailed) return strictPermissions;
    if (!effective || effective.role !== role) return strictPermissions;
    if (!category) return strictPermissions;
    return effective.permissions[category] ?? openPermissions;
  };

  const activeModelName = expandedModel;
  const activeModel = useMemo(
    () => (activeModelName ? (catalogModels.find((m) => m.model === activeModelName) ?? null) : null),
    [activeModelName, catalogModels],
  );
  const activePerm = permsForCategory(activeModel?.category ?? null);

  const {
    data: alloc,
    isError: allocHasError,
    error: allocErrorObj,
    createMutation,
    refreshAfterWrite,
  } = useAllocations(role, activeModelName, activePerm.summary && activePerm.detail && activePerm.expand);
  const { onShelfMutation } = useTransit(role);


  const allocBusy = createMutation.isPending || onShelfMutation.isPending;

  const onShelfOne = async (row: TransitDetail): Promise<string | null> => {
    try {
      await onShelfMutation.mutateAsync({ id: row.id, expectedRevision: row.revision, yes: "YES", requestId: `transit-on-shelf-${row.id}-${row.revision}` });
      /* 上架事务完成后先取得权威目录，普通海外仓再切到在库明细，直发FBA保留在途归档状态；
         刷新失败时保留在途标签和现有错误反馈。 */
      const refreshed = await refetchCatalog();
      if (refreshed.error) return row.shippingMethod === "直发FBA"
        ? "直发 FBA 已归档，页面刷新失败，请刷新页面。"
        : "已上架，页面刷新失败，请刷新页面。";
      if (row.shippingMethod !== "直发FBA") setDetailTab("stock");
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  // 输入防抖
  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(query.trim().toLowerCase()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // popstate：返回/前进恢复同一工作状态
  useEffect(() => {
    const onPop = () => {
      const next = readUrlContext();
      setQuery(next.query);
      setCategoryFilter(next.category);
      setExpandedModel(next.model);
      setDetailTab(next.tab);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 状态同步到 URL（replaceState，不产生历史条目）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams();
    if (query.trim()) p.set("q", query.trim());
    if (categoryFilter !== "all") p.set("category", CATEGORY_SLUG[categoryFilter]);
    if (expandedModel) {
      p.set("model", expandedModel);
      if (detailTab !== "stock") p.set("tab", detailTab);
    }
    const search = p.toString();
    window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
  }, [query, categoryFilter, expandedModel, detailTab]);

  const rows: ModelRow[] = useMemo(() => {
    const result = catalogModels
      .filter((m) => {
        if (categoryFilter !== "all" && m.category !== categoryFilter) return false;
        if (keyword && !m.model.toLowerCase().includes(keyword)) return false;
        return true;
      })
      .map((model) => {
        const batches = catalog?.stockDetails[model.model] ?? [];
        /* 后端在角色缺少批次明细权限时不下发 stockDetails。此时预锁定与可用为“未知”，
           不能按 0 计算——否则运营看到的可用库存会等于整个在库数，与全量口径不一致。
           批次为空但在库为 0 时不存在歧义，仍按 0 计。 */
        /* 预锁定与可用由后端汇总权威值下发；明细仅用于核对，不从不完整明细推算。 */
        const locked = model.locked;
        return {
          model,
          batches,
          locked,
          available: model.available,
        };
      });

    return result.sort((a, b) => {
      let valA: string | number = a.model.model;
      let valB: string | number = b.model.model;
      if (sortField === "inStock") { valA = a.model.inStock; valB = b.model.inStock; }
      else if (sortField === "locked") { valA = a.locked ?? -1; valB = b.locked ?? -1; }
      else if (sortField === "available") { valA = a.available ?? -1; valB = b.available ?? -1; }
      else if (sortField === "inTransit") { valA = a.model.inTransit; valB = b.model.inTransit; }
      else if (sortField === "total") { valA = a.model.inStock + a.model.inTransit; valB = b.model.inStock + b.model.inTransit; }
      else if (sortField === "batches") { valA = a.batches.length; valB = b.batches.length; }

      if (typeof valA === "string" && typeof valB === "string") {
        return sortOrder === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return sortOrder === "asc" ? Number(valA) - Number(valB) : Number(valB) - Number(valA);
    });
  }, [catalogModels, catalog?.stockDetails, categoryFilter, keyword, sortField, sortOrder]);

  const suggestions = useMemo(
    () =>
      keyword === ""
        ? []
        : catalogModels.filter(
            (m) => m.model.toLowerCase().includes(keyword) && (categoryFilter === "all" || m.category === categoryFilter),
          ),
    [keyword, categoryFilter, catalogModels],
  );

  /* 展开的型号若确实已不在当前筛选结果中，收起下钻区。
     只在目录数据已到位时判断——切角色时 catalog 会短暂为空，
     若不加这层保护，下钻区会在每次切角色时被误收起。 */
  useEffect(() => {
    if (!catalog) return;
    if (expandedModel && !rows.some((r) => r.model.model === expandedModel)) {
      setExpandedModel(null);
      setActiveBatchKey(null);
    }
  }, [catalog, rows, expandedModel]);

  const changeCategory = (next: CategoryFilter) => {
    setCategoryFilter(next);
    /* 只清除“不属于新类目”的上下文：切到全部类目、或当前展开的型号仍属于新类目时，
       保留搜索词与下钻区，不让用户白丢一次操作现场。 */
    const expandedCategory = catalogModels.find((m) => m.model === expandedModel)?.category ?? null;
    const stillBelongs = next === "all" || (expandedModel !== null && expandedCategory === next);
    if (!stillBelongs) {
      setQuery("");
      setKeyword("");
      setExpandedModel(null);
      setActiveBatchKey(null);
    }
  };

  const expandModel = (model: string | null) => {
    setExpandedModel(model);
    setActiveBatchKey(null);
    if (model) setDetailTab("stock");
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  const submitEntry = async (
    batchCtx: AllocationBatchContext,
    entry: AllocationEntry,
  ): Promise<{ error: string; code?: string; status?: number } | null> => {
    try {
      await createMutation.mutateAsync({ batch: batchCtx, entry });
      return null;
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof Error ? (err as Error & { code?: string }).code : undefined,
        status: err instanceof Error ? (err as Error & { status?: number }).status : undefined,
      };
    }
  };

  const searching = keyword !== "";
  const expandedRow = rows.find((r) => r.model.model === expandedModel) ?? null;

  return (
    <Panel>
      <div className="filter-bar">
        <SearchBox
          query={query}
          suggestions={suggestions}
          onQueryChange={setQuery}
          onSelect={(m) => {
            setQuery(m.model);
            expandModel(m.model);
          }}
          onClear={() => setQuery("")}
        />

        <Segmented<CategoryFilter>
          ariaLabel="按类目筛选"
          value={categoryFilter}
          onChange={changeCategory}
          items={[
            { value: "all", label: "全部类目", count: catalog ? categoryCounts.all : undefined },
            { value: "硒鼓", label: "硒鼓", count: catalog ? categoryCounts["硒鼓"] : undefined },
            { value: "墨盒", label: "墨盒", count: catalog ? categoryCounts["墨盒"] : undefined },
          ]}
        />

      </div>

      {permFailed && (
        <div className="callout callout-warn" role="alert">
          <Icon name="alert" size={15} className="callout-icon" />
          <div>
            <strong>权限信息加载失败</strong>
            <p>
              暂时无法查看明细、提交调拨或询库。
              <button type="button" className="link-btn" onClick={() => void refetchPerms()}>
                重新加载
              </button>
            </p>
          </div>
        </div>
      )}

      {catalogHasError && (
        <div className="callout callout-danger" role="alert">
          <Icon name="alert" size={15} className="callout-icon" />
          <div>
            <strong>库存数据加载失败</strong>
            <p>
              {catalogErrorObj instanceof Error ? catalogErrorObj.message : String(catalogErrorObj)}
              <button type="button" className="link-btn" onClick={() => void refetchCatalog()}>
                重新加载
              </button>
            </p>
          </div>
        </div>
      )}

      {allocHasError && (
        <div className="callout callout-danger" role="alert">
          <Icon name="alert" size={15} className="callout-icon" />
          <div>
            <strong>调拨数据加载失败</strong>
            <p>{allocErrorObj instanceof Error ? allocErrorObj.message : String(allocErrorObj)}</p>
          </div>
        </div>
      )}

      {catalogLoading && !catalog ? (
        <SkeletonTable rows={5} cols={8} />
      ) : rows.length > 0 ? (
        <InventoryTable
          rows={rows}
          expandedModel={expandedModel}
          sortField={sortField}
          sortOrder={sortOrder}
          onSort={handleSort}
          onExpand={expandModel}
          expandedDetail={
            expandedRow && catalog ? (
              <ModelDetailSection
                model={expandedRow.model}
                stockRows={expandedRow.batches}
                transitRows={catalog.inTransitDetails[expandedRow.model.model] ?? []}
                role={role}
                perm={permsForCategory(expandedRow.model.category)}
                permLoading={permLoading}
                alloc={alloc}
                allocBusy={allocBusy}
                activeBatchKey={activeBatchKey}
                onSelectBatchKey={setActiveBatchKey}
                tab={detailTab}
                onTabChange={setDetailTab}
                onEntry={submitEntry}
                onRefresh={refreshAfterWrite}
                onShelf={onShelfOne}
              />
            ) : null
          }
        />
      ) : !catalogHasError ? (
        <EmptyState
          title={searching ? "未找到匹配型号" : "暂无库存记录"}
          action={
            searching ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setQuery("")}>
                清除搜索
              </button>
            ) : undefined
          }
        />
      ) : null}

    </Panel>
  );
}
