// SEC-COOKIE-2 (ALE-5248, second round). Browsers send 127.0.0.1 cookies to every port, so a dashboard cookie
// reaches any other loopback listener. The audits replayed a captured session cookie with a forged Origin and made
// an attacker a permanent team owner. Now the cookie authorizes nothing: the login hands the session to the page
// in the URL fragment (never sent to a server), the page keeps it in its own origin's storage (port-isolated) and
// sends it as X-Walkie-Session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cluster, type TestNode } from "../helpers/cluster.ts";

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

/** The session value the login hands the page (in the redirect's fragment). */
async function session(): Promise<string> {
  const res = await login();
  const m = /^\/#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "");
  if (!m) throw new Error(`no session in the login redirect: ${res.headers.get("location")}`);
  return m[1] as string;
}

const invite = (headers: Record<string, string>, login = "mallory@example.com", handle = "mallory") =>
  fetch(url("/v1/team/invite"), {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ login, handle, role: "owner" }),
  });

/** Reads a stream until `until` matches the text so far, it ends, or `ms` pass. */
async function readUntil(body: ReadableStream<Uint8Array>, until: (text: string) => boolean, ms = 3_000): Promise<{ text: string; done: boolean }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const r = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null)]);
      if (r === null) break;
      if (r.done) return { text, done: true };
      text += dec.decode(r.value, { stream: true });
      if (until(text)) return { text, done: false };
    }
    return { text, done: false };
  } finally {
    reader.releaseLock();
  }
}

describe("SEC-COOKIE-2: the dashboard session never rides in a cookie", () => {
  test("/auth hands the session over in the URL fragment and sets no session cookie", async () => {
    const res = await login();
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toMatch(/^\/#s=[0-9a-f]{64}$/);
    expect(loc).not.toContain(alex.d.token);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // every Set-Cookie line only clears (the pre-upgrade walkie_token and the round-1 walkie_s_<port>)
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const line of cookies) expect(line).toMatch(/^[a-z_0-9]+=; Max-Age=0;/);
    expect(cookies.some((l) => l.startsWith("walkie_token=;"))).toBe(true);
    expect(cookies.some((l) => l.startsWith(`walkie_s_${port()}=;`))).toBe(true);
  });

  test("/auth only answers GET", async () => {
    const { nonce } = await alex.client().authNonce();
    expect((await fetch(url(`/auth?nonce=${nonce}`), { method: "POST", redirect: "manual" })).status).toBe(405);
  });

  test("the session works as X-Walkie-Session (reads, and writes with the page's Origin)", async () => {
    const s = await session();
    expect((await fetch(url("/v1/me"), { headers: { "X-Walkie-Session": s } })).status).toBe(200);
    const post = await fetch(url("/v1/post"), {
      method: "POST", headers: { "X-Walkie-Session": s, Origin: origin(), "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general", text: "from the dashboard" }),
    });
    expect(post.status).toBe(200);
    // cross-site and Origin-less writes are still refused
    const bad = await fetch(url("/v1/post"), {
      method: "POST", headers: { "X-Walkie-Session": s, Origin: "http://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general", text: "csrf" }),
    });
    expect(bad.status).toBe(403);
    const none = await fetch(url("/v1/post"), {
      method: "POST", headers: { "X-Walkie-Session": s, "Content-Type": "application/json" }, body: JSON.stringify({ channel: "general", text: "no origin" }),
    });
    expect(none.status).toBe(403);
    // still only the dashboard's routes
    expect((await fetch(url("/v1/diag"), { headers: { "X-Walkie-Session": s } })).status).toBe(403);
    // and never a bearer
    expect((await fetch(url("/v1/me"), { headers: { Authorization: `Bearer ${s}` } })).status).toBe(401);
  });

  test("HIGH: a session value replayed as a cookie with a forged Origin authorizes nothing (reads included)", async () => {
    const s = await session();
    const jar = { Cookie: `walkie_s_${port()}=${s}` };
    expect((await fetch(url("/v1/events"), { headers: jar })).status).toBe(401);
    expect((await fetch(url("/v1/me"), { headers: jar })).status).toBe(401);
    expect((await fetch(url("/v1/stream"), { headers: jar })).status).toBe(401);
    expect((await invite({ ...jar, Origin: origin() })).status).toBe(401);
    expect(alex.d.core.roster.members.has("mallory@example.com")).toBe(false);
    // the header, not the cookie, is the credential
    expect((await fetch(url("/v1/events"), { headers: { "X-Walkie-Session": s } })).status).toBe(200);
  });

  test("a legacy cookie on any response is cleared", async () => {
    const s = await session();
    const res = await fetch(url("/v1/me"), { headers: { "X-Walkie-Session": s, Cookie: `walkie_token=${"a".repeat(64)}; walkie_s_${port()}=${s}` } });
    expect(res.status).toBe(200);
    const cleared = res.headers.getSetCookie();
    expect(cleared.some((l) => l.startsWith("walkie_token=;") && l.includes("Max-Age=0"))).toBe(true);
    expect(cleared.some((l) => l.startsWith(`walkie_s_${port()}=;`) && l.includes("Max-Age=0"))).toBe(true);
    const page = await fetch(url("/"), { headers: { Cookie: `walkie_token=${"a".repeat(64)}` } });
    expect(page.headers.getSetCookie().some((l) => l.startsWith("walkie_token=;"))).toBe(true);
    // no cookie, no Set-Cookie noise
    expect((await fetch(url("/v1/me"), { headers: { "X-Walkie-Session": s } })).headers.getSetCookie()).toEqual([]);
  });

  test("the dashboard stream takes the header; logout with the header closes it", async () => {
    const s = await session();
    const ac = new AbortController();
    const stream = await fetch(url("/v1/stream"), { headers: { "X-Walkie-Session": s }, signal: ac.signal });
    expect(stream.status).toBe(200);
    const body = stream.body as ReadableStream<Uint8Array>;
    expect((await readUntil(body, (t) => t.includes("event: hello"))).text).toContain("event: hello");
    expect((await fetch(url("/auth/logout"), { method: "POST", headers: { "X-Walkie-Session": s, Origin: "http://evil.example" } })).status).toBe(403);
    // a cookie is not how logout finds the session either
    expect((await fetch(url("/auth/logout"), { method: "POST", headers: { Cookie: `walkie_s_${port()}=${s}`, Origin: origin() } })).status).toBe(204);
    expect((await fetch(url("/v1/me"), { headers: { "X-Walkie-Session": s } })).status).toBe(200);
    const out = await fetch(url("/auth/logout"), { method: "POST", headers: { "X-Walkie-Session": s, Origin: origin() } });
    expect(out.status).toBe(204);
    expect((await fetch(url("/v1/me"), { headers: { "X-Walkie-Session": s } })).status).toBe(401);
    const end = await readUntil(body, () => false, 3_000);
    ac.abort();
    expect(end.done).toBe(true);
  });
});

