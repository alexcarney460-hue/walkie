// FINAL release audits (docs/audits/2026-09-26-fable-final.md, 2026-09-26-hestia-codex-final.md), unit level.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "../../src/daemon/http.ts";
import { readKeyFile } from "../../src/integrations/secrets.ts";
import { RELEASE_BUILD, serviceBaseFromEnv } from "../../src/license/service.ts";
import { SITE_ORIGIN } from "../../src/license/site.ts";
import { Core, FUTURE_HOLD_MS, FUTURE_SKEW_MS, PLAN_FLOOR_META } from "../../src/daemon/core.ts";
import { activateOnAuthority } from "../../src/license/activate.ts";
import { DAY_MS, TRIAL_MS, effective } from "../../src/license/plans.ts";
import { agentsView, askView, effectiveState, STALE_STATUS_MS } from "../../src/daemon/views.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, reopen, statusOf } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, now, tnode, type TNode } from "../helpers/events.ts";
import { testVendor } from "../helpers/license.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const vendor = testVendor();
const YEARS_10 = 10 * 365 * DAY_MS;

function thrown(fn: () => unknown): HttpError | undefined {
  try { fn(); } catch (err) { if (err instanceof HttpError) return err; throw err; }
  return undefined;
}

function nodeBody(n: TNode): { node_id: string; login: string; hostname: string; pubkey: string; ip: string } {
  return { node_id: n.keys.nodeId, login: n.login, hostname: n.hostname, pubkey: n.keys.pubkey, ip: "127.0.0.1" };
}

/** An authority with a settable clock, a member `m` admitted and #general. */
function team(opts: { license?: boolean; start?: number } = {}) {
  let t = opts.start ?? now();
  const a = tnode("alex"), m = tnode("mia");
  const { team: id, create } = createTeam(a);
  const A = makeCore(a, id, cleanups, { licenseVerifier: vendor.verify, clock: () => t });
  t = Math.max(t, create.ts + 1);
  A.ingest(create, "local");
  A.emit("team.member", { login: m.login, handle: m.handle, role: "member" });
  A.emit("team.node", nodeBody(m));
  A.emit("channel.upsert", { name: "general" });
  if (opts.license) A.emit("team.license", { key: vendor.issue({ team: id, plan: "business", seats: 10, issued_at: t }) });
  return { a, m, id, create, A, clock: () => t, setClock: (v: number) => { t = v; } };
}

// ---- Fable 1 (HIGH): the plan clock floor is never moved by another member's event -----------------------

