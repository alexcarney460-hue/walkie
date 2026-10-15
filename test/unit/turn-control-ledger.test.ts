import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnDispatchLedger, type DispatchKey } from "../../src/daemon/seats/turn-control-ledger.ts";
const dirs: string[] = []; afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const path = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "ledger-"))); dirs.push(dir); return join(dir, "controls.sqlite"); };
const boot = "a".repeat(32), seat = "b".repeat(32);
const key = (i: number, launch = `${"c".repeat(16)}:1`, s = seat): DispatchKey => ({ launch, boot_generation: boot, seat_generation: s, control_id: i.toString(16).padStart(32, "0") });
test("capacity checks use an indexed seat count and a durable WAL", () => {
  const file = path(); const ledger = new TurnDispatchLedger(file, boot);
  const db = new Database(file);
  expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  const plan = db.query("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM turn_dispatch WHERE launch = ? AND seat = ?")
    .all(`${"c".repeat(16)}:1`, seat) as { detail: string }[];
  expect(plan.some((step) => step.detail.includes("USING COVERING INDEX"))).toBe(true);
  db.close(); ledger.close();
});
test("durable admission and dispatch marker prevent replay across crash, dedupe and digest conflict", () => {
  const file = path(); let db = new TurnDispatchLedger(file, boot);
  expect(db.admit(key(1), "d".repeat(64))).toEqual({ status: "admitted", outcome: "requested" });
  expect(db.admit(key(1), "d".repeat(64))).toEqual({ status: "duplicate", outcome: "requested" });
  expect(db.admit(key(1), "e".repeat(64)).status).toBe("conflict");
  expect(db.markDispatching(key(1))).toBe(true);
  db.close(); db = new TurnDispatchLedger(file, "f".repeat(32));
  expect(db.lookup(key(1))?.outcome).toBe("unknown");
  expect(db.admit(key(1), "d".repeat(64))).toEqual({ status: "duplicate", outcome: "unknown" });
  expect(db.markDispatching(key(1))).toBe(false);
  db.close();
  expect(readFileSync(file).includes(Buffer.from("continue this private prompt"))).toBe(false);
});
test("received and ACK-only outcomes become unknown on a new boot; observed outcomes persist", () => {
  const file = path(); let db = new TurnDispatchLedger(file, boot);
  db.admit(key(1), "d".repeat(64)); db.admit(key(2), "e".repeat(64));
  db.markDispatching(key(2)); expect(db.resolve(key(2), "runtime_accepted")).toBe(true);
  db.admit(key(3), "f".repeat(64)); db.markDispatching(key(3)); db.resolve(key(3), "interrupted_observed");
  db.close(); db = new TurnDispatchLedger(file, "f".repeat(32));
  expect(db.lookup(key(1))?.outcome).toBe("unknown");
  expect(db.lookup(key(2))?.outcome).toBe("unknown");
  expect(db.lookup(key(3))?.outcome).toBe("interrupted_observed");
  expect(db.resolve(key(2), "interrupted_observed")).toBe(false);
  db.close();
});
test("two ledger instances share exact 256 per-seat and 4096 per-host tombstone bounds", () => {
  const file = path(); const a = new TurnDispatchLedger(file, boot), b = new TurnDispatchLedger(file, boot);
  for (let i = 0; i < 256; i++) expect((i % 2 ? a : b).admit(key(i, `${"c".repeat(16)}:1`), "d".repeat(64)).status).toBe("admitted");
  expect(a.admit(key(256), "d".repeat(64)).status).toBe("capacity");
  for (let n = 2; n <= 16; n++) for (let i = 0; i < 256; i++) expect(a.admit(key(i, `${"c".repeat(16)}:${n}`, n.toString(16).padStart(32, "0")), "d".repeat(64)).status).toBe("admitted");
  expect(b.admit(key(999, `${"c".repeat(16)}:17`, "f".repeat(32)), "d".repeat(64)).status).toBe("capacity");
  expect(a.count()).toBe(4096); a.close(); b.close();
}, 30_000);
test("fake write sees a durable marker; lost response and duplicate never issue a second write", async () => {
  const file = path(); const db = new TurnDispatchLedger(file, boot);
  let writes = 0;
  const first = await db.dispatchOnce(key(88), "d".repeat(64), async () => {
    writes++;
    const observer = new TurnDispatchLedger(file, boot);
    expect(observer.lookup(key(88))?.phase).toBe("dispatching"); observer.close();
    throw new Error("lost response");
  });
  expect(first).toEqual({ status: "admitted", outcome: "unknown" });
  const again = await db.dispatchOnce(key(88), "d".repeat(64), async () => { writes++; return "runtime_accepted"; });
  expect(again).toEqual({ status: "duplicate", outcome: "unknown" });
  expect(writes).toBe(1);
  db.close();
});

test("new boot fences a retained old ledger instance before it can mark another write", () => {
  const file = path(); const old = new TurnDispatchLedger(file, boot);
  old.admit(key(100), "d".repeat(64));
  const next = new TurnDispatchLedger(file, "f".repeat(32));
  expect(old.markDispatching(key(100))).toBe(false);
  expect(old.admit(key(101), "d".repeat(64)).status).toBe("stale");
  expect(next.lookup(key(100))?.outcome).toBe("unknown");
  old.close(); next.close();
  expect(() => new TurnDispatchLedger(file, boot)).toThrow("stale turn control boot generation");
});
