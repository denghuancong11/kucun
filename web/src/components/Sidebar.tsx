import { requirements } from "../data";
import { TRANSIT_VIEW_ROLES, type RequirementKey, type Role } from "../types";
import { Icon } from "./Icon";

const navIcons: Record<string, string> = {
  req1: "box",
  req3: "truck",
  req4: "refresh",
  approvals: "check",
  audit: "clock",
};

const roleOptions: { value: Role; label: string }[] = [
  { value: "admin", label: "管理员" },
  { value: "assistant-1", label: "助理-一团" },
  { value: "assistant-2", label: "助理-二团" },
  { value: "operation-1", label: "运营·一团" },
  { value: "operation-2", label: "运营·二团" },
  { value: "purchasing", label: "采购" },
  { value: "logistics", label: "物流" },
  { value: "alan", label: "Alan" },
  { value: "business", label: "商务" },
];

export function Sidebar({
  view,
  role,
  onNavigate,
}: {
  view: RequirementKey;
  role: Role;
  onNavigate: (view: RequirementKey) => void;
}) {
  const renderItem = (item: (typeof requirements)[number]) => {
    return (
      <button
        key={item.key}
        type="button"
        className={`nav-item${view === item.key ? " active" : ""}`}
        title={item.title}
        aria-current={view === item.key ? "page" : undefined}
        onClick={() => onNavigate(item.key)}
      >
        <Icon name={navIcons[item.key]} size={15} strokeWidth={1.9} />
        <span>{item.label}</span>
      </button>
    );
  };

  return (
    <aside className="sidebar">
      <div className="brand" aria-label="Unismar耗材库存系统"><span className="brand-mark" aria-hidden="true">U</span><span>Unismar</span><span>耗材</span><span>库存系统</span></div>
      <nav aria-label="功能导航">
        {requirements.filter(item => item.key !== "req3" || TRANSIT_VIEW_ROLES.includes(role)).map(renderItem)}
      </nav>
    </aside>
  );
}

export function Topbar({
  view, tabs, onNavigate, onClose,
  role,
  onRoleChange,
}: {
  view: RequirementKey; tabs: RequirementKey[]; onNavigate: (view: RequirementKey) => void; onClose: (view: RequirementKey) => void;
  role: Role;
  onRoleChange: (role: Role) => void;
}) {
  return (
    <header className="topbar">
      <nav className="tab-strip" aria-label="已打开页面">{tabs.map(key => <div className={`top-tab${view === key ? " active" : ""}`} key={key}><button type="button" onClick={() => onNavigate(key)}>{requirements.find(item => item.key === key)!.label}</button>{key !== "req1" && <button className="tab-close" type="button" aria-label={`关闭${requirements.find(item => item.key === key)!.label}`} onClick={() => onClose(key)}>×</button>}</div>)}</nav>

      <div className="topbar-right">
        <label className="role-select" title="切换当前操作角色">
          <span className="role-label">当前角色</span>
          <select value={role} onChange={(e) => onRoleChange(e.target.value as Role)} aria-label="切换当前操作角色">
            {roleOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <span className="topbar-date">{new Date().toLocaleDateString("zh-CN")}</span>
      </div>
    </header>
  );
}
