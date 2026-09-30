// ROUND 5 (item 2): Stop must not wait behind shell preparation. It closes the current Claude at once (outside the
// lifecycle queue) and cancels the token read and the privileged helper call instead of waiting out their timeouts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readClaudeToken } from "../../src/accounts/adapters/claude.ts";
import { runProcess } from "../../src/daemon/procs.ts";
import { adminCall } from "../../src/daemon/seats/runner-child.ts";
import { rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";

let r: Rig;
let tokenRig: Rig;
const tokenHook: { fn: ((signal: AbortSignal) => Promise<unknown>) | null } = { fn: null };
const goodToken = () => ({ value: "fake-access", expiresAt: Date.now() + 3_600_000 });
beforeAll(async () => {
  r = await rig();
  tokenRig = await rig({ orchestrator: { readShellToken: (signal: AbortSignal) => tokenHook.fn ? tokenHook.fn(signal) : Promise.resolve(goodToken()) } });
}, 60_000);
afterAll(async () => { await r.c.close(); await tokenRig.c.close(); });

const STOP_BOUND_MS = 5_000;
const stopWithin = (rg: Rig) => Promise.race([rg.alex.client("").orchestratorStop(), Bun.sleep(STOP_BOUND_MS).then(() => { throw new Error("Stop timed out"); })]);
const noShellWithoutObligation = (host: any) => {
  expect(host.shellUser.active).toBe(false);
  expect(host.shellUser.generation === null || host.shellUser.pendingCleanup !== null).toBe(true);
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a never answering keychain reader ends when preparation is aborted", async () => {
  const controller = new AbortController();
  const read = readClaudeToken({ provider: "claude", dir: r.root, isDefault: true },
    async () => new Promise<never>(() => undefined), 60_000, 0, controller.signal);
  controller.abort();
  expect(await Promise.race([read, Bun.sleep(1_000).then(() => "late")])).toBe("keychain_unavailable");
});

test("aborting runProcess and adminCall kills the process they started", async () => {
  for (const kind of ["runProcess", "adminCall"] as const) {
    const pidFile = join(r.root, `${kind}.pid`);
    const controller = new AbortController();
    const argv = ["/bin/sh", "-c", `echo $$ > '${pidFile}'; exec /bin/sleep 60`];
    const run = kind === "runProcess"
      ? runProcess(argv, { timeoutMs: 60_000, signal: controller.signal })
      : adminCall(argv, 60_000, undefined, controller.signal);
    const pid = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() || null, { what: `${kind} child pid` }));
    try {
      expect(alive(pid)).toBe(true);
      controller.abort();
      await Promise.race([run, Bun.sleep(2_000).then(() => { throw new Error(`${kind} did not return after abort`); })]);
      await waitFor(() => !alive(pid) || null, { what: `${kind} child gone`, timeoutMs: 3_000 }).catch(() => undefined);
      expect(alive(pid)).toBe(false);
    } finally { if (alive(pid)) process.kill(pid, "SIGKILL"); }
  }
}, 30_000);

test("stop closes the live child before it waits for the lifecycle queue", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform" });
  const host = r.host();
  await waitFor(() => host.child?.alive, { what: "platform child" });
  const child = host.child;
  const token = host.childToken as string;
  expect(host.acceptsToken(token)).toBe(true);
  let release!: () => void;
  const blocker = host.serial(() => new Promise<void>((resolve) => { release = resolve; }));
  const stop = host.stopByHand();
  try {
    await waitFor(() => !child.alive, { what: "child killed while the queue is blocked", timeoutMs: 3_000 });
    expect(host.acceptsToken(token)).toBe(false);
  } finally { release(); }
  await blocker;
  await stop;
  expect(host.child).toBeNull();
  expect(host.phase).toBe("stopped");
});

test("stop closes the live child while shell helper never answers", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform" });
  const host = r.host();
  await waitFor(() => host.child?.alive, { what: "platform child" });
  const child = host.child;
  let entered = false;
  r.hook.fn = async (verb) => {
    if (verb === "talkie-create") { entered = true; return new Promise<never>(() => undefined); }
  };
  const access = host.setAccess("full").catch(() => undefined);
  await waitFor(() => entered, { what: "hung helper create" });
  const started = Date.now();
  await stopWithin(r);
  expect(Date.now() - started).toBeLessThan(STOP_BOUND_MS);
  await access;
  r.hook.fn = null;
  expect(child.alive).toBe(false);
  expect(host.child).toBeNull();
  expect(host.phase).toBe("stopped");
  noShellWithoutObligation(host);
}, 60_000);

test("stop resolves promptly while the helper's reconcile never answers", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform" });
  const host = r.host();
  await waitFor(() => host.child?.alive, { what: "platform child" });
  const child = host.child;
  let entered = false;
  r.hook.fn = async (verb) => {
    if (verb === "talkie-reconcile") { entered = true; return new Promise<never>(() => undefined); }
  };
  const access = host.setAccess("full").catch(() => undefined);
  await waitFor(() => entered, { what: "hung helper reconcile" });
  await stopWithin(r);
  await access;
  r.hook.fn = null;
  expect(child.alive).toBe(false);
  expect(host.child).toBeNull();
  expect(host.phase).toBe("stopped");
  expect(host.shellUser.generation).toBeNull();
  noShellWithoutObligation(host);
}, 60_000);

test("stop resolves promptly while the token read never answers", async () => {
  const host = tokenRig.host();
  await tokenRig.alex.client("").orchestratorStart({ access: "platform" });
  await waitFor(() => host.child?.alive, { what: "platform child" });
  const child = host.child;
  let entered = false;
  let seen: AbortSignal | undefined;
  tokenHook.fn = (signal) => { entered = true; seen = signal; return new Promise<never>(() => undefined); };
  const access = host.setAccess("full").catch(() => undefined);
  await waitFor(() => entered, { what: "hung token read" });
  await stopWithin(tokenRig);
  await access;
  tokenHook.fn = null;
  expect(seen?.aborted).toBe(true);
  expect(tokenRig.count("talkie-create")).toBe(0);
  expect(child.alive).toBe(false);
  expect(host.child).toBeNull();
  expect(host.phase).toBe("stopped");
  noShellWithoutObligation(host);
}, 60_000);

test("stop does not wait for a cleanup that is already stuck in the helper", async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const host = r.host();
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  let release!: () => void;
  const stuck = new Promise<void>((resolve) => { release = resolve; });
  let destroying = false;
  r.hook.fn = async (verb) => { if (verb === "talkie-destroy") { destroying = true; await stuck; } };
  // What a give-up or a settings switch starts: a cleanup with no bound of its own.
  const cleanup = host.shellUser.destroy().catch(() => undefined);
  await waitFor(() => destroying, { what: "stuck helper destroy" });
  const started = Date.now();
  // Stop returns with cleanup pending; the existing helper call continues to verification.
  await stopWithin(r);
  expect(Date.now() - started).toBeLessThan(STOP_BOUND_MS);
  expect(host.child).toBeNull();
  expect(host.phase).toBe("stopped");
  expect(host.state.active).toBe(false);
  expect(host.state.stopped_by_hand).toBe(true);
  expect(host.shellUser.pendingCleanup !== null || host.shellUser.generation === null).toBe(true);
  release();
  r.hook.fn = null;
  await cleanup;
}, 60_000);
