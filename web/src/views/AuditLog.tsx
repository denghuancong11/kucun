import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAuditLog, formatNumber } from "../api";
import { Icon } from "../components/Icon";
import { Panel, displayTime } from "../components/ui";
import type { AuditAction, AuditRecord, Role, Tone } from "../types";

type VisibleAuditAction = Extract<AuditAction, "transfer_upgrade_update" | "transfer_upgrade_import" | "business_correction" | "transit_import" | "transit_import_revert" | "transit_status" | "transit_on_shelf" | "upgrade_relocation_cancelled" | "upgrade_relocation_corrected" | "transit_team_corrected" | "entry" | "review" | "reject" | "confirm" | "cancel" | "upgrade_direct_start" | "upgrade_direct_complete" | "upgrade_relocation_created" | "upgrade_relocation_complete">;

const auditActions: ReadonlyArray<{ value: VisibleAuditAction; label: string; tone: Tone }> = [
  {value:"transfer_upgrade_update",label:"转仓升级办理",tone:"green"},
  {value:"transfer_upgrade_import",label:"转仓升级导入",tone:"blue"},
  {value:"transit_import",label:"在途导入",tone:"blue"},
  {value:"transit_status",label:"物流更新",tone:"blue"},
  {value:"transit_on_shelf",label:"上架入库",tone:"green"},
  { value: "entry", label: "调拨录入", tone: "blue" },
  { value: "review", label: "商务审核", tone: "blue" },
  { value: "reject", label: "商务拒绝", tone: "red" },
  { value: "confirm", label: "调拨确认", tone: "green" },
  { value: "upgrade_relocation_created", label: "移仓发货", tone: "amber" },
  { value: "upgrade_relocation_complete", label: "移仓升级完成", tone: "green" },
  { value: "upgrade_direct_start", label: "在库升级锁定", tone: "blue" },
  { value: "upgrade_direct_complete", label: "在库升级完成", tone: "green" },
];


const roleLabels: Record<string, string> = {
  admin: "管理员",
  assistant: "助理",
  "assistant-1": "助理-一团",
  "assistant-2": "助理-二团",
  "operation-1": "运营·一团",
  "operation-2": "运营·二团",
  purchasing: "采购", logistics: "物流", alan: "Alan",
  business: "商务",
};

interface AuditFilters {
  model: string;
  from: string;
  to: string;
}

const emptyFilters: AuditFilters = { model: "", from: "", to: "" };

function isVisibleAuditAction(value: unknown): value is VisibleAuditAction {
  return auditActions.some((item) => item.value === value);
}

function actionOf(record: AuditRecord): VisibleAuditAction | null {
  const value = record.eventType ?? record.action;
  return isVisibleAuditAction(value) ? value : null;
}

function actionMeta(value: VisibleAuditAction) {
  return auditActions.find((item) => item.value === value) ?? auditActions[0];
}

function parseBatchModel(batch?: string) {
  if (!batch) return "";
  const separator = batch.indexOf("#");
  return separator > 0 ? batch.slice(0, separator) : "";
}

function recordModel(record: AuditRecord) {
  return record.model ?? parseBatchModel(record.batch);
}

/* 单元格内同时给出在库与预锁定两个维度，但压在一行内，
   避免为了两条堆叠文本把整表行高推到近 80px。 */
function QuantityChange({ record }: { record: AuditRecord }) {
  if (record.effectKnown !== true || !Number.isFinite(record.onHandDelta) || !Number.isFinite(record.lockedDelta)) {
    return <span className="audit-delta-unknown">库存影响未记录</span>;
  }
  return (
    <span className="audit-quantity-change">
      <span className="audit-dim">
        <small>在库</small>
        <SignedDelta value={Number(record.onHandDelta)} />
      </span>
      <span className="audit-dim">
        <small>预锁定</small>
        <SignedDelta value={Number(record.lockedDelta)} />
      </span>
    </span>
  );
}

function SignedDelta({ value }: { value: number }) {
  const signed = value > 0 ? `+${formatNumber(value)}` : value < 0 ? `-${formatNumber(Math.abs(value))}` : "0";
  const tone = value > 0 ? "positive" : value < 0 ? "negative" : "zero";
  return <strong className={`audit-delta audit-delta-${tone}`}>{signed}</strong>;
}

