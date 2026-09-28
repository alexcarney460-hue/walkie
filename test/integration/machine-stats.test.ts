// WALKIE-MACHINE-STATS-1: machine stats ride on the peer `vv` answer. A node sees its own stats and its peers'; a
// peer that doesn't send them (stats off, or v0.1.3) has none; the last known values stay after a peer goes offline;
// nothing is written to the event log.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Reading } from "../../src/daemon/machine-stats/read.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const GiB = 1024 ** 3;
let c: Cluster;
let alex: TestNode, kira: TestNode;
let reading: Reading = { mem: { total: 16 * GiB, used: 9 * GiB, swap_used: 0, pressure: "normal" }, temp_c: 58 };

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", machineStats: { intervalMs: 100, read: async () => reading } });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp" }); // stats off (as a v0.1.3 peer sends none)
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "member");
  const j = await kira.client().join(alex.peerAddr);
  if (!j.admitted) throw new Error(`join failed: ${j.reason}`);
});
afterAll(async () => { await c.close(); });

const nodeOn = async (viewer: TestNode, host: string) => (await viewer.client().peers()).nodes.find((n) => n.hostname === host);

test("own stats on this node; a peer's arrive over vv; a peer without stats has none", async () => {
  const self = await waitFor(async () => (await nodeOn(alex, "alex-mbp"))?.stats, { what: "alex's own stats" });
  expect(self.mem).toEqual({ total: 16 * GiB, used: 9 * GiB, swap_used: 0, pressure: "normal" });
  expect(self.temp_c).toBe(58);
  const seen = await waitFor(async () => (await nodeOn(kira, "alex-mbp"))?.stats, { what: "alex's stats on kira" });
  expect(seen.temp_c).toBe(58);
  expect(seen.at).toBeLessThanOrEqual(Date.now());
  expect((await nodeOn(alex, "kiras-mbp"))?.stats).toBeUndefined();
  expect((await nodeOn(kira, "kiras-mbp"))?.stats).toBeUndefined();
  // The team view carries the same field; no event kind was added to the log.
  expect((await kira.client().team()).nodes.find((n) => n.hostname === "alex-mbp")?.stats?.temp_c).toBe(58);
  const kinds = new Set((await kira.client().events({ limit: 500 })).events.map((e) => e.kind));
  expect([...kinds].every((k) => !k.includes("stat") || k === "agent.status")).toBe(true);
});

test("a meaningful change reaches the peer; noise does not", async () => {
  reading = { ...reading, temp_c: 58.5 };
  await Bun.sleep(400);
  expect((await nodeOn(alex, "alex-mbp"))?.stats?.temp_c).toBe(58);
  reading = { mem: { total: 16 * GiB, used: 14.5 * GiB, swap_used: 2 * GiB, pressure: "warn" }, temp_c: 91 };
  const s = await waitFor(async () => {
    const st = (await nodeOn(kira, "alex-mbp"))?.stats;
    return st?.temp_c === 91 ? st : null;
  }, { what: "updated stats on kira" });
  expect(s.mem?.pressure).toBe("warn");
  expect(s.mem?.swap_used).toBe(2 * GiB);
});

test("offline peer: last known stats kept (the dashboard greys them)", async () => {
  await alex.stop();
  const n = await waitFor(async () => {
    const x = await nodeOn(kira, "alex-mbp");
    return x && !x.online ? x : null;
  }, { what: "alex offline on kira", timeoutMs: 15_000 });
  expect(n.stats?.temp_c).toBe(91);
});
