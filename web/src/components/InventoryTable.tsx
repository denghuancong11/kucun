import { Fragment, type ReactNode } from "react";
import { formatNumber } from "../api";
import type { ModelSummary, StockDetail } from "../types";
import { Icon } from "./Icon";
import { Badge, FlashNum } from "./ui";

export type SortField = "model" | "inStock" | "locked" | "available" | "inTransit" | "total" | "batches";
export type SortOrder = "asc" | "desc";

export interface ModelRow {
  model: ModelSummary;
  batches: StockDetail[];
  /* 批次级明细对当前角色不可见时为 null。绝不用“0”冒充未知：
     locked=0 会把可用库存显示成整个在库数，业务据此下单就会超卖。 */
  locked: number | null;
  available: number | null;
}

const columns: Array<{ field?: SortField; label: string; num?: boolean }> = [
  { field: "model", label: "型号" },
  { label: "类目" },
  { field: "inStock", label: "在库库存", num: true },
  { field: "locked", label: "预锁定", num: true },
  { field: "available", label: "可用库存", num: true },
  { field: "inTransit", label: "在途库存", num: true },
  { field: "total", label: "库存总量", num: true },
  { field: "batches", label: "批次", num: true },
];

/* 库存汇总主表。行点击 = 下钻到该型号明细。 */
export function InventoryTable({
  rows,
  expandedModel,
  sortField,
  sortOrder,
  onSort,
  onExpand,
  expandedDetail,
}: {
  rows: ModelRow[];
  expandedModel: string | null;
  sortField: SortField;
  sortOrder: SortOrder;
  onSort: (field: SortField) => void;
  onExpand: (model: string | null) => void;
  expandedDetail: ReactNode;
}) {
  const sortIndicator = (field: SortField) =>
    sortField === field ? (
      <Icon name={sortOrder === "asc" ? "arrowUp" : "arrowDown"} size={11} className="sort-active" />
    ) : (
      <Icon name="arrowDown" size={11} className="sort-hint" />
    );

  return (
    <div className="table-wrap scroll-x result-anim">
      <table className="data-table inventory-summary-table">
        <colgroup>
          <col className="summary-col-model" />
          <col className="summary-col-category" />
          <col className="summary-col-number" />
          <col className="summary-col-number" />
          <col className="summary-col-number" />
          <col className="summary-col-number" />
          <col className="summary-col-number" />
          <col className="summary-col-batches" />
        </colgroup>
        <thead>
          <tr>
            {columns.map((col) =>
              col.field ? (
                <th
                  key={col.label}
                  className={`sortable-th${col.num ? " num" : ""}${col.field === "model" ? " inventory-summary-model-header" : ""}`}
                  aria-sort={sortField === col.field ? (sortOrder === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button type="button" className="th-sort" onClick={() => onSort(col.field!)}>
                    <span>{col.label}</span>
                    {sortIndicator(col.field)}
                  </button>
                </th>
              ) : (
                <th key={col.label}>{col.label}</th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ model, batches, locked, available }) => {
            const isExpanded = expandedModel === model.model;
            const hasBatches = batches.length > 0;
            const derivedUnknown = locked === null || available === null;
            const unknownTitle = "暂时无法取得预锁定和可用库存数量";
            const detailId = `inventory-detail-${model.model.replace(/[^A-Za-z0-9_-]/g, "-")}`;
            const toggleExpanded = () => onExpand(isExpanded ? null : model.model);

            return (
              <Fragment key={model.model}>
                <tr
                  className={`inventory-summary-row inventory-model-row${isExpanded ? " row-expanded" : ""}`}
                  onClick={toggleExpanded}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleExpanded();
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-expanded={isExpanded}
                  aria-controls={detailId}
                  title={isExpanded ? "收起明细" : "展开在库批次与在途明细"}
                >
                  <td className="inventory-summary-model">
                    <span className="model-cell">
                      <Icon
                        name="chevron"
                        size={12}
                        className={`row-caret${isExpanded ? " open" : ""}`}
                      />
                      {model.model}
                    </span>
                  </td>
                  <td className="inventory-summary-category">
                    {model.category && <Badge label={model.category} tone="neutral" dot={false} />}
                  </td>
                  <td className="num strong inventory-summary-metric inventory-summary-in-stock">
                    <FlashNum value={model.inStock} />
                  </td>
                  <td className="num inventory-summary-metric inventory-summary-locked">
                    {locked === null ? (
                      <span className="muted unknown-cell" title={unknownTitle}>—</span>
                    ) : locked > 0 ? (
                      <span className="alloc-locked">{formatNumber(locked)}</span>
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                  <td className="num strong inventory-summary-metric inventory-summary-available">
                    {available === null ? (
                      <span className="muted unknown-cell" title={unknownTitle}>—</span>
                    ) : available > 0 ? (
                      <span className="alloc-available">{formatNumber(available)}</span>
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                  <td className="num inventory-summary-metric inventory-summary-in-transit">
                    {model.inTransit > 0 ? (
                      <span className="alloc-transit">{formatNumber(model.inTransit)}</span>
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                  <td className="num total inventory-summary-metric inventory-summary-total">
                    <FlashNum value={model.inStock + model.inTransit} />
                  </td>
                  <td className="num muted inventory-summary-batch-count">
                    {derivedUnknown && !hasBatches ? (
                      <span className="unknown-cell" title={unknownTitle}>—</span>
                    ) : (
                      batches.length
                    )}
                  </td>
                </tr>
                {isExpanded && expandedDetail && (
                  <tr id={detailId} className="model-detail-host">
                    <td className="model-detail-host-cell" colSpan={columns.length}>
                      {expandedDetail}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

    </div>
  );
}
