// Round 10, finding 2: an idle Hermes session is not offline because another profile hooked. Through discovery, with the census
// scanning every 15 s and fixtures for the processes and the clock.
import { expect, test } from "bun:test";
import { status, world, ME } from "../../test/helpers/discovery-world.ts";
import { hermesEvent, hermesHook, launchd, offlineEvents, rowState, type World } from "../../test/helpers/hermes-world.ts";

const VENV = "/Users/example/.hermes/hermes-agent/venv/bin";
const PY = `${VENV}/python3`;
const HERMES = `${VENV}/hermes`;
const BARE_GATEWAY = `${VENV}/python -m hermes_cli.main gateway run --replace`; // this Mac's always-on gateway (pid 41648)

// ---- an idle session is not offline because another profile hooked (round 10, finding 2) --------------------------------
// A session at its prompt hooks no more, so its row ages while another profile's hooks keep arriving. Only the census sweep
// ends such a row, and only when its ten minutes have passed and no live process could own it.
type Proc = World["fx"]["procs"][number];
/**
 * Hook events a millisecond apart. Signed statuses that share a time are ordered by their ids, which compare as text (`o:9` is
 * above `o:10`), so a test that reads the latest card of events sent at one instant would read whichever id sorts last.
 */
function hermesSpaced(w: World, profile: string, name: string, events: readonly string[]) {
  for (const event of events) { hermesEvent(w, profile, name, event); w.clock.t += 1; }
}
const TURN_EVENTS = ["on_session_start", "pre_llm_call", "post_llm_call", "on_session_end"];
const WORK = (w: World): Proc => ({ pid: 400, ppid: 1, uid: ME, startedAt: w.clock.t - 600_000, command: "hermes -p work chat", tty: "ttys009" });

/**
 * `old` ends a turn and then sits at its prompt (its row: state offline, fallback idle) while `work` hooks every 5 s and the
 * census scans every 15 s. `exitsAt`: minute at which the processes of `old` (every one but `work`'s) exit, silently. Returns the
 * card of `old` after each scan, its rows at the end, and the offline events it was sent.
 */
async function idleTimeline(procs: (w: World) => Proc[], minutes: number, exitsAt?: number) {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w), WORK(w), ...procs(w)];
    for (const p of w.fx.procs) w.fx.cwds.set(p.pid, w.cwd);
    const disc = w.disc();
    await disc.tick();
    hermesSpaced(w, "old", "prompt", TURN_EVENTS);
    const lastHook = w.clock.t;
    const cards: string[] = [];
    for (let step = 1; step * 5_000 <= minutes * 60_000; step++) {
      w.clock.t = lastHook + step * 5_000;
      if (exitsAt !== undefined && w.clock.t - lastHook >= exitsAt * 60_000) w.fx.procs = w.fx.procs.filter((p) => p.pid === 1 || p.pid === 400);
      hermesHook(w, "work", "busy");
      if (step % 3 === 0) { await disc.tick(); cards.push(`${status(w.core, "hermes-old")?.state}`); }
    }
    const rows = w.core.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM hermes_sessions WHERE profile = 'old'").get()?.n;
    return { cards, rows, offline: offlineEvents(w, "hermes-old"), workCard: status(w.core, "hermes-work")?.state };
  } finally { while (cleanups.length) cleanups.pop()?.(); }
}
const OLD_NAMED = (w: World): Proc => ({ pid: 401, ppid: 1, uid: ME, startedAt: w.clock.t - 600_000, command: `${PY} ${HERMES} -p old chat`, tty: "ttys001" });
const OLD_BARE = (w: World): Proc => ({ pid: 401, ppid: 1, uid: ME, startedAt: w.clock.t - 600_000, command: `${PY} ${HERMES} chat`, tty: "ttys001" });
const OLD_GATEWAY = (w: World): Proc => ({ pid: 401, ppid: 1, uid: ME, startedAt: w.clock.t - 600_000, command: `${PY} -m hermes_cli.main -p old gateway run --replace`, tty: null });

