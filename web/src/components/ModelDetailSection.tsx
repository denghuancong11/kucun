import { Fragment, useState } from "react";
import { formatNumber } from "../api";
import { TRANSIT_SHELF_ROLES } from "../types";
import type {
  AllocationBatchTotals,
  AllocationEntry,
  AllocationsPayload,
  ModelSummary,
  Role,
  RolePermissions,
  StockDetail,
  TransitDetail,
} from "../types";
import { AllocationPanel, type AllocationBatchContext } from "./AllocationPanel";
import { Icon } from "./Icon";
import { InquiryEntry } from "./InquiryEntry";
import { operationGroups } from "../utils/roles";
import { Badge, Clip, Segmented, Spinner } from "./ui";

export type DetailTab = "stock" | "transit";

const TRANSIT_SHELF_ROLE_SET = new Set<Role>(TRANSIT_SHELF_ROLES);

/* 明细区超过该行数时，容器限高内滚并让表头相对容器吸顶（R6 §4.3 P2） */
const STICKY_ROW_THRESHOLD = 20;

interface CommonProps {
  model: ModelSummary;
  stockRows: StockDetail[];
  transitRows: TransitDetail[];
  role: Role;
  perm: RolePermissions;
  permLoading: boolean;
  alloc: AllocationsPayload | undefined;
  allocBusy: boolean;
  activeBatchKey: string | null;
  onSelectBatchKey: (key: string | null) => void;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onEntry: (
    batch: AllocationBatchContext,
    entry: AllocationEntry,
  ) => Promise<{ error: string; code?: string; status?: number } | null>;
  onShelf: (row: TransitDetail) => Promise<string | null>;
}

/* 明细合计行：数量落在件数列下，说明并入同一行，超/欠差异整行转红。 */
function SubtotalRow({
  sum,
  reference,
  referenceLabel,
  span,
}: {
  sum: number;
  reference: number;
  referenceLabel: string;
  span: number;
}) {
  const mismatch = sum !== reference;
  return (
    <tr className={`subtotal-row${mismatch ? " mismatch" : ""}`}>
      <td className="num subtotal-cell">{formatNumber(sum)}</td>
      <td className="subtotal-label" colSpan={span}>
        明细合计
        {mismatch && <span className="subtotal-note"> · 与{referenceLabel}不一致（{referenceLabel} {formatNumber(reference)}）</span>}
      </td>
    </tr>
  );
}

