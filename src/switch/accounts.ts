// The switcher's view of the accounts it may use (ACCOUNTS-2): this machine's vault, plus — through the local daemon —
// the pooled team view (phase 1 readings from every machine, each machine's vault badge and policy, and every wrapped
// session's lease). When the daemon does not answer, the vault alone, with the last readings the daemon saved in
// ~/.walkie/accounts.json, the local marks and the local leases.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { WalkieClient } from "../client/index.ts";
import { AccountUsage, DEFAULT_TEAM_POLICY, type AccountView, type AccountVault, type ResetClock, type TeamPolicy } from "../protocol/accounts.ts";
import { activeLeases, markKey, readMarks, readSessionReadings } from "../accounts/leases.ts";
import type { Candidate } from "../accounts/select.ts";
import { Vault, type VaultEntry } from "../accounts/vault/vault.ts";
import { codexBaseHome, syncCodexHome } from "../accounts/vault/codex-home.ts";
import { removeLeaseHome, sweepLeaseHomes, writeLeaseHome } from "../accounts/vault/codex-lease-home.ts";
import { validClock } from "../accounts/clock.ts";
import { isPooled, mayLeaseUnder } from "../accounts/pool.ts";

export interface Credentials {
  /** Claude: the setup-token (held in memory for one launch). */
  token?: string;
  /** A hand-out's grant id (the lease names it) and the credential generation (marks bind to it). */
  grant?: string;
  gen?: string;
  /** Codex: the account's CODEX_HOME (a leased one for a pooled login: deleted by `release`). */
  home?: string;
  /** Deletes what the credentials left on disk (a leased Codex home); call when the session ended. */
  release?: () => void;
}

export interface AccountSource {
  gather(provider: "claude" | "codex", now: number): Promise<Candidate[]>;
  credentials(c: Candidate, agent: string | null): Promise<Credentials>;
  /** Vault accounts for this provider exist on this machine (else the wrapper passes straight through). */
  hasAccounts(provider: "claude" | "codex"): boolean;
  /**
   * Any account the switcher could use: the local vault, or (round 1, Codex 6) permitted accounts in the owner's other
   * vaults / borrowed ones, found through the daemon — so a machine without a vault of its own still switches.
   */
  available(provider: "claude" | "codex", now: number): Promise<boolean>;
}

const SavedFile = z.object({ records: z.array(z.object({ id: z.string(), reading: AccountUsage.nullable(), clock: z.unknown().optional() }).passthrough()) }).passthrough();

function savedRecords(walkieHome: string): z.infer<typeof SavedFile>["records"] {
  const path = join(walkieHome, "accounts.json");
  if (!existsSync(path)) return [];
  try {
    const p = SavedFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return p.success ? p.data.records : [];
  } catch {
    return []; // unreadable: none
  }
}

/** The last readings the daemon saved (accounts.json), by account id. */
export function savedReadings(walkieHome: string): Map<string, AccountUsage> {
  const out = new Map<string, AccountUsage>();
  for (const r of savedRecords(walkieHome)) if (r.reading) out.set(r.id, r.reading);
  return out;
}

/** RESET-CLOCK-1: the reset times the daemon remembered (accounts.json), by account id (validated entry by entry). */
export function savedClocks(walkieHome: string): Map<string, ResetClock[]> {
  const out = new Map<string, ResetClock[]>();
  for (const r of savedRecords(walkieHome)) {
    const c = validClock(r.clock);
    if (c.length) out.set(r.id, c);
  }
  return out;
}

/** The newest known (not "unknown") reading. */
function freshest(list: readonly (AccountUsage | null)[]): AccountUsage | null {
  return list.filter((u): u is AccountUsage => !!u && u.state !== "unknown").sort((a, b) => b.at - a.at)[0] ?? null;
}

function meterless(u: AccountUsage | null): boolean {
  return !u || u.state === "unknown";
}

/** Whether `me` may have an account handed out from its owner's vault under this policy (COMPANY POOL: pool.ts). */
export function mayLease(v: AccountVault | undefined, owner: string, me: string, team: TeamPolicy = DEFAULT_TEAM_POLICY, role: string | null = "member"): boolean {
  return mayLeaseUnder(v, owner, me, team, role);
}

export interface PooledView {
  accounts: AccountView[]; me: string | null;
  /** COMPANY POOL: the team accounts policy (absent from an older daemon: company, the default). */
  team?: TeamPolicy;
  /** The caller's role in the team (observers never borrow through the pool). */
  role?: string | null;
}

/** Leases the scheduler may count: backed by the owner's own machine or a hand-out the owner granted (round 1, Codex 7). */
function verifiedLeases(v: AccountView | undefined): number {
  return (v?.leases ?? []).filter((l) => l.verified === true).length;
}

