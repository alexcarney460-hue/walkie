// Go-live lane D with real daemons. REVIEW-codex P2-5: two owners on separate machines. The roster authority (alex) can
// make the team's compute account and rent; the second owner's machine (bob) can't, and its compute state says so
// (authority_required), which is what the dashboard shows instead of an Add compute that would fail there.
// REVIEW-opus P2-6 (PROBE-7): an owner daemon with no compute account does not call the site (round 3: not at all).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { ComputeSite } from "../../src/daemon/compute/site.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { QUOTES } from "../helpers/compute-fixtures.ts";

setDefaultTimeout(60_000);

const calls: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let c: Cluster;
let alex: TestNode, bob: TestNode;

beforeAll(async () => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
    const p = new URL(req.url).pathname;
    calls.push(p);
    if (p === "/api/compute/quotes") return Response.json(QUOTES);
    return Response.json({ error: "handover_not_found" }, { status: 404 });
  } });
  const site = () => new ComputeSite({ base: `http://127.0.0.1:${server.port}` });
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "-", hostname: "alex-mbp", direct: true, compute: { site: site(), intervalMs: 3_600_000 } });
  bob = await c.add({ name: "bob", login: "-", hostname: "bob-mbp", direct: true, compute: { site: site(), intervalMs: 3_600_000 } });
  await alex.client().init("acme", "alex");
  expect((await bob.client().join((await alex.client().inviteCode("bob", "owner")).code)).admitted).toBe(true);
}, 30_000);
afterAll(async () => { await c.close(); server.stop(true); });

test("the authority's state allows renting; the other owner's machine says the authority is required", async () => {
  expect(alex.d.core.isAuthority()).toBe(true);
  expect(bob.d.core.isAuthority()).toBe(false);
  const here = await alex.client().computeState();
  expect(here).toMatchObject({ account_id: null, status: "none" });
  expect("authority_required" in here).toBe(false);
  expect(await bob.client().computeState()).toMatchObject({ account_id: null, status: "none", authority_required: true });
  // What the flag stands for: a rent from bob's machine is refused before any site call (no account can be made there).
  const before = calls.filter((p) => p === "/api/compute/account").length;
  const err = await bob.client().computeRent({ machines: [{ tier: "agent", count: 1 }] }).catch((e: unknown) => e) as { status?: number; message?: string };
  expect(err.status).toBe(409);
  expect(err.message).toContain("roster authority");
  expect(calls.filter((p) => p === "/api/compute/account").length).toBe(before);
});

test("an owner daemon with no compute account polling fast sends nothing to the site (PROBE-7; round 3: no team proof without compute)", async () => {
  const seen: string[] = [];
  const idle = new ComputeSite({ base: "http://127.0.0.1:9", fetch: async (url, init) => {
    seen.push(`${new URL(String(url)).pathname} ${String(init?.body ?? "").includes('"action":"status"') ? "status" : ""}`);
    return Response.json({ error: "handover_not_found" }, { status: 404 });
  } });
  const solo = new Cluster();
  try {
    const owner = await solo.add({ name: "carol", login: "-", hostname: "carol-mbp", direct: true, compute: { site: idle, intervalMs: 300, random: () => 0 } });
    await owner.client().init("solo", "carol");
    await new Promise((r) => setTimeout(r, 2_500));
    expect(seen).toEqual([]);
  } finally { await solo.close(); }
});
