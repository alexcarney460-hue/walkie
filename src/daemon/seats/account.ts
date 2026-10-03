// A v2 seat's account (FO-2, FLEET-ORCH-1 §5.1): the host runs the seat on the named router account instead of its
// default login, only when this machine may use that account under its owner's vault policy or the company pool:
//   · an account in this machine's vault (its person's: local, own or shared alike);
//   · the person's own account in their vault on another of their machines (policy own or shared);
//   · a teammate's account shared to this machine's person (policy shared, share_with ∋ them; the owner's machine also
//     requires its vault_sharing, and checks everything again before it hands the login out), and only for a seat
//     whose LAUNCHER the owner lets use it too (the owner, or share_with ∋ the launcher: FO-2 r1 MEDIUM 11);
//   · COMPANY POOL (pre.8 merge): while the team's pool is on, a login its holder pooled (not personal) for this
//     machine's person and the launcher alike when each is an owner or member (never an observer); the holder keeps
//     its 10 % reserve and re-checks everything before it lends.
//     The host person's own accounts serve any launcher allowed on their machine (their consent: `seats allow`).
// Without an account a seat keeps this machine's own login (Alex's decision). A Codex login from another machine is
// LEASED as an access-only copy (never its refresh token: codex-access.ts), and Kimi logins aren't vault accounts.
// Anything else is refused `account_not_usable`. Credentials live in the seat's environment (or a leased Codex home)
// for one run and are never posted or logged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mayLeaseUnder } from "../../accounts/pool.ts";
import type { AccountVault, AccountView, TeamPolicy } from "../../protocol/accounts.ts";
import type { SeatRuntime } from "../../protocol/seats.ts";
import type { VaultEntry } from "../../accounts/vault/vault.ts";

export const ACCOUNT_NOT_USABLE = "account_not_usable";

export type AccountPlan =
  | { kind: "local"; entry: VaultEntry }
  | { kind: "peer"; id: string; owner: string; node: string; provider: "claude" | "codex"; pooled?: true; gen?: string }
  | { kind: "refused"; why: string };

/** The team's pool and who is an owner/member (the pool's borrowers); omitted: the pool is off. */
export interface PoolContext { team: TeamPolicy; roleOf: (handle: string) => string | null }

/** Whether `me` may have an account handed out from its owner's vault (own / shared policy, or the company pool). */
function mayLease(v: AccountVault | undefined, owner: string, me: string, pool: PoolContext | undefined): boolean {
  return mayLeaseUnder(v, owner, me, pool?.team ?? "per-account", pool ? pool.roleOf(me) : null);
}

function refused(why: string): AccountPlan { return { kind: "refused", why: `${ACCOUNT_NOT_USABLE}: ${why}` }; }

/**
 * Where a seat on this machine (whose person is `me`) gets account `key` (`<owner>:<id>`), or why it can't. Pure:
 * `vault` is this machine's vault, `pooled` the team's accounts view (which machine holds which account, its policy,
 * online or not).
 */
export function planSeatAccount(
  key: string, o: { runtime: SeatRuntime; me: string; launcher: string; vault: readonly VaultEntry[]; pooled: readonly AccountView[]; pool?: PoolContext },
): AccountPlan {
  const at = key.indexOf(":");
  const owner = key.slice(0, at);
  const id = key.slice(at + 1);
  if (at <= 0 || !/^[0-9a-f]{24}$/.test(id)) return refused("not an account key (<owner>:<24 hex id>)");
  if (o.runtime === "kimi") return refused("Kimi logins aren't vault accounts: leave the account out to use this machine's own Kimi login");
  if (o.runtime === "grok") return refused("Grok uses only this machine's subscription login, not a vault account");
  if (owner === o.me) {
    const entry = o.vault.find((e) => e.id === id);
    if (entry) {
      return entry.provider === o.runtime ? { kind: "local", entry } : refused(`that account is a ${entry.provider} login and this seat runs ${o.runtime}`);
    }
  }
  const runtime = o.runtime;
  const name = runtime === "codex" ? "Codex" : "Claude";
  const view = o.pooled.find((v) => v.provider === runtime && v.id === id && (v.owners[0] ?? "") === owner);
  if (!view) return refused(`no ${name} account ${key} is known to this machine`);
  const holders = view.machines.filter((m) => !m.self && m.vault);
  if (!holders.length) return refused(`no machine of @${owner} holds ${key} in its vault`);
  // One holder that lets both this machine's person and (for a teammate's account) the launcher have it, online: the
  // token is leased from exactly that holder (FO-2 r2 MED 4).
  const launcherOk = (v: AccountVault | undefined) => owner === o.me || o.launcher === owner || mayLease(v, owner, o.launcher, o.pool);
  const lend = holders.filter((m) => mayLease(m.vault, owner, o.me, o.pool));
  if (!lend.length) {
    return refused(owner === o.me
      ? "its vault policy is local: it is used only on the machine that holds it"
      : `@${owner} hasn't shared it with @${o.me} (vault policy shared, listing @${o.me})`);
  }
  const both = lend.filter((m) => launcherOk(m.vault));
  if (!both.length) return refused(`@${owner} shared it with @${o.me}, not with @${o.launcher} who launched this seat`);
  const online = both.find((m) => m.online);
  if (!online) return refused(`the machine holding it (${both[0]?.hostname ?? "?"}) is offline`);
  return { kind: "peer", id, owner, node: online.node_id, provider: runtime,
    ...(owner !== o.me && o.pool?.team === "company" && online.vault?.company && !online.vault.personal ? { pooled: true as const } : {}),
    ...(online.vault?.gen ? { gen: online.vault.gen } : {}) };
}

