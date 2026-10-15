// Joining a team through any member's node: the roster authority admits, every other node
// answers `not_authority` with the authority's address and the joiner retries there.
// Over Tailscale the authority admits a whois login on the roster; over Sqwakie Direct, an invite code.
import type { MeView } from "../protocol/schemas.ts";
import type { Core } from "./core.ts";
import { HttpError } from "./http.ts";
import { decodeInvite } from "./invite.ts";
import { decodeFleetLink } from "./fleet-link.ts";
import { JOIN_REQUEST_TTL_MS } from "./store.ts";
import { PeerCallError, parsePeerTarget, type PeerAddr, type PeerClient } from "./peer-client.ts";
import { DEFAULT_PEER_PORT } from "./roster.ts";
import type { SyncManager } from "./sync.ts";
import { addrLabel } from "./transport.ts";
import { meView } from "./views.ts";

export type JoinResult = MeView & { admitted: boolean; reason?: string };

function key(a: PeerAddr): string { return `${a.ip}:${a.port}`; }

export async function joinTeam(core: Core, sync: SyncManager, client: PeerClient, peer: string): Promise<JoinResult> {
  // An already-admitted node may re-join (idempotent) to re-pin a changed IP/port, and a node whose
  // member was removed may re-join the same team after a re-invite (adoptTeam refuses another team).
  // A node with a team id it was never admitted to must not silently switch teams.
  if (core.teamId && !core.me() && !core.roster.nodes.get(core.nodeId)?.revoked_by_removal) {
    throw new HttpError(409, "team_exists", "this node already has a team id but is not admitted; use a fresh WALKIE_HOME");
  }
  let first: PeerAddr;
  try {
    first = parsePeerTarget(peer, DEFAULT_PEER_PORT);
  } catch (err) {
    throw new HttpError(400, "invalid", (err as Error).message);
  }

  let authority: PeerAddr[] = [];
  try {
    const a = (await client.hello(first)).authority;
    authority = a ? [{ ip: a.ip, port: a.port }] : [];
  } catch (err) {
    if (err instanceof PeerCallError && err.status === 403) return { ...meView(core), admitted: false, reason: "not_member" };
    throw new HttpError(502, "peer_unreachable", `could not reach ${peer}: ${(err as Error).message}`);
  }

  const queue: PeerAddr[] = [first, ...authority];
  const tried = new Set<string>();
  while (queue.length) {
    const addr = queue.shift() as PeerAddr;
    if (tried.has(key(addr))) continue;
    tried.add(key(addr));
    let res;
    try {
      res = await client.join(addr, { pubkey: core.keys.pubkey, hostname: core.hostname, ip: core.ip, port: core.peerPort });
    } catch (err) {
      if (err instanceof PeerCallError && err.status === 403) return { ...meView(core), admitted: false, reason: err.code === "not_member" ? "not_member" : err.message };
      if (err instanceof PeerCallError && err.code === "node_limit") return { ...meView(core), admitted: false, reason: "node_limit" };
      if (err instanceof PeerCallError && err.code === "plan_limit") return { ...meView(core), admitted: false, reason: "plan_limit" };
      core.log.warn("join_attempt_failed", { peer: key(addr), err: (err as Error).message });
      continue;
    }
    if (res.admitted && res.team) return adopt(core, sync, client, addr, res.team);
    if (res.reason === "pending_approval") return { ...meView(core), admitted: false, reason: "pending_approval" };
    if (res.authority) queue.push({ ip: res.authority.ip, port: res.authority.port });
  }
  return { ...meView(core), admitted: false, reason: "not_authority" };
}

/** Admitted by the node at `addr`: take the team id, pull the whole log from it, and start syncing. */
async function adopt(core: Core, sync: SyncManager, client: PeerClient, addr: PeerAddr, team: string): Promise<JoinResult> {
  core.adoptTeam(team);
  const vv = await client.vv(addr);
  await sync.pullAll(addr, vv.vv);
  // Origins pulled before the founder's were held until the team existed: release them now.
  core.drainPending();
  if (!core.me()) throw new HttpError(502, "join_incomplete", "admitted, but the roster from the peer does not list this node yet; retry walkie join");
  // A fleet link's authority may have named this machine `<host>-2` (another machine has its name): take it.
  const renamed = core.adoptRosterHostname();
  if (renamed) core.log.info("hostname_from_roster", { hostname: renamed });
  sync.rosterChanged();
  core.log.info("joined_team", { team, via: addrLabel(addr) });
  return { ...meView(core), admitted: true };
}

/** Refusals a Direct join reports as its `reason` (the rest are transport failures, 502). */
const DIRECT_REFUSALS = new Set(["not_member", "node_limit", "plan_limit", "forbidden"]);

