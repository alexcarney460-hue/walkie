import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signEvent } from "../../src/daemon/keys.ts";
import { eventId } from "../../src/protocol/ids.ts";
import { PROTOCOL_VERSION, type UnsignedEvent } from "../../src/protocol/schemas.ts";
import { Cluster, standardTeam, TEST_LIMITS, waitFor, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode, kira: TestNode, kira2: TestNode, eve: TestNode;

beforeAll(async () => {
  c = new Cluster();
  ({ alex, kira, kira2 } = await standardTeam(c));
  eve = await c.add({ name: "eve", login: "eve@evil.example", hostname: "eve-box" });
});
afterAll(async () => { await c.close(); });

function peerFetch(target: TestNode, as: TestNode, path: string, init: RequestInit = {}): Promise<Response> {
  const team = alex.d.core.teamId ?? "";
  return fetch(`http://127.0.0.1:${target.peerPort}${path}`, {
    ...init,
    headers: { "X-Walkie-Node": as.d.nodeId, "X-Walkie-Team": team, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("peer API gate", () => {
  test("an outsider login gets 403 on every peer endpoint", async () => {
    const origin = alex.d.nodeId;
    const probes: [string, RequestInit][] = [
      ["/peer/v1/hello", {}],
      ["/peer/v1/join", { method: "POST", body: JSON.stringify({ pubkey: eve.d.core.keys.pubkey, hostname: "eve", ip: "127.0.0.1" }) }],
      ["/peer/v1/vv", {}],
      [`/peer/v1/events?origin=${origin}&after=0&limit=10`, {}],
      ["/peer/v1/events", { method: "POST", body: JSON.stringify({ events: [] }) }],
      [`/peer/v1/blobs/${"a".repeat(64)}`, {}],
    ];
    for (const [path, init] of probes) {
      const res = await peerFetch(alex, eve, path, init);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    const joined = await eve.client().join(alex.peerAddr);
    expect(joined).toMatchObject({ admitted: false, reason: "not_member" });
  });

  test("a member's unadmitted node can hello/join but not read", async () => {
    const res = await peerFetch(alex, kira, "/peer/v1/vv");
    expect(res.status).toBe(200);
    const stranger = await c.add({ name: "kira3", login: "kira@example.com", hostname: "kiras-pi" });
    expect((await peerFetch(alex, stranger, "/peer/v1/hello")).status).toBe(200);
    expect((await peerFetch(alex, stranger, "/peer/v1/vv")).status).toBe(403);
    await stranger.stop();
  });

  test("team header mismatch is 409", async () => {
    const res = await peerFetch(alex, kira, "/peer/v1/vv", { headers: { "X-Walkie-Team": "ffffffffffffffff" } });
    expect(res.status).toBe(409);
  });

  test("forged events are rejected: bad sig, wrong author handle, non-authority team.member", async () => {
    const team = alex.d.core.teamId as string;
    const kk = kira.d.core.keys;
    const base = (seq: number, over: Partial<UnsignedEvent> = {}): UnsignedEvent => ({
      v: PROTOCOL_VERSION, team, id: eventId(kk.nodeId, seq), origin: kk.nodeId, seq, ts: Date.now(),
      author: { handle: "kira", node: kk.nodeId }, kind: "msg.post", channel: "general", body: { text: "forged" }, ...over,
    });
    const badSig = signEvent(eve.d.core.keys, base(10_001));
    const wrongHandle = signEvent(kk, base(10_002, { author: { handle: "alex", node: kk.nodeId } }));
    const notOwner = signEvent(kk, base(10_003, {
      kind: "team.member", channel: undefined, body: { login: "eve@evil.example", handle: "eve", role: "owner" },
    }));
    const res = await peerFetch(alex, kira, "/peer/v1/events", { method: "POST", body: JSON.stringify({ events: [badSig, wrongHandle, notOwner] }) });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { accepted: number; rejected: { id: string; reason: string }[] };
    expect(out.accepted).toBe(0);
    expect(out.rejected.map((r) => r.reason)).toEqual(["bad_signature", "author_handle_mismatch", "not_authority"]);
    expect(alex.d.core.roster.members.has("eve@evil.example")).toBe(false);
    const visible = await alex.client().events({ channel: "general", limit: 500 });
    expect(visible.events.some((e) => (e.body as { text?: string }).text === "forged")).toBe(false);
  });

  test("oversized peer body is refused", async () => {
    const res = await peerFetch(alex, kira, "/peer/v1/events", { method: "POST", body: "x".repeat(1_100_000) });
    expect([413, 400]).toContain(res.status);
  });
});

describe("restricted channels", () => {
  test("non-member peer gets stubs only and can't read via its local API", async () => {
    await alex.client().channel({ name: "secret", members: ["alex"] });
    const { event } = await alex.client().post({ channel: "secret", text: "the eagle lands at noon" });
    await waitFor(() => kira.d.core.store.getRow(event.id), { what: "stub on kira" });
    const row = kira.d.core.store.getRow(event.id);
    expect(row?.redacted).toBe(1);
    expect(row?.json).not.toContain("eagle");
    // local API on the non-member node
    expect((await kira.client().events({ channel: "secret" })).events).toEqual([]);
    await expect(kira.client().event(event.id)).rejects.toMatchObject({ status: 404 });
    expect((await kira.client().team()).channels.map((ch) => ch.name)).not.toContain("secret");
    await expect(kira.client().post({ channel: "secret", text: "let me in" })).rejects.toMatchObject({ status: 403 });
    // pull path serves a stub too
    const pulled = await peerFetch(alex, kira2, `/peer/v1/events?origin=${alex.d.nodeId}&after=${event.seq - 1}&limit=1`);
    const body = (await pulled.json()) as { events: Record<string, unknown>[] };
    // Stubs carry the signed header (D3), never the body.
    expect(body.events[0]).toEqual({
      id: event.id, origin: event.origin, seq: event.seq, ts: event.ts, kind: "msg.post", redacted: true, channel: "secret", hsig: event.hsig,
    });
    // contiguity still holds on the non-member
    await waitFor(() => kira2.d.core.store.vvOf(alex.d.nodeId) >= event.seq, { what: "kira2 vv past stub" });
    // the member reads it
    expect((await alex.client().events({ channel: "secret" })).events[0]?.id).toBe(event.id);
  });
});

describe("local loopback API", () => {
  const url = (n: TestNode, p: string) => `http://127.0.0.1:${n.d.localPort}${p}`;

  test("rejects missing token, bad Host and bad Origin", async () => {
    expect((await fetch(url(alex, "/v1/me"))).status).toBe(401);
    const auth = { Authorization: `Bearer ${alex.d.token}` };
    expect((await fetch(url(alex, "/v1/me"), { headers: auth })).status).toBe(200);
    expect((await fetch(url(alex, "/v1/me"), { headers: { ...auth, Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(url(alex, "/v1/me"), { headers: { ...auth, Host: `evil.example:${alex.d.localPort}` } })).status).toBe(403);
    const post = (headers: Record<string, string>) => fetch(url(alex, "/v1/post"), {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ channel: "general", text: "via loopback" }),
    });
    expect((await post({ ...auth, Origin: "http://evil.example" })).status).toBe(403);
    expect((await post({ ...auth, Origin: `http://127.0.0.1:${alex.d.localPort}` })).status).toBe(200);
  });

  test("/auth takes a one-shot nonce from the unix socket (never the token) and hands the page a session in the fragment; session writes need Origin", async () => {
    // FINAL Fable 5: the token is refused on the URL; a nonce is minted over the unix socket only, and works once.
    expect((await fetch(url(alex, `/auth?token=${alex.d.token}`), { redirect: "manual" })).status).toBe(401);
    expect((await fetch(url(alex, "/v1/auth/nonce"), { method: "POST", headers: { Authorization: `Bearer ${alex.d.token}` } })).status).toBe(403);
    const { nonce, expires_at } = await alex.client().authNonce();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(expires_at - Date.now()).toBeLessThanOrEqual(60_000);
    const res = await fetch(url(alex, `/auth?nonce=${nonce}`), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect((await fetch(url(alex, `/auth?nonce=${nonce}`), { redirect: "manual" })).status).toBe(401); // single use
    // SEC-COOKIE-2: no cookie carries the session (every Set-Cookie only clears an old one)
    for (const line of res.headers.getSetCookie()) expect(line).toContain("Max-Age=0");
    const value = /^\/#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
    const sess = { "X-Walkie-Session": value }; // a dashboard session, never the token (WALKIE-SEC-COOKIE-1)
    expect((await fetch(url(alex, "/v1/me"), { headers: sess })).status).toBe(200);
    const write = (extra: Record<string, string>) => fetch(url(alex, "/v1/post"), {
      method: "POST", headers: { ...sess, "Content-Type": "application/json", ...extra }, body: JSON.stringify({ channel: "general", text: "session" }),
    });
    expect((await write({})).status).toBe(403);
    expect((await write({ Origin: "http://evil.example" })).status).toBe(403);
    expect((await write({ Origin: `http://localhost:${alex.d.localPort}` })).status).toBe(200);
    expect((await fetch(url(alex, "/auth?nonce=" + "0".repeat(64)), { redirect: "manual" })).status).toBe(401);
    expect((await fetch(url(alex, "/auth?token=wrong"), { redirect: "manual" })).status).toBe(401);
  });

  test("dashboard static route serves with CSP (placeholder when web/dist is missing)", async () => {
    const res = await fetch(url(alex, "/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await res.text()).toContain("Walkie");
  });

  test("unix socket is mode 0600", async () => {
    const { statSync } = await import("node:fs");
    expect(statSync(alex.socket).mode & 0o777).toBe(0o600);
  });
});

describe("rate limiting and SSE", () => {
  test("peer API rate limit returns 429 (checked before whois)", async () => {
    const c2 = new Cluster();
    try {
      const strict = await c2.add({ name: "strict", login: "s@example.com", limits: { ...TEST_LIMITS, peer: { capacity: 5, perSecond: 1 } } });
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await fetch(`http://127.0.0.1:${strict.peerPort}/peer/v1/hello`)).status);
      expect(statuses.slice(0, 5).every((s) => s === 403)).toBe(true);
      expect(statuses.slice(5)).toEqual([429, 429, 429]);
    } finally {
      await c2.close();
    }
  });


  test("agent write limit returns 429", async () => {
    const cl = kira.client("spammer");
    let limited = 0;
    for (let i = 0; i < 22; i++) {
      try { await cl.post({ channel: "general", text: `spam ${i}` }); } catch (err) { if ((err as { status?: number }).status === 429) limited++; }
    }
    expect(limited).toBeGreaterThanOrEqual(2);
  });

  test("SSE stream delivers an event within 100 ms", async () => {
    const ac = new AbortController();
    const it = alex.client().stream(["general"], ac.signal);
    const first = await it.next();
    expect(first.value?.type).toBe("hello");
    let sentAt = 0;
    const got = (async () => {
      for await (const m of it) if (m.type === "event" && (m.event.body as { text?: string }).text === "sse ping") return performance.now() - sentAt;
      return Infinity;
    })();
    await Bun.sleep(20);
    sentAt = performance.now();
    await alex.client().post({ channel: "general", text: "sse ping" });
    const ms = await got;
    ac.abort();
    console.log(`[metric] SSE delivery (local post → stream): ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(100);
  });

  test("SSE carries remote events too", async () => {
    const ac = new AbortController();
    const it = alex.client().stream(undefined, ac.signal);
    await it.next();
    const t0 = performance.now();
    const got = (async () => {
      for await (const m of it) if (m.type === "event" && (m.event.body as { text?: string }).text === "from kira") return performance.now() - t0;
      return Infinity;
    })();
    await kira.client().post({ channel: "general", text: "from kira" });
    const ms = await got;
    ac.abort();
    console.log(`[metric] cross-node post → SSE on other node: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1000);
  });
});

describe("removal", () => {
  test("a removed member's node is refused and its new events rejected", async () => {
    await alex.client().setRole("kira", "removed");
    const res = await peerFetch(alex, kira, "/peer/v1/vv");
    expect(res.status).toBe(403);
    await waitFor(() => kira.d.core.me() === null, { what: "kira sees own removal", timeoutMs: 4_000 });
    await expect(kira.client().post({ channel: "general", text: "still here?" })).rejects.toMatchObject({ status: 403 });
  });
});