/**
 * Whether two plans name the same credential: the same lending machine for a hand-out, and the same stored generation
 * for this machine's own vault entry (an account removed and added again under the same id is a new credential).
 */
export function sameAccountSource(a: Exclude<AccountPlan, { kind: "refused" }>, b: Exclude<AccountPlan, { kind: "refused" }>): boolean {
  // A hand-out's generation is compared when both sides know it (an older lender or view may not report one).
  if (a.kind === "peer" && b.kind === "peer") {
    return a.node === b.node && a.id === b.id && a.provider === b.provider && (a.gen === undefined || b.gen === undefined || a.gen === b.gen);
  }
  if (a.kind === "local" && b.kind === "local") return a.entry.id === b.entry.id && a.entry.gen === b.entry.gen;
  return false;
}

/** What a seat's run gets from its account: environment additions and, for a seat user's Codex, its auth.json copy. */
export interface SeatCredentials {
  env: Record<string, string>;
  /** Owner-reported lease expiry; unknown on old Claude peers. */
  expiresAt?: number | null;
  /** A seat user's Codex: the account's access-only auth.json (handed to its runner, never the refresh token). */
  codexAuth?: string;
  /** A same-user seat's leased Codex home (COMPANY POOL; codex-lease-home.ts), deleted when the seat ends. */
  leaseHome?: string;
  /** A hand-out's credential generation as the lending machine reported it (absent from older lenders). */
  gen?: string;
  /** For the router's lease (the account id, a hand-out's node, owner and grant). */
  lease: { provider: "claude" | "codex"; account: string; from_node?: string; owner?: string; grant?: string };
}

export interface CredentialDeps {
  /** This machine's vault: a Claude token, decrypted in memory for one launch. */
  claudeToken: (id: string) => Promise<string>;
  /** A hand-out from the owner's machine (vault-lease.ts): a Claude setup-token, or an access-only Codex auth.json. */
  lease: (id: string, node: string, provider: "claude" | "codex") => Promise<{ token?: string; codex_auth?: string; grant: string; expires_at?: number | null; gen?: string }>;
  /** A same-user seat's Codex home for a leased login (codex-lease-home.ts writeLeaseHome). */
  leaseHome?: (grant: string, authJson: string) => string;
  /**
   * Keep a same-user Codex lease in memory (`codexAuth`) and do not call `leaseHome`. The host writes the home
   * only after it has checked the launcher again. A seat user never writes a lease home, so this does not apply.
   */
  deferLeaseHome?: boolean;
  /** Codex auth.json reduced to access-only (host.ts accessOnlyCodex). */
  accessOnlyCodex: (text: string) => string | null;
}

/** The credentials for a planned account (the seat runs as the person, or as a seat user: `asSeatUser`). */
export async function seatCredentials(plan: Exclude<AccountPlan, { kind: "refused" }>, me: string, asSeatUser: boolean, d: CredentialDeps): Promise<SeatCredentials> {
  if (plan.kind === "peer") {
    const r = await d.lease(plan.id, plan.node, plan.provider);
    if (r.expires_at !== undefined && r.expires_at !== null && r.expires_at <= Date.now()) throw new Error("the owner's account lease expired");
    const lease = { provider: plan.provider, account: plan.id, from_node: plan.node, ...(plan.owner !== me ? { owner: plan.owner } : {}), grant: r.grant };
    const gen = r.gen ? { gen: r.gen } : {};
    if (plan.provider === "claude") {
      if (!r.token) throw new Error("the owner's machine sent no token");
      return { env: { CLAUDE_CODE_OAUTH_TOKEN: r.token }, expiresAt: r.expires_at, lease, ...gen };
    }
    if (!r.codex_auth) throw new Error("the owner's machine sent no Codex login");
    if (asSeatUser) return { env: {}, codexAuth: r.codex_auth, expiresAt: r.expires_at, lease, ...gen };
    if (d.deferLeaseHome) return { env: {}, codexAuth: r.codex_auth, expiresAt: r.expires_at, lease, ...gen };
    if (!d.leaseHome) throw new Error("a leased Codex login needs a home of its own on this machine");
    const home = d.leaseHome(r.grant, r.codex_auth);
    return { env: { CODEX_HOME: home }, leaseHome: home, expiresAt: r.expires_at, lease, ...gen };
  }
  const e = plan.entry;
  if (e.provider === "claude") return { env: { CLAUDE_CODE_OAUTH_TOKEN: await d.claudeToken(e.id) }, lease: { provider: "claude", account: e.id } };
  if (!e.home) throw new Error("the vault's Codex account has no home directory");
  if (!asSeatUser) return { env: { CODEX_HOME: e.home }, lease: { provider: "codex", account: e.id } };
  let copy: string | null = null;
  try { copy = d.accessOnlyCodex(readFileSync(join(e.home, "auth.json"), "utf8")); } catch { copy = null; }
  if (!copy) throw new Error("that Codex account isn't signed in where a seat user can use it (no auth.json in its vault home)");
  return { env: {}, codexAuth: copy, lease: { provider: "codex", account: e.id } };
}