export function AuditLogView({ role }: { role: Role }) {
  const client=useQueryClient(),running=useRef(false);
  const [querying,setQuerying]=useState(false),[queryDone,setQueryDone]=useState('');
  const [detail, setDetail] = useState<AuditRecord | null>(null);
  const [action, setAction] = useState<VisibleAuditAction>("entry");
  const [draftFilters, setDraftFilters] = useState<AuditFilters>(emptyFilters);
  const [filters, setFilters] = useState<AuditFilters>(emptyFilters);
  const [queryError, setQueryError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["audit", role, action, filters], queryFn: () => fetchAuditLog(role, { action, ...filters, limit: 200 }) });
  const records = query.data?.records ?? [];
  const loading = query.isLoading;
  const error = query.isError ? query.error.message : null;

  const selectedMeta = actionMeta(action);
  const hasFilters = Object.values(filters).some(Boolean);


  const submitQuery = async (event: FormEvent) => {
    event.preventDefault();
    if(running.current)return;
    setQueryDone('');
    if (draftFilters.from && draftFilters.to && draftFilters.from > draftFilters.to) {
      setQueryError("开始日期不能晚于结束日期");return;
    }
    const next = { model: draftFilters.model.trim(), from: draftFilters.from, to: draftFilters.to };
    running.current=true;setQuerying(true);setQueryError(null);
    try {
      const result=await client.fetchQuery({queryKey:["audit",role,action,next],queryFn:()=>fetchAuditLog(role,{action,...next,limit:200}),staleTime:0});
      setFilters(next);setQueryDone('查询完成：'+selectedMeta.label+'，共 '+result.records.length+' 条。');
    } catch(failure){setQueryError(failure instanceof Error?failure.message:String(failure));}
    finally{running.current=false;setQuerying(false);}
  };

  const clearQuery = () => {
    setQueryDone('');
    setDraftFilters(emptyFilters);
    setFilters(emptyFilters);
    setQueryError(null);
  };

  return (
    <Panel className="audit-panel">
      <form className="audit-search" role="search" onSubmit={event=>void submitQuery(event)}>
        <label className="field"><span>操作分类</span><select aria-label="选择库存操作分类" value={action} disabled={querying} onChange={event => {setQueryDone('');setAction(event.target.value as VisibleAuditAction);}}>{auditActions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label className="field"><span>型号</span><input name="model" value={draftFilters.model} disabled={querying} onChange={(event) => {setQueryDone('');setDraftFilters((value) => ({ ...value, model: event.target.value }));}} aria-label="按型号查询库存流水" placeholder="输入型号" /></label>
        <label className="field"><span>开始日期</span><input name="from" type="date" value={draftFilters.from} disabled={querying} onChange={(event) => {setQueryDone('');setDraftFilters((value) => ({ ...value, from: event.target.value }));}} aria-label="按开始日期查询库存流水" /></label>
        <label className="field"><span>结束日期</span><input name="to" type="date" value={draftFilters.to} disabled={querying} onChange={(event) => {setQueryDone('');setDraftFilters((value) => ({ ...value, to: event.target.value }));}} aria-label="按结束日期查询库存流水" /></label>
        <div className="audit-search-actions">
          <button type="submit" className="btn btn-primary" aria-label="查询" disabled={loading||querying}><Icon name="search" size={13} />{querying?"正在查询…":queryDone?"查询完成":"查询"}</button>
          <button type="button" className="btn btn-ghost" disabled={loading || querying || (!Object.values(draftFilters).some(Boolean) && !hasFilters)} onClick={clearQuery}>清空</button>
        </div>
      </form>

      {queryDone && <p role="status">{queryDone}</p>}
      {queryError && <div className="audit-query-error" role="alert">{queryError}</div>}

      {loading && (
        <div className="detail-loading" role="status">
          <div className="skeleton-table" aria-hidden="true"><span className="skeleton-bar" /><span className="skeleton-bar" /><span className="skeleton-bar" /></div>
          <span className="detail-loading-note"><span className="spinner" aria-hidden="true" />正在加载{selectedMeta.label}流水…</span>
        </div>
      )}

      {error && <div className="callout" role="alert"><Icon name="alert" size={15} className="callout-icon" /><div><strong>库存流水加载失败</strong><p>{error}</p></div></div>}

      {!loading && !error && records.length === 0 && (
        <div className="detail-empty">{hasFilters ? "未找到符合条件的流水。" : `暂无${selectedMeta.label}流水。`}</div>
      )}

      {!loading && records.length > 0 && (
        <>
          <div className="table-wrap scroll-x">
            <table className="data-table audit-table">
              <thead><tr><th>操作时间</th><th>业务动作</th><th>型号 / 类目</th><th>业务单号</th><th>数量</th><th>在库 / 预锁定变化</th><th>可用变化</th><th>运营 / 团队</th><th>操作人</th><th>详情</th></tr></thead>
              <tbody>{records.map((record, index) => <tr key={record.eventId ?? index} data-audit-row-action={actionOf(record) ?? action}>
                <td className="date-cell">{displayTime(record.at)}</td><td>{actionMeta(actionOf(record) ?? action).label}</td><td><strong>{recordModel(record) || "—"}</strong><div className="muted">{record.category || "—"}</div></td><td>{record.businessNo || record.documentNo || "—"}</td><td>{record.quantity == null ? "—" : formatNumber(record.quantity)}</td>
                <td><QuantityChange record={record} /></td><td>{record.effectKnown === true && record.availableDelta != null ? <SignedDelta value={record.availableDelta} /> : "—"}</td><td>{record.operator || "—"}<div className="muted">{record.department || record.team || "—"}</div></td><td>{roleLabels[record.role] || record.role || "—"}</td><td><button className="link-btn" type="button" onClick={() => setDetail(record)}>查看</button></td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="detail-field-note audit-count">
            已显示 {records.length} 条，最多显示 200 条。
            {/* 原「操作结果」列在同一分类下每行取值恒定，不承载信息，已并入分类标签本身 */}
          </div>
        </>
      )}
      {detail && <div className="dialog-mask"><div className="dialog audit-detail-dialog" role="dialog" aria-modal="true" aria-label="流水详情"><h3>流水详情</h3><dl className="relocation-fields">
        {[["业务单号",detail.businessNo || detail.documentNo],["时间",displayTime(detail.at)],["业务动作",actionMeta(actionOf(detail) ?? action).label],["型号",recordModel(detail)],["类目",detail.category],["数量",detail.quantity == null ? "—" : formatNumber(detail.quantity)],["运营",detail.operator],["团队",detail.department || detail.team],["操作岗位",roleLabels[detail.role] || detail.role],["店铺",detail.store],["来源批次",detail.batch],["操作结果",detail.result],["原因",detail.reason]].map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}
        <div><dt>库存变化</dt><dd><QuantityChange record={detail} /></dd></div><div><dt>在途变化</dt><dd>{detail.inTransitDelta == null ? "—" : <SignedDelta value={detail.inTransitDelta} />}</dd></div>
      </dl><div className="dialog-actions"><button className="btn btn-ghost" type="button" onClick={() => setDetail(null)}>关闭</button></div></div></div>}
    </Panel>
  );
}
