// The fleet-wide accounts picture for the team's orchestrator (RESET-CLOCK-1 / COMPANY POOL): every machine's
// accounts with each window's used %, reset time and when it was observed, who is using which account right now,
// which machine lends a pooled login, and a suggested split of seats over the logins. Pure: built from the pooled
// accounts view (`GET /v1/accounts`). Only numbers, enums, masked labels and handles — never credential material.
// No zod, no node: the dashboard bundle imports it too.
import { clockAvailability, displayState, UNKNOWN_MS, usageUntil } from "./accounts-format.ts";
import type { AccountView, ResetClock } from "./accounts.ts";
import { lendsAs, PERSONAL_RESERVE_PCT, type TeamPolicy } from "./pool-rules.ts";

export interface FleetWindow {
  kind: ResetClock["kind"]; scope: string | null; window_s: number | null;
  /** null: only its reset time is remembered (no current reading of it). */
  used_pct: number | null;
  resets_at: number | null;
  observed_at: number;
  exhausted: boolean;
}

export interface FleetAccount {
  key: string; id: string; provider: AccountView["provider"]; label: string; plan: string | null; owner: string;
  /** This machine's vault policy for it (null: a login a session uses here, not in the vault). */
  policy: string | null;
  /** Lent to every machine of the team right now (company policy, team on company). */
  pooled: boolean;
  /** This machine is where borrowers lease it from (the online holder with the newest home). */
  lender: boolean;
  state: ReturnType<typeof displayState>;
  /** This copy's login needs a re-login (reported per machine: one copy can break while the others work). */
  needs_relogin: boolean;
  agents: string[];
  windows: FleetWindow[];
}

export interface FleetMachine { node_id: string; hostname: string; handle: string; online: boolean; self: boolean; accounts: FleetAccount[] }

export interface FleetUse { key: string; label: string; provider: AccountView["provider"]; owner: string; handle: string; hostname: string; agent: string | null; since: number; verified: boolean }

export interface Fleet { machines: FleetMachine[]; using_now: FleetUse[] }

function windowsOf(m: AccountView["machines"][number], clock: readonly ResetClock[] | undefined): FleetWindow[] {
  const u = m.usage;
  const out: FleetWindow[] = (u?.windows ?? []).map((w) => ({
    kind: w.kind, scope: w.scope, window_s: w.window_s, used_pct: w.used_pct, resets_at: w.resets_at, observed_at: u?.at ?? 0, exhausted: w.used_pct >= 100,
  }));
  // Remembered windows the reading no longer lists (a stale or failed reading): their reset still counts down.
  for (const c of m.clock ?? clock ?? []) {
    if (out.some((w) => w.kind === c.kind && w.scope === c.scope)) continue;
    out.push({ kind: c.kind, scope: c.scope, window_s: c.window_s, used_pct: null, resets_at: c.resets_at, observed_at: c.observed_at, exhausted: c.exhausted });
  }
  return out;
}

/** The lender of an account: its online vault holder with the newest home_at (null: none online). */
export function lenderOf(a: AccountView, team: TeamPolicy): string | null {
  const holders = a.machines.filter((m) => m.vault && m.online && lendsAs(m.vault, team) !== "local")
    .sort((x, y) => (y.vault?.home_at ?? 0) - (x.vault?.home_at ?? 0));
  return holders[0]?.node_id ?? null;
}

export function fleetView(list: readonly AccountView[], team: TeamPolicy, now: number): Fleet {
  const byNode = new Map<string, FleetMachine>();
  const using: FleetUse[] = [];
  for (const a of list) {
    const owner = a.owners[0] ?? "";
    const lender = lenderOf(a, team);
    for (const m of a.machines) {
      const policy = m.vault ? lendsAs(m.vault, team) : null;
      const row: FleetAccount = {
        key: a.key, id: a.id, provider: a.provider, label: a.label, plan: a.plan, owner, policy, pooled: policy === "company",
        lender: !!m.vault && lender === m.node_id, state: displayState(m.usage, now), needs_relogin: m.usage?.state === "relogin",
        agents: [...m.agents], windows: windowsOf(m, a.clock),
      };
      const node = byNode.get(m.node_id) ?? { node_id: m.node_id, hostname: m.hostname, handle: m.handle, online: m.online, self: m.self, accounts: [] };
      byNode.set(m.node_id, { ...node, accounts: [...node.accounts, row] });
    }
    for (const l of a.leases ?? []) {
      using.push({ key: a.key, label: a.label, provider: a.provider, owner, handle: l.handle, hostname: l.hostname, agent: l.agent, since: l.since, verified: l.verified === true });
    }
  }
  const machines = [...byNode.values()].sort((x, y) => Number(y.self) - Number(x.self) || x.hostname.localeCompare(y.hostname));
  return { machines, using_now: using.sort((x, y) => x.hostname.localeCompare(y.hostname) || x.since - y.since) };
}

