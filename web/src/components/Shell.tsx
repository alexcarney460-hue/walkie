import type { ReactNode } from "react";
import { Armchair, CircleHelp, FileText, FolderKanban, Gauge, LayoutGrid, ListChecks, MessagesSquare, Moon, Newspaper, Plug, Search, Sparkles, Sun, Users } from "lucide-react";
import { canAnswer, machineHue } from "../lib/format.ts";
import { hueVar } from "./primitives.tsx";
import { MachineStatsLine } from "./MachineStats.tsx";
import { planBadgeText, planTone } from "../lib/plan.ts";
import { hrefFor, useRoute, type View } from "../lib/route.ts";
import { toggleTheme, useTheme } from "../lib/theme.ts";
import { useNow } from "../lib/time.ts";
import { unreadCount } from "../state/reducer.ts";
import { useActions, useStore } from "../state/store.tsx";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--surface-3)" stroke="var(--line-strong)" />
      <path d="M6.5 9.5h8" stroke="var(--text)" strokeWidth="2" strokeLinecap="round" />
      <path d="M9.5 14.5h8" stroke="var(--signal)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const NAV: Array<{ view: View; label: string; short: string; key: string; icon: typeof LayoutGrid; tab?: false }> = [
  { view: "mission", label: "Mission Control", short: "Agents", key: "m", icon: LayoutGrid },
  // Every reported project's plain-English status report (UPDATES-1); not a phone tab (six fit): the Projects page links to it there.
  { view: "updates", label: "Updates", short: "Updates", key: "r", icon: Newspaper, tab: false },
  { view: "projects", label: "Projects", short: "Projects", key: "p", icon: FolderKanban },
  // Plain-language board (WALK-75). Not a phone tab: the six tabs stay Agents, Projects, Talkie, Channels, Asks, Team.
  { view: "simple", label: "Simple", short: "Simple", key: "n", icon: ListChecks, tab: false },
  { view: "orchestrator", label: "WalkieTalkie", short: "Talkie", key: "o", icon: Sparkles },
  { view: "board", label: "Channels", short: "Channels", key: "b", icon: MessagesSquare },
  { view: "asks", label: "Asks", short: "Asks", key: "a", icon: CircleHelp },
  // Not in the phone tab bar (six tabs fit: Agents · Projects · Chat · Channels · Asks · Team).
  { view: "artifacts", label: "Artifacts", short: "Files", key: "f", icon: FileText, tab: false },
  { view: "team", label: "Team", short: "Team", key: "t", icon: Users },
  // Not in the phone tab bar (six tabs fit); reachable from the Team page there.
  { view: "integrations", label: "Integrations", short: "Integrations", key: "i", icon: Plug, tab: false },
  // Provider accounts and usage left (ACCOUNTS-1); on phones, the strip on Mission Control links here.
  { view: "accounts", label: "Accounts", short: "Accounts", key: "u", icon: Gauge, tab: false },
  // Remote seats (PROTOCOL §11): agents a teammate starts on a machine whose person allowed it; not a phone tab.
  { view: "seats", label: "Seats", short: "Seats", key: "s", icon: Armchair, tab: false },
];

function useBadges(): Partial<Record<View, { n: number; tone: "signal" | "amber" | "neutral" }>> {
  const s = useStore();
  const now = useNow();
  const unread = (s.team?.channels ?? []).reduce((acc, c) => acc + unreadCount(s, c.name), 0);
  const myAsks = s.asks.filter((a) => canAnswer(a, s.me?.handle ?? null, s.agents, now)).length;
  return {
    board: unread ? { n: unread, tone: "neutral" } : undefined,
    asks: myAsks ? { n: myAsks, tone: "amber" } : undefined,
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
  if (!plan) return null;
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
          <span className="rail-team truncate">{me?.team?.name ?? "Walkie"}</span>
          <span className="rail-me mono truncate">{me?.handle ?? "?"} · {me?.node.hostname}</span>
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
          const active = route.view === item.view;
          const badge = badges[item.view];
          return (
            <a key={item.view} href={hrefFor({ view: item.view })} className={["rail-link", item.view === "simple" ? "simple-nav" : "", active ? "is-active" : ""].filter(Boolean).join(" ")} aria-current={active ? "page" : undefined}>
              <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="rail-link-label">{item.label}</span>
              {badge ? (
                <span className={`badge badge-${badge.tone} tnum`} aria-label={`${badge.n} pending`}>{badge.n}</span>
              ) : (
                <span className="rail-hint" aria-hidden="true"><kbd>g</kbd><kbd>{item.key}</kbd></span>
              )}
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
  const route = useRoute();
  const { me } = useStore();
  return (
    <header className="mobilebar">
      <Logo size={20} />
      <span className="mobilebar-team truncate">{me?.team?.name ?? "Walkie"}</span>
      <a href={hrefFor({ view: "simple" })} className="mobile-simple" aria-current={route.view === "simple" ? "page" : undefined}>Simple</a>
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
      {NAV.filter((item) => item.tab !== false).map((item) => {
        const Icon = item.icon;
        const active = route.view === item.view;
        const badge = badges[item.view];
        return (
          <a key={item.view} href={hrefFor({ view: item.view })} className={active ? "tab is-active" : "tab"} aria-current={active ? "page" : undefined}>
            <span className="tab-icon">
              <Icon size={19} strokeWidth={1.75} aria-hidden="true" />
              {badge && <span className={`tab-badge badge-${badge.tone}`} aria-label={`${badge.n} pending`} />}
            </span>
            <span className="tab-label">{item.short}</span>
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
