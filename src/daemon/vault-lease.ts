// Vault hand-out between machines (ACCOUNTS-2 phase 3): a wrapped Claude session on hestia runs on a setup-token that
// lives in the vault on alex-mac. COMPANY POOL: a Codex login is LEASED, never copied — the borrower gets an
// access-only auth.json (access + id token, empty refresh token; codex-access.ts), so the home machine stays the only
// refresher of its refresh token. A Claude setup-token cannot refresh at all and is handed out as-is for one launch.
//
//   requester (the machine that needs a token)          owner (the machine whose vault holds it)
//   POST /v1/vault/lease  (unix socket only)  ──►  POST /peer/v1/vault/lease   (WireGuard; whois + roster + admitted node)
//     {account, node, agent?}                         {account, agent?, epk, nonce, ts}
//                                                     · ts within 60 s, nonce never seen before (replay)
//                                                     · account is in this vault (Claude, or Codex access-only)
//                                                     · policy: own → the caller is this machine's owner;
//                                                       shared → also a listed teammate, and only while this
//                                                       owner has "vault_sharing": true; local → refused.
//                                                       COMPANY POOL (team setting on, login not personal):
//                                                       any owner/member, never an observer.
//                                                     · every cross-person hand-out (shared or pooled) keeps
//                                                       the last 10 % for the vault holder
//                                                     · 10 hand-outs/node/hour; owner-launched seats opt in up to 256
//                                                       per node (a bucket of their own), 256 total per vault holder/hour.
//                                                       Hand-out, probe and usage-refresh budgets live in a
//                                                       roster-bounded store, not the shared 512-key limiter.
//                                                     · reply sealed to the caller's ephemeral X25519 key (seal.ts)
//   ◄── {token}  (never stored on the requester; it lives in the wrapper's memory for one launch)
// The owner logs each hand-out and each refusal (account id, node, handle, agent — never the token).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { SETUP_TOKEN_RE } from "../accounts/vault/vault.ts";
import { CLAUDE_ACCESS_MIN_LEFT_MS } from "../accounts/vault/claude-access.ts";
import { isAccessOnly } from "../accounts/vault/codex-access.ts";
import { CODEX_LEASE_MIN_LEFT_MS } from "../accounts/vault/codex-access.ts";
import { AccountUsage, DEFAULT_TEAM_POLICY, type TeamPolicy } from "../protocol/accounts.ts";
import { PERSONAL_RESERVE_PCT } from "../protocol/pool-rules.ts";
import { ephemeralKey, openLease, sealLease } from "../accounts/vault/seal.ts";
import type { VaultSource } from "../accounts/service.ts";
import type { VaultEntry } from "../accounts/vault/vault.ts";
import type { Core } from "./core.ts";
import { HttpError } from "./http.ts";
import { nodeMember, type MemberRec, type NodeRec } from "./roster.ts";
import { peerCapabilities } from "./peer-capabilities.ts";
import { DEFAULT_LEASE_LIMIT, LEASE_LAUNCHER_CAP, nodeLeaseAvailable, ownPersonLeaseAvailable, takeNodeLease, takeOwnPersonLease, vaultLeaseBudget, type RosterLeaseState } from "./vault-lease-policy.ts";

export const LEASE_WINDOW_MS = 60_000;
export const LEASES_PER_NODE_PER_HOUR = DEFAULT_LEASE_LIMIT;
/** Same borrower-visible deadline for a warm hit, miss, or cold cache. */
const PROBE_DEADLINE_MS = 750;
const PROBE_CACHE_MS = 60_000;
const PROBE_REFRESH_AHEAD_MS = 10_000;

interface ProbeCache {
  results: Map<string, { ready: boolean; until: number }>;
  pending: Map<string, () => Promise<{ ready: boolean; until: number }>>;
  reading: string | null;
}
/** A vault has one credential read at a time. Only health, never credential bytes, is retained. */
const probeCaches = new WeakMap<VaultSource, ProbeCache>();

function probeCache(vault: VaultSource): ProbeCache {
  let cache = probeCaches.get(vault);
  if (!cache) {
    cache = { results: new Map(), pending: new Map(), reading: null };
    probeCaches.set(vault, cache);
  }
  return cache;
}

