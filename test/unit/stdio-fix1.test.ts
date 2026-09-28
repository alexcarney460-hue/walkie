// WALKIE-MISSION-1 fix round 1 (Codex 9): `walkie subscribe | head -n 1` ends once the reader is gone (EPIPE), a
// subscription still stops on SIGINT while its reader doesn't read (a full pipe), and a finite command blocked on a
// full pipe still dies on Ctrl-C.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = mkdtempSync("/tmp/walkie-stdio-fix1-");
const cleanupPids: number[] = [];
afterAll(() => {
  for (const pid of cleanupPids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function gone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await Bun.sleep(50); }
  return !alive(pid);
}
async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const t = await Bun.file(file).text().catch(() => "");
    if (/^\d+$/.test(t)) return Number(t);
    await Bun.sleep(50);
  }
  throw new Error("no pid");
}

const BOARD = join(import.meta.dir, "../../src/cli/commands/board.ts");
const CONTEXT = join(import.meta.dir, "../../src/cli/context.ts");
const STDIO = join(import.meta.dir, "../../src/cli/stdio.ts");

/** A child running the real `subscribe` command against a stream that never ends (a status event every 5 ms). */
function subscriber(pidFile = ""): string {
  const file = join(dir, `sub-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, `
    ${pidFile ? `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` : ""}
    import { subscribe } from ${JSON.stringify(BOARD)};
    import { makeCtx } from ${JSON.stringify(CONTEXT)};
    const base = makeCtx({ pos: [], flags: new Map([["json", true]]) } as never);
    let n = 0;
    const client = {
      team: async () => ({ nodes: [] }),
      async *stream(_c: unknown, signal: AbortSignal) {
        while (!signal.aborted) {
          await Bun.sleep(5);
          n++;
          yield { type: "event", event: { id: "n1:" + n, kind: "msg.post", ts: n, channel: "general", author: { handle: "alex", node: "n1" }, body: { text: "x".repeat(2000) + n } } };
        }
      },
    };
    const code = await subscribe({ ...base, client: () => client } as never);
    process.stderr.write("subscribe returned " + code + "\\n");
    process.exit(code);
  `);
  return file;
}

describe("streaming output", () => {
  test("subscribe | head -n 1: the subscription ends when the reader goes away (it ran forever before)", async () => {
    const sub = subscriber();
    const p = Bun.spawn(["sh", "-c", `"${process.execPath}" "${sub}" | head -n 1 >/dev/null; echo "pipe:\${PIPESTATUS:-done}"`], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill("SIGKILL"), 8_000);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    expect(code).toBe(0); // finished on its own, not killed by the timer
    expect(out).toContain("pipe:");
    expect(err).toContain("subscribe returned 0");
  }, 15_000);

  test("SIGINT stops a subscription whose reader never reads (a full pipe)", async () => {
    const pidFile = join(dir, "sub.pid");
    const sub = subscriber(pidFile);
    // `sleep` holds the pipe open and never reads it: the subscriber's writes block once 64 KB are queued.
    const sh = Bun.spawn(["sh", "-c", `"${process.execPath}" "${sub}" 2>"${pidFile}.err" | sleep 30`], { stdout: "ignore", stderr: "ignore" });
    cleanupPids.push(sh.pid);
    const pid = await readPid(pidFile);
    await Bun.sleep(1_500);
    expect(alive(pid)).toBe(true); // blocked on the full pipe, still running
    process.kill(pid, "SIGINT");
    expect(await gone(pid, 5_000)).toBe(true);
    sh.kill("SIGKILL");
  }, 15_000);

  test("a finite command blocked on a full pipe still ends on Ctrl-C (no handler of its own)", async () => {
    const pidFile = join(dir, "finite.pid");
    const file = join(dir, "finite.ts");
    writeFileSync(file, `
      import { writeFileSync } from "node:fs";
      import { writeOut } from ${JSON.stringify(STDIO)};
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      for (let i = 0; i < 1000; i++) writeOut("z".repeat(100_000) + "\\n");
      process.exit(0);
    `);
    const sh = Bun.spawn(["sh", "-c", `"${process.execPath}" "${file}" | sleep 30`], { stdout: "ignore", stderr: "ignore" });
    cleanupPids.push(sh.pid);
    const pid = await readPid(pidFile);
    await Bun.sleep(1_000);
    expect(alive(pid)).toBe(true); // blocked in writeAll
    process.kill(pid, "SIGINT");
    expect(await gone(pid, 5_000)).toBe(true);
    sh.kill("SIGKILL");
  }, 15_000);
});
