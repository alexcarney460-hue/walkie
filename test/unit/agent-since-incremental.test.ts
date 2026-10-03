// DAEMON-STALL-2: AgentSince reads a roster without allocating for the rows that did not change, and gives exactly the
// answers the one-pass version gave (compared here with that version, verbatim, on random roster histories, two rows
// sharing one id included: two machines of one person that share a hostname).
import { describe, expect, test } from "bun:test";
import { AgentSince, type SinceInput, type SinceView } from "../../src/protocol/agent-since.ts";
import type { AgentState } from "../../src/protocol/schemas.ts";

/** AgentSince as it was before DAEMON-STALL-2: every read builds a new record for every row. */
class ReferenceSince {
  private seen = new Map<string, { state: AgentState; stateSince: number; line: string; lineSince: number; observed: number }>();
  read(rows: readonly SinceInput[], now: number): Map<string, SinceView> {
    const next = new Map<string, { state: AgentState; stateSince: number; line: string; lineSince: number; observed: number }>();
    const out = new Map<string, SinceView>();
    for (const r of rows) {
      const prev = this.seen.get(r.id);
      const line = `${r.effective_state}\n${r.activity ?? ""}`;
      const start = prev && r.observed <= prev.observed ? now : Math.min(r.observed, now);
      const s = {
        state: r.effective_state, line, observed: Math.max(r.observed, prev?.observed ?? 0),
        stateSince: prev && prev.state === r.effective_state ? prev.stateSince : start,
        lineSince: prev && prev.line === line ? prev.lineSince : start,
      };
      next.set(r.id, s);
      out.set(r.id, { state_since: s.stateSince, activity_since: s.lineSince });
    }
    this.seen = next;
    return out;
  }
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATES: AgentState[] = ["working", "idle", "waiting", "blocked", "offline"];
const LINES = [undefined, "", "Running a command", "Editing files"];

describe("AgentSince", () => {
  test("gives the one-pass version's answers on random roster histories, duplicate ids included", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const rand = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
      const now0 = 1_000_000;
      const ids = Array.from({ length: 40 }, (_, i) => `alex/mbp/a-${i}`);
      let rows: SinceInput[] = ids.map((id) => ({ id, effective_state: pick(STATES), activity: pick(LINES), observed: now0 - Math.floor(rand() * 5_000) }));
      const since = new AgentSince();
      const ref = new ReferenceSince();
      let now = now0;
      for (let step = 0; step < 120; step++) {
        now += Math.floor(rand() * 4_000);
        rows = rows
          // some agents report (a newer observation, maybe another state or line), some stay as they were
          .map((r) => (rand() < 0.2 ? { ...r, effective_state: pick(STATES), activity: pick(LINES), observed: Math.max(r.observed, now - Math.floor(rand() * 3_000)) } : r))
          // some are older than before (a state going stale: same observation, another state)
          .map((r) => (rand() < 0.05 ? { ...r, effective_state: pick(STATES) } : r))
          // some leave the roster, some come back, some are a second row under an id already there (two machines, one hostname)
          .filter(() => rand() > 0.03);
        if (rand() < 0.3) rows = [...rows, { id: pick(ids), effective_state: pick(STATES), activity: pick(LINES), observed: now - Math.floor(rand() * 2_000) }];
        if (rand() < 0.2) rows = [...rows, { id: `alex/mbp/new-${step}`, effective_state: pick(STATES), activity: pick(LINES), observed: now }];
        if (rand() < 0.1) rows = [...rows].sort(() => rand() - 0.5);
        const want = ref.read(rows, now);
        const got = since.read(rows, now);
        expect([...got.entries()]).toEqual([...want.entries()]);
      }
    }
  });

  test("a row that did not change gets the very object it got last time; a changed one gets a new one", () => {
    const since = new AgentSince();
    const rows: SinceInput[] = [
      { id: "a", effective_state: "working", activity: "Running a command", observed: 100 },
      { id: "b", effective_state: "idle", observed: 100 },
    ];
    const first = since.read(rows, 1_000);
    // The same status read again, and a newer observation of the same state and line: nothing about the starts moves.
    const again = since.read([rows[0] as SinceInput, { ...(rows[1] as SinceInput), observed: 500 }], 2_000);
    expect(again.get("a")).toBe(first.get("a"));
    expect(again.get("b")).toBe(first.get("b"));
    const moved = since.read([{ ...(rows[0] as SinceInput), activity: "Editing files" }, rows[1] as SinceInput], 3_000);
    expect(moved.get("a")).not.toBe(first.get("a"));
    expect(moved.get("a")).toEqual({ state_since: 100, activity_since: 3_000 }); // a new line with nothing newer behind it starts at now
    expect(moved.get("b")).toBe(first.get("b"));
  });

  test("an agent missing from a read is forgotten: it comes back as a new agent", () => {
    const since = new AgentSince();
    since.read([{ id: "a", effective_state: "working", observed: 500 }], 1_000);
    since.read([], 2_000);
    // Remembered, a change of state with nothing newer behind it would start at now (3 000); a forgotten agent starts at its observation.
    expect(since.read([{ id: "a", effective_state: "idle", observed: 500 }], 3_000).get("a")).toEqual({ state_since: 500, activity_since: 500 });
    // Not forgotten: the same change one read later does start at now.
    expect(since.read([{ id: "a", effective_state: "offline", observed: 500 }], 4_000).get("a")).toEqual({ state_since: 4_000, activity_since: 4_000 });
  });
});
