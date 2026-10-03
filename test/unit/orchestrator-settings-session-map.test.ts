import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Like the nearby refresh-race fixture, use the real host methods with an in-memory child.
// No constructor, daemon, account lookup, process launch or privilege helper is needed.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "settings-session-"));
  const host: any = Object.create(OrchestratorHost.prototype);
  const messages = new Map<string, any>();
  const writes: unknown[] = [];
  const launches: unknown[] = [];
  const child = { alive: true, write: (value: unknown) => { writes.push(value); return true; },
    close: async () => { child.alive = false; } };
  Object.assign(host, {
    state: { active: true, owner: "alex", access: "platform", permission_mode: "default",
      cwd: dir, claude: join(dir, "fake-claude"), started_at: 1, sessions: { older: "older-session" } },
    statePath: join(dir, "orchestrator.json"), lifecycle: Promise.resolve(), opts: {},
    runGeneration: 0, finalGeneration: 0, stopping: false, closed: false,
    phase: "idle", turn: null, queue: [], child, childSession: "new-session", childFresh: true,
    childTools: "platform", restarts: 0, attempt: 0, restartTimer: null,
    leadership: { valid: true }, shellUser: { assertInstalled() {}, pendingCleanup: null },
    log: { info() {}, warn() {} },
    core: { me: () => ({ handle: "alex" }), store: {
      orchMessage: (id: string) => messages.get(id),
      putOrchMessage: (message: any) => messages.set(message.id, message),
    }, hub: { publishLocal() {} } },
    detectLogins: async () => {}, prepareAuth: async () => {}, prepareShellUser: async () => {},
    live() {}, status() {},
    spawn: (session: string, resume: boolean) => {
      launches.push({ session, resume, access: host.state.access, model: host.state.model });
      host.child = { alive: true };
    },
  });
  return { host, child, messages, writes, launches,
    saved: () => JSON.parse(readFileSync(host.statePath, "utf8")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const stage of ["detectLogins", "prepareAuth", "prepareShellUser"] as const) {
  test(`accepted access preserves a session created while ${stage} waits`, async () => {
    const r = fixture();
    const entered = deferred();
    const release = deferred();
    r.host[stage] = async () => { entered.resolve(); await release.promise; };
    const setting = r.host.setAccess("full");
    try {
      await entered.promise;
      const before = r.host.state;
      const message = r.host.say("ordinary conversation", undefined, { via: "cli" });
      const turn = r.host.turn;
      const sessions = { older: "older-session", [message.thread]: "new-session" };
      expect(r.host.state.sessions).toEqual(sessions);
      expect(before.sessions).toEqual({ older: "older-session" });
      release.resolve();
      const view = await setting;
      expect(view.access).toBe("full");
      expect(view.permission_mode).toBe("bypassPermissions");
      expect(r.host.child).toBe(r.child);
      expect(r.host.turn).toBe(turn);
      expect(r.messages.get(message.id).state).toBe("sent");
      expect(r.writes).toHaveLength(1);
      expect(r.launches).toEqual([]);
      expect(r.host.pendingNote).toBe("_Access: full._");
      expect(r.host.state.sessions).toEqual(sessions);
      expect(r.saved()).toMatchObject({ access: "full", permission_mode: "bypassPermissions", sessions });
    } finally { release.resolve(); await setting.catch(() => {}); r.cleanup(); }
  });
}

test("refused preparation preserves the newer session and current access without a restart", async () => {
  const r = fixture();
  const entered = deferred();
  const release = deferred();
  r.host.prepareShellUser = async () => { entered.resolve(); await release.promise; throw new Error("fixture refusal"); };
  const setting = r.host.setAccess("full");
  try {
    await entered.promise;
    const message = r.host.say("during refusal", undefined, { via: "cli" });
    const latest = r.host.state;
    release.resolve();
    await expect(setting).rejects.toThrow("fixture refusal");
    expect(r.host.state).toBe(latest);
    expect(r.saved().sessions[message.thread]).toBe("new-session");
    expect(r.host.state.access).toBe("platform");
    expect(r.host.child).toBe(r.child);
    expect(r.host.restartTimer).toBeNull();
    expect(r.host.attempt).toBe(0);
    expect(r.host.pendingNote).toBeUndefined();
  } finally { release.resolve(); await setting.catch(() => {}); r.cleanup(); }
});

test("queued model change retains the accepted access and session while a turn is active", async () => {
  const r = fixture();
  const entered = deferred();
  const release = deferred();
  r.host.prepareAuth = async () => { entered.resolve(); await release.promise; };
  const setting = r.host.setAccess("full");
  try {
    await entered.promise;
    const message = r.host.say("during settings", undefined, { via: "cli" });
    const model = r.host.setModel("sonnet");
    release.resolve();
    await setting;
    await model;
    expect(r.saved()).toMatchObject({ access: "full", model: "sonnet",
      sessions: { older: "older-session", [message.thread]: "new-session" } });
    expect(r.host.pendingModel).toBe("sonnet");
    expect(r.host.child).toBe(r.child);
    expect(r.launches).toEqual([]);
  } finally { release.resolve(); await r.host.lifecycle; r.cleanup(); }
});

test("idle access change still restarts the fake child on its mapped session", async () => {
  const r = fixture();
  try {
    r.host.state = { ...r.host.state, sessions: { older: "new-session" } };
    await r.host.setAccess("full");
    expect(r.child.alive).toBe(false);
    expect(r.launches).toEqual([{ session: "new-session", resume: true, access: "full", model: undefined }]);
    expect(r.saved()).toMatchObject({ access: "full", sessions: { older: "new-session" } });
    expect([...r.messages.values()].map((m) => m.text)).toEqual(["_Access: full._"]);
  } finally { r.cleanup(); }
});

test("a fenced access completion remains refused and preserves the newer mapping", async () => {
  const r = fixture();
  const entered = deferred();
  const release = deferred();
  r.host.prepareAuth = async () => { entered.resolve(); await release.promise; };
  const setting = r.host.setAccess("full");
  try {
    await entered.promise;
    const message = r.host.say("before cancellation", undefined, { via: "cli" });
    r.host.finalGeneration++;
    release.resolve();
    await expect(setting).rejects.toMatchObject({ code: "orchestrator_superseded" });
    expect(r.host.state.access).toBe("platform");
    expect(r.saved().sessions[message.thread]).toBe("new-session");
    expect(r.host.child).toBe(r.child);
    expect(r.launches).toEqual([]);
    expect(r.host.restartTimer).toBeNull();
  } finally { release.resolve(); await setting.catch(() => {}); r.cleanup(); }
});