/**
 * Builds the candidate list (pure; exported for tests). Round 1 (Codex 7, Opus 4):
 *   · a local vault entry takes readings and lease counts ONLY from its owner's (the caller's) pooled entry — another
 *     member reporting the same id can never exclude or down-rank it;
 *   · the caller's own accounts on its other machines (policy own/shared) are own candidates;
 *   · a teammate's shared account is a candidate only when the borrower opted in (`borrow`); selectOwnFirst then uses
 *     it only when none of the caller's own accounts can be picked. Its leases are informational (0).
 */
export function candidatesFrom(o: {
  provider: "claude" | "codex"; entries: readonly VaultEntry[]; pooled: PooledView | null; saved: Map<string, AccountUsage>;
  marks: ReturnType<typeof readMarks>; localLeases: Map<string, number>;
  /** What wrapped sessions themselves last reported (session-readings.json). */
  sessions?: Record<string, AccountUsage>;
  /** The caller opted in to borrowing teammates' shared accounts (`walkie accounts borrow on`). */
  borrow?: boolean;
  /** RESET-CLOCK-1: the reset times the daemon saved (used when the daemon does not answer). */
  clocks?: Map<string, ResetClock[]>;
}): Candidate[] {
  const me = o.pooled?.me ?? null;
  const team = o.pooled?.team ?? DEFAULT_TEAM_POLICY;
  const role = o.pooled?.role ?? "member";
  const out: Candidate[] = [];
  const local = new Set<string>();
  for (const e of o.entries) {
    if (e.provider !== o.provider) continue;
    local.add(e.id);
    const mine = me !== null ? o.pooled?.accounts.find((v) => v.id === e.id && v.owners.includes(me)) : undefined;
    const usage = freshest([mine?.usage && !meterless(mine.usage) ? mine.usage : null, o.saved.get(e.id) ?? null, o.sessions?.[e.id] ?? null]) ?? mine?.usage ?? null;
    const clock = mine?.clock ?? o.clocks?.get(e.id);
    out.push({
      id: e.id, provider: e.provider, label: e.label, owner: me, own: true, source: "local", usage, gen: e.gen,
      ...(o.marks[e.id] ? { mark: o.marks[e.id] } : {}), ...(clock?.length ? { clock } : {}),
      leases: Math.max(verifiedLeases(mine), o.localLeases.get(e.id) ?? 0),
      meterless: meterless(usage),
    });
  }
  // Hand-outs (phase 3): logins another machine's vault may lend to this one — Claude setup-tokens, and (COMPANY POOL)
  // Codex logins as access-only leases. Round 4 (Codex 3): identity is owner-qualified (owner + account id) throughout
  // — a teammate advertising the same account id can never shadow an own account — and every own account is listed
  // (reachable or not) before any teammate's, so the borrowing rule always sees all of them.
  if (o.pooled && me) {
    const seen = new Set<string>([...local].map((id) => `${me}\u0000${id}`));
    const views = o.pooled.accounts.filter((v) => v.provider === o.provider);
    const ownerOf = (v: AccountView) => v.owners[0] ?? "";
    for (const pass of ["own", "theirs"] as const) {
      for (const v of views) {
        const owner = ownerOf(v);
        const own = owner === me;
        if ((pass === "own") !== own) continue;
        const key = `${owner}\u0000${v.id}`;
        if (seen.has(key)) continue;
        // The lenders: online machines of the owner that may lend here, whose own copy does not need a re-login; the
        // newest home (promotion) first, the others kept as alternatives when it fails (Codex p8 MEDIUM 4).
        const holders = v.machines.filter((m) => !m.self && m.online && m.usage?.state !== "relogin" && mayLease(m.vault, owner, me, team, role))
          .sort((a, b) => (b.vault?.home_at ?? 0) - (a.vault?.home_at ?? 0));
        const holder = holders[0];
        // A teammate's login: through the company pool, or (shared) only with the borrower's opt-in.
        const pooled = !own && !!holder && isPooled(holder.vault, team);
        if (!own && !pooled && !o.borrow) continue;
        if (!holder) {
          // An own account in a vault on another machine that is offline (or not lending here): unreachable, but
          // still one of "every own account" for the borrowing rule.
          if (own && v.machines.some((m) => !m.self && m.vault)) {
            seen.add(key);
            out.push({ id: v.id, provider: o.provider, label: v.label, owner, own: true, source: "peer", usage: v.usage, leases: 0, unavailable: true, ...(v.clock?.length ? { clock: v.clock } : {}) });
          }
          continue;
        }
        seen.add(key);
        out.push({
          id: v.id, provider: o.provider, label: v.label, owner, own, source: "peer", node: holder.node_id,
          ...(holders.length > 1 ? { nodes: holders.map((m) => m.node_id) } : {}),
          ...(holder.vault?.gen ? { gen: holder.vault.gen } : {}),
          // Marks are owner-qualified (round 5, Codex 7): what a borrowed account hit never lands on an own one.
          usage: v.usage, ...(o.marks[markKey({ id: v.id, own, owner })] ? { mark: o.marks[markKey({ id: v.id, own, owner })] } : {}),
          // Leases on a pooled login count for everyone (the pool spreads out); a shared one's are informational.
          leases: own || pooled ? verifiedLeases(v) : 0, meterless: meterless(v.usage),
          ...(v.clock?.length ? { clock: v.clock } : {}), ...(pooled ? { pooled: true } : {}),
        });
      }
    }
  }
  return out;
}

