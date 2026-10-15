// Durable at-most-once Sqwakie dispatch metadata. Source-only: no transport is opened here.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { SeatControlIntent } from "../../protocol/seat-turn-control.ts";
import type { SeatControlIntent as SeatControlIntentT } from "../../protocol/seat-turn-control.ts";
import type { SeatControlOutcome } from "../../protocol/seat-turn-control.ts";
export interface DispatchKey { launch: string; boot_generation: string; seat_generation: string; control_id: string }
export type DispatchStatus = "admitted" | "duplicate" | "conflict" | "capacity" | "stale";
export interface DispatchResult { status: DispatchStatus; outcome?: SeatControlOutcome }
interface Row { digest: string; phase: string; outcome: SeatControlOutcome }
export function controlPayloadDigest(intent: SeatControlIntentT): string {
  return createHash("sha256").update(JSON.stringify(SeatControlIntent.parse(intent))).digest("hex");
}
const generation = /^[0-9a-f]{32}$/;
const launchId = /^[0-9a-f]{16}:[1-9][0-9]*$/;
const digestPattern = /^[0-9a-f]{64}$/;
function validate(key: DispatchKey, digest?: string): void {
  if (!launchId.test(key.launch) || !generation.test(key.boot_generation) || !generation.test(key.seat_generation) || !generation.test(key.control_id)
    || (digest !== undefined && !digestPattern.test(digest))) throw new TypeError("invalid turn dispatch metadata");
}
/** The caller owns authorization and serializes its state CAS before asking this ledger to dispatch. */
export class TurnDispatchLedger {
  private readonly db: Database;
  constructor(path: string, private readonly currentBoot: string) {
    if (!generation.test(currentBoot)) throw new TypeError("invalid boot generation");
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0");
    this.db.exec(`CREATE TABLE IF NOT EXISTS turn_dispatch (
      launch TEXT NOT NULL, boot TEXT NOT NULL, seat TEXT NOT NULL, control TEXT NOT NULL,
      digest TEXT NOT NULL, phase TEXT NOT NULL, outcome TEXT NOT NULL,
      PRIMARY KEY (launch, boot, seat, control)
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS turn_dispatch_seat_count ON turn_dispatch (launch, seat)");
    this.db.exec("CREATE TABLE IF NOT EXISTS turn_dispatch_meta (id INTEGER PRIMARY KEY CHECK (id = 1), active_boot TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS turn_dispatch_boots (boot TEXT PRIMARY KEY)");
    this.db.transaction(() => {
      const active = this.db.query("SELECT active_boot FROM turn_dispatch_meta WHERE id = 1").get() as { active_boot: string } | null;
      const seen = this.db.query("SELECT boot FROM turn_dispatch_boots WHERE boot = ?").get(currentBoot);
      if (seen && active?.active_boot !== currentBoot) throw new Error("stale turn control boot generation");
      if (!seen && (this.db.query("SELECT COUNT(*) AS n FROM turn_dispatch_boots").get() as { n: number }).n >= 4096) throw new Error("turn control boot ledger capacity");
      this.db.query("INSERT OR IGNORE INTO turn_dispatch_boots (boot) VALUES (?)").run(currentBoot);
      this.db.query("INSERT INTO turn_dispatch_meta (id, active_boot) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET active_boot = excluded.active_boot").run(currentBoot);
      // A new boot never resumes/adopts an old thread or retries even a received/not-sent intent.
      this.db.query("UPDATE turn_dispatch SET phase = 'unknown', outcome = 'unknown' WHERE boot != ? AND phase IN ('received', 'dispatching', 'accepted')").run(currentBoot);
    }).immediate();
  }
  close(): void { this.db.close(); }
  private active(): boolean { return (this.db.query("SELECT active_boot FROM turn_dispatch_meta WHERE id = 1").get() as { active_boot: string }).active_boot === this.currentBoot; }
  private row(key: DispatchKey): Row | null {
    return this.db.query("SELECT digest, phase, outcome FROM turn_dispatch WHERE launch = ? AND boot = ? AND seat = ? AND control = ?")
      .get(key.launch, key.boot_generation, key.seat_generation, key.control_id) as Row | null;
  }
  count(): number { return (this.db.query("SELECT COUNT(*) AS n FROM turn_dispatch").get() as { n: number }).n; }
  lookup(key: DispatchKey): { outcome: SeatControlOutcome; phase: string } | null {
    validate(key); const row = this.row(key); return row ? { outcome: row.phase === "dispatching" ? "unknown" : row.outcome, phase: row.phase } : null;
  }
  admit(key: DispatchKey, digest: string): DispatchResult {
    validate(key, digest);
    return this.db.transaction((): DispatchResult => {
      const old = this.row(key);
      if (old) return old.digest === digest ? { status: "duplicate", outcome: old.phase === "dispatching" ? "unknown" : old.outcome } : { status: "conflict" };
      if (key.boot_generation !== this.currentBoot || !this.active()) return { status: "stale" };
      const seatCount = (this.db.query("SELECT COUNT(*) AS n FROM turn_dispatch WHERE launch = ? AND seat = ?").get(key.launch, key.seat_generation) as { n: number }).n;
      if (seatCount >= 256 || this.count() >= 4096) return { status: "capacity" };
      this.db.query("INSERT INTO turn_dispatch (launch, boot, seat, control, digest, phase, outcome) VALUES (?, ?, ?, ?, ?, 'received', 'requested')")
        .run(key.launch, key.boot_generation, key.seat_generation, key.control_id, digest);
      return { status: "admitted", outcome: "requested" };
    }).immediate();
  }
  /** One fake or future adapter write. A durable marker is committed before invoking send. */
  async dispatchOnce(key: DispatchKey, digest: string, send: () => Promise<SeatControlOutcome>): Promise<DispatchResult> {
    const admission = this.admit(key, digest);
    if (admission.status !== "admitted") return admission;
    if (!this.markDispatching(key)) throw new Error("turn dispatch marker not durable");
    let outcome: SeatControlOutcome;
    try { outcome = await send(); } catch { outcome = "unknown"; }
    if (outcome === "requested" || !["runtime_accepted", "interrupted_observed", "completed_before_interrupt", "rejected", "unknown"].includes(outcome)) outcome = "unknown";
    try {
      if (!this.resolve(key, outcome)) outcome = "unknown";
    } catch { outcome = "unknown"; }
    if (outcome === "unknown") {
      try { this.markUnknown(key); } catch { /* dispatching marker remains durable and reads unknown */ }
    }
    return { status: "admitted", outcome };
  }
  /** This committed marker must be written before the first possible adapter write. */
  markDispatching(key: DispatchKey): boolean {
    validate(key);
    if (key.boot_generation !== this.currentBoot) return false;
    return this.db.query("UPDATE turn_dispatch SET phase = 'dispatching' WHERE launch = ? AND boot = ? AND seat = ? AND control = ? AND phase = 'received' AND EXISTS (SELECT 1 FROM turn_dispatch_meta WHERE id = 1 AND active_boot = ?)")
      .run(key.launch, key.boot_generation, key.seat_generation, key.control_id, this.currentBoot).changes === 1;
  }
  resolve(key: DispatchKey, outcome: SeatControlOutcome): boolean {
    validate(key);
    if (key.boot_generation !== this.currentBoot || outcome === "requested" || !["runtime_accepted", "interrupted_observed", "completed_before_interrupt", "rejected", "unknown"].includes(outcome)) return false;
    const phase = outcome === "runtime_accepted" ? "accepted" : "final";
    return this.db.query(`UPDATE turn_dispatch SET phase = ?, outcome = ? WHERE launch = ? AND boot = ? AND seat = ? AND control = ?
      AND (phase = 'dispatching' OR (phase = 'accepted' AND ? != 'runtime_accepted'))
      AND EXISTS (SELECT 1 FROM turn_dispatch_meta WHERE id = 1 AND active_boot = ?)`)
      .run(phase, outcome, key.launch, key.boot_generation, key.seat_generation, key.control_id, outcome, this.currentBoot).changes === 1;
  }
  /** Best effort after ambiguous send or result-persistence failure; a failed write remains uncertain on disk. */
  markUnknown(key: DispatchKey): boolean { return this.resolve(key, "unknown"); }
}
