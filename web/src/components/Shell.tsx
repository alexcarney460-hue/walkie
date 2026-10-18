import type { ReactNode } from "react";
import { FolderKanban, House, MessagesSquare, Moon, Search, Settings, Sparkles, Sun } from "lucide-react";
import { machineHue } from "../lib/format.ts";
import { planBadgeText, planTone } from "../lib/plan.ts";
import { hrefFor, useRoute, type View } from "../lib/route.ts";
import { toggleTheme, useTheme } from "../lib/theme.ts";
import { useNow } from "../lib/time.ts";
import { unreadCount } from "../state/reducer.ts";
import { useActions, useStore } from "../state/store.tsx";
import { useHomeNeeds } from "../views/home/needs.tsx";
import { settingsWarning } from "../views/settings/model.ts";
import { MachineStatsLine } from "./MachineStats.tsx";
import { hueVar } from "./primitives.tsx";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--surface-3)" stroke="var(--line-strong)" />
      <path d="M6.5 9.5h8" stroke="var(--text)" strokeWidth="2" strokeLinecap="round" />
      <path d="M9.5 14.5h8" stroke="var(--signal)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export const NAV: Array<{ view: View; label: string; key: string; icon: typeof House }> = [
  { view: "home", label: "Home", key: "h", icon: House },
  { view: "projects", label: "Projects", key: "p", icon: FolderKanban },
  { view: "orchestrator", label: "Talkie", key: "o", icon: Sparkles },
  { view: "board", label: "Channels", key: "b", icon: MessagesSquare },
  { view: "settings", label: "Settings", key: "s", icon: Settings },
];

export function primaryView(view: View): View {
  if (view === "asks" || view === "home" || view === "agents" || view === "mission" || view === "machine") return "home";
  if (view === "projects" || view === "orchestrator" || view === "board") return view;
  return "settings";
}

function useBadges(): Partial<Record<View, { n: number; tone: "signal" | "amber" | "neutral" }>> {
  const s = useStore();
  const now = useNow();
  const { count, pending } = useHomeNeeds();
  const unread = (s.team?.channels ?? []).reduce((acc, c) => acc + unreadCount(s, c.name), 0);
  let warning = false;
  try { warning = settingsWarning(s, now, pending.length); } catch { warning = false; }
  return {
    board: unread ? { n: unread, tone: "neutral" } : undefined,
    home: count ? { n: count, tone: "amber" } : undefined,
    settings: warning ? { n: 1, tone: "amber" } : undefined,
  };
}

export function ConnectionIndicator({ compact }: { compact?: boolean }) {
  const { conn } = useStore();
  const { reconnectNow } = useActions();
  const now = useNow();
  if (conn.status === "live") {
    return (
      <span className="conn conn-live" role="status" title="Live: receiving updates from the daemon (a silent stream is replaced within 35 s)">
        <span className="conn-dot" aria-hidden="true" />
        {compact ? <span className="sr-only">Live</span> : "Live"}
      </span>
    );
  }
  if (conn.status === "connecting") {
    return (
      <span className="conn conn-wait" role="status">
        <span className="conn-dot" aria-hidden="true" />
        {compact ? <span className="sr-only">Connecting</span> : "Connecting"}
      </span>
    );
  }
  const left = conn.retryAt ? Math.max(0, conn.retryAt - now) : 0;
  const why = conn.reason === "stalled" ? "No data from the daemon for over 35 s" : conn.reason === "gap" ? "An update was missed; reloading the roster" : "Stream disconnected";
  return (
    <button type="button" className="conn conn-down" role="status" onClick={reconnectNow} title={`${why}. Click to retry now.`} data-reason={conn.reason ?? ""}>
      <span className="conn-dot" aria-hidden="true" />
      {compact ? <span className="sr-only">Reconnecting</span> : <span className="tnum">Reconnecting{left > 0 ? ` in ${Math.ceil(left / 1000)}s` : "…"}</span>}
    </button>
  );
}

function ThemeButton() {
  const { effective } = useTheme();
  const next = effective === "dark" ? "light" : "dark";
  return (
    <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={toggleTheme} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
      {effective === "dark" ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />}
    </button>
  );
}

