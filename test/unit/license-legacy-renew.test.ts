// Lane C (go-live review O P1-3): a renewal token bound by the released compute-locked site carries no authority.
// After the flip, once the team has compute state, the site renews it only with a roster proof signed by the
// enrolled authority. The authority's renewer retries a refused renewal once with that proof.
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Core } from "../../src/daemon/core.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { activateCode } from "../../src/license/bind.ts";
import { makeVerifier } from "../../src/license/format.ts";
import { DAY_MS } from "../../src/license/plans.ts";
import { LicenseRenewer, refreshLicense } from "../../src/license/renew.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import { loadRenewToken, saveRenewToken } from "../../src/license/renew-token.ts";
import { LicenseService, type FetchLike } from "../../src/license/service.ts";
import { rosterProof } from "../../src/daemon/compute/team-proof.ts";
import { MemoryStore } from "../../site/api/_lib/compute/memory-store.ts";
import { teamAuthority } from "../../site/api/_lib/compute/team-proof.ts";
import { signingKeyFromPem, signLicense } from "../../site/api/_lib/license.ts";
import { verifySig } from "../../site/api/_lib/protocol/keys.ts";
import { makeBind } from "../../site/api/license/bind.ts";
import { COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION } from "../../site/api/_lib/compute/release-gate.ts";
import { issueKey, payloadFor, verifyActivationCode } from "../../site/api/_lib/issue.ts";
import { renewHash } from "../../site/api/_lib/metadata.ts";
import { makeRenew, renewMessage } from "../../site/api/license/renew.ts";
import { fullEnv, MockStripe, subscription, testKeypair } from "../../site/test/helpers.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const log = createLogger({});
const kp = testKeypair();
const verify = makeVerifier(kp.publicB64);
const LIC = ["sub", "LEGACYRENEW"].join("_");
const TOKEN = "t".repeat(43);

function authority(): { team: string; core: Core } {
  const a = tnode("alex");
  const { team, create } = createTeam(a);
  const core = makeCore(a, team, cleanups, { licenseVerifier: verify });
  core.ingest(create, "local");
  return { team, core };
}

function licenseKey(team: string, expiresAt: number): string {
  return signLicense({ v: 2, kind: "license", team, lic_id: LIC, plan: "team", seats: 7, email: "lead@kestrel.test",
    interval: "month", issued_at: now() - DAY_MS, expires_at: expiresAt }, signingKeyFromPem(kp.pem));
}

describe("renewer retry with a signed roster proof", () => {
  function licensed() {
    const { team, core } = authority();
    core.emit("team.license", { key: licenseKey(team, now() + 3 * DAY_MS) });
    saveRenewToken(core.paths.home, { lic_id: LIC, team, token: TOKEN });
    return { team, core };
  }
  function service(replies: Response[]) {
    const bodies: Record<string, unknown>[] = [];
    const s = new LicenseService({ fetch: async (_u, init) => { bodies.push(JSON.parse(String(init.body))); return replies.shift()!; } });
    return { s, bodies };
  }

  test("403 invalid_renewal: one retry carries the authority's roster proof signed over the renew message", async () => {
    const { team, core } = licensed();
    const fresh = licenseKey(team, now() + 35 * DAY_MS);
    const { s, bodies } = service([Response.json({ error: "invalid_renewal" }, { status: 403 }), Response.json({ key: fresh })]);
    expect(await new LicenseRenewer(core, log, { service: s, now }).tick()).toBe("renewed");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({ lic_id: LIC, renewal_token: TOKEN });
    const { proof, ...rest } = bodies[1] as { proof: { expires_at: number; renew_signature: string } };
    expect(rest).toEqual({ lic_id: LIC, renewal_token: TOKEN });
    const signer = teamAuthority(team, proof as never);
    expect(signer?.key).toBe(core.keys.pubkey);
    expect(proof.expires_at).toBeGreaterThan(core.clock());
    expect(proof.expires_at).toBeLessThanOrEqual(core.clock() + 300_000);
    expect(verifySig(core.keys.pubkey, renewMessage(team, LIC, proof.expires_at), proof.renew_signature)).toBe(true);
    expect(core.roster.license?.key).toBe(fresh);
  });

  test("no retry for other refusals; a refused retry is reported once as refused", async () => {
    for (const reply of [Response.json({ error: "subscription_inactive" }, { status: 402 }),
      Response.json({ error: "other" }, { status: 403 }), Response.json({ error: "stripe_unavailable" }, { status: 502 })]) {
      const { core } = licensed();
      const { s, bodies } = service([reply]);
      expect(await new LicenseRenewer(core, log, { service: s, now }).tick()).toBe("refused");
      expect(bodies).toHaveLength(1);
    }
    const { core } = licensed();
    const { s, bodies } = service([Response.json({ error: "invalid_renewal" }, { status: 403 }),
      Response.json({ error: "invalid_renewal" }, { status: 403 })]);
    const warnings: string[] = [];
    const seen: Logger = { ...log, warn: (msg) => { warnings.push(msg); } };
    expect(await new LicenseRenewer(core, seen, { service: s, now }).tick()).toBe("proof_refused");
    expect(bodies).toHaveLength(2);
    expect(warnings).toEqual(["license_renew_proof_refused"]);
  });

  test("an open fork is its own outcome with its own message, on the daily check and on a manual refresh", async () => {
    const forkReplies = () => [Response.json({ error: "invalid_renewal" }, { status: 403 }),
      Response.json({ error: "authority_fork_open" }, { status: 409 })];
    const { core } = licensed();
    const warnings: string[] = [];
    const seen: Logger = { ...log, warn: (msg) => { warnings.push(msg); } };
    const daily = service(forkReplies());
    expect(await new LicenseRenewer(core, seen, { service: daily.s, now }).tick()).toBe("fork_open");
    expect(daily.bodies).toHaveLength(2);
    expect(warnings).toEqual(["license_renew_fork_open"]);
    let err: unknown;
    try { await refreshLicense(core, service(forkReplies()).s, log); } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 409, code: "authority_fork_open" });
    expect((err as Error).message).toContain("fork");
    expect((err as Error).message).not.toContain("isn't active");
  });

  test("a manual refresh refused even with the signed proof says what to do, not 'subscription inactive'", async () => {
    const { core } = licensed();
    const { s } = service([Response.json({ error: "invalid_renewal" }, { status: 403 }),
      Response.json({ error: "invalid_renewal" }, { status: 403 })]);
    let err: unknown;
    try { await refreshLicense(core, s, log); } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 409, code: "renewal_authority_refused" });
    const message = (err as Error).message;
    expect(message).toContain("compute");
    expect(message).toContain("roster authority");
    expect(message).not.toContain("isn't active");
  });
});

