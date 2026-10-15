import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { JOIN_REQUEST_TTL_MS } from "../../src/daemon/store.ts";

setDefaultTimeout(60_000);
let c: Cluster, owner: TestNode, otherOwner: TestNode;
let offset = 0;
const clock = () => Date.now() + offset;
beforeAll(async () => {
  c = new Cluster();
  owner = await c.add({ name: "owner", login: "-", direct: true, clock });
  otherOwner = await c.add({ name: "other-owner", login: "-", direct: true, clock });
  await owner.client().init("fixture", "owner");
  await otherOwner.client().join((await owner.client().inviteCode("other-owner", "owner")).code);
  const member = await c.add({ name: "target", login: "-", direct: true, clock });
  await member.client().join((await owner.client().inviteCode("target", "member")).code);
  await waitFor(() => otherOwner.d.core.roster.members.has("direct:target"));
});
afterAll(async () => { await c?.close(); });

for (const forwarded of [false, true]) test(`${forwarded ? "forwarded signed" : "local"} owner cannot decide a replacement owner request from a stale member row`, async () => {
  const decider = forwarded ? otherOwner : owner;
  const a = await owner.client().mintLink({ for: "target", approve: true, expires_days: 30 });
  const b = await owner.client().mintLink({ for: "owner", owner_machines: true, approve: true, expires_days: 30 });
  const n = await c.add({ name: forwarded ? "forwarded-waiter" : "local-waiter", login: "-", direct: true, clock });
  expect((await n.client().joinLink(a.token)).reason).toBe("pending_approval");
  const displayed = (await decider.client().links()).uses.find(u => u.node_id === n.d.nodeId && u.state === "pending")!;
  expect(typeof displayed.generation).toBe("string");
  offset += JOIN_REQUEST_TTL_MS + 1000;
  expect((await n.client().joinLink(b.token)).reason).toBe("pending_approval");
  const current = owner.d.core.store.joinRequest(n.d.nodeId, clock())!;
  for (const approve of [true, false]) {
    await expect(decider.client().request("POST", "/v1/team/admit-link", {
      node_id: displayed.node_id, link: displayed.link, generation: displayed.generation, approve,
    })).rejects.toMatchObject({ status: 409, code: "stale_join_request" });
    expect(owner.d.core.store.joinRequest(n.d.nodeId, clock())).toEqual(current);
    await expect(decider.client().request("POST", "/v1/team/admit", { node_id: n.d.nodeId, approve }))
      .rejects.toMatchObject({ status: 409, code: "stale_join_request" });
  }
  const refreshed = (await decider.client().links()).uses;
  expect(refreshed.some(u => u.link === a.id && u.state === "pending")).toBe(false);
  const fresh = refreshed.find(u => u.link === b.id && u.node_id === n.d.nodeId)!;
  await decider.client().request("POST", "/v1/team/admit-link", { node_id: fresh.node_id, link: fresh.link, generation: fresh.generation, approve: true });
  expect(owner.d.core.roster.nodes.get(n.d.nodeId)?.login).toBe("direct:owner");
});

test("an agent cannot approve or deny a pending machine through either admission route", async () => {
  const link = await owner.client().mintLink({ for: "target", approve: true, expires_days: 30 });
  const waiting = await c.add({ name: "agent-decision-waiter", login: "-", direct: true, clock });
  expect((await waiting.client().joinLink(link.token)).reason).toBe("pending_approval");
  const pending = (await owner.client().links()).uses.find(u => u.node_id === waiting.d.nodeId && u.state === "pending")!;
  for (const approve of [true, false]) {
    await expect(owner.client("helper").request("POST", "/v1/team/admit-link", {
      node_id: pending.node_id, link: pending.link, generation: pending.generation, approve,
    })).rejects.toMatchObject({ status: 403, code: "person_only" });
    await expect(owner.client("helper").request("POST", "/v1/team/admit", { node_id: pending.node_id, approve }))
      .rejects.toMatchObject({ status: 403, code: "person_only" });
    expect(owner.d.core.store.joinRequest(waiting.d.nodeId, clock())).toBeDefined();
  }
  await owner.client().request("POST", "/v1/team/admit-link", {
    node_id: pending.node_id, link: pending.link, generation: pending.generation, approve: true,
  });
  expect(owner.d.core.roster.nodes.get(waiting.d.nodeId)?.login).toBe("direct:target");
});
