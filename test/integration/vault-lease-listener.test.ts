// PRE4-INT: POST /v1/vault/lease (ACCOUNTS-2) is served on the unix socket only. On pre.3 the route context's
// `transport` is Walkie Direct's control, so the lane's `c.transport !== "unix"` check became `c.listener`: this pins
// that the loopback listener (durable token) is refused and the unix socket reaches the route's own validation.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { WalkieError } from "../../src/client/index.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode;

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  await alex.client().init("acme", "alex");
}, 30_000);
afterAll(async () => { await c.close(); });

const BODY = { account: "a".repeat(24), node: "0123456789abcdef" };

test("the loopback listener is refused (403), even with the durable token", async () => {
  const port = alex.d.localPort as number;
  const res = await fetch(`http://127.0.0.1:${port}/v1/vault/lease`, {
    method: "POST",
    headers: { Authorization: `Bearer ${alex.d.token}`, Host: `127.0.0.1:${port}`, "Content-Type": "application/json" },
    body: JSON.stringify(BODY),
  });
  expect(res.status).toBe(403);
  expect(await res.text()).toContain("only served on the unix socket");
});

test("the unix socket reaches the route (an unknown owner machine is 404, not the listener's 403)", async () => {
  const err = await alex.client().vaultLease(BODY).then(() => null, (e: unknown) => e as WalkieError);
  expect(err).toBeInstanceOf(WalkieError);
  expect(err?.status).toBe(404);
  expect(err?.code).toBe("not_found");
});