/**
 * `walkie join <invite-code>` (Sqwakie Direct, PROTOCOL §4): dial the roster authority named in the invite by its
 * node key (relay hint and discovery find it), present the code and this node's key, and follow at most two
 * `not_authority` redirects (the authority moved since the invite was minted). The code is never logged.
 */
export async function joinWithInvite(
  core: Core, sync: SyncManager, client: PeerClient, code: string, enableDirect: () => Promise<void>,
): Promise<JoinResult> {
  const inv = decodeInvite(code);
  if ("error" in inv) throw new HttpError(400, "invalid", "that is not a valid Sqwakie invite code (copy the whole code, starting with wk1)");
  if (core.teamId && core.teamId !== inv.team) throw new HttpError(409, "team_exists", "this node already belongs to another team; use a fresh WALKIE_HOME");
  if (core.teamId && !core.me() && !core.roster.nodes.get(core.nodeId)?.revoked_by_removal) {
    throw new HttpError(409, "team_exists", "this node already has a team id but is not admitted; use a fresh WALKIE_HOME");
  }
  await enableDirect();
  let addr: PeerAddr = { ip: "", port: DEFAULT_PEER_PORT, pubkey: inv.authority, ...(inv.relay ? { relay: inv.relay } : {}) };
  for (let hop = 0; hop < 3; hop++) {
    let res;
    try {
      res = await client.join(addr, { pubkey: core.keys.pubkey, hostname: core.hostname, ip: "", port: DEFAULT_PEER_PORT, invite: code });
    } catch (err) {
      if (err instanceof PeerCallError && err.status > 0 && (err.code.startsWith("invite_") || DIRECT_REFUSALS.has(err.code))) {
        return { ...meView(core), admitted: false, reason: err.code };
      }
      throw new HttpError(502, "peer_unreachable", `could not reach the team's roster authority over Sqwakie Direct: ${(err as Error).message}`);
    }
    if (res.admitted && res.team) {
      // The code names its team; a machine (the invite's authority, or one it redirected to) that admits us into
      // any other team is not the one the owner sent us to.
      if (res.team !== inv.team) throw new HttpError(502, "team_mismatch", "the machine that answered admitted this node to a different team than the invite's; nothing was joined");
      return adopt(core, sync, client, addr, res.team);
    }
    if (res.reason === "pending_approval") return { ...meView(core), admitted: false, reason: "pending_approval" };
    if (!res.authority?.pubkey || res.authority.pubkey === addr.pubkey) break;
    addr = { ip: "", port: DEFAULT_PEER_PORT, pubkey: res.authority.pubkey };
  }
  return { ...meView(core), admitted: false, reason: "not_authority" };
}

// ---- fleet links (FLEET-LINK-1, PROTOCOL §4 "Fleet links") ------------------------------------------------------------

/** Refusals a fleet-link join reports as its `reason`, besides `link_*` codes. */
const LINK_REFUSALS = new Set(["not_member", "node_limit", "plan_limit", "forbidden", "rate_limited", "join_limit"]);

/**
 * `walkie join <fleet link>` / `walkie setup --join-link`: like an invite (joinWithInvite), but the token may admit
 * many machines. With an approve-each-machine link the authority queues this machine: it then keeps asking in the
 * background (startLinkWait) and joins by itself once an owner approves it. The token is never logged or kept.
 */
export async function joinWithLink(
  core: Core, sync: SyncManager, client: PeerClient, token: string, enableDirect: () => Promise<void>,
): Promise<JoinResult> {
  const link = decodeFleetLink(token);
  if ("error" in link) throw new HttpError(400, "invalid", "that is not a valid Sqwakie fleet link (copy the whole link or command again: the token starts with wl1)");
  if (core.teamId && core.teamId !== link.team) throw new HttpError(409, "team_exists", "this node already belongs to another team; use a fresh WALKIE_HOME");
  if (core.teamId && !core.me() && !core.roster.nodes.get(core.nodeId)?.revoked_by_removal) {
    throw new HttpError(409, "team_exists", "this node already has a team id but is not admitted; use a fresh WALKIE_HOME");
  }
  if (core.teamId && core.me()) return { ...meView(core), admitted: true };
  await enableDirect();
  let addr: PeerAddr = { ip: "", port: DEFAULT_PEER_PORT, pubkey: link.authority, ...(link.relay ? { relay: link.relay } : {}) };
  for (let hop = 0; hop < 3; hop++) {
    let res;
    try {
      res = await client.join(addr, { pubkey: core.keys.pubkey, hostname: core.hostname, ip: "", port: DEFAULT_PEER_PORT, link: token });
    } catch (err) {
      if (err instanceof PeerCallError && err.status > 0 && (err.code.startsWith("link_") || LINK_REFUSALS.has(err.code))) {
        return { ...meView(core), admitted: false, reason: err.code };
      }
      throw new HttpError(502, "peer_unreachable", `could not reach the team's roster authority over Sqwakie Direct: ${(err as Error).message}`);
    }
    if (res.admitted && res.team) {
      if (res.team !== link.team) throw new HttpError(502, "team_mismatch", "the machine that answered admitted this node to a different team than the link's; nothing was joined");
      stopLinkWait(core);
      return adopt(core, sync, client, addr, res.team);
    }
    if (res.reason === "pending_approval") {
      startLinkWait(core, sync, client, addr, link.team);
      return { ...meView(core), admitted: false, reason: "pending_approval" };
    }
    if (!res.authority?.pubkey || res.authority.pubkey === addr.pubkey) break;
    addr = { ip: "", port: DEFAULT_PEER_PORT, pubkey: res.authority.pubkey };
  }
  return { ...meView(core), admitted: false, reason: "not_authority" };
}

