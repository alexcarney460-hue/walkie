import { expect, test, afterEach } from "bun:test";
import { makeCore } from "../../../test/helpers/core.ts";
import { createTeam, tnode } from "../../../test/helpers/events.ts";
import { PeerApi } from "../peer-api.ts";
import { skillHash } from "./catalog.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

test("catalog posts and later ordinary posts cross an old peer's contiguous stream", () => {
  const owner = tnode("owner"), peer = tnode("peer");
  const { team, create } = createTeam(owner);
  const core = makeCore(owner, team, cleanups);
  core.ingest(create, "local");
  core.emit("team.member", { login: peer.login, handle: peer.handle, role: "member" });
  core.emit("team.node", { node_id: peer.keys.nodeId, login: peer.login, hostname: peer.hostname,
    pubkey: peer.keys.pubkey, ip: "127.0.0.1" });
  core.emit("channel.upsert", { name: "skills" });
  const text = "---\nname: careful-review\ndescription: Review carefully.\nuses: [walkie_skill]\n---\nRead the diff.\n";
  const proposal = core.emit("msg.post", { text: "proposed skill careful-review", skill: {
    op: "propose", name: "careful-review", sha256: skillHash(text), text } }, { channel: "skills" });
  const approval = core.emit("msg.post", { text: "approved skill careful-review", skill: {
    op: "approve", name: "careful-review", sha256: skillHash(text) } }, { channel: "skills" });
  const later = core.emit("msg.post", { text: "later ordinary message" }, { channel: "skills" });
  const api = new PeerApi(core) as unknown as { serveEvents(url: URL, handle: string): { events: Array<{ kind: string; id: string }> } };
  const path = new URL(`http://localhost/peer/v1/events?origin=${owner.keys.nodeId}&after=4`);
  expect(api.serveEvents(path, peer.handle).events.map((e) => e.id)).toEqual([proposal.id, approval.id, later.id]);
  expect(api.serveEvents(path, peer.handle).events.map((e) => e.kind)).toEqual(["msg.post", "msg.post", "msg.post"]);
});
