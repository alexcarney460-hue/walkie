// WALKIE-LICENSE-1: the license format, plans/entitlements, the enforcement rules, the CLI text and
// the renewal loop. Chain and core behavior: license-chain.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { sign } from "node:crypto";
import { WalkieError } from "../../src/client/index.ts";
import { planLimitText, planLine } from "../../src/cli/commands/license.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { EMPTY_ROSTER, applyRosterEvent, type Roster } from "../../src/daemon/roster.ts";
import { assertIntegrationAllowed, planLimitFor, planLimitFromPeer } from "../../src/license/enforce.ts";
import { decodeLicense, verifyLicense } from "../../src/license/format.ts";
import { DAY_MS, FREE, GRACE_MS, TRIAL_MS, effective, planView, type LicenseState } from "../../src/license/plans.ts";
import { LicenseRenewer } from "../../src/license/renew.ts";
import { saveRenewToken } from "../../src/license/renew-token.ts";
import { LicenseService, type FetchLike } from "../../src/license/service.ts";
import { MANAGE_URL, SITE_ORIGIN, checkoutUrl } from "../../src/license/site.ts";
import { VENDOR_PUBLIC_KEY_B64 } from "../../src/license/vendor-key.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, now, tnode } from "../helpers/events.ts";
import { testVendor } from "../helpers/license.ts";
import { c } from "../../src/cli/format.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const vendor = testVendor();
const T0 = 1_800_000_000_000;

function stateOf(key: string): LicenseState {
  const d = decodeLicense(key);
  if ("error" in d) throw new Error(d.error);
  return { key, payload: d.payload, event_id: "0123456789abcdef:9" };
}

