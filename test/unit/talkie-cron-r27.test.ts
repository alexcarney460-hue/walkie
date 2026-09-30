import { expect, test } from "bun:test";
import { Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { SCHEDULE_CHANNEL, type Schedule } from "../../src/protocol/talkie-schedule.ts";
import type { Core } from "../../src/daemon/core.ts";

const KEY = "schedule_completion_unresolved";
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const run = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;

function fixture() {
  const schedule: Schedule = { id: ID, name: "Hourly Check", cron: "*/5 * * * *", task: { prompt: "Check" },
    enabled: true, created_by: "alex", last_run: 1, next_run: 300_000, last_result: null, failures: 0, run_id: run(0) };
  const rows: { id: string; origin: string; seq: number; ts: number; json: string }[] = [];
  const meta = new Map<string, string>();
  const notes: string[] = [];
  let wall = 3_600_000;
  let authority = false;
  let failCompletion = false;
  let failNote = false;
  const channels = new Map<string, object>([[SCHEDULE_CHANNEL, {}], ["general", {}]]);
  const change = (op: object) => {
    const seq = rows.length + 1;
    rows.push({ id: String(seq).padStart(8, "0"), origin: "owner", seq, ts: seq,
      json: JSON.stringify({ body: { text: `walkie-talkie-schedule:v1:${JSON.stringify(op)}` } }) });
  };
  const put = (n: number) => change({ op: "put", rev: rows.length, schedule: { ...schedule, run_id: run(n), last_run: n + 1 } });
  put(0);
  const core = { clock: () => wall, isAuthority: () => authority, me: () => ({ role: "owner" }), roster: { channels },
    store: { getMeta: (key: string) => meta.get(key) ?? null, setMeta: (key: string, value: string) => { meta.set(key, value); },
      transaction: (fn: () => void) => fn(), channelEventCount: () => rows.length,
      queryEvents: ({ since_ts }: { since_ts?: number }) => rows.filter((row) => since_ts === undefined || row.ts > since_ts)
        .reverse() },
    emit: (_kind: string, body: { text: string }, opts: { channel: string }) => {
      if (failCompletion && body.text.includes('"completion_run"')) throw new Error("completion write failed");
      if (failNote && opts.channel === "general") throw new Error("general post failed");
      if (opts.channel === "general") notes.push(body.text);
      return { id: `note:${notes.length}` };
    }, log: { warn: () => {} },
  } as unknown as Core;
  const schedules = new Schedules(core, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} });
  return { core, schedules, meta, notes, channels, put, change,
    remove: () => change({ op: "remove", id: ID, rev: rows.length }),
    setWall: (at: number) => { wall = at; }, setCompletionFailure: (value: boolean) => { failCompletion = value; },
    setNoteFailure: (value: boolean) => { failNote = value; }, setAuthority: (value: boolean) => { authority = value; }, schedule };
}

test("same-schedule supersessions coalesce 150 failures into at most two hourly notes; removal still posts", () => {
  const f = fixture();
  for (let n = 1; n <= 150; n++) {
    f.meta.set(KEY, JSON.stringify([{ id: ID, name: f.schedule.name, run: run(n - 1), slot: n }]));
    f.put(n);
    f.schedules.status();
  }
  expect(f.notes.length).toBeLessThanOrEqual(2);
  expect(f.notes[0]).toContain(f.schedule.name);
  f.setWall(7_200_000);
  f.meta.set(KEY, JSON.stringify([{ id: ID, name: f.schedule.name, run: run(150), slot: 151 }]));
  f.put(151);
  f.schedules.status();
  expect(f.notes.length).toBe(2);
  expect(f.notes[1]).toMatch(/15[01] unresolved completions/);
  f.meta.set(KEY, JSON.stringify([{ id: ID, name: f.schedule.name, run: run(151), slot: 152 }]));
  f.remove();
  f.schedules.status();
  expect(f.notes.length).toBe(3);
  expect(f.notes[2]).toContain("removed");
  expect(JSON.parse(f.meta.get("schedule_completion_supersession_notes") ?? "{}")).toEqual({});
});

