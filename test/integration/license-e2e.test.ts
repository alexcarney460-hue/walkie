// LICENSE-FIX-1 end to end, with Stripe mocked and the site's real billing functions in-process as the
// license service: checkout completed → activation code revealed once → bound to team A by A's
// authority (real CLI) → the key is accepted on A's chain → the same code refused for team B (409) →
// renewal with the right token OK, with a wrong token 403 → A's key rejected on B's chain.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../src/daemon/logger.ts";
import { makeVerifier } from "../../src/license/format.ts";
import { LicenseRenewer } from "../../src/license/renew.ts";
import { loadRenewToken, RENEW_TOKEN_FILE } from "../../src/license/renew-token.ts";
import { LicenseService, type FetchLike } from "../../src/license/service.ts";
import type { Deps } from "../../site/api/_lib/issue.ts";
import { renewHash } from "../../site/api/_lib/metadata.ts";
import { makeBind } from "../../site/api/license/bind.ts";
import { makeLicense } from "../../site/api/license/index.ts";
import { makeRenew } from "../../site/api/license/renew.ts";
import { fullEnv, MockStripe, subscription, testKeypair } from "../../site/test/helpers.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const DAY = 86_400_000;
const kp = testKeypair();
const verify = makeVerifier(kp.publicB64);
const stripe = new MockStripe();
const deps: Deps = { env: fullEnv(kp.pem), stripe: () => stripe, now: () => Date.now() };
const SUB = "sub_E2E1";
const periodEnd = (ms: number) => Math.floor(ms / 1000);

/** The license service as the daemons see it: the site's handlers, called in-process. */
const calls: { path: string; redirect: RequestRedirect | undefined }[] = [];
const siteFetch: FetchLike = async (url, init) => {
  const path = new URL(url).pathname;
  calls.push({ path, redirect: init.redirect });
  const req = new Request(url, init);
  if (path === "/api/license/bind") return makeBind(deps)(req);
  if (path === "/api/license/renew") return makeRenew(deps)(req);
  return new Response("not found", { status: 404 });
};

let c: Cluster;
let alex: TestNode, bea: TestNode, bob: TestNode;
let teamA = "", teamB = "";

async function walkie(node: TestNode, args: string[]) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket };
  return runAsPerson([process.execPath, CLI, ...args], env); // a person's terminal
}

beforeAll(async () => {
  stripe.subs.set(SUB, subscription({ id: SUB, created: periodEnd(Date.now()) - 60, items: { data: [{ quantity: 5, current_period_end: periodEnd(Date.now() + 30 * DAY), price: { id: "price_team_m", lookup_key: "walkie_team_month" } }] } }));
  stripe.sessions.set("cs_e2e", { id: "cs_e2e", mode: "subscription", status: "complete", subscription: SUB, customer: "cus_XYZ" });
  c = new Cluster();
  const spec = { licenseVerifier: verify, licenseService: { base: "https://site.test", fetch: siteFetch } };
  alex = await c.add({ name: "alex", login: "alex@example.com", ...spec });
  bea = await c.add({ name: "bea", login: "bea@example.com", ...spec });
  bob = await c.add({ name: "bob", login: "bob@example.com", ...spec });
  await alex.client().init("acme", "alex");
  await alex.client().invite("bea@example.com", "bea", "owner");
  const j = await bea.client().join(alex.peerAddr);
  if (!j.admitted) throw new Error(`bea join failed: ${j.reason}`);
  await bob.client().init("bravo", "bob");
  teamA = (await alex.client().me()).team?.id as string;
  teamB = (await bob.client().me()).team?.id as string;
});
afterAll(async () => { await c.close(); });

