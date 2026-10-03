// Hermes privacy by default: every profile shows its state (working, idle, offline) and never an activity line, unless config.json lists
// it in `hermes_activity_profiles`. These tests run the daemon's own pieces over a throwaway Walkie home: the allow list's parser, the
// config schema and its writer, the file reader the daemon keeps, the Hermes route and discovery, and check that the hook reads the same
// answer from the same file. No environment variable decides anything.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHermesActivityProfiles, SharePolicyFile } from "../agent/share-policy.ts";
import { hermesObservation } from "../hooks/hermes.ts";
import { HERMES_ACTIVITY_PROFILES_MAX, hermesActivityProfiles } from "../protocol/hermes-activity.ts";
import { ConfigSchema, loadConfig, saveConfigField, saveHermesActivityProfiles } from "./config.ts";
import { EXITED_ACTIVITY } from "./discovery.ts";
import { applyHermesStatus, shownCard, submitHermesUpdate } from "./hermes-status.ts";
import { scrubHermesActivity, startHermesActivityScrub } from "./hermes-scrub.ts";
import { dispatch, type RouteCtx } from "./local-routes.ts";
import { createLogger, type Logger } from "./logger.ts";
import { effectiveState, observedAt } from "./views.ts";
import { makeCore } from "../../test/helpers/core.ts";
import { waitFor } from "../../test/helpers/cluster.ts";
import { AGENT, hook as claudeHook, ME, status, world } from "../../test/helpers/discovery-world.ts";
import { tnode } from "../../test/helpers/events.ts";
import type { World } from "../../test/helpers/hermes-world.ts";

const hex = (name: string) => createHash("sha256").update(name).digest("hex");
const names = (count: number) => Array.from({ length: count }, (_, i) => `profile-${i}`);

