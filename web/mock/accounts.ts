// Fictional provider accounts for the mock daemon (ACCOUNTS-1): every state a tile can show — live meters in each
// colour band, a model-scoped weekly bar, an account pooled across two machines, stale, exhausted with a reset time,
// needs re-login, and unknown. Masked labels only, as the real daemon shares them.
import type { AccountUsage, AccountView, AccountWindow, ResetClock, ResetResult } from "../../src/protocol/accounts.ts";
import { clockFromReading } from "../../src/accounts/clock.ts";
import type { World } from "./world.ts";

const MIN = 60_000;
const H = 60 * MIN;

interface Seed {
  id: string; provider: AccountView["provider"]; label: string; plan: string | null;
  on: Array<[host: string, agents: string[]]>;
  usage: (now: number) => AccountUsage | null;
  /** RESET-CLOCK-1: remembered reset times (default: the reading's own). */
  clock?: (now: number) => ResetClock[];
}

const rc = (kind: ResetClock["kind"], resetsIn: number | null, observedAgo: number, now: number, exhausted = false): ResetClock => ({
  kind, scope: null, window_s: kind === "session" ? 5 * 3600 : 7 * 86_400, resets_at: resetsIn === null ? null : now + resetsIn,
  observed_at: now - observedAgo, exhausted, source: "api",
});

const w = (kind: AccountWindow["kind"], used: number, resetsIn: number | null, now: number, scope: string | null = null): AccountWindow => ({
  kind, used_pct: used, resets_at: resetsIn === null ? null : now + resetsIn, scope,
  window_s: kind === "session" ? 5 * 3600 : kind === "other" ? null : 7 * 86_400,
});
const ok = (now: number, windows: AccountWindow[], ago = 40_000, source: AccountUsage["source"] = "api"): AccountUsage =>
  ({ at: now - ago, state: "ok", reason: null, source, windows, until: null });

