// WALK-83 schedules: supersession notes are posted by the scheduler's tick (not only when someone reads the schedules), and the
// owner can acknowledge the legacy count-only overflow. Same mock Core as talkie-cron-r27.test.ts.
import { expect, test } from "bun:test";
import { Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { SCHEDULE_CHANNEL, type Schedule } from "../../src/protocol/talkie-schedule.ts";
import { HttpError } from "../../src/daemon/http.ts";
import type { Core } from "../../src/daemon/core.ts";

const KEY = "schedule_completion_unresolved";
const NOTES = "schedule_completion_supersession_notes";
const OVERFLOW = "schedule_completion_unresolved_overflow";
const ID = "11111111-1111-4111-8111-111111111111";
const run = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const HOUR = 3_600_000;

function fixture(opts: { lease?: boolean; role?: "owner" | "member" | null } = {}) {
  const schedule: Schedule = { id: ID, name: "Hourly Check", cron: "*/5 * * * *", task: { prompt: "Check" },
    enabled: true, created_by: "alex", last_run: 1, next_run: 300_000, last_result: null, failures: 0, run_id: run(0) };
  const rows: { id: string; origin: string; seq: number; ts: number; json: string }[] = [];
  const meta = new Map<string, string>();
  const notes: string[] = [];
  const warnings: string[] = [];
  let wall = HOUR;
  let role: "owner" | "member" | null = opts.role === undefined ? "owner" : opts.role;
  const channels = new Map<string, object>([[SCHEDULE_CHANNEL, {}], ["general", {}]]);
  const put = (n: number) => {
    const seq = rows.length + 1;
    rows.push({ id: String(seq).padStart(8, "0"), origin: "owner", seq, ts: seq, json: JSON.stringify({ body: { text:
      `walkie-talkie-schedule:v1:${JSON.stringify({ op: "put", rev: rows.length, schedule: { ...schedule, run_id: run(n), last_run: n + 1 } })}` } }) });
  };
  put(0);
  const core = { clock: () => wall, isAuthority: () => false, me: () => (role ? { role } : null), myHandle: () => (role ? "alex" : null), roster: { channels },
    store: { getMeta: (key: string) => meta.get(key) ?? null, setMeta: (key: string, value: string) => { meta.set(key, value); },
      deleteMeta: (key: string) => { meta.delete(key); },
      transaction: (fn: () => void) => fn(), channelEventCount: () => rows.length,
      queryEvents: ({ since_ts }: { since_ts?: number }) => rows.filter((row) => since_ts === undefined || row.ts > since_ts).reverse() },
    emit: (_kind: string, body: { text: string }, opts: { channel: string }) => {
      if (opts.channel === "general") notes.push(body.text);
      return { id: `note:${notes.length}` };
    }, log: { warn: (message: string) => { warnings.push(message); } },
  } as unknown as Core;
  const schedules = new Schedules(core, { valid: () => opts.lease !== false, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} });
  return { schedules, meta, notes, warnings, channels, put, schedule,
    setWall: (at: number) => { wall = at; }, setRole: (value: typeof role) => { role = value; },
    pend: (n: number) => { meta.set(KEY, JSON.stringify([{ id: ID, name: schedule.name, run: run(n - 1), slot: n }])); put(n); } };
}

test("a machine without the lease posts a supersession note once #general returns, without anyone reading schedules", async () => {
  const f = fixture({ lease: false });
  f.channels.delete("general");
  f.pend(1);
  f.schedules.status(); // an owner read folds the entry into a pending note while #general is missing
  expect(JSON.parse(f.meta.get(NOTES) ?? "{}")[ID].pending).toBe(1);
  expect(f.notes).toHaveLength(0);
  f.channels.set("general", {});
  await f.schedules.tick(HOUR);
  expect(f.notes).toHaveLength(1);
  expect(f.notes[0]).toContain("1 unresolved completion");
  expect(JSON.parse(f.meta.get(NOTES) ?? "{}")[ID].pending).toBe(0);
});

test("a note held for its hour is posted by the first tick after the hour", async () => {
  const f = fixture();
  f.pend(1);
  f.schedules.status();
  expect(f.notes).toHaveLength(1);
  f.pend(2);
  f.schedules.status(); // inside the hour: held
  expect(f.notes).toHaveLength(1);
  expect(JSON.parse(f.meta.get(NOTES) ?? "{}")[ID].pending).toBe(1);
  f.setWall(HOUR + 30 * 60_000);
  await f.schedules.tick(HOUR + 30 * 60_000);
  expect(f.notes).toHaveLength(1); // not due yet
  f.setWall(2 * HOUR);
  await f.schedules.tick(2 * HOUR);
  expect(f.notes).toHaveLength(2);
  expect(f.notes[1]).toContain("1 unresolved completion");
  await f.schedules.tick(2 * HOUR + 15_000);
  expect(f.notes).toHaveLength(2); // nothing pending: no further posts
});

test("a tick with nothing pending posts nothing and raises no warning", async () => {
  const f = fixture({ lease: false });
  await f.schedules.tick(HOUR);
  expect(f.notes).toHaveLength(0);
  expect(f.warnings).toEqual([]);
});

test("a machine that is not an admitted member leaves its pending notes alone and does not complain", async () => {
  const f = fixture({ lease: false, role: null });
  f.setRole("owner");
  f.pend(1);
  f.schedules.status();
  f.pend(2);
  f.schedules.status();
  f.setRole(null);
  f.setWall(2 * HOUR);
  await f.schedules.tick(2 * HOUR);
  expect(f.notes).toHaveLength(1);
  expect(f.warnings).toEqual([]);
  expect(JSON.parse(f.meta.get(NOTES) ?? "{}")[ID].pending).toBe(1);
});

test("an owner acknowledges the legacy count-only overflow; it clears the count and nothing else", () => {
  const f = fixture();
  f.meta.set(OVERFLOW, "3");
  expect(f.schedules.status()).toContain("3 older schedule completion outcomes remain unresolved");
  expect(f.schedules.status()).toContain("--ack-legacy");
  expect(f.schedules.acknowledgeLegacyOverflow()).toEqual({ cleared: 3 });
  expect(f.meta.has(OVERFLOW)).toBe(false);
  expect(f.schedules.status()).toBeNull();
  expect(f.schedules.acknowledgeLegacyOverflow()).toEqual({ cleared: 0 });

  const retained = [{ id: ID, name: f.schedule.name, run: run(0), claim: { term: 0, seq: 1, generation: 0 } }];
  f.meta.set(KEY, JSON.stringify(retained));
  f.meta.set(OVERFLOW, "garbled"); // a value that cannot be read still counts as one outcome to review
  expect(f.schedules.acknowledgeLegacyOverflow()).toEqual({ cleared: 1 });
  expect(JSON.parse(f.meta.get(KEY) ?? "[]")).toEqual(retained);
});

test("only an owner can acknowledge the legacy overflow", () => {
  const f = fixture({ role: "member" });
  f.meta.set(OVERFLOW, "2");
  expect(() => f.schedules.acknowledgeLegacyOverflow()).toThrow(HttpError);
  expect(f.meta.get(OVERFLOW)).toBe("2");
});
