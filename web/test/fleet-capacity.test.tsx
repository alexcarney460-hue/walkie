// WALK-65: Mission Control, the Team machines list and the machine page show each machine's free capacity.
// Seats load through a provider in tests so a render that has not loaded them (the existing SSR tests) shows nothing.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountView, AgentView, NodeView, SeatsView, TeamView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { go, installWindow } from "./window-stub.ts";

const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
const inert: unknown = new Proxy(() => inert, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : inert), apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

const GIB = 1024 ** 3;
const NOW = Date.now();
const NODE = "n1n1n1n1n1n1n1n1";

let mod: {
  FleetCapacityBadge: typeof import("../src/components/FleetCapacity.tsx").FleetCapacityBadge;
  SeatSnapshotProvider: typeof import("../src/components/FleetCapacity.tsx").SeatSnapshotProvider;
  capacityForMachine: typeof import("../src/components/FleetCapacity.tsx").capacityForMachine;
  MissionControl: () => ReactNode;
  Team: () => ReactNode;
  MachineDetail: () => ReactNode;
  StaticStore: (p: { state: State; children: ReactNode }) => ReactNode;
  initialState: State;
};
beforeAll(async () => {
  const [cap, mc, team, machine, st, rd] = await Promise.all([
    import("../src/components/FleetCapacity.tsx"),
    import("../src/views/mission/MissionControl.tsx"),
    import("../src/views/Team.tsx"),
    import("../src/views/machine/MachineDetail.tsx"),
    import("../src/state/store.tsx"),
    import("../src/state/reducer.ts"),
  ]);
  mod = {
    FleetCapacityBadge: cap.FleetCapacityBadge, SeatSnapshotProvider: cap.SeatSnapshotProvider, capacityForMachine: cap.capacityForMachine,
    MissionControl: mc.MissionControl, Team: team.Team, MachineDetail: machine.MachineDetail,
    StaticStore: st.StaticStore, initialState: rd.initialState,
  };
});

function machine(over: Partial<NodeView> = {}): NodeView {
  return {
    node_id: NODE, handle: "maren", hostname: "harbor-1", ip: "100.64.0.8", online: true, last_seen: NOW, rtt_ms: 4, self: true,
    sync: { behind: 0, last_sync: NOW },
    stats: {
      at: NOW, temp_c: null,
      mem: { total: 16 * GIB, used: 4 * GIB, free: 8 * GIB, swap_used: 0, pressure: "normal" },
      sys: { os: "linux", arch: "x64", cpus: 8, load1: 0.4, cpu_busy_pct: 10 },
    },
    ...over,
  };
}

function seats(over: { allows?: boolean; max?: number | null; running?: number; member?: boolean } = {}): SeatsView {
  const max = over.max === undefined ? 2 : over.max;
  const member = over.member !== false;
  return {
    local: { allow: true } as SeatsView["local"],
    hosts: [{
      node: NODE, hostname: "harbor-1", handle: "maren", self: true, allows: over.allows ?? true, member,
      channel: `seats-${NODE}`, online: true,
      // A non-member is not sent the cap. An unknown cap (member, max null) omits it too.
      ...(max === null || !member ? {} : { availability: { state: "available", max } }),
    }],
    seats: Array.from({ length: over.running ?? 0 }, (_, i) => ({
      id: `seat-${i}`, host: { node: NODE, hostname: "harbor-1", handle: "maren" }, state: "running" as const,
    })) as unknown as SeatsView["seats"],
  };
}

function account(used = 10): AccountView {
  const at = NOW - 5 * 60_000;
  return {
    key: "maren:aaaaaaaaaaaaaaaaaaaaaaaa", id: "aaaaaaaaaaaaaaaaaaaaaaaa", provider: "claude", label: "Claude account", plan: null,
    owners: ["maren"], claimed_by: [],
    machines: [{ node_id: NODE, hostname: "harbor-1", handle: "maren", online: true, self: true, agents: [], usage: null }],
    usage: { at, state: "ok", reason: null, source: "api", until: null, windows: [{ kind: "session", used_pct: used, resets_at: at + 3_600_000, window_s: null, scope: null }] },
    usage_host: "harbor-1", last_seen: at,
  };
}

const TEAM: TeamView = {
  id: "t", name: "harbor", authority: NODE, channels: [], nodes: [], plan: undefined as never,
  members: [{ login: "maren@example", handle: "maren", role: "owner", display_name: "Maren Holt" }],
};

/** Mission Control lists a machine only once an agent on it is live. Working is never archived. */
function agent(): AgentView {
  return {
    id: "maren/harbor-1/seat-1", handle: "maren", node: NODE, hostname: "harbor-1", agent: "seat-1",
    status: { agent: "seat-1", state: "working", runtime: "claude-code", title: "seat-1 title" },
    updated_at: NOW, machine_online: true, effective_state: "working", archived: false,
  };
}