test("end to end: bound by the released locked site, the team enrolls in compute, and the daemon still renews", async () => {
  const { team, core } = authority();
  const stripe = new MockStripe();
  const store = new MemoryStore();
  const env = fullEnv(kp.pem, { DATABASE_URL: "postgres://u:p@127.0.0.1:1/unused" });
  const periodEnd = (ms: number) => Math.floor(ms / 1000);
  stripe.subs.set(LIC, subscription({ id: LIC, items: { data: [{ quantity: 7, current_period_end: periodEnd(now() + 3 * DAY_MS),
    price: { id: "price_team_m", lookup_key: "walkie_team_month" } }] } }));
  const deps = { env, stripe: () => stripe, now: () => now() };
  let flipped = false;
  const siteFetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (!flipped) {
      // The released site (pre.10 to pre.16): no database, and the daemon's roster proof is ignored. While this build
      // keeps the lock on, that is the in-tree handler with preview off; once the lock flips the in-tree bind needs its
      // store (lane C round 11), so the released handler's two-key write is reproduced with the site's own helpers.
      if (path !== "/api/license/bind") return new Response("not found", { status: 404 });
      if (!COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION)
        return makeBind({ ...deps, env: fullEnv(kp.pem), previewCompute: false, computeStore: () => null })(new Request(url, init));
      const { code: activation, team_id } = JSON.parse(String(init.body)) as { code: string; team_id: string };
      const payload = verifyActivationCode(activation, env)!, sub = (await stripe.getSubscription(payload.lic_id))!;
      const token = randomBytes(32).toString("base64url");
      await stripe.setSubscriptionMetadata(sub.id, { walkie_team: team_id, walkie_renew_hash: renewHash(token) });
      return Response.json({ key: issueKey(payloadFor(sub, env, now(), team_id), env), renewal_token: token });
    }
    const req = new Request(url, init);
    const site = { ...deps, previewCompute: true, computeStore: () => store };
    if (path === "/api/license/renew") return makeRenew(site)(req);
    return new Response("not found", { status: 404 });
  };
  const service = new LicenseService({ base: "https://site.test", fetch: siteFetch });
  const code = signLicense({ v: 2, kind: "activation", lic_id: LIC, plan: "team", seats: 7, email: "lead@kestrel.test",
    interval: "month", issued_at: now(), expires_at: now() + 30 * DAY_MS }, signingKeyFromPem(kp.pem));
  expect((await activateCode(core, service, code)).renewal).toBe("saved");
  expect(Object.keys(stripe.subs.get(LIC)!.metadata).sort()).toEqual(["walkie_renew_hash", "walkie_team"]);
  expect(loadRenewToken(core.paths.home)?.lic_id).toBe(LIC);

  flipped = true;
  const chain = teamAuthority(team, rosterProof(core))!;
  await store.tx(async t => {
    await t.setEnrollment({ team_id: team, key: chain.key, source: "license", updated_at: now() });
    await t.setControl(`enrollment-chain:${team}`, { depth: chain.depth, chainId: chain.chainId, chain: chain.chain, version: 1 });
  });
  const cur = stripe.subs.get(LIC)!;
  stripe.subs.set(LIC, { ...cur, items: { data: [{ ...cur.items.data[0]!, current_period_end: periodEnd(now() + 33 * DAY_MS) }] } });
  const expires = core.roster.license!.payload.expires_at;
  expect(await new LicenseRenewer(core, log, { service, now: () => expires - 3 * DAY_MS }).tick()).toBe("renewed");
  expect(core.roster.license!.payload.expires_at).toBeGreaterThan(expires);
  expect(Object.keys(stripe.subs.get(LIC)!.metadata).sort()).toEqual(["walkie_renew_hash", "walkie_team"]);
});