/** How often a machine waiting for an owner's approval asks again, and for how long (tests shorten it). */
export const LINK_WAIT = { intervalMs: 10_000, maxMs: JOIN_REQUEST_TTL_MS };
const LINK_WAIT_META = "link_wait";
const waiters = new WeakMap<Core, { stop(): void }>();

interface WaitState { team: string; pubkey: string; relay?: string; since: number }

/**
 * A machine an approve-each-machine link queued: asks the authority again (with its key only; the token isn't kept)
 * until an owner approved it, then joins. Persisted without the token (store meta), so a restart resumes it; gives up
 * after a day (the authority drops the request then too).
 */
export function startLinkWait(core: Core, sync: SyncManager, client: PeerClient, addr: PeerAddr, team: string, since = Date.now()): void {
  stopLinkWait(core);
  const state: WaitState = { team, pubkey: addr.pubkey as string, ...(addr.relay ? { relay: addr.relay } : {}), since };
  core.store.setMeta(LINK_WAIT_META, JSON.stringify(state));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); };
  const finish = () => { stop(); try { core.store.deleteMeta(LINK_WAIT_META); } catch { /* closed */ } waiters.delete(core); };
  const tick = async () => {
    if (stopped) return;
    try {
      if (core.me()) return finish();
      if (Date.now() - state.since > LINK_WAIT.maxMs) {
        core.log.warn("link_wait_gave_up", { team });
        return finish();
      }
      const res = await client.join(addr, { pubkey: core.keys.pubkey, hostname: core.hostname, ip: "", port: DEFAULT_PEER_PORT });
      if (!stopped && res.admitted && res.team === team) {
        await adopt(core, sync, client, addr, team);
        core.log.info("link_wait_admitted", { team });
        return finish();
      }
    } catch (err) {
      if (stopped) return;
      const fields = { team, err: err instanceof Error ? err.message : String(err), ...(err instanceof PeerCallError ? { code: err.code, status: err.status } : {}) };
      if (err instanceof PeerCallError && err.status === 403 && (err.code === "forbidden" || err.code.startsWith("link_"))) {
        core.log.warn("link_wait_refused", fields);
        return finish();
      }
      // Includes legacy authorities' not_member responses and transient transport failures.
      core.log.warn("link_wait_failed", fields);
    }
    // After half an hour without an answer, once a minute; terminal refusals stop immediately.
    const wait = Date.now() - state.since > 30 * 60_000 ? Math.max(LINK_WAIT.intervalMs, 60_000) : LINK_WAIT.intervalMs;
    if (!stopped) { timer = setTimeout(() => void tick(), wait); timer.unref?.(); }
  };
  timer = setTimeout(() => void tick(), LINK_WAIT.intervalMs);
  timer.unref?.();
  waiters.set(core, { stop });
}

export function stopLinkWait(core: Core): void {
  waiters.get(core)?.stop();
  waiters.delete(core);
}

/** At startup: a machine still waiting for approval (persisted by startLinkWait) keeps asking. */
export async function resumeLinkWait(core: Core, sync: SyncManager, client: PeerClient, enableDirect: () => Promise<unknown>): Promise<void> {
  const raw = core.store.getMeta(LINK_WAIT_META);
  if (!raw) return;
  let s: WaitState;
  try { s = JSON.parse(raw) as WaitState; } catch { core.store.deleteMeta(LINK_WAIT_META); return; }
  if (core.me() || typeof s.pubkey !== "string" || typeof s.team !== "string" || Date.now() - s.since > LINK_WAIT.maxMs) {
    core.store.deleteMeta(LINK_WAIT_META);
    return;
  }
  await enableDirect();
  startLinkWait(core, sync, client, { ip: "", port: DEFAULT_PEER_PORT, pubkey: s.pubkey, ...(typeof s.relay === "string" ? { relay: s.relay } : {}) }, s.team, s.since);
}
