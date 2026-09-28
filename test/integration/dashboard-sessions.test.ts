// WALKIE-SEC-COOKIE-1/2 (ALE-5248): the dashboard login is a separate, short-lived, revocable session, never the
// durable local.token, and never a cookie (browsers send 127.0.0.1 cookies to every port, RFC 6265 §8.5). The
// page gets it in the login redirect's fragment and sends it as X-Walkie-Session (test/integration/sec-cookie-2).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

let c: Cluster;
let alex: TestNode;

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  await alex.client().init("acme", "alex");
});
afterAll(async () => { await c.close(); });

const port = () => alex.d.localPort as number;
const url = (p: string) => `http://127.0.0.1:${port()}${p}`;
const origin = () => `http://127.0.0.1:${port()}`;

/** `walkie dashboard`: a nonce over the unix socket, exchanged at /auth. */
async function login(): Promise<Response> {
  const { nonce } = await alex.client().authNonce();
  return fetch(url(`/auth?nonce=${nonce}`), { redirect: "manual" });
}

/** A session value (from the login redirect's fragment) and the header that carries it. */
async function session(): Promise<{ value: string; h: Record<string, string> }> {
  const res = await login();
  const value = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  return { value, h: { "X-Walkie-Session": value } };
}

describe("dashboard sessions", () => {
  test("the login hands over a session (in the fragment), never local.token", async () => {
    const res = await login();
    expect(res.status).toBe(302);
    const value = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(value).not.toBe(alex.d.token);
    for (const line of res.headers.getSetCookie()) expect(line).not.toContain(alex.d.token);
    // the pre-upgrade cookie is cleared on login
    expect(res.headers.getSetCookie().some((l) => l.startsWith("walkie_token=;") && l.includes("Max-Age=0"))).toBe(true);
    expect((await fetch(url("/v1/me"), { headers: { "X-Walkie-Session": value } })).status).toBe(200);
  });

  test("a session value is not a bearer on the local API", async () => {
    const s = await session();
    expect((await fetch(url("/v1/me"), { headers: { Authorization: `Bearer ${s.value}` } })).status).toBe(401);
    const post = await fetch(url("/v1/post"), {
      method: "POST", headers: { Authorization: `Bearer ${s.value}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general", text: "session as bearer" }),
    });
    expect(post.status).toBe(401);
    // the durable token as a bearer still works for scripts
    expect((await fetch(url("/v1/me"), { headers: { Authorization: `Bearer ${alex.d.token}` } })).status).toBe(200);
  });

  test("the pre-upgrade cookie (local.token) is rejected, under either name, and as a session header", async () => {
    expect((await fetch(url("/v1/me"), { headers: { Cookie: `walkie_token=${alex.d.token}` } })).status).toBe(401);
    expect((await fetch(url("/v1/me"), { headers: { Cookie: `walkie_s_${port()}=${alex.d.token}` } })).status).toBe(401);
    expect((await fetch(url("/v1/me"), { headers: { "X-Walkie-Session": alex.d.token } })).status).toBe(401);
  });

  test("a session is only accepted for dashboard routes", async () => {
    const s = await session();
    const write = (path: string, body: unknown) => fetch(url(path), {
      method: "POST", headers: { ...s.h, Origin: origin(), "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await write("/v1/post", { channel: "general", text: "from the dashboard" })).status).toBe(200);
    // the Accounts page (ACCOUNTS-1) reads this with a session
    expect((await fetch(url("/v1/accounts"), { headers: s.h })).status).toBe(200);
    // not used by the dashboard → not reachable with a session (the token still reaches them)
    expect((await write("/v1/team/authority", { node: "alex-mbp" })).status).toBe(403);
    expect((await write("/v1/join", { peer: "127.0.0.1:1" })).status).toBe(403);
    expect((await fetch(url("/v1/diag"), { headers: s.h })).status).toBe(403);
    expect((await fetch(url("/v1/diag"), { headers: { Authorization: `Bearer ${alex.d.token}` } })).status).toBe(200);
  });

  test("a session is bound to the Host it was issued for", async () => {
    const s = await session();
    expect((await fetch(url("/v1/me"), { headers: { ...s.h, Host: `localhost:${port()}` } })).status).toBe(401);
    expect((await fetch(url("/v1/me"), { headers: s.h })).status).toBe(200);
  });

  test("logout revokes the session and closes its open stream", async () => {
    const s = await session();
    const ac = new AbortController();
    const stream = await fetch(url("/v1/stream"), { headers: s.h, signal: ac.signal });
    expect(stream.status).toBe(200);
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // hello frame
    // cross-site logout is refused like any other dashboard write
    expect((await fetch(url("/auth/logout"), { method: "POST", headers: { ...s.h, Origin: "http://evil.example" } })).status).toBe(403);
    expect((await fetch(url("/auth/logout"), { method: "POST", headers: s.h })).status).toBe(403);
    const out = await fetch(url("/auth/logout"), { method: "POST", headers: { ...s.h, Origin: origin() } });
    expect(out.status).toBe(204);
    expect((await fetch(url("/v1/me"), { headers: s.h })).status).toBe(401);
    // the stream ends (done) instead of staying authenticated
    const ended = await Promise.race([
      (async () => { for (;;) { const r = await reader.read(); if (r.done) return true; } })().catch(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    ac.abort();
    expect(ended).toBe(true);
  });

  test("`walkie dashboard logout` revokes every session", async () => {
    const a = await session();
    const b = await session();
    const res = await alex.client().logoutDashboards();
    expect(res.revoked).toBeGreaterThanOrEqual(2);
    expect((await fetch(url("/v1/me"), { headers: a.h })).status).toBe(401);
    expect((await fetch(url("/v1/me"), { headers: b.h })).status).toBe(401);
    // re-login still works
    const again = await session();
    expect((await fetch(url("/v1/me"), { headers: again.h })).status).toBe(200);
  });

  test("the logout and rotate routes are unix-socket only", async () => {
    const bearer = { Authorization: `Bearer ${alex.d.token}`, Origin: origin() };
    expect((await fetch(url("/v1/auth/logout"), { method: "POST", headers: bearer })).status).toBe(403);
    expect((await fetch(url("/v1/auth/rotate"), { method: "POST", headers: bearer })).status).toBe(403);
  });

  test("`walkie token rotate` replaces local.token, revokes sessions, and the old token stops working", async () => {
    const s = await session();
    const old = alex.d.token;
    const res = await alex.client().rotateToken();
    expect(res).toEqual({ rotated: true, path: alex.d.paths.token });
    expect(JSON.stringify(res)).not.toContain(alex.d.token);
    const fresh = readFileSync(alex.d.paths.token, "utf8").trim();
    expect(fresh).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh).not.toBe(old);
    expect(alex.d.token).toBe(fresh);
    expect((await fetch(url("/v1/me"), { headers: { Authorization: `Bearer ${old}` } })).status).toBe(401);
    expect((await fetch(url("/v1/me"), { headers: { Authorization: `Bearer ${fresh}` } })).status).toBe(200);
    expect((await fetch(url("/v1/me"), { headers: s.h })).status).toBe(401);
  });

  test("CLI: `walkie dashboard logout` and `walkie token rotate` (the new token is never printed)", async () => {
    const cli = async (args: string[]) => {
      return runAsPerson([process.execPath, join(import.meta.dir, "../../src/cli/main.ts"), ...args],
        { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: alex.home, WALKIE_SOCKET: alex.socket });
    };
    const s = await session();
    const out = await cli(["dashboard", "logout"]);
    expect(out.code).toBe(0);
    expect(out.out).toMatch(/^signed out \d+ dashboard sessions?/);
    expect((await fetch(url("/v1/me"), { headers: s.h })).status).toBe(401);
    const old = alex.d.token;
    const rot = await cli(["token", "rotate"]);
    expect(rot.code).toBe(0);
    expect(rot.out).toContain(`rotated ${alex.d.paths.token}`);
    expect(alex.d.token).not.toBe(old);
    expect(rot.out + rot.err).not.toContain(alex.d.token);
    expect((await cli(["token"])).code).not.toBe(0);
  });

  // LIVE-2: sessions now survive a restart on the same port (live-2-sessions.test.ts); this node's port is random per
  // start, and a session is bound to the Host it was issued for.
  test("a daemon restart on a different port does not carry a session over (Host-bound)", async () => {
    const s = await session();
    expect((await fetch(url("/v1/me"), { headers: s.h })).status).toBe(200);
    await alex.restart();
    const res = await fetch(url("/v1/me"), { headers: s.h });
    expect(res.status).toBe(401);
  });
});
