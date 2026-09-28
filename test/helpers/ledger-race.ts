// One of two (or more) real helper processes racing for seat user ids (test/unit/seats-fix6.test.ts): the REAL create
// logic (admin.ts) over the fake system, sharing one test root and so one ledger (admin-ledger.ts). Prints which ids
// it made, which it was told were used, and anything else.
import { join } from "node:path";
import { createSeatUser } from "../../src/daemon/seats/admin.ts";
import { fakeSeatWorld } from "./fake-seat-users.ts";

const [root, count] = process.argv.slice(2);
const w = fakeSeatWorld(root as string, join(root as string, "walkie-home"));
const made: number[] = [];
const used: number[] = [];
const other: Array<{ n: number; why?: string }> = [];
for (let n = 1; n <= Number(count); n++) {
  const r = await createSeatUser(n, w.sys);
  if (r.ok) made.push(n);
  else if (r.code === "used") used.push(n);
  else other.push({ n, why: r.why });
}
process.stdout.write(`${JSON.stringify({ made, used, other })}\n`);