describe("Fable 1: a member's event never moves the plan clock", () => {
  test("a member 10 years ahead cannot change the plan; invites still work; a fresh license still activates", () => {
    const { m, id, A, clock } = team({ license: true });
    expect(A.plan()?.status).toBe("active");
    const floorBefore = A.planNow();
    const poison = ev(id, m, "msg.post", { text: "hello from 2036" }, { channel: "general", ts: clock() + YEARS_10 });
    A.ingest(poison, "remote");
    expect(A.plan()).toMatchObject({ plan: "business", status: "active" });
    expect(A.planNow()).toBe(Math.max(clock(), floorBefore));
    expect(Number(A.store.getMeta(PLAN_FLOOR_META) ?? "0")).toBeLessThanOrEqual(clock() + FUTURE_SKEW_MS);
    // Adding people still works (Business: 10 seats) and a fresh key activates.
    const b = tnode("bea");
    expect(A.emit("team.member", { login: b.login, handle: b.handle, role: "member" }).kind).toBe("team.member");
    const fresh = vendor.issue({ team: id, plan: "business", seats: 12, issued_at: clock() });
    expect(activateOnAuthority(A, fresh)?.kind).toBe("team.license");
    expect(A.plan()?.seats.limit).toBe(12);
  });

  test("a member's future event within the hold band is accepted but moves no clock-derived state either", () => {
    const { m, id, A, clock } = team();
    const soon = ev(id, m, "msg.post", { text: "an hour ahead" }, { channel: "general", ts: clock() + 60 * 60_000 });
    expect(A.ingest(soon, "remote").status).toBe("accepted");
    expect(A.planNow()).toBe(clock());
  });

  test("an event more than 24 h ahead of the clock is held (future_ts), not rejected, and drains when the clock catches up", () => {
    const { m, id, A, clock, setClock } = team();
    const far = ev(id, m, "msg.post", { text: "tomorrow+" }, { channel: "general", ts: clock() + FUTURE_HOLD_MS + 60_000 });
    expect(A.ingest(far, "remote")).toEqual({ status: "pending", reason: "future_ts" });
    expect(statusOf(A, far.id)).toBe("pending");
    A.drainPending();
    expect(statusOf(A, far.id)).toBe("pending"); // still in the future
    setClock(far.ts - FUTURE_HOLD_MS + 1_000);
    A.drainPending();
    expect(statusOf(A, far.id)).toBe("ok");
  });

  test("the floor moves with the chain's entries, clamped to clock + 5 min; the old test's claim is inverted", () => {
    const a = tnode("alex"), m = tnode("mia");
    const { team: id, create } = createTeam(a);
    const core = makeCore(tnode("obs"), id, cleanups, { clock: () => now() });
    const soon = now() + 2 * 60_000;
    const far = now() + 60 * 60_000; // an hour ahead: within the hold band, past the clamp
    feed(core, [create, memberEv(id, a, m, "member"), nodeEv(id, a, m),
      ev(id, a, "channel.upsert", { name: "general" }, { ts: soon })]);
    expect(core.planNow()).toBe(soon);
    feed(core, [ev(id, m, "msg.post", { text: "from the future" }, { channel: "general", ts: now() + 40 * DAY_MS })]);
    expect(core.planNow()).toBe(soon); // a member's event: nothing
    feed(core, [ev(id, a, "channel.upsert", { name: "later" }, { ts: far })]);
    expect(core.planNow()).toBe(now() + FUTURE_SKEW_MS); // the chain: clamped
    expect(Number(core.store.getMeta(PLAN_FLOOR_META))).toBe(now() + FUTURE_SKEW_MS);
  });

  test("startup rebuilds the floor from the chain only: stored member rows and the retired meta key are ignored", () => {
    const a = tnode("alex"), m = tnode("mia"), obs = tnode("obs");
    const { team: id, create } = createTeam(a);
    const core = makeCore(obs, id, cleanups, { clock: () => now() });
    feed(core, [create, memberEv(id, a, m, "member"), nodeEv(id, a, m), ev(id, a, "channel.upsert", { name: "general" }),
      ev(id, m, "msg.post", { text: "soon" }, { channel: "general", ts: now() + 60 * 60_000 })]);
    core.store.setMeta("max_seen_time", String(now() + YEARS_10)); // a floor an older build persisted from that row
    const reopened = reopen(core, obs);
    expect(reopened.planNow()).toBeLessThanOrEqual(now() + FUTURE_SKEW_MS);
    expect(reopened.store.getMeta("max_seen_time")).toBeNull();
    // This node's own persisted record (its clock, or the chain's clamped ts) is kept within a day of the clock;
    // further than that it was recorded by a clock since corrected and is reset (FINAL-2 Fable 3).
    reopened.store.setMeta(PLAN_FLOOR_META, String(now() + 20 * 60 * 60_000));
    expect(reopen(reopened, obs).planNow()).toBe(now() + 20 * 60 * 60_000);
    reopened.store.setMeta(PLAN_FLOOR_META, String(now() + 3 * DAY_MS));
    expect(reopen(reopened, obs).planNow()).toBeLessThanOrEqual(now() + FUTURE_SKEW_MS);
  });

  test("property: for well-behaved clocks the hold and the clamp change no verdict and no roster", () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let round = 0; round < 8; round++) {
      const a = tnode("alex"), m = tnode("mia"), o = tnode("obs");
      const { team: id, create } = createTeam(a);
      const base = now();
      const jitter = () => base + Math.floor((rnd() * 2 - 1) * (FUTURE_HOLD_MS - 60 * 60_000)); // within ±23 h
      const events: Event[] = [create, memberEv(id, a, m, "member"), nodeEv(id, a, m), ev(id, a, "channel.upsert", { name: "general" }, { ts: jitter() })];
      for (let i = 0; i < 12; i++) {
        const who = rnd() < 0.5 ? a : m;
        if (rnd() < 0.2) events.push(ev(id, a, "channel.upsert", { name: `c${i}`, members: rnd() < 0.5 ? ["alex"] : undefined }, { ts: jitter() }));
        else events.push(ev(id, who, "msg.post", { text: `t${i}` }, { channel: rnd() < 0.3 ? `c${Math.floor(rnd() * i)}` : "general", ts: jitter() }));
      }
      const order = [...events].sort(() => rnd() - 0.5);
      const strict = makeCore(o, id, cleanups, { clock: () => base });
      const lenient = makeCore(tnode("obs"), id, cleanups, { clock: () => base + 100 * 365 * DAY_MS }); // never holds, never clamps
      feed(strict, order); feed(lenient, order);
      strict.drainPending(); lenient.drainPending();
      for (const e of events) expect([e.kind, statusOf(strict, e.id)]).toEqual([e.kind, statusOf(lenient, e.id)]);
      expect([...strict.roster.channels.keys()].sort()).toEqual([...lenient.roster.channels.keys()].sort());
      expect(strict.chainLength).toBe(lenient.chainLength);
    }
  });

  test("this node's own emits never carry a ts more than 5 min ahead of its clock, even after a clock correction", () => {
    const { A, id, clock, setClock } = team();
    setClock(clock() + YEARS_10);
    const future = A.emit("msg.post", { text: "from 2036" }, { channel: "general" });
    expect(future.ts).toBe(clock());
    setClock(future.ts - YEARS_10 + DAY_MS); // corrected
    const back = A.emit("msg.post", { text: "back in time" }, { channel: "general" });
    expect(back.ts).toBe(clock() + FUTURE_SKEW_MS);
    expect(back.team).toBe(id);
    expect(statusOf(A, back.id)).toBe("ok");
  });
});