function state(over: Partial<State> = {}): State {
  const nodes = over.nodes ?? [machine()];
  return {
    ...mod.initialState, phase: "ready", team: { ...TEAM, nodes }, nodes, accounts: [account()], agents: [agent()],
    me: { handle: "maren", role: "owner", transport: { mode: "direct" }, tailscale: { ok: false } } as State["me"], ...over,
  };
}

function badge(node: NodeView, view: SeatsView | null, accounts: AccountView[] = [account()]): string {
  return renderToStaticMarkup(<mod.FleetCapacityBadge node={node} accounts={accounts} seats={view} now={NOW} />);
}

function page(el: ReactNode, view: SeatsView | null): string {
  const body = view ? <mod.SeatSnapshotProvider seats={view}>{el}</mod.SeatSnapshotProvider> : el;
  return renderToStaticMarkup(<mod.StaticStore state={state()}>{body}</mod.StaticStore>);
}

test("the badge names free seats, the limit and the score for each factor", () => {
  const open = badge(machine(), seats());
  expect(open).toContain('data-testid="capacity-harbor-1"');
  expect(open).toContain("2 free");
  expect(open).toContain(">100<");
  expect(open).toContain('class="cap-badge is-open"');
  expect(open).toContain("score 100 of 100");
  expect(open).toContain("2 free seats");
  expect(open).toContain("limited by seats");
  expect(badge(machine({ online: false }), seats())).toContain("Offline");
  expect(badge(machine({ online: false }), seats())).toContain("is-offline");
  const hot = machine({ stats: { at: NOW, temp_c: null, mem: { total: 16 * GIB, used: 4 * GIB, free: 8 * GIB, swap_used: 0, pressure: "normal" }, sys: { os: "linux", arch: "x64", cpus: 8, load1: 1, cpu_busy_pct: 92 } } });
  expect(badge(hot, seats())).toContain("Limited by CPU");
  expect(badge(hot, seats())).toContain("is-blocked");
  const tight = machine({ stats: { at: NOW, temp_c: null, mem: { total: 16 * GIB, used: 15 * GIB, free: GIB, swap_used: 0, pressure: "normal" }, sys: { os: "linux", arch: "x64", cpus: 8, load1: 0.2, cpu_busy_pct: 5 } } });
  expect(badge(tight, seats())).toContain("Limited by memory");
  const unknown = machine({ stats: { at: NOW, temp_c: null, mem: { total: 16 * GIB, used: 4 * GIB, free: 8 * GIB, swap_used: 0, pressure: "normal" }, sys: { os: "linux", arch: "x64", cpus: 8, load1: 0.2, cpu_busy_pct: 5 }, discovery: { incomplete: true, unreported: 0, stale: true } } });
  expect(badge(unknown, seats())).toContain("Load unknown");
  expect(badge(machine(), seats(), [account(95)])).toContain("Limited by accounts");
  expect(badge(machine(), seats({ max: null }))).toContain("Limited by seats");
  expect(badge(machine(), seats({ max: null }))).not.toContain("2 free");
  expect(badge(machine(), null)).toBe("");
});

test("Mission Control, Team and the machine page show the score once seats are loaded, and not before", () => {
  go("#/mission");
  expect(page(<mod.MissionControl />, null)).not.toContain("capacity-harbor-1");
  const mission = page(<mod.MissionControl />, seats());
  expect(mission).toContain('data-testid="capacity-harbor-1"');
  expect(mission).toContain("2 free");
  go("#/team");
  const team = page(<mod.Team />, seats());
  expect(team).toContain('data-testid="capacity-harbor-1"');
  expect(team).toContain("2 free");
  go(`#/machines/${NODE}`);
  const detail = page(<mod.MachineDetail />, seats());
  expect(detail).toContain('data-testid="capacity-harbor-1"');
  expect(detail).toContain("2 free");
  expect(detail).toContain("score 100 of 100");
});

test("the badge names itself, and a viewer outside the seats channel does not see a free-seat count", () => {
  const hidden = badge(machine(), seats({ member: false }));
  expect(hidden).toContain("Seats hidden");
  expect(hidden).toContain("is-muted");
  expect(hidden).not.toContain("is-blocked");
  expect(hidden).not.toContain("Limited by seats");
  expect(hidden).not.toContain(">0<");
  expect(hidden).toContain('role="img"');
  expect(hidden).toContain("seats hidden");
  expect(hidden).not.toContain("0 free");
  // A member whose cap is really full still sees the zero.
  const full = badge(machine(), seats({ running: 2 }));
  expect(full).toContain("Limited by seats");
  expect(full).not.toContain("Seats hidden");
  expect(full).toContain(">0<");
  const hot = machine({ stats: { at: NOW, temp_c: null, mem: { total: 16 * GIB, used: 4 * GIB, free: 8 * GIB, swap_used: 0, pressure: "normal" }, sys: { os: "linux", arch: "x64", cpus: 8, load1: 1, cpu_busy_pct: 92 } } });
  const hotHidden = badge(hot, seats({ member: false }));
  expect(hotHidden).toContain("Limited by CPU");
  expect(hotHidden).toContain("seats hidden");
  expect(hotHidden).not.toContain("0 free");
  expect(hotHidden).not.toContain("free seats");
  const noHost = badge(machine(), { ...seats(), hosts: [] });
  expect(noHost).toContain("Limited by seats");
  expect(noHost).not.toContain("Seats hidden");
  const open = badge(machine(), seats());
  expect(open).toContain('role="img"');
  expect(open).toContain('aria-label="harbor-1: score 100 of 100, 2 free seats, limited by seats"');
});

