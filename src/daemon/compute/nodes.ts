// Which machine a rental became, and ending it on the team (RENT-2). The node is found on the CHAIN: the `team.node`
// admission that used one of the rental's invite ids (the codes this daemon minted). The site's `node_id` is what the
// rented box reports about itself, so it is shown, never trusted for a revocation.
import type { Core } from "../core.ts";
import type { PeerClient } from "../peer-client.ts";
import { HttpError } from "../http.ts";
import { submitRequest, type CatchUp } from "../requests.ts";
import { transportFields } from "../roster.ts";

/** How many recent `team.node` events are searched for an admission (a team adds far fewer machines than this). */
const SCAN_LIMIT = 2_000;

/** Invite id → the node its `team.node` admission admitted, from the chain (one scan per poll round). */
export function invitedNodes(core: Core): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const row of core.store.queryEvents({ kinds: ["team.node"], limit: SCAN_LIMIT })) {
    let body: { invite?: unknown; node_id?: unknown } | undefined;
    try { body = (JSON.parse(row.json) as { body?: { invite?: unknown; node_id?: unknown } }).body; } catch { continue; }
    if (typeof body?.invite === "string" && typeof body.node_id === "string" && !out.has(body.invite)) out.set(body.invite, body.node_id);
  }
  return out;
}

/** The node admitted with one of `inviteIds`, or null when none (yet). */
export function nodeForInvites(nodes: ReadonlyMap<string, string>, inviteIds: readonly string[]): string | null {
  for (const id of inviteIds) {
    const n = nodes.get(id);
    if (n) return n;
  }
  return null;
}

/**
 * What ending a rented machine on the team came to:
 * - `revoked` / `already`: the roster shows the machine revoked (now, or an owner had done it): confirmed.
 * - `queued`: asked for, but not confirmed here yet (waiting for the roster authority to be reachable, or accepted by it
 *   and not yet synced). The machine is still admitted.
 * - `refused`: it cannot be revoked this way (see `reason`); the machine is still admitted.
 * - `held`: the caller asked not to send anything now (a request was accepted a moment ago, or a refusal is backing off)
 *   and the roster doesn't show the machine revoked: the earlier answer stands.
 * - `unknown_node`: the roster has no such machine.
 */
export type RevokeOutcome = "revoked" | "queued" | "already" | "unknown_node" | "refused" | "held";

export interface RevokeResult {
  readonly outcome: RevokeOutcome;
  /** In plain words, why a `refused` one was (shown to owners; never a peer's own text). */
  readonly reason?: string;
  /** With `queued`: the authority accepted the request but this daemon's roster doesn't show it yet (it is not queued here). */
  readonly accepted?: boolean;
}

/** Whether `outcome` is a confirmed revocation (the only outcome that ends a rental's watch). */
export function revocationConfirmed(outcome: RevokeOutcome): boolean {
  return outcome === "revoked" || outcome === "already";
}

export interface RevokeDeps { readonly core: Core; readonly client: PeerClient; readonly catchUp: CatchUp }

/** How many queued roster requests are searched for a revocation already waiting (the queue is a handful of rows). */
const QUEUE_SCAN_LIMIT = 1_000;

/** Whether a revocation of `nodeId` is already waiting in this daemon's queue for the authority (survives a restart). */
export function revocationQueued(core: Core, nodeId: string): boolean {
  for (const q of core.store.queuedRequests(QUEUE_SCAN_LIMIT)) {
    try {
      const req = JSON.parse(q.json) as { kind?: unknown; body?: { node_id?: unknown; revoked?: unknown } };
      if (req.kind === "team.node" && req.body?.node_id === nodeId && req.body.revoked === true) return true;
    } catch { continue; } // a damaged row is for the queue flush to drop
  }
  return false;
}

/** The authority's refusal in plain words: its code only when it is a plain code (the peer's own text is never shown). */
function authorityRefusal(err: HttpError): string {
  const code = /^[a-z0-9_]{1,40}$/.test(err.code) ? ` (${err.code})` : "";
  return `the team's roster authority refused the request${code}`;
}

/**
 * Revokes a rented machine as `walkie team revoke` does (a `team.node` with revoked: true): directly on the roster
 * authority, else as a roster request (queued while the authority is unreachable). Never this machine or the authority.
 * Only `revoked` and `already` mean the machine is off the team. A revocation already queued here is not sent again, so
 * calling this on every round is safe; the authority's refusal comes back as `refused` with its reason. With `hold` it
 * still checks the roster (an owner may have revoked it meanwhile) but sends nothing.
 */
export async function revokeRentedNode(d: RevokeDeps, nodeId: string, hold = false): Promise<RevokeResult> {
  const n = d.core.roster.nodes.get(nodeId);
  if (!n) return { outcome: "unknown_node" };
  if (n.revoked) return { outcome: "already" };
  if (hold) return { outcome: "held" };
  if (nodeId === d.core.nodeId) return { outcome: "refused", reason: "the rented machine is the one running this compute service" };
  if (nodeId === d.core.authority) {
    return { outcome: "refused", reason: "the rented machine is the team's roster authority; move authority to another owner machine (walkie team authority <machine>), then revoke it (walkie team revoke <machine>)" };
  }
  if (revocationQueued(d.core, nodeId)) return { outcome: "queued" };
  const body = { node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port, revoked: true, ...transportFields(n) };
  if (d.core.isAuthority()) {
    d.core.emit("team.node", body as never);
    return { outcome: "revoked" };
  }
  let res: Awaited<ReturnType<typeof submitRequest>>;
  try {
    res = await submitRequest(d.core, d.client, d.catchUp, "team.node", body);
  } catch (err) {
    if (err instanceof HttpError) return { outcome: "refused", reason: authorityRefusal(err) };
    throw err;
  }
  if ("queued" in res) return { outcome: "queued" };
  // The authority took it; confirmed once this node's own roster shows it (the event arrives with the catch-up or sync).
  return d.core.roster.nodes.get(nodeId)?.revoked ? { outcome: "revoked" } : { outcome: "queued", accepted: true };
}
