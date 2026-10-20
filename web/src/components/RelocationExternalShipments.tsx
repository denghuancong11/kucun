import { formatNumber } from "../api";
import type { RelocationExternalItem, RelocationExternalShipment } from "../types";
import { preserveSummarySelection } from "../utils/rowExpansion";
import { displayTime } from "./ui";

export function RelocationExternalShipments({ rows, selected, disabled, onChange, readOnly = false }: {
  rows: RelocationExternalShipment[]; selected: Record<number, string>;
  disabled: boolean; onChange: (selected: Record<number, string>) => void;
  readOnly?: boolean;
}) {
  if (rows.length === 0) return null;
  const choose = (row: RelocationExternalShipment, checked: boolean) => {
    const next = { ...selected };
    if (checked) next[row.lineId] = String(row.availableQuantity);
    else delete next[row.lineId];
    onChange(next);
  };
  return <div className="relocation-external-shipments"><div className="table-wrap scroll-x"><table className="data-table sub reconcile-table" aria-label="移仓包裹明细"><thead><tr>
    {!readOnly && <th>采纳</th>}<th>店铺</th><th>国家</th><th>订单号</th><th>FNSKU</th><th>承运商</th><th>运单号</th><th>包裹发货时间</th><th className="reconcile-number">包裹实发数量</th><th className="reconcile-number">已采纳数量</th><th className="reconcile-number">可采纳数量</th><th>领星数据获取时间</th>{!readOnly && <th>本次采纳数量</th>}
  </tr></thead><tbody>{rows.map((row) => {
      const chosen = Object.prototype.hasOwnProperty.call(selected, row.lineId);
      return <tr className={chosen && !readOnly ? "selected" : undefined} key={row.lineId} data-external-shipment-id={row.lineId}>
        {!readOnly && <td><input type="checkbox" aria-label={`采纳包裹 ${row.trackingNo} ${row.fnsku}`} checked={chosen} disabled={disabled || (!chosen && row.availableQuantity <= 0)} onChange={(event) => choose(row, event.target.checked)} /></td>}
        <td>{row.storeName || "—"}</td><td>{row.countryCode || "—"}</td><td className="reconcile-identifier">{row.orderNo || "—"}</td><td className="reconcile-identifier">{row.fnsku || "—"}</td><td>{row.carrier || "—"}</td><td className="reconcile-identifier">{row.trackingNo || "—"}</td><td>{row.shipDate || "—"}</td>
        <td className="reconcile-number">{formatNumber(row.quantity)}</td><td className="reconcile-number">{formatNumber(row.usedQuantity)}</td><td className="reconcile-number">{formatNumber(row.availableQuantity)}</td><td>{displayTime(row.capturedAt, true)}</td>
        {!readOnly && <td><input className="external-shipment-quantity" aria-label={`包裹 ${row.trackingNo} ${row.fnsku} 本次采纳数量`} type="number" min="1" max={row.availableQuantity} step="1" value={selected[row.lineId] ?? ""} disabled={disabled || !chosen} onChange={(event) => onChange({ ...selected, [row.lineId]: event.target.value })} /></td>}
      </tr>;
    })}</tbody></table></div>
    <p className="form-hint">最近获取领星数据：{displayTime(rows.map((row) => row.capturedAt).sort().slice(-1)[0])}</p>
  </div>;
}

export function RelocationExternalHistory({ items }: { items: RelocationExternalItem[] }) {
  if (items.length === 0) return null;
  return <details className="relocation-external-history"><summary onClick={preserveSummarySelection}>领星包裹采纳明细（{items.length}）</summary><div className="table-wrap scroll-x"><table className="data-table sub reconcile-table" aria-label="移仓包裹采纳明细"><thead><tr><th>店铺</th><th>国家</th><th>订单号</th><th>FNSKU</th><th>承运商</th><th>运单号</th><th>包裹发货时间</th><th className="reconcile-number">包裹实发数量</th><th className="reconcile-number">本单采纳数量</th><th>已采纳包裹的数据获取时间</th></tr></thead><tbody>{items.map((item) => <tr key={item.lineId}>
    <td>{item.snapshot.storeName || "—"}</td><td>{item.snapshot.countryCode || "—"}</td><td className="reconcile-identifier">{item.snapshot.orderNo || "—"}</td><td className="reconcile-identifier">{item.snapshot.fnsku || "—"}</td><td>{item.snapshot.carrier || "—"}</td><td className="reconcile-identifier">{item.snapshot.trackingNo || "—"}</td><td>{item.snapshot.shipDate || "—"}</td><td className="reconcile-number">{formatNumber(item.snapshot.quantity)}</td><td className="reconcile-number">{formatNumber(item.quantity)}</td><td>{displayTime(item.snapshot.capturedAt, true)}</td>
  </tr>)}</tbody></table></div></details>;
}
