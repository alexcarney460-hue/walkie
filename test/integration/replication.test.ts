import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Event } from "../../src/protocol/schemas.ts";
import { Cluster, standardTeam, waitFor, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode, kira: TestNode, kira2: TestNode;

beforeAll(async () => {
  c = new Cluster();
  ({ alex, kira, kira2 } = await standardTeam(c));
});
afterAll(async () => { await c.close(); });

describe("join", () => {
  test("owner node admits directly; member node redirects to owners", async () => {
    const team = await alex.client().team();
    expect(team.members.map((m) => m.handle).sort()).toEqual(["alex", "kira"]);
    expect(team.nodes.map((n) => n.hostname).sort()).toEqual(["alex-mbp", "kiras-mbp", "kiras-studio"]);
    const me2 = await kira2.client().me();
    expect(me2.handle).toBe("kira");
    expect(me2.role).toBe("member");
    expect(me2.team?.id).toBe(team.id);
  });

  test("join is idempotent for an already-admitted node", async () => {
    const again = await kira.client().join(alex.peerAddr);
    expect(again.admitted).toBe(true);
  });
});

describe("push + anti-entropy", () => {
  test("post on A arrives on B via push", async () => {
    await waitFor(async () => (await alex.client().peers()).nodes.filter((n) => n.online).length === 3, { what: "all nodes online" });
    const t0 = performance.now();
    const { event } = await alex.client().post({ channel: "general", text: "hello from alex" });
    await waitFor(async () => {
      const got = await kira.client().events({ channel: "general", kinds: "msg.post" });
      return got.events.some((e) => e.id === event.id);
    }, { intervalMs: 2, what: "push delivery" });
    const ms = performance.now() - t0;
    console.log(`[metric] push latency alex→kira (post + poll): ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1_000);
  });

  test("offline node catches up 50 events with no gaps after restart", async () => {
    await kira.stop();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) ids.push((await alex.client().post({ channel: "general", text: `batch ${i}` })).event.id);
    await kira.start();
    const t0 = performance.now();
    await waitFor(async () => {
      const got = await kira.client().events({ channel: "general", kinds: "msg.post", limit: 500 });
      const have = new Set(got.events.map((e: Event) => e.id));
      return ids.every((id) => have.has(id));
    }, { what: "catch-up", timeoutMs: 15_000 });
    console.log(`[metric] 50-event catch-up after restart: ${(performance.now() - t0).toFixed(1)} ms`);
    const vvA = alex.d.core.store.vv();
    const vvK = kira.d.core.store.vv();
    expect(vvK[alex.d.nodeId]).toBe(vvA[alex.d.nodeId]);
  });
});
