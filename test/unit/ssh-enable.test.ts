// WALK-67 lane 8, round 2: `walkie ssh enable` no longer opens Remote Login. On macOS (and Linux and WSL) it installs, or
// repairs, Walkie's own SSH service for a machine that already has an owner SSH authorization: the person types yes, one
// sudo runs `provision root-marker install <home> ssh-macos|ssh-linux`, and the result is judged only by the daemon's
// status. Stubbed seams only: no sudo, no daemon, no service.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { SshStatus } from "../../src/cli/commands/doctor.ts";
import { sshEnableCommand, type SshEnableDeps } from "../../src/cli/commands/ssh.ts";
import type { RootBatchDeps, RootBatchNeed } from "../../src/cli/root-batch.ts";
import type { SshStepDeps } from "../../src/cli/ssh-enroll.ts";
import { walkieUnitHints } from "../../src/cli/ssh-unit.ts";
import { fakeDaemon } from "../helpers/fake-daemon.ts";
import { SERVICES, systemctlSays } from "../helpers/systemctl-show.ts";

const ready: SshStatus = { owner_key_present: true, tunnel_allowed: true, reason: null, server: { enabled: true, detail: "up" } };
const down: SshStatus = { ...ready, server: { enabled: false, detail: "Walkie's SSH service is not running (nothing listens on 127.0.0.1:22022)" } };

function setup(over: { platform?: NodeJS.Platform; status?: SshStatus; after?: SshStatus; confirm?: () => Promise<void>; batch?: Parameters<typeof batchOf>[0]; walkieUnit?: boolean; hints?: Pick<SshStepDeps, "walkieUnit" | "walkieActive"> } = {}) {
  const lines: string[] = []; const order: string[] = []; const needs: RootBatchNeed[] = [];
  let t = 0;
  const root: RootBatchDeps = batchOf(over.batch ?? {}, needs, order);
  const platform = over.platform ?? "darwin";
  const deps: SshEnableDeps = {
    platform, out: (l) => lines.push(l), root,
    confirm: over.confirm ?? (async () => { order.push("confirm"); }),
    status: async () => { order.push("status"); return over.status ?? down; },
    step: { platform, timeoutMs: 6_000, pollMs: 2_000, read: async () => over.after ?? ready, sleep: async (ms) => { t += ms; }, now: () => t,
      ...(over.walkieUnit !== undefined ? { walkieUnit: () => over.walkieUnit as boolean } : {}), ...(over.hints ?? {}) },
  };
  return { deps, lines, order, needs, text: () => lines.join("\n") };
}
function batchOf(over: { markerPresent?: boolean; result?: Partial<Awaited<ReturnType<RootBatchDeps["run"]>>> }, needs: RootBatchNeed[], order: string[]): RootBatchDeps {
  return {
    markerPresent: () => over.markerPresent ?? true,
    run: async (need) => { order.push("sudo"); needs.push(need); return { marker: true, ssh: "installed", ...over.result }; },
  };
}