/** The borrower's opt-in (config.json `borrow_shared`), read at each gather. */
export function borrowOn(walkieHome: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(walkieHome, "config.json"), "utf8")) as { borrow_shared?: unknown }).borrow_shared === true;
  } catch {
    return false;
  }
}

export function defaultSource(walkieHome: string, env: NodeJS.ProcessEnv = process.env): AccountSource {
  let vault: Vault | null = null;
  const openVault = (): Vault | null => {
    if (!vault && Vault.exists(walkieHome)) vault = Vault.open(walkieHome);
    return vault;
  };
  const client = new WalkieClient({ timeoutMs: 2_000 });
  return {
    hasAccounts(provider) {
      if (!Vault.exists(walkieHome)) return false;
      return (openVault()?.list() ?? []).some((e) => e.provider === provider);
    },
    async available(provider, now) {
      if (this.hasAccounts(provider)) return true;
      return (await this.gather(provider, now)).length > 0;
    },
    async gather(provider, now) {
      const entries = openVault()?.list() ?? [];
      let pooled: PooledView | null = null;
      try {
        const [acc, me] = await Promise.all([client.accounts(), client.me().catch(() => null)]);
        pooled = { accounts: acc.accounts, me: me?.handle ?? null, team: acc.pool?.policy ?? DEFAULT_TEAM_POLICY, role: me?.role ?? null };
      } catch { /* daemon down or not in a team: the vault alone */ }
      const localLeases = new Map<string, number>();
      for (const l of activeLeases(walkieHome)) localLeases.set(l.account, (localLeases.get(l.account) ?? 0) + 1);
      return candidatesFrom({ provider, entries, pooled, saved: savedReadings(walkieHome), marks: readMarks(walkieHome, now), localLeases, sessions: readSessionReadings(walkieHome, now), borrow: borrowOn(walkieHome), clocks: savedClocks(walkieHome) });
    },
    async credentials(c, agent) {
      if (c.source === "peer") {
        // The preferred lender first, then the other holders (one failing machine never blocks a healthy one).
        const nodes = c.nodes?.length ? c.nodes : [c.node as string];
        let r: Awaited<ReturnType<typeof client.vaultLease>> | null = null;
        let last: unknown = null;
        for (const node of nodes) {
          try { r = await client.vaultLease({ account: c.id, node, ...(agent ? { agent } : {}), ...(c.provider === "codex" ? { provider: "codex" as const } : {}) }); break; } catch (err) { last = err; }
        }
        if (!r) throw last instanceof Error ? last : new Error("no machine holding it could lend it");
        if (c.provider === "codex") {
          // COMPANY POOL: a leased (access-only) Codex login in a home of its own, deleted when the session ends.
          if (!r.codex_auth) throw new Error("the owner's machine sent no Codex login");
          sweepLeaseHomes(walkieHome);
          const home = writeLeaseHome(walkieHome, codexBaseHome(walkieHome, env), r.grant, r.codex_auth);
          return { home, grant: r.grant, ...(r.gen ? { gen: r.gen } : {}), release: () => { try { removeLeaseHome(home, walkieHome); } catch { /* swept later */ } } };
        }
        if (!r.token) throw new Error("the owner's machine sent no token");
        return { token: r.token, grant: r.grant, ...(r.gen ? { gen: r.gen } : {}) };
      }
      const v = openVault();
      const e = v?.get(c.id);
      if (!v || !e) throw new Error("that account is no longer in the vault");
      if (e.provider === "claude") return { token: await v.claudeToken(e.id) };
      if (!e.home) throw new Error("the vault Codex account has no home directory");
      syncCodexHome(e.home, codexBaseHome(walkieHome, env));
      return { home: e.home };
    },
  };
}