describe("license format", () => {
  test("a signed key verifies with its vendor key and decodes its payload", () => {
    const key = vendor.issue({ plan: "business", seats: 7, team: "0123456789abcdef" });
    const r = vendor.verify(key);
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.payload.kind, r.payload.plan, r.payload.seats, r.payload.team]).toEqual(["license", "business", 7, "0123456789abcdef"]);
    const code = vendor.verify(vendor.code({ seats: 4 }));
    expect(code.ok && [code.payload.kind, code.payload.team]).toEqual(["activation", undefined]);
  });

  test("the production verifier is bound to the embedded vendor key and rejects any other signer", () => {
    expect(VENDOR_PUBLIC_KEY_B64).toBe("MGBsUknkf2XnCPY6LawlhMKAl0fc4CrIGuZ3rDqJnsA=");
    expect(verifyLicense(vendor.issue())).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("rejects a tampered payload, a foreign signature, wrong version, seats < 1 and malformed keys", () => {
    const key = vendor.issue({ seats: 3 });
    const [seg, sig] = key.split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<string, unknown>;
    const resign = (p: Record<string, unknown>): string => {
      const s = Buffer.from(JSON.stringify(p)).toString("base64url");
      return `${s}.${sign(null, Buffer.from(s), vendor.privateKey).toString("base64url")}`;
    };
    const bumped = Buffer.from(JSON.stringify({ ...payload, seats: 300 })).toString("base64url");
    expect(vendor.verify(`${bumped}.${sig}`)).toEqual({ ok: false, reason: "bad_signature" });
    expect(vendor.verify(testVendor().issue())).toEqual({ ok: false, reason: "bad_signature" });
    expect(vendor.verify(resign({ ...payload, v: 1 }))).toEqual({ ok: false, reason: "wrong_version" });
    // A license must name its team and an activation code must not (the signature alone isn't enough).
    const { team: _t, ...noTeam } = payload;
    expect(vendor.verify(resign(noTeam))).toEqual({ ok: false, reason: "bad_payload" });
    expect(vendor.verify(resign({ ...payload, kind: "activation" }))).toEqual({ ok: false, reason: "bad_payload" });
    expect(vendor.verify(resign({ ...payload, team: "ACME" }))).toEqual({ ok: false, reason: "bad_payload" });
    expect(vendor.verify(resign({ ...payload, kind: "gift" }))).toEqual({ ok: false, reason: "bad_payload" });
    expect(vendor.verify(resign({ ...payload, seats: 0 }))).toEqual({ ok: false, reason: "bad_seats" });
    expect(vendor.verify(resign({ ...payload, plan: "enterprise" }))).toEqual({ ok: false, reason: "bad_payload" });
    expect(vendor.verify(resign({ ...payload, expires_at: payload.issued_at }))).toEqual({ ok: false, reason: "bad_payload" });
    for (const bad of ["", "abc", `${seg}.${sig}.x`, `${seg}=.${sig}`, `${seg}.${sig}==`, `${seg}.${sig.slice(0, -4)}`, "x".repeat(5000)]) {
      expect(vendor.verify(bad).ok).toBe(false);
    }
    expect(vendor.verify(key).ok).toBe(true);
  });

  test("review: surrounding whitespace is not a second valid spelling", () => {
    const key = vendor.issue();
    for (const k of [` ${key}`, `${key}\n`, `${key} `]) expect(vendor.verify(k)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("review fixes", () => {
  test("Team is capped at 50 people whatever the seat count; Business is not", () => {
    const team = stateOf(vendor.issue({ plan: "team", seats: 80, issued_at: T0, expires_at: T0 + 35 * DAY_MS }));
    const biz = stateOf(vendor.issue({ plan: "business", seats: 80, issued_at: T0, expires_at: T0 + 35 * DAY_MS }));
    expect(effective(team, T0, T0 + DAY_MS).entitlements.people).toBe(50);
    expect(effective(biz, T0, T0 + DAY_MS).entitlements.people).toBe(80);
  });

  test("a renewal body over the cap is refused even without Content-Length", async () => {
    const a = tnode("alex");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups, { licenseVerifier: vendor.verify });
    core.ingest(create, "local");
    core.emit("team.license", { key: vendor.issue({ team, lic_id: "sub_cap", issued_at: now() - DAY_MS, expires_at: now() + DAY_MS }) });
    saveRenewToken(core.paths.home, { lic_id: "sub_cap", team, token: "k".repeat(43) });
    const big = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(1024).fill(65)); c.close(); },
    });
    const r = new LicenseRenewer(core, createLogger({}), { now, service: new LicenseService({ base: "https://x.test", fetch: async () => new Response(big) }) });
    expect(await r.tick()).toBe("failed");
  });
});

