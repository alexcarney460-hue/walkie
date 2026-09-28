// SEC-COOKIE-2 (ALE-5248, second round): session deadlines, the socket probe, and one daemon per socket.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DashboardSessions, SESSION_MAX_MS } from "../../src/daemon/dashboard-sessions.ts";
import { LocalApi, type LocalApiDeps } from "../../src/daemon/local-api.ts";
import { Hub } from "../../src/daemon/sse.ts";
import type { Event } from "../../src/protocol/schemas.ts";

const HOST = "127.0.0.1:7457";

describe("absolute session deadline", () => {
  test("a session is over exactly at createdAt + 7 days (>=, not >)", () => {
    let now = 1_000;
    const s = new DashboardSessions({ now: () => now });
    const v = s.create(HOST);
    const sess = s.check(v, HOST);
    expect(sess?.expiresAt).toBe(1_000 + SESSION_MAX_MS);
    s.openStream(sess!);
    now = 1_000 + SESSION_MAX_MS - 1;
    expect(s.check(v, HOST)).not.toBeNull();
    now = 1_000 + SESSION_MAX_MS;
    expect(s.check(v, HOST)).toBeNull();
    expect(sess!.signal.aborted).toBe(true);
  });

  test("the hub delivers nothing to a stream past its deadline, even before any sweep or timer runs", async () => {
    const hub = new Hub(60_000, 10);
    try {
      const ac = new AbortController();
      const res = hub.open(null, [], ac.signal, Date.now() + 80);
      expect(res).not.toBeNull();
      const reader = (res as Response).body!.getReader();
      await reader.read(); // ": connected"
      await Bun.sleep(120);
      hub.publishEvent({ id: "e1", kind: "msg.post", body: { text: "late" } } as unknown as Event);
      const dec = new TextDecoder();
      let text = "";
      for (;;) {
        const r = await Promise.race([reader.read(), Bun.sleep(500).then(() => null)]);
        if (r === null || r.done) break;
        text += dec.decode(r.value);
      }
      expect(text).not.toContain("late");
      expect(hub.size).toBe(0);
    } finally {
      hub.close();
    }
  });
});

const root = mkdtempSync("/tmp/walkie-sc2-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const fakeDeps = { core: { log: noopLog }, token: "0".repeat(64), webDir: root } as unknown as LocalApiDeps;

describe("stale socket probe", () => {
  test("a live socket we can't connect to (mode 000; Bun reports ENOENT) is not removed", async () => {
    const path = join(root, "m000.sock");
    const live = Bun.serve({ unix: path, fetch: () => Response.json({ ok: true }) } as unknown as Parameters<typeof Bun.serve>[0]);
    try {
      chmodSync(path, 0o000);
      await expect(LocalApi.clearStaleSocket(path)).rejects.toThrow();
      expect(existsSync(path)).toBe(true);
      chmodSync(path, 0o600);
      expect((await fetch("http://walkie/v1/healthz", { unix: path } as RequestInit)).status).toBe(200);
    } finally {
      live.stop(true);
    }
  });
});

describe("one daemon per socket (lockfile held for the daemon's lifetime)", () => {
  test("two concurrent starts on one socket: exactly one binds, and its socket survives", async () => {
    const path = join(root, "race.sock");
    const a = new LocalApi(fakeDeps);
    const b = new LocalApi(fakeDeps);
    try {
      const results = await Promise.allSettled([a.startUnix(path), b.startUnix(path)]);
      expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
      const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(String(refused.reason)).toMatch(/already running|already listening/);
      expect((await fetch("http://walkie/v1/healthz", { unix: path } as RequestInit)).status).toBe(200);
    } finally {
      a.stop();
      b.stop();
    }
  });

  test("a start while another daemon holds the lock is refused before touching the socket; after it stops, a start works", async () => {
    const path = join(root, "held.sock");
    const a = new LocalApi(fakeDeps);
    await a.startUnix(path);
    const b = new LocalApi(fakeDeps);
    await expect(b.startUnix(path)).rejects.toThrow(/already running/);
    expect((await fetch("http://walkie/v1/healthz", { unix: path } as RequestInit)).status).toBe(200);
    b.stop(); // a refused start must not remove the running daemon's socket
    expect(existsSync(path)).toBe(true);
    a.stop();
    expect(existsSync(path)).toBe(false);
    // the lockfile stays behind; it is not "stale" (the lock died with its holder)
    expect(existsSync(`${path}.lock`)).toBe(true);
    const c2 = new LocalApi(fakeDeps);
    await c2.startUnix(path);
    expect((await fetch("http://walkie/v1/healthz", { unix: path } as RequestInit)).status).toBe(200);
    c2.stop();
  });

  test("a lock held by a killed process is free again (no stale-lock cleanup needed)", async () => {
    const path = join(root, "killed.sock");
    const child = Bun.spawn(["bun", "-e", `
      const { LocalApi } = await import(${JSON.stringify(join(import.meta.dir, "../../src/daemon/local-api.ts"))});
      const api = new LocalApi({ core: { log: { info() {}, warn() {}, error() {}, debug() {} } }, token: "0".repeat(64), webDir: "/" });
      await api.startUnix(${JSON.stringify(path)});
      console.log("up");
      setInterval(() => {}, 1000);
    `], { stdout: "pipe" });
    const reader = child.stdout.getReader();
    await reader.read();
    child.kill(9);
    await child.exited;
    expect(existsSync(path)).toBe(true); // the dead daemon's socket file
    const next = new LocalApi(fakeDeps);
    await next.startUnix(path);
    expect((await fetch("http://walkie/v1/healthz", { unix: path } as RequestInit)).status).toBe(200);
    next.stop();
  });
});
