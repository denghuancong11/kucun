import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchSync, type ApiError } from "./api";
import { Sidebar, Topbar } from "./components/Sidebar";
import { requirements } from "./data";
import { ROLES, TRANSIT_ROLES, type RequirementKey, type Role, type SyncState } from "./types";
import { AuditLogView } from "./views/AuditLog";
import { Requirement1View } from "./views/Requirement1";
import { Requirement3View } from "./views/Requirement3";
import { Requirement4View } from "./views/Requirement4";
import { ApprovalCenterView } from "./views/ApprovalCenter";

const ROLE_STORAGE_KEY = "aster-current-role";

function readCurrentRole(): Role {
  const stored = sessionStorage.getItem(ROLE_STORAGE_KEY);
  return ROLES.includes(stored as Role) ? stored as Role : "admin";
}

export default function App() {
  const [view, setView] = useState<RequirementKey>("req1");
  const [tabs, setTabs] = useState<RequirementKey[]>(["req1"]);
  const navigate = (next: RequirementKey) => { setView(next); setTabs(current => current.includes(next) ? current : [...current, next]); };
  const closeTab = (key: RequirementKey) => { const next = tabs.filter(item => item !== key); setTabs(next); if (view === key) setView(next[next.length - 1]); };
  const [role, setRole] = useState<Role>(readCurrentRole);
  const syncRef = useRef<SyncState | null>(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    let timer: number;
    let running = false;
    const observe = (next: SyncState) => {
      const previous = syncRef.current;
      if (previous && next.databaseId === previous.databaseId && next.dataVersion < previous.dataVersion) return;
      syncRef.current = next;
      // 以页面实际读到的版本为准：首次查询或失败的刷新不能算作已追上服务端。
      void queryClient.refetchQueries({ type: "active", predicate: query => {
        const status = (query.state.error as ApiError | null)?.status;
        if (status && status >= 400 && status < 500) return false;
        const loaded = (query.state.data as { sync?: SyncState } | undefined)?.sync;
        return query.state.fetchStatus === "idle" && (query.state.status === "error" || Boolean(loaded &&
          (loaded.databaseId !== next.databaseId || loaded.dataVersion < next.dataVersion)));
      } }, { cancelRefetch: false });
    };
    const check = async () => {
      if (cancelled || running) return;
      running = true; window.clearTimeout(timer);
      try { const next = await fetchSync(role); if (!cancelled) observe(next); }
      catch { /* 各业务查询显示连接错误，版本轮询下次继续。 */ }
      finally { running = false; if (!cancelled) timer = window.setTimeout(() => void check(), 2000); }
    };
    // 本人提交也可能跨过他人的更新，仍核对各页面查询实际读到的版本。
    const ownWrite = (event: Event) => observe((event as CustomEvent<SyncState>).detail);
    const focus = () => void check();
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    window.addEventListener("aster-write", ownWrite);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    void check();
    return () => { cancelled = true; window.clearTimeout(timer); window.removeEventListener("aster-write", ownWrite); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [role, queryClient]);
  const changeRole = (next: Role) => {
    const url = new URL(location.href); url.searchParams.delete("model"); url.searchParams.delete("tab");
    history.replaceState(null, "", url);
    if (!TRANSIT_ROLES.includes(next)) {
      setTabs(current => current.filter(item => item !== "req3"));
      setView(current => current === "req3" ? "req1" : current);
    }
    sessionStorage.setItem(ROLE_STORAGE_KEY, next);
    setRole(next);
  };
  const meta = requirements.find(item => item.key === view)!;
  return <div className="app">
    <a className="skip-link" href="#main-content">跳转到主要内容</a>
    <Sidebar view={view} role={role} onNavigate={navigate} />
    <div className="main">
      <Topbar view={view} tabs={tabs} onNavigate={navigate} onClose={closeTab} role={role} onRoleChange={changeRole} />
      <main className="content" id="main-content" tabIndex={-1}><div className="breadcrumb">Unismar耗材库存系统 <span>›</span> {meta.label}</div><div className="view-enter" key={`${view}-${role}`}><h1 className="page-title">{meta.label}</h1>
        {view === "req1" && <Requirement1View role={role} />}
        {view === "req3" && TRANSIT_ROLES.includes(role) && <Requirement3View role={role} />}
        {view === "req4" && <Requirement4View role={role} />}
        {view === "approvals" && <ApprovalCenterView role={role} />}
        {view === "audit" && <AuditLogView role={role} />}
      </div></main>
    </div>
  </div>;
}