const SEEDS: Seed[] = [
  {
    id: "a1c0ffee0000000000000001", provider: "claude", label: "ma***@ke***.example", plan: "Max 20x",
    on: [["maren-mbp", ["ux-seat"]], ["atlas", ["api-seat"]]],
    usage: (now) => ok(now, [w("session", 38, 2 * H + 45 * MIN, now), w("weekly", 71, 3 * 24 * H + 4 * H, now), w("weekly_model", 82, 3 * 24 * H + 4 * H, now, "Opus")]),
  },
  {
    id: "a1c0ffee0000000000000002", provider: "codex", label: "ma***@ke***.example", plan: "Pro",
    on: [["maren-mbp", ["review"]], ["atlas", ["migrator"]]],
    usage: (now) => ({ ...ok(now, [w("weekly", 13, 6 * 24 * H + 22 * H, now)], 90_000), resets: { available: 2, applicable: 1 } }),
  },
  {
    id: "a1c0ffee0000000000000003", provider: "claude", label: "to***@ke***.example", plan: "Pro",
    on: [["tobias-mbp", ["infra", "docs"]]],
    usage: (now) => ok(now, [w("session", 93, 58 * MIN, now), w("weekly", 55, 4 * 24 * H, now)]),
  },
  {
    id: "a1c0ffee0000000000000004", provider: "kimi", label: "to***@ke***.example", plan: null,
    on: [["tobias-mbp", ["triage"]]],
    usage: (now) => ok(now, [w("session", 10, 3 * H + 12 * MIN, now), w("weekly", 6, 5 * 24 * H + 8 * H, now)], 3 * MIN),
  },
  {
    id: "a1c0ffee0000000000000005", provider: "claude", label: "in***@ke***.example", plan: "Max 5x",
    on: [["ines-studio", ["design-sys"]]],
    usage: (now) => ({ at: now - 50_000, state: "exhausted", reason: "limit_reached", source: "api", until: now + H + 12 * MIN, windows: [w("session", 100, H + 12 * MIN, now), w("weekly", 64, 2 * 24 * H, now)] }),
  },
  {
    id: "a1c0ffee0000000000000006", provider: "codex", label: "in***@ke***.example", plan: "Plus",
    on: [["ines-studio", ["copy"]]],
    usage: (now) => ({ ...ok(now, [w("session", 40, 3 * H, now), w("weekly", 22, 5 * 24 * H, now)], 25 * MIN, "session"), resets: { available: 1, applicable: 1 } }),
  },
  {
    id: "a1c0ffee0000000000000007", provider: "codex", label: "so***@ke***.example", plan: "Plus",
    on: [["sol-x1", ["perf"]]],
    usage: (now) => ({ at: now - 2 * MIN, state: "relogin", reason: "login_expired", source: "none", windows: [], until: null }),
  },
  {
    id: "a1c0ffee0000000000000008", provider: "claude", label: "so***@ke***.example", plan: "Pro",
    on: [["sol-x1", ["scratch"]]],
    usage: (now) => ({ at: now - 4 * MIN, state: "unknown", reason: "keychain_unavailable", source: "none", windows: [], until: null }),
    // RESET-CLOCK-1: no reading now, but the reset times from its last one keep counting down.
    clock: (now) => [rc("session", 2 * H + 14 * MIN, 3 * H, now), rc("weekly", 3 * 24 * H + 4 * H, 3 * H, now)],
  },
  {
    // RESET-CLOCK-1: the 5-hour limit was hit 13 h ago and reset 12 h ago; no reading since (its login moved).
    id: "a1c0ffee000000000000000a", provider: "claude", label: "ma***@ke***.example", plan: "Max 5x",
    on: [["maren-mbp", []]],
    usage: (now) => ({ at: now - 13 * H, state: "exhausted", reason: "limit_reached", source: "api", until: now - 12 * H, windows: [w("session", 100, -12 * H, now), w("weekly", 95, 5 * 24 * H + 10 * H, now)] }),
    clock: (now) => [rc("session", -12 * H, 13 * H, now, true), rc("weekly", 5 * 24 * H + 10 * H, 13 * H, now)],
  },
  {
    id: "a1c0ffee0000000000000009", provider: "grok", label: "ma***@ke***.example", plan: null,
    on: [["atlas", []]],
    usage: (now) => ({ at: now - MIN, state: "unknown", reason: "no_usage_api", source: "none", windows: [], until: null }),
  },
];

/** Seeds the accounts (after the machines exist). */
export function seedAccounts(world: World): void {
  const now = Date.now();
  for (const s of SEEDS) {
    const usage = s.usage(now);
    const machines = s.on.map(([host, agents]) => {
      const n = world.node(host);
      return { node_id: n.node_id, hostname: host, handle: n.handle, online: true, self: host === world.meNodeHost, agents, usage };
    });
    const clock = s.clock ? s.clock(now) : clockFromReading(usage);
    const owner = machines[0]?.handle ?? "?";
    world.accounts.push({
      key: `${owner}:${s.id}`, id: s.id, provider: s.provider, label: s.label, plan: s.plan, owners: [owner], claimed_by: [],
      machines, usage, usage_host: usage ? s.on[0]![0] : null, last_seen: now, ...(clock.length ? { clock } : {}),
    });
  }
}

/** Usage creeps up on the accounts in use (the meters fall), as polling would show it. */
export function driftAccounts(world: World, tick: number): void {
  const now = Date.now();
  world.accounts = world.accounts.map((a) => {
    const u = a.usage;
    if (!u || u.state !== "ok" || u.source !== "api" || !a.machines.some((m) => m.agents.length)) return a;
    const step = 0.2 + ((tick + a.id.charCodeAt(23)) % 3) * 0.2;
    const windows = u.windows.map((x) => ({ ...x, used_pct: Math.min(99, Math.round((x.used_pct + (x.kind === "session" ? step : step / 4)) * 10) / 10) }));
    const next = { ...u, at: now - 20_000, windows };
    return { ...a, usage: next, clock: clockFromReading(next), machines: a.machines.map((m) => ({ ...m, usage: next })) };
  });
}

