// WALKIE-SEC-COOKIE-1 (ALE-5248): dashboard session lifetime rules.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DashboardSessions, SESSION_IDLE_MS, SESSION_MAX_MS } from "../../src/daemon/dashboard-sessions.ts";

const HOST = "127.0.0.1:7457";
const H = 3_600_000;

describe("dashboard session store", () => {
  test("values are 256-bit hex, stored only as a hash", () => {
    const s = new DashboardSessions({ now: () => 0 });
    const v = s.create(HOST);
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    const stored = s.storedKeys();
    expect(stored).not.toContain(v);
    expect(stored).toContain(createHash("sha256").update(v).digest("hex"));
    expect(s.check(v, HOST)).not.toBeNull();
    expect(s.check("0".repeat(64), HOST)).toBeNull();
    expect(s.check(v, "localhost:7457")).toBeNull(); // bound to the Host it was issued for
  });

  test("12 h idle expiry, sliding on use", () => {
    let now = 0;
    const s = new DashboardSessions({ now: () => now });
    const v = s.create(HOST);
    expect(SESSION_IDLE_MS).toBe(12 * H);
    now = 11 * H;
    expect(s.check(v, HOST)).not.toBeNull(); // slides the window
    now = 22 * H;
    expect(s.check(v, HOST)).not.toBeNull();
    now = 22 * H + SESSION_IDLE_MS + 1;
    expect(s.check(v, HOST)).toBeNull();
    expect(s.size).toBe(0);
  });

  test("an open stream keeps the session alive; the absolute cap ends it and aborts the stream", () => {
    let now = 0;
    const s = new DashboardSessions({ now: () => now });
    const v = s.create(HOST);
    const sess = s.check(v, HOST);
    expect(sess).not.toBeNull();
    const release = s.openStream(sess!);
    now = 13 * H;
    s.sweep();
    expect(s.check(v, HOST)).not.toBeNull(); // idle rule doesn't apply while a stream is open
    now = SESSION_MAX_MS + 1;
    s.sweep();
    expect(sess!.signal.aborted).toBe(true);
    expect(s.check(v, HOST)).toBeNull();
    release();
  });

  test("revoke one, revoke all (aborting their signals), and a bounded store", () => {
    const s = new DashboardSessions({ now: () => 0, max: 4 });
    const a = s.create(HOST);
    const sa = s.check(a, HOST)!;
    expect(s.revoke(a)).toBe(true);
    expect(sa.signal.aborted).toBe(true);
    expect(s.check(a, HOST)).toBeNull();
    const vs = [s.create(HOST), s.create(HOST), s.create(HOST), s.create(HOST), s.create(HOST)];
    expect(s.size).toBe(4);
    expect(s.check(vs[0] as string, HOST)).toBeNull(); // oldest evicted
    expect(s.revokeAll()).toBe(4);
    expect(s.size).toBe(0);
  });
});
