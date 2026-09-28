// LICENSE-FIX-1 (docs/audits/2026-09-26-hestia-codex-license.md): team-bound licenses (H3), the
// rollback-resistant plan clock (M4), the team-wide integration count (M5), the pinned license service
// (M6), the renewal race (M7) and the renewal token.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "../../src/daemon/core.ts";
import { HttpError } from "../../src/daemon/http.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { SubmitResult } from "../../src/daemon/requests.ts";
import { activateOnAuthority, checkActivatable } from "../../src/license/activate.ts";
import { IntegrationSlots, setIntegrationSlot, slotHeld } from "../../src/license/integrations.ts";
import { DAY_MS, FUTURE_SKEW_MS, GRACE_MS, TRIAL_MS } from "../../src/license/plans.ts";
import { LicenseRenewer } from "../../src/license/renew.ts";
import { loadRenewToken, saveRenewToken, RENEW_TOKEN_FILE } from "../../src/license/renew-token.ts";
import { LicenseService, serviceBaseFromEnv } from "../../src/license/service.ts";
import { SITE_ORIGIN } from "../../src/license/site.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, reopen, statusOf } from "../helpers/core.ts";
import { createTeam, ev, now, tnode, type TNode } from "../helpers/events.ts";
import { testVendor } from "../helpers/license.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const vendor = testVendor();
const log = createLogger({});

function thrown(fn: () => unknown): HttpError | undefined {
  try { fn(); } catch (err) { if (err instanceof HttpError) return err; throw err; }
  return undefined;
}

function authority(opts: { clock?: () => number } = {}): { a: TNode; team: string; create: Event; core: Core } {
  const a = tnode("alex");
  const { team, create } = createTeam(a);
  const core = makeCore(a, team, cleanups, { licenseVerifier: vendor.verify, ...opts });
  core.ingest(create, "local");
  return { a, team, create, core };
}

// ---- H3: a license is bound to one team ---------------------------------------------------------------

describe("H3: team-bound licenses", () => {
  test("the chain applies a license only when it names this team; another team's key and an activation code are rejected", () => {
    const a = tnode("alex");
    const { team, create } = createTeam(a);
    const other = createTeam(tnode("zed"), "other").team;
    const theirs = ev(team, a, "team.license", { key: vendor.issue({ team: other, seats: 99 }) });
    const code = ev(team, a, "team.license", { key: vendor.code({ seats: 50 }) });
    const mine = ev(team, a, "team.license", { key: vendor.issue({ team, seats: 3 }) });
    const core = makeCore(tnode("obs"), team, cleanups, { licenseVerifier: vendor.verify });
    feed(core, [create, theirs, code]);
    expect([statusOf(core, theirs.id), core.store.getRow(theirs.id)?.reason]).toEqual(["rejected", "bad_license"]);
    expect([statusOf(core, code.id), core.store.getRow(code.id)?.reason]).toEqual(["rejected", "bad_license"]);
    expect(core.roster.license).toBeUndefined();
    feed(core, [mine]);
    expect(core.roster.license?.payload).toMatchObject({ team, seats: 3, kind: "license" });
  });

  test("activation refuses another team's key (400 wrong_team) and an activation code (400 activation_code) before signing anything", () => {
    const { team, core } = authority();
    const foreign = vendor.issue({ team: "abcdefabcdefabcd" });
    expect([thrown(() => checkActivatable(core, foreign))?.status, thrown(() => checkActivatable(core, foreign))?.code]).toEqual([400, "wrong_team"]);
    expect(thrown(() => checkActivatable(core, vendor.code()))?.code).toBe("activation_code");
    // Even the authority's own emit (bypassing the activation checks) is refused by the chain's validity rule.
    expect(thrown(() => core.emit("team.license", { key: foreign }))?.message).toBe("event rejected: bad_license");
    expect(activateOnAuthority(core, vendor.issue({ team }))?.kind).toBe("team.license");
  });
});

// ---- M4: rolling the clock back can't resurrect a trial or a license --------------------------------