describe("plans and effective entitlements", () => {
  const created = T0;
  const lic = (p: Parameters<typeof vendor.issue>[0]) => stateOf(vendor.issue({ issued_at: T0, expires_at: T0 + 35 * DAY_MS, ...p }));

  test("trial for 14 days from team.create, then Free", () => {
    expect(effective(null, created, created + TRIAL_MS - 1)).toMatchObject({ plan: "team", status: "trial" });
    expect(effective(null, created, created + TRIAL_MS - 1).entitlements.people).toBe(50);
    expect(effective(null, created, created + TRIAL_MS)).toEqual({ plan: "free", status: "free", entitlements: FREE });
    expect(FREE).toEqual({ people: 2, machines: 4, restricted_channels: false, integrations: 1, audit_export: false, join_approval: false });
  });

  test("a license applies while valid and for 14 days of grace, then the team is Free (or on trial)", () => {
    const l = lic({ plan: "team", seats: 10 });
    const exp = l.payload.expires_at;
    expect(effective(l, created, exp)).toMatchObject({ plan: "team", status: "active" });
    expect(effective(l, created, exp).entitlements).toEqual({ people: 10, machines: null, restricted_channels: true, integrations: null, audit_export: false, join_approval: false });
    expect(effective(l, created, exp + GRACE_MS)).toMatchObject({ plan: "team", status: "grace" });
    expect(effective(l, created, exp + GRACE_MS + 1)).toMatchObject({ plan: "free", status: "free" });
    // A license that lapsed while the trial still runs falls back to the trial.
    const short = lic({ expires_at: T0 + DAY_MS });
    expect(effective(short, created, T0 + DAY_MS + GRACE_MS - 1)).toMatchObject({ status: "grace" });
    expect(effective(short, T0 + 5 * DAY_MS, T0 + DAY_MS + GRACE_MS + 1)).toMatchObject({ plan: "team", status: "trial" });
  });

  test("Business = Team plus audit_export and join_approval", () => {
    const e = effective(lic({ plan: "business", seats: 4 }), created, T0 + DAY_MS).entitlements;
    expect(e).toEqual({ people: 4, machines: null, restricted_channels: true, integrations: null, audit_export: true, join_approval: true });
  });

  test("planView reports usage, trial days left (rounded up) and links on the one site origin", () => {
    const v = planView(null, created, { people: 3, machines: 5 }, created + 4.5 * DAY_MS);
    expect(v).toMatchObject({ plan: "team", status: "trial", seats: { used: 3, limit: 50 }, machines: { used: 5, limit: null }, license: null });
    expect(v.trial).toEqual({ ends_at: created + TRIAL_MS, days_left: 10 });
    expect(v.upgrade_url).toBe(`${SITE_ORIGIN}/api/checkout?plan=team&interval=month&seats=3`);
    expect(v.manage_url.startsWith(SITE_ORIGIN)).toBe(true);
    const l = lic({ seats: 10 });
    const lv = planView(l, created, { people: 7, machines: 9 }, T0 + DAY_MS);
    expect(lv.license).not.toHaveProperty("org");
    expect(lv.license).toMatchObject({ seats: 10, grace_ends_at: l.payload.expires_at + GRACE_MS });
    expect(lv.trial).toBeNull();
  });
});