test("the same function the summary uses is what the badge renders", () => {
  const node = machine();
  const view = seats();
  const accounts = [account()];
  expect(mod.capacityForMachine(node, accounts, view, NOW)).toEqual({ free_slots: 2, limiting_factor: "seats", score: 100 });
  expect(mod.capacityForMachine(machine({ online: false }), accounts, view, NOW).limiting_factor).toBe("offline");
});

/** Text inside every `@media (max-width: 860px)` block. 860px is the dashboard's phone width, so it covers 390px. */
function phoneRules(src: string): string {
  const needle = "@media (max-width: 860px)";
  const out: string[] = [];
  for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
    const open = src.indexOf("{", at);
    let depth = 1;
    let i = open + 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    out.push(src.slice(open + 1, i - 1));
  }
  return out.join("\n");
}

test("the badge uses theme tokens and wraps at the phone width, which covers 390px", () => {
  const css = readFileSync(new URL("../src/styles/mission.css", import.meta.url), "utf8");
  const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const phone = phoneRules(css);
  expect(css).toContain("@media (max-width: 860px)");
  expect(860).toBeGreaterThanOrEqual(390);
  expect(phone).toMatch(/\.cap-badge\s*\{[^}]*white-space:\s*normal/);
  expect(phone).toMatch(/\.machine-head \.cap-badge\s*\{[^}]*flex:\s*1 1 auto/);
  const rules = [...css.matchAll(/[^{}]*\.cap-[\w-]+[^{]*\{[^}]*\}/g)].map((m) => m[0]).join("\n");
  expect(rules).toContain("var(--surface-2)");
  expect(rules).toContain("var(--signal)");
  expect(rules).toContain("var(--signal-strong)");
  expect(rules).toContain("var(--amber)");
  // 11px text on the 14% tint. --signal-strong clears 4.5:1 in both themes. Amber has no stronger token:
  // 80% amber mixed with --text darkens it on the light theme and lightens it on the dark one.
  expect(rules).toContain("color-mix(in oklch, var(--amber) 80%, var(--text))");
  const muted = rules.match(/\.cap-badge\.is-muted\s*\{[^}]*\}/)?.[0] ?? "";
  expect(muted).toContain("var(--text-2)");
  expect(muted).toContain("var(--surface-2)");
  expect(muted).not.toContain("amber");
  expect(rules).toContain("var(--text-2)");
  expect(rules).toContain("var(--line)");
  expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  // `white-space` is the wrap property the phone rule requires, not a paint color.
  expect(rules.replaceAll("white-space", "")).not.toMatch(/\b(?:white|black)\b/);
  expect(rules).toContain("max-width: 100%");
  expect(rules).toContain("overflow-wrap: anywhere");
  // Dark, the light colour scheme, and an explicit light theme each define the tokens the badge paints with.
  expect(tokens.match(/--surface-2:/g)?.length).toBeGreaterThanOrEqual(3);
  expect(tokens.match(/--signal:/g)?.length).toBeGreaterThanOrEqual(3);
  expect(tokens.match(/--amber:/g)?.length).toBeGreaterThanOrEqual(3);
  expect(tokens).toContain("prefers-color-scheme: light");
  expect(tokens).toContain('data-theme="light"');
});

test("Team and the live Mission Control list tick on a 30 second clock", () => {
  const team = readFileSync(new URL("../src/views/Team.tsx", import.meta.url), "utf8");
  expect(team).toContain("useCoarseNow(");
  expect(team).not.toMatch(/useNow\(/);
  const mission = readFileSync(new URL("../src/views/mission/MissionControl.tsx", import.meta.url), "utf8");
  const liveStart = mission.indexOf("function LiveView");
  const liveEnd = mission.indexOf("function MissionExtras");
  expect(liveStart).toBeGreaterThan(0);
  expect(liveEnd).toBeGreaterThan(liveStart);
  const live = mission.slice(liveStart, liveEnd);
  expect(live).toContain("useCoarseNow(");
  expect(live).not.toMatch(/useNow\(/);
  // The lag banner on the same page still reads the one-second clock.
  expect(mission).toMatch(/useNow\(/);
});
