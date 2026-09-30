import { newPeerNonce, signPeerRequest } from "../../src/daemon/peer-sig.ts";
import type { TestNode } from "./cluster.ts";

/** Send a raw peer probe under the same node-key boundary as PeerClient. */
export function signedPeerFetch(from: TestNode, to: TestNode, path: string,
  init: { method?: "GET" | "POST"; body?: string } = {}): Promise<Response> {
  const url = new URL(path, `http://127.0.0.1:${to.peerPort}`);
  const method = init.method ?? "GET";
  const body = init.body ?? "";
  const team = from.d.core.teamId ?? "";
  const sig = signPeerRequest(from.d.core.keys, { method, path: url.pathname, query: url.search, body,
    requester: from.d.nodeId, target: to.d.nodeId, team, ts: Date.now(), nonce: newPeerNonce() });
  return fetch(url, { method, headers: { "content-type": "application/json", "x-walkie-node": from.d.nodeId,
    "x-walkie-team": team, ...sig }, ...(method === "POST" ? { body } : {}) });
}
