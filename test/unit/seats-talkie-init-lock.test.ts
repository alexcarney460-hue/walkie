import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runSeatAdmin } from "../../src/daemon/seats/admin.ts";
import { withSeatAdminLock } from "../../src/daemon/seats/talkie-lock.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("talkie-lock-init waits for the outer lock before ledger and lock setup", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".talkie-init-lock-"));
  dirs.push(dir);
  const world = fakeSeatWorld(dir, join(dir, "walkie"));
  const outer = join(dir, "outer.lock");
  const talkie = join(dir, "talkie.lock");
  let opens = 0;
  const sys = { ...world.sys, seatAdminLockPath: outer, talkieLockPath: talkie,
    ledger: () => { opens++; return world.sys.ledger(); } };
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const holder = withSeatAdminLock(outer, false, async () => { entered(); await held; });
  await started;
  const getuid = spyOn(process, "getuid").mockReturnValue(0);
  try {
    const lines: string[] = [];
    const init = runSeatAdmin(["talkie-lock-init"], sys, (line) => lines.push(line));
    await Bun.sleep(30);
    expect(opens).toBe(0);
    expect(existsSync(talkie)).toBe(false);
    release();
    await holder;
    expect(await init).toBe(0);
    expect(JSON.parse(lines[0] as string)).toEqual({ ok: true });
    expect(opens).toBeGreaterThan(0);
    expect(existsSync(talkie)).toBe(true);
  } finally { release(); getuid.mockRestore(); await holder; }
});