// ---- Fable 2 (MEDIUM): a future-clock init can't buy a permanent trial ------------------------------------

describe("Fable 2: a team created with a clock in the future gets no trial once the clock is corrected", () => {
  test("founder inits at +10 y, then corrects the clock: Free, also after a restart; an honest founder keeps the 14-day trial", () => {
    let t = now() + YEARS_10;
    const a = tnode("alex");
    const A = makeCore(a, "", cleanups, { licenseVerifier: vendor.verify, clock: () => t });
    A.store.db.query("DELETE FROM meta WHERE key = 'team'").run();
    const create = A.createTeam("acme", "alex");
    expect(create.ts).toBe(t);
    A.emit("channel.upsert", { name: "general" });
    expect(A.plan()?.status).toBe("trial"); // by its own (wrong) clock
    t = create.ts - YEARS_10 + DAY_MS; // the real time
    expect(A.plan()?.status).toBe("free");
    expect(thrown(() => A.emit("channel.upsert", { name: "secret", members: ["alex"] }))?.code).toBe("plan_limit");
    const again = reopen(A, a);
    expect(again.plan()?.status).toBe("free");
    // An honest founder.
    let h = now();
    const b = tnode("bea");
    const B = makeCore(b, "", cleanups, { licenseVerifier: vendor.verify, clock: () => h });
    B.store.db.query("DELETE FROM meta WHERE key = 'team'").run();
    const c2 = B.createTeam("bravo", "bea");
    h = c2.ts + 13 * DAY_MS;
    expect(B.plan()?.status).toBe("trial");
    h = c2.ts + TRIAL_MS + 1;
    expect(B.plan()?.status).toBe("free");
  });

  test("effective(): the trial needs the team's creation to be at most 5 min ahead of the raw clock", () => {
    const created = now();
    expect(effective(null, created, created + DAY_MS, created + DAY_MS).status).toBe("trial");
    expect(effective(null, created, created + DAY_MS, created - FUTURE_SKEW_MS + 1).status).toBe("trial");
    expect(effective(null, created, created + DAY_MS, created - FUTURE_SKEW_MS - 1).status).toBe("free");
  });
});

// ---- Fable 8 (LOW): UI staleness and ask expiry use clamped timestamps -----------------------------------

