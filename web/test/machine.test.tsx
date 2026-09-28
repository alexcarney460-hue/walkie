// WALKIE-UI-POLISH-1: the machine page (#/machines/<node-id>) renders a real-fleet-shaped team (two Macs, Claude Code,
// Codex and Kimi agents, pooled accounts, an open ask), and the sidebar's machines link to it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountView, AgentState, AgentView, AskView, NodeView, TeamView } from "../src/api/types.ts";
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

type Mod = {
  MachineDetail: () => ReactNode; Sidebar: (p: { onSearch: () => void }) => ReactNode;
  StaticStore: (p: { state: State; children: ReactNode }) => ReactNode; initialState: State;
  parseHash: typeof import("../src/lib/route.ts").parseHash; hrefFor: typeof import("../src/lib/route.ts").hrefFor;
  goBack: typeof import("../src/lib/route.ts").goBack;
  splitAgents: typeof import("../src/views/machine/MachineDetail.tsx").splitAgents;
  machineAsks: typeof import("../src/views/machine/MachineDetail.tsx").machineAsks;
  transportText: typeof import("../src/views/machine/MachineDetail.tsx").transportText;
};
let mod: Mod;
beforeAll(async () => {
  const [md, sh, st, rd, rt] = await Promise.all([
    import("../src/views/machine/MachineDetail.tsx"), import("../src/components/Shell.tsx"), import("../src/state/store.tsx"),
    import("../src/state/reducer.ts"), import("../src/lib/route.ts"),
  ]);
  mod = {
    MachineDetail: md.MachineDetail, Sidebar: sh.Sidebar, StaticStore: st.StaticStore, initialState: rd.initialState,
    parseHash: rt.parseHash, hrefFor: rt.hrefFor, goBack: rt.goBack, splitAgents: md.splitAgents, machineAsks: md.machineAsks, transportText: md.transportText,
  };
});

const NOW = Date.now();
const MIN = 60_000;
const GiB = 1024 ** 3;
const ALEX = "a1e0000000000001";
const KIRA = "c7e0000000000002";

// The real fleet's shape: alex-mac (this machine, roster authority) and kira-mac over Tailscale, both Apple Silicon.
const NODES: NodeView[] = [
  {
    node_id: ALEX, handle: "alex", hostname: "alex-mac", ip: "100.101.1.2", online: true, last_seen: NOW, rtt_ms: null, self: true, authority: true,
    transports: ["tailscale"], sync: { behind: 0, last_sync: NOW },
    stats: {
      at: NOW - 20_000, temp_c: 71.4, mem: { total: 16 * GiB, used: 13.1 * GiB, swap_used: 4.6 * GiB, pressure: "warn" },
      accel: { chip: "Apple M3", unified: true, gpu_limit: null, gpus: [] },
      sys: { os: "darwin", arch: "arm64", version: "0.2.0-pre.2", cpus: 8, load1: 6.2 },
    },
  },
  {
    node_id: KIRA, handle: "kira", hostname: "kira-mac", ip: "100.101.1.3", online: false, last_seen: NOW - 12 * MIN, rtt_ms: null, self: false,
    via: "tailscale", transports: ["tailscale"], sync: { behind: 3, last_sync: NOW - 12 * MIN },
    stats: { at: NOW - 13 * MIN, temp_c: null, mem: { total: 36 * GiB, used: 20 * GiB, swap_used: 0, pressure: "normal" }, accel: { chip: "Apple M3 Pro", unified: true, gpu_limit: null, gpus: [] } },
  },
];
const TEAM: TeamView = {
  id: "7c1e4a90b25fd318", name: "Acme", authority: ALEX, channels: [], nodes: NODES, plan: undefined as never,
  members: [{ login: "alex@x", handle: "alex", role: "owner", display_name: "Avery Quinn" }, { login: "kira@x", handle: "kira", role: "owner", display_name: "Kira Moore" }],
};
const agent = (node: NodeView, name: string, state: AgentState, runtime: AgentView["status"]["runtime"], title: string, archived = false): AgentView => ({
  id: `${node.handle}/${node.hostname}/${name}`, handle: node.handle, node: node.node_id, hostname: node.hostname, agent: name,
  status: { agent: name, state, runtime, title, started_at: NOW - 40 * MIN }, updated_at: NOW - MIN, machine_online: node.online,
  effective_state: state, archived,
});
const AGENTS = [
  agent(NODES[0]!, "orchestrator", "working", "claude-code", "Merging UI-POLISH-1"),
  agent(NODES[0]!, "codex-audit", "waiting", "codex", "Needs a decision on the fee round"),
  agent(NODES[0]!, "kimi-review", "idle", "kimi", "Reviewed seats r3"),
  agent(NODES[1]!, "builder", "working", "claude-code", "Kira's builder"),
];
const ACCOUNTS: AccountView[] = [{
  key: "alex:a1c0ffee0000000000000001", id: "a1c0ffee0000000000000001", provider: "claude", label: "al***@gm***.com", plan: "Max 20x",
  owners: ["alex"], claimed_by: [], usage_host: "alex-mac", last_seen: NOW,
  machines: [{ node_id: ALEX, hostname: "alex-mac", handle: "alex", online: true, self: true, agents: ["orchestrator"], usage: null }],
  usage: { at: NOW, state: "ok", reason: null, source: "api", until: null, windows: [{ kind: "session", used_pct: 40, resets_at: NOW + 60 * MIN, window_s: null, scope: null }] },
}];
const ASK: AskView = {
  ask: {
    v: 1, team: TEAM.id, id: `${KIRA}:9`, origin: KIRA, seq: 9, ts: NOW - 2 * MIN, author: { handle: "kira", node: KIRA, agent: "builder" },
    kind: "ask", body: { to: "@alex/alex-mac/orchestrator", text: "Ship the glass buttons today?", expires_at: NOW + 30 * MIN }, sig: "x",
  } as AskView["ask"],
  answers: [], state: "open", expires_at: NOW + 30 * MIN,
};

