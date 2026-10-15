// WALK-175. The seats probe makes this process a Linux child subreaper. An orphaned descendant is then our child,
// and after SIGKILL it stays a zombie until waitpid. These tests run on Linux only; macOS has no subreaper.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { armAdoptedZombieTracking, enableLinuxChildSubreaper, installLinuxChildSubreaper, noteSnapshotIdentity, reapAdoptedZombies, startAdoptedZombieSweep } from "../../src/daemon/adopted-zombies.ts";
import { ClaudeChild } from "../../src/daemon/orchestrator/process.ts";

function procFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function ourZombie(pid: number): boolean {
  const fields = procFields(pid);
  return fields !== null && (fields[0] === "Z" || fields[0] === "X") && Number(fields[1]) === process.pid;
}

function directChildrenExcept(skip: number): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === skip) continue;
    const fields = procFields(pid);
    if (fields && Number(fields[1]) === process.pid) pids.push(pid);
  }
  return pids;
}

test.skipIf(process.platform !== "linux")("an adopted descendant is not recorded as a spawned pid", async () => {
  // prctl first, then the orphan. Tracking receives every other direct child and not this pid. A post-prctl
  // /proc scan would own the orphan with no exit promise, and the zombie would stay until the process exits.
  enableLinuxChildSubreaper();
  const dir = mkdtempSync("/tmp/walkie-zombie-own-");
  const pidPath = join(dir, "pid");
  let child = 0;
  try {
    const bin = join(dir, "parent.sh");
    writeFileSync(bin, "#!/bin/bash\nsleep 60 &\necho $! > \"$PIDFILE\"\ndisown\nexit 0\n");
    chmodSync(bin, 0o755);
    const parent = Bun.spawn([bin], {
      env: { PATH: "/usr/bin:/bin", PIDFILE: pidPath },
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    const code = await Promise.race([parent.exited, Bun.sleep(3_000).then(() => "hung" as const)]);
    expect(code).toBe(0);
    child = Number(readFileSync(pidPath, "utf8").trim());
    const adopted = procFields(child);
    expect(adopted).not.toBeNull();
    expect(Number(adopted![1])).toBe(process.pid);
    armAdoptedZombieTracking(directChildrenExcept(child));
    process.kill(child, "SIGKILL");
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      reapAdoptedZombies();
      gone = procFields(child) === null;
      if (!gone) await Bun.sleep(10);
    }
    expect(gone).toBe(true);
    child = 0;
  } finally {
    startAdoptedZombieSweep();
    if (child > 0) {
      try { process.kill(child, "SIGKILL"); } catch { /* already gone */ }
      for (let i = 0; i < 20 && procFields(child); i++) {
        reapAdoptedZombies();
        await Bun.sleep(10);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(process.platform !== "linux")("a snapshot pid with a different start time is not kept, so the replacement zombie is collected", async () => {
  // The recorded ticks are not this process's. That is the pid-reuse window: the snapshot pid exited, the
  // kernel reused the number, and the sweep never saw ENOENT. A matching start time would still be owned.
  installLinuxChildSubreaper();
  const dir = mkdtempSync("/tmp/walkie-zombie-reuse-");
  const pidPath = join(dir, "pid");
  let child = 0;
  try {
    const bin = join(dir, "parent.sh");
    writeFileSync(bin, "#!/bin/bash\nsleep 60 &\necho $! > \"$PIDFILE\"\ndisown\nexit 0\n");
    chmodSync(bin, 0o755);
    const parent = Bun.spawn([bin], {
      env: { PATH: "/usr/bin:/bin", PIDFILE: pidPath },
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    const code = await Promise.race([parent.exited, Bun.sleep(3_000).then(() => "hung" as const)]);
    expect(code).toBe(0);
    child = Number(readFileSync(pidPath, "utf8").trim());
    const adopted = procFields(child);
    expect(adopted).not.toBeNull();
    expect(adopted![0]).not.toBe("Z");
    const realStart = adopted![19];
    expect(realStart).toMatch(/^\d+$/);
    noteSnapshotIdentity(child, String(BigInt(realStart!) + 1n));
    reapAdoptedZombies();
    expect(procFields(child)?.[0]).not.toBe("Z");
    expect(Number(procFields(child)?.[1])).toBe(process.pid);
    process.kill(child, "SIGKILL");
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      reapAdoptedZombies();
      gone = procFields(child) === null;
      if (!gone) await Bun.sleep(10);
    }
    expect(gone).toBe(true);
    child = 0;
  } finally {
    if (child > 0) {
      try { process.kill(child, "SIGKILL"); } catch { /* already gone */ }
      for (let i = 0; i < 20 && procFields(child); i++) {
        reapAdoptedZombies();
        await Bun.sleep(10);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(process.platform !== "linux")("a killed adopted descendant stays a zombie until it is collected, and a live one is not", async () => {
  installLinuxChildSubreaper();
  const dir = mkdtempSync("/tmp/walkie-zombie-");
  const pidPath = join(dir, "pid");
  let child = 0;
  try {
    const bin = join(dir, "parent.sh");
    writeFileSync(bin, "#!/bin/bash\nsleep 60 &\necho $! > \"$PIDFILE\"\ndisown\nexit 0\n");
    chmodSync(bin, 0o755);
    // stderr is ignored: a pipe would stay open on the grandchild and the read would wait for sleep.
    const parent = Bun.spawn([bin], {
      env: { PATH: "/usr/bin:/bin", PIDFILE: pidPath },
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    const code = await Promise.race([parent.exited, Bun.sleep(3_000).then(() => "hung" as const)]);
    expect(code).toBe(0);
    child = Number(readFileSync(pidPath, "utf8").trim());
    const adopted = procFields(child);
    expect(adopted).not.toBeNull();
    expect(adopted![0]).not.toBe("Z");
    expect(Number(adopted![1])).toBe(process.pid);
    reapAdoptedZombies();
    expect(procFields(child)?.[0]).not.toBe("Z");
    expect(Number(procFields(child)?.[1])).toBe(process.pid);
    process.kill(child, "SIGKILL");
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      reapAdoptedZombies();
      gone = procFields(child) === null;
      if (!gone) await Bun.sleep(10);
    }
    expect(gone).toBe(true);
    child = 0;
  } finally {
    if (child > 0) {
      try { process.kill(child, "SIGKILL"); } catch { /* already gone */ }
      for (let i = 0; i < 20 && procFields(child); i++) {
        reapAdoptedZombies();
        await Bun.sleep(10);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(process.platform !== "linux")("close() does not leave a TERM-ignoring descendant as our zombie", async () => {
  installLinuxChildSubreaper();
  const dir = mkdtempSync("/tmp/walkie-zombie-close-");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/bash\nd="$(dirname "$0")"\nbash -c "trap '' TERM; touch '$d/ready'; exec sleep 300" &\necho $! > "$d/pid"\nwhile [ ! -f "$d/ready" ]; do sleep 0.01; done\nexit 0\n`);
  chmodSync(bin, 0o755);
  let pid = 0;
  try {
    const child = new ClaudeChild(bin, [], dir, { PATH: "/usr/bin:/bin" }, { onSignal: () => undefined, onExit: () => undefined });
    await child.exited;
    const pidFile = join(dir, "pid");
    for (let i = 0; i < 100 && !(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()); i++) await Bun.sleep(10);
    pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(procFields(pid)).not.toBeNull();
    const started = Date.now();
    await child.close();
    // The descendant ignores SIGTERM, so close() still spends REAP_GRACE_MS (2s). It must not also spend
    // REAP_KILL_WAIT_MS (1s) on a zombie that still answers signal 0. 2.8s leaves room for the grace and one poll.
    expect(Date.now() - started).toBeLessThan(2_800);
    const fields = procFields(pid);
    const stillAlive = fields !== null && fields[0] !== "Z" && fields[0] !== "X";
    expect(stillAlive).toBe(false);
    expect(ourZombie(pid)).toBe(false);
    pid = 0;
  } finally {
    if (pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      reapAdoptedZombies();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