function MachinesMini() {
  const { nodes } = useStore();
  const route = useRoute();
  if (!nodes.length) return null;
  const online = nodes.filter((n) => n.online).length;
  return (
    <div className="rail-machines">
      <div className="rail-label">
        <span>Machines</span>
        <span className="tnum">{online}/{nodes.length}</span>
      </div>
      <ul>
        {nodes.map((n) => {
          const active = route.view === "machine" && route.node === n.node_id;
          return (
            <li key={n.node_id}>
              {/* Opens the machine page: its stats, agents, accounts and asks. */}
              <a href={hrefFor({ view: "machine", node: n.node_id })} className={`rail-machine has-stats${n.online ? "" : " is-off"}${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined} aria-label={`${n.hostname}, ${n.online ? "online" : "offline"}: open machine details`}
                style={hueVar("--mh", machineHue(n.hostname))}>
                <span className={`dot ${n.online ? "dot-on" : "dot-off"}`} aria-hidden="true" />
                <span className="mono truncate">{n.hostname}</span>
                <span className="tnum muted rail-rtt">{n.self ? "this" : n.online && n.rtt_ms !== null ? `${n.rtt_ms} ms` : "off"}</span>
                <MachineStatsLine node={n} />
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The team's plan ("Team trial · 9 days left"); opens the Billing panel on the Team page. */
export function PlanBadge() {
  const { team, me } = useStore();
  const plan = team?.plan ?? me?.plan ?? null;
  if (!plan || planTone(plan) !== "amber") return null;
  return (
    <a className={`plan-badge plan-badge-${planTone(plan)}`} href={hrefFor({ view: "team", tab: "billing" })} title="Plan and billing">
      <span className="plan-badge-dot" aria-hidden="true" />
      <span className="truncate">{planBadgeText(plan)}</span>
      <span className="sr-only"> (open billing)</span>
    </a>
  );
}

export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const route = useRoute();
  const { me } = useStore();
  const badges = useBadges();
  return (
    <aside className="rail" aria-label="Primary">
      <div className="rail-brand">
        <Logo />
        <div className="rail-brand-text">
          <span className="rail-team truncate">{me?.team?.name ?? "Sqwakie"}</span>
          <span className="rail-me mono truncate" title={me?.node.hostname}>{me?.handle ?? "?"}</span>
        </div>
      </div>
      <button type="button" className="rail-search" onClick={onSearch}>
        <Search size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>Jump to…</span>
        <span className="rail-kbd"><kbd>⌘</kbd><kbd>K</kbd></span>
      </button>
      <nav className="rail-nav">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = primaryView(route.view) === item.view;
          const badge = badges[item.view];
          return (
            <a key={item.view} href={hrefFor({ view: item.view })} className={`rail-link${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined}>
              <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="rail-link-label">{item.label}</span>
              {badge && item.view !== "settings" ? (
                <span className={`badge badge-${badge.tone} tnum`}>{badge.n}<span className="sr-only"> pending</span></span>
              ) : badge ? <><span className="nav-warning-dot" aria-hidden="true" /><span className="sr-only">Settings need attention</span></> : null}
            </a>
          );
        })}
      </nav>
      <MachinesMini />
      <PlanBadge />
      <div className="rail-foot">
        <ConnectionIndicator />
        <ThemeButton />
      </div>
    </aside>
  );
}

export function MobileBar({ onSearch }: { onSearch: () => void }) {
  const { me } = useStore();
  return (
    <header className="mobilebar">
      <Logo size={20} />
      <span className="mobilebar-team truncate">{me?.team?.name ?? "Sqwakie"}</span>
      <ConnectionIndicator compact />
      <span className="mobilebar-spacer" />
      <ThemeButton />
      <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onSearch} aria-label="Search and jump">
        <Search size={16} strokeWidth={1.75} />
      </button>
    </header>
  );
}

export function TabBar() {
  const route = useRoute();
  const badges = useBadges();
  return (
    <nav className="tabbar" aria-label="Primary">
      {NAV.map((item) => {
        const Icon = item.icon;
        const active = primaryView(route.view) === item.view;
        const badge = badges[item.view];
        return (
          <a key={item.view} href={hrefFor({ view: item.view })} className={active ? "tab is-active" : "tab"} aria-current={active ? "page" : undefined}>
            <span className="tab-icon">
              <Icon size={19} strokeWidth={1.75} aria-hidden="true" />
              {badge && <><span className={`tab-badge badge-${badge.tone}`} aria-hidden="true" />
                <span className="sr-only">{item.view === "settings" ? "Settings need attention" : `${badge.n} pending`}</span></>}
            </span>
            <span className="tab-label">{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

export function PageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1 className="page-title">{title}</h1>
        {meta && <p className="page-meta">{meta}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