function drainProbeReads(cache: ProbeCache): void {
  if (cache.reading) return;
  const next = cache.pending.entries().next().value;
  if (!next) return;
  const [key, read] = next;
  cache.pending.delete(key);
  cache.reading = key;
  void Promise.resolve().then(read).then((result) => {
    while (cache.results.size >= 256) cache.results.delete(cache.results.keys().next().value as string);
    cache.results.set(key, result);
  }).catch(() => {
    cache.results.set(key, { ready: false, until: Date.now() + PROBE_CACHE_MS });
  }).finally(() => {
    cache.reading = null;
    drainProbeReads(cache);
  });
}

function queueProbeRead(cache: ProbeCache, key: string, read: () => Promise<{ ready: boolean; until: number }>): void {
  if (cache.reading !== key && !cache.pending.has(key)) cache.pending.set(key, read);
  drainProbeReads(cache);
}

const AccountRef = z.string().regex(/^[0-9a-f]{24}$/);
const AgentRef = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/);

export const PeerLeaseReq = z.object({
  account: AccountRef,
  agent: AgentRef.optional(),
  /** The signed seat event's launcher, relayed by its admitted host; absent peers get the base budget. */
  launcher: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).optional(),
  epk: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  ts: z.number().int().nonnegative(),
}).strict();
export type PeerLeaseReq = z.infer<typeof PeerLeaseReq>;

export const PeerLeaseRes = z.object({
  epk: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  // COMPANY POOL: an access-only Codex auth.json (two JWTs) is larger than a setup-token.
  box: z.string().regex(/^[A-Za-z0-9_-]{40,24000}$/),
  owner: z.string().max(32),
  /** The grant id the borrower's lease names; the credential generation its marks bind to. */
  grant: z.string().regex(/^[0-9a-f]{16}$/),
  gen: z.string().regex(/^[0-9a-f]{0,32}$/),
  /** COMPANY POOL (additive): what the box holds — absent = a Claude setup-token (every older owner). */
  provider: z.enum(["claude", "codex"]).optional(),
  /** COMPANY POOL (additive): when a leased Codex access token runs out (its JWT exp), when known. */
  expires_at: z.number().int().nonnegative().nullable().optional(),
});
export type PeerLeaseRes = z.infer<typeof PeerLeaseRes>;

export const LocalLeaseReq = z.object({
  account: AccountRef, node: z.string().min(1).max(80), agent: AgentRef.optional(),
  launcher: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).optional(),
  /** What the caller expects back (default claude): a reply of the other kind is refused. */
  provider: z.enum(["claude", "codex"]).optional(),
}).strict();

export const PeerProbeReq = z.object({ account: AccountRef, provider: z.enum(["claude", "codex"]) }).strict();
export type PeerProbeReq = z.infer<typeof PeerProbeReq>;
export const PeerProbeRes = z.object({ ready: z.literal(true) }).strict();

/** What both sides bind the sealed reply to. */
export function leaseContext(account: string, requesterNode: string, ownerNode: string): string {
  return `${account}|${requesterNode}|${ownerNode}`;
}

/**
 * Cross-person hand-outs this owner daemon issued: each gets a grant id returned to the borrower and named by its
 * lease. Each grant backs one verified lease for its account and node for a day. Same-person leases verify by roster
 * handle and do not enter this bounded book.
 */
export class GrantBook {
  private readonly grants = new Map<string, { account: string; node: string; at: number }>();
  record(account: string, node: string, now: number): string {
    for (const [k, g] of this.grants) if (now - g.at > 86_400_000) this.grants.delete(k);
    while (this.grants.size >= 1024) this.grants.delete(this.grants.keys().next().value as string);
    const id = randomBytes(8).toString("hex");
    this.grants.set(id, { account, node, at: now });
    return id;
  }
  valid(grant: string | undefined, account: string, node: string, now: number): boolean {
    const g = grant ? this.grants.get(grant) : undefined;
    return !!g && g.account === account && g.node === node && now - g.at <= 86_400_000;
  }
}