// ---- limit resets (ACCOUNTS-RESET-1) ---------------------------------------------------------------------------

/** Attempts the mock minted (prepare), their answers once used, and how many resets were really used per account. */
const prepared = new Map<string, string>();
const attempts = new Map<string, { account: string; result: ResetResult }>();
export const resetUses = new Map<string, number>();

/** POST /v1/accounts/reset/prepare on the mock: an attempt id per account until it is used. */
export function mockPrepareReset(world: World, account: string): { status: number; body: unknown } {
  const a = world.accounts.find((x) => x.id === account && x.machines.some((m) => m.self));
  if (!a) return { status: 404, body: { error: { code: "not_found", message: "that account's login is not on this machine" } } };
  if (a.provider !== "codex") return { status: 409, body: { error: { code: "not_supported", message: "this provider's resets are used on its own page, not through Walkie" } } };
  const open = [...prepared.entries()].find(([id, acc]) => acc === account && !attempts.has(id));
  const id = open?.[0] ?? crypto.randomUUID();
  prepared.set(id, account);
  return { status: 200, body: { attempt: { id, account, earlier: null } } };
}

/** POST /v1/accounts/reset on the mock: this machine's Codex accounts only; the same request id never uses two. */
export function mockUseReset(world: World, account: string, requestId: string): { status: number; body: unknown } {
  if (prepared.get(requestId) !== account && !attempts.has(requestId)) return { status: 409, body: { error: { code: "unknown_attempt", message: "no such reset attempt here; open the sheet again" } } };
  const prior = attempts.get(requestId);
  if (prior) return prior.account === account ? { status: 200, body: { result: prior.result } } : { status: 409, body: { error: { code: "request_reused", message: "that request id belongs to another account" } } };
  const a = world.accounts.find((x) => x.id === account && x.machines.some((m) => m.self));
  if (!a) return { status: 404, body: { error: { code: "not_found", message: "that account's login is not on this machine; use a reset from the dashboard of the machine that holds it" } } };
  if (a.provider !== "codex") return { status: 409, body: { error: { code: "not_supported", message: "this provider's resets are used on its own page, not through Walkie" } } };
  const left = a.usage?.resets?.available ?? 0;
  const result: ResetResult = left > 0 ? { outcome: "reset", left: left - 1 } : { outcome: "none", left: 0 };
  attempts.set(requestId, { account, result });
  if (result.outcome === "reset") {
    resetUses.set(account, (resetUses.get(account) ?? 0) + 1);
    const now = Date.now();
    world.accounts = world.accounts.map((x) => {
      if (x.id !== account || !x.usage) return x;
      const usage: AccountUsage = { ...x.usage, at: now, windows: x.usage.windows.map((win) => ({ ...win, used_pct: 0 })), resets: { available: left - 1, applicable: null } };
      return { ...x, usage, machines: x.machines.map((m) => ({ ...m, usage })) };
    });
    world.broadcast({ type: "accounts", accounts: world.accountViews() });
  }
  return { status: 200, body: { result } };
}

/** POST /v1/accounts/refresh on the mock: a fresh reading time for this machine's account. */
export function mockRefresh(world: World, account: string): { status: number; body: unknown } {
  const a = world.accounts.find((x) => x.id === account && x.machines.some((m) => m.self));
  if (!a) return { status: 404, body: { error: { code: "not_found", message: "that account's login is not on this machine" } } };
  const now = Date.now();
  world.accounts = world.accounts.map((x) => (x.id === account && x.usage ? { ...x, usage: { ...x.usage, at: now }, machines: x.machines.map((m) => ({ ...m, usage: m.usage ? { ...m.usage, at: now } : m.usage })) } : x));
  world.broadcast({ type: "accounts", accounts: world.accountViews() });
  return { status: 200, body: { scheduled: true, held: false } };
}