test("pending supersessions post when general returns with no unresolved entries", () => {
  const f = fixture();
  f.channels.delete("general");
  f.meta.set(KEY, JSON.stringify([{ id: ID, name: f.schedule.name, run: run(0), slot: 1 }]));
  f.put(1);
  f.schedules.status();
  expect(JSON.parse(f.meta.get(KEY) ?? "[]")).toEqual([]);
  expect(f.notes).toHaveLength(0);
  f.channels.set("general", {});
  f.setNoteFailure(true);
  f.schedules.status();
  expect(JSON.parse(f.meta.get("schedule_completion_supersession_notes") ?? "{}")[ID].pending).toBe(1);
  f.setNoteFailure(false);
  f.schedules.status();
  expect(f.notes).toHaveLength(1);
  expect(f.notes[0]).toContain("1 unresolved completion");
});

test("pending supersessions post in a quiet hour and fold into a removal note", () => {
  const f = fixture();
  f.meta.set(KEY, JSON.stringify([{ id: ID, name: f.schedule.name, run: run(0), slot: 1 }]));
  f.put(1);
  f.schedules.status();
  f.meta.set(KEY, JSON.stringify([{ id: ID, name: f.schedule.name, run: run(1), slot: 2 }]));
  f.put(2);
  f.schedules.status();
  expect(f.notes).toHaveLength(1);
  f.setWall(7_200_000);
  f.schedules.status();
  expect(f.notes).toHaveLength(2);
  expect(f.notes[1]).toContain("1 unresolved completion");

  f.meta.set(KEY, JSON.stringify([{ id: ID, name: f.schedule.name, run: run(2), slot: 3 }]));
  f.put(3);
  f.schedules.status();
  f.remove();
  f.schedules.status();
  expect(f.notes).toHaveLength(3);
  expect(f.notes[2]).toContain("removed");
  expect(f.notes[2]).toContain("1 unresolved completion");
  expect(JSON.parse(f.meta.get("schedule_completion_supersession_notes") ?? "{}")).toEqual({});
});

test("paging an old reconciled entry preserves another schedule's active completion retry status", async () => {
  const f = fixture();
  const other = { ...f.schedule, id: OTHER_ID, name: "Other Job", run_id: run(900) };
  f.change({ op: "put", schedule: other });
  f.meta.set(KEY, JSON.stringify([{ id: ID, name: f.schedule.name, run: run(0), slot: 1 }]));
  f.put(1);
  f.setAuthority(true);
  f.setCompletionFailure(true);
  const active = { run: run(900), turn: "turn", started: 3_600_000 };
  type ActiveRun = typeof active;
  const internals = f.schedules as unknown as { active: Map<string, ActiveRun>;
    complete: (schedule: Schedule, pending: ActiveRun, reply: { text: string; ok: boolean }, now: number) => Promise<void> };
  internals.active.set(OTHER_ID, active);
  await internals.complete(other, active, { text: "done", ok: true }, 3_600_000);
  expect(f.schedules.unresolvedPage().total).toBe(0);
  expect(f.schedules.status()).toContain("schedule completion write failed");
  internals.active.set(OTHER_ID, { run: run(901), turn: "next", started: 3_600_000 });
  expect(f.schedules.status()).toBeNull();
});

test("recovering one completion leaves another schedule's retry failure visible", async () => {
  const f = fixture();
  const other = { ...f.schedule, id: OTHER_ID, name: "Other Job", run_id: run(900) };
  f.change({ op: "put", schedule: other });
  f.setAuthority(true);
  f.setCompletionFailure(true);
  type ActiveRun = { run: string; turn: string; started: number; completion?: { nextAttemptAt: number } };
  const internals = f.schedules as unknown as { active: Map<string, ActiveRun>;
    complete: (schedule: Schedule, pending: ActiveRun, reply: { text: string; ok: boolean }, now: number) => Promise<void> };
  const first: ActiveRun = { run: run(0), turn: "first", started: 3_600_000 };
  const second: ActiveRun = { run: run(900), turn: "second", started: 3_600_000 };
  internals.active.set(ID, first);
  internals.active.set(OTHER_ID, second);
  await internals.complete(f.schedule, first, { text: "first done", ok: true }, 3_600_000);
  await internals.complete(other, second, { text: "second done", ok: true }, 3_600_000);
  expect(f.schedules.status()).toContain("schedule completion write failed");
  f.setCompletionFailure(false);
  second.completion!.nextAttemptAt = 0;
  await internals.complete(other, second, { text: "second done", ok: true }, 3_600_000);
  expect(f.schedules.status()).toContain("schedule completion write failed");
});