/** The earliest remembered reset among accounts at their limit, per provider (for an orchestrator to schedule on). */
export function nextFreeByProvider(list: readonly AccountView[], now: number): Record<string, { at: number; account: string; key: string; label: string; owner: string } | null> {
  const out: Record<string, { at: number; account: string; key: string; label: string; owner: string } | null> = {};
  for (const a of list) {
    const av = clockAvailability(a.clock, a.usage, now);
    const until = av.kind === "exhausted" ? av.until : a.usage?.state === "exhausted" ? usageUntil(a.usage) : null;
    if (!(a.provider in out)) out[a.provider] = null;
    if (until === null || until <= now) continue;
    const cur = out[a.provider];
    if (!cur || until < cur.at) out[a.provider] = { at: until, account: a.id, key: a.key, label: a.label, owner: a.owners[0] ?? "" };
  }
  return out;
}

// ---- suggest a split ------------------------------------------------------------------------------

/** A machine's seat cap when none is known: DEFAULT_HOST_MAX of protocol/seats.ts (repeated: no zod in this bundle). */
export const DEFAULT_SEAT_CAP = 3;

export interface SplitMachine { node_id: string; hostname: string; handle: string; online: boolean; cap: number }

export interface SplitLogin {
  key: string; id: string; label: string; plan: string | null; provider: AccountView["provider"]; owner: string;
  /** Least % left over its windows (null: unknown). */
  room: number | null;
  /** When its fullest window resets (null: unknown). */
  resets_at: number | null;
  /** Whether it can be used at all right now (not at its limit per the reading or the remembered reset times). */
  usable: boolean;
  /** Who may run on it, from its ONLINE holders: "company" (every machine), "own" (the owner's), "local" (holders only). */
  scope: "company" | "own" | "shared" | "local";
  share_with: string[];
  /** Online machines that hold it (in a vault, or a CLI's own login). */
  holders: string[];
  /** Some online machine holds it (else no seat anywhere: Codex p8 MEDIUM 5). */
  reachable: boolean;
}

export interface SplitAssignment { key: string; label: string; plan: string | null; seats: number }
export interface SplitResult {
  machines: Array<{ node_id: string; hostname: string; cap: number; seats: SplitAssignment[]; idle: number }>;
  /** Logins that get no seat now: out (with when they free; null: unknown) or unreachable (no online holder). */
  waiting: Array<{ key: string; label: string; frees_at: number | null; why: "out" | "unreachable" }>;
}

/** Room left in % for one login (the least over its live windows); null when no reading says. */
export function roomLeft(a: AccountView, now: number): { room: number | null; resets_at: number | null } {
  const u = a.usage;
  if (!u || u.state === "unknown" || u.state === "relogin" || !u.windows.length || now - u.at > UNKNOWN_MS) return { room: null, resets_at: null };
  const live = u.windows.map((w) => (w.resets_at !== null && w.resets_at <= now ? { ...w, used_pct: 0 } : w));
  const hottest = live.reduce((x, w) => (w.used_pct > x.used_pct ? w : x));
  return { room: Math.max(0, 100 - hottest.used_pct), resets_at: hottest.resets_at };
}

/** The split's view of an account: its room, reset, who may use it (from the vault policy) and whether it is usable. */
export function splitLogin(a: AccountView, team: TeamPolicy, now: number): SplitLogin {
  const { room, resets_at } = roomLeft(a, now);
  const online = a.machines.filter((m) => m.online);
  const vaults = online.filter((m) => m.vault);
  const pols = vaults.map((m) => lendsAs(m.vault as NonNullable<typeof m.vault>, team));
  const scope = pols.includes("company") ? "company" : pols.includes("shared") ? "shared" : pols.includes("own") ? "own" : "local";
  const avail = clockAvailability(a.clock, a.usage, now);
  const state = displayState(a.usage, now);
  const out = state === "exhausted" || state === "relogin" || (avail.kind === "exhausted" && (avail.until === null || avail.until > now)) || room === 0;
  const frees = avail.kind === "exhausted" ? avail.until : usageUntil(a.usage) ?? resets_at;
  return {
    key: a.key, id: a.id, label: a.label, plan: a.plan, provider: a.provider, owner: a.owners[0] ?? "", room: out ? 0 : room, resets_at: out ? frees : resets_at,
    usable: !out, scope, share_with: [...new Set(vaults.flatMap((m) => m.vault?.share_with ?? []))],
    holders: online.map((m) => m.node_id), reachable: online.length > 0,
  };
}