/** Nonces seen in the last window (replay guard), bounded. */
export class NonceBook {
  private readonly seen = new Map<string, number>();
  take(nonce: string, now: number): boolean {
    for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    while (this.seen.size >= 4096) this.seen.delete(this.seen.keys().next().value as string);
    this.seen.set(nonce, now + 2 * LEASE_WINDOW_MS);
    return true;
  }
}

export interface VaultPeerDeps {
  vault: VaultSource | null;
  /** The owner's config "vault_sharing" (cross-person hand-outs), read at each request (round 1, Opus 7). */
  sharing: boolean | (() => boolean);
  nonces: NonceBook;
  grants?: GrantBook;
  /** COMPANY POOL: the team's pool setting as this machine knows it (off when unknown). */
  teamPolicy?: () => TeamPolicy;
  /** COMPANY POOL: the least room (%) this machine's own readings show for a vault login (null: no current reading). */
  roomLeft?: (id: string, now: number) => number | null;
  /** COMPANY POOL: asks this machine to renew a vault Codex login (its one refresher). */
  renew?: (id: string) => void;
}

/** The owner's `vault_sharing` as config.json says it right now (missing / unreadable = off). */
export function liveVaultSharing(configPath: string): boolean {
  try {
    return (JSON.parse(readFileSync(configPath, "utf8")) as { vault_sharing?: unknown }).vault_sharing === true;
  } catch {
    return false;
  }
}

function sharingOn(d: Pick<VaultPeerDeps, "sharing">): boolean {
  try { return typeof d.sharing === "function" ? d.sharing() : d.sharing; } catch { return false; }
}

/**
 * Whether this vault account's policy lends it to `caller` right now: by its own policy, or by the company pool. Never to
 * an observer or a removed member, whatever the policy names (WALK-74: one place for hand-outs, probes and usage).
 */
function lending(me: MemberRec, d: Pick<VaultPeerDeps, "sharing" | "teamPolicy">, caller: MemberRec, e: VaultEntry): { owner: boolean; byPolicy: boolean; byPool: boolean } {
  const owner = me.login === caller.login;
  if (caller.role === "observer" || caller.role === "removed") return { owner, byPolicy: false, byPool: false };
  let team: TeamPolicy = DEFAULT_TEAM_POLICY;
  try { team = d.teamPolicy?.() ?? DEFAULT_TEAM_POLICY; } catch { /* the default */ }
  const byPolicy = e.policy === "own" ? owner : e.policy === "shared" ? owner || (sharingOn(d) && e.share_with.includes(caller.handle)) : false;
  const byPool = !byPolicy && team === "company" && !e.personal && (owner || caller.role === "owner" || caller.role === "member");
  return { owner, byPolicy, byPool };
}

function eligibleEntry(core: Core, d: VaultPeerDeps, caller: MemberRec, account: string, now: number,
  deny: (code: string, message: string, status?: number) => never): { entry: VaultEntry; policy: string } {
  const me = core.me();
  if (!me) deny("not_ready", "this machine is not in the team", 409);
  const entry = d.vault?.list().find((e) => e.id === account);
  if (!entry || (entry.provider !== "claude" && !(entry.provider === "codex" && d.vault?.codexAccess))) deny("not_found", "no such account in this machine's vault", 404);
  const e = entry as VaultEntry;
  if (e.provider === "claude" && e.expires_at !== null && e.expires_at < now + CLAUDE_ACCESS_MIN_LEFT_MS) {
    deny("expired", "the owner's Claude setup-token has expired or has too little time left", 409);
  }
  const { owner, byPolicy, byPool } = lending(me as MemberRec, d, caller, e);
  if (!byPolicy && !byPool) {
    deny("not_allowed", caller.role === "observer" || caller.role === "removed" ? "observers and removed members can't borrow accounts"
      : e.policy === "shared" && !sharingOn(d) && e.share_with.includes(caller.handle) ? "the owner has not turned vault sharing on" : "this account's policy does not allow that");
  }
  if (!owner) {
    let room: number | null = null;
    try { room = d.roomLeft?.(e.id, now) ?? null; } catch { room = null; }
    if (room === null || !Number.isFinite(room)) deny("reserved", `no current usage reading here, so the last ${PERSONAL_RESERVE_PCT}% kept for its person cannot be checked`, 409);
    if (room - PERSONAL_RESERVE_PCT <= 0) deny("reserved", `the last ${PERSONAL_RESERVE_PCT}% of it is kept for its person`, 409);
  }
  return { entry: e, policy: byPool ? "company" : e.policy };
}

