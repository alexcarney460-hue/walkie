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
//                                                       any owner/member, never an observer, and only while
//                                                       this machine's reading shows more than the 10 %
//                                                       kept for its person
//                                                     · at most 10 hand-outs per calling node per hour
//                                                     · reply sealed to the caller's ephemeral X25519 key (seal.ts)
//   ◄── {token}  (never stored on the requester; it lives in the wrapper's memory for one launch)
// The owner logs each hand-out and each refusal (account id, node, handle, agent — never the token).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { SETUP_TOKEN_RE } from "../accounts/vault/vault.ts";
import { isAccessOnly } from "../accounts/vault/codex-access.ts";
import { AccountUsage, DEFAULT_TEAM_POLICY, type TeamPolicy } from "../protocol/accounts.ts";
import { PERSONAL_RESERVE_PCT } from "../protocol/pool-rules.ts";
import { ephemeralKey, openLease, sealLease } from "../accounts/vault/seal.ts";
import type { VaultSource } from "../accounts/service.ts";
import type { Core } from "./core.ts";
import { HttpError } from "./http.ts";
import type { MemberRec, NodeRec } from "./roster.ts";

export const LEASE_WINDOW_MS = 60_000;
export const LEASES_PER_NODE_PER_HOUR = 10;
const LEASE_BUCKET = { capacity: LEASES_PER_NODE_PER_HOUR, perSecond: LEASES_PER_NODE_PER_HOUR / 3600 };

const AccountRef = z.string().regex(/^[0-9a-f]{24}$/);
const AgentRef = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/);

export const PeerLeaseReq = z.object({
  account: AccountRef,
  agent: AgentRef.optional(),
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
  /** What the caller expects back (default claude): a reply of the other kind is refused. */
  provider: z.enum(["claude", "codex"]).optional(),
}).strict();

/** What both sides bind the sealed reply to. */
export function leaseContext(account: string, requesterNode: string, ownerNode: string): string {
  return `${account}|${requesterNode}|${ownerNode}`;
}

/** Hand-outs this (owner) daemon granted, by account and node, for a day: what makes a borrower's lease verifiable. */
/**
 * Hand-outs this (owner) daemon issued (round 2, Codex 7 / Opus 8): each gets a grant id, returned to the borrower and
 * named by its lease. A lease counts only when it names a grant issued for that account to that node in the last day,
 * and a grant backs one lease — so one hand-out can never become 64 "verified" sessions.
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

function sharingOn(d: VaultPeerDeps): boolean {
  try { return typeof d.sharing === "function" ? d.sharing() : d.sharing; } catch { return false; }
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
  if (!core.limiter.take(`vault-lease:${callerNode}`, LEASE_BUCKET, now)) deny("rate_limited", "too many hand-outs from this machine; try later", 429);
  if (Math.abs(now - req.ts) > LEASE_WINDOW_MS) deny("stale", "lease request is too old or from the future (check the clocks)");
  if (!d.nonces.take(req.nonce, now)) deny("replay", "lease request already seen");
  const me = core.me();
  if (!me) deny("not_ready", "this machine is not in the team", 409);
  const entry = d.vault?.list().find((e) => e.id === req.account);
  if (!entry || (entry.provider !== "claude" && !(entry.provider === "codex" && d.vault?.codexAccess))) deny("not_found", "no such account in this machine's vault", 404);
  const e = entry as NonNullable<typeof entry>;
  const owner = (me as MemberRec).login === caller.login;
  let team: TeamPolicy = DEFAULT_TEAM_POLICY;
  try { team = d.teamPolicy?.() ?? DEFAULT_TEAM_POLICY; } catch { /* the default */ }
  // Its own policy first (unchanged: own = the owner's machines; shared = listed teammates while vault_sharing is on).
  const byPolicy = e.policy === "own" ? owner : e.policy === "shared" ? owner || (sharingOn(d) && e.share_with.includes(caller.handle)) : false;
  // COMPANY POOL: while the team's pool is on, a login its person has not marked personal is lent to every owner and
  // member (never an observer) — keeping the last PERSONAL_RESERVE_PCT of it for its person.
  const byPool = !byPolicy && team === "company" && !e.personal && (owner || caller.role === "owner" || caller.role === "member");
  if (!byPolicy && !byPool) {
    deny("not_allowed", e.policy === "shared" && !sharingOn(d) && e.share_with.includes(caller.handle) ? "the owner has not turned vault sharing on" : "this account's policy does not allow that");
  }
  const pol = byPool ? "company" : e.policy;
  if (byPool && !owner) {
    let room: number | null = null;
    try { room = d.roomLeft?.(e.id, now) ?? null; } catch { room = null; }
    if (room === null) deny("reserved", `no current usage reading here, so the last ${PERSONAL_RESERVE_PCT}% kept for its person cannot be checked`, 409);
    if ((room as number) - PERSONAL_RESERVE_PCT <= 0) deny("reserved", `the last ${PERSONAL_RESERVE_PCT}% of it is kept for its person`, 409);
  }
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
  }
  const grant = d.grants?.record(e.id, callerNode, now) ?? randomBytes(8).toString("hex");
  core.log.info("vault_lease_granted", { account: e.id, provider: e.provider, policy: pol, to_node: callerNode, to_handle: caller.handle, ...(req.agent ? { agent: req.agent } : {}) });
  const sealed = sealLease(secret, req.epk, req.nonce, leaseContext(e.id, callerNode, core.nodeId));
  return {
    ...sealed, owner: (me as MemberRec).handle, grant, gen: e.gen,
    ...(e.provider === "codex" ? { provider: "codex" as const, expires_at: expiresAt } : {}),
  };
}