/** A throwaway Walkie home, removed after `body`. */
function withHome<T>(body: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "walkie-hermes-activity-"));
  try { return body(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

describe("the allow list as config.json states it", () => {
  test("a list of valid names is read, each name once", () => {
    expect(hermesActivityProfiles({ hermes_activity_profiles: ["research", "default", "a", "x-1"] })).toEqual(["research", "default", "a", "x-1"]);
    expect(hermesActivityProfiles({ hermes_activity_profiles: ["research", "research", "writer"] })).toEqual(["research", "writer"]);
    expect(hermesActivityProfiles({ hermes_activity_profiles: ["a".repeat(32)] })).toEqual(["a".repeat(32)]);
    expect(hermesActivityProfiles({ hermes_activity_profiles: names(HERMES_ACTIVITY_PROFILES_MAX) })).toHaveLength(HERMES_ACTIVITY_PROFILES_MAX);
    expect(hermesActivityProfiles({ share_activity: true, hermes_activity_profiles: [] })).toEqual([]);
  });

  test("anything else gives no profile: a missing key, a wrong type, a name Walkie cannot carry, one bad entry, too many", () => {
    const bad: unknown[] = [undefined, null, 0, "research", [], [["research"]], { hermes_activity_profiles: undefined }, { hermes_activity_profiles: null },
      { hermes_activity_profiles: "research" }, { hermes_activity_profiles: "research,writer" }, { hermes_activity_profiles: { 0: "research" } },
      { hermes_activity_profiles: [42] }, { hermes_activity_profiles: [null] }, { hermes_activity_profiles: [""] },
      { hermes_activity_profiles: ["Research"] }, { hermes_activity_profiles: [" research"] }, { hermes_activity_profiles: ["re search"] },
      { hermes_activity_profiles: ["re_search"] }, { hermes_activity_profiles: ["-research"] }, { hermes_activity_profiles: ["../research"] },
      { hermes_activity_profiles: ["a".repeat(33)] }, { hermes_activity_profiles: ["research", "Writer"] }, // one bad entry voids the whole list
      { hermes_activity_profiles: ["research", 7] }, { hermes_activity_profiles: names(HERMES_ACTIVITY_PROFILES_MAX + 1) }];
    for (const config of bad) expect([JSON.stringify(config), hermesActivityProfiles(config)]).toEqual([JSON.stringify(config), []]);
  });
});

describe("the daemon's config", () => {
  test("loadConfig keeps a valid list, defaults to none, and reads a malformed one as none rather than refusing to start", () => withHome((home) => {
    const path = join(home, "config.json");
    expect(loadConfig(path, false).hermes_activity_profiles).toEqual([]); // no file: the defaults are written
    expect(JSON.parse(readFileSync(path, "utf8")).hermes_activity_profiles).toEqual([]);
    writeFileSync(path, JSON.stringify({ hermes_activity_profiles: ["research", "writer"] }));
    expect(loadConfig(path, false).hermes_activity_profiles).toEqual(["research", "writer"]);
    for (const value of ["research", [42], ["Research"], ["research", "../x"], names(HERMES_ACTIVITY_PROFILES_MAX + 1), { a: 1 }, null]) {
      writeFileSync(path, JSON.stringify({ hermes_activity_profiles: value }));
      expect([JSON.stringify(value), loadConfig(path, false).hermes_activity_profiles]).toEqual([JSON.stringify(value), []]);
    }
  }));

  test("a loader that has never heard of the key accepts a config that carries it, and other writers keep it", () => withHome((home) => {
    // Every released daemon's ConfigSchema is a plain z.object (no .strict() on the top level, checked for v0.1.3 through v0.2.0-pre.10.1):
    // it strips keys it does not know. The schema of such a daemon is this one without the key.
    const older = ConfigSchema.omit({ hermes_activity_profiles: true });
    const parsed = older.safeParse({ share_activity: true, hermes_activity_profiles: ["research"] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toHaveProperty("hermes_activity_profiles");
    // this version stays tolerant of keys it does not know either, so a later key is no problem for it
    expect(ConfigSchema.safeParse({ hermes_activity_profiles: ["research"], a_future_key: { x: 1 } }).success).toBe(true);
    // a daemon that rewrites one field of config.json (saveConfigField, as every older version does) keeps the key it does not know
    const path = join(home, "config.json");
    writeFileSync(path, JSON.stringify({ hermes_activity_profiles: ["research"], share_activity: true }));
    saveConfigField(path, "share_prompts", true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ hermes_activity_profiles: ["research"], share_activity: true, share_prompts: true });
  }));

  test("saveHermesActivityProfiles writes the list atomically (0600), keeps every other key, and creates the home and file when there are none", () => withHome((home) => {
    const path = join(home, "walkie", "config.json"); // the home does not exist yet
    saveHermesActivityProfiles(path, ["research", "research", "writer"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ hermes_activity_profiles: ["research", "writer"] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, JSON.stringify({ share_activity: true, seats: { allow: true }, hermes_activity_profiles: ["research"] }));
    saveHermesActivityProfiles(path, ["writer"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ share_activity: true, seats: { allow: true }, hermes_activity_profiles: ["writer"] });
    saveHermesActivityProfiles(path, []); // the empty list clears it
    expect(JSON.parse(readFileSync(path, "utf8")).hermes_activity_profiles).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).share_activity).toBe(true);
  }));

  test("saveHermesActivityProfiles refuses what it should not touch, and leaves the file as it was", () => withHome((home) => {
    const path = join(home, "config.json");
    writeFileSync(path, JSON.stringify({ hermes_activity_profiles: ["research"] }));
    expect(() => saveHermesActivityProfiles(path, ["Research"])).toThrow();
    expect(() => saveHermesActivityProfiles(path, names(HERMES_ACTIVITY_PROFILES_MAX + 1))).toThrow();
    for (const content of ["[]", "null", "7", '"x"']) {
      writeFileSync(path, content);
      expect(() => saveHermesActivityProfiles(path, ["research"])).toThrow(/not a JSON object/);
      expect(readFileSync(path, "utf8")).toBe(content);
    }
    writeFileSync(path, "{ not json");
    expect(() => saveHermesActivityProfiles(path, ["research"])).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  }));
});

/** The configs the hook and the daemon must read the same way: what the person wrote, damaged or not. */
const CONFIGS: ReadonlyArray<readonly [string, string | null, readonly string[]]> = [
  ["no file", null, []], ["empty file", "", []], ["not JSON", "{ nope", []], ["an array", "[]", []], ["null", "null", []], ["no key", "{}", []],
  ["an empty list", JSON.stringify({ hermes_activity_profiles: [] }), []],
  ["a list", JSON.stringify({ hermes_activity_profiles: ["research", "writer"] }), ["research", "writer"]],
  ["a list with repeats", JSON.stringify({ hermes_activity_profiles: ["research", "research"] }), ["research"]],
  ["a string", JSON.stringify({ hermes_activity_profiles: "research" }), []],
  ["a bad entry", JSON.stringify({ hermes_activity_profiles: ["research", "Writer"] }), []],
  ["too many", JSON.stringify({ hermes_activity_profiles: names(HERMES_ACTIVITY_PROFILES_MAX + 1) }), []],
];

describe("the daemon and the hook read the same list from the same file", () => {
  test("the hook's reader and the daemon's file reader agree on every config, and both read damage as none", () => {
    for (const [what, content, expected] of CONFIGS) {
      withHome((home) => {
        if (content !== null) writeFileSync(join(home, "config.json"), content);
        expect([what, readHermesActivityProfiles(home)]).toEqual([what, expected]);
        expect([what, new SharePolicyFile(join(home, "config.json")).hermesActivityProfiles()]).toEqual([what, expected]);
      });
    }
  });

  test("the daemon picks a change up without a restart, and a damaged file takes the list away at once", () => withHome((home) => {
    const path = join(home, "config.json");
    const file = new SharePolicyFile(path);
    expect(file.hermesActivityProfiles()).toEqual([]);
    const write = (content: string) => { writeFileSync(`${path}.tmp`, content); renameSync(`${path}.tmp`, path); };
    write(JSON.stringify({ hermes_activity_profiles: ["research"] }));
    expect(file.hermesActivityProfiles()).toEqual(["research"]);
    write(JSON.stringify({ hermes_activity_profiles: ["writer"] })); // same size: the new file is the change
    expect(file.hermesActivityProfiles()).toEqual(["writer"]);
    write("{ damaged");
    expect(file.hermesActivityProfiles()).toEqual([]);
    write(JSON.stringify({ hermes_activity_profiles: ["research", "writer"], share_activity: true }));
    expect(file.hermesActivityProfiles()).toEqual(["research", "writer"]);
    expect(file.get()).toMatchObject({ activity: true }); // the share policy comes from the same read
    rmSync(path);
    expect(file.hermesActivityProfiles()).toEqual([]);
  }));
});

// ---- the route and discovery, over a world's real Core -----------------------------------------------------------------------------

/** The activity line of a profile's card, if it shows one. */
const lineOf = (w: World, profile: string) => status(w.core, `hermes-${profile}`)?.activity;

const BASE = { share_prompts: true, share_activity: true, share_paths: false };
/** Replaces the world's config.json by a new file (so the daemon sees the change), with the share policy it started with. */
function configure(w: World, extra: Record<string, unknown> | string): void {
  const file = w.core.paths.config;
  writeFileSync(`${file}.tmp`, typeof extra === "string" ? extra : JSON.stringify({ ...BASE, ...extra }));
  renameSync(`${file}.tmp`, file);
}

let sequence = 0;
/** One hook observation as the route receives it. */
function observation(profile: string, session: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { profile, session: hex(session), at: Date.now(), sequence: ++sequence, state: "working", fallback: "working", activity: "Using terminal", source: "tool", ...over };
}

async function post(w: World, body: Record<string, unknown>): Promise<Response> {
  const url = new URL("http://walkie/v1/hermes/status");
  const req = new Request(url, { method: "POST", body: JSON.stringify(body) });
  return dispatch({ core: w.core, req, url, agent: `hermes-${body.profile as string}` } as unknown as RouteCtx);
}

const rowOf = (w: World, session: string) => w.core.store.db.query<{ activity: string | null; source: string | null }, [string]>(
  "SELECT activity, source FROM hermes_sessions WHERE session = ?").get(hex(session));

/** A world whose cleanups run after `body`. */
async function inWorld(body: (w: World) => Promise<void>): Promise<void> {
  const cleanups: Array<() => void> = [];
  try { await body(world(cleanups)); } finally { while (cleanups.length) cleanups.pop()?.(); }
}

describe("the Hermes route", () => {
  test("by default no profile's activity is stored or posted, whatever it is called", async () => inWorld(async (w) => {
    for (const profile of ["example-billing", "payroll", "customer-support", "default", "research"]) {
      const response = await post(w, observation(profile, `${profile}-s1`));
      expect([profile, response.status]).toEqual([profile, 200]);
      expect([profile, rowOf(w, `${profile}-s1`)]).toEqual([profile, { activity: null, source: null }]);
      const card = status(w.core, `hermes-${profile}`);
      expect([profile, card?.state, card?.runtime_name]).toEqual([profile, "working", "hermes"]);
      expect([profile, card]).toEqual([profile, expect.not.objectContaining({ activity: expect.anything() })]);
    }
  }));

  test("a listed profile's activity is stored and posted, and no other profile's is, in the same daemon", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research"] });
    await post(w, observation("research", "r1"));
    await post(w, observation("example-billing", "b1"));
    expect(rowOf(w, "r1")).toEqual({ activity: "Using terminal", source: "tool" });
    expect(status(w.core, "hermes-research")).toMatchObject({ state: "working", runtime_name: "hermes", activity: "Using terminal" });
    expect(rowOf(w, "b1")).toEqual({ activity: null, source: null });
    expect(status(w.core, "hermes-example-billing")).not.toHaveProperty("activity");
  }));

  test("a profile taken off the list shows nothing from the rows it stored while it was on it", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research"] });
    await post(w, observation("research", "old")); // working, "Using terminal": stored while the profile was listed
    expect(status(w.core, "hermes-research")?.activity).toBe("Using terminal");
    configure(w, { hermes_activity_profiles: [] });
    // another session of the profile hooks: the card is computed from the working row that still holds the old line, and must not show it
    await post(w, observation("research", "new", { state: "idle", fallback: "idle", activity: undefined, source: undefined }));
    expect(rowOf(w, "old")).toEqual({ activity: "Using terminal", source: "tool" });
    expect(status(w.core, "hermes-research")).toMatchObject({ state: "working" });
    expect(status(w.core, "hermes-research")).not.toHaveProperty("activity");
  }));

  test("a damaged setting fails private: the profile it names shows state only", async () => inWorld(async (w) => {
    for (const [what, content] of [["not JSON", "{ damaged"], ["a string", JSON.stringify({ ...BASE, hermes_activity_profiles: "research" })],
      ["a bad entry", JSON.stringify({ ...BASE, hermes_activity_profiles: ["research", "Writer"] })]] as const) {
      configure(w, content);
      await post(w, observation("research", `damaged-${what}`));
      expect([what, rowOf(w, `damaged-${what}`)]).toEqual([what, { activity: null, source: null }]);
    }
    expect(status(w.core, "hermes-research")).not.toHaveProperty("activity");
    configure(w, { hermes_activity_profiles: ["research"] }); // repaired: it shows again
    await post(w, observation("research", "repaired"));
    expect(status(w.core, "hermes-research")?.activity).toBe("Using terminal");
  }));

  test("the hook and the daemon agree: for every config, the hook builds an activity line, and the daemon lets one through, exactly when the config lists the profile", async () => {
    const payload = JSON.stringify({ hook_event_name: "pre_tool_call", session_id: "sess", profile: "research", tool_name: "terminal" });
    for (const [what, content, expected] of CONFIGS) {
      // the hook's side: its own reader on a home holding this config
      const hookShows = withHome((home) => {
        if (content !== null) writeFileSync(join(home, "config.json"), content);
        return hermesObservation(payload, readHermesActivityProfiles(home), { prompts: false, activity: true })?.activity !== undefined;
      });
      // the daemon's side: the same config in its home, and an observation that carries a line whatever the hook decided
      let daemonShows = false;
      await inWorld(async (w) => {
        configure(w, content ?? "{}");
        const response = await post(w, observation("research", `agree-${what}`));
        expect([what, response.status]).toEqual([what, 200]);
        daemonShows = status(w.core, "hermes-research")?.activity !== undefined;
      });
      expect([what, hookShows, daemonShows]).toEqual([what, expected.includes("research"), expected.includes("research")]);
    }
  });
});