describe("M4: the plan clock never goes backwards", () => {
  test("after the trial ended, setting the clock back into it still evaluates as Free; the floor survives a restart", () => {
    let t = now();
    const { a, create, core } = authority({ clock: () => t });
    t = create.ts + DAY_MS;
    core.emit("channel.upsert", { name: "general" });
    expect(core.plan()?.status).toBe("trial");
    t = create.ts + TRIAL_MS + DAY_MS;
    core.emit("channel.upsert", { name: "general", topic: "after the trial" }); // an emit records the time
    expect(core.plan()?.status).toBe("free");
    t = create.ts + DAY_MS; // clock rolled back into the trial
    expect(core.plan()?.status).toBe("free");
    expect(thrown(() => core.emit("channel.upsert", { name: "ops", members: ["alex"] }))?.code).toBe("plan_limit");
    expect(Number(core.store.getMeta("plan_floor"))).toBe(create.ts + TRIAL_MS + DAY_MS);
    // A restart with the clock within a day of the floor keeps it; more than a day behind resets it
    // (FINAL-2 Fable 3: the price of an authority recovering from its own wrong clock).
    t = create.ts + TRIAL_MS + 2 * 60 * 60_000;
    expect(reopen(core, a).plan()?.status).toBe("free");
    t = create.ts + DAY_MS;
    const again = reopen(core, a);
    expect(again.plan()?.status).toBe("trial");
    expect(Number(again.store.getMeta("plan_floor"))).toBe(create.ts + DAY_MS + FUTURE_SKEW_MS);
  });

  test("an expired license can't be revived by rolling back, and noteTime() (the hourly tick) records the time without an emit", () => {
    let t = now();
    const { team, create, core } = authority({ clock: () => t });
    t = create.ts + TRIAL_MS + 1;
    const key = vendor.issue({ team, issued_at: t, expires_at: t + 30 * DAY_MS });
    activateOnAuthority(core, key, t);
    expect(core.plan()?.status).toBe("active");
    t = t + 30 * DAY_MS + GRACE_MS + DAY_MS;
    core.noteTime();
    expect(core.plan()?.status).toBe("free");
    t = create.ts + TRIAL_MS + 2;
    expect(core.plan()?.status).toBe("free");
    // Activation checks use the floor too: a key that lapsed past grace by the floor is refused.
    expect(thrown(() => checkActivatable(core, key))?.code).toBe("license_expired");
  });
});

// ---- M5 (now F3): the integration count is team-wide, decided at the authority from the chain -------

const eventOf = (r: SubmitResult): Event | null => ("event" in r ? r.event : null);