describe("Fable 8: peer-supplied ts never drives staleness or ask expiry beyond the clamp", () => {
  test("an agent status stamped an hour ahead counts from its receipt (+5 min at most) and goes stale like any other", () => {
    const { m, id, A, clock } = team({ start: Date.now() }); // the simulated clock at the real one: receipt times are real
    const st = ev(id, m, "agent.status", { agent: "bot", state: "working", runtime: "cli", title: "x" }, { ts: clock() + 60 * 60_000, agent: "bot" });
    expect(A.ingest(st, "remote").status).toBe("accepted");
    const row = A.store.agent(m.keys.nodeId, "bot");
    expect(row?.ts).toBeLessThanOrEqual(Date.now() + FUTURE_SKEW_MS);
    expect(effectiveState("working", row?.ts as number, true, Date.now() + STALE_STATUS_MS + FUTURE_SKEW_MS + 1)).toBe("offline");
    const sync = { peerState: () => undefined, isOnline: () => true } as never;
    expect(agentsView(A, sync)[0]?.updated_at).toBe(row?.ts as number);
  });

  test("an ask whose expiry is 10 years ahead expires after its own timeout counted from receipt (capped at a day)", () => {
    const { m, id, A, clock } = team({ start: Date.now() });
    const ts = clock() + YEARS_10;
    const ask = ev(id, m, "ask", { to: "@alex", text: "?", expires_at: ts + 300_000 }, { channel: "general", ts });
    expect(A.ingest(ask, "remote").status).toBe("pending"); // held: 24 h ahead
    const soon = clock() + 60 * 60_000;
    const ask2 = ev(id, m, "ask", { to: "@alex", text: "?", expires_at: soon + 300_000 }, { channel: "general", ts: soon });
    expect(A.ingest(ask2, "remote").status).toBe("accepted");
    const row = A.store.getRow(ask2.id);
    const view = askView(A, row as never);
    expect(view.expires_at).toBeLessThanOrEqual(Date.now() + FUTURE_SKEW_MS + 300_000);
    expect(view.expires_at).toBeGreaterThan(Date.now());
    const forever = ev(id, m, "ask", { to: "@alex", text: "?", expires_at: clock() + 30 * DAY_MS }, { channel: "general", ts: clock() });
    expect(A.ingest(forever, "remote").status).toBe("accepted");
    expect(askView(A, A.store.getRow(forever.id) as never).expires_at).toBeLessThanOrEqual(Date.now() + FUTURE_SKEW_MS + DAY_MS);
  });
});

// ---- Codex 2 (HIGH): in-memory chain state is rolled back with the transaction ----------------------------

describe("Codex 2: the chain cursor and every in-memory effect follow the transaction", () => {
  test("a failed integration post on the authority, then a roster event: the roster event applies and is stored ok", () => {
    const { A, id } = team();
    const seqBefore = A.store.allocatedSelfSeq(A.nodeId);
    expect(() => A.store.transaction(() => {
      A.emit("msg.post", { text: "ledger" }, { channel: "general" });
      throw new Error("ledger write failed");
    })).toThrow("ledger write failed");
    expect(A.store.allocatedSelfSeq(A.nodeId)).toBe(seqBefore);
    const b = tnode("bea");
    const invite = A.emit("team.member", { login: b.login, handle: b.handle, role: "member" });
    expect(invite.seq).toBe(seqBefore + 1);
    expect(A.store.getRow(invite.id)?.status).toBe("ok");
    expect(A.roster.members.get(b.login)?.role).toBe("member");
    expect(A.teamId).toBe(id);
    // A replica fed the authority's rows agrees.
    const R = makeCore(tnode("r"), id, cleanups, { licenseVerifier: vendor.verify });
    feed(R, A.store.rosterRows(A.nodeId, 0, 1_000));
    expect(R.roster.members.get(b.login)?.role).toBe("member");
  });

  test("a rolled-back roster emit leaves the chain, the roster and the plan floor as they were", () => {
    const { A, clock } = team();
    const before = { len: A.chainLength, roster: A.roster, floor: A.planNow() };
    expect(() => A.store.transaction(() => {
      A.emit("channel.upsert", { name: "doomed" }, {});
      expect(A.roster.channels.has("doomed")).toBe(true);
      throw new Error("boom");
    })).toThrow("boom");
    expect(A.chainLength).toBe(before.len);
    expect(A.roster.channels.has("doomed")).toBe(false);
    expect(A.roster).toBe(before.roster);
    expect(A.planNow()).toBe(Math.max(before.floor, clock()));
    const ok = A.emit("channel.upsert", { name: "kept" });
    expect(A.store.getRow(ok.id)?.status).toBe("ok");
    expect(A.roster.channels.has("kept")).toBe(true);
  });
});

