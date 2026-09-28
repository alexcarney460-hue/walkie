// WALKIE-LIVE-2: what a restarted daemon accepts from the saved sessions.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DashboardSessions, SESSION_IDLE_MS, SESSION_MAX_MS, SESSION_PERSIST_EVERY_MS } from "../../src/daemon/dashboard-sessions.ts";

const HOST = "127.0.0.1:7457";
const box = () => { let v: string | null = null; return { load: () => v, save: (x: string | null) => { v = x; }, get: () => v }; };

test("restored: live sessions only; expired, idle-expired, over-long and malformed entries are dropped", () => {
  let now = 1_000_000;
  const p = box();
  const a = new DashboardSessions({ now: () => now, persist: p });
  const keep = a.create(HOST);
  const idle = a.create(HOST);
  now += SESSION_IDLE_MS - 10_000;
  a.check(keep, HOST); // saved lastSeen moves (older than SESSION_PERSIST_EVERY_MS)
  a.close();
  const saved = JSON.parse(p.get() as string) as { g: string; s: { h: string; host: string; c: number; e: number; l: number }[] };
  const forged = [...saved.s, { h: "zz", host: HOST, c: now, e: now + 1, l: now }, { h: "a".repeat(64), host: HOST, c: now, e: now + SESSION_MAX_MS * 2, l: now }];
  p.save(JSON.stringify({ g: saved.g, s: forged }));
  now += 20_000; // `idle` is now past 12 h without use
  const b = new DashboardSessions({ now: () => now, persist: p });
  expect(b.check(keep, HOST)).not.toBeNull();
  expect(b.check(idle, HOST)).toBeNull();
  expect(b.size).toBe(1);
  expect(p.get()).not.toContain(keep);
  expect(p.get()).toContain(createHash("sha256").update(keep).digest("hex"));
  now += SESSION_MAX_MS;
  const c = new DashboardSessions({ now: () => now, persist: p });
  expect(c.check(keep, HOST)).toBeNull(); // the 7-day cap holds across restarts
  expect(new DashboardSessions({ now: () => now, persist: { load: () => "{not json", save: () => {} } }).size).toBe(0);
});

test("lastSeen is written at most once a minute, and revocation clears the saved copy", () => {
  let now = 0;
  let writes = 0;
  let v: string | null = null;
  const s = new DashboardSessions({ now: () => now, persist: { load: () => v, save: (x) => { writes++; v = x; } } });
  const val = s.create(HOST);
  const base = writes;
  for (let i = 0; i < 100; i++) { now += 100; s.check(val, HOST); }
  expect(writes - base).toBe(0);
  now += SESSION_PERSIST_EVERY_MS;
  s.check(val, HOST);
  expect(writes - base).toBe(1);
  s.revokeAll();
  expect(v).toBeNull();
});