/** Admitted, revoked/removed, or not on this roster. Lease budgets are cleared only for a roster node that is not admitted. */
function rosterLeaseState(core: Core): (id: string) => RosterLeaseState {
  return (id) => {
    if (!core.roster.nodes.has(id)) return "unknown";
    return nodeMember(core.roster, id) !== null ? "admitted" : "gone";
  };
}

/** `vaultLeaseBudget`'s owner-launched key draws on its own slot; at the default limit both share the base slot. */
function budgetKind(key: string): "base" | "owner" {
  return key.endsWith(":owner-launched") ? "owner" : "base";
}

/** Owner-side readiness check: same policy and account health as a hand-out, without issuing one. */
export async function probeLease(core: Core, d: VaultPeerDeps, callerNode: string, caller: MemberRec, raw: unknown, now = Date.now()): Promise<z.infer<typeof PeerProbeRes>> {
  const deadline = performance.now() + PROBE_DEADLINE_MS;
  let result: z.infer<typeof PeerProbeRes> | undefined;
  let error: unknown;
  try { result = probeLeaseUnchecked(core, d, callerNode, caller, raw, now); }
  catch (caught) { error = caught; }
  await Bun.sleep(Math.max(0, deadline - performance.now()));
  if (error) throw error;
  return result as z.infer<typeof PeerProbeRes>;
}

function probeLeaseUnchecked(core: Core, d: VaultPeerDeps, callerNode: string, caller: MemberRec, raw: unknown, now: number): z.infer<typeof PeerProbeRes> {
  const deny = (code: string, _message: string, _status = 403): never => {
    core.log.warn("vault_probe_denied", { to_node: callerNode, to_handle: caller.handle, reason: code });
    throw new HttpError(503, "unavailable", "lease unavailable");
  };
  const parsed = PeerProbeReq.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "invalid", "bad lease probe");
  const roster = rosterLeaseState(core);
  if (!takeNodeLease(core, callerNode, { capacity: 60, perSecond: 60 / 3600 }, "probe", now, roster)) throw new HttpError(429, "rate_limited", "too many lease probes");
  // A probe carries no launcher (so older holders keep parsing it): on the owner's own machines the next seat may be
  // owner-launched or not, so it is ready only when both the base and the owner-launched bucket have room.
  const ownPerson = core.me()?.login === caller.login;
  const base = vaultLeaseBudget(core.paths.config, callerNode, false);
  const ownerLaunched = ownPerson ? vaultLeaseBudget(core.paths.config, callerNode, true) : base;
  if (!nodeLeaseAvailable(core, callerNode, base.spec, budgetKind(base.key), now, roster)
    || !nodeLeaseAvailable(core, callerNode, ownerLaunched.spec, budgetKind(ownerLaunched.key), now, roster)
    || (ownPerson && !ownPersonLeaseAvailable(core, now))) deny("handout_rate_limited", "lease unavailable", 503);
  const req = parsed.data as PeerProbeReq;
  const { entry } = eligibleEntry(core, d, caller, req.account, now, deny);
  if (entry.provider !== req.provider) deny("not_found", "the selected account is for a different provider", 404);
  const vault = d.vault as VaultSource;
  const cache = probeCache(vault);
  const key = `${entry.provider}:${entry.id}`;
  const cached = cache.results.get(key);
  if (!cached || cached.until - now <= PROBE_REFRESH_AHEAD_MS) {
    if (cached && cached.until <= now) cache.results.delete(key);
    queueProbeRead(cache, key, async () => {
      const checkedAt = Date.now();
      if (entry.provider === "codex") {
        const access = vault.codexAccess?.(entry.id, checkedAt) ?? null;
        const ready = !!access && (access.expiresAt === null || access.expiresAt > checkedAt + CODEX_LEASE_MIN_LEFT_MS);
        return { ready, until: ready && access.expiresAt !== null
          ? Math.min(checkedAt + PROBE_CACHE_MS, access.expiresAt - CODEX_LEASE_MIN_LEFT_MS) : checkedAt + PROBE_CACHE_MS };
      }
      const token = await vault.claudeToken(entry.id);
      return { ready: SETUP_TOKEN_RE.test(token), until: Date.now() + PROBE_CACHE_MS };
    });
    if (!cached || cached.until <= now) return deny("readiness_pending", "lease unavailable", 503);
  }
  if (!cached.ready) deny(entry.provider === "codex" ? "codex_access_unavailable" : "claude_token_unreadable", "lease unavailable", 503);
  return { ready: true };
}

