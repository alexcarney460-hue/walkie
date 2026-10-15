// Go-live lane D (REVIEW-opus.md P1-4, P2-9, P2-11; REVIEW-codex.md P2-4): what is on sale follows the private quota,
// a rented machine installs only a listed release, and a definitive "no capacity" from the provider is retried instead
// of failing the rental (bounded in round 2: compute-golive-d2.test.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { makeQuotes } from "../api/compute/quotes.ts";
import { makeRent } from "../api/compute/rent.ts";
import { makeStart } from "../api/compute/start.ts";
import { checkRent } from "../api/_lib/compute/validate.ts";
import { RENTED_MACHINE_RELEASES, rentableRelease } from "../api/_lib/compute/releases.ts";
import { ComputeError, rent as enqueue, state } from "../api/_lib/compute/service.ts";
import { tick } from "../api/_lib/compute/tick.ts";
import { STUCK_LAUNCH_MS } from "../api/_lib/compute/tick.ts";
import type { HandlerDeps } from "../api/_lib/compute/handler.ts";
import { codes, createAccount, fixtureTeam, fund, idem, joinCode, MIN, world, type World } from "./compute-helpers.ts";

const USD = 1_000_000;
const RELEASE = RENTED_MACHINE_RELEASES[RENTED_MACHINE_RELEASES.length - 1]!;
type Tier = "agent" | "agent-xl" | "gpu-20" | "gpu-48" | "gpu-80";

function rentReq(machines: { tier: Tier; count: number }[], version = RELEASE) {
  const n = machines.reduce((s, m) => s + m.count, 0);
  return { idempotency_key: idem(), machines, codes: codes(n), walkie_version: version };
}

async function funded(w: World, micros: number): Promise<{ account_id: string; token: string }> {
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, micros);
  return a;
}

function handlers(w: World): HandlerDeps {
  return { env: { COMPUTE_ENABLED: "1", SITE_URL: "https://site.test" }, compute: () => w.d, stripe: () => null };
}

const post = (path: string, token: string, body: unknown) => new Request(`https://site.test${path}`, {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9", authorization: `Bearer ${token}` },
});

describe("CPU-only launch: a tier whose quota group holds no machine is not on sale", () => {
  test("quotes list only the tiers with quota; none left means not available", async () => {
    const cpu = world({ quotas: { cpu: 3, gpu: 0 } });
    const q = await (await makeQuotes(handlers(cpu))(new Request("https://site.test/api/compute/quotes"))).json() as { available: boolean; tiers: { id: string }[] };
    expect(q.tiers.map((t) => t.id)).toEqual(["agent", "agent-xl"]);
    expect(q.available).toBe(true);
    const none = world({ quotas: { cpu: 0, gpu: 0 } });
    const empty = await (await makeQuotes(handlers(none))(new Request("https://site.test/api/compute/quotes"))).json() as { available: boolean; tiers: unknown[] };
    expect(empty.tiers).toEqual([]);
    expect(empty.available).toBe(false);
    // Drain mode (the control plane configured with launches off, REVIEW-opus P1-2): nothing is for sale.
    const drain = world({ quotas: { cpu: 3, gpu: 0 } });
    const off = await (await makeQuotes({ ...handlers(drain), compute: () => ({ ...drain.d, enabled: false }) })(new Request("https://site.test/api/compute/quotes"))).json() as { available: boolean };
    expect(off.available).toBe(false);
  });

  test("rent refuses a zero-quota tier before inserting anything, so its credit is not held (PROBE-2)", async () => {
    const w = world({ quotas: { cpu: 3, gpu: 0 } });
    const a = await funded(w, 2 * USD);
    const err = await enqueue(w.d, a.account_id, rentReq([{ tier: "gpu-20", count: 1 }])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComputeError);
    expect(err).toMatchObject({ status: 409, code: "tier_unavailable" });
    // A mixed request is refused whole: nothing of it is queued or started.
    const mixed = await enqueue(w.d, a.account_id, rentReq([{ tier: "agent", count: 1 }, { tier: "gpu-48", count: 1 }])).catch((e: unknown) => e);
    expect(mixed).toMatchObject({ status: 409, code: "tier_unavailable" });
    expect((await state(w.d, a.account_id)).rentals).toEqual([]);
    // The balance the GPU ask would have held still covers a CPU machine.
    const ok = await enqueue(w.d, a.account_id, rentReq([{ tier: "agent", count: 1 }]));
    expect(ok.rentals.map((r) => r.state)).toEqual(["starting"]);
  });

  test("the rent endpoint answers 409 tier_unavailable", async () => {
    const w = world({ quotas: { cpu: 3, gpu: 0 } });
    const a = await funded(w, 20 * USD);
    const res = await makeRent(handlers(w))(post("/api/compute/rent", a.token, rentReq([{ tier: "gpu-80", count: 1 }])));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "tier_unavailable" });
  });

  test("a request accepted before the quota went to zero still replays", async () => {
    const w = world({ quotas: { cpu: 3, gpu: 1 } });
    const a = await funded(w, 20 * USD);
    const req = rentReq([{ tier: "gpu-20", count: 1 }]);
    const first = await enqueue(w.d, a.account_id, req);
    const closed = { ...w.d, config: { ...w.d.config, quotas: { cpu: 3, gpu: 0 } } };
    const again = await enqueue(closed, a.account_id, req);
    expect(again.replay).toBe(true);
    expect(again.rentals.map((r) => r.id)).toEqual(first.rentals.map((r) => r.id));
  });
});

