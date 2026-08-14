import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { Reorder } from "motion/react";
import {
  IconBooks,
  IconBriefcase,
  IconBulb,
  IconChartCandle,
  IconChevronLeft,
  IconChevronRight,
  IconCommand,
  IconHome,
  IconMenu2,
  IconRadar2,
  IconSearch,
  IconSettings,
  IconTopologyStar3,
} from "@tabler/icons-react";

const localWorkbench = import.meta.env.VITE_WORKBENCH_HOSTED !== "true";

const primaryNavigation = [
  { to: "/", label: "总览", icon: IconHome, end: true },
  { to: "/graph", label: "知识星图", icon: IconTopologyStar3 },
  { to: "/books", label: "书架", icon: IconBooks },
  { to: "/daily-hot", label: "每日热点", icon: IconRadar2 },
  ...(localWorkbench
    ? [{ to: "/career", label: "求职备战", icon: IconBriefcase }]
    : []),
  ...(localWorkbench
    ? [{ to: "/stocks", label: "重点个股", icon: IconChartCandle }]
    : []),
  { to: "/topics", label: "灵感库", icon: IconBulb },
];

// 导航顺序持久化：存路由数组，恢复时按序重排；未记录的新增项保持默认顺序追加。
const NAV_ORDER_KEY = "workbench.nav-order.v1";

function loadNavOrder(defaults) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(NAV_ORDER_KEY));
    if (!Array.isArray(saved)) return defaults;
    const byRoute = new Map(defaults.map((item) => [item.to, item]));
    const ordered = saved
      .filter((to) => byRoute.has(to))
      .map((to) => byRoute.get(to));
    const rest = defaults.filter((item) => !saved.includes(item.to));
    return ordered.length ? [...ordered, ...rest] : defaults;
  } catch {
    return defaults;
  }
}

function saveNavOrder(items) {
  try {
    window.localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(items.map((i) => i.to)));
  } catch {
    // 隐私模式等场景写入失败时静默降级，仅本次会话内保持顺序。
  }
}

// 侧栏收缩状态持久化（仅桌面端语义；移动端抽屉不受影响）。
const SIDEBAR_COLLAPSED_KEY = "workbench.sidebar-collapsed.v1";

function loadSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveSidebarCollapsed(collapsed) {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // 写入失败时静默降级。
  }
}

export function AppShell({ children, onOpenSearch, sync }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [navItems, setNavItems] = useState(() => loadNavOrder(primaryNavigation));
  const [collapsed, setCollapsed] = useState(() => loadSidebarCollapsed());

  const handleNavReorder = (next) => {
    setNavItems(next);
    saveNavOrder(next);
  };

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      saveSidebarCollapsed(next);
      return next;
    });
  };

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  return (
    <div className={`app-shell${collapsed ? " app-shell--sidebar-collapsed" : ""}`}>
      <header className="mobile-header">
        <button
          aria-label="打开导航"
          className="icon-button"
          onClick={() => setMobileOpen(true)}
          type="button"
        >
          <IconMenu2 aria-hidden="true" />
        </button>
        <span className="mobile-header__brand">
          <img alt="" aria-hidden="true" src="/workbench-mark.svg" />
          <span>司南工作台</span>
        </span>
        <button
          aria-label="搜索"
          className="icon-button"
          onClick={onOpenSearch}
          type="button"
        >
          <IconSearch aria-hidden="true" />
        </button>
      </header>

      {mobileOpen ? (
        <button
          aria-label="关闭导航"
          className="sidebar-backdrop"
          onClick={() => setMobileOpen(false)}
          type="button"
        />
      ) : null}

      <aside
        className={`sidebar${mobileOpen ? " sidebar--open" : ""}${collapsed ? " sidebar--collapsed" : ""}`}
      >
        <div className="sidebar__top">
          <div className="sidebar__brand-row">
            <NavLink
              className="sidebar__brand"
              onClick={() => setMobileOpen(false)}
              title={collapsed ? "司南工作台" : undefined}
              to="/"
            >
              <img alt="" aria-hidden="true" src="/workbench-mark.svg" />
              <span>司南工作台</span>
            </NavLink>
            <button
              aria-label={collapsed ? "展开侧栏" : "收缩侧栏"}
              className="icon-button sidebar__collapse"
              onClick={toggleCollapsed}
              title={collapsed ? "展开侧栏" : "收缩侧栏"}
              type="button"
            >
              {collapsed ? (
                <IconChevronRight aria-hidden="true" />
              ) : (
                <IconChevronLeft aria-hidden="true" />
              )}
            </button>
          </div>
          <div className="sidebar__tag">PERSONAL AI WORKBENCH</div>

          <Reorder.Group
            as="nav"
            aria-label="主要导航"
            axis="y"
            className="sidebar__nav"
            values={navItems}
            onReorder={handleNavReorder}
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                  <Reorder.Item
                    as="div"
                    key={item.to}
                    value={item}
                    style={{ position: "relative", zIndex: 1 }}
                  >
                    <NavLink
                      className={({ isActive }) =>
                        `sidebar__nav-item${isActive ? " sidebar__nav-item--active" : ""}`
                      }
                      draggable={false}
                      end={item.end}
                      onClick={() => setMobileOpen(false)}
                      title={collapsed ? item.label : undefined}
                      to={item.to}
                    >
                      <Icon aria-hidden="true" className="sidebar__nav-icon" stroke={1.7} />
                      <span>{item.label}</span>
                    </NavLink>
                  </Reorder.Item>
              );
            })}
          </Reorder.Group>
        </div>

        <div className="sidebar__bottom">
          <div className={`sidebar__sync sidebar__sync--${sync?.status || "connecting"}`}>
            <span aria-hidden="true" />
            <span>{sync?.status === "watching" ? "文件已实时同步" : sync?.status === "rebuilding" || sync?.status === "pending" ? "正在同步文件" : "正在连接文件同步"}</span>
          </div>
          <NavLink
            className="sidebar__settings"
            onClick={() => setMobileOpen(false)}
            title={collapsed ? "系统状态" : undefined}
            to="/system"
          >
            <IconSettings aria-hidden="true" stroke={1.6} />
            <span>系统状态</span>
          </NavLink>
        </div>
      </aside>

      <main className="app-main">{children}</main>

      <button
        aria-label="打开全局搜索"
        className="floating-search"
        onClick={onOpenSearch}
        type="button"
      >
        <IconSearch aria-hidden="true" />
        <span>搜索知识库</span>
        <span className="floating-search__shortcut">
          <IconCommand aria-hidden="true" />K
        </span>
      </button>
    </div>
  );
}