describe("walkie ssh enable", () => {
  test("macOS: asks the person once, runs the ONE sudo for Walkie's service, then judges only by the daemon's status", async () => {
    const s = setup();
    expect(await sshEnableCommand([], s.deps)).toBe(0);
    expect(s.order).toEqual(["status", "confirm", "sudo"]);
    expect(s.needs).toEqual([{ marker: false, sshLinux: false, sshMacos: true }]);
    expect(s.text()).toContain("one administrator step (sudo asks for your password once): Walkie's SSH service for the owner's key (it listens only on this Mac and accepts only key logins; Remote Login is not used)");
    expect(s.text()).toContain("owner SSH is ready");
  });
  test("Linux and WSL: the same command installs the loopback sshd service instead", async () => {
    const s = setup({ platform: "linux", status: { ...down, server: { enabled: false, detail: "no SSH server on 127.0.0.1" } } });
    expect(await sshEnableCommand([], s.deps)).toBe(0);
    expect(s.needs).toEqual([{ marker: false, sshLinux: true, sshMacos: false }]);
  });
  test("it never opens, mentions or asks for Remote Login except to say Walkie does not use it", async () => {
    const s = setup();
    await sshEnableCommand([], s.deps);
    expect(Object.keys(s.deps.step).sort()).toEqual(["now", "platform", "pollMs", "read", "sleep", "timeoutMs"]);
    const mentions = s.lines.filter((l) => l.includes("Remote Login"));
    expect(mentions.every((l) => l.includes("Remote Login is not used"))).toBe(true);
    expect(s.text()).not.toContain("System Settings");
  });
  test("a service that already answers needs no confirmation and no sudo: it just reports", async () => {
    const s = setup({ status: ready });
    expect(await sshEnableCommand([], s.deps)).toBe(0);
    expect(s.order).toEqual(["status"]);
    expect(s.text()).toContain("already answers");
    expect(s.text()).toContain("owner SSH is ready");
  });
  test("Linux and WSL: an SSH server that is not Walkie's answering on 22 is not used and not called ready: said plainly, nothing asked, nothing run (final review A)", async () => {
    for (const unit of [false, undefined] as const) {
      const s = setup({ platform: "linux", status: ready, ...(unit === undefined ? {} : { walkieUnit: unit }) });
      expect(await sshEnableCommand([], s.deps)).toBe(1);
      expect(s.order).toEqual(["status"]);
      expect(s.text()).toContain("This machine already runs its own SSH server; Walkie's owner SSH needs its own service, which a later release adds alongside it; owner SSH stays off.");
      expect(s.text()).not.toContain("already answers");
      expect(s.text()).not.toContain("owner SSH is ready");
    }
  });
  test("Linux and WSL: Walkie's own service answering (its unit installed) is reported as before", async () => {
    const s = setup({ platform: "linux", status: ready, walkieUnit: true });
    expect(await sshEnableCommand([], s.deps)).toBe(0);
    expect(s.text()).toContain("already answers");
    expect(s.text()).toContain("owner SSH is ready");
  });
  test("Linux and WSL: Walkie's own running service, as systemd tells the unprivileged person, is reported as before; any other systemd answer for the same server stays off (final review C, F1)", async () => {
    // The unit FILE sat behind a root-only /etc/systemd/system, so a healthy Walkie machine was told "owner SSH stays off".
    for (const [name, text, ok] of [["Walkie's own, running", SERVICES.walkies, true], ["Walkie's own, stopped", SERVICES.stopped, false],
      ["another unit of that name", SERVICES.foreign, false], ["no such unit", SERVICES.missing, false]] as const) {
      const s = setup({ platform: "linux", status: ready, hints: walkieUnitHints("linux", systemctlSays(text)) });
      expect([name, await sshEnableCommand([], s.deps)]).toEqual([name, ok ? 0 : 1]);
      expect([name, s.text().includes("already answers"), s.text().includes("owner SSH stays off")]).toEqual([name, ok, !ok]);
    }
  });
  test("a machine with no owner SSH authorization has nothing to enable: said plainly, nothing asked, nothing run", async () => {
    const s = setup({ status: { ...down, reason: "grant_absent", owner_key_present: false, tunnel_allowed: false } });
    expect(await sshEnableCommand([], s.deps)).toBe(1);
    expect(s.order).toEqual(["status"]);
    expect(s.text()).toContain("no owner SSH authorization");
    expect(s.text()).toContain("--owner-ssh");
  });
  test("a person who does not confirm (or an agent) gets nothing installed", async () => {
    const s = setup({ confirm: async () => { throw new Error("only a person can install Walkie's SSH service on this machine, at a terminal"); } });
    await expect(sshEnableCommand([], s.deps)).rejects.toThrow("only a person");
    expect(s.order).toEqual(["status"]);
    expect(s.needs).toEqual([]);
  });
  test("an administrator step that failed is said with its reason and the command to repeat it, and nothing is reported ready", async () => {
    const rerun = "sudo /usr/local/bin/walkie provision root-marker install /Users/arvid/.walkie ssh-macos";
    const s = setup({ batch: { result: { marker: true, ssh: "failed", why: "the SSH service install stopped; its messages are above", rerun } } });
    expect(await sshEnableCommand([], s.deps)).toBe(1);
    expect(s.text()).toContain("the SSH service was not installed");
    expect(s.text()).toContain(rerun);
    expect(s.text()).toContain("run walkie ssh enable again");
    expect(s.text()).not.toContain("the same link");
    expect(s.text()).not.toContain("is ready");
  });
  test("a service that was installed but never reads ready is a failure with the verdict's own words", async () => {
    const s = setup({ after: down });
    expect(await sshEnableCommand([], s.deps)).toBe(1);
    expect(s.text()).toContain("NOT ready");
    expect(s.text()).toContain("walkie ssh enable");
  });
  test("it takes no arguments and runs only on macOS, Linux and WSL", async () => {
    await expect(sshEnableCommand(["--now"], setup().deps)).rejects.toThrow("usage: walkie ssh enable");
    await expect(sshEnableCommand([], setup({ platform: "win32" }).deps)).rejects.toThrow("macOS, Linux and WSL");
  });
});

describe("the real CLI entry", () => {
  test("without a person at a terminal nothing is installed: exit 1, and the refusal says why", async () => {
    const daemon = fakeDaemon({ "GET /v1/ssh/status": down });
    const home = mkdtempSync("/tmp/walkie-ssh-enable-");
    try {
      const child = Bun.spawn([process.execPath, "src/cli/main.ts", "ssh", "enable"], { cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_SOCKET: daemon.socket, WALKIE_HOME: home } });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(1);
      expect(err).toMatch(/only a person can|agents can't/);
      expect(out).not.toContain("administrator step");
      expect(daemon.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /v1/ssh/status"]);
    } finally { daemon.stop(); rmSync(home, { recursive: true, force: true }); }
  });
});

