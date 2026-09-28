import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validChildLease } from "../../src/daemon/orchestrator/supervisor.ts";
import { leaseHookCommand } from "../../src/daemon/orchestrator/process.ts";

test("hook command blocks when its binary is missing or exceeds its own deadline", async () => {
  for (const command of [leaseHookCommand(["/nonexistent/walkie"]), leaseHookCommand(["/bin/sleep", "3"], 1)]) {
    const p = Bun.spawn(["/bin/sh", "-c", command], { stdout: "ignore", stderr: "ignore" });
    expect(await p.exited).toBe(2);
  }
}, 5_000);

test("PreToolUse lease fence denies expired, stale-epoch and changed-run calls", () => {
  const dir = mkdtempSync(join(import.meta.dir, ".hook-"));
  const file = join(dir, "lease.json");
  const run = `7.${crypto.randomUUID()}`;
  const now = Date.now();
  const lease = { expires: now + 2000, renewed: now, serial: 1, epoch: 7, run };
  try {
    writeFileSync(file, JSON.stringify(lease));
    expect(validChildLease(file, run, now)).toBe(true);
    expect(validChildLease(file, run, now + 2000)).toBe(false);
    expect(validChildLease(file, `8.${run.slice(2)}`, now)).toBe(false);
    writeFileSync(file, JSON.stringify({ ...lease, epoch: 8 }));
    expect(validChildLease(file, run, now)).toBe(false);
    writeFileSync(file, JSON.stringify({ ...lease, run: `7.${crypto.randomUUID()}` }));
    expect(validChildLease(file, run, now)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("internal Claude hook emits an execution denial for a stale lease", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".hook-"));
  const file = join(dir, "lease.json");
  const run = `4.${crypto.randomUUID()}`;
  writeFileSync(file, JSON.stringify({ expires: Date.now() - 1, renewed: Date.now(), serial: 1, epoch: 4, run }));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/cli/main.ts"),
      "--internal-orchestrator-hook", file], { env: { PATH: process.env.PATH ?? "", WALKIE_TALKIE_RUN: run }, stdout: "pipe", stderr: "pipe" });
    const result = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(result)).toMatchObject({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny" } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
