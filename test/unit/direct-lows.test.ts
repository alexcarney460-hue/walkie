// DIRECT-FIX-1, the Opus audit's cheap LOWs: the Direct gate compares the stored key (not only its 64-bit node id);
// a joiner refuses to adopt a team other than its invite's; a pasted code with whitespace still takes the invite
// path, and no error echoes a code.
import { afterEach, describe, expect, test } from "bun:test";
import { createInvite } from "../../src/daemon/invite.ts";
import { joinWithInvite } from "../../src/daemon/join.ts";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import type { PeerClient } from "../../src/daemon/peer-client.ts";
import type { Roster } from "../../src/daemon/roster.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { nodeIdFromPubkey } from "../../src/protocol/ids.ts";
import { makeCore } from "../helpers/core.ts";
import { now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const directBody = (who: ReturnType<typeof tnode>) => ({
  node_id: who.keys.nodeId, login: who.login, hostname: who.hostname, pubkey: who.keys.pubkey, ip: "",
  endpoint: Buffer.from(who.keys.pubkey, "base64").toString("hex"), transports: ["direct"],
});

function directTeam() {
  const alex = tnode("alex", "direct:alex");
  const kira = tnode("kira", "direct:kira");
  const core = makeCore(alex, "0000000000000000", cleanups);
  core.store.deleteMeta("team");
  core.createTeam("acme", "alex", { login: alex.login });
  core.emit("team.node", directBody(alex));
  core.emit("team.member", { login: kira.login, handle: "kira", role: "member" });
  core.emit("team.node", directBody(kira));
  return { alex, kira, core, team: core.teamId as string };
}

describe("Direct gate: the stored key, not only the node id", () => {
  test("a key whose 64-bit node id collides with a member's node gets 403, not that member's access", async () => {
    const w = directTeam();
    const mallory = tnode("mallory");
    const kiraNode = w.core.roster.nodes.get(w.kira.keys.nodeId);
    if (!kiraNode) throw new Error("kira's node missing");
    // Simulated collision: kira's record under mallory's node id (the key stored is still kira's).
    const collided = nodeIdFromPubkey(mallory.keys.pubkey);
    const real = w.core.roster;
    const patched: Roster = { ...real, nodes: new Map(real.nodes).set(collided, { ...kiraNode, node_id: collided }) };
    Object.defineProperty(w.core, "roster", { get: () => patched, configurable: true });
    const req = new Request("http://walkie.direct/peer/v1/vv", { headers: { "X-Walkie-Team": w.team } });
    const res = await new PeerApi(w.core).handle(req, { kind: "direct", pubkey: mallory.keys.pubkey });
    expect(res.status).toBe(403);
    // kira's own key still passes.
    const ok = await new PeerApi(w.core).handle(new Request("http://walkie.direct/peer/v1/vv", { headers: { "X-Walkie-Team": w.team } }), { kind: "direct", pubkey: w.kira.keys.pubkey });
    expect(ok.status).toBe(200);
  });
});

describe("joinWithInvite", () => {
  test("a machine that admits us into a team other than the invite's is refused before anything is adopted", async () => {
    const owner = tnode("owner");
    const joiner = tnode("joiner");
    const core = makeCore(joiner, "", cleanups);
    core.store.deleteMeta("team");
    const inv = createInvite(owner.keys, { team: "aaaaaaaaaaaaaaaa", authority: owner.keys.pubkey, handle: "joiner", role: "member", now: now(), pos: 0 });
    let pulled = false;
    const client = {
      join: async () => ({ admitted: true, team: "bbbbbbbbbbbbbbbb", node_id: joiner.keys.nodeId }),
      vv: async () => { pulled = true; return { node: "x", vv: {}, ts: 0 }; },
    } as unknown as PeerClient;
    const sync = { pullAll: async () => undefined, rosterChanged: () => undefined } as unknown as SyncManager;
    const err = await joinWithInvite(core, sync, client, inv.code, async () => undefined).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: "team_mismatch" });
    expect(core.teamId).toBeNull();
    expect(pulled).toBe(false);
  });
});

describe("POST /v1/join with a pasted code", () => {
  async function joinRoute(peer: string) {
    const joiner = tnode("joiner");
    const core = makeCore(joiner, "", cleanups);
    core.store.deleteMeta("team");
    const req = new Request("http://127.0.0.1/v1/join", { method: "POST", body: JSON.stringify({ peer }) });
    const ctx = { core, req, url: new URL(req.url), noTimeout: () => undefined } as unknown as RouteCtx;
    return dispatch(ctx).then((r) => ({ status: r.status, code: "", message: "" }), (e: { status: number; code: string; message: string }) => e);
  }
  const owner = tnode("owner");
  const code = createInvite(owner.keys, { team: "aaaaaaaaaaaaaaaa", authority: owner.keys.pubkey, handle: "joiner", role: "member", now: now(), pos: 0 }).code;

  test("trailing and embedded whitespace is dropped and the code takes the invite path; the error doesn't echo it", async () => {
    for (const pasted of [`${code}\n`, `  ${code}  `, `${code.slice(0, 80)}\n${code.slice(80)}`]) {
      const res = await joinRoute(pasted);
      // No Walkie Direct in this bare route context: reaching it proves the invite path was taken.
      expect(res).toMatchObject({ status: 503, code: "direct_unavailable" });
      expect(res.message).not.toContain(code.slice(3, 40));
    }
  });

  test("a damaged code is refused as an invite, without echoing it", async () => {
    const damaged = `${code.slice(0, 60)}.!${code.slice(62)}`;
    const res = await joinRoute(damaged.replace(".", ""));
    expect(res.status).toBe(400);
    expect(res.message).not.toContain(code.slice(3, 40));
  });
});
