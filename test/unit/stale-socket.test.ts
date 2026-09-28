// WALKIE-SEC-COOKIE-1 (ALE-5248): startup must never unlink a live daemon's socket because it answered slowly.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalApi } from "../../src/daemon/local-api.ts";

describe("clearStaleSocket", () => {
  const root = mkdtempSync("/tmp/walkie-sock-");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a live daemon that answers slowly (900 ms) keeps its socket; startup refuses", async () => {
    const path = join(root, "slow.sock");
    const slow = Bun.serve({ unix: path, fetch: async () => { await Bun.sleep(900); return Response.json({ ok: true }); } } as unknown as Parameters<typeof Bun.serve>[0]);
    try {
      await expect(LocalApi.clearStaleSocket(path)).rejects.toThrow(/did not answer/);
      expect(existsSync(path)).toBe(true);
      // and it is still the live daemon's socket
      const res = await fetch("http://walkie/v1/healthz", { unix: path } as RequestInit);
      expect(res.status).toBe(200);
    } finally {
      slow.stop(true);
    }
  });

  test("a healthy daemon: refuses with 'already listening'", async () => {
    const path = join(root, "live.sock");
    const live = Bun.serve({ unix: path, fetch: () => Response.json({ ok: true }) } as unknown as Parameters<typeof Bun.serve>[0]);
    try {
      await expect(LocalApi.clearStaleSocket(path)).rejects.toThrow(/already listening/);
      expect(existsSync(path)).toBe(true);
    } finally {
      live.stop(true);
    }
  });

  test("a dead daemon's socket (nothing listening) is removed", async () => {
    const path = join(root, "dead.sock");
    const child = Bun.spawn(["bun", "-e", `Bun.serve({ unix: ${JSON.stringify(path)}, fetch: () => new Response("x") }); setInterval(() => {}, 1000);`]);
    for (let i = 0; i < 100 && !existsSync(path); i++) await Bun.sleep(50);
    child.kill(9);
    await child.exited;
    expect(existsSync(path)).toBe(true);
    await LocalApi.clearStaleSocket(path);
    expect(existsSync(path)).toBe(false);
  });

  test("a leftover regular file is removed", async () => {
    const path = join(root, "file.sock");
    writeFileSync(path, "x");
    await LocalApi.clearStaleSocket(path);
    expect(existsSync(path)).toBe(false);
  });
});