/** Owner side of POST /peer/v1/vault/lease. The caller's identity is already verified (peer-api.ts). */
export async function grantLease(core: Core, d: VaultPeerDeps, callerNode: string, caller: MemberRec, raw: unknown, now = Date.now()): Promise<PeerLeaseRes> {
  const deny = (code: string, message: string, status = 403): never => {
    core.log.warn("vault_lease_denied", { to_node: callerNode, to_handle: caller.handle, reason: code });
    throw new HttpError(status, code, message);
  };
  const p = PeerLeaseReq.safeParse(raw);
  if (!p.success) deny("invalid", "bad lease request", 400);
  const req = p.data as PeerLeaseReq;
  const ownPerson = core.me()?.login === caller.login;
  // Every hand-out to this person's machines counts toward the per-holder ceiling; a refusal by it spends no per-node one.
  const ceiling = () => deny("rate_limited", "too many hand-outs to this person's machines; try later", 429);
  if (ownPerson && !ownPersonLeaseAvailable(core, now)) ceiling();
  const ownerLaunched = ownPerson && req.launcher === caller.handle;
  const budget = vaultLeaseBudget(core.paths.config, callerNode, ownerLaunched);
  const kind = budgetKind(budget.key);
  // Owner-launched hand-outs that still share the base (the limit is 10) are remembered. The first time the
  // separate bucket is created, it starts at the new limit minus those, not at a fresh full bucket.
  if (!takeNodeLease(core, callerNode, budget.spec, kind, now, rosterLeaseState(core), ownerLaunched && kind === "base")) deny("rate_limited", "too many hand-outs from this machine; try later", 429);
  if (Math.abs(now - req.ts) > LEASE_WINDOW_MS) deny("stale", "lease request is too old or from the future (check the clocks)");
  if (!d.nonces.take(req.nonce, now)) deny("replay", "lease request already seen");
  const { entry: e, policy: pol } = eligibleEntry(core, d, caller, req.account, now, deny);
  if (ownPerson && !takeOwnPersonLease(core, now)) ceiling();
  let secret: string;
  let expiresAt: number | null = null;
  if (e.provider === "codex") {
    // Lease, never copy: the access-only auth.json; the refresh token stays here, so this machine alone refreshes it.
    let access: ReturnType<NonNullable<VaultSource["codexAccess"]>> = null;
    try { access = (d.vault as VaultSource).codexAccess?.(e.id, now) ?? null; } catch { access = null; }
    if (!access) {
      try { d.renew?.(e.id); } catch { /* renewal is best effort; the next request tries again */ }
      return deny("unavailable", "the login's access token is unreadable or about to run out; its home machine is renewing it", 503);
    }
    secret = access.json;
    expiresAt = access.expiresAt;
  } else {
    try { secret = await (d.vault as VaultSource).claudeToken(e.id); } catch { return deny("unavailable", "the vault could not be read on the owner's machine", 503); }
    if (!SETUP_TOKEN_RE.test(secret)) deny("unavailable", "the owner's vault entry is not a Claude setup-token", 503);
  }
  // The roster can change while the vault read is in flight. A machine that is no longer admitted does not receive
  // the sealed login. Same refusal as one that was already gone; the hand-out this call already took is spent.
  if (rosterLeaseState(core)(callerNode) === "gone") deny("rate_limited", "too many hand-outs from this machine; try later", 429);
  // Everything the hand-out was judged on is judged again as it is now, the way a fresh request would be: the caller's
  // member record the roster holds now (made an observer during the read), this machine's own (removed meanwhile),
  // the vault entry (removed, a policy or share-list change), its expiry and its person's 10% reserve (a usage reading
  // that arrived during the read). A credential removed and added again under the same id during the read is a new
  // generation: the one read is not handed out (Codex pre.12 audit SHOULD 2 and 3).
  // Judged at the time the read returned (never earlier than the request's own time), so a token or usage reading that
  // went past its margin during the read counts.
  const again = eligibleEntry(core, d, nodeMember(core.roster, callerNode) ?? caller, req.account, Math.max(now, Date.now()), deny);
  if (again.entry.gen !== e.gen || again.entry.provider !== e.provider) deny("unavailable", "the account was replaced while it was being read; try again", 503);
  const lender = core.me() as MemberRec;
  // Same-person leases are verified by the borrower's roster handle; keeping their grants would evict teammates' grants.
  const grant = !ownPerson ? d.grants?.record(e.id, callerNode, now) ?? randomBytes(8).toString("hex") : randomBytes(8).toString("hex");
  core.log.info("vault_lease_granted", { account: e.id, provider: e.provider, policy: pol, to_node: callerNode, to_handle: caller.handle, ...(req.agent ? { agent: req.agent } : {}) });
  const sealed = sealLease(secret, req.epk, req.nonce, leaseContext(e.id, callerNode, core.nodeId));
  return {
    ...sealed, owner: lender.handle, grant, gen: e.gen,
    ...(e.provider === "codex" ? { provider: "codex" as const, expires_at: expiresAt } : { expires_at: e.expires_at }),
  };
}

