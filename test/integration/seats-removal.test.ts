// PRE4 RC (Opus 1): removing a member takes them out of every restricted channel (core.ts dropFromRestricted),
// someone else's seats channel included: the authority may narrow a seats channel to drop members no longer on the
// team (roster.ts seatsChannelRule), and nothing more. A re-invite does not put them back.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { WalkieError } from "../../src/client/index.ts";
import { seatsChannel } from "../../src/protocol/seats.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode, bob: TestNode, eve: TestNode;

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bob-mbp" });
  eve = await c.add({ name: "eve", login: "eve@example.com", hostname: "eve-mbp" });
  await alex.client().init("acme", "alex");
  for (const [n, h] of [[bob, "bob"], [eve, "eve"]] as const) {
    await alex.client().invite(`${h}@example.com`, h, "member");
    expect((await n.client().join(alex.peerAddr)).admitted).toBe(true);
  }
}, 60_000);
afterAll(async () => { await c.close(); });

test("eve's removal drops her from bob's seats channel on the authority; a re-invite doesn't bring her back", async () => {
  const name = seatsChannel(bob.d.nodeId);
  // bob's machine shapes its own seats channel (as its seats host does), through the authority.
  await bob.client().request("POST", "/v1/channels", { name, members: ["bob", "eve"], seats: true });
  await waitFor(() => alex.d.core.roster.channels.get(name)?.members?.length === 2, { timeoutMs: 10_000, what: "the seats channel on the authority" });
  expect(alex.d.core.roster.channels.get(name)).toMatchObject({ members: ["bob", "eve"], seats: true });

  const e = { login: "eve@example.com", handle: "eve" };
  alex.d.core.emit("team.member", { ...e, role: "removed" });
  expect(alex.d.core.roster.channels.get(name)).toMatchObject({ members: ["bob"], seats: true });
  alex.d.core.emit("team.member", { ...e, role: "member" });
  expect(alex.d.core.roster.channels.get(name)?.members).toEqual(["bob"]);
  await waitFor(() => bob.d.core.roster.channels.get(name)?.members?.join(",") === "bob", { timeoutMs: 10_000, what: "bob's replica follows" });
});

test("the authority still can't add anyone to (or otherwise change) someone else's seats channel", async () => {
  const name = seatsChannel(bob.d.nodeId);
  expect(() => alex.d.core.emit("channel.upsert", { name, members: ["bob", "alex"] })).toThrow(/reserved_name/);
  expect(() => alex.d.core.emit("channel.upsert", { name, topic: "mine now" })).toThrow(/reserved_name/);
  const refused = await alex.client().request("POST", "/v1/channels", { name, members: ["bob", "eve"] }).then(() => null, (err: unknown) => err as WalkieError);
  expect(refused?.status).toBe(403);
});
