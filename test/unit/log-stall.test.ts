// A stuck log disk used to block the daemon thread (appendFileSync). The write now waits off that thread.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../src/daemon/logger.ts";

test("a stuck log write does not stall the event loop", async () => {
  const dir = mkdtempSync("/tmp/walkie-log-stall-");
  let release: () => void = () => {};
  let started = false;
  const log = createLogger({
    file: join(dir, "daemon.log"),
    append: () => new Promise<void>((resolve) => { started = true; release = resolve; }),
  });
  try {
    log.info("while the disk is stuck");
    for (let i = 0; i < 20 && !started; i++) await Bun.sleep(1);
    expect(started).toBe(true);
    const t0 = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(performance.now() - t0).toBeLessThan(500);
    release();
    await log.flush();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
