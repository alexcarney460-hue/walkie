// WALKIE-PWA-1 fix round 1 (Codex + Opus audits): eviction with an open stream, a hostile relay against the
// daemon, deadlines, per-device concurrency, the phone's data projections, the real EventId route, the phone's own
// write bucket, and pairing from the unix socket.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hkdfKey, pairingKeys, phoneHello, roomOf, unb64u } from "../../src/mobile/crypto.ts";
import { MobileLink, type Registered } from "../../src/mobile/client.ts";
import { DEVICE_MAX } from "../../src/daemon/mobile/devices.ts";
import { startRelay, type RelayHandle } from "../../src/relay/server.ts";
import { MAX_FRAME } from "../../src/mobile/wire.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { testVendor } from "../helpers/license.ts";

const APP = "http://127.0.0.1:1/m";
const vendor = testVendor();
let c: Cluster;
let alex: TestNode;
let relay: RelayHandle;
let relayUrl: string;

beforeAll(async () => {
  relay = startRelay({ port: 0, hostname: "127.0.0.1", connectRate: { capacity: 1_000, perSecond: 1_000 }, perIpConnections: 1_000 });
  relayUrl = `ws://127.0.0.1:${relay.port}`;
  c = new Cluster();
  alex = await c.add({
    name: "alex", login: "alex@example.com", hostname: "alex-mbp", licenseVerifier: vendor.verify,
    mobile: { relayUrl, appUrl: APP, timeouts: { authMs: 400, registerMs: 800, heartbeatMs: 100 } },
  });
  await alex.client().init("acme", "alex");
});
afterAll(async () => {
  await c.close();
  relay.stop();
});