describe("a rented machine installs only a release the site knows was published (PROBE-4)", () => {
  test("rent refuses an unknown release tag at the boundary", async () => {
    expect(checkRent(rentReq([{ tier: "agent", count: 1 }], "v9.9.9-doesnotexist"))).toEqual({ ok: false, error: "unsupported_walkie_version" });
    expect(checkRent(rentReq([{ tier: "agent", count: 1 }], "v0.2.0-pre.16.1"))).toEqual({ ok: false, error: "unsupported_walkie_version" });
    expect(checkRent(rentReq([{ tier: "agent", count: 1 }], RELEASE)).ok).toBe(true);
    const w = world();
    const a = await funded(w, 20 * USD);
    const res = await makeRent(handlers(w))(post("/api/compute/rent", a.token, rentReq([{ tier: "agent", count: 1 }], "v9.9.9-doesnotexist")));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unsupported_walkie_version" });
    expect(w.cloud.provisions).toHaveLength(0);
  });

  test("start refuses an unknown release tag for a queued rental", async () => {
    const w = world({ quotas: { cpu: 1, gpu: 0 } });
    const a = await funded(w, 20 * USD);
    await enqueue(w.d, a.account_id, rentReq([{ tier: "agent", count: 1 }]));
    const queued = await enqueue(w.d, a.account_id, rentReq([{ tier: "agent", count: 1 }]));
    const id = queued.rentals[0]!.id;
    await w.store.tx((t) => t.updateRental(id, { state: "needs_code", needs_code_at: w.d.now() }));
    const bad = await makeStart(handlers(w))(post("/api/compute/start", a.token, { rental_id: id, code: joinCode(), walkie_version: "v9.9.9-doesnotexist" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "unsupported_walkie_version" });
    const ok = await makeStart(handlers(w))(post("/api/compute/start", a.token, { rental_id: id, code: joinCode(), walkie_version: RELEASE }));
    expect(ok.status).toBe(200);
  });

  test("the list holds the installer's release and this build's release, newest last, all well-formed", () => {
    const tagOf = (file: string) => /^DEFAULT_VERSION="(v[^"]+)"$/m.exec(readFileSync(new URL(file, import.meta.url), "utf8"))?.[1];
    const installer = tagOf("../../scripts/install.sh");
    const served = tagOf("../install.sh");
    const pkg = `v${(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version}`;
    const hint = "add it to RENTED_MACHINE_RELEASES in site/api/_lib/compute/releases.ts";
    expect({ installer, in: rentableRelease(installer ?? ""), hint }).toEqual({ installer, in: true, hint });
    expect({ served, in: rentableRelease(served ?? ""), hint }).toEqual({ served, in: true, hint });
    expect({ pkg, in: rentableRelease(pkg), hint }).toEqual({ pkg, in: true, hint });
    expect(RENTED_MACHINE_RELEASES[RENTED_MACHINE_RELEASES.length - 1]).toBe(installer!);
    expect(new Set(RENTED_MACHINE_RELEASES).size).toBe(RENTED_MACHINE_RELEASES.length);
    for (const tag of RENTED_MACHINE_RELEASES) expect(tag).toMatch(/^v\d+\.\d+\.\d+(?:-pre\.\d+(?:\.\d+)?)?$/);
  });
});

describe("a definitive provider capacity refusal is retried (it never fails the rental at once)", () => {
  test("the rental waits to retry with its first hour still reserved, then starts when the provider has room", async () => {
    const w = world({ quotas: { cpu: 2, gpu: 0 } });
    const a = await funded(w, 2 * USD);
    w.cloud.failNext = "capacity";
    const res = await enqueue(w.d, a.account_id, rentReq([{ tier: "agent", count: 1 }]));
    const id = res.rentals[0]!.id;
    await tick(w.d);
    let r = (await state(w.d, a.account_id)).rentals[0]!;
    expect(r).toMatchObject({ id, state: "starting", started_at: null, spent_micros: 0 });
    expect(w.logs.some((l) => l.event === "alert_provider_unavailable" && l.fields.rental === id)).toBe(true);
    // Its first hour stays held: 2.00 - 0.75 leaves 1.25, so a second $1.50/h machine is refused.
    const short = await enqueue(w.d, a.account_id, rentReq([{ tier: "agent-xl", count: 1 }])).catch((e: unknown) => e);
    expect(short).toMatchObject({ status: 402, code: "insufficient_credit" });
    // Past the uncertain-launch grace window it is retried (the provider has room now), not failed.
    w.advance(STUCK_LAUNCH_MS + MIN);
    await tick(w.d);
    r = (await state(w.d, a.account_id)).rentals[0]!;
    expect(r.state).toBe("starting");
    expect(r.started_at).not.toBeNull();
    expect(w.cloud.provisions.filter((p) => p.tags["walkie:rental"] === id)).toHaveLength(2);
  });

  test("other provider failures stay uncertain (never a second create)", async () => {
    const w = world();
    const a = await funded(w, 20 * USD);
    w.cloud.failNext = "error";
    await enqueue(w.d, a.account_id, rentReq([{ tier: "agent", count: 1 }]));
    await tick(w.d);
    w.advance(STUCK_LAUNCH_MS);
    await tick(w.d);
    expect((await state(w.d, a.account_id)).rentals[0]).toMatchObject({ state: "failed", end_reason: "launch_failed" });
    expect(w.cloud.provisions).toHaveLength(1);
  });
});