describe("license end to end (mocked Stripe, the site's functions as the license service)", () => {
  let code = "";
  let keyA = "";

  test("checkout completed → the welcome page reveals the activation code exactly once", async () => {
    const get = () => makeLicense(deps)(new Request("https://site.test/api/license?session_id=cs_e2e"));
    const first = await get();
    expect(first.status).toBe(200);
    code = ((await first.json()) as { code: string }).code;
    const p = verify(code);
    expect(p.ok && [p.payload.kind, p.payload.team, p.payload.seats]).toEqual(["activation", undefined, 5]);
    // Within the retry window the same session gets the same code again (a lost response, FINAL-2 Codex 4);
    // after it the code is gone for good.
    const second = await get();
    expect([second.status, ((await second.json()) as { code: string }).code]).toEqual([200, code]);
    const late = makeLicense({ ...deps, now: () => Date.now() + 11 * 60_000 })(new Request("https://site.test/api/license?session_id=cs_e2e"));
    expect([(await late).status, ((await (await late).json()) as { error: string }).error]).toEqual([410, "already_revealed"]);
  });

  test("a non-authority owner can't exchange the code (it names the authority); nothing is bound", async () => {
    const r = await walkie(bea, ["license", "activate", code]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not_authority");
    expect(r.err).toContain("alex-mbp");
    expect(stripe.subs.get(SUB)?.metadata.walkie_team).toBeUndefined();
  });

  test("A's authority binds it: the team-bound key is on A's chain, replicated, and the renewal token is saved 0600 (hash only at the site)", async () => {
    const r = await walkie(alex, ["license", "activate", code]);
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(r.out).toContain("license activated · Team · 2/5 seats");
    const lic = alex.d.core.roster.license;
    expect(lic?.payload).toMatchObject({ kind: "license", team: teamA, lic_id: SUB, seats: 5 });
    keyA = lic?.key as string;
    const onBea = await waitFor(async () => { const p = await bea.client().license(); return p.license ? p : null; }, { what: "license on bea" });
    expect(onBea).toMatchObject({ plan: "team", status: "active", seats: { used: 2, limit: 5 } });
    const tok = loadRenewToken(alex.home);
    expect(tok).toMatchObject({ lic_id: SUB, team: teamA });
    expect(statSync(join(alex.home, RENEW_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    expect(stripe.subs.get(SUB)?.metadata).toMatchObject({ walkie_team: teamA, walkie_renew_hash: renewHash(tok?.token as string) });
    // The token never reaches the chain: no event body anywhere carries it.
    const events = await alex.client().events({ limit: 500 });
    expect(JSON.stringify(events)).not.toContain(tok?.token as string);
    expect(calls.every((x) => x.redirect === "error")).toBe(true);
  });

  test("the same code on team B is refused with 409 license_bound_elsewhere; A's binding is untouched", async () => {
    const before = { ...stripe.subs.get(SUB)?.metadata };
    const r = await walkie(bob, ["license", "activate", code]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("license_bound_elsewhere");
    expect(bob.d.core.roster.license).toBeUndefined();
    expect(stripe.subs.get(SUB)?.metadata).toEqual(before);
    const direct = await makeBind(deps)(new Request("https://site.test/api/license/bind", { method: "POST", body: JSON.stringify({ code, team_id: teamB }) }));
    expect(direct.status).toBe(409);
  });

  test("renewal: the right token gets a fresh key (and the authority's renewer activates it); a wrong token is 403", async () => {
    const token = (loadRenewToken(alex.home) as { token: string }).token;
    const renew = (body: unknown) => makeRenew(deps)(new Request("https://site.test/api/license/renew", { method: "POST", body: JSON.stringify(body) }));
    const ok = await renew({ lic_id: SUB, renewal_token: token });
    expect(ok.status).toBe(200);
    const fresh = verify(((await ok.json()) as { key: string }).key);
    expect(fresh.ok && [fresh.payload.kind, fresh.payload.team]).toEqual(["license", teamA]);
    const wrong = await renew({ lic_id: SUB, renewal_token: "A".repeat(43) });
    expect([wrong.status, await wrong.json()]).toEqual([403, { error: "invalid_renewal" }]);
    const bare = await renew({ lic_id: SUB });
    expect(bare.status).toBe(400);
    // Stripe starts the next period; the authority's daily renewer (due within 7 days) picks it up.
    const cur = stripe.subs.get(SUB)!;
    stripe.subs.set(SUB, { ...cur, items: { data: [{ ...cur.items.data[0]!, quantity: 6, current_period_end: periodEnd(Date.now() + 60 * DAY) }] } });
    const expires = alex.d.core.roster.license!.payload.expires_at;
    const renewer = new LicenseRenewer(alex.d.core, createLogger({}), { service: new LicenseService({ base: "https://site.test", fetch: siteFetch }), now: () => expires - 3 * DAY });
    expect(await renewer.tick()).toBe("renewed");
    expect(alex.d.core.roster.license?.payload).toMatchObject({ team: teamA, seats: 6 });
    expect(JSON.parse(readFileSync(join(alex.home, RENEW_TOKEN_FILE), "utf8")).token).toBe(token);
  });

  test("a key for team A is rejected on team B: by activation (400 wrong_team) and by B's chain itself", async () => {
    const r = await walkie(bob, ["license", "activate", keyA]);
    expect([r.code, r.err.includes("wrong_team")]).toEqual([1, true]);
    let msg = "";
    try { bob.d.core.emit("team.license", { key: keyA }); } catch (err) { msg = (err as Error).message; }
    expect(msg).toBe("event rejected: bad_license");
    expect(bob.d.core.roster.license).toBeUndefined();
    expect((await bob.client().license()).status).toBe("trial");
    expect(teamA).not.toBe(teamB);
  });
});