const secretOf = (url: string) => (/#pair=([A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22})/.exec(url) as RegExpExecArray)[1] as string;

async function pairPhone(node: TestNode, name = "Phone", url = relayUrl): Promise<Registered> {
  const p = await node.client().mobilePair();
  const k = await pairingKeys(secretOf(p.url));
  const link = await MobileLink.open({ relay: url, room: k.room, kid: "pair", psk: k.psk });
  const reg = await link.register(name);
  link.close();
  return reg;
}

const deviceLink = async (reg: Registered, url = relayUrl) =>
  MobileLink.open({ relay: url, room: reg.room, kid: `d:${reg.device.id}`, psk: await hkdfKey(unb64u(reg.key)) });

describe("eviction (Codex HIGH 1 / Opus 1)", () => {
  test("pairing a ninth device evicts the least recently used one: its open stream ends, it is unlisted and its room is gone", async () => {
    await alex.client().mobileRevokeAll();
    const first = await pairPhone(alex, "oldest");
    const link = await deviceLink(first);
    const got: string[] = [];
    const ended = new Promise<void>((resolve) => { link.onClose = () => resolve(); });
    link.stream("/v1/stream", (type) => got.push(type), () => undefined);
    await waitFor(() => got.includes("hello"), { what: "stream open" });
    await Bun.sleep(20); // the others are used more recently
    for (let i = 0; i < DEVICE_MAX; i++) await pairPhone(alex, `p${i}`);
    await ended; // the evicted device's link (and its stream) closed
    const before = got.length;
    await alex.client().post({ channel: "general", text: "after eviction" });
    await Bun.sleep(200);
    expect(got.length).toBe(before); // nothing more reached it
    const s = await alex.client().mobile();
    expect(s.devices.map((d) => d.id)).not.toContain(first.device.id);
    expect(s.devices.length).toBe(DEVICE_MAX);
    await waitFor(async () => (await deviceLink(first).then(() => null, (e: { code: number | null }) => e))?.code === 4404, { what: "room released" });
    await expect(alex.client().mobileRevoke(first.device.id)).rejects.toMatchObject({ status: 404 });
    await alex.client().mobileRevokeAll();
  });
});

describe("deadlines and per-device limits", () => {
  test("a hello with a device's key id but no key: the link is dropped at the authentication deadline", async () => {
    const reg = await pairPhone(alex);
    const ws = new WebSocket(`${relayUrl}/v1/phone?room=${reg.room}`);
    ws.binaryType = "arraybuffer";
    const closed = new Promise<number>((resolve) => { ws.onclose = (e) => resolve(e.code); });
    await new Promise((resolve) => { ws.onopen = resolve; });
    const h = await phoneHello(`d:${reg.device.id}`);
    ws.send(h.frame); // the daemon answers; this "phone" never proves it holds the key
    expect(await closed).toBe(4403);
    await alex.client().mobileRevokeAll();
  });

  test("a pairing link that completes the handshake but never sends an encrypted message is dropped at the deadline", async () => {
    const p = await alex.client().mobilePair();
    const k = await pairingKeys(secretOf(p.url));
    const link = await MobileLink.open({ relay: relayUrl, room: k.room, kid: "pair", psk: k.psk });
    const closed = new Promise<number | null>((resolve) => { link.onClose = (e) => resolve(e.code); });
    expect(await closed).toBe(4403);
    await alex.client().mobileRevokeAll();
  });

  test("streams are limited per device, across all of its connections", async () => {
    const reg = await pairPhone(alex);
    const links = [await deviceLink(reg), await deviceLink(reg), await deviceLink(reg)];
    const outcomes: string[] = [];
    for (const l of links) {
      for (let i = 0; i < 2; i++) {
        l.stream("/v1/stream", (type) => { if (type === "hello") outcomes.push("open"); }, (e) => { if (e) outcomes.push(String(e.code)); });
      }
    }
    await waitFor(() => outcomes.length >= 6, { what: "six stream outcomes" });
    expect(outcomes.filter((o) => o === "open").length).toBe(2);
    expect(outcomes.filter((o) => o === "429").length).toBe(4);
    for (const l of links) l.close();
    await alex.client().mobileRevokeAll();
  });
});

describe("staleness (Codex MED 8)", () => {
  test("the daemon's authenticated heartbeat keeps the link fresh; silence closes it as stale", async () => {
    const reg = await pairPhone(alex);
    const link = await deviceLink(reg);
    const t0 = link.lastFrameAt;
    await Bun.sleep(350);
    expect(link.lastFrameAt).toBeGreaterThan(t0); // pings (every 100 ms here) arrive with nothing else going on
    link.watch(250);
    await Bun.sleep(400);
    expect(link.isOpen).toBe(true); // heartbeats keep it alive
    const stale = await deviceLink(reg);
    const closed = new Promise<number | null>((resolve) => { stale.onClose = (e) => resolve(e.code); });
    stale.watch(1); // nothing can arrive within 1 ms: the watchdog closes it
    expect(await closed).toBe(4408);
    link.close();
    await alex.client().mobileRevokeAll();
  });

  test("a relay that swallows frames: the request resolves as 504 at its deadline", async () => {
    const reg = await pairPhone(alex);
    let swallow = false;
    class Swallow extends WebSocket {
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void { if (!swallow) super.send(data as string); }
    }
    const link = await MobileLink.open({ relay: relayUrl, room: reg.room, kid: `d:${reg.device.id}`, psk: await hkdfKey(unb64u(reg.key)), WebSocket: Swallow as unknown as typeof WebSocket });
    expect((await link.request("GET", "/v1/me")).status).toBe(200);
    swallow = true;
    const r = await link.request("GET", "/v1/agents", undefined, 200);
    expect(r.status).toBe(504);
    link.close();
    await alex.client().mobileRevokeAll();
  });
});

describe("round 2: pairing rooms, stream budgets, phone limits, refresh notices", () => {
  test("abandoned pairing codes give their relay rooms up (20 mints with a phone paired: rooms stay bounded)", async () => {
    await alex.client().mobileRevokeAll();
    const reg = await pairPhone(alex);
    for (let i = 0; i < 20; i++) await alex.client().mobilePair();
    await waitFor(() => relay.stats().rooms <= 1 + 3, { what: "rooms bounded" });
    expect((await alex.client().mobile()).pairing).toBe(3);
    const link = await deviceLink(reg); // the device room still works
    expect((await link.request("GET", "/v1/me")).status).toBe(200);
    link.close();
    await alex.client().mobileRevokeAll();
  });

  test("a live stream that outruns the device's byte budget is ended with a resync, not queued", async () => {
    const carol = await c.add({
      name: "carol", login: "carol@example.com", hostname: "carol-mbp",
      mobile: { relayUrl, appUrl: APP, deviceBytes: { capacity: 12_000, perSecond: 1 } },
    });
    await carol.client().init("carols", "carol");
    const reg = await pairPhone(carol);
    const link = await deviceLink(reg);
    let ended: { code: number | null; message: string } | null = null;
    let events = 0;
    link.stream("/v1/stream", (type) => { if (type === "event") events += 1; }, (e) => { ended = e ?? { code: 0, message: "" }; });
    await Bun.sleep(100);
    for (let i = 0; i < 40; i++) await carol.client().post({ channel: "general", text: `${"x".repeat(900)} ${i}` });
    const e = await waitFor(() => ended, { what: "stream ended" });
    expect(e.code).toBe(429);
    expect(e.message).toContain("fell behind");
    expect(events).toBeLessThan(40);
    const r = await link.request("GET", "/v1/me"); // over budget answers are small 429s, the link lives
    expect([200, 429]).toContain(r.status);
    expect(link.isOpen).toBe(true);
    link.close();
  });

  test("the live stream turns roster changes into a bare refresh notice", async () => {
    const reg = await pairPhone(alex);
    const link = await deviceLink(reg);
    const got: { type: string; data: unknown }[] = [];
    const cancel = link.stream("/v1/stream", (type, data) => got.push({ type, data }), () => undefined);
    await waitFor(() => got.some((m) => m.type === "hello"), { what: "hello" });
    await alex.client().channel({ name: "phone-news", topic: "secret topic" });
    const notice = await waitFor(() => got.find((m) => m.type === "refresh"), { what: "refresh" });
    expect(notice.data).toEqual({ what: "channels" });
    expect(JSON.stringify(got)).not.toContain("secret topic");
    cancel();
    link.close();
    await alex.client().mobileRevokeAll();
  });

  test("the phone refuses oversized frames and floods before keeping them", async () => {
    const reg = await pairPhone(alex);
    let sock: Inject | null = null;
    class Inject extends WebSocket {
      constructor(url: string | URL) { super(url); sock = this; } // eslint-disable-line @typescript-eslint/no-this-alias
      deliver(buf: ArrayBuffer) { this.onmessage?.(new MessageEvent("message", { data: buf })); }
    }
    const open = async () => {
      const l = await MobileLink.open({ relay: relayUrl, room: reg.room, kid: `d:${reg.device.id}`, psk: await hkdfKey(unb64u(reg.key)), WebSocket: Inject as unknown as typeof WebSocket });
      const closed = new Promise<number | null>((resolve) => { l.onClose = (e) => resolve(e.code); });
      return { l, closed, s: sock as unknown as Inject };
    };
    const a = await open();
    a.s.deliver(new ArrayBuffer(MAX_FRAME + 1));
    expect(await a.closed).toBe(4400);
    const b = await open();
    for (let i = 0; i < 300 && b.l.isOpen; i++) b.s.deliver(new ArrayBuffer(64)); // queued faster than decrypted
    expect(await b.closed).toBe(4429);
    await alex.client().mobileRevokeAll();
  });

  test("handshakes are budgeted per room first: one room's burst doesn't lock another device out", async () => {
    const a = await pairPhone(alex, "A");
    const b = await pairPhone(alex, "B");
    const outcomes: string[] = [];
    for (let i = 0; i < 14; i++) {
      await deviceLink(a).then((l) => { outcomes.push("ok"); l.close(); }, (e: { code: number | null }) => outcomes.push(String(e.code)));
    }
    expect(outcomes.filter((o) => o === "ok").length).toBeLessThanOrEqual(10);
    // turned away by the relay's per-room join budget (4429) or the daemon's per-room handshake budget (4403)
    expect(outcomes.some((o) => o === "4403" || o === "4429")).toBe(true);
    const lb = await deviceLink(b);
    expect((await lb.request("GET", "/v1/me")).status).toBe(200);
    lb.close();
    await alex.client().mobileRevokeAll();
  });

  test("a device reconnecting into a reused slot keeps working after another device is revoked", async () => {
    const a = await pairPhone(alex, "A");
    const b = await pairPhone(alex, "B");
    const la = await deviceLink(a);
    await alex.client().mobileRevoke(a.device.id); // A's goodbye, kick and room release
    const lb = await deviceLink(b); // likely gets A's old slot at the relay
    for (let i = 0; i < 5; i++) expect((await lb.request("GET", "/v1/me")).status).toBe(200);
    expect(la.isOpen).toBe(false);
    lb.close();
    await alex.client().mobileRevokeAll();
  });
});

describe("round 3", () => {
  test("per-room budgets at the relay: join churn and pre-handshake floods in one room never cost another room's phone its link", async () => {
    const r3 = startRelay({ port: 0, hostname: "127.0.0.1", clientIpHeader: "fly-client-ip" });
    const url = `ws://127.0.0.1:${r3.port}`;
    const erin = await c.add({ name: "erin", login: "erin@example.com", hostname: "erin-mbp", mobile: { relayUrl: url, appUrl: APP } });
    try {
      await erin.client().init("erins", "erin");
      const a = await pairPhone(erin, "A", url);
      const b = await pairPhone(erin, "B", url);
      const lb = await deviceLink(b, url);
      const as = (ip: string) => new WebSocket(`${url}/v1/phone?room=${a.room}`, { headers: { "fly-client-ip": ip } } as unknown as string[]);
      // 36 connect/close cycles into A's room from two addresses
      for (let i = 0; i < 36; i++) {
        const ws = as(i % 2 ? "10.0.0.1" : "10.0.0.2");
        await new Promise((resolve) => { ws.onopen = resolve; ws.onclose = resolve; });
        ws.close();
      }
      // 4 sockets each sending 8 MiB without a handshake
      const floods = [0, 1, 2, 3].map((i) => as(`10.0.1.${i}`));
      await Promise.all(floods.map((ws) => new Promise((resolve) => { ws.onopen = resolve; ws.onclose = resolve; })));
      for (const ws of floods) {
        ws.binaryType = "arraybuffer";
        for (let j = 0; j < 8 && ws.readyState === WebSocket.OPEN; j++) ws.send(new Uint8Array(MAX_FRAME));
      }
      await Bun.sleep(500);
      expect(erin.d.mobile.violations).toBe(0); // the daemon's link never tripped
      expect((await erin.client().mobile()).linked).toBe(true);
      expect(lb.isOpen).toBe(true);
      for (let i = 0; i < 3; i++) expect((await lb.request("GET", "/v1/me")).status).toBe(200);
      lb.close();
    } finally {
      await erin.stop();
      r3.stop();
    }
  });

  test("the response cap applies to the projected payload: too many posts answer 413, fewer answer 200", async () => {
    const reg = await pairPhone(alex);
    const link = await deviceLink(reg);
    await alex.client().channel({ name: "bulk" });
    for (let i = 0; i < 100; i++) await alex.client().post({ channel: "bulk", text: `${"é".repeat(1_400)} ${i}` }); // ~2.8 KB each encoded
    expect((await link.request("GET", "/v1/events?channel=bulk&kinds=msg.post&limit=100")).status).toBe(413);
    expect((await link.request("GET", "/v1/events?channel=bulk&kinds=msg.post&limit=20")).status).toBe(200);
    // and request bodies are measured in encoded bytes: 40 000 four-byte characters are 160 KB
    expect((await link.request("POST", "/v1/post", { channel: "general", text: "😀".repeat(20_000) })).status).toBe(413);
    link.close();
    await alex.client().mobileRevokeAll();
  });

  test("a registration that fails (the device room isn't confirmed in time) still gives the pairing room up", async () => {
    const slow = startRelay({
      port: 0, hostname: "127.0.0.1",
      roomOf: async (key) => { await Bun.sleep(300); return roomOf(key); },
    });
    const url = `ws://127.0.0.1:${slow.port}`;
    const fay = await c.add({ name: "fay", login: "fay@example.com", hostname: "fay-mbp", mobile: { relayUrl: url, appUrl: APP, timeouts: { roomMs: 100 } } });
    try {
      await fay.client().init("fays", "fay");
      const p = await fay.client().mobilePair();
      const k = await pairingKeys(secretOf(p.url));
      const link = await MobileLink.open({ relay: url, room: k.room, kid: "pair", psk: k.psk });
      await expect(link.register("Phone")).rejects.toThrow();
      await waitFor(() => slow.stats().rooms === 0, { what: "pairing and device rooms released" });
      expect((await fay.client().mobile()).devices).toEqual([]);
    } finally {
      await fay.stop();
      slow.stop();
    }
  });

  test("the phone closes on a text frame, and an open settles only after its first encrypted ping is out", async () => {
    const reg = await pairPhone(alex);
    let sock: TextInject | null = null;
    class TextInject extends WebSocket {
      constructor(u: string | URL) { super(u); sock = this; } // eslint-disable-line @typescript-eslint/no-this-alias
      deliver(d: string) { this.onmessage?.(new MessageEvent("message", { data: d })); }
    }
    const l = await MobileLink.open({ relay: relayUrl, room: reg.room, kid: `d:${reg.device.id}`, psk: await hkdfKey(unb64u(reg.key)), WebSocket: TextInject as unknown as typeof WebSocket });
    const closed = new Promise<number | null>((resolve) => { l.onClose = (e) => resolve(e.code); });
    (sock as unknown as TextInject).deliver("hello");
    expect(await closed).toBe(4400);
    // a socket that dies while the ping is being sent: the open rejects (it used to hang forever)
    let sends = 0;
    class DiesOnPing extends WebSocket {
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (++sends === 2) { this.close(); throw new Error("closed"); }
        super.send(data as string);
      }
    }
    const opened = MobileLink.open({ relay: relayUrl, room: reg.room, kid: `d:${reg.device.id}`, psk: await hkdfKey(unb64u(reg.key)), WebSocket: DiesOnPing as unknown as typeof WebSocket, timeoutMs: 60_000 });
    const outcome = await Promise.race([opened.then(() => "resolved", () => "rejected"), Bun.sleep(3_000).then(() => "pending")]);
    expect(outcome).toBe("rejected");
    await alex.client().mobileRevokeAll();
  });
});