describe("shownCard", () => {
  const card = { body: { agent: "hermes-research", state: "working" as const, runtime: "other" as const, runtime_name: "hermes", activity: "Using terminal" },
    provenance: { activity: "tool" as const } };
  test("keeps the line for a listed profile and removes it, with where it came from, for every other", () => {
    expect(shownCard(card, ["research"])).toBe(card);
    expect(shownCard(card, ["writer"])).toEqual({ body: { agent: "hermes-research", state: "working", runtime: "other", runtime_name: "hermes" }, provenance: {} });
    expect(shownCard(card, [])).toEqual({ body: { agent: "hermes-research", state: "working", runtime: "other", runtime_name: "hermes" }, provenance: {} });
    const plain = { body: { agent: "hermes-writer", state: "idle" as const, runtime: "other" as const, runtime_name: "hermes" }, provenance: {} };
    expect(shownCard(plain, [])).toBe(plain);
    expect(card.body.activity).toBe("Using terminal"); // the card it was given is never changed
  });
});

describe("the scan for cards to scrub", () => {
  test("Store.agentsWithPrefix is a range over the primary key: one node's agents by prefix, nothing else", async () => inWorld(async (w) => {
    const insert = w.core.store.db.query("INSERT INTO agents_latest(node, agent, handle, event_id, ts, body) VALUES (?, ?, 'alex', ?, 1, '{}')");
    const me = w.core.nodeId;
    for (const [node, agent] of [[me, "hermes-a"], [me, "hermes-b"], [me, "hermes-"], [me, "hermes."], [me, "hermesx"], [me, "hermes"], [me, "cc-1"], ["peer", "hermes-c"]] as const) {
      insert.run(node, agent, `${node}:${agent}`);
    }
    expect(w.core.store.agentsWithPrefix(me, "hermes-").map((r) => r.agent)).toEqual(["hermes-", "hermes-a", "hermes-b"]);
    expect(w.core.store.agentsWithPrefix("peer", "hermes-").map((r) => r.agent)).toEqual(["hermes-c"]);
    expect(w.core.store.agentsWithPrefix("nobody", "hermes-")).toEqual([]);
    const plan = w.core.store.db.query<{ detail: string }, [string, string, string]>(
      "EXPLAIN QUERY PLAN SELECT * FROM agents_latest WHERE node = ? AND agent >= ? AND agent < ? ORDER BY agent").all(me, "hermes-", "hermes.");
    expect(plan.map((r) => r.detail).join(" ")).toMatch(/SEARCH agents_latest USING (COVERING )?INDEX \w+ \(node=\? AND agent>\? AND agent<\?\)/);
  }));
});

