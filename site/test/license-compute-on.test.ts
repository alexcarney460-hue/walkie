// v0.2.0-pre.17 (lane E): with the site lock ON, the DEPLOYED licence handlers (previewCompute false, as the published
// POST entrypoints build them) take the compute-capable path. A bind records every binding in the compute store, so it
// refuses without one (lane C round 11) and fails closed on a dead database before any Stripe write; a drained site
// (COMPUTE_ENABLED unset, store set) binds and records. A renewal needs no store, but one that is configured and dead
// fails the renewal (the daemon retries daily inside its 7-day window plus 14-day grace) instead of answering around it.
import { expect, test } from "bun:test";
import { makeBind } from "../api/license/bind.ts";
import { makeRenew } from "../api/license/renew.ts";
import { signLicense, signingKeyFromPem } from "../api/_lib/license.ts";
import { renewHash } from "../api/_lib/metadata.ts";
import { MemoryStore } from "../api/_lib/compute/memory-store.ts";
import { bindingsKey } from "../api/_lib/compute/licence-records.ts";
import type { ComputeStore } from "../api/_lib/compute/store.ts";
import { deps, fullEnv, MockStripe, NOW, PERIOD_END_S, subscription, testKeypair } from "./helpers.ts";

const signing = testKeypair();
const team = "a1b2c3d4e5f60718";
const lic = "sub_ABC123";
const code = signLicense({ v: 2, kind: "activation", lic_id: lic, plan: "team", seats: 7,
  email: "lead@kestrel.test", interval: "month", issued_at: NOW,
  expires_at: PERIOD_END_S * 1000 + 5 * 86_400_000 }, signingKeyFromPem(signing.pem));
const request = (path: string, body: unknown) => new Request(`https://site.test/api/license/${path}`,
  { method: "POST", body: JSON.stringify(body) });

/** A configured database that does not answer: PgStore connects lazily, so every first query rejects. */
function deadStore(): { store: ComputeStore; calls: () => number } {
  let calls = 0;
  const store = new Proxy({}, { get: () => async () => { calls++; throw Error("database unreachable"); } }) as unknown as ComputeStore;
  return { store, calls: () => calls };
}
/** The deployed handlers' dependencies: never preview mode (the published entrypoints never set it). */
const deployed = (stripe: MockStripe, env: ReturnType<typeof fullEnv>, store: () => ComputeStore | null) =>
  ({ ...deps(stripe, env), previewCompute: false, computeStore: store });

for (const proof of [undefined, { malformed: true }]) {
  test(`lock-ON bind with ${proof ? "a malformed" : "no"} proof and a dead database fails closed before any Stripe write`, async () => {
    const stripe = new MockStripe();
    stripe.subs.set(lic, subscription({ id: lic }));
    const dead = deadStore();
    const response = await makeBind(deployed(stripe, fullEnv(signing.pem), () => dead.store))(request("bind", { code, team_id: team, proof }));
    expect([response.status, await response.json()]).toEqual([503, { error: "compute_state_unavailable" }]);
    expect(dead.calls()).toBeGreaterThan(0);
    expect(stripe.calls.metadata).toEqual([]);
  });
}

test("lock-ON bind without a store answers licence_store_required before any Stripe write (drained or enabled)", async () => {
  for (const extra of [{}, { COMPUTE_ENABLED: "1" }] as Record<string, string>[]) {
    const stripe = new MockStripe();
    stripe.subs.set(lic, subscription({ id: lic }));
    const response = await makeBind(deployed(stripe, fullEnv(signing.pem, extra), () => null))(request("bind", { code, team_id: team }));
    expect([response.status, await response.json()]).toEqual([503, { error: "licence_store_required" }]);
    expect(stripe.calls.metadata).toEqual([]);
  }
});

test("a drained lock-ON bind (store set, COMPUTE_ENABLED unset) binds the licence and records the binding", async () => {
  const stripe = new MockStripe();
  stripe.subs.set(lic, subscription({ id: lic }));
  const store = new MemoryStore();
  const response = await makeBind(deployed(stripe, fullEnv(signing.pem), () => store))(request("bind", { code, team_id: team }));
  expect(response.status).toBe(200);
  expect(Object.keys(await response.json() as object).sort()).toEqual(["key", "renewal_token"]);
  expect(stripe.calls.metadata).toHaveLength(1);
  const write = stripe.calls.metadata[0]!.metadata;
  expect(write.walkie_team).toBe(team);
  expect(write.walkie_renew_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(await store.tx((t) => t.control(bindingsKey(team)))).toEqual({ subscriptions: [lic] });
});

test("lock-ON renewal: no store renews from Stripe alone; a store with no compute state renews; a dead store refuses", async () => {
  const token = "T".repeat(43);
  const renewOn = async (store: () => ComputeStore | null) => {
    const stripe = new MockStripe();
    stripe.subs.set(lic, subscription({ id: lic, metadata: { walkie_team: team, walkie_renew_hash: renewHash(token) } }));
    const response = await makeRenew(deployed(stripe, fullEnv(signing.pem), store))(request("renew", { lic_id: lic, renewal_token: token }));
    return { status: response.status, body: await response.json() as Record<string, unknown>, writes: stripe.calls.metadata };
  };
  const bare = await renewOn(() => null);
  expect([bare.status, Object.keys(bare.body), bare.writes]).toEqual([200, ["key"], []]);
  const fresh = await renewOn(() => new MemoryStore());
  expect([fresh.status, Object.keys(fresh.body), fresh.writes]).toEqual([200, ["key"], []]);
  const dead = deadStore();
  const failed = await renewOn(() => dead.store);
  expect([failed.status, failed.body, failed.writes]).toEqual([502, { error: "stripe_unavailable" }, []]);
  expect(dead.calls()).toBeGreaterThan(0);
});