for (const [label, process] of [["its named process", OLD_NAMED], ["a bare process (it could run any profile)", OLD_BARE], ["its named gateway", OLD_GATEWAY]] as const) {
  test(`a session idle at its prompt for 30 minutes keeps its idle card while another profile hooks every 5 s: ${label} runs`, async () => {
    const r = await idleTimeline((w) => [process(w)], 30);
    expect(new Set(r.cards)).toEqual(new Set(["idle"]));
    expect(r.cards).toHaveLength(120);
    expect([r.rows, r.offline]).toEqual([1, 0]); // its row is still there, and no offline was ever sent for it
    expect(r.workCard).toBe("working");
  });
}

test("a session idle at its prompt whose process exited is purged by the sweep once its ten minutes have passed, not by another profile's hooks", async () => {
  const r = await idleTimeline(() => [], 30);
  // scans run every 15 s from the last hook: the 40th is the one at exactly ten minutes
  expect(r.cards.slice(0, 39)).toEqual(Array(39).fill("idle"));
  expect(r.cards.slice(39)).toEqual(Array(81).fill("offline"));
  expect([r.rows, r.offline]).toEqual([0, 1]); // its row is purged, and its card went offline exactly once
});

test("when the named process of an idle session exits after 30 minutes, the card goes offline and the row is purged at that scan", async () => {
  const r = await idleTimeline((w) => [OLD_NAMED(w)], 35, 30);
  expect(r.cards.slice(0, 119)).toEqual(Array(119).fill("idle")); // it was alive and idle for the first 30 minutes (119 scans)
  expect(r.cards.slice(119)).toEqual(Array(r.cards.length - 119).fill("offline")); // the 120th, at 30:00, finds its process gone
  expect([r.rows, r.offline >= 1]).toEqual([0, true]);
});

test("a process of another profile is no owner: the idle session of `old` is purged at ten minutes whoever else runs", async () => {
  const r = await idleTimeline((w) => [{ pid: 402, ppid: 1, uid: ME, startedAt: w.clock.t - 600_000, command: `${PY} ${HERMES} -p example-ops chat`, tty: "ttys002" }], 12);
  expect(r.cards.slice(0, 39)).toEqual(Array(39).fill("idle"));
  expect(r.cards.slice(39)).toEqual(Array(r.cards.length - 39).fill("offline"));
  expect(r.rows).toBe(0);
});

test("a busy Mac (another profile hooking every 5 s) purges the exited idle session at ten minutes whatever the scan phase", async () => {
  for (let phase = 1_000; phase <= 15_000; phase += 2_000) {
    const cleanups: Array<() => void> = [];
    try {
      const w = world(cleanups);
      w.fx.procs = [launchd(w), WORK(w)];
      const disc = w.disc();
      await disc.tick();
      hermesSpaced(w, "old", "prompt", TURN_EVENTS);
      const t0 = w.clock.t;
      const timeline: Array<{ at: number; kind: "scan" | "busy" }> = [];
      for (let at = 2_000; at <= 12 * 60_000; at += 5_000) timeline.push({ at, kind: "busy" });
      for (let at = phase; at <= 12 * 60_000; at += 15_000) timeline.push({ at, kind: "scan" });
      timeline.sort((a, b) => a.at - b.at || (a.kind === "busy" ? -1 : 1));
      let offlineAt: number | null = null;
      for (const step of timeline) {
        w.clock.t = t0 + step.at;
        if (step.kind === "busy") hermesHook(w, "work", "busy"); else await disc.tick();
        if (offlineAt === null && status(w.core, "hermes-old")?.state === "offline") offlineAt = step.at;
      }
      expect([phase, offlineAt !== null && offlineAt >= 10 * 60_000 && offlineAt < 10 * 60_000 + 15_000]).toEqual([phase, true]);
    } finally { while (cleanups.length) cleanups.pop()?.(); }
  }
});