describe("M5/F3: integrations are counted across the whole team on the chain", () => {
  /** A Free team (trial over) with a second machine holding the `linear` slot on the chain. */
  function freeTeamWithRemoteLinear() {
    let t = 0;
    const a = tnode("alex"), b = tnode("bea");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups, { licenseVerifier: vendor.verify, clock: () => t });
    t = create.ts + 1;
    core.ingest(create, "local");
    core.emit("team.member", { login: b.login, handle: b.handle, role: "member" });
    core.emit("team.node", { node_id: b.keys.nodeId, login: b.login, hostname: b.hostname, pubkey: b.keys.pubkey, ip: "127.0.0.1" });
    core.emit("team.integration", { connector: "linear", node: b.keys.nodeId, enabled: true });
    t = create.ts + TRIAL_MS + DAY_MS; // Free: 1 integration
    return { core, b };
  }

  test("a Free team with Linear on another machine can't take a Fireflies slot here (402 plan_limit, counted 2); the same connector is fine", async () => {
    const { core } = freeTeamWithRemoteLinear();
    expect(slotHeld(core, "fireflies")).toBe(false);
    let err: HttpError | undefined;
    try { await setIntegrationSlot({ core }, "fireflies", true); } catch (e) { err = e as HttpError; }
    expect([err?.status, err?.code]).toEqual([402, "plan_limit"]);
    expect(err?.details).toMatchObject({ resource: "integrations", limit: 1, used: 1 });
    expect(slotHeld(core, "fireflies")).toBe(false);
    expect(eventOf(await setIntegrationSlot({ core }, "linear", true))?.kind).toBe("team.integration");
    expect(slotHeld(core, "linear")).toBe(true);
    expect(eventOf(await setIntegrationSlot({ core }, "linear", true))).toBeNull(); // already held: a no-op
  });

  test("a slot released on the other machine makes room; disabling is never limited", async () => {
    const { core, b } = freeTeamWithRemoteLinear();
    core.emit("team.integration", { connector: "linear", node: b.keys.nodeId, enabled: false });
    expect(eventOf(await setIntegrationSlot({ core }, "fireflies", true))?.kind).toBe("team.integration");
    expect(eventOf(await setIntegrationSlot({ core }, "fireflies", false))?.kind).toBe("team.integration");
    expect(core.roster.integrations?.size ?? 0).toBe(0);
  });

  test("the reconciler asks for a slot for a connector enabled locally without one, releases a disabled one's, and turns on a pending one", async () => {
    const { core } = authority();
    const settings: Record<string, { enabled?: boolean; pending_enable?: boolean }> = { wispr: { enabled: true }, linear: { enabled: false, pending_enable: true } };
    const turnedOn: string[] = [];
    const slots = new IntegrationSlots({ core }, { settings: (id) => settings[id] ?? {}, enablePending: (id) => turnedOn.push(id) }, log);
    await slots.reconcile();
    expect(slotHeld(core, "wispr")).toBe(true);
    expect(turnedOn).toEqual([]); // no slot yet for the pending one: it waits for its request
    core.emit("team.integration", { connector: "linear", node: core.nodeId, enabled: true }); // the authority accepted meanwhile
    await slots.reconcile();
    expect(turnedOn).toEqual(["linear"]);
    settings.wispr = { enabled: false };
    await slots.reconcile();
    expect(slotHeld(core, "wispr")).toBe(false);
  });
});

// ---- M6: the license service origin is pinned ------------------------------------------------------

describe("M6: pinned license service", () => {
  test("WALKIE_LICENSE_URL is honored only for http loopback AND WALKIE_DEV=1", () => {
    expect(serviceBaseFromEnv({})).toBe(SITE_ORIGIN);
    expect(serviceBaseFromEnv({ WALKIE_LICENSE_URL: "https://attacker.example/api" })).toBe(SITE_ORIGIN);
    expect(serviceBaseFromEnv({ WALKIE_LICENSE_URL: "https://attacker.example/api", WALKIE_DEV: "1" })).toBe(SITE_ORIGIN);
    expect(serviceBaseFromEnv({ WALKIE_LICENSE_URL: "http://127.0.0.1:9000/x" })).toBe(SITE_ORIGIN);
    expect(serviceBaseFromEnv({ WALKIE_LICENSE_URL: "http://127.0.0.1:9000/x", WALKIE_DEV: "1" })).toBe("http://127.0.0.1:9000");
    expect(serviceBaseFromEnv({ WALKIE_LICENSE_URL: "http://localhost:3000", WALKIE_DEV: "1" })).toBe("http://localhost:3000");
    expect(serviceBaseFromEnv({ WALKIE_LICENSE_URL: "http://127.0.0.1.attacker.example/", WALKIE_DEV: "1" })).toBe(SITE_ORIGIN);
    expect(serviceBaseFromEnv({ WALKIE_LICENSE_URL: "http://localhost@attacker.example/", WALKIE_DEV: "1" })).toBe(SITE_ORIGIN);
  });

  test("requests never follow redirects and go to <base>/api/license/{bind,renew}", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const s = new LicenseService({ fetch: async (url, init) => { calls.push({ url, init }); return Response.json({ ok: true }); } });
    await s.bind("code", "0123456789abcdef");
    await s.renew("sub_1", "tok");
    expect(calls.map((c) => c.url)).toEqual([`${SITE_ORIGIN}/api/license/bind`, `${SITE_ORIGIN}/api/license/renew`]);
    expect(calls.every((c) => c.init.redirect === "error" && c.init.method === "POST")).toBe(true);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: "code", team_id: "0123456789abcdef" });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ lic_id: "sub_1", renewal_token: "tok" });
  });
});

