import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatNumber } from "../api";
import type { NoticeMessage, Tone } from "../types";
import { Icon } from "./Icon";

export function Badge({
  label,
  tone = "neutral",
  dot = true,
  title,
}: {
  label: string;
  tone?: Tone;
  dot?: boolean;
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {dot && <i aria-hidden="true" />}
      {label}
    </span>
  );
}

/* 统一状态色映射：物流状态、上架指示、字段映射等所有状态徽标共用，保证同一语义在全站呈现同一颜色。
   身份表（README「业务状态色身份表」）：可用=绿，在途=琥珀，预锁定=蓝，已调出/已撤销=中性灰，异常=红。
   品牌蓝只表示“当前选中”，不参与业务状态，故此处不返回 brand。 */
export function toneForStatus(status: string): Tone {
  if (status === "可用" || status === "可展示" || status === "已确认" || status === "调拨完成，已备份") return "green";
  if (status === "待确认" || status === "待助理确认" || status === "待修改") return "amber";
  if (status === "缺失" || status === "已撤回" || status === "已拒绝") return "red";
  if (status === "已撤销") return "neutral";
  if (status.includes("预锁定")) return "blue";
  if (/\byes\b/i.test(status)) return "green";
  if (/\bno\b/i.test(status)) return "amber";
  return "neutral";
}

/* 统一时间呈现：全站唯一入口。后端在不同接口分别返回 ISO 串与本地串，
   这里统一收敛为 zh-CN 24 小时制，避免同一份数据在三个视图出现三种格式。 */
export function displayTime(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

/* 右上角浮动通知。类名保留 notice-* 语义（既有回归脚本与样式表以此定位）。 */
export function Notice({
  notice,
  onClose,
}: {
  notice: NoticeMessage | null;
  onClose?: () => void;
}) {
  if (!notice) return null;
  const iconName = notice.kind === "success" ? "circleCheck" : notice.kind === "error" ? "alert" : "info";
  return (
    <div className="notice-container" aria-live="polite">
      <div className={`notice notice-${notice.kind}`} role="status">
        <Icon name={iconName} size={15} className="notice-icon" />
        <span className="notice-text">{notice.text}</span>
        {onClose && (
          <button type="button" className="notice-close" onClick={onClose} aria-label="关闭提示">
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

export function Panel({
  title,
  description,
  actions,
  badge,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions || badge) && (
        <div className="panel-head">
          <div className="panel-title-area">
            <div className="panel-title-row">
              {title && <h2>{title}</h2>}
              {badge}
            </div>
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="panel-head-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/* 独立空态块：图标 + 标题 + 提示 + 可选操作按钮 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="e-icon" aria-hidden="true">
        <Icon name="inbox" size={24} strokeWidth={1.5} />
      </span>
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/* 骨架屏组件：数据加载时提供平滑占位，消除表格抖动 */
export function Skeleton({
  width = "100%",
  height = "16px",
  rounded = false,
  className = "",
}: {
  width?: string;
  height?: string;
  rounded?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`skeleton-bar ${rounded ? "skeleton-rounded" : ""} ${className}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

export function SkeletonTable({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="skeleton-table-wrap" aria-hidden="true">
      <div className="skeleton-table-header">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} height="14px" width="70%" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div className="skeleton-table-row" key={r}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} height="13px" width={c === 0 ? "80%" : c === 1 ? "50%" : "65%"} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* 长字段省略显示：默认截断 + 悬停 title 预览；点击或键盘触发后展开完整内容，再次点击收起。 */
export function Clip({ text, mono = false }: { text: string; mono?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={`clip${mono ? " mono" : ""}${open ? " open" : ""}`}
      title={text}
      aria-expanded={open}
      aria-label={`${text}（点击${open ? "收起" : "查看完整内容"}）`}
      onClick={() => setOpen((prev) => !prev)}
    >
      {text}
    </button>
  );
}

/* 数字变化反馈：值变化后给一次 ≤300ms 的透明度脉冲（一次性播放，非常驻动画）。 */
export function useFlashOnChange(value: number): boolean {
  const prev = useRef(value);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (Object.is(prev.current, value)) return;
    prev.current = value;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 400);
    return () => window.clearTimeout(timer);
  }, [value]);
  return flash;
}

/* 纯数字版：直接渲染千分位数字并在变化时脉冲 */
export function FlashNum({ value }: { value: number }) {
  const flash = useFlashOnChange(value);
  return <span className={flash ? "num-flash" : undefined}>{formatNumber(value)}</span>;
}

/* 加载指示：CSS-only 圆环，reduced-motion 下降级为静态环（见 styles）。 */
export function Spinner({ label }: { label?: string }) {
  return (
    <span className="loading-inline" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

/* 分段控件：类目筛选、明细标签、角色/类目选择共用同一控件语言。 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  role = "group",
  className = "",
}: {
  items: Array<{ value: T; label: string; count?: number; icon?: string; disabled?: boolean; title?: string; className?: string }>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  role?: "group" | "tablist";
  className?: string;
}) {
  const isTabs = role === "tablist";
  return (
    <div className={`chip-group ${className}`} role={role} aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role={isTabs ? "tab" : undefined}
          aria-selected={isTabs ? item.value === value : undefined}
          aria-pressed={isTabs ? undefined : item.value === value}
          className={`chip${item.value === value ? " active" : ""}${item.className ? ` ${item.className}` : ""}`}
          disabled={item.disabled}
          title={item.title}
          onClick={() => !item.disabled && onChange(item.value)}
        >
          {item.icon && <Icon name={item.icon} size={13} />}
          <span>{item.label}</span>
          {item.count !== undefined && <span className="chip-count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* 仅用于用户触发的读取和下载；业务写入继续使用原请求确认机制。 */
export function FeedbackButton({label, pendingLabel, doneLabel, onAction, successText, onResult, disabled=false, className="btn btn-ghost"}: {
  label:string; pendingLabel:string; doneLabel:string; onAction:()=>Promise<unknown>; successText?:string;
  onResult?:(notice:NoticeMessage)=>void; disabled?:boolean; className?:string;
}) {
  const [state,setState]=useState<'idle'|'busy'|'done'>('idle');
  const [error,setError]=useState('');
  const running=useRef(false);
  const run=async()=>{
    if(running.current||disabled)return;
    running.current=true;setState('busy');setError('');
    try { await onAction();setState('done');onResult?.({kind:'success',text:successText??label+'：'+doneLabel}); }
    catch(cause){const text=label+'失败：'+(cause instanceof Error?cause.message:String(cause));setState('idle');setError(text);onResult?.({kind:'error',text});}
    finally {running.current=false;}
  };
  return <><button type="button" className={className} aria-label={label} aria-busy={state==='busy'} disabled={disabled||state==='busy'} onClick={()=>void run()}>{state==='busy'?pendingLabel:state==='done'?doneLabel:label}</button>
    {error&&!onResult&&<span className="field-error" role="alert">{error}</span>}
    {state==='done'&&successText&&!onResult&&<span className="form-hint" role="status">{successText}</span>}</>;
}