test("a finished session's row is purged at ten minutes, though a bare process runs: nothing owns a session that finalized", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w), { pid: 300, ppid: 1, uid: ME, startedAt: w.clock.t - 86_400_000, command: BARE_GATEWAY }];
    const disc = w.disc();
    await disc.tick();
    hermesSpaced(w, "done", "S", [...TURN_EVENTS, "on_session_finalize"]);
    const lastHook = w.clock.t - 1; // the finalize hook's own time
    expect([rowState(w, "S"), status(w.core, "hermes-done")?.state]).toEqual(["offline", "offline"]); // finalized: over for good
    w.clock.t = lastHook + 10 * 60_000 - 1;
    await disc.tick();
    expect(rowState(w, "S")).toBe("offline");
    w.clock.t = lastHook + 10 * 60_000;
    await disc.tick();
    expect(rowState(w, "S")).toBeUndefined(); // no process owns a session that finalized, though the bare gateway could own any other
    expect(status(w.core, "hermes-done")?.state).toBe("offline");
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

test("a quiet working session retired at ten minutes costs one offline status; purging its retired row a scan later costs none", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w), { pid: 202, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "hermes -p default chat", tty: "ttys001" }];
    w.fx.cwds.set(202, w.cwd);
    const disc = w.disc();
    await disc.tick();
    hermesHook(w, "default", "long"); // a long tool call: no hook follows
    const lastHook = w.clock.t;
    w.clock.t = lastHook + 10 * 60_000;
    await disc.tick();
    expect([rowState(w, "long"), status(w.core, "hermes-default")?.state, offlineEvents(w, "hermes-default")]).toEqual(["offline", "offline", 1]);
    w.clock.t += 15_000;
    await disc.tick();
    expect([rowState(w, "long"), status(w.core, "hermes-default")?.state, offlineEvents(w, "hermes-default")]).toEqual([undefined, "offline", 1]);
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

test("a session at its prompt keeps its row while a bare process runs, however long, and a finished sibling's purge leaves its idle card", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w), { pid: 300, ppid: 1, uid: ME, startedAt: w.clock.t - 86_400_000, command: BARE_GATEWAY }];
    const disc = w.disc();
    await disc.tick();
    hermesSpaced(w, "bot", "chat-1", TURN_EVENTS); // a bot's chat at its prompt
    w.clock.t += 1_000;
    hermesSpaced(w, "bot", "chat-2", ["on_session_start", "on_session_end", "on_session_finalize"]); // another chat, finished: the newest row
    expect(status(w.core, "hermes-bot")?.state).toBe("offline"); // the newest ended row decides
    for (let step = 1; step <= 120; step++) { w.clock.t += 15_000; await disc.tick(); } // 30 minutes of scans
    expect([rowState(w, "chat-1"), rowState(w, "chat-2")]).toEqual(["offline", undefined]); // chat-1 is owned by the gateway; chat-2 is over
    expect(status(w.core, "hermes-bot")?.state).toBe("idle"); // with the finished chat purged, the card is what the chat at its prompt says
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

// ---- a session resumed by a title that spells a help or version flag is still a session (round 12, finding 1) -----------------
// Read as `hermes --help`, such a process is neither a session nor liveness evidence: with no other Hermes process to own its
// row, the sweep purged the row of a live session at ten minutes and its card went offline. A title is free text.
test("a resumed session whose title or id spells a help or version flag keeps its row and its idle card at its prompt for 30 minutes", async () => {
  for (const tail of ["-c fix -h handling", "-c mysession -v", "-r id --help"]) {
    const cleanups: Array<() => void> = [];
    try {
      const w = world(cleanups);
      w.fx.procs = [launchd(w), { pid: 500, ppid: 1, uid: ME, startedAt: w.clock.t - 600_000, command: `${PY} ${HERMES} ${tail}`, tty: "ttys004" }];
      w.fx.cwds.set(500, w.cwd);
      const disc = w.disc();
      await disc.tick();
      hermesSpaced(w, "default", "titled", TURN_EVENTS);
      const lastHook = w.clock.t;
      const cards = new Set<string | undefined>();
      for (let step = 1; step <= 120; step++) { w.clock.t = lastHook + step * 15_000; await disc.tick(); cards.add(status(w.core, "hermes-default")?.state); }
      expect([tail, [...cards], rowState(w, "titled"), offlineEvents(w, "hermes-default")]).toEqual([tail, ["idle"], "offline", 0]);
    } finally { while (cleanups.length) cleanups.pop()?.(); }
  }
});
