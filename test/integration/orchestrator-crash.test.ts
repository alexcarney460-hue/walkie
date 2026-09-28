// ORCH-FIX-13 (Opus r13 MEDIUM): a daemon that dies abruptly (killed by its exact PID with SIGKILL, so no shutdown runs)
// is covered by the independent supervisor even before restart. Startup also removes the stale group record.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "orch-crash-daemon.ts");
const home = mkdtempSync("/tmp/walkie-crash-");
const procs: Subprocess[] = [];
const extra: number[] = [];

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Starts the fixture daemon and reads its first line of JSON. */
async function daemon(mode: "first" | "again"): Promise<{ proc: Subprocess; out: Record<string, unknown> }> {
  const proc = Bun.spawn([process.execPath, FIXTURE, home, mode], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  procs.push(proc);
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let buf = "";
  const deadline = Date.now() + 30_000;
  while (!buf.includes("\n")) {
    const r = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null)]);
    if (!r || r.done) throw new Error(`fixture ${mode} gave no output: ${await new Response(proc.stderr as ReadableStream).text()}`);
    buf += new TextDecoder().decode(r.value);
  }
  reader.releaseLock();
  return { proc, out: JSON.parse(buf.slice(0, buf.indexOf("\n"))) as Record<string, unknown> };
}

afterAll(async () => {
  for (const p of procs) if (alive(p.pid)) { p.kill("SIGTERM"); await Promise.race([p.exited, Bun.sleep(5_000)]); }
  for (const pid of extra) if (alive(pid)) process.kill(pid, "SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

describe("a daemon crash doesn't leave Claude's tools running", () => {
  test("killed by PID mid-turn: supervisor ends its tools before restart; startup preserves unrelated processes", async () => {
    const first = await daemon("first");
    const pid = first.out.pid as number;
    const grandchild = first.out.grandchild as number;
    extra.push(grandchild);
    expect(pid).toBe(first.proc.pid);
    expect(alive(grandchild)).toBe(true);
    const recorded = JSON.parse(readFileSync(join(home, "orchestrator.json"), "utf8")) as { groups?: { pgid: number }[] };
    expect(recorded.groups?.length).toBe(1);
    const pgid = (recorded.groups as { pgid: number }[])[0]?.pgid as number;

    process.kill(pid, "SIGKILL"); // exactly this daemon's process: no shutdown, no reap
    await first.proc.exited;
    const supervisedDeadline = Date.now() + 3_000;
    while (alive(grandchild) && Date.now() < supervisedDeadline) await Bun.sleep(25);
    expect(alive(grandchild)).toBe(false); // independent of a replacement daemon
    // an unrelated process of ours, in its own group, must survive the cleanup
    const bystander = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    extra.push(bystander.pid);

    const again = await daemon("again");
    expect(again.out.ready).toBe(true);
    const deadline = Date.now() + 5_000;
    while (alive(grandchild) && Date.now() < deadline) await Bun.sleep(50);
    expect(alive(grandchild)).toBe(false);
    expect(alive(pgid)).toBe(false);
    expect(alive(bystander.pid)).toBe(true);
    // the new Claude's group is the only one recorded now
    const now = JSON.parse(readFileSync(join(home, "orchestrator.json"), "utf8")) as { groups?: { pgid: number }[] };
    expect(now.groups?.map((g) => g.pgid)).not.toContain(pgid);
    bystander.kill("SIGKILL");
  }, 90_000);
});
