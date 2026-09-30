import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { callingTalkieDaemon, checkTalkieDaemonStopped } from "../../src/daemon/seats/admin-sys.ts";
import { processStart } from "../../src/daemon/seats/admin-ledger.ts";
import { instanceLockHeld } from "../../src/daemon/instance-lock.ts";

const run = "11111111-1111-4111-8111-111111111111";

test("owner repair refuses a live lease and a live socket, then accepts both stopped", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-repair-live-"));
  const owner = process.getuid?.() ?? 0;
  const dir = join(root, `walkie-seats-${owner}-aaaaaaaaaaaaaaaa`);
  mkdirSync(dir);
  const lease = join(dir, "uid-lease.json");
  const socket = join(dir, "talkie.sock");
  try {
    writeFileSync(lease, JSON.stringify({ run, expires: Date.now() + 60_000, renewed: Date.now(), serial: 1 }));
    const gone = { pid: 99_999, start: "gone" };
    expect((await checkTalkieDaemonStopped(root, owner, run, gone)).why).toContain("lease is still live");
    expect((await checkTalkieDaemonStopped(root, owner, null, gone)).why).toContain("lease is still live");
    rmSync(lease);
    const server = Bun.serve({ unix: socket, fetch: () => new Response("ok") });
    try { expect((await checkTalkieDaemonStopped(root, owner, run, gone)).why).toContain("socket still has a live owner"); }
    finally { server.stop(true); }
    expect((await checkTalkieDaemonStopped(root, owner, run, gone)).ok).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a live recorded daemon cannot hide by unlinking its lease and socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-repair-unlinked-"));
  try {
    const owner = process.getuid?.() ?? 0;
    const daemon = { pid: process.pid, start: processStart(process.pid)! };
    expect((await checkTalkieDaemonStopped(root, owner, run, daemon)).ok).toBe(false);
    expect((await checkTalkieDaemonStopped(root, owner, run, null)).ok).toBe(false);
    expect((await checkTalkieDaemonStopped(root, owner, run, { pid: 99_999, start: "gone" })).ok).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("root helper binds the daemon to its instance lock and listening socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-daemon-identity-"));
  const socket = join(root, "walkie.sock");
  const instance = createHash("sha256").update(socket).digest("hex");
  const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "..", "fixtures", "talkie-daemon-identity.ts"), socket],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    expect(new TextDecoder().decode((await daemon.stdout.getReader().read()).value).trim()).toBe("ready");
    const owner = process.getuid?.() ?? 0;
    expect(instanceLockHeld(`${socket}.lock`)).toBe(true);
    const recorded = callingTalkieDaemon(owner, instance, daemon.pid);
    expect(recorded).toEqual({ pid: daemon.pid, start: processStart(daemon.pid)! });
    expect(() => callingTalkieDaemon(owner, "0".repeat(64), daemon.pid)).toThrow();
  } finally {
    daemon.kill("SIGKILL"); await daemon.exited;
    expect(instanceLockHeld(`${socket}.lock`)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a command-line impostor cannot register itself while the real daemon holds the instance", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-daemon-impostor-"));
  const socket = join(root, "walkie.sock");
  const instance = createHash("sha256").update(socket).digest("hex");
  const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "..", "fixtures", "talkie-daemon-identity.ts"), socket],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const impostor = Bun.spawn([process.execPath, "-e", "await Bun.sleep(10000)", "daemon", "run"],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    expect(new TextDecoder().decode((await daemon.stdout.getReader().read()).value).trim()).toBe("ready");
    const owner = process.getuid?.() ?? 0;
    expect(() => callingTalkieDaemon(owner, instance, impostor.pid)).toThrow();
  } finally {
    impostor.kill("SIGKILL"); daemon.kill("SIGKILL");
    await Promise.all([impostor.exited, daemon.exited]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("replacement socket and lock inodes cannot hide the original live daemon", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-daemon-replaced-"));
  const socket = join(root, "walkie.sock");
  const instance = createHash("sha256").update(socket).digest("hex");
  const fixture = join(import.meta.dir, "..", "fixtures", "talkie-daemon-identity.ts");
  const original = Bun.spawn([process.execPath, fixture, socket], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let replacement: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | null = null;
  try {
    expect(new TextDecoder().decode((await original.stdout.getReader().read()).value).trim()).toBe("ready");
    rmSync(socket);
    rmSync(`${socket}.lock`);
    replacement = Bun.spawn([process.execPath, fixture, socket], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode((await replacement.stdout.getReader().read()).value).trim()).toBe("ready");
    expect(() => callingTalkieDaemon(process.getuid?.() ?? 0, instance, replacement!.pid)).toThrow("another live holder");
  } finally {
    replacement?.kill("SIGKILL"); original.kill("SIGKILL");
    await Promise.all([original.exited, replacement?.exited]);
    rmSync(root, { recursive: true, force: true });
  }
});