describe("discovery", () => {
  const listed = (w: World) => ({ hermesActivity: () => w.core.hermesActivityProfiles() }); // as the daemon wires it (main.ts)
  /** How many statuses this agent ever signed with an activity line: what the team was ever shown, not only what the card shows now. */
  const activityEvents = (w: World, agent: string) => w.core.store.db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM events WHERE kind = 'agent.status' AND author_agent = ? AND json_extract(body, '$.activity') IS NOT NULL").get(agent)!.n;
  const process = (w: World, pid: number, profile: string) =>
    ({ pid, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: `hermes --profile ${profile} chat`, cpuMs: 1_000 });

  test("a listed profile's card says when its process exits, and an unlisted profile's was never shown a line, not even for an instant", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research"] });
    for (const profile of ["research", "example-billing"]) await post(w, observation(profile, `${profile}-s`, { state: "idle", fallback: "idle", activity: "Finished turn", source: "phrase" }));
    expect(status(w.core, "hermes-research")?.activity).toBe("Finished turn");
    expect(status(w.core, "hermes-example-billing")).not.toHaveProperty("activity");
    const disc = w.disc(listed(w));
    w.fx.procs.push(process(w, 700, "research"), process(w, 701, "example-billing"));
    await disc.tick();
    w.fx.procs = w.fx.procs.filter((p) => p.pid !== 700 && p.pid !== 701);
    w.clock.t += 15_000;
    await disc.tick();
    expect(status(w.core, "hermes-research")).toMatchObject({ state: "offline", runtime_name: "hermes", activity: EXITED_ACTIVITY });
    expect(status(w.core, "hermes-example-billing")).toMatchObject({ state: "offline", runtime_name: "hermes" });
    expect(status(w.core, "hermes-example-billing")).not.toHaveProperty("activity");
    expect(activityEvents(w, "hermes-example-billing")).toBe(0); // at no point did any status of it carry a line
    expect(activityEvents(w, "hermes-research")).toBeGreaterThan(1); // the listed one's did: "Finished turn", "Process exited"
  }));

  test("once a profile is off the list, neither discovery's change of its state nor its exit carries the line it showed before", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research"] });
    await post(w, observation("research", "r", { state: "idle", fallback: "idle", activity: "Finished turn", source: "phrase" }));
    const disc = w.disc(listed(w));
    w.fx.procs.push(process(w, 700, "research"));
    const busy = () => { w.clock.t += 30_000; w.fx.procs = w.fx.procs.map((p) => ({ ...p, cpuMs: (p.cpuMs ?? 0) + 25_000 })); };
    await disc.tick(); // a baseline for the process's CPU
    busy();
    await disc.tick(); // one busy reading: discovery counts CPU only after two in a row
    expect(status(w.core, "hermes-research")).toMatchObject({ state: "idle", activity: "Finished turn" }); // still listed, untouched
    configure(w, { hermes_activity_profiles: [] }); // taken off the list
    const before = activityEvents(w, "hermes-research");
    expect(before).toBeGreaterThan(0);
    // the second busy reading comes in the scan that learns the profile is off the list: discovery replaces the hook's idle card with
    // its own state, built from the card that still holds the old line, and must keep the line out of it
    busy();
    await disc.tick();
    expect(status(w.core, "hermes-research")).toMatchObject({ state: "working", runtime_name: "hermes" });
    expect(status(w.core, "hermes-research")).not.toHaveProperty("activity");
    // and then the process exits
    w.fx.procs = w.fx.procs.filter((p) => p.pid !== 700);
    w.clock.t += 15_000;
    await disc.tick();
    expect(status(w.core, "hermes-research")).toMatchObject({ state: "offline", runtime_name: "hermes" });
    expect(status(w.core, "hermes-research")).not.toHaveProperty("activity");
    expect(activityEvents(w, "hermes-research")).toBe(before); // not one more status carried a line
  }));

  test("the card the census sweep posts for a profile that is off the list carries no line from the rows it kept", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research"] });
    const hook = (session: string, over: Record<string, unknown>) => submitHermesUpdate(w.core.statuses, applyHermesStatus(w.core.store,
      { profile: "research", session: hex(session), at: w.clock.t, sequence: ++sequence, state: "working", fallback: "working", ...over } as never, w.clock.t),
      w.core.hermesActivityProfiles());
    hook("prompt", { state: "offline", fallback: "idle", activity: "Finished turn", source: "phrase" }); // a session at its prompt
    hook("busy", { activity: "Using terminal", source: "tool" }); // another one, working
    expect(status(w.core, "hermes-research")).toMatchObject({ state: "working", activity: "Using terminal" });
    const disc = w.disc(listed(w));
    w.fx.procs.push(process(w, 700, "research"));
    await disc.tick();
    configure(w, { hermes_activity_profiles: [] }); // taken off the list
    const before = activityEvents(w, "hermes-research");
    // the process exits: the sweep retires the working session and recomputes the card from the session at its prompt, whose line is "Finished turn"
    w.fx.procs = w.fx.procs.filter((p) => p.pid !== 700);
    w.clock.t += 15_000;
    await disc.tick();
    expect(w.core.store.db.query<{ state: string }, [string]>("SELECT state FROM hermes_sessions WHERE session = ?").get(hex("busy"))?.state).toBe("offline"); // retired
    expect(status(w.core, "hermes-research")).toMatchObject({ state: "idle", runtime_name: "hermes" });
    expect(status(w.core, "hermes-research")).not.toHaveProperty("activity");
    expect(activityEvents(w, "hermes-research")).toBe(before);
  }));

  test("a card that shows an activity line for a profile that is no longer listed is posted again with its state only, within one scan", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research", "writer"] });
    await post(w, observation("research", "r"));
    await post(w, observation("writer", "w"));
    expect([status(w.core, "hermes-research")?.activity, status(w.core, "hermes-writer")?.activity]).toEqual(["Using terminal", "Using terminal"]);
    const disc = w.disc(listed(w));
    await disc.tick();
    expect([status(w.core, "hermes-research")?.activity, status(w.core, "hermes-writer")?.activity]).toEqual(["Using terminal", "Using terminal"]); // listed: untouched
    configure(w, { hermes_activity_profiles: ["writer"] }); // research is taken off the list
    w.clock.t += 15_000;
    await disc.tick();
    expect(status(w.core, "hermes-research")).toMatchObject({ state: "working", runtime: "other", runtime_name: "hermes" });
    expect(status(w.core, "hermes-research")).not.toHaveProperty("activity");
    expect(status(w.core, "hermes-writer")?.activity).toBe("Using terminal");
    configure(w, "{ damaged"); // and a damaged config takes every line away at the next scan
    w.clock.t += 15_000;
    await disc.tick();
    expect(status(w.core, "hermes-writer")).toMatchObject({ state: "working", runtime_name: "hermes" });
    expect(status(w.core, "hermes-writer")).not.toHaveProperty("activity");
  }));

  /** Holds the process listing of the next scans until the returned function is called: a scan that is in flight, deterministically. */
  const holdListing = (w: World): (() => void) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const list = w.fx.list.bind(w.fx);
    w.fx.list = async () => { await gate; return list(); };
    return release;
  };
  const atPrompt = { state: "idle", fallback: "idle", activity: "Finished turn", source: "phrase" } as const; // a session at its prompt: it hooks no more

  test("a profile listed while a scan is in flight keeps the line its hook posted: the sweep judges by the list as it is then, not as the scan began", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: [] });
    const disc = w.disc(listed(w));
    const release = holdListing(w);
    const scanning = disc.tick(); // the scan has read the list ([]) and waits for the process listing
    configure(w, { hermes_activity_profiles: ["research"] }); // the person lists research while it is in flight
    expect((await post(w, observation("research", "r", atPrompt))).status).toBe(200);
    expect(lineOf(w, "research")).toBe("Finished turn");
    w.clock.t += 15_000;
    release();
    await scanning;
    expect(lineOf(w, "research")).toBe("Finished turn"); // listed now: the sweep did not scrub it with the list the scan began with
  }));

  test("a profile taken off the list while a scan is in flight loses its line at that scan's sweep, not one scan later", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research"] });
    await post(w, observation("research", "r", atPrompt));
    expect(lineOf(w, "research")).toBe("Finished turn");
    const disc = w.disc(listed(w));
    const release = holdListing(w);
    const scanning = disc.tick(); // the scan has read the list (["research"]) and waits for the process listing
    configure(w, { hermes_activity_profiles: [] }); // the person takes it off while it is in flight
    w.clock.t += 15_000;
    release();
    await scanning;
    expect(status(w.core, "hermes-research")).toMatchObject({ state: "idle", runtime_name: "hermes" });
    expect(status(w.core, "hermes-research")).not.toHaveProperty("activity");
  }));

  test("a discovery built without the setting lists nobody: every Hermes card is state only", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research"] }); // the file lists it, but this discovery was never given the list
    await post(w, observation("research", "r"));
    expect(status(w.core, "hermes-research")?.activity).toBe("Using terminal");
    await w.disc().tick(); // no hermesActivity option: private
    expect(status(w.core, "hermes-research")).not.toHaveProperty("activity");
  }));
});

