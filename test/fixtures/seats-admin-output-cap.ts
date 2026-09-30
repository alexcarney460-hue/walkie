// Exercise the root helper's real output path without creating users or touching host state.
import { runSeatAdmin, type AdminSys } from "../../src/daemon/seats/admin.ts";
import { writeSync } from "node:fs";

const cap = 256 * 1024;
const allIds = Array.from({ length: 50_000 }, (_, i) => i + 1);
let low = 0;
let high = allIds.length;
while (low < high) {
  const mid = Math.ceil((low + high) / 2);
  const bytes = Buffer.byteLength(`${JSON.stringify({ ok: true, ids: allIds.slice(0, mid) })}\n`);
  if (bytes <= cap) low = mid;
  else high = mid - 1;
}
const ids = allIds.slice(0, low);
process.getuid = () => 0; // Only this disposable child; no sudo and no OS-user mutation.
// Model a runtime that accepts part of an asynchronous stdout.write and queues the rest.
// The immediate process.exit below must not depend on that queued callback running.
process.stdout.write = ((data: string | Uint8Array) => {
  const bytes = Buffer.from(data);
  writeSync(1, bytes.subarray(0, 32 * 1024));
  setTimeout(() => writeSync(1, bytes.subarray(32 * 1024)), 20);
  return false;
}) as typeof process.stdout.write;
// `pending` reads the ledger read-only (seat round 20); the mutating ledger() must not be needed for it.
const sys = { caller: () => 1, pendingReadOnly: () => ({ ids, summary: { homes: 0, vaults: 0, knownBytes: 0 } }), procs: () => [] } as unknown as AdminSys;
process.exit(await runSeatAdmin(["pending"], sys));