// ---- renewal token + M7 --------------------------------------------------------------------------

describe("renewal with the renewal token", () => {
  const TOKEN = "t".repeat(43);
  function licensed(expiresIn: number) {
    const { team, core } = authority();
    const key = vendor.issue({ team, lic_id: "sub_abc", issued_at: now() - DAY_MS, expires_at: now() + expiresIn });
    core.emit("team.license", { key });
    return { team, core, key };
  }

  test("the token file is 0600 and round-trips; a missing or other-license token means no call at all", async () => {
    const { team, core } = licensed(DAY_MS);
    let called = 0;
    const service = new LicenseService({ fetch: async () => { called++; return Response.json({}); } });
    expect(await new LicenseRenewer(core, log, { service, now }).tick()).toBe("no_token");
    saveRenewToken(core.paths.home, { lic_id: "sub_other", team, token: TOKEN });
    expect(await new LicenseRenewer(core, log, { service, now }).tick()).toBe("no_token");
    expect(called).toBe(0);
    saveRenewToken(core.paths.home, { lic_id: "sub_abc", team, token: TOKEN });
    expect(statSync(join(core.paths.home, RENEW_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    expect(loadRenewToken(core.paths.home)).toEqual({ lic_id: "sub_abc", team, token: TOKEN });
  });

  test("due: POSTs {lic_id, renewal_token}; a key for another team is refused", async () => {
    const { team, core } = licensed(3 * DAY_MS);
    saveRenewToken(core.paths.home, { lic_id: "sub_abc", team, token: TOKEN });
    const bodies: unknown[] = [];
    const reply = (key: string) => new LicenseService({ fetch: async (_u, init) => { bodies.push(JSON.parse(String(init.body))); return Response.json({ key }); } });
    const foreign = vendor.issue({ team: "abcdefabcdefabcd", lic_id: "sub_abc", seats: 12, issued_at: now(), expires_at: now() + 35 * DAY_MS });
    expect(await new LicenseRenewer(core, log, { service: reply(foreign), now }).tick()).toBe("failed");
    const fresh = vendor.issue({ team, lic_id: "sub_abc", seats: 12, issued_at: now(), expires_at: now() + 35 * DAY_MS });
    expect(await new LicenseRenewer(core, log, { service: reply(fresh), now }).tick()).toBe("renewed");
    expect(bodies).toEqual([{ lic_id: "sub_abc", renewal_token: TOKEN }, { lic_id: "sub_abc", renewal_token: TOKEN }]);
    expect(core.roster.license?.payload.seats).toBe(12);
  });

  test("M7: a license activated while the renewal was in flight is not overwritten by the renewal's answer", async () => {
    const { team, core } = licensed(3 * DAY_MS);
    saveRenewToken(core.paths.home, { lic_id: "sub_abc", team, token: TOKEN });
    const newer = vendor.issue({ team, lic_id: "sub_new", plan: "business", seats: 40, issued_at: now(), expires_at: now() + 365 * DAY_MS });
    const renewed = vendor.issue({ team, lic_id: "sub_abc", seats: 12, issued_at: now(), expires_at: now() + 35 * DAY_MS });
    const service = new LicenseService({
      fetch: async () => {
        activateOnAuthority(core, newer); // the owner activates license B meanwhile
        return Response.json({ key: renewed });
      },
    });
    expect(await new LicenseRenewer(core, log, { service, now }).tick()).toBe("superseded");
    expect(core.roster.license?.key).toBe(newer);
  });
});

describe("renew token store", () => {
  test("rejects a malformed file instead of sending it", () => {
    const dir = mkdtempSync("/tmp/walkie-tok-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(loadRenewToken(dir)).toBeNull();
    writeFileSync(join(dir, RENEW_TOKEN_FILE), "not json");
    expect(loadRenewToken(dir)).toBeNull();
  });
});
