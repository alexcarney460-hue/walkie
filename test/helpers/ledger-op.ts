// One helper-like process holding a seat user id in the REAL ledger (admin-ledger.ts) for test/unit/seats-fix7.test.ts:
//   create <db> <n> <ms>  reserves n as a create, holds it `ms`, then makes it (reserved → making → created)
//   destroy <db> <n>      takes n for a destroy (waiting while another live operation holds it), then finishes it
// Prints one JSON line of what it saw and when.
import { Ledger, selfOp } from "../../src/daemon/seats/admin-ledger.ts";

const [mode, db, nArg, msArg] = process.argv.slice(2);
const n = Number(nArg);
const ledger = new Ledger(db as string);
const op = selfOp();
const owner = process.getuid?.() ?? -1;
if (mode === "create") {
  const r = ledger.reserve(n, owner, op);
  const reservedAt = Date.now();
  await Bun.sleep(Number(msArg));
  const advanced = r.ok && ledger.advance(n, op, "reserved", "making");
  if (advanced) ledger.finish(n, op, "created");
  process.stdout.write(`${JSON.stringify({ reserved: r.ok, reservedAt, advanced, doneAt: Date.now() })}\n`);
} else {
  const started = Date.now();
  let t = ledger.takeForDestroy(n, owner, op);
  while (!t.ok && t.busy) { await Bun.sleep(50); t = ledger.takeForDestroy(n, owner, op); }
  const takenAt = Date.now();
  if (t.ok && t.state !== "cancelled") ledger.finish(n, op, "destroyed");
  process.stdout.write(`${JSON.stringify({ started, takenAt, saw: t.ok ? t.state : null, final: ledger.state(n) })}\n`);
}
ledger.close();
