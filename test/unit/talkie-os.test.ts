import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TalkieOsUser, SETUP_USER_COMMAND } from "../../src/daemon/orchestrator/os-user.ts";
import { setupUserAdmin } from "../../src/cli/commands/seats.ts";
import type { Ctx } from "../../src/cli/context.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

test("shell access refuses a missing helper with the person command", () => {
  const user = new TalkieOsUser("/not-a-socket", () => false, { ready: () => false });
  expect(() => user.assertInstalled()).toThrow(SETUP_USER_COMMAND);
});

test("shell access refuses an open person home before creating the account", async () => {
  let called = false;
  const root = mkdtempSync("/tmp/walkie-talkie-os-"); roots.push(root);
  const user = new TalkieOsUser("/not-a-socket", () => false, { ready: () => true,
    socketRoot: root, privateHome: () => "your home is readable", admin: async () => { called = true; return { ok: true }; } });
  await expect(user.prepare()).rejects.toThrow("your home is readable");
  expect(called).toBe(false);
});

test("an agent cannot apply the root helper install even with agent admin enabled", async () => {
  const ctx = { args: { flags: new Map([["apply", true]]) }, agentSignals: () => ({ marker: "agent", inspection: "ok" }),
    person: { interactive: () => false } } as unknown as Ctx;
  await expect(setupUserAdmin(ctx)).rejects.toThrow("for the person");
});

test("daemon restart reconciles a stale dedicated uid", async () => {
  const calls: string[] = [];
  const root = mkdtempSync("/tmp/walkie-talkie-os-"); roots.push(root);
  const instance = createHash("sha256").update("/not-a-socket").digest("hex");
  const user = new TalkieOsUser("/not-a-socket", () => false, { ready: () => true, existing: () => true, socketRoot: root,
    admin: async (verb) => { calls.push(verb); return verb === "talkie-status"
      ? { ok: true, status: { accountUid: 550_000, uidTaken: true, homeExists: true, processes: [], ledgerOwner: "created", generation: "11111111-1111-4111-8111-111111111111", instance } }
      : { ok: true }; } });
  await user.cleanupStale();
  expect(calls).toEqual(["talkie-status", "talkie-reconcile"]);
});

test("concurrent shell preparations share one helper create", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-os-"); roots.push(root);
  const userHome = join(root, "walkie-talkie"); mkdirSync(userHome);
  const calls: string[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: root,
    admin: async (verb) => {
      calls.push(verb);
      if (verb === "talkie-reconcile") await held;
      return { ok: true, name: "walkie-talkie", uid: 550_000, home: userHome };
    },
  });
  try {
    const first = user.prepare();
    const second = user.prepare();
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual(["talkie-status", "talkie-reconcile", "talkie-create"]);
    expect(user.active).toBe(true);
  } finally { release(); await user.destroy(); }
});

test("the dedicated uid socket forwards only a live orchestrator token", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-os-"); roots.push(root);
  const userHome = join(root, "walkie-talkie"); mkdirSync(userHome);
  const daemonSocket = join(root, "daemon.sock");
  const daemon = Bun.serve({ unix: daemonSocket, fetch: (req: Request) => new Response(JSON.stringify({
    agent: req.headers.get("x-walkie-agent"), token: req.headers.get("x-walkie-orchestrator-token"),
  })) } as Parameters<typeof Bun.serve>[0]);
  const calls: string[] = [];
  const user = new TalkieOsUser(daemonSocket, (token) => token === "live", {
    ready: () => true, privateHome: () => null, socketRoot: root, runner: "/fake/runner", runtime: "/fake/claude",
    admin: async (verb) => { calls.push(verb); return { ok: true, name: "walkie-talkie", uid: 550_000, home: userHome }; },
  });
  try {
    await user.prepare();
    const bad = await fetch("http://walkie/v1/healthz", { unix: user.socket } as RequestInit);
    expect(bad.status).toBe(401);
    const good = await fetch("http://walkie/v1/healthz", { unix: user.socket, headers: {
      "X-Walkie-Orchestrator-Token": "live", "X-Walkie-Agent": "someone-else",
    } } as RequestInit);
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ agent: "orchestrator", token: "live" });
  } finally { await user.destroy(); daemon.stop(true); }
  expect(calls).toEqual(["talkie-status", "talkie-reconcile", "talkie-create", "talkie-destroy"]);
});