describe("enforcement rules (emit-time only)", () => {
  // A roster built by folding (no validation needed for the rule tests).
  const a = tnode("alex"), b = tnode("bea"), k = tnode("kira");
  const { team, create } = createTeam(a);
  const base: Event[] = [create, memberEv(team, a, b, "member"), nodeEv(team, a, b), ev(team, a, "channel.upsert", { name: "secret", members: ["alex", "bea"] })];
  const roster = base.reduce<Roster>((r, e) => applyRosterEvent(r, e), EMPTY_ROSTER);
  const freeAt = roster.team!.created_ts + TRIAL_MS + 1;
  const trialAt = roster.team!.created_ts + 1;

  test("Free: a third person, a fifth machine and a new restricted channel are refused with the details", () => {
    const hit = planLimitFor(roster, "team.member", { login: k.login, handle: "kira", role: "member" }, freeAt);
    expect(hit).toEqual({ resource: "people", limit: 2, used: 2, plan: "free", subscribed: false, upgrade_url: checkoutUrl("team", "month", 3) });
    expect(planLimitFor(roster, "channel.upsert", { name: "ops", members: ["alex"] }, freeAt)?.resource).toBe("restricted_channels");
    expect(planLimitFor(roster, "channel.upsert", { name: "general" }, freeAt)).toBeNull();
    const m = (i: number) => ({ node_id: `${i}`.padStart(16, "a"), login: b.login });
    let r = roster;
    for (let i = 0; i < 2; i++) r = applyRosterEvent(r, nodeEv(team, a, tnode("bea", b.login, `b${i}`)));
    expect(planLimitFor(r, "team.node", m(1), freeAt)).toMatchObject({ resource: "machines", limit: 4, used: 4 });
    expect(planLimitFor(r, "team.node", { ...m(1), revoked: true }, freeAt)).toBeNull();
  });

  test("changes that add nothing are never limited: role changes, removals, re-pins, existing restricted channels, licenses", () => {
    expect(planLimitFor(roster, "team.member", { login: b.login, handle: "bea", role: "owner" }, freeAt)).toBeNull();
    expect(planLimitFor(roster, "team.member", { login: b.login, handle: "bea", role: "removed" }, freeAt)).toBeNull();
    expect(planLimitFor(roster, "team.node", { node_id: b.keys.nodeId, login: b.login }, freeAt)).toBeNull();
    expect(planLimitFor(roster, "channel.upsert", { name: "secret", members: ["alex"], topic: "t" }, freeAt)).toBeNull();
    expect(planLimitFor(roster, "channel.upsert", { name: "secret", public: true }, freeAt)).toBeNull();
    expect(planLimitFor(roster, "team.license", { key: "x" }, freeAt)).toBeNull();
    expect(planLimitFor(roster, "team.authority", { node_id: b.keys.nodeId }, freeAt)).toBeNull();
  });

  test("re-inviting a removed member counts as adding a person", () => {
    const r = applyRosterEvent(roster, memberEv(team, a, b, "removed"));
    const again = { login: b.login, handle: "bea", role: "member" };
    expect(planLimitFor(r, "team.member", again, freeAt)).toBeNull(); // 1 person left
    const full = applyRosterEvent(r, memberEv(team, a, k, "member"));
    expect(planLimitFor(full, "team.member", again, freeAt)?.resource).toBe("people");
  });

  test("the trial allows all of it", () => {
    expect(planLimitFor(roster, "team.member", { login: k.login, handle: "kira", role: "member" }, trialAt)).toBeNull();
    expect(planLimitFor(roster, "channel.upsert", { name: "ops", members: ["alex"] }, trialAt)).toBeNull();
  });

  test("assertIntegrationAllowed: Free allows one enabled integration; the trial all", () => {
    expect(() => assertIntegrationAllowed({ roster }, 1, freeAt)).not.toThrow();
    let err: unknown;
    try { assertIntegrationAllowed({ roster }, 2, freeAt); } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 402, code: "plan_limit", details: { resource: "integrations", limit: 1, used: 1 } });
    expect(() => assertIntegrationAllowed({ roster }, 3, trialAt)).not.toThrow();
  });

  test("a relayed plan_limit keeps only validated numbers and gets a locally built link (checkout, or the portal when OUR chain holds an active license)", () => {
    const d = planLimitFromPeer({ resource: "people", limit: 2, used: 2, plan: "free", subscribed: true, upgrade_url: "https://evil.example/x", code: "plan_limit" }, roster, freeAt);
    expect(d).toEqual({ resource: "people", limit: 2, used: 2, plan: "free", subscribed: false, upgrade_url: checkoutUrl("team", "month", 3) });
    expect(planLimitFromPeer({ resource: "people", limit: -1, used: 2, plan: "free" }, roster, freeAt)).toBeUndefined();
    expect(planLimitFromPeer("nope", roster, freeAt)).toBeUndefined();
    const licensed = { ...roster, license: stateOf(vendor.issue({ team, seats: 2, issued_at: T0, expires_at: T0 + 35 * DAY_MS })) };
    const p = planLimitFromPeer({ resource: "people", limit: 2, used: 2, plan: "team", subscribed: false }, licensed, T0 + DAY_MS);
    expect(p).toEqual({ resource: "people", limit: 2, used: 2, plan: "team", subscribed: true, upgrade_url: MANAGE_URL });
  });
});