// ---- Codex 3 (HIGH): durable commits ----------------------------------------------------------------------

describe("Codex 3: a transaction that writes this node's own event commits with synchronous=FULL", () => {
  test("a local emit and a ledger transaction run FULL; a peer's event and a verdict update stay NORMAL", () => {
    const { m, id, A, clock } = team();
    const seen: string[] = [];
    const db = A.store.db as unknown as { exec: (sql: string) => unknown };
    const orig = db.exec.bind(A.store.db);
    db.exec = (sql: string) => { if (sql.startsWith("PRAGMA synchronous")) seen.push(sql); return orig(sql); };
    expect(A.store.synchronous).toBe("NORMAL");
    A.emit("msg.post", { text: "mine" }, { channel: "general" });
    expect(seen).toEqual(["PRAGMA synchronous = FULL", "PRAGMA synchronous = NORMAL"]);
    seen.length = 0;
    A.ingest(ev(id, m, "msg.post", { text: "theirs" }, { channel: "general", ts: clock() }), "remote");
    expect(seen).toEqual([]);
    A.store.transaction(() => { A.emit("msg.post", { text: "a" }, { channel: "general" }); A.emit("msg.post", { text: "b" }, { channel: "general" }); }, { durable: true });
    expect(seen).toEqual(["PRAGMA synchronous = FULL", "PRAGMA synchronous = NORMAL"]); // once, around the outermost transaction
    expect(A.store.synchronous).toBe("NORMAL");
    expect((A.store.db.query<{ synchronous: number }, []>("PRAGMA synchronous").get())?.synchronous).toBe(1);
  });
});

// ---- Fable 6 (LOW): the ACL check runs on the file that was opened -----------------------------------------

describe("Fable 6: a symlinked key file is checked at its real path", () => {
  test.if(process.platform === "darwin")("a symlink to a file whose ACL grants others access is refused (the check follows the link)", () => {
    const dir = mkdtempSync("/tmp/walkie-acl-link-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const real = join(dir, "real.txt"), link = join(dir, "link.txt");
    writeFileSync(real, "acl_key_0123456789abcdef\n", { mode: 0o600 });
    symlinkSync(real, link);
    expect(readKeyFile(link)).toBe("acl_key_0123456789abcdef"); // a clean target through a link is fine
    expect(Bun.spawnSync(["chmod", "+a", "everyone allow read", real]).exitCode).toBe(0);
    expect(() => readKeyFile(link)).toThrow(/ACL/);
    expect(() => readKeyFile(link)).toThrow(/chmod -N \S*\/real\.txt/); // the fix names the real file (its canonical path), not the link
    expect(Bun.spawnSync(["chmod", "-N", real]).exitCode).toBe(0);
    expect(readKeyFile(link)).toBe("acl_key_0123456789abcdef");
  });
});

// ---- Codex 7 (LOW): the loopback license-service override is compiled out of release binaries -----------

describe("Codex 7: WALKIE_LICENSE_URL is honoured only in source runs", () => {
  test("a release build (WALKIE_EMBEDDED=true) pins the site origin whatever the environment says; a source run honours a loopback URL with WALKIE_DEV=1", () => {
    const env = { WALKIE_DEV: "1", WALKIE_LICENSE_URL: "http://127.0.0.1:4040/x" };
    expect(serviceBaseFromEnv(env, false)).toBe("http://127.0.0.1:4040");
    expect(serviceBaseFromEnv(env, true)).toBe(SITE_ORIGIN);
    expect(serviceBaseFromEnv({ WALKIE_LICENSE_URL: "http://127.0.0.1:4040" }, false)).toBe(SITE_ORIGIN); // no WALKIE_DEV
    expect(serviceBaseFromEnv({ WALKIE_DEV: "1", WALKIE_LICENSE_URL: "https://evil.example" }, false)).toBe(SITE_ORIGIN); // not loopback
    expect(RELEASE_BUILD).toBe(false); // this test runs from source
  });
});

export {};
void Core;