function state(over: Partial<State> = {}): State {
  return {
    ...mod.initialState, phase: "ready", team: TEAM, nodes: NODES, agents: AGENTS, accounts: ACCOUNTS, asks: [ASK],
    archive: [{ node: ALEX, idle: 0, offline: 2 }], me: { handle: "alex", version: "0.2.0-pre.2", team: { id: TEAM.id, name: TEAM.name }, node: { id: ALEX, hostname: "alex-mac", ip: "100.101.1.2", port: 7458 } } as State["me"], ...over,
  };
}
const render = (s: State, el: ReactNode) => renderToStaticMarkup(<mod.StaticStore state={s}>{el}</mod.StaticStore>);

test("route: #/machines/<id> is the machine page and round-trips, with an agent drawer on top", () => {
  expect(mod.parseHash(`#/machines/${ALEX}`)).toEqual({ view: "machine", node: ALEX });
  expect(mod.parseHash(`#/machines/${ALEX}?agent=x`)).toEqual({ view: "machine", node: ALEX, agent: "x" });
  expect(mod.hrefFor({ view: "machine", node: ALEX })).toBe(`#/machines/${ALEX}`);
  expect(mod.parseHash("#/machines")).toEqual({ view: "mission" }); // no id: home
});

test("Back: previous view, ignoring drawers opened and closed on the way; never leaves the dashboard", () => {
  const w = installWindow();
  const back = () => { mod.goBack({ view: "team" }); go(w.location.hash); };
  go("#/team");
  go(`#/machines/${ALEX}`);
  go(`#/machines/${ALEX}?agent=alex%2Falex-mac%2Forchestrator`); // drawer open
  go(`#/machines/${ALEX}`); // Esc
  back();
  expect(w.location.hash).toBe("#/team"); // not the drawer
  // Walk back through several views, then past the start: the fallback, not out of the dashboard.
  go("#/asks");
  go(`#/machines/${KIRA}`);
  back();
  expect(w.location.hash).toBe("#/asks");
  back();
  expect(w.location.hash).toBe("#/team");
});

test("the sidebar's machines link to their machine page, the open one marked current", () => {
  go(`#/machines/${KIRA}`);
  const out = render(state(), <mod.Sidebar onSearch={() => {}} />);
  expect(out).toContain(`href="#/machines/${ALEX}"`);
  expect(out).toMatch(new RegExp(`href="#/machines/${KIRA}" class="rail-machine[^"]*is-active"[^>]*aria-current="page"`));
});

