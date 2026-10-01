import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "./store.ts";
import { applyHermesStatus, hermesProfileLive, hermesProfileStatus, noteHermesCensus, offlineExitedHermesSessions, pruneHermesSessions, purgeEndedHermesSessions, HERMES_PROFILE_CAP, HERMES_TOTAL_CAP } from "./hermes-status.ts";
import { hermesObservation } from "../hooks/hermes.ts";
import { removeLegacyHermesFiles } from "./hermes-legacy.ts";
import { dispatch, type RouteCtx } from "./local-routes.ts";
import { HttpError } from "./http.ts";
import { HERMES_HOOK_LIMIT, RateLimiter } from "./ratelimit.ts";
const key = (session: string) => createHash("sha256").update(session).digest("hex");

test("21 out-of-order Hermes events keep the newest state", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-order-"));
  const store = new Store(join(root, "test.db"));
  try {
    const events = Array.from({ length: 21 }, (_, sequence) => ({
      profile: "default", session: key("session-a"), at: 1_000, sequence,
      state: sequence === 20 ? "idle" as const : "working" as const,
      fallback: "idle" as const,
    }));
    for (const event of [...events].reverse()) applyHermesStatus(store, event, 1_000);
    expect(applyHermesStatus(store, events[0]!, 1_000).body.state).toBe("idle");
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("overlapping Hermes sessions stay isolated", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-overlap-"));
  const store = new Store(join(root, "test.db"));
  try {
    const send = (session: string, sequence: number, state: "working" | "idle" | "offline", fallback = state) =>
      applyHermesStatus(store, { profile: "default", session: key(session), at: 1_000 + sequence,
        sequence: 0, state, fallback }, 1_000 + sequence).body.state;
    expect(send("a", 0, "working")).toBe("working");
    expect(send("b", 1, "working")).toBe("working");
    expect(send("a", 2, "offline", "idle")).toBe("working");
    expect(send("b", 3, "idle")).toBe("idle");
    expect(send("b", 4, "offline")).toBe("offline");
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Hermes census retires only an exited pid when another session shares its profile", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-pid-"));
  const store = new Store(join(root, "test.db"));
  try {
    const at = 10_000;
    for (const [name, pid] of [["exited", 201], ["live", 202]] as const) {
      applyHermesStatus(store, { profile: "default", session: key(name), pid, at, sequence: 0,
        state: "working", fallback: "idle" }, at);
    }
    expect(offlineExitedHermesSessions(store, [{ pid: 202, profile: "default", startedAt: 1 }], at + 1)).toEqual([]);
    expect(store.db.query<{ session: string; state: string }, []>("SELECT session, state FROM hermes_sessions ORDER BY session").all())
      .toEqual([{ session: key("exited"), state: "offline" }, { session: key("live"), state: "working" }]
        .sort((a, b) => a.session.localeCompare(b.session)));
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an unresolved Hermes process shields a pid-less row only until the ten-minute TTL since its last hook", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-unnamed-"));
  const store = new Store(join(root, "test.db"));
  try {
    applyHermesStatus(store, { profile: "billing", session: key("quiet"), at: 10_000, sequence: 0,
      state: "working", fallback: "idle" }, 10_000);
    const unresolved = [{ pid: 202, profile: null, startedAt: 1 }];
    expect(offlineExitedHermesSessions(store, unresolved, 10_001)).toEqual([]);
    expect(offlineExitedHermesSessions(store, unresolved, 10_000 + 10 * 60_000 - 1)).toEqual([]);
    expect(offlineExitedHermesSessions(store, unresolved, 10_000 + 10 * 60_000)).toEqual(["billing"]);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a named Hermes process never shields another profile's row, and no process retires every pid-less row", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-named-"));
  const store = new Store(join(root, "test.db"));
  try {
    for (const profile of ["a", "b"]) applyHermesStatus(store, { profile, session: key(profile), at: 10_000, sequence: 0,
      state: "working", fallback: "idle" }, 10_000);
    const stateOf = (profile: string) => store.db.query<{ state: string }, [string]>(
      "SELECT state FROM hermes_sessions WHERE profile = ?").get(profile)?.state;
    expect(offlineExitedHermesSessions(store, [{ pid: 1, profile: "a", startedAt: 1 }], 10_001)).toEqual(["b"]);
    expect([stateOf("a"), stateOf("b")]).toEqual(["working", "offline"]);
    expect(offlineExitedHermesSessions(store, [], 10_002)).toEqual(["a"]);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an unresolved process shields only rows without a named match, and a named one keeps its own profile live", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-mixed-"));
  const store = new Store(join(root, "test.db"));
  try {
    for (const profile of ["a", "b"]) applyHermesStatus(store, { profile, session: key(profile), at: 10_000, sequence: 0,
      state: "working", fallback: "idle" }, 10_000);
    const census = [{ pid: 1, profile: "a", startedAt: 1 }, { pid: 2, profile: null, startedAt: 1 }];
    expect(offlineExitedHermesSessions(store, census, 10_000 + 60_000)).toEqual([]);
    expect(offlineExitedHermesSessions(store, census, 10_000 + 10 * 60_000).sort()).toEqual(["a", "b"]);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("profile fallback expires a quiet session without a process id", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-fallback-"));
  const store = new Store(join(root, "test.db"));
  try {
    applyHermesStatus(store, { profile: "default", session: key("quiet"), at: 10_000, sequence: 0,
      state: "working", fallback: "idle" }, 10_000);
    const process = [{ pid: 202, profile: "default", startedAt: 1 }];
    expect(offlineExitedHermesSessions(store, process, 10_001)).toEqual([]);
    expect(offlineExitedHermesSessions(store, process, 10_000 + 10 * 60_000)).toEqual(["default"]);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a profile stays live by the census rule the sweep applies, or by a hook received after the census", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-live-"));
  const store = new Store(join(root, "test.db"));
  try {
    const TTL = 10 * 60_000;
    applyHermesStatus(store, { profile: "a", session: key("a"), at: 10_000, sequence: 0, state: "working", fallback: "idle" }, 10_000);
    applyHermesStatus(store, { profile: "idle", session: key("idle"), at: 10_000, sequence: 0, state: "idle", fallback: "idle" }, 10_000);
    applyHermesStatus(store, { profile: "p", session: key("p"), pid: 7, at: 10_000, sequence: 0, state: "working", fallback: "idle" }, 10_000);
    const live = (profile: string, processes: Parameters<typeof hermesProfileLive>[2], capturedAt: number) =>
      hermesProfileLive(store, profile, processes, capturedAt);
    expect(live("a", [], 10_001)).toBe(false);
    expect(live("a", [{ pid: 1, profile: "a" }], 10_001)).toBe(true);
    expect(live("a", [{ pid: 1, profile: "b" }], 10_001)).toBe(false);
    expect(live("a", [{ pid: 1, profile: null }], 10_001)).toBe(true);
    expect(live("a", [{ pid: 1, profile: null }], 10_000 + TTL)).toBe(false);
    expect(live("a", [], 9_999)).toBe(true); // received after the census was captured
    expect(live("idle", [{ pid: 1, profile: null }], 10_001)).toBe(false); // only a working row is a live session
    expect(live("p", [{ pid: 7, profile: "p", startedAt: 1 }], 10_000 + TTL)).toBe(true); // a hook-supplied pid has no TTL
    expect(live("p", [{ pid: 8, profile: "p", startedAt: 1 }], 10_001)).toBe(false);
    expect(live("nobody", [{ pid: 1, profile: null }], 10_001)).toBe(false);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("after the census retires a working session, the profile card is what a hook would compute from the rows that remain", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-card-"));
  const store = new Store(join(root, "test.db"));
  try {
    const send = (name: string, at: number, state: "working" | "idle") =>
      applyHermesStatus(store, { profile: "default", session: key(name), at, sequence: 0, state, fallback: "idle" }, at);
    send("exits", 10_000, "working");
    expect(send("sibling", 10_001, "idle").body.state).toBe("working"); // the working session still decides the card
    expect(offlineExitedHermesSessions(store, [], 10_002)).toEqual(["default"]);
    const card = hermesProfileStatus(store, "default");
    expect(card.body).toEqual({ agent: "hermes-default", state: "idle", runtime: "other", runtime_name: "hermes" });
    const next = send("sibling", 10_003, "idle"); // the very card the next hook of the sibling computes
    expect(card).toEqual({ body: next.body, provenance: next.provenance });
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a retired session's last activity does not show on the idle card of its profile", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-card-activity-"));
  const store = new Store(join(root, "test.db"));
  try {
    applyHermesStatus(store, { profile: "default", session: key("sibling"), at: 10_000, sequence: 0, state: "idle",
      fallback: "idle", activity: "Finished turn", source: "phrase" }, 10_000);
    applyHermesStatus(store, { profile: "default", session: key("exits"), at: 10_001, sequence: 0, state: "working",
      fallback: "working", activity: "Using terminal", source: "tool" }, 10_001);
    expect(offlineExitedHermesSessions(store, [], 10_002)).toEqual(["default"]);
    expect(JSON.stringify(hermesProfileStatus(store, "default"))).not.toContain("Using terminal");
    expect(hermesProfileStatus(store, "default").body.state).toBe("idle");
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("with no live row left the profile card is offline, a working row keeps it working, and activity follows the working row", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-card-none-"));
  const store = new Store(join(root, "test.db"));
  try {
    expect(hermesProfileStatus(store, "default").body.state).toBe("offline");
    applyHermesStatus(store, { profile: "default", session: key("a"), at: 10_000, sequence: 0, state: "working",
      fallback: "working", activity: "Using terminal", source: "tool" }, 10_000);
    expect(hermesProfileStatus(store, "default")).toEqual({
      body: { agent: "hermes-default", state: "working", runtime: "other", runtime_name: "hermes", activity: "Using terminal" },
      provenance: { activity: "tool" },
    });
    expect(offlineExitedHermesSessions(store, [], 10_001)).toEqual(["default"]);
    expect(hermesProfileStatus(store, "default")).toEqual({
      body: { agent: "hermes-default", state: "offline", runtime: "other", runtime_name: "hermes" }, provenance: {},
    });
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("while a census runs, a hook deletes no row by age, its own profile's or another's: the census sweep ends them (hermes-expiry.test.ts: where none runs)", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-ttl-"));
  const store = new Store(join(root, "test.db"));
  try {
    const TTL = 10 * 60_000;
    const hook = (profile: string, name: string, at: number, state: "working" | "idle" | "offline") =>
      applyHermesStatus(store, { profile, session: key(name), at, sequence: 0, state, fallback: state === "working" ? "working" : "idle" }, at);
    const survivors = () => store.db.query<{ session: string }, []>("SELECT session FROM hermes_sessions ORDER BY session").all()
      .map((r) => r.session).sort();
    hook("a", "working", 10_000, "working");
    hook("a", "ended", 10_000, "offline");
    hook("a", "idle", 10_000, "idle");
    hook("b", "other", 10_000, "offline");
    const seeded = [key("working"), key("ended"), key("idle"), key("other")];
    for (const age of [TTL - 1, TTL + 1, 2 * TTL + 1, 10 * TTL]) {
      noteHermesCensus(store, 10_000 + age - 15_000); // the census last scanned 15 s ago
      // another profile's hook, and a hook of the rows' own profile: neither deletes any of them, nor hands back a card
      expect(hook("c", "trigger", 10_000 + age, "idle").recomputed).toEqual([]);
      expect(hook("a", "own-trigger", 10_000 + age, "idle").recomputed).toEqual([]);
      expect(survivors()).toEqual([...seeded, key("trigger"), key("own-trigger")].sort());
    }
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

// Hermes fires `on_session_end` after every turn: a live session at its prompt is a state=offline / fallback=idle row.
const AT_PROMPT = { state: "offline", fallback: "idle", activity: "Finished turn", source: "phrase" } as const;

test("another profile hooking every 5 s for 30 minutes leaves an idle session's row and card as they were", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-idle-"));
  const store = new Store(join(root, "test.db"));
  try {
    const first = applyHermesStatus(store, { profile: "old", session: key("prompt"), at: 10_000, sequence: 5, ...AT_PROMPT }, 10_000);
    expect(first.body.state).toBe("idle");
    const idleCard = hermesProfileStatus(store, "old");
    let hooks = 0;
    for (let at = 15_000; at <= 10_000 + 30 * 60_000; at += 5_000, hooks++) {
      const update = applyHermesStatus(store, { profile: "work", session: key("busy"), at, sequence: hooks, state: "working", fallback: "working" }, at);
      expect(update.recomputed).toEqual([]); // the hook deleted no other profile's row, so no other profile's card is its business
    }
    expect(hooks).toBe(360);
    expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM hermes_sessions WHERE profile = ?").get("old")?.n).toBe(1);
    expect(hermesProfileStatus(store, "old")).toEqual(idleCard);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("rows deleted by the total cap also hand back their profile's card", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-cap-recompute-"));
  const store = new Store(join(root, "test.db"));
  try {
    const insert = store.db.query("INSERT INTO hermes_sessions(profile, session, at, seq, state, fallback) VALUES (?, ?, ?, 0, 'idle', 'idle')");
    insert.run("lone", key("lone"), 1);
    for (let p = 0; p < 16; p++) for (let n = 0; n < 32; n++) insert.run(`full-${p}`, key(`${p}-${n}`), 1_000 + p * 100 + n);
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM hermes_sessions").get()?.n).toBe(HERMES_TOTAL_CAP + 1);
    const update = applyHermesStatus(store, { profile: "new", session: key("new"), at: 5_000, sequence: 0, state: "idle", fallback: "idle" }, 5_000);
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM hermes_sessions").get()?.n).toBe(HERMES_TOTAL_CAP);
    expect(update.recomputed.find((card) => card.body.agent === "hermes-lone")?.body.state).toBe("offline"); // its only row went
    expect(update.recomputed.some((card) => card.body.agent === "hermes-new")).toBe(false);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the route posts the card of a profile whose row the total cap evicted, then the hook's own", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-route-recompute-"));
  const store = new Store(join(root, "test.db"));
  const posted: Array<[string, string]> = [];
  try {
    const now = Date.now();
    const insert = store.db.query("INSERT INTO hermes_sessions(profile, session, at, seq, state, fallback) VALUES (?, ?, ?, 0, 'idle', 'idle')");
    insert.run("lone", key("lone"), now - 60_000); // the oldest row of all: the one the cap evicts
    for (let p = 0; p < 15; p++) for (let n = 0; n < 32; n++) insert.run(`full-${p}`, key(`${p}-${n}`), now - 50_000 + p * 100 + n);
    for (let n = 0; n < 31; n++) insert.run("part", key(`part-${n}`), now - 40_000 + n); // 1 + 480 + 31 = 512 rows: the hook's own makes 513
    const core = { teamId: "fixture", me: () => ({ role: "member" }), store, config: { redact: false }, limiter: { take: () => true },
      hermesActivityProfiles: () => [],
      statuses: { submit: (agent: string, body: { state: string }) => { posted.push([agent, body.state]); return null; } } };
    const url = new URL("http://walkie/v1/hermes/status");
    const req = new Request(url, { method: "POST", body: JSON.stringify({ profile: "work", session: key("w"), at: now, sequence: 0, state: "working", fallback: "working" }) });
    const response = await dispatch({ core, req, url, agent: "hermes-work" } as unknown as RouteCtx);
    expect(response.status).toBe(202);
    expect(posted).toEqual([["hermes-lone", "offline"], ["hermes-work", "working"]]);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a sibling at its prompt keeps the card idle when the other session's row is retired", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-prompt-"));
  const store = new Store(join(root, "test.db"));
  try {
    applyHermesStatus(store, { profile: "default", session: key("A"), at: 10_000, sequence: 5, ...AT_PROMPT }, 10_000);
    applyHermesStatus(store, { profile: "default", session: key("B"), at: 10_500, sequence: 1, state: "working", fallback: "working",
      activity: "Thinking", source: "phrase" }, 10_500);
    expect(offlineExitedHermesSessions(store, [], 10_500 + 20 * 60_000)).toEqual(["default"]);
    const card = hermesProfileStatus(store, "default");
    // The idle card carries the line of the newest row that did not end by retirement (A's), never the retired row's.
    expect(card).toEqual({ body: { agent: "hermes-default", state: "idle", runtime: "other", runtime_name: "hermes", activity: "Finished turn" },
      provenance: { activity: "phrase" } });
    // The next hook that changes nothing (a duplicate of A's old event) computes the very same card.
    const duplicate = applyHermesStatus(store, { profile: "default", session: key("A"), at: 10_000, sequence: 5, ...AT_PROMPT }, 10_500 + 21 * 60_000);
    expect({ body: duplicate.body, provenance: duplicate.provenance }).toEqual(card);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a stale hook after the census retired a working row does not flip the card back to working", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-stale-"));
  const store = new Store(join(root, "test.db"));
  try {
    applyHermesStatus(store, { profile: "default", session: key("A"), at: 10_000, sequence: 5, ...AT_PROMPT }, 10_000);
    applyHermesStatus(store, { profile: "default", session: key("B"), at: 10_500, sequence: 1, state: "working", fallback: "working",
      activity: "Using terminal", source: "tool" }, 10_500);
    expect(offlineExitedHermesSessions(store, [], 10_500 + 20_000)).toEqual(["default"]);
    expect(hermesProfileStatus(store, "default").body.state).not.toBe("working");
    // A late, older event of A: it changes no row (the newer end-of-turn row wins), and its card is computed from the rows.
    const stale = applyHermesStatus(store, { profile: "default", session: key("A"), at: 9_000, sequence: 1, state: "working", fallback: "working" }, 10_500 + 21_000);
    expect(stale.body.state).not.toBe("working");
    expect(stale.body).toEqual(hermesProfileStatus(store, "default").body);
    // The retired row itself is offline with an offline fallback and no activity text.
    expect(store.db.query<{ state: string; fallback: string; activity: string | null }, [string]>(
      "SELECT state, fallback, activity FROM hermes_sessions WHERE session = ?").get(key("B"))).toEqual({ state: "offline", fallback: "offline", activity: null });
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a retired row decides nothing: an ending a hook reported does, and a session's own later hook revives it", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-retired-"));
  const store = new Store(join(root, "test.db"));
  try {
    const cardState = () => hermesProfileStatus(store, "default").body.state;
    const send = (name: string, at: number, state: "working" | "offline", fallback: "working" | "idle" | "offline") =>
      applyHermesStatus(store, { profile: "default", session: key(name), at, sequence: 0, state, fallback }, at);
    send("B", 10_000, "working", "working");
    expect(offlineExitedHermesSessions(store, [], 10_001)).toEqual(["default"]);
    expect(cardState()).toBe("offline"); // only a retired row: nothing ended on its own
    send("A", 9_000, "offline", "idle"); // a turn ended, older than the retired row
    expect(cardState()).toBe("idle"); // the retired row, though newer, says nothing
    send("C", 11_000, "offline", "offline"); // a hook reported a session's end for good, newer: that does decide
    expect(cardState()).toBe("offline");
    send("B", 12_000, "working", "working"); // the retired session hooks again: it is back
    expect(cardState()).toBe("working");
    expect(offlineExitedHermesSessions(store, [], 12_001)).toEqual(["default"]);
    expect(cardState()).toBe("offline"); // C's end is the newest ended row of its own; B is retired again
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

// A seeded walk through the hook events the installed Hermes sends, from three sessions of one profile, with the census
// retiring every working row now and then: the sweep's card (hermesProfileStatus) is, after every step, the card that a
// hook that changes no row (a duplicate of a session's last event) computes, and it is working only while a row works.
test("the sweep's card is the card of a hook that changes no row, after every step of a seeded walk", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-walk-"));
  const store = new Store(join(root, "test.db"));
  try {
    let state = 0x2f6e2b1; // mulberry32
    const next = () => { state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T;
    const events = ["on_session_start", "pre_llm_call", "pre_tool_call", "post_tool_call", "post_llm_call", "on_session_end", "on_session_finalize"];
    const last = new Map<string, NonNullable<ReturnType<typeof hermesObservation>>>();
    let now = 1_000_000;
    let sequence = 0;
    const seen = new Set<string>();
    for (let step = 0; step < 400; step++) {
      now += Math.floor(next() * 2_000); // 400 steps stay well inside the TTL: expiry has its own tests
      const roll = next();
      if (roll < 0.15) offlineExitedHermesSessions(store, [], now + 1);
      else {
        const session = pick(["A", "B", "C"]);
        const observation = hermesObservation(JSON.stringify({ session_id: session, profile: "default", hook_event_name: pick(events),
          tool_name: "terminal", cwd: "/x", timestamp: now, event_sequence: ++sequence }), ["default"], { prompts: false, activity: true });
        if (!observation) throw new Error("no observation");
        applyHermesStatus(store, observation, now);
        last.set(session, observation);
      }
      const card = hermesProfileStatus(store, "default");
      seen.add(card.body.state);
      const working = store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM hermes_sessions WHERE state = 'working'").get()?.n ?? 0;
      expect([step, card.body.state === "working"]).toEqual([step, working > 0]);
      const duplicate = last.size ? applyHermesStatus(store, pick([...last.values()]), now) : null;
      if (duplicate) expect([step, { body: duplicate.body, provenance: duplicate.provenance }]).toEqual([step, card]);
    }
    expect([...seen].sort()).toEqual(["idle", "offline", "working"]); // the walk really visits every card state
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("first daemon open removes abandoned client lock, recovery, ledger, and pending files", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-legacy-"));
  const names = ["hermes-sessions.lock", "hermes-sessions.lock.recovery", "hermes-pending",
    "hermes-sessions.lock.stale-00000000-0000-4000-8000-000000000001"];
  try {
    for (const name of names) mkdirSync(join(root, name));
    writeFileSync(join(root, "hermes-sessions.json"), "{}");
    const store = new Store(join(root, "test.db"));
    removeLegacyHermesFiles(root);
    store.db.close();
    for (const name of [...names, "hermes-sessions.json"]) expect(existsSync(join(root, name))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Hermes route accepts every burst observation before status publication throttling", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-route-"));
  const store = new Store(join(root, "test.db"));
  const states: string[] = [];
  try {
    const now = Date.now();
    const core = { teamId: "fixture", me: () => ({ role: "member" }), store, hermesActivityProfiles: () => [],
      statuses: { submit: (_agent: string, body: { state: string }) => { states.push(body.state); return null; } },
      config: { redact: false }, limiter: { take: () => true } };
    for (const sequence of [2, 1, 0]) {
      const url = new URL("http://walkie/v1/hermes/status");
      const req = new Request(url, { method: "POST", body: JSON.stringify({ profile: "default", session: key("a"),
        at: now, sequence, state: sequence === 2 ? "idle" : "working", fallback: "idle" }) });
      const response = await dispatch({ core, req, url, agent: "hermes-default" } as unknown as RouteCtx);
      expect(response.status).toBe(202);
    }
    expect(states).toEqual(["idle", "idle", "idle"]);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Hermes row caps evict oldest ended sessions before working sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-cap-"));
  const store = new Store(join(root, "test.db"));
  try {
    const insert = store.db.query("INSERT INTO hermes_sessions(profile, session, at, seq, state, fallback) VALUES (?, ?, ?, 0, ?, 'idle')");
    insert.run("a", key("working"), 1, "working");
    insert.run("a", key("old-idle"), 2, "idle");
    insert.run("a", key("new-idle"), 3, "idle");
    insert.run("b", key("other"), 4, "idle");
    pruneHermesSessions(store, "a", 2, 3);
    expect(store.db.query<{ session: string }, []>("SELECT session FROM hermes_sessions WHERE profile = 'a' ORDER BY at").all()
      .map((row) => row.session)).toEqual([key("working"), key("new-idle")]);
    expect(store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM hermes_sessions").get()?.count).toBe(3);
    insert.run("c", key("third-profile"), 5, "idle");
    pruneHermesSessions(store, "c", 2, 3);
    expect(store.db.query<{ session: string }, []>("SELECT session FROM hermes_sessions ORDER BY at").all()
      .map((row) => row.session)).toEqual([key("working"), key("other"), key("third-profile")]);
    expect(HERMES_PROFILE_CAP).toBeLessThan(HERMES_TOTAL_CAP);
    expect(HERMES_TOTAL_CAP).toBeLessThan(10_000);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a virtual 10,000-session faulty hook is reduced to the caps with bounded SQL operations", () => {
  const simulated = (profileRows: number, totalRows: number) => {
    const calls: string[] = [];
    const fake = { db: { query: (sql: string) => {
      calls.push(sql);
      return {
        get: () => ({ n: sql.includes("WHERE profile = ?") ? profileRows : totalRows }),
        run: (...args: unknown[]) => {
          const removed = args.at(-1) as number;
          if (sql.includes("WHERE profile = ?")) profileRows -= removed;
          totalRows -= removed;
        },
      };
    } } } as unknown as Store;
    pruneHermesSessions(fake, "faulty");
    expect(profileRows).toBeLessThanOrEqual(HERMES_PROFILE_CAP);
    expect(totalRows).toBeLessThanOrEqual(HERMES_TOTAL_CAP);
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.filter((sql) => sql.startsWith("DELETE"))).toEqual([
      expect.stringContaining("LIMIT ?"),
    ]);
  };
  simulated(10_000, 10_000);
  simulated(1, 10_000);
  const limiter = new RateLimiter();
  expect(HERMES_HOOK_LIMIT.capacity).toBeGreaterThanOrEqual(21);
  expect(limiter.take("faulty", HERMES_HOOK_LIMIT, 1_000, HERMES_HOOK_LIMIT.capacity)).toBe(true);
  expect(limiter.take("faulty", HERMES_HOOK_LIMIT, 1_000)).toBe(false);
});

test("production Hermes profile cap holds after distinct observations", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-production-cap-"));
  const store = new Store(join(root, "test.db"));
  try {
    for (let n = 0; n <= HERMES_PROFILE_CAP; n++) applyHermesStatus(store, {
      profile: "faulty", session: key(`distinct-${n}`), at: 1_000 + n, sequence: 0,
      state: "idle", fallback: "idle",
    }, 1_000 + n);
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM hermes_sessions WHERE profile = 'faulty'").get()?.n)
      .toBe(HERMES_PROFILE_CAP);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Hermes profile projection uses indexed bounded reads", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-plan-"));
  const store = new Store(join(root, "test.db"));
  try {
    for (const sql of [
      "SELECT at, seq, state, fallback, activity, source FROM hermes_sessions WHERE profile = ? AND state = 'working' ORDER BY at DESC, seq DESC LIMIT 1",
      "SELECT at, seq, state, fallback, activity, source FROM hermes_sessions WHERE profile = ? AND state != 'offline' ORDER BY at DESC, seq DESC LIMIT 1",
      "SELECT at, seq, state, fallback, activity, source FROM hermes_sessions WHERE profile = ? AND source IS NOT 'retired' ORDER BY at DESC, seq DESC LIMIT 1",
    ]) {
      const plan = store.db.query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${sql}`).all("default");
      expect(plan.some((row) => row.detail.includes("hermes_sessions_profile_at"))).toBe(true);
      expect(sql).toContain("LIMIT 1");
    }
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Hermes route rejects a new session when its admission bucket is exhausted", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-limit-"));
  const store = new Store(join(root, "test.db"));
  try {
    const now = Date.now();
    const url = new URL("http://walkie/v1/hermes/status");
    const req = new Request(url, { method: "POST", body: JSON.stringify({ profile: "default", session: key("new"),
      at: now, sequence: 0, state: "working", fallback: "idle" }) });
    const core = { teamId: "fixture", me: () => ({ role: "member" }), store,
      limiter: { take: () => false }, config: { redact: false } };
    await expect(dispatch({ core, req, url, agent: "hermes-default" } as unknown as RouteCtx)).rejects
      .toMatchObject({ status: 429, code: "rate_limited" } satisfies Partial<HttpError>);
    expect(store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM hermes_sessions").get()?.count).toBe(0);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Hermes route accepts a known session end after admission quota is exhausted", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-end-"));
  const store = new Store(join(root, "test.db"));
  try {
    const now = Date.now();
    const session = key("known");
    applyHermesStatus(store, { profile: "default", session, at: now, sequence: 0,
      state: "working", fallback: "idle" }, now);
    const limiter = new RateLimiter();
    expect(limiter.take("hermes-hook:default", HERMES_HOOK_LIMIT, now, HERMES_HOOK_LIMIT.capacity)).toBe(true);
    const url = new URL("http://walkie/v1/hermes/status");
    const req = new Request(url, { method: "POST", body: JSON.stringify({ profile: "default", session,
      at: now + 1, sequence: 1, state: "offline", fallback: "idle" }) });
    const core = { teamId: "fixture", me: () => ({ role: "member" }), store, limiter, hermesActivityProfiles: () => [],
      statuses: { submit: () => null }, config: { redact: false } };
    const response = await dispatch({ core, req, url, agent: "hermes-default" } as unknown as RouteCtx);
    expect(response.status).toBe(202);
    expect(store.db.query<{ state: string }, [string]>("SELECT state FROM hermes_sessions WHERE session = ?").get(session)?.state)
      .toBe("offline");
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

// ---- the census sweep purges ended rows, knowing which processes could own them (round 10, finding 2) -----------------------
// A session at its prompt hooks no more, so a row ending a turn (state offline / fallback idle, or state idle) is kept for as long as
// a live process could own it. It goes once its ten minutes (counted from the hook's receipt) have passed and none could.
const TTL = 10 * 60_000;

/** A store with the rows given, each received at `received` (the hook's own time defaults to it), and what the sweep leaves of them. */
function endedRows(rows: ReadonlyArray<{ profile: string; name: string; state: "working" | "idle" | "offline"; fallback: "working" | "idle" | "offline"; pid?: number; at?: number }>, received = 10_000) {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-purge-"));
  const store = new Store(join(root, "test.db"));
  for (const row of rows) {
    applyHermesStatus(store, { profile: row.profile, session: key(row.name), at: row.at ?? received, sequence: 0, state: row.state, fallback: row.fallback,
      ...(row.pid ? { pid: row.pid } : {}) }, received);
  }
  const left = () => store.db.query<{ session: string }, []>("SELECT session FROM hermes_sessions ORDER BY session").all().map((r) => r.session);
  const done = () => { store.db.close(); rmSync(root, { recursive: true, force: true }); };
  return { store, left, done };
}

test("the sweep keeps an ended row for ten minutes, then purges it when nothing could own it, and says whose card to recompute", () => {
  const { store, left, done } = endedRows([{ profile: "p", name: "rest", state: "offline", fallback: "idle" },
    { profile: "p", name: "idle", state: "idle", fallback: "idle" }, { profile: "q", name: "other", state: "offline", fallback: "idle" }]);
  try {
    expect(purgeEndedHermesSessions(store, [], 10_000 + TTL - 1)).toEqual([]);
    expect(left()).toHaveLength(3);
    expect(purgeEndedHermesSessions(store, [], 10_000 + TTL).sort()).toEqual(["p", "q"]); // each profile once, however many rows it lost
    expect(left()).toEqual([]);
    expect(purgeEndedHermesSessions(store, [], 10_000 + 2 * TTL)).toEqual([]); // nothing left, nothing to recompute
    expect(hermesProfileStatus(store, "p").body.state).toBe("offline");
  } finally { done(); }
});

test("an ended row is kept while a process that names its profile, or names none, is running; one that names another profile is no owner", () => {
  for (const [label, processes, kept] of [
    ["a process naming its profile", [{ pid: 1, profile: "p", startedAt: 1 }], true],
    ["a process naming no profile (a bare chat or gateway)", [{ pid: 1, profile: null, startedAt: 1 }], true],
    ["a process naming another profile", [{ pid: 1, profile: "q", startedAt: 1 }], false],
    ["only processes naming other profiles", [{ pid: 1, profile: "q" }, { pid: 2, profile: "r" }], false],
    ["no process", [], false],
  ] as const) {
    for (const [state, fallback] of [["offline", "idle"], ["idle", "idle"]] as const) {
      const { store, left, done } = endedRows([{ profile: "p", name: "rest", state, fallback }]);
      try {
        for (const age of [TTL, 3 * TTL, 1_000 * TTL]) {
          purgeEndedHermesSessions(store, processes, 10_000 + age);
          expect([label, state, age, left().length]).toEqual([label, state, age, kept ? 1 : 0]);
          if (!kept) break;
        }
      } finally { done(); }
    }
  }
});

test("a row whose hook named a process is owned by that process only: running, started before the hook, and not another profile's", () => {
  for (const [label, processes, kept] of [
    ["that process", [{ pid: 7, profile: "p", startedAt: 1 }], true],
    ["that process, which names no profile", [{ pid: 7, profile: null, startedAt: 1 }], true],
    ["that process, with no start time", [{ pid: 7, profile: "p" }], true],
    ["a reused pid: the process started after the hook", [{ pid: 7, profile: "p", startedAt: 20_000 }], false],
    ["another pid", [{ pid: 8, profile: "p", startedAt: 1 }], false],
    ["that pid, naming another profile", [{ pid: 7, profile: "q", startedAt: 1 }], false],
    ["an unresolved process of another pid", [{ pid: 8, profile: null, startedAt: 1 }], false],
  ] as const) {
    const { store, left, done } = endedRows([{ profile: "p", name: "rest", state: "offline", fallback: "idle", pid: 7 }]);
    try {
      purgeEndedHermesSessions(store, processes, 10_000 + TTL);
      expect([label, left().length]).toEqual([label, kept ? 1 : 0]);
    } finally { done(); }
  }
});

test("a row that says its session is over is purged after its ten minutes whatever runs; a working row is the retirement's, never purged", () => {
  const { store, left, done } = endedRows([{ profile: "p", name: "finalized", state: "offline", fallback: "offline" },
    { profile: "p", name: "working", state: "working", fallback: "working" }, { profile: "p", name: "retired", state: "working", fallback: "working" }]);
  try {
    const bare = [{ pid: 1, profile: null, startedAt: 1 }];
    expect(offlineExitedHermesSessions(store, [], 10_001).sort()).toEqual(["p"]); // both working rows retired, state offline / source retired
    applyHermesStatus(store, { profile: "p", session: key("working"), at: 10_002, sequence: 1, state: "working", fallback: "working" }, 10_002);
    expect(purgeEndedHermesSessions(store, bare, 10_000 + TTL - 1)).toEqual([]);
    expect(purgeEndedHermesSessions(store, bare, 10_000 + TTL)).toEqual([]); // finalized and retired go, though a bare process runs; the card is working still
    expect(left()).toEqual([key("working")]); // received at 10_002: a working row, and not yet ten minutes old
    expect(purgeEndedHermesSessions(store, [], 1_000 * TTL)).toEqual([]); // a working row is never purged here, however old
    expect(left()).toEqual([key("working")]);
  } finally { done(); }
});

test("the ten minutes count from the hook's receipt, not from the time the hook claims", () => {
  const received = 10_000_000;
  for (const claimed of [received - 90 * 60_000, received + 60 * 60_000]) {
    const { store, left, done } = endedRows([{ profile: "p", name: "rest", state: "offline", fallback: "idle", at: claimed }], received);
    try {
      expect(purgeEndedHermesSessions(store, [], received + TTL - 1)).toEqual([]);
      expect(left()).toHaveLength(1);
      expect(purgeEndedHermesSessions(store, [], received + TTL)).toEqual(["p"]);
    } finally { done(); }
  }
});

test("the sweep names only the profiles whose card the purge moved: a retired row decides nothing, and a finished session's row may not", () => {
  // Retirement and purge are two sweeps apart: the retired row is purged with no card to recompute.
  const retired = endedRows([{ profile: "p", name: "gone", state: "working", fallback: "working" }]);
  try {
    expect(offlineExitedHermesSessions(retired.store, [], 10_001)).toEqual(["p"]); // the card moves: working to offline
    expect(purgeEndedHermesSessions(retired.store, [], 10_000 + TTL)).toEqual([]); // the retired row goes; the card is offline either way
    expect(retired.left()).toEqual([]);
  } finally { retired.done(); }
  // A finished session's row, alone: the profile is offline with it and without it.
  const alone = endedRows([{ profile: "p", name: "done", state: "offline", fallback: "offline" }]);
  try {
    expect(purgeEndedHermesSessions(alone.store, [], 10_000 + TTL)).toEqual([]);
    expect(alone.left()).toEqual([]);
  } finally { alone.done(); }
  // The newest ended row is a finished session's, over a session still at its prompt (owned): the card was offline, and is idle once it goes.
  const newest = endedRows([{ profile: "p", name: "prompt", state: "offline", fallback: "idle", at: 9_000 }, { profile: "p", name: "done", state: "offline", fallback: "offline" }]);
  try {
    expect(hermesProfileStatus(newest.store, "p").body.state).toBe("offline");
    expect(purgeEndedHermesSessions(newest.store, [{ pid: 1, profile: "p", startedAt: 1 }], 10_000 + TTL)).toEqual(["p"]);
    expect(newest.left()).toEqual([key("prompt")]);
    expect(hermesProfileStatus(newest.store, "p").body.state).toBe("idle");
  } finally { newest.done(); }
});

test("purging an ended row moves the card to what the remaining rows say, and a kept row keeps it idle", () => {
  const { store, done } = endedRows([{ profile: "p", name: "gone", state: "offline", fallback: "idle", pid: 7 },
    { profile: "p", name: "stays", state: "offline", fallback: "idle", pid: 8 }]);
  try {
    expect(hermesProfileStatus(store, "p").body.state).toBe("idle");
    expect(purgeEndedHermesSessions(store, [{ pid: 8, profile: "p", startedAt: 1 }], 10_000 + TTL)).toEqual([]); // one row went, one is owned: still idle
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM hermes_sessions").get()?.n).toBe(1);
    expect(hermesProfileStatus(store, "p").body.state).toBe("idle");
    expect(purgeEndedHermesSessions(store, [], 10_000 + TTL)).toEqual(["p"]);
    expect(hermesProfileStatus(store, "p").body.state).toBe("offline");
  } finally { done(); }
});