describe("SEC-COOKIE-2: invite never changes an existing member's role", () => {
  test("re-inviting a current member is refused (409); the member route still changes roles", async () => {
    await alex.client().invite("bea@example.com", "bea", "member");
    await expect(alex.client().invite("bea@example.com", "bea", "owner")).rejects.toMatchObject({ status: 409 });
    expect(alex.d.core.roster.members.get("bea@example.com")?.role).toBe("member");
    // a dashboard session can't reach the role route at all
    const s = await session();
    const viaSession = await fetch(url("/v1/team/member"), {
      method: "POST", headers: { "X-Walkie-Session": s, Origin: origin(), "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "bea", role: "owner" }),
    });
    expect(viaSession.status).toBe(403);
    await alex.client().setRole("bea", "observer");
    expect(alex.d.core.roster.members.get("bea@example.com")?.role).toBe("observer");
    // a removed member may be invited again (that is how a person is re-admitted)
    await alex.client().setRole("bea", "removed");
    expect((await alex.client().invite("bea@example.com", "bea", "member")).event.kind).toBe("team.member");
    expect(alex.d.core.roster.members.get("bea@example.com")?.role).toBe("member");
  });
});

describe("SEC-COOKIE-2: rotation closes what the old token opened", () => {
  test("an old-bearer stream ends before a post made after rotation reaches it", async () => {
    const old = alex.d.token;
    const ac = new AbortController();
    const stream = await fetch(url("/v1/stream"), { headers: { Authorization: `Bearer ${old}` }, signal: ac.signal });
    expect(stream.status).toBe(200);
    const body = stream.body as ReadableStream<Uint8Array>;
    await readUntil(body, (t) => t.includes("event: hello"));
    await alex.client().rotateToken();
    const marker = `after-rotation-${Date.now()}`;
    await alex.client().post({ channel: "general", text: marker });
    const rest = await readUntil(body, (t) => t.includes(marker), 3_000);
    ac.abort();
    expect(rest.text).not.toContain(marker);
    expect(rest.done).toBe(true);
    // the new token still streams
    const ac2 = new AbortController();
    const fresh = await fetch(url("/v1/stream"), { headers: { Authorization: `Bearer ${alex.d.token}` }, signal: ac2.signal });
    expect(fresh.status).toBe(200);
    ac2.abort();
  });
});

describe("SEC-COOKIE-2: the pre-upgrade token is rotated once, automatically", () => {
  test("first start of the upgraded daemon replaces local.token; later starts keep it", async () => {
    const node = await c.add({ name: "upg", login: "upg@example.com", hostname: "upg-mbp" });
    const tokenPath = node.d.paths.token;
    await node.stop();
    // a v0.1.3 home: a token that has been in browser cookies, and no rotation marker
    const leaked = "b".repeat(64);
    writeFileSync(tokenPath, leaked + "\n", { mode: 0o600 });
    const marker = join(node.home, "local.token.rotated");
    expect(existsSync(marker)).toBe(true); // the first start (fresh home) marked it
    const { rmSync } = await import("node:fs");
    rmSync(marker);
    await node.start();
    const now = readFileSync(tokenPath, "utf8").trim();
    expect(now).toMatch(/^[0-9a-f]{64}$/);
    expect(now).not.toBe(leaked);
    expect(node.d.token).toBe(now);
    expect(existsSync(marker)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${node.d.localPort}/v1/me`, { headers: { Authorization: `Bearer ${leaked}` } })).status).toBe(401);
    await node.restart();
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(now); // once only
    await node.stop();
  });
});