test("machine page: header facts, live stats, agents working first, idle collapsed, accounts, open ask", () => {
  go(`#/machines/${ALEX}`);
  const out = render(state(), <mod.MachineDetail />);
  expect(out).toContain(">alex-mac</h1>");
  expect(out).toContain("Online");
  expect(out).toContain("roster authority");
  expect(out).toContain("this machine");
  expect(out).toContain("Avery Quinn");
  expect(out).toContain("macOS · arm64 · Apple M3");
  expect(out).toContain("0.2.0-pre.2");
  expect(out).toContain("This machine"); // connection
  // Live stats: memory 82 % (pressure elevated), CPU load 6.2 over 8 cores, 71 °C.
  expect(out).toContain('aria-label="Memory 82 % used"');
  expect(out).toContain("pressure elevated");
  expect(out).toContain('aria-label="CPU load 78 % of 8 cores"');
  expect(out).toContain("71.4");
  expect(out).toContain("Unified memory");
  // Agents: the working and waiting ones in the grid; idle kimi-review in the collapsed section with the archive count.
  expect(out).toContain("2 running");
  expect(out.indexOf("Needs a decision on the fee round")).toBeLessThan(out.indexOf("Merging UI-POLISH-1")); // waiting ranks first
  expect(out).toMatch(/<details class="mdx-more"><summary><span>Idle and archived<\/span><span class="seg-n tnum">3<\/span>/);
  expect(out.indexOf("Reviewed seats r3")).toBeGreaterThan(out.indexOf("Idle and archived"));
  expect(out).not.toContain("Kira&#x27;s builder"); // another machine's agent
  expect(out).toContain("Codex");
  expect(out).toContain("Kimi");
  // Accounts used on this machine, and the ask to its orchestrator with an inline answer.
  expect(out).toContain("Accounts on this machine");
  expect(out).toContain("al***@gm***.com");
  expect(out).toContain("Ship the glass buttons today?");
  expect(out).toContain(">Answer</button>");
  expect(out).toContain("What it could run on its own");
});

test("an observer sees the open ask but no answer controls (the daemon would refuse them)", () => {
  go(`#/machines/${ALEX}`);
  const out = render(state({ me: { ...state().me!, role: "observer" } }), <mod.MachineDetail />);
  expect(out).toContain("Ship the glass buttons today?");
  expect(out).not.toContain(">Answer</button>");
});

test("an offline machine: last known values, a status note, and an empty agents state", () => {
  go(`#/machines/${KIRA}`);
  const out = render(state({ agents: AGENTS.filter((a) => a.node !== KIRA) }), <mod.MachineDetail />);
  expect(out).toContain("Offline · last seen 12m ago");
  expect(out).toContain('role="status"');
  expect(out).toContain("kira-mac is offline. Stats and agents are what it last reported");
  expect(out).toContain('class="mg is-stale"');
  expect(out).toContain("kira-mac is offline</p>"); // empty agents state title
  expect(out).toContain("Load not reported (an older Walkie)"); // no stats.sys from this daemon
  expect(out).toContain("Tailscale · 100.101.1.3");
  expect(out).toContain("<dt>System</dt><dd>Apple M3 Pro</dd>"); // chip only: this daemon sends no platform facts
  expect(out).toContain("<dt>Walkie</dt><dd class=\"mono\">not reported</dd>");
});

test("an unknown machine id: a friendly not-found state with a way back", () => {
  go("#/machines/ffffffffffffffff");
  const out = render(state(), <mod.MachineDetail />);
  expect(out).toContain("We can&#x27;t find that machine");
  expect(out).toContain('<h1 class="sr-only">Machine not found</h1>');
  expect(out).toContain('href="#/team"');
});

test("helpers: agent split, asks to or from the machine, transport text", () => {
  const { active, idle } = mod.splitAgents(AGENTS, ALEX);
  expect(active.map((a) => a.agent)).toEqual(["codex-audit", "orchestrator"]);
  expect(idle.map((a) => a.agent)).toEqual(["kimi-review"]);
  expect(mod.machineAsks([ASK], NODES[0]!, NOW)).toHaveLength(1); // addressed to alex-mac's agent
  expect(mod.machineAsks([ASK], NODES[1]!, NOW)).toHaveLength(1); // asked from kira-mac
  expect(mod.machineAsks([{ ...ASK, expires_at: NOW - 1 }], NODES[0]!, NOW)).toHaveLength(0); // expired
  expect(mod.transportText({ ...NODES[1]!, online: true, rtt_ms: 14 })).toBe("Tailscale · 100.101.1.3 · 14 ms");
  expect(mod.transportText({ ...NODES[1]!, via: "direct", transports: ["direct"], rtt_ms: 30 })).toBe("Walkie Direct · 30 ms");
  expect(mod.transportText({ ...NODES[1]!, via: "relay" })).toBe("Relayed through a teammate's machine");
});
