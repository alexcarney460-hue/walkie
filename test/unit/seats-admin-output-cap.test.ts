import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { adminCall } from "../../src/daemon/seats/runner-child.ts";
import { CleanupQueue } from "../../src/daemon/seats/cleanup-queue.ts";

const CHILD = join(import.meta.dir, "..", "fixtures", "seats-admin-output-cap.ts");
const CAP = 256 * 1024;

test("seat-admin writes its near-cap answer fully before immediate process exit", async () => {
  const child = Bun.spawn([process.execPath, CHILD], { stdout: "pipe", stderr: "pipe" });
  // Hold the reader until the pipe fills, as can happen when sudo/daemon is delayed.
  await Bun.sleep(150);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(Buffer.byteLength(stdout)).toBeGreaterThan(CAP - 16);
  expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(CAP);
  const answer = JSON.parse(stdout) as { ok: boolean; ids: number[] };
  expect(answer.ok).toBe(true);
  expect(answer.ids.length).toBeGreaterThan(40_000);
  expect(answer.ids.at(-1)).toBe(answer.ids.length);
});

test("the daemon parses the helper's complete near-cap answer", async () => {
  const answer = await adminCall([process.execPath, CHILD]);
  expect(answer?.ok).toBe(true);
  expect(answer?.ids?.length).toBeGreaterThan(40_000);
  expect(answer?.ids?.at(-1)).toBe(answer?.ids?.length);
});

test("outer admin timeout fails the attempt and schedules a retry", async () => {
  let timedOut = 0;
  const queue = new CleanupQueue(async () => {
    const answer = await adminCall([process.execPath, join(import.meta.dir, "..", "fixtures", "seats-admin-hang.ts")],
      20, undefined, undefined, () => { timedOut++; });
    return { ok: answer?.ok === true };
  }, { retryBaseMs: 1_000 });
  expect((await queue.request(1)).ok).toBe(false);
  expect(timedOut).toBe(1);
  expect(queue.retryDelay(1)).toBe(1_000);
  await queue.close();
});

test("an oversized helper answer stops its child", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".admin-overcap-"));
  const pidPath = join(dir, "pid");
  let pid = 0;
  try {
    expect(await adminCall([process.execPath, join(import.meta.dir, "..", "fixtures", "seats-admin-overcap.ts"), pidPath], 2_000)).toBeNull();
    expect(existsSync(pidPath)).toBe(true);
    pid = Number(readFileSync(pidPath, "utf8"));
    await Bun.sleep(100);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});