describe("CLI plan text", () => {
  const base = planView(null, T0, { people: 2, machines: 3 }, T0 + TRIAL_MS + 1);
  test("plan lines", () => {
    expect(planLine(base)).toBe("Free · 2/2 people");
    expect(planLine(planView(null, T0, { people: 2, machines: 3 }, T0 + 4.5 * DAY_MS))).toBe("Team trial · 10 days left");
    const l = stateOf(vendor.issue({ seats: 10, issued_at: T0, expires_at: T0 + 35 * DAY_MS }));
    expect(planLine(planView(l, T0, { people: 7, machines: 9 }, T0 + DAY_MS), T0 + DAY_MS)).toBe("Team · 7/10 seats");
    expect(planLine(planView(l, T0, { people: 7, machines: 9 }, T0 + 30 * DAY_MS), T0 + 30 * DAY_MS)).toBe("Team · 7/10 seats · renews in 5 days");
    expect(planLine(planView(l, T0, { people: 7, machines: 9 }, T0 + 40 * DAY_MS))).toContain("renewal overdue, grace until");
  });
  test("a 402 prints a friendly upgrade message", () => {
    const err = new WalkieError("plan_limit", "x", 402, { resource: "people", limit: 2, used: 2, plan: "free", upgrade_url: "https://getwalkie.vercel.app/api/checkout?plan=team&interval=month&seats=3" });
    const text = planLimitText(err) ?? "";
    expect(text).toContain("Your Free plan includes 2 people (2 in use).");
    expect(text).toContain(c.bold("https://getwalkie.vercel.app/api/checkout?plan=team&interval=month&seats=3"));
    expect(planLimitText(new WalkieError("forbidden", "x", 403))).toBeNull();
  });
});