/** Requester side: asks the owner's node, opens the sealed reply. */
export async function requestLease(
  // `node` (pre.4 merge): the owner's roster record, so the caller can pick a transport (Walkie Direct included).
  core: Core, call: (addr: { ip: string; port: number }, body: PeerLeaseReq, node: NodeRec) => Promise<PeerLeaseRes>, raw: unknown, now = Date.now(),
): Promise<{ token?: string; codex_auth?: string; expires_at?: number | null; owner: string; grant: string; gen: string }> {
  const p = LocalLeaseReq.safeParse(raw);
  if (!p.success) throw new HttpError(400, "invalid", "account (24 hex), node, optional agent and provider");
  const { account, node, agent } = p.data;
  const want = p.data.provider ?? "claude";
  if (node === core.nodeId) throw new HttpError(400, "invalid", "that account is in this machine's own vault");
  const n = core.roster.nodes.get(node);
  if (!n || n.revoked) throw new HttpError(404, "not_found", "no such machine in the team");
  const key = ephemeralKey();
  const nonce = randomBytes(16).toString("hex");
  const res = await call({ ip: n.ip, port: n.port }, { account, ...(agent ? { agent } : {}), epk: key.publicKey, nonce, ts: now }, n);
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
  return { token: opened, owner: res.owner, grant: res.grant, gen: res.gen };
}

/** An existing borrower may refresh usage, under the poller's shared throttle and provider backoff. */
export const BorrowedUsageReq = z.object({ account: AccountRef, grant: z.string().regex(/^[0-9a-f]{16}$/) }).strict();
export const BorrowedUsageRes = z.object({ usage: AccountUsage.nullable() });
export function refreshBorrowedUsage(core: Core, node: string, raw: unknown): z.infer<typeof BorrowedUsageRes> {
  const req = BorrowedUsageReq.safeParse(raw);
  if (!req.success) throw new HttpError(400, "invalid", "bad usage refresh request");
  if (!core.vaultGrants.valid(req.data.grant, req.data.account, node, Date.now())) throw new HttpError(403, "forbidden", "a current account grant is required");
  if (!core.limiter.take(`vault-usage:${node}`, { capacity: 10, perSecond: 1 / 60 }, Date.now())) throw new HttpError(429, "rate_limited", "usage refresh is throttled");
  core.vaultRefresh(req.data.account);
  return { usage: core.accounts?.accounts.find((a) => a.id === req.data.account)?.usage ?? null };
}
