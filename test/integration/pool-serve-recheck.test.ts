// WALK-74 (ASYNC-PERMS-1) for served models: a member asks a sharing machine to serve a model, and bringing it up
// (download, then load) takes a while. A member made an observer meanwhile gets nothing brought up: the model stops
// before it serves, with the plain reason, and the machine's one pool job is free again. The control: the same slow
// load for a member who is still one ends serving. (llama-server is the stand-in; $HOME/hold-health keeps it loading.)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memberByHandle } from "../../src/daemon/roster.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { ACCEPT_STANDIN, fakeServeRuntime, placeModel } from "../helpers/pool-runtime.ts";

const GiB = 1024 ** 3;
let c: Cluster;
let host: TestNode, user: TestNode;
const hold = () => join(host.home, "pool", "hold-health");
const serve = async () => (await host.client().pool()).serve;

beforeAll(async () => {
  c = new Cluster();
  const pool = { llamaDir: fakeServeRuntime(c.root), verifyRuntime: ACCEPT_STANDIN, serveBudget: () => 11 * GiB };
  host = await c.add({ name: "atlas", login: "alex@example.com", hostname: "atlas", pool });
  user = await c.add({ name: "mac", login: "kira@example.com", hostname: "kiras-mac", pool });
  await host.client().init("serve-recheck", "alex");
  await host.client().invite("kira@example.com", "kira", "member");
  expect((await user.client().join(host.peerAddr)).admitted).toBe(true);
  placeModel(host.home, "llama-3.2-3b", "q4");
  await host.client().poolShare(true, null);
  await waitFor(async () => (await user.client().team()).nodes.find((n) => n.hostname === host.hostname)?.pool?.share, { timeoutMs: 15_000, what: "sharing seen" });
}, 60_000);
afterAll(async () => { rmSync(hold(), { force: true }); await c.close(); });

async function startHeld(): Promise<void> {
  writeFileSync(hold(), "");
  await user.client().poolServe({ model: "llama-3.2-3b", on: host.hostname });
  await waitFor(async () => (await serve())?.state === "loading" ? true : null, { timeoutMs: 15_000, what: "host loading the model" });
}

test("control: a member still allowed when the load ends gets the model served", async () => {
  await startHeld();
  rmSync(hold(), { force: true });
  const s = await waitFor(async () => { const v = await serve(); return v?.state === "serving" ? v : null; }, { timeoutMs: 30_000, what: "host serving" });
  expect(s.started_by?.hostname).toBe(user.hostname);
  await host.client().poolServeStop();
  await waitFor(async () => (await serve())?.state === "stopped" ? true : null, { timeoutMs: 15_000, what: "stopped by its person" });
}, 60_000);

test("a member made an observer while the model loaded: it is not brought up, with the reason", async () => {
  await startHeld();
  await host.client().setRole("kira", "observer");
  expect(memberByHandle(host.d.core.roster, "kira")?.role).toBe("observer");
  const s = await waitFor(async () => { const v = await serve(); return v?.state === "stopped" ? v : null; }, { timeoutMs: 15_000, what: "the held model stopped" });
  expect(s.serving_at).toBeNull();
  expect(s.error).toBe("not started: kiras-mac may no longer use this machine (its person was removed or made an observer, or the machine was revoked)");
  rmSync(hold(), { force: true });
  // The machine's one pool job is free again: its own person can serve at once.
  expect(["downloading", "loading"]).toContain((await host.client().poolServe({ model: "llama-3.2-3b", on: host.hostname })).serve?.state ?? "none");
  await host.client().poolServeStop();
}, 60_000);