describe("renewal", () => {
  function licensedAuthority(expiresIn: number) {
    const a = tnode("alex");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups, { licenseVerifier: vendor.verify });
    core.ingest(create, "local");
    const key = vendor.issue({ team, lic_id: "sub_abc", issued_at: now() - DAY_MS, expires_at: now() + expiresIn });
    core.emit("team.license", { key });
    saveRenewToken(core.paths.home, { lic_id: "sub_abc", team, token: TOKEN });
    return { core, key, team };
  }
  const TOKEN = "r".repeat(43);
  const log = createLogger({});
  type Call = { url: string; init: RequestInit };
  const fetcher = (calls: Call[], respond: () => Response): FetchLike => async (url, init) => { calls.push({ url, init }); return respond(); };
  const service = (f: FetchLike) => new LicenseService({ base: "https://x.test", fetch: f });

  test("not due (more than 7 days left): only the daily status check-in, no renewal", async () => {
    const { core } = licensedAuthority(20 * DAY_MS);
    const calls: Call[] = [];
    const r = new LicenseRenewer(core, log, { now, service: service(fetcher(calls, () => new Response("{}"))) });
    expect(await r.tick()).toBe("not_due");
    expect(calls.map((c) => c.url)).toEqual(["https://x.test/api/license/status"]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ lic_id: "sub_abc", renewal_token: TOKEN, issued_at: core.roster.license?.payload.issued_at });
  });

  test("FINAL Codex 4: not due, but the service reports a newer grant → renewed at once; a status outage is a quiet not_due; `refresh` renews on demand", async () => {
    const { core, team } = licensedAuthority(20 * DAY_MS);
    const fresh = vendor.issue({ team, lic_id: "sub_abc", seats: 12, issued_at: now(), expires_at: now() + 35 * DAY_MS });
    const calls: Call[] = [];
    const svc = service(async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/status")) return Response.json({ seats: 12, plan: "team", interval: "month", expires_at: now() + 35 * DAY_MS, status: "active", newer: true });
      return Response.json({ key: fresh });
    });
    expect(await new LicenseRenewer(core, log, { now, service: svc }).tick()).toBe("refreshed");
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["status", "renew"]);
    expect(core.roster.license?.payload.seats).toBe(12);
    // The status says the seats differ even without `newer` (an older site): still refreshed.
    const more = vendor.issue({ team, lic_id: "sub_abc", seats: 15, issued_at: now(), expires_at: now() + 35 * DAY_MS });
    const svc2 = service(async (url) => Response.json(url.endsWith("/status") ? { seats: 15, plan: "team", newer: false } : { key: more }));
    expect(await new LicenseRenewer(core, log, { now, service: svc2 }).tick()).toBe("refreshed");
    expect(core.roster.license?.payload.seats).toBe(15);
    // Outage on the check-in: not_due, nothing else called.
    const down: Call[] = [];
    expect(await new LicenseRenewer(core, log, { now, service: service(fetcher(down, () => { throw new Error("ECONNREFUSED"); })) }).tick()).toBe("not_due");
    expect(down.length).toBe(1);
    // Manual refresh: renew regardless of the expiry; a same grant is "unchanged".
    const { refreshLicense } = await import("../../src/license/renew.ts");
    expect((await refreshLicense(core, service(async () => Response.json({ key: more })), log)).outcome).toBe("unchanged");
    const bigger = vendor.issue({ team, lic_id: "sub_abc", seats: 20, issued_at: now(), expires_at: now() + 35 * DAY_MS });
    expect((await refreshLicense(core, service(async () => Response.json({ key: bigger })), log)).outcome).toBe("refreshed");
    expect(core.roster.license?.payload.seats).toBe(20);
    let err: unknown;
    try { await refreshLicense(core, service(async () => Response.json({ error: "subscription_inactive" }, { status: 402 })), log); } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 402, code: "subscription_inactive" });
  });

  test("due: POSTs only {lic_id, renewal_token} and activates the returned key", async () => {
    const { core, team } = licensedAuthority(3 * DAY_MS);
    const fresh = vendor.issue({ team, lic_id: "sub_abc", seats: 12, issued_at: now(), expires_at: now() + 35 * DAY_MS });
    const calls: Call[] = [];
    const r = new LicenseRenewer(core, log, { now, service: service(fetcher(calls, () => Response.json({ key: fresh }))) });
    expect(await r.tick()).toBe("renewed");
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://x.test/api/license/renew");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ lic_id: "sub_abc", renewal_token: TOKEN });
    expect(core.roster.license?.payload.seats).toBe(12);
    expect(await r.tick()).toBe("not_due");
  });

  test("the same grant re-issued before Stripe starts the next period adds nothing to the chain", async () => {
    const { core, key } = licensedAuthority(3 * DAY_MS);
    const cur = core.roster.license!.payload;
    const same = vendor.issue({ ...cur, issued_at: cur.issued_at + 1000 });
    const r = new LicenseRenewer(core, log, { now, service: service(fetcher([], () => Response.json({ key: same }))) });
    expect(await r.tick()).toBe("unchanged");
    expect(core.roster.license?.key).toBe(key);
  });

  test("failures are never fatal: 402, 403, network error, garbage, a key for another license, a forged key", async () => {
    const { core, key, team } = licensedAuthority(DAY_MS);
    const outcomes: string[] = [];
    const cases: (() => Response)[] = [
      () => Response.json({ error: "subscription_inactive" }, { status: 402 }),
      () => Response.json({ error: "invalid_renewal" }, { status: 403 }),
      () => { throw new Error("ECONNREFUSED"); },
      () => new Response("not json"),
      () => Response.json({ key: vendor.issue({ team, lic_id: "sub_other" }) }),
      () => Response.json({ key: testVendor().issue({ team, lic_id: "sub_abc" }) }),
    ];
    for (const respond of cases) outcomes.push(await new LicenseRenewer(core, log, { now, service: service(fetcher([], respond)) }).tick());
    expect(outcomes).toEqual(["refused", "refused", "failed", "failed", "failed", "failed"]);
    expect(core.roster.license?.key).toBe(key);
  });

  test("only the authority renews, and only with a license", async () => {
    const a = tnode("alex");
    const { team, create } = createTeam(a);
    const core = makeCore(a, team, cleanups, { licenseVerifier: vendor.verify });
    core.ingest(create, "local");
    expect(await new LicenseRenewer(core, log, { now, service: service(async () => { throw new Error("no"); }) }).tick()).toBe("no_license");
    const other = makeCore(tnode("bea"), team, cleanups, { licenseVerifier: vendor.verify });
    other.ingest(create, "remote");
    expect(await new LicenseRenewer(other, log, { now }).tick()).toBe("not_authority");
  });
});