test("the dedicated socket refuses machine and credential routes", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-os-"); roots.push(root);
  const userHome = join(root, "walkie-talkie"); mkdirSync(userHome);
  const daemon = Bun.serve({ unix: join(root, "daemon.sock"), fetch: () => new Response("forwarded") } as Parameters<typeof Bun.serve>[0]);
  const user = new TalkieOsUser(join(root, "daemon.sock"), (token) => token === "live", {
    ready: () => true, privateHome: () => null, socketRoot: root, admin: async () => ({ ok: true, name: "walkie-talkie", uid: 550_000, home: userHome }),
  });
  try {
    await user.prepare();
    for (const path of ["/v1/seats/config", "/v1/seats/token", "/v1/vault/lease", "/v1/admin/switches", "/v1/orchestrator/access", "/v1/orchestrator/start", "/v1/seats/repos", "/v1/team/invite", "/v1/license", "/v1/direct/enable", "/v1/steward/config", "/v1/mobile/pair", "/v1/compute/rent", "/v1/compute/stop", "/v1/compute/credit", "/v1/compute/handover/object"]) {
      const response = await fetch(`http://walkie${path}`, { unix: user.socket, method: "POST", headers: { "X-Walkie-Orchestrator-Token": "live" }, body: "{}" } as RequestInit);
      expect(response.status).toBe(403);
    }
    for (const path of ["/v1/me", "/v1/team", "/v1/projects", "/v1/seats", "/v1/orchestrator"]) {
      const response = await fetch(`http://walkie${path}`, { unix: user.socket, headers: { "X-Walkie-Orchestrator-Token": "live" } } as RequestInit);
      expect(response.status).toBe(200);
    }
    for (const path of ["/v1/post", "/v1/ask", "/v1/answer", "/v1/projects", "/v1/tasks", "/v1/tasks/card-1/comment", "/v1/seats/run", "/v1/orchestrator/say"]) {
      const response = await fetch(`http://walkie${path}`, { unix: user.socket, method: "POST",
        headers: { "X-Walkie-Orchestrator-Token": "live" }, body: "{}" } as RequestInit);
      expect(response.status).toBe(200);
    }
    const repos = await fetch("http://walkie/v1/seats/repos", { unix: user.socket, headers: { "X-Walkie-Orchestrator-Token": "live" } } as RequestInit);
    expect(repos.status).toBe(403);
    for (const path of ["/v1/compute/quotes", "/v1/compute/state"]) {
      const response = await fetch(`http://walkie${path}`, { unix: user.socket, headers: { "X-Walkie-Orchestrator-Token": "live" } } as RequestInit);
      expect(response.status).toBe(403);
    }
    for (const body of [{ name: "project", automations: {} }, { name: "project", paths: [] }]) {
      const response = await fetch("http://walkie/v1/projects", { unix: user.socket, method: "POST",
        headers: { "X-Walkie-Orchestrator-Token": "live" }, body: JSON.stringify(body) } as RequestInit);
      expect(response.status).toBe(403);
    }
  } finally { await user.destroy(); daemon.stop(true); }
});

test("a crashed uid monitor restarts, then a crash loop fails closed", async () => {
  const root = mkdtempSync("/tmp/walkie-monitor-death-"); roots.push(root);
  const userHome = join(root, "walkie-talkie"); mkdirSync(userHome);
  const monitors: Array<{ exit: (code: number | null) => void; killed: boolean }> = [];
  const failures: string[] = [];
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: root,
    admin: async () => ({ ok: true, name: "walkie-talkie", uid: 550_000, home: userHome }),
    monitor: () => {
      let exit: (code: number | null) => void = () => undefined;
      const exited = new Promise<number | null>((resolve) => { exit = resolve; });
      const entry = { exit, killed: false };
      monitors.push(entry);
      return { exited, kill: () => { entry.killed = true; } };
    },
    monitorFailure: (reason) => { failures.push(reason); void user.destroy(); },
  });
  try {
    await user.prepare();
    for (let i = 0; i < 3; i++) {
      monitors[i]!.exit(1);
      await Bun.sleep(0);
      expect(monitors.length).toBe(i + 2);
      expect(failures).toEqual([]);
    }
    monitors[3]!.exit(1);
    await Bun.sleep(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("monitor");
    expect(monitors.length).toBe(4);
  } finally { await user.destroy(); }
});