function StockPane({
  model,
  stockRows,
  role,
  perm,
  alloc,
  allocBusy,
  activeBatchKey,
  onSelectBatchKey,
  onEntry,
}: CommonProps) {
  if (stockRows.length === 0) {
    return (
      <div className="detail-pane pane-stock">
        <div className="detail-empty">
          {model.inStock > 0
            ? `在库 ${formatNumber(model.inStock)} 件暂无对应的明细记录。`
            : "该型号当前没有在库库存。"}
        </div>
      </div>
    );
  }

  const showFields = perm.detail;
  /* 明细表始终显示在库件数、预锁定和可用件数；权限只控制批次身份字段。 */
  const colCount = showFields ? 10 : 4;
  const sum = stockRows.reduce((total, row) => total + row.quantity, 0);
  const lockedSum = stockRows.reduce((total, row) => total + row.locked, 0);
  const availableSum = stockRows.reduce((total, row) => total + row.available, 0);

  return (
    <div className="detail-pane pane-stock">
      <div
        className={`table-wrap scroll-x detail-table-scroll${stockRows.length > STICKY_ROW_THRESHOLD ? " stickable" : ""}`}
      >
        <table className="data-table sub detail-data-table detail-stock-table">
          <thead>
            <tr>
              <th className="num">在库件数</th>
              <th className="num">预锁定</th>
              <th className="num">可用件数</th>
              {showFields && (
                <>
                  <th>套/箱</th>
                  <th>发货计划号</th>
                  <th>发货时间</th>
                  <th>版本号</th>
                  <th>已贴 FNSKU</th><th>发货方式（所属海外仓）</th>
                </>
              )}
              <th className="actions-col">调拨</th>
            </tr>
          </thead>
          <tbody>
            {stockRows.map((row, index) => {
              const key = row.batchKey;
              const open = activeBatchKey === key;
              const locked = row.locked;
              const available = row.available;
              const totals: AllocationBatchTotals = alloc?.totals[key] ?? {
                base: row.baseQuantity,
                onHand: row.quantity,
                locked,
                available,
                revision: row.revision,
                updatedAt: model.updatedAt ?? "",
              };
              const batchContext: AllocationBatchContext = {
                key,
                model: model.model,
                category: model.category ?? "硒鼓",
                quantity: row.baseQuantity,
                plan: row.plan ?? "",
                date: row.date ?? "",
                version: row.version ?? "",
                fnsku: row.fnsku ?? "",
                packPerBox: row.packPerBox ?? null,
              };

              return (
                <Fragment key={key || index}>
                  <tr className={open ? "batch-open" : undefined}>
                    <td className="num strong">{formatNumber(row.quantity)}</td>
                    <td className="num">{formatNumber(locked)}</td>
                    <td className="num">{formatNumber(available)}</td>
                    {showFields && (
                      <>
                        <td>{row.packPerBox || "—"}</td>
                        <td>
                           <Clip text={row.plan || "—"} mono />
                        </td>
                        <td className="date-cell">{row.date || "—"}</td>
                        <td>
                          <span className="ver-chip">{row.version || "—"}</span>
                        </td>
                        <td>
                           <Clip text={row.fnsku || "—"} mono />
                        </td><td>{row.warehouse || "历史仓库未确定"}{row.sourceTeam && <span className="muted"> · {row.sourceTeam}</span>}</td>
                      </>
                    )}
                    <td className="actions-col">
                      <div className="row-actions">
                        {row.isLegacyPlaceholder ? null : locked > 0 && <Badge label={`预锁定 ${formatNumber(locked)}`} tone="blue" />}
                        <button
                          type="button"
                          className={`alloc-toggle${open ? " open" : ""}`}
                           disabled={!perm.actions || row.isLegacyPlaceholder}
                          aria-expanded={open}
                          title={
                            !perm.actions
                                ? "当前角色没有调拨操作权限"
                                : open
                                  ? "收起调拨表单"
                                  : `填写调拨表单（当前可用 ${formatNumber(available)} 件）`
                          }
                          onClick={() => onSelectBatchKey(open ? null : key)}
                        >
                          <Icon name="chevron" size={13} className="alloc-toggle-caret" />
                          <span>调拨</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                  {open && perm.actions && (
                    <tr className="alloc-row">
                      <td colSpan={colCount}>
                        <AllocationPanel
                          batch={batchContext}
                          totals={totals}
                          role={role}
                          actionsAllowed={perm.actions}
                          busy={allocBusy}
                          onEntry={onEntry}
                        />
                      </td>
                    </tr>
                  )}
                  {perm.detail && perm.expand && (
                    <tr className="allocation-history-row">
                      <td colSpan={colCount}>
                        <details className="allocation-history" aria-label={`${key} 调拨记录`}>
                          <summary>调拨记录{alloc && `（${alloc.publicRecords[key]?.length ?? 0}）`}</summary>
                          {!alloc ? <p>调拨记录尚未加载。</p> : <>
                            <div className="table-wrap scroll-x">
                              <table className="data-table sub allocation-history-table">
                                <thead><tr><th>调拨单</th><th>运营姓名</th><th>团队</th><th className="num">原申请量</th><th className="num">批准量</th><th className="num">当前调拨占用</th><th className="num">实际调出</th><th>状态</th></tr></thead>
                                <tbody>{(alloc.publicRecords[key] ?? []).length === 0
                                  ? <tr><td colSpan={8}>暂无调拨记录</td></tr>
                                  : alloc.publicRecords[key].map(record => <tr key={record.id} data-allocation-summary-id={record.id}>
                                    <td className="mono">{record.documentNo}</td><td>{record.operator || "历史未记录"}</td><td>{record.department || "历史未记录"}</td>
                                    <td className="num">{record.requestedQuantity === null ? "历史未记录" : formatNumber(record.requestedQuantity)}</td>
                                    <td className="num">{record.approvedQuantity !== null ? formatNumber(record.approvedQuantity) : record.status === "待商务审核" ? "待审核" : record.status === "已拒绝" ? "已拒绝" : "历史未记录"}</td>
                                    <td className="num">{record.lockedQuantity === null ? "未记录" : formatNumber(record.lockedQuantity)}</td>
                                    <td className="num">{record.issuedQuantity === null ? "未记录" : formatNumber(record.issuedQuantity)}</td><td>{record.status.includes("已归档") ? "" : record.status}</td>
                                  </tr>)}</tbody>
                              </table>
                            </div>
                          </>}
                        </details>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
           <tr className={`subtotal-row${sum !== model.inStock || lockedSum !== (model.locked ?? lockedSum) || availableSum !== (model.available ?? availableSum) ? " mismatch" : ""}`}>
             <td className="num subtotal-cell">{formatNumber(sum)}</td>
             <td className="num subtotal-cell">{formatNumber(lockedSum)}</td>
             <td className="num subtotal-cell">{formatNumber(availableSum)}</td>
             <td className="subtotal-label" colSpan={colCount - 3}>
               明细合计
               {sum !== model.inStock && ` · 与在库库存不一致（${formatNumber(model.inStock)}）`}
               {model.locked != null && lockedSum !== model.locked && ` · 与汇总预锁定不一致（${formatNumber(model.locked)}）`}
               {model.available != null && availableSum !== model.available && ` · 与可用库存不一致（${formatNumber(model.available)}）`}
             </td>
           </tr>
          </tfoot>
        </table>
      </div>
      {!showFields && (
        <p className="detail-field-note">
          当前角色无法查看计划号、发货时间、版本号和 FNSKU。
        </p>
      )}
    </div>
  );
}

function TransitPane({ model, transitRows, perm, role, onShelf }: CommonProps) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  return <div className="detail-pane pane-transit"><div className="table-wrap scroll-x"><table className="data-table sub">
    <thead><tr><th>在途件数</th>{perm.detail && <><th>套/箱</th><th>发货计划号</th><th>发货时间</th><th>版本号</th><th>已贴 FNSKU</th><th>发货方式</th><th>团队</th><th>物流状态</th></>}<th>是否上架</th></tr></thead>
    <tbody>{transitRows.map(row => <tr key={row.id}><td>{formatNumber(row.quantity)}</td>{perm.detail && <><td>{row.packPerBox || "—"}</td><td>{row.plan}</td><td>{row.date}</td><td>{row.version}</td><td>{row.fnsku}</td><td>{row.shippingMethod}</td><td>{row.team}</td><td>{row.status}</td></>}<td>
      {TRANSIT_SHELF_ROLE_SET.has(role) && (!operationGroups[role] || row.team === operationGroups[role]) && perm.actions && row.statusCode === "in_transit" && !row.isLegacyPlaceholder ? <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={async () => {
        setBusy(row.id); setError(null); const failure = await onShelf(row); setBusy(null); if (failure) setError(failure);
      }}>{busy === row.id ? "提交中…" : row.shippingMethod === "直发FBA" ? "yes" : "确认上架"}</button> : row.statusCode === "on_shelf" && row.shippingMethod === "直发FBA" ? null : <span>{row.onShelf}</span>}
    </td></tr>)}<SubtotalRow sum={transitRows.reduce((sum,row) => sum + row.quantity,0)} reference={model.inTransit} referenceLabel="在途库存" span={perm.detail ? 9 : 1} /></tbody>
  </table></div>{error && <p className="dialog-error" role="alert">{error}</p>}</div>;
}

/* 型号下钻区：在库批次（可继续展开到调拨行）与在途明细两个分段。
   这一级由「明细展开」权限控制开合，字段列由「明细字段查看」控制。 */
export function ModelDetailSection(props: CommonProps) {
  const { model, stockRows, transitRows, perm, permLoading, tab, onTabChange } = props;

  if (permLoading) {
    return (
      <section className="detail-panel">
        <Spinner label="权限信息加载中…" />
      </section>
    );
  }

  if (!perm.summary) {
    return (
      <section className="detail-panel">
        <div className="detail-empty">当前角色没有查看该类目库存的权限。</div>
      </section>
    );
  }

  return (
    <section className="detail-panel" aria-label={`${model.model} 库存明细`}>
      <div className="detail-tabs">
        <Segmented<DetailTab>
          role="tablist"
          ariaLabel="明细分类切换"
          value={tab}
          onChange={onTabChange}
          items={[
            {
              value: "stock",
              label: "在库明细",
              count: stockRows.length,
              icon: "package",
              className: "tab-stock",
              disabled: !perm.expand,
              title: perm.expand ? "在库批次与调拨" : "当前角色没有查看明细的权限",
            },
            {
              value: "transit",
              label: "在途明细",
              count: transitRows.length,
              icon: "truck",
              className: "tab-transit",
              disabled: !perm.expand,
              title: perm.expand ? "在途物流与上架状态" : "当前角色没有查看明细的权限",
            },
          ]}
        />
        <InquiryEntry key={model.model} model={model} role={props.role} enabled={perm.actions && perm.expand} />
      </div>

      {!perm.expand ? (
        <div className="detail-empty">当前角色没有查看明细的权限，仅可查看该型号的库存汇总数字。</div>
      ) : tab === "stock" ? (
        <StockPane {...props} />
      ) : (
        <TransitPane {...props} />
      )}
    </section>
  );
}
