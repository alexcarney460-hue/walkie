// Candidate ordering only: divergent heartbeat views may choose different candidates during a partition.
// Acting requires an exclusive renewable lease from the roster authority (leadership.ts), including manual starts.

export const LEAD_OFFLINE_MS = 5 * 60_000;

export interface LeadNode {
  node_id: string; hostname: string; handle: string;
  online: boolean; last_seen: number | null;
}

export interface LeadInput {
  self: string;
  authority: string | null;
  nodes: readonly LeadNode[];
  /** Handles of the team's owners. */
  owners: ReadonlySet<string>;
  /** Whether a machine may lead (self: its own login and switches; peers: their WalkieTalkie status). */
  eligible: (nodeId: string) => boolean;
  now: number;
  offlineMs?: number;
}

/** The machines in lead order: the authority first, then the owners' machines by node id. */
export function leadOrder(i: Pick<LeadInput, "authority" | "nodes" | "owners">): LeadNode[] {
  const auth = i.nodes.find((n) => n.node_id === i.authority);
  const owners = i.nodes.filter((n) => n.node_id !== i.authority && i.owners.has(n.handle))
    .sort((a, b) => (a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0));
  return [...(auth ? [auth] : []), ...owners];
}

function fresh(n: LeadNode, i: LeadInput): boolean {
  if (n.node_id === i.self || n.online) return true;
  return n.last_seen !== null && i.now - n.last_seen < (i.offlineMs ?? LEAD_OFFLINE_MS);
}

/** Preferred candidate; this result alone never authorizes leadership. */
export function electLead(i: LeadInput): LeadNode | null {
  return leadOrder(i).find((n) => fresh(n, i) && i.eligible(n.node_id)) ?? null;
}
