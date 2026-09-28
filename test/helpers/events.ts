// Builders for signed events in unit tests.
import { deriveTeamId, eventId } from "../../src/protocol/ids.ts";
import { PROTOCOL_VERSION, type BodyOf, type Event, type Kind } from "../../src/protocol/schemas.ts";
import { generateKeys, signEvent, type NodeKeys } from "../../src/daemon/keys.ts";

export interface TNode { keys: NodeKeys; handle: string; login: string; seq: number; hostname: string }

export function tnode(handle: string, login = `${handle}@example.com`, hostname = `${handle}-mbp`): TNode {
  return { keys: generateKeys(), handle, login, seq: 0, hostname };
}

let clock = 1_700_000_000_000;
export function tick(): number { clock += 1000; return clock; }
/** The simulated wall clock (the last tick): Cores built for unit tests judge plans at this time. */
export function now(): number { return clock; }

export function ev<K extends Kind>(
  team: string, n: TNode, kind: K, body: BodyOf<K>, opts: { channel?: string; agent?: string; ts?: number; handle?: string } = {},
): Event {
  n.seq += 1;
  return signEvent(n.keys, {
    v: PROTOCOL_VERSION, team, id: eventId(n.keys.nodeId, n.seq), origin: n.keys.nodeId, seq: n.seq, ts: opts.ts ?? tick(),
    author: { handle: opts.handle ?? n.handle, node: n.keys.nodeId, ...(opts.agent ? { agent: opts.agent } : {}) },
    kind, ...(opts.channel ? { channel: opts.channel } : {}), body,
  });
}

export function createTeam(owner: TNode, name = "acme"): { team: string; create: Event } {
  const ts = tick();
  const team = deriveTeamId(owner.keys.pubkey, name, ts);
  const create = ev(team, owner, "team.create", {
    name, owner_login: owner.login, owner_handle: owner.handle, node_hostname: owner.hostname,
    node_pubkey: owner.keys.pubkey, node_ip: "127.0.0.1", node_port: 7458,
  }, { ts });
  return { team, create };
}

export function memberEv(team: string, by: TNode, who: TNode, role: "owner" | "member" | "observer" | "removed"): Event {
  return ev(team, by, "team.member", { login: who.login, handle: who.handle, role });
}

export function nodeEv(team: string, by: TNode, who: TNode, revoked = false): Event {
  return ev(team, by, "team.node", {
    node_id: who.keys.nodeId, login: who.login, hostname: who.hostname, pubkey: who.keys.pubkey, ip: "127.0.0.1",
    ...(revoked ? { revoked: true } : {}),
  });
}