// ---- the scrub does not depend on discovery ----------------------------------------------------------------------------------------
// A machine with `"discover_agents": false` (and a Windows daemon) runs no discovery scan, so nothing there would ever take a line off the
// card of a session at its prompt, which hooks no more. The daemon's own timer does, at start and every pass (src/daemon/hermes-scrub.ts).
// No test below builds an AgentDiscovery.

describe("the scrub without discovery", () => {
  const quiet = createLogger({});
  const statusEvents = (w: World, agent: string) => w.core.store.db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM events WHERE kind = 'agent.status' AND author_agent = ?").get(agent)!.n;

  test("a pass posts state only for each card that shows a line for an unlisted profile, once, and touches no other card", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research", "writer"] });
    await post(w, observation("research", "r"));
    await post(w, observation("writer", "w"));
    await post(w, observation("example-billing", "b")); // never listed: no line was ever stored for it
    claudeHook(w.core, "working", "Thinking"); // an ordinary agent that shows a line: not a Hermes card, never touched
    w.clock.t += 15_000; // a later status than the cards above
    const before = statusEvents(w, "hermes-research");
    expect(scrubHermesActivity(w.core, ["research", "writer"])).toBe(0); // both listed (and example-billing has no line)
    expect(statusEvents(w, "hermes-research")).toBe(before);
    expect(scrubHermesActivity(w.core, ["writer"])).toBe(1); // research left the list
    expect(status(w.core, "hermes-research")).toMatchObject({ state: "working", runtime: "other", runtime_name: "hermes" });
    expect(status(w.core, "hermes-research")).not.toHaveProperty("activity");
    expect(statusEvents(w, "hermes-research")).toBe(before + 1);
    expect(lineOf(w, "writer")).toBe("Using terminal");
    expect(status(w.core, AGENT)?.activity).toBe("Thinking");
    expect(scrubHermesActivity(w.core, ["writer"])).toBe(0); // nothing left to post: a second pass repeats nothing
    expect(statusEvents(w, "hermes-research")).toBe(before + 1);
    expect(scrubHermesActivity(w.core, [])).toBe(1); // an empty list takes writer's line too
    expect(lineOf(w, "writer")).toBeUndefined();
    expect(status(w.core, AGENT)?.activity).toBe("Thinking");
  }));

  test("a pass keeps the time the card was observed: a session that died long ago is not made to look alive by it", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research"] });
    await post(w, observation("research", "r")); // working, "Using terminal"
    const before = w.core.store.agent(w.core.nodeId, "hermes-research")!;
    w.clock.t += 3 * 60 * 60_000; // three hours and no hook since: no discovery runs here to say the session is gone
    expect(scrubHermesActivity(w.core, [])).toBe(1);
    const after = w.core.store.agent(w.core.nodeId, "hermes-research")!;
    const card = JSON.parse(after.body) as { state: "working"; observed_at?: number };
    expect(after.ts).toBeGreaterThan(before.ts); // signed now
    expect(observedAt(card, after.ts)).toBe(before.ts); // observed then
    expect(effectiveState(card.state, observedAt(card, after.ts), true, w.clock.t)).toBe("offline"); // shown as the stale card it is, not as working
    expect(card).not.toHaveProperty("activity");
  }));

  test("a card whose status bucket is empty is left for the next pass, which posts it", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research"] });
    await post(w, observation("research", "r"));
    w.clock.t += 15_000;
    const take = w.core.limiter.take.bind(w.core.limiter);
    Object.assign(w.core.limiter, { take: () => false });
    expect(scrubHermesActivity(w.core, [])).toBe(0);
    expect(lineOf(w, "research")).toBe("Using terminal");
    Object.assign(w.core.limiter, { take });
    expect(scrubHermesActivity(w.core, [])).toBe(1);
    expect(lineOf(w, "research")).toBeUndefined();
  }));

  test("a node that is not in a team has nothing to scrub, and a pass does not throw", () => {
    const cleanups: Array<() => void> = [];
    try {
      const core = makeCore(tnode("solo"), "00000000000000aa", cleanups); // a team id in its store but no roster: not an admitted member
      expect(scrubHermesActivity(core, [])).toBe(0);
    } finally { while (cleanups.length) cleanups.pop()?.(); }
  });

  test("the timer takes the line off a profile that left the list, and off every profile once the file is damaged, with no discovery built", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research", "writer"] });
    await post(w, observation("research", "r"));
    await post(w, observation("writer", "w"));
    const stop = startHermesActivityScrub(w.core, quiet, { intervalMs: 10 });
    try {
      await Bun.sleep(80); // many passes while both are listed: nothing is touched
      expect([lineOf(w, "research"), lineOf(w, "writer")]).toEqual(["Using terminal", "Using terminal"]);
      w.clock.t += 15_000;
      configure(w, { hermes_activity_profiles: ["writer"] }); // research is taken off the list
      await waitFor(() => lineOf(w, "research") === undefined, { what: "research's line gone" });
      expect(status(w.core, "hermes-research")).toMatchObject({ state: "working", runtime_name: "hermes" });
      expect(lineOf(w, "writer")).toBe("Using terminal");
      w.clock.t += 15_000;
      configure(w, "{ damaged"); // a damaged file lists nobody
      await waitFor(() => lineOf(w, "writer") === undefined, { what: "writer's line gone" });
      expect(status(w.core, "hermes-writer")).toMatchObject({ state: "working", runtime_name: "hermes" });
    } finally { stop(); }
  }));

  test("it scrubs at start, before the first interval: a list edited while the daemon was down is in force at once", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research"] });
    await post(w, observation("research", "r"));
    expect(lineOf(w, "research")).toBe("Using terminal");
    w.clock.t += 15_000;
    configure(w, { hermes_activity_profiles: [] }); // taken off the list while no daemon ran: no pass has seen it
    const stop = startHermesActivityScrub(w.core, quiet, { intervalMs: 3_600_000 });
    try { expect(lineOf(w, "research")).toBeUndefined(); } finally { stop(); }
  }));

  test("a stopped scrub does nothing more", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research"] });
    await post(w, observation("research", "r"));
    startHermesActivityScrub(w.core, quiet, { intervalMs: 10 })();
    w.clock.t += 15_000;
    configure(w, { hermes_activity_profiles: [] });
    await Bun.sleep(80); // eight intervals, had it still been running
    expect(lineOf(w, "research")).toBe("Using terminal");
  }));

  test("a pass that fails is logged without the profile and the timer lives on", async () => inWorld(async (w) => {
    configure(w, { hermes_activity_profiles: ["research"] });
    await post(w, observation("research", "r"));
    w.clock.t += 15_000;
    configure(w, { hermes_activity_profiles: [] });
    const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const log: Logger = { ...quiet, warn: (msg, fields) => { warns.push({ msg, ...(fields ? { fields } : {}) }); } };
    const take = w.core.limiter.take.bind(w.core.limiter);
    let calls = 0;
    Object.assign(w.core.limiter, { take: (...args: Parameters<typeof take>) => { if (++calls === 1) throw new Error("the status path is down"); return take(...args); } });
    const stop = startHermesActivityScrub(w.core, log, { intervalMs: 10 }); // the run at start fails, a later one succeeds
    try {
      await waitFor(() => lineOf(w, "research") === undefined, { what: "the line gone after the failed pass" });
      expect(warns[0]).toEqual({ msg: "hermes_activity_scrub_failed", fields: { err: "the status path is down" } });
      expect(JSON.stringify(warns)).not.toContain("research");
    } finally { stop(); }
  }));
});
