// The client-side "you aren't a launcher" refusal (seats/routes.ts target()): a team member who was never a
// launcher (not an owner, not listed) isn't even in the host's seats channel, so `walkie seat run` is refused
// locally, before any request reaches the host. Alex: this refusal should say the exact fix and whose machine's
// person runs it, like the ones the host itself posts back (seats.test.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { noKeychainSeats } from "../helpers/no-keychain.ts";

let c: Cluster;
let alex: TestNode;
let arvid: TestNode;
let kira: TestNode;

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  arvid = await c.add({ name: "arvid", login: "arvid@example.com", hostname: "arvid-mac", seats: noKeychainSeats(join(c.root, "arvid-home"), { flushMs: 100 }) });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kira-mbp" });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  await alex.client().invite("kira@example.com", "kira", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
  expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);
  await arvid.client().seatsConfig({ allow: true, same_user: true });
  await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.hostname === "arvid-mac" && h.allows), { what: "arvid-mac takes seats" });
}, 60_000);

afterAll(async () => { await c.close(); });

test("kira (a member, never a launcher) is refused locally, with the exact fix and whose person runs it", async () => {
  await expect(kira.client().seatRun({ machine: "arvid-mac", runtime: "claude", prompt: "hi" }))
    .rejects.toMatchObject({
      status: 403, code: "forbidden",
      message: "you aren't a launcher on arvid-mac: its person runs `walkie seats allow --launchers @kira` there to add you",
    });
});

test("a member's agent is offered person coverage with an exact-agent narrower option", async () => {
  await expect(kira.client("cc-1").seatRun({ machine: "arvid-mac", runtime: "claude", prompt: "hi" }))
    .rejects.toMatchObject({
      status: 403, code: "forbidden",
      message: "you aren't a launcher on arvid-mac: its person runs `walkie seats allow --launchers @kira` there to cover you and your agents, or `walkie seats allow --launchers @kira/kira-mbp/cc-1` to allow only this agent",
    });
});
