import { formatNumber } from "../api";
import type { RelocationExternalItem, RelocationExternalShipment } from "../types";
import { displayTime } from "./ui";

export function RelocationExternalShipments({ workNo, rows, selected, disabled, onChange, readOnly = false }: {
  workNo: string; rows: RelocationExternalShipment[]; selected: Record<number, string>;
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
  return <div className="relocation-external-shipments"><div className="package-grid">{rows.map((row) => {
      const chosen = Object.prototype.hasOwnProperty.call(selected, row.lineId);
      return <div className={`package-card${chosen && !readOnly ? " selected" : ""}`} key={row.lineId} data-external-shipment-id={row.lineId}>
        <div className="package-card-head">{!readOnly && <input type="checkbox" aria-label={`${workNo} 采纳包裹 ${row.trackingNo} ${row.lineId}`} checked={chosen} disabled={disabled || (!chosen && row.availableQuantity <= 0)} onChange={(event) => choose(row, event.target.checked)} />}<strong>{row.externalId}</strong></div>
        <div className="external-shipment-details"><strong>{row.storeName || row.storeId} · {row.countryCode || "—"}</strong><br />
          <span>{row.carrier || "—"} · <span className="mono">{row.trackingNo || "—"}</span></span><br />
          <span className="mono muted">{row.orderNo} · {row.fnsku}</span><br />包裹发货 {row.shipDate || "—"}</div>
        <div className="package-quantities">实发 {formatNumber(row.quantity)} · 已用 {formatNumber(row.usedQuantity)} · <strong>可用 {formatNumber(row.availableQuantity)}</strong></div>
        {!readOnly && <label className="package-quantity">本次采纳<input className="external-shipment-quantity" aria-label={`${workNo} 包裹 ${row.lineId} 本次采纳数量`} type="number" min="1" max={row.availableQuantity} step="1" value={selected[row.lineId] ?? ""} disabled={disabled || !chosen} onChange={(event) => onChange({ ...selected, [row.lineId]: event.target.value })} /></label>}
      </div>;
    })}</div>
    <p className="form-hint">最近取数 {displayTime(rows.map((row) => row.capturedAt).sort().slice(-1)[0])}</p>
  </div>;
}

export function RelocationExternalHistory({ items }: { items: RelocationExternalItem[] }) {
  if (items.length === 0) return null;
  return <details className="relocation-external-history"><summary>领星包裹采纳明细（{items.length}）</summary>{items.map((item) => <div key={item.lineId}>
    <strong>{item.snapshot.storeName || item.snapshot.storeId} · {item.snapshot.countryCode || "—"}</strong>
    <div className="mono">{item.snapshot.orderNo} · {item.snapshot.fnsku}</div>
    <div>{item.snapshot.carrier || "—"} · <span className="mono">{item.snapshot.trackingNo || "—"}</span></div>
    <div>包裹实发 {formatNumber(item.snapshot.quantity)} 件，本单采纳 <strong>{formatNumber(item.quantity)}</strong> 件</div>
    <div>包裹发货 {item.snapshot.shipDate || "—"}；取数 {displayTime(item.snapshot.capturedAt)}</div>
  </div>)}</details>;
}