/** A TCP proxy passing daemon → relay at `rate` bytes/s (relay → daemon unthrottled): a slow home uplink. */
async function slowUplink(targetPort: number, rate: number): Promise<{ url: string; stop: () => void }> {
  const net = await import("node:net");
  const ends: (() => void)[] = [];
  const proxy = net.createServer((down) => {
    const up = net.connect(targetPort, "127.0.0.1");
    up.on("data", (d: Buffer) => down.write(d));
    const q: Buffer[] = [];
    let qBytes = 0;
    down.on("data", (d: Buffer) => { q.push(d); qBytes += d.length; if (qBytes > 256 * 1024) down.pause(); });
    const tick = setInterval(() => {
      let budget = rate / 20;
      while (budget > 0 && q.length) { const b = q[0] as Buffer; const k = Math.min(b.length, budget); up.write(b.subarray(0, k)); budget -= k; qBytes -= k; if (k === b.length) q.shift(); else q[0] = b.subarray(k); }
      if (qBytes < 128 * 1024) down.resume();
    }, 50);
    const end = () => { clearInterval(tick); up.destroy(); down.destroy(); };
    ends.push(end);
    up.on("close", end); down.on("close", end); up.on("error", end); down.on("error", end);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  return { url: `ws://127.0.0.1:${(proxy.address() as { port: number }).port}`, stop: () => { for (const e of ends) e(); proxy.close(); } };
}

describe("round 4", () => {
  test("sustained abuse of one room (churn + pre-handshake floods) over a slow uplink: another room's phone keeps working", async () => {
    const r4 = startRelay({ port: 0, hostname: "127.0.0.1", clientIpHeader: "fly-client-ip" });
    const url = `ws://127.0.0.1:${r4.port}`;
    const up = await slowUplink(r4.port, 256 * 1024);
    const gina = await c.add({ name: "gina", login: "gina@example.com", hostname: "gina-mbp", mobile: { relayUrl: up.url, appUrl: APP } });
    let ipn = 0;
    const ip = () => `10.9.${(ipn >> 8) & 255}.${ipn++ & 255}`;
    class Addressed extends WebSocket { constructor(u: string | URL) { super(u, { headers: { "fly-client-ip": ip() } } as unknown as string[]); } }
    try {
      await gina.client().init("ginas", "gina");
      const pairVia = async () => {
        const p = await gina.client().mobilePair();
        const k = await pairingKeys(secretOf(p.url));
        const l = await MobileLink.open({ relay: url, room: k.room, kid: "pair", psk: k.psk, WebSocket: Addressed as unknown as typeof WebSocket });
        const reg = await l.register("x");
        l.close();
        return reg;
      };
      const a = await pairVia();
      const b = await pairVia();
      const lb = await MobileLink.open({ relay: url, room: b.room, kid: `d:${b.device.id}`, psk: await hkdfKey(unb64u(b.key)), WebSocket: Addressed as unknown as typeof WebSocket });
      let ok = 0;
      const bad: number[] = [];
      let stop = false;
      const poll = (async () => { while (!stop) { const x = await lb.request("GET", "/v1/me"); if (x.status === 200) ok += 1; else bad.push(x.status); await Bun.sleep(250); } })();
      const end = Date.now() + 8_000;
      while (Date.now() < end) {
        const ws = new Addressed(`${url}/v1/phone?room=${a.room}`);
        ws.binaryType = "arraybuffer";
        await new Promise((res) => { ws.onopen = res; ws.onclose = res; setTimeout(res, 1_000); });
        for (let j = 0; j < 8 && ws.readyState === WebSocket.OPEN; j++) ws.send(new Uint8Array(MAX_FRAME));
        await Bun.sleep(100);
        try { ws.close(); } catch { /* closed */ }
      }
      stop = true;
      await poll;
      expect(gina.d.mobile.violations).toBe(0);
      expect(lb.isOpen).toBe(true);
      expect(ok).toBeGreaterThan(20);
      expect(bad.length).toBeLessThanOrEqual(2);
      lb.close();
    } finally {
      await gina.stop();
      up.stop();
      r4.stop();
    }
  }, 60_000);

  test("long posts are cut for the phone (4 000 characters + a note), so even 5 of the longest fit one answer", async () => {
    const reg = await pairPhone(alex);
    const link = await deviceLink(reg);
    await alex.client().channel({ name: "long" });
    for (let i = 0; i < 5; i++) await alex.client().post({ channel: "long", text: `${"ж".repeat(31_990)}${i}` }); // ~64 KB each encoded
    const r = await link.request<{ events: { body: { text: string; truncated?: boolean } }[] }>("GET", "/v1/events?channel=long&kinds=msg.post&limit=5");
    expect(r.status).toBe(200);
    expect(r.body.events).toHaveLength(5);
    for (const e of r.body.events) {
      expect(e.body.truncated).toBe(true);
      expect(e.body.text.length).toBeLessThan(4_100);
      expect(e.body.text).toContain("open on your computer");
    }
    link.close();
    await alex.client().mobileRevokeAll();
  });

  test("open asks that don't fit one answer come back cut to what fits, marked truncated (never a 413)", async () => {
    const reg = await pairPhone(alex);
    const link = await deviceLink(reg);
    const kira = await c.add({ name: "kira4", login: "kira4@example.com", hostname: "kira4-mbp" });
    await alex.client().invite("kira4@example.com", "kira4", "member");
    const j = await kira.client().join(alex.peerAddr);
    expect(j.admitted).toBe(true);
    await waitFor(async () => (await kira.client().team()).members.some((m) => m.handle === "kira4"), { what: "kira4 synced" });
    await alex.client().channel({ name: "asks4" });
    await waitFor(async () => (await kira.client().team()).channels.some((ch) => ch.name === "asks4"), { what: "channel synced" });
    for (let i = 0; i < 90; i++) await kira.client().ask({ to: "@alex", text: `${"q".repeat(8_000)} ${i}`, channel: "asks4", timeout_s: 3_600 });
    const r = await waitFor(async () => {
      const x = await link.request<{ asks: unknown[]; truncated?: boolean }>("GET", "/v1/asks?state=open&to=me");
      return x.status === 200 && x.body.truncated ? x : null;
    }, { timeoutMs: 20_000, what: "asks cut to fit" });
    expect(r.body.asks.length).toBeGreaterThan(10);
    expect(r.body.asks.length).toBeLessThan(90);
    link.close();
    await kira.stop();
    await alex.client().mobileRevokeAll();
  });

  test("140 open asks of 31 000 characters (over 4 MiB raw): projected and fitted first, so a 200 with truncated, not a 413", async () => {
    const reg = await pairPhone(alex);
    const link = await deviceLink(reg);
    const kira = await c.add({ name: "kira5", login: "kira5@example.com", hostname: "kira5-mbp" });
    await alex.client().invite("kira5@example.com", "kira5", "member");
    const j = await kira.client().join(alex.peerAddr);
    expect(j.admitted).toBe(true);
    await waitFor(async () => (await kira.client().team()).members.some((m) => m.handle === "kira5"), { what: "kira5 synced" });
    await alex.client().channel({ name: "asks5" });
    await waitFor(async () => (await kira.client().team()).channels.some((ch) => ch.name === "asks5"), { what: "channel synced" });
    // spread over agents so no single writer's rate limit is what's being tested
    for (let i = 0; i < 140; i++) await kira.client(`asker${Math.floor(i / 18)}`).ask({ to: "@alex", text: `${"q".repeat(31_000)} ${i}`, channel: "asks5", timeout_s: 3_600 });
    await waitFor(async () => {
      const raw = await alex.client().asks({ state: "open", to: "me" });
      return raw.asks.length >= 140 ? raw : null;
    }, { timeoutMs: 30_000, what: "all asks synced" });
    const r = await link.request<{ asks: { ask: { body: { text: string; truncated?: boolean } } }[]; truncated?: boolean }>("GET", "/v1/asks?state=open&to=me");
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(true);
    expect(r.body.asks.length).toBeGreaterThan(10);
    for (const a of r.body.asks) expect(a.ask.body.truncated).toBe(true);
    link.close();
    await kira.stop();
    await alex.client().mobileRevokeAll();
  }, 90_000);

  test("360 open asks of 32 000 CJK characters (over 32 MiB raw, Codex r6 2): bounded at the source, a 200 with truncated, never a 413", async () => {
    const reg = await pairPhone(alex);
    const link = await deviceLink(reg);
    const kira = await c.add({ name: "kira6", login: "kira6@example.com", hostname: "kira6-mbp" });
    await alex.client().invite("kira6@example.com", "kira6", "member");
    const j = await kira.client().join(alex.peerAddr);
    expect(j.admitted).toBe(true);
    await waitFor(async () => (await kira.client().team()).members.some((m) => m.handle === "kira6"), { what: "kira6 synced" });
    await alex.client().channel({ name: "asks6" });
    await waitFor(async () => (await kira.client().team()).channels.some((ch) => ch.name === "asks6"), { what: "channel synced" });
    // spread over agents so no single writer's rate limit is what's being tested
    const cjk = "漢".repeat(31_990);
    for (let i = 0; i < 360; i++) await kira.client(`asker${Math.floor(i / 18)}`).ask({ to: "@alex", text: `${cjk} ${i}`, channel: "asks6", timeout_s: 3_600 });
    await waitFor(async () => {
      const raw = await alex.client().asks({ state: "open", to: "me" });
      return raw.asks.length >= 360 ? raw : null;
    }, { timeoutMs: 30_000, what: "all asks synced" });
    const r = await link.request<{ asks: { ask: { body: { text: string; truncated?: boolean } } }[]; truncated?: boolean }>("GET", "/v1/asks?state=open&to=me");
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(true);
    expect(r.body.asks.length).toBeGreaterThan(10);
    for (const a of r.body.asks) expect(a.ask.body.truncated).toBe(true);
    link.close();
    await kira.stop();
    await alex.client().mobileRevokeAll();
  }, 180_000);
});

describe("what the phone sees (Codex MED 6, Opus 5)", () => {
  let reg: Registered;
  let link: MobileLink;
  beforeAll(async () => {
    const team = (await alex.client().me()).team?.id as string;
    await alex.client().activateLicense(vendor.issue({ team, issued_at: Date.now(), expires_at: Date.now() + 30 * 86_400_000 }));
    reg = await pairPhone(alex);
    link = await deviceLink(reg);
  });
  afterAll(async () => { link.close(); await alex.client().mobileRevokeAll(); });

  test("no license, plan, roster or other event kinds; no plan, logins or addresses in me/team/peers", async () => {
    const lic = await link.request<{ events: { kind: string }[] }>("GET", "/v1/events?kinds=team.license");
    expect(lic.status).toBe(200);
    expect(lic.body.events).toEqual([]);
    const all = await link.request<{ events: { kind: string; sig?: string }[] }>("GET", "/v1/events?channel=general&limit=500");
    expect(all.body.events.every((e) => ["msg.post", "ask", "answer"].includes(e.kind))).toBe(true);
    expect(JSON.stringify(all.body)).not.toContain("\"sig\"");
    expect(all.body.events.length).toBeLessThanOrEqual(100);
    const me = await link.request<Record<string, unknown>>("GET", "/v1/me");
    expect(Object.keys(me.body).sort()).toEqual(["handle", "node", "role", "team", "version"]);
    const team = await link.request("GET", "/v1/team");
    const peers = await link.request("GET", "/v1/peers");
    for (const body of [me.body, team.body, peers.body]) {
      const text = JSON.stringify(body);
      for (const needle of ["plan", "license", "alex@example.com", "127.0.0.1", "\"ip\"", "authority"]) expect({ needle, found: text.includes(needle) }).toEqual({ needle, found: false });
    }
  });

  test("the live stream carries no license event and no plan", async () => {
    const got: { type: string; data: unknown }[] = [];
    const cancel = link.stream("/v1/stream", (type, data) => got.push({ type, data }), () => undefined);
    await waitFor(() => got.some((m) => m.type === "hello"), { what: "hello" });
    const team = (await alex.client().me()).team?.id as string;
    await alex.client().activateLicense(vendor.issue({ team, seats: 12, issued_at: Date.now(), expires_at: Date.now() + 31 * 86_400_000 }));
    await alex.client().post({ channel: "general", text: "marker after license" });
    await waitFor(() => got.some((m) => JSON.stringify(m.data).includes("marker after license")), { what: "post on stream" });
    cancel();
    const text = JSON.stringify(got);
    expect(text).not.toContain("team.license");
    expect(text).not.toContain("\"plan\"");
    expect(text).not.toContain("alex@example.com");
  });

  test("event detail takes a real EventId (with the colon); another kind's detail is a 404", async () => {
    const posted = await link.request<{ event: { id: string } }>("POST", "/v1/post", { channel: "general", text: "detail me" });
    expect(posted.body.event.id).toMatch(/^[0-9a-f]{16}:[1-9][0-9]*$/);
    const detail = await link.request<{ event: { id: string; body: { text: string } } }>("GET", `/v1/events/${posted.body.event.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.event.body.text).toBe("detail me");
    const roster = (await alex.client().events({ kinds: "team.create", limit: 1 })).events[0] as { id: string };
    expect((await link.request("GET", `/v1/events/${roster.id}`)).status).toBe(404);
  });

  test("raw and artifacts are stripped from a phone's post (redaction always applies)", async () => {
    const secret = ("sk" + "-ant-api03-") + "A".repeat(80);
    const r = await link.request<{ event: { body: { text: string; artifacts?: unknown } } }>("POST", "/v1/post", {
      channel: "general", text: `leak ${secret}`, raw: true, artifacts: ["a".repeat(64)],
    });
    expect(r.status).toBe(200);
    expect(r.body.event.body.text).not.toContain(secret);
    expect(r.body.event.body.artifacts).toBeUndefined();
  });

  test("a phone's writes use their own rate bucket, not the desktop person's", async () => {
    // exhaust the phone's bucket (60 per minute for a person), then the desktop still posts
    let limited = false;
    for (let i = 0; i < 70 && !limited; i++) {
      const r = await link.request("POST", "/v1/post", { channel: "general", text: `burst ${i}` });
      limited = r.status === 429;
    }
    expect(limited).toBe(true);
    expect((await alex.client().post({ channel: "general", text: "desktop unaffected" })).event).toBeTruthy();
  });
});

describe("pairing needs a person (Opus 7)", () => {
  test("an agent header is refused; without it the unix socket is the same-OS-user boundary (documented)", async () => {
    await expect(alex.client("claude").mobilePair()).rejects.toMatchObject({ status: 403 });
    expect((await alex.client().mobilePair()).code).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    await alex.client().mobileRevokeAll();
  });
});

// ---- a hostile relay ---------------------------------------------------------------------------------------------

interface Fake {
  port: number; sockets: ServerWebSocket<unknown>[]; rooms: string[]; closeOf: Map<ServerWebSocket<unknown>, number>; connects: number;
  /** Answer claims with a refusal instead of `opened`. */
  refuse: boolean;
  /** Stop echoing pings (a relay that stopped reading). */
  noPong: boolean;
  stop(): void;
}

/** Slot generations the fake relay hands out (joins name them; frames carry them). */
let gens = 0;
const joinMsg = (room: string, slot: number) => JSON.stringify({ t: "join", room, slot, gen: ++gens });
function slotFrame(slot: number, gen: number, payload: Uint8Array): Uint8Array {
  const b = new Uint8Array(payload.byteLength + 5);
  b[0] = slot;
  new DataView(b.buffer).setUint32(1, gen);
  b.set(payload, 5);
  return b;
}

function fakeRelay(): Fake {
  const f: Fake = { port: 0, sockets: [], rooms: [], closeOf: new Map(), connects: 0, refuse: false, noPong: false, stop: () => undefined };
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      maxPayloadLength: 8 * MAX_FRAME,
      open(ws) { f.connects += 1; f.sockets.push(ws); ws.send(JSON.stringify({ t: "hello", v: 2 })); },
      async message(ws, msg) {
        if (typeof msg !== "string") return;
        const m = JSON.parse(msg) as { t: string; key?: string; n?: string };
        if (m.t === "ping" && m.n) { if (!f.noPong) ws.send(JSON.stringify({ t: "pong", n: m.n })); return; }
        if (m.t === "open" && m.key) {
          const room = await roomOf(unb64u(m.key));
          f.rooms.push(room);
          ws.send(JSON.stringify(f.refuse ? { t: "error", message: "too many rooms", room } : { t: "opened", room }));
        }
      },
      close(ws, code) { f.closeOf.set(ws, code); },
    },
  });
  f.port = server.port as number;
  f.stop = () => server.stop(true);
  return f;
}

describe("a hostile relay can't exhaust the daemon (Codex HIGH 2)", () => {
  let fake: Fake;
  let bob: TestNode;
  beforeAll(async () => {
    fake = fakeRelay();
    bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bob-mbp", mobile: { relayUrl: `ws://127.0.0.1:${fake.port}`, appUrl: APP, stallMs: 1_500 } });
    await bob.client().init("bobs", "bob");
  });
  afterAll(() => fake.stop());

  async function linked(): Promise<{ ws: ServerWebSocket<unknown>; room: string }> {
    const before = fake.sockets.length;
    await bob.client().mobilePair();
    const ws = await waitFor(() => (fake.sockets.length > before ? fake.sockets.at(-1) : null), { what: "daemon connects" });
    const room = await waitFor(() => fake.rooms.at(-1), { what: "room claimed" });
    return { ws, room };
  }

  async function expectViolation(send: (ws: ServerWebSocket<unknown>, room: string) => void, what: string, orVoided = false): Promise<void> {
    const { ws, room } = await linked();
    const v = bob.d.mobile.violations;
    send(ws, room);
    const code = await waitFor(() => fake.closeOf.get(ws), { what: `${what}: link closed` });
    if (orVoided && code === 1000) {
      // Five joins that leave without registering voided the pairing first: with nothing left to serve, the daemon hung up.
      expect((await bob.client().mobile()).pairing).toBe(0);
    } else {
      expect(code).toBe(4400);
      expect(bob.d.mobile.violations).toBe(v + 1);
    }
    expect(bob.d.mobile.sessionCount).toBe(0);
    expect((await bob.client().me()).handle).toBe("bob"); // the daemon is fine
    await bob.client().mobileRevokeAll(); // stop wanting the link (the penalty backoff would delay the next test)
  }

  test("2,000 joins with distinct slots: the link is dropped at the first slot out of range, sessions stay bounded", async () => {
    await expectViolation((ws, room) => { for (let slot = 0; slot < 2_000; slot++) ws.send(joinMsg(room, slot)); }, "2000 joins");
  });

  test("a negative slot", async () => {
    await expectViolation((ws, room) => ws.send(joinMsg(room, -1)), "negative slot");
  });

  test("join churn within range: the link is dropped (join rate limit, or the pairing voided first)", async () => {
    await expectViolation((ws, room) => {
      for (let i = 0; i < 2_000; i++) { ws.send(joinMsg(room, 0)); ws.send(JSON.stringify({ t: "leave", slot: 0, gen: gens })); }
    }, "join churn", true);
  });

  test("frames at the size boundaries: an empty payload drops that phone only; a frame over the limit, or with no header, drops the link", async () => {
    const { ws, room } = await linked();
    const v = bob.d.mobile.violations;
    ws.send(joinMsg(room, 4));
    await waitFor(() => bob.d.mobile.sessionCount === 1, { what: "session 4" });
    ws.send(slotFrame(4, gens, new Uint8Array(0))); // a header and nothing else: that phone only
    await waitFor(() => bob.d.mobile.sessionCount === 0, { what: "slot 4 dropped" });
    expect(bob.d.mobile.violations).toBe(v);
    expect(fake.closeOf.get(ws)).toBeUndefined(); // the link stays up
    ws.send(new Uint8Array(3)); // shorter than the slot header: the relay itself is broken
    expect(await waitFor(() => fake.closeOf.get(ws), { what: "link closed" })).toBe(4400);
    expect(bob.d.mobile.violations).toBe(v + 1);
    await bob.client().mobileRevokeAll();
    // one byte over the largest frame the relay may forward: the transport ends the link before keeping the payload
    const second = await linked();
    second.ws.send(joinMsg(second.room, 5));
    await waitFor(() => bob.d.mobile.sessionCount === 1, { what: "session 5" });
    second.ws.send(slotFrame(5, gens, new Uint8Array(MAX_FRAME + 1)));
    expect(await waitFor(() => fake.closeOf.get(second.ws), { what: "link closed (1009)" })).toBe(1009);
    await bob.client().mobileRevokeAll();
  });

  test("10,000 error controls: the inbound budget drops the link; a few log lines; the daemon stays responsive", async () => {
    const logLines = () => readFileSync(join(bob.home, "logs", "daemon.log"), "utf8").split("\n").filter((l) => l.includes("mobile_relay")).length;
    const before = logLines();
    const { ws, room } = await linked();
    const started = Date.now();
    void room;
    const v = bob.d.mobile.violations;
    for (let i = 0; i < 10_000; i++) ws.send(JSON.stringify({ t: "error", message: "x" }));
    // Frames are charged as they arrive (round 5): the transport ends the link (1008, policy) and the link counts it.
    expect(await waitFor(() => fake.closeOf.get(ws), { what: "link closed" })).toBe(1008);
    expect(bob.d.mobile.violations).toBe(v + 1);
    const t0 = Date.now();
    expect((await bob.client().me()).handle).toBe("bob");
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(logLines() - before).toBeLessThanOrEqual(6);
    await bob.client().mobileRevokeAll();
  });

  test("controls about rooms the daemon never held are violations", async () => {
    const other = await roomOf(new Uint8Array(32).fill(7));
    await expectViolation((ws) => ws.send(JSON.stringify({ t: "closed", room: other, reason: "x" })), "closed unknown");
    await expectViolation((ws) => ws.send(JSON.stringify({ t: "error", message: "x", room: other })), "error unknown");
    await expectViolation((ws) => ws.send(joinMsg(other, 6)), "join unknown");
  });

  test("a relay that stops echoing (stopped reading): the daemon closes the link when the echo is late", async () => {
    const { ws, room } = await linked();
    ws.send(joinMsg(room, 7));
    const g = gens;
    await waitFor(() => bob.d.mobile.sessionCount === 1, { what: "session" });
    fake.noPong = true;
    try {
      const h = await phoneHello("pair");
      ws.send(slotFrame(7, g, h.frame)); // the daemon answers; that reply is data the relay now never acknowledges
      expect(await waitFor(() => fake.closeOf.get(ws), { what: "link closed", timeoutMs: 8_000 })).toBe(4400);
      expect(bob.d.mobile.sessionCount).toBe(0);
    } finally {
      fake.noPong = false;
    }
    await bob.client().mobileRevokeAll();
  });

  test("before the handshake every frame is held to the hello's size (a hello, then 1 MiB frames): that phone only", async () => {
    const { ws, room } = await linked();
    const v = bob.d.mobile.violations;
    ws.send(joinMsg(room, 8));
    const g = gens;
    await waitFor(() => bob.d.mobile.sessionCount === 1, { what: "session" });
    const h = await phoneHello("pair");
    ws.send(slotFrame(8, g, h.frame));
    ws.send(slotFrame(8, g, new Uint8Array(MAX_FRAME)));
    await waitFor(() => bob.d.mobile.sessionCount === 0, { what: "phone dropped" });
    expect(bob.d.mobile.violations).toBe(v);
    expect(fake.closeOf.get(ws)).toBeUndefined();
    await bob.client().mobileRevokeAll();
  });

  test("a pairing room the relay drops withdraws the code and says so", async () => {
    const { ws, room } = await linked();
    expect((await bob.client().mobile()).pairing).toBe(1);
    ws.send(JSON.stringify({ t: "closed", room, reason: "gone" }));
    await waitFor(async () => (await bob.client().mobile()).pairing === 0, { what: "pairing withdrawn" });
    expect((await bob.client().mobile()).notice).toContain("no longer works");
    await bob.client().mobileRevokeAll();
  });

  test("pair() refuses to show a code whose room the relay rejected", async () => {
    fake.refuse = true;
    try {
      await expect(bob.client().mobilePair()).rejects.toMatchObject({ status: 503 });
      expect((await bob.client().mobile()).pairing).toBe(0);
    } finally {
      fake.refuse = false;
      await bob.client().mobileRevokeAll();
    }
  });

  test("malformed and unknown controls", async () => {
    await expectViolation((ws) => ws.send("{not json"), "not json");
    await expectViolation((ws) => ws.send(JSON.stringify({ t: "surprise" })), "unknown control");
    await expectViolation((ws) => ws.send(joinMsg("x", 0)), "bad room");
  });

  test("an oversized handshake frame only drops that phone (kick), not the link", async () => {
    const { ws, room } = await linked();
    const v = bob.d.mobile.violations;
    ws.send(joinMsg(room, 2));
    await waitFor(() => bob.d.mobile.sessionCount === 1, { what: "session" });
    ws.send(slotFrame(2, gens, new Uint8Array(4_000)));
    await waitFor(() => bob.d.mobile.sessionCount === 0, { what: "session dropped" });
    expect(bob.d.mobile.violations).toBe(v);
    await bob.client().mobileRevokeAll();
  });

  test("after a violation the daemon waits before reconnecting", async () => {
    const { ws, room } = await linked();
    const connects = fake.connects;
    ws.send(joinMsg(room, 999));
    await waitFor(() => fake.closeOf.get(ws) === 4400, { what: "dropped" });
    await Bun.sleep(1_500);
    expect(fake.connects).toBe(connects); // no immediate reconnect (penalty backoff ≥ ~25 s)
    await bob.client().mobileRevokeAll();
  });
});