test("removed entry remains durable until its general note posts", () => {
  const f = fixture();
  f.meta.set(KEY, JSON.stringify([{ id: ID, name: f.schedule.name, run: run(0), slot: 1 }]));
  f.remove();
  f.channels.delete("general");
  f.schedules.status();
  expect(JSON.parse(f.meta.get(KEY) ?? "[]")).toHaveLength(1);
  expect(f.notes).toHaveLength(0);
  f.channels.set("general", {});
  f.setNoteFailure(true);
  f.schedules.status();
  expect(JSON.parse(f.meta.get(KEY) ?? "[]")).toHaveLength(1);
  expect(f.notes).toHaveLength(0);
  f.setNoteFailure(false);
  f.schedules.status();
  f.schedules.status();
  expect(JSON.parse(f.meta.get(KEY) ?? "[]")).toHaveLength(0);
  expect(f.notes).toHaveLength(1);
  expect(f.notes[0]).toContain("removed");
});

test("cursor rejects malformed UUIDs and claim fields while allowing a resolved row", () => {
  const f = fixture();
  const entries = [1, 2].map((seq) => ({ id: ID, name: f.schedule.name, run: run(0),
    claim: { term: 0, seq, generation: 0 } }));
  f.meta.set(KEY, JSON.stringify(entries));
  const cursor = f.schedules.unresolvedPage(undefined, 1).next_cursor!;
  f.meta.set(KEY, JSON.stringify([entries[1]!]));
  expect(f.schedules.unresolvedPage(cursor, 1).entries).toEqual([entries[1]!]);
  for (const invalid of [
    `${"-".repeat(36)}|${run(0)}|c:0:1:0`,
    `${ID}|${"-".repeat(36)}|c:0:1:0`,
    `${ID}|${run(0)}|c:0:0:0`,
    `${ID}|${run(0)}|c:0:9007199254740992:0`,
    `${ID}|${run(0)}|c:01:1:0`,
    `${ID}|${run(0)}|l:${"-".repeat(36)}`,
  ]) expect(() => f.schedules.unresolvedPage(invalid)).toThrow();
});

test("uppercase stored UUIDs emit reusable lowercase cursors and accept uppercase input", () => {
  const f = fixture();
  const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  const upperRun = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
  f.change({ op: "put", schedule: { ...f.schedule, id, run_id: upperRun } });
  const entries = [1, 2].map((seq) => ({ id, name: "Uppercase", run: upperRun,
    claim: { term: 0, seq, generation: 0 } }));
  f.meta.set(KEY, JSON.stringify(entries));
  const first = f.schedules.unresolvedPage(undefined, 1);
  expect(first.next_cursor).toBe(first.next_cursor!.toLowerCase());
  expect(f.schedules.unresolvedPage(first.next_cursor!, 1).entries).toEqual([entries[1]!]);
  const [cursorId, cursorRun, claim] = first.next_cursor!.split("|");
  expect(f.schedules.unresolvedPage(`${cursorId!.toUpperCase()}|${cursorRun!.toUpperCase()}|${claim}`, 1).entries)
    .toEqual([entries[1]!]);

  const secondId = "EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE";
  f.change({ op: "put", schedule: { ...f.schedule, id: secondId, run_id: upperRun } });
  const localEntries = [
    { id, name: "Uppercase", run: upperRun, local_id: "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC" },
    { id: secondId, name: "Uppercase Two", run: upperRun, local_id: "DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD" },
  ];
  f.meta.set(KEY, JSON.stringify(localEntries));
  const localCursor = f.schedules.unresolvedPage(undefined, 1).next_cursor!;
  expect(localCursor).toBe(localCursor.toLowerCase());
  expect(f.schedules.unresolvedPage(localCursor, 1).entries).toEqual([localEntries[1]!]);
  const [localId, localRun, identity] = localCursor.split("|");
  expect(f.schedules.unresolvedPage(`${localId!.toUpperCase()}|${localRun!.toUpperCase()}|l:${identity!.slice(2).toUpperCase()}`, 1).entries)
    .toEqual([localEntries[1]!]);
});
