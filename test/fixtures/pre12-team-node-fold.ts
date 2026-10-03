/**
 * Node-record fold from 66ccde8e6a5590716d00a88c588042dc30601cc7 (v0.2.0-pre.12).
 *
 * `pre12NodeRecOf` is `nodeRecOf` from that commit. `pre12FoldNodes` applies it in the
 * `team.node` branch of that commit's `applyKind`, and applies the same commit's
 * `team.create` and removing `team.member` branches so a whole chain's node map can be
 * compared. Invite ids and member spend counts are not part of the node record.
 * The unit test uses this file instead of calling git.
 */
import type { Event } from "../../src/protocol/schemas.ts";

const DEFAULT_PEER_PORT = 7458;
const TRANSPORTS = ["tailscale", "direct"] as const;
type Transport = (typeof TRANSPORTS)[number];

export interface Pre12Node {
  readonly node_id: string;
  readonly login: string;
  readonly hostname: string;
  readonly pubkey: string;
  readonly ip: string;
  readonly port: number;
  readonly revoked: boolean;
  readonly revoked_by_removal?: boolean;
  readonly peer_sig_v1?: true;
  readonly transports?: readonly Transport[];
}

interface NodeBody {
  readonly node_id: string;
  readonly login: string;
  readonly hostname: string;
  readonly pubkey: string;
  readonly ip: string;
  readonly port?: number;
  readonly revoked?: boolean;
  readonly transports?: readonly string[];
  readonly peer_sig_v1?: boolean;
}

function knownTransports(names: readonly string[] | undefined): Transport[] | undefined {
  if (!names) return undefined;
  const known = TRANSPORTS.filter((t) => names.includes(t));
  return known.length ? [...known] : undefined;
}

/** `nodeRecOf` from 66ccde8e6a5590716d00a88c588042dc30601cc7. */
export function pre12NodeRecOf(b: NodeBody, previous?: Pre12Node): Pre12Node {
  const transports = knownTransports(b.transports);
  return {
    node_id: b.node_id, login: b.login, hostname: b.hostname, pubkey: b.pubkey, ip: b.ip,
    port: b.port ?? DEFAULT_PEER_PORT, revoked: b.revoked === true, ...(transports ? { transports } : {}),
    ...(b.peer_sig_v1 === true || previous?.peer_sig_v1 ? { peer_sig_v1: true as const } : {}),
  };
}

function founderNode(ev: Event): Pre12Node {
  const b = ev.body as {
    owner_login: string; node_hostname: string; node_pubkey: string; node_ip: string; node_port?: number; peer_sig_v1?: boolean;
  };
  return {
    node_id: ev.origin, login: b.owner_login, hostname: b.node_hostname, pubkey: b.node_pubkey,
    ip: b.node_ip, port: b.node_port ?? DEFAULT_PEER_PORT, revoked: false,
    ...(b.peer_sig_v1 ? { peer_sig_v1: true as const } : {}),
  };
}

/** Node map after one roster event, folded the way 66ccde8e folds node records. */
export function pre12FoldNodes(nodes: ReadonlyMap<string, Pre12Node>, ev: Event): Map<string, Pre12Node> {
  if (ev.kind === "team.create") {
    const node = founderNode(ev);
    return new Map(nodes).set(node.node_id, node);
  }
  if (ev.kind === "team.member") {
    const b = ev.body as { login?: string; role?: string };
    if (b.role !== "removed" || typeof b.login !== "string") return new Map(nodes);
    const next = new Map(nodes);
    for (const n of nodes.values()) {
      if (n.login === b.login) next.set(n.node_id, n.revoked ? n : { ...n, revoked: true, revoked_by_removal: true });
    }
    return next;
  }
  if (ev.kind === "team.node") {
    const b = ev.body as unknown as NodeBody;
    return new Map(nodes).set(b.node_id, pre12NodeRecOf(b, nodes.get(b.node_id)));
  }
  return new Map(nodes);
}