/** Holders already reported as not (yet) announcing the launcher field, per requesting daemon. */
const unverifiedLauncherHolders = new WeakMap<Core, Set<string>>();

/** Once per holder: its owner-launched seats get only the base budget until a verified vv shows `lease_launcher_v1`. */
function noteUnverifiedLauncher(core: Core, node: string): void {
  let seen = unverifiedLauncherHolders.get(core);
  if (!seen) { seen = new Set(); unverifiedLauncherHolders.set(core, seen); }
  if (seen.has(node)) return;
  seen.add(node);
  core.log.warn("vault_lease_launcher_unverified", { from_node: node });
}

/** Requester side: asks the owner's node, opens the sealed reply. */
export async function requestLease(
  // `node` (pre.4 merge): the owner's roster record, so the caller can pick a transport (Walkie Direct included).
  core: Core, call: (addr: { ip: string; port: number }, body: PeerLeaseReq, node: NodeRec) => Promise<PeerLeaseRes>, raw: unknown, now = Date.now(),
): Promise<{ token?: string; codex_auth?: string; expires_at?: number | null; owner: string; grant: string; gen: string }> {
  const p = LocalLeaseReq.safeParse(raw);
  if (!p.success) throw new HttpError(400, "invalid", "account (24 hex), node, optional agent and provider");
  const { account, node, agent, launcher } = p.data;
  const want = p.data.provider ?? "claude";
  if (node === core.nodeId) throw new HttpError(400, "invalid", "that account is in this machine's own vault");
  const n = core.roster.nodes.get(node);
  if (!n || n.revoked) throw new HttpError(404, "not_found", "no such machine in the team");
  const ask = async (withLauncher: boolean) => {
    const key = ephemeralKey();
    const nonce = randomBytes(16).toString("hex");
    const res = await call({ ip: n.ip, port: n.port }, { account, ...(agent ? { agent } : {}),
      ...(withLauncher && launcher ? { launcher } : {}), epk: key.publicKey, nonce, ts: now }, n);
    return { key, nonce, res };
  };
  // pre.10.1 and pre.11 holders refuse any unknown field (400 invalid, before spending a hand-out or the nonce), so the
  // launcher goes only to a holder whose verified capabilities announce it; a refusal of it is asked once more without.
  const withLauncher = !!launcher && peerCapabilities(core.store, node)?.caps.includes(LEASE_LAUNCHER_CAP) === true;
  if (launcher && !withLauncher) noteUnverifiedLauncher(core, node);
  let answer: Awaited<ReturnType<typeof ask>>;
  try { answer = await ask(withLauncher); }
  catch (err) {
    const e = err as { status?: unknown; code?: unknown };
    if (!withLauncher || e.status !== 400 || e.code !== "invalid") throw err;
    core.log.warn("vault_lease_launcher_refused", { from_node: node });
    answer = await ask(false);
  }
  const { key, nonce, res } = answer;
  let opened: string;
  try {
    opened = openLease({ epk: res.epk, box: res.box }, key.privateKey, nonce, leaseContext(account, core.nodeId, node));
  } catch {
    throw new HttpError(502, "bad_lease", "the owner's reply could not be opened");
  }
  const got = res.provider ?? "claude";
  if (got !== want) throw new HttpError(502, "bad_lease", `the owner's reply is a ${got} login, not the ${want} one asked for`);
  if (got === "codex") {
    // Only an access-only copy is ever accepted (never a refresh token or an API key).
    if (!isAccessOnly(opened)) throw new HttpError(502, "bad_lease", "the owner's reply is not an access-only Codex login");
    core.log.info("vault_lease_received", { account, provider: "codex", from_node: node, ...(agent ? { agent } : {}) });
    return { codex_auth: opened, expires_at: res.expires_at ?? null, owner: res.owner, grant: res.grant, gen: res.gen };
  }
  if (!SETUP_TOKEN_RE.test(opened)) throw new HttpError(502, "bad_lease", "the owner's reply is not a setup-token");
  core.log.info("vault_lease_received", { account, from_node: node, ...(agent ? { agent } : {}) });
  return { token: opened, expires_at: res.expires_at ?? null, owner: res.owner, grant: res.grant, gen: res.gen };
}