function mayRun(l: SplitLogin, m: SplitMachine): boolean {
  if (l.scope === "company") return true;
  if (l.scope === "own") return m.handle === l.owner;
  if (l.scope === "shared") return m.handle === l.owner || l.share_with.includes(m.handle);
  return l.holders.includes(m.node_id);
}

/**
 * Weight of a login on a machine: its room, minus the personal reserve on another person's machine. Room unknown: 5 on
 * its person's own machines, nothing elsewhere (the reserve cannot be checked: fail closed, as the router does).
 */
function weight(l: SplitLogin, m: SplitMachine): number {
  if (!l.usable || !l.reachable || !mayRun(l, m)) return 0;
  const other = m.handle !== l.owner;
  if (l.room === null) return other ? 0 : 5;
  return Math.max(0, l.room - (other ? PERSONAL_RESERVE_PCT : 0));
}

/** Of two equally good logins the one whose window resets sooner goes first (its room comes back first). */
function sooner(a: SplitLogin, b: SplitLogin): boolean {
  const ar = a.resets_at ?? Number.MAX_SAFE_INTEGER;
  const br = b.resets_at ?? Number.MAX_SAFE_INTEGER;
  return ar !== br ? ar < br : a.key < b.key;
}

/**
 * Seats per login per machine: each online machine's seat slots are filled round by round, each slot going to the
 * login with the most weight per seat it already has (room left minus the 10 % personal reserve on other people's
 * machines), so logins with more room get proportionally more seats and machines share them. Deterministic.
 */
export function suggestSplit(machines: readonly SplitMachine[], logins: readonly SplitLogin[]): SplitResult {
  const online = machines.filter((m) => m.online && m.cap > 0);
  const given = new Map<string, number>();
  const per = new Map<string, Map<string, number>>(online.map((m) => [m.node_id, new Map()]));
  const maxCap = Math.max(0, ...online.map((m) => m.cap));
  for (let r = 0; r < maxCap; r++) {
    for (const m of online) {
      if (m.cap <= r) continue;
      let best: SplitLogin | null = null;
      let bestScore = 0;
      for (const l of logins) {
        const w = weight(l, m);
        if (w <= 0) continue;
        const score = w / ((given.get(l.key) ?? 0) + 1);
        if (score > bestScore + 1e-9 || (best && Math.abs(score - bestScore) <= 1e-9 && sooner(l, best))) { best = l; bestScore = score; }
      }
      if (!best) continue;
      given.set(best.key, (given.get(best.key) ?? 0) + 1);
      const mm = per.get(m.node_id) as Map<string, number>;
      mm.set(best.key, (mm.get(best.key) ?? 0) + 1);
    }
  }
  const byKey = new Map(logins.map((l) => [l.key, l]));
  return {
    machines: online.map((m) => {
      const seats = [...(per.get(m.node_id) as Map<string, number>).entries()]
        .map(([key, n]) => ({ key, label: byKey.get(key)?.label ?? key, plan: byKey.get(key)?.plan ?? null, seats: n }))
        .sort((x, y) => y.seats - x.seats || x.key.localeCompare(y.key));
      return { node_id: m.node_id, hostname: m.hostname, cap: m.cap, seats, idle: m.cap - seats.reduce((n, s) => n + s.seats, 0) };
    }),
    waiting: logins.filter((l) => !l.usable || !l.reachable)
      .map((l) => ({ key: l.key, label: l.label, frees_at: l.usable ? null : l.resets_at, why: l.usable ? "unreachable" as const : "out" as const }))
      .sort((x, y) => (x.frees_at ?? Number.MAX_SAFE_INTEGER) - (y.frees_at ?? Number.MAX_SAFE_INTEGER)),
  };
}
