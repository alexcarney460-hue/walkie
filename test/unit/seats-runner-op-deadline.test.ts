import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSeatUser, destroySeatUser } from "../../src/daemon/seats/admin.ts";
import { runnerOp } from "../../src/daemon/seats/runner-child.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fakeRunner = () => [process.execPath, join(import.meta.dir, "../fixtures/seats-runner-open-pipe.ts")];

test("runner operation abandons a surviving process and open stdout at its deadline", async () => {
  const began = Date.now();
  const result = await runnerOp(fakeRunner(), "sweep", 40);
  expect(Date.now() - began).toBeLessThan(180);
  expect(result).toMatchObject({ verified: false, why: "runner did not exit" });
});

test("an unanswered runner sweep releases the destroy claim for retry", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".runner-op-deadline-"));
  dirs.push(dir);
  const world = fakeSeatWorld(dir, join(dir, "walkie-home"));
  expect((await createSeatUser(1, world.sys)).ok).toBe(true);
  world.sys.sweepAsUser = async (_name, _uid, _roots, _residue, timeoutMs) => {
    const result = await runnerOp(fakeRunner(), "sweep", Math.min(40, timeoutMs ?? 40));
    return { ok: result?.verified === true, left: [result?.why ?? "no answer"] };
  };
  const result = await destroySeatUser(1, world.sys, 500);
  expect(result).toMatchObject({ ok: false });
  expect(result.why).toContain("runner did not exit");
  expect(world.sys.ledger().pending(501)).toContain(1);
});