/**
 * An existing borrower may refresh usage, under the poller's shared throttle and provider backoff, while the account's
 * policy still lends it to them (WALK-74): a grant was made under the policy as it was then, and outlives it by a day.
 */
/** Usage refreshes refused, by borrowing node and account, so each refusal is logged once while it lasts. */
const usageDenied = new WeakMap<Core, Set<string>>();
export const BorrowedUsageReq = z.object({ account: AccountRef, grant: z.string().regex(/^[0-9a-f]{16}$/) }).strict();
export const BorrowedUsageRes = z.object({ usage: AccountUsage.nullable() });
export function refreshBorrowedUsage(core: Core, d: Pick<VaultPeerDeps, "vault" | "sharing" | "teamPolicy">, node: string, caller: MemberRec,
  raw: unknown): z.infer<typeof BorrowedUsageRes> {
  const req = BorrowedUsageReq.safeParse(raw);
  if (!req.success) throw new HttpError(400, "invalid", "bad usage refresh request");
  if (!core.vaultGrants.valid(req.data.grant, req.data.account, node, Date.now())) throw new HttpError(403, "forbidden", "a current account grant is required");
  const me = core.me();
  let entry: VaultEntry | undefined;
  try { entry = me ? d.vault?.list().find((e) => e.id === req.data.account) : undefined; } catch { entry = undefined; }
  // The same account test a hand-out applies (eligibleEntry): a Claude login, or a Codex one this vault can lease.
  if (entry && entry.provider !== "claude" && !(entry.provider === "codex" && d.vault?.codexAccess)) entry = undefined;
  const lent = me && entry ? lending(me, d, caller, entry) : null;
  const key = `${node}:${req.data.account}`;
  const denied = usageDenied.get(core) ?? new Set<string>();
  usageDenied.set(core, denied);
  if (!lent || (!lent.byPolicy && !lent.byPool)) {
    // Logged once per borrowing machine and account while it stays refused (its reserve check asks every minute).
    if (!denied.has(key)) {
      if (denied.size >= 1024) denied.clear();
      denied.add(key);
      core.log.warn("vault_usage_denied", { to_node: node, to_handle: caller.handle, reason: !me ? "not_ready" : entry ? "not_allowed" : "not_found" });
    }
    throw new HttpError(403, "not_allowed", "this account is no longer lent to you: its owner changed who may use it");
  }
  denied.delete(key);
  if (!takeNodeLease(core, node, { capacity: 10, perSecond: 1 / 60 }, "usage", Date.now(), rosterLeaseState(core))) throw new HttpError(429, "rate_limited", "usage refresh is throttled");
  core.vaultRefresh(req.data.account);
  return { usage: core.accounts?.accounts.find((a) => a.id === req.data.account)?.usage ?? null };
}
