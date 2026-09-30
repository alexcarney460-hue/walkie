// Which machine a rental became, and ending it on the team (RENT-2). The node is found on the CHAIN: the `team.node`
// admission that used one of the rental's invite ids (the codes this daemon minted). The site's `node_id` is what the
// rented box reports about itself, so it is shown, never trusted for a revocation.
import type { Core } from "../core.ts";
import type { PeerClient } from "../peer-client.ts";
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

export type RevokeOutcome = "revoked" | "queued" | "already" | "unknown_node" | "refused";

export interface RevokeDeps { readonly core: Core; readonly client: PeerClient; readonly catchUp: CatchUp }

/**
 * Revokes a rented machine as `walkie team revoke` does (a `team.node` with revoked: true): directly on the roster
 * authority, else as a roster request (queued while the authority is unreachable). Never this machine or the authority.
 */
export async function revokeRentedNode(d: RevokeDeps, nodeId: string): Promise<RevokeOutcome> {
  const n = d.core.roster.nodes.get(nodeId);
  if (!n) return "unknown_node";
  if (n.revoked) return "already";
  if (nodeId === d.core.nodeId || nodeId === d.core.authority) return "refused";
  const body = { node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port, revoked: true, ...transportFields(n) };
  if (d.core.isAuthority()) {
    d.core.emit("team.node", body as never);
    return "revoked";
  }
  const res = await submitRequest(d.core, d.client, d.catchUp, "team.node", body);
  return "queued" in res ? "queued" : "revoked";
}
