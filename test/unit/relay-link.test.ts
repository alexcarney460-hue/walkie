// WALKIE-PWA-1 relay link: a paired device's relay room that the relay refuses or drops is claimed again with backoff
// (a pairing room is let go); and the outbound bound, tested against a real TCP peer that stops reading.
import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { createHash } from "node:crypto";
import { randomBytes, roomOf, unb64u } from "../../src/mobile/crypto.ts";
import { RelayLink } from "../../src/daemon/mobile/relay-link.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import { MAX_FRAME } from "../../src/mobile/wire.ts";

const log = { info: () => undefined, warn: (e: string, x: unknown) => { if (process.env.DBG) console.log("WARN", e, JSON.stringify(x)); }, error: () => undefined, debug: () => undefined } as unknown as Logger;
const stops: (() => void)[] = [];
afterEach(() => { for (const s of stops.splice(0)) s(); });

/** A relay that refuses the first `refusals` claims of each room, then grants them; records claims per room. */
function relay(refusals: number) {
  const claims = new Map<string, number>();
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { ws.send(JSON.stringify({ t: "hello", v: 2 })); },
      async message(ws, msg) {
        const m = JSON.parse(String(msg)) as { t: string; key?: string; n?: string };
        if (m.t === "ping" && m.n) { ws.send(JSON.stringify({ t: "pong", n: m.n })); return; }
        if (m.t !== "open" || !m.key) return;
        const room = await roomOf(unb64u(m.key));
        const n = (claims.get(room) ?? 0) + 1;
        claims.set(room, n);
        ws.send(JSON.stringify(n <= refusals ? { t: "error", message: "room held", room } : { t: "opened", room }));
      },
    },
  });
  stops.push(() => server.stop(true));
  return { url: `ws://127.0.0.1:${server.port}`, claims };
}

const handlers = { join: () => undefined, leave: () => undefined, data: () => undefined, badFrame: () => undefined, down: () => undefined };

test("a refused device room is claimed again until the relay grants it", async () => {
  const r = relay(2);
  const link = new RelayLink(r.url, handlers, log, { reclaimMs: 50 });
  stops.push(() => link.stop());
  const key = randomBytes(32);
  const room = await roomOf(key);
  link.holdRoom(room, key, true);
  expect(await link.opened(room, 3_000)).toBe(false); // the first claim is refused
  const deadline = Date.now() + 3_000;
  while ((r.claims.get(room) ?? 0) < 3 && Date.now() < deadline) await Bun.sleep(20);
  expect(r.claims.get(room)).toBe(3);
  expect(await link.opened(room, 1_000)).toBe(true);
  expect(link.held(room)).toBe(true);
});

test("a refused pairing room is let go, not re-claimed", async () => {
  const r = relay(99);
  const link = new RelayLink(r.url, handlers, log, { reclaimMs: 50 });
  stops.push(() => link.stop());
  const key = randomBytes(32);
  const room = await roomOf(key);
  link.holdRoom(room, key, false);
  expect(await link.opened(room, 3_000)).toBe(false);
  await Bun.sleep(300);
  expect(r.claims.get(room)).toBe(1);
  expect(link.held(room)).toBe(false);
});

// ---- a real peer that stops reading (Opus r3 HIGH: Bun's client WebSocket reports no backpressure) -----------------

/** A server-to-client WebSocket text frame (unmasked). */
function textFrame(s: string): Buffer {
  const p = Buffer.from(s);
  if (p.length < 126) return Buffer.concat([Buffer.from([0x81, p.length]), p]);
  const h = Buffer.alloc(4);
  h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2);
  return Buffer.concat([h, p]);
}

/**
 * A raw TCP "relay": completes the WebSocket handshake, confirms `room` and announces a phone in slot 0, then stops
 * reading for good (it never answers a ping). Returns the url and a way to see whether the daemon's side closed.
 */
async function stalledPeer(room: string): Promise<{ url: string; closed: () => boolean; stop: () => void }> {
  let closed = false;
  const socks: net.Socket[] = [];
  const srv = net.createServer((sock) => {
    socks.push(sock);
    let buf = Buffer.alloc(0);
    sock.on("close", () => { closed = true; });
    sock.on("error", () => { closed = true; });
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const s = buf.toString("latin1");
      if (s.indexOf("\r\n\r\n") < 0) return;
      const key = (/Sec-WebSocket-Key: (.*)\r\n/i.exec(s) as RegExpExecArray)[1]?.trim() ?? "";
      const acc = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
      sock.write(textFrame(JSON.stringify({ t: "hello", v: 2 })));
      sock.write(textFrame(JSON.stringify({ t: "opened", room })));
      sock.write(textFrame(JSON.stringify({ t: "join", room, slot: 0, gen: 1 })));
      sock.off("data", onData);
      sock.pause(); // never read again
    };
    sock.on("data", onData);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}`, closed: () => closed, stop: () => { for (const s of socks) s.destroy(); srv.close(); } };
}

test("a real peer that stops reading: past the 8 MiB window sends are refused, memory stays bounded, and the stall ends the link", async () => {
  const key = randomBytes(32);
  const room = await roomOf(key);
  const peer = await stalledPeer(room);
  stops.push(peer.stop);
  let joined = false;
  // minRate: judge the stall by the fixed time alone (a 8 MiB backlog would otherwise be given ~68 min at MIN_RATE)
  const link = new RelayLink(peer.url, { ...handlers, join: () => { joined = true; } }, log, { stallMs: 1_500, minRate: 1e12 });
  stops.push(() => link.stop());
  link.holdRoom(room, key, true);
  const deadline = Date.now() + 5_000;
  while (!joined && Date.now() < deadline) await Bun.sleep(10);
  expect(joined).toBe(true);
  Bun.gc(true);
  const rss0 = process.memoryUsage().rss;
  const frame = new Uint8Array(MAX_FRAME - 64);
  let accepted = 0;
  const results = new Map<string, number>();
  for (let i = 0; i < 256; i++) { const r = link.send(0, frame); results.set(r, (results.get(r) ?? 0) + 1); } // 256 MiB offered
  expect(results.get("sent") ?? 0).toBeLessThanOrEqual(8); // at most 8 MiB ever handed to the transport
  expect(results.get("full") ?? 0).toBeGreaterThanOrEqual(248); // refused, not queued
  expect(link.violations).toBe(0); // being full isn't a violation: a slow relay is just slow
  Bun.gc(true);
  // Growth over this test's own sends only (rss0 is read after a GC, just before them). The bound is loose on purpose:
  // the functional checks above (at most 8 sends accepted, the rest refused) are what prove the window holds, while
  // process RSS also moves with whatever else the full suite has allocated and the allocator keeps (64.5 MiB was seen
  // once in a full run, 99.8 MiB in the pre.10 release run). 256 MiB offered and queued would still be past 192.
  const grew = (process.memoryUsage().rss - rss0) / 2 ** 20;
  expect(grew).toBeLessThan(192);
  const until = Date.now() + 5_000;
  while (link.connected && Date.now() < until) await Bun.sleep(50);
  expect(link.connected).toBe(false); // no acknowledgement progress for 1.5 s: a stall
  expect(link.violations).toBe(1);
  expect(peer.closed() || !link.connected).toBe(true);
});

test("a peer that never echoes a ping: outstanding data with no progress for the stall time ends the link, even a little", async () => {
  const key = randomBytes(32);
  const room = await roomOf(key);
  const peer = await stalledPeer(room);
  stops.push(peer.stop);
  let joined = false;
  const link = new RelayLink(peer.url, { ...handlers, join: () => { joined = true; } }, log, { stallMs: 400 });
  stops.push(() => link.stop());
  link.holdRoom(room, key, true);
  const deadline = Date.now() + 5_000;
  while (!joined && Date.now() < deadline) await Bun.sleep(10);
  expect(link.send(0, new Uint8Array(1_000))).toBe("sent");
  const until = Date.now() + 5_000;
  while (link.connected && Date.now() < until) await Bun.sleep(50);
  expect(link.connected).toBe(false);
  expect(link.violations).toBe(1);
});

test("an honest relay echoes pings: unacknowledged bytes drain and the link stays up", async () => {
  const { startRelay } = await import("../../src/relay/server.ts");
  const r = startRelay({ port: 0, hostname: "127.0.0.1" });
  stops.push(() => r.stop());
  const key = randomBytes(32);
  const room = await roomOf(key);
  let joinedSlot = -1;
  const link = new RelayLink(`ws://127.0.0.1:${r.port}`, { ...handlers, join: (_room: string, slot: number) => { joinedSlot = slot; } }, log);
  stops.push(() => link.stop());
  link.holdRoom(room, key, true);
  expect(await link.opened(room, 3_000)).toBe(true);
  const phone = new WebSocket(`ws://127.0.0.1:${r.port}/v1/phone?room=${room}`);
  stops.push(() => phone.close());
  let got = 0;
  phone.binaryType = "arraybuffer";
  phone.onmessage = (ev) => { got += (ev.data as ArrayBuffer).byteLength; };
  const t0 = Date.now();
  while (joinedSlot < 0 && Date.now() - t0 < 3_000) await Bun.sleep(10);
  const frame = new Uint8Array(200 * 1024);
  for (let i = 0; i < 40; i++) { // 8 MiB in all, more than the unacknowledged limit, paced like real traffic
    expect(link.send(joinedSlot, frame)).toBe("sent");
    await Bun.sleep(5);
  }
  const t1 = Date.now();
  while (link.unacked > 0 && Date.now() - t1 < 5_000) await Bun.sleep(20);
  expect(link.unacked).toBe(0);
  expect(link.connected).toBe(true);
  expect(link.violations).toBe(0);
  expect(got).toBeGreaterThan(0);
});

// ---- round 4: slow uplinks, protocol versions ---------------------------------------------------------------------

/** A TCP proxy that forwards daemon → relay at `rate` bytes/s (relay → daemon unthrottled): a slow home uplink. */
async function throttle(targetPort: number, rate: number): Promise<number> {
  const proxy = net.createServer((down) => {
    const up = net.connect(targetPort, "127.0.0.1");
    up.on("data", (d) => down.write(d));
    const q: Buffer[] = [];
    let qBytes = 0;
    down.on("data", (d: Buffer) => { q.push(d); qBytes += d.length; if (qBytes > 256 * 1024) down.pause(); });
    const tick = setInterval(() => {
      let budget = rate / 20;
      while (budget > 0 && q.length) {
        const b = q[0] as Buffer;
        const n = Math.min(b.length, budget);
        up.write(b.subarray(0, n)); budget -= n; qBytes -= n;
        if (n === b.length) q.shift(); else q[0] = b.subarray(n);
      }
      if (qBytes < 128 * 1024) down.resume();
    }, 50);
    const end = () => { clearInterval(tick); up.destroy(); down.destroy(); };
    up.on("close", end); down.on("close", end); up.on("error", end); down.on("error", end);
    stops.push(end);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  stops.push(() => proxy.close());
  return (proxy.address() as net.AddressInfo).port;
}

for (const [label, rate] of [["2 Mbit/s", 256 * 1024], ["1 Mbit/s", 128 * 1024]] as const) {
  test(`an honest relay behind a ${label} uplink: a 7 MiB burst and paced sends never cost the link (refused when full)`, async () => {
    const { startRelay } = await import("../../src/relay/server.ts");
    const r = startRelay({ port: 0, hostname: "127.0.0.1" });
    stops.push(() => r.stop());
    const pport = await throttle(r.port, rate);
    const key = randomBytes(32);
    const room = await roomOf(key);
    let slot = -1;
    const link = new RelayLink(`ws://127.0.0.1:${pport}`, { ...handlers, join: (_r: string, s: number) => { slot = s; } }, log, { stallMs: 6_000 });
    stops.push(() => link.stop());
    link.holdRoom(room, key, true);
    expect(await link.opened(room, 5_000)).toBe(true);
    const phone = new WebSocket(`ws://127.0.0.1:${r.port}/v1/phone?room=${room}`);
    stops.push(() => phone.close());
    phone.binaryType = "arraybuffer";
    let got = 0;
    phone.onmessage = (ev) => { got += (ev.data as ArrayBuffer).byteLength; };
    const t0 = Date.now();
    while (slot < 0 && Date.now() - t0 < 3_000) await Bun.sleep(10);
    const f = new Uint8Array(256 * 1024);
    const results = new Map<string, number>();
    const count = (x: string) => results.set(x, (results.get(x) ?? 0) + 1);
    for (let i = 0; i < 28; i++) count(link.send(slot, f)); // 7 MiB at once
    const end = Date.now() + 8_000;
    while (Date.now() < end && link.connected) { count(link.send(slot, f)); await Bun.sleep(250); } // 1 MiB/s offered
    expect(link.connected).toBe(true);
    expect(link.violations).toBe(0);
    expect(results.get("sent") ?? 0).toBeGreaterThan(0);
    expect(results.get("full") ?? 0).toBeGreaterThan(0); // the window filled: those sends were refused, not queued
    expect(got).toBeGreaterThan(rate); // data kept flowing to the phone
  }, 30_000);
}

test("protocol versions: a relay that never says hello, or says an older version, is reported, not looped on", async () => {
  const silent = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no"); }, websocket: { message() { /* none */ } } });
  stops.push(() => silent.stop(true));
  const seen: string[] = [];
  const a = new RelayLink(`ws://127.0.0.1:${silent.port}`, { ...handlers, incompatible: (m: string) => seen.push(m) }, log, { helloMs: 300 });
  stops.push(() => a.stop());
  a.holdRoom(await roomOf(randomBytes(32)), randomBytes(32), true);
  const t0 = Date.now();
  while (!seen.length && Date.now() - t0 < 3_000) await Bun.sleep(20);
  expect(seen[0]).toContain("older than this Walkie");
  const old = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no"); }, websocket: { open(ws) { ws.send(JSON.stringify({ t: "hello", v: 1 })); }, message() { /* none */ } } });
  stops.push(() => old.stop(true));
  const seen2: string[] = [];
  const b = new RelayLink(`ws://127.0.0.1:${old.port}`, { ...handlers, incompatible: (m: string) => seen2.push(m) }, log);
  stops.push(() => b.stop());
  b.holdRoom(await roomOf(randomBytes(32)), randomBytes(32), true);
  const t1 = Date.now();
  while (!seen2.length && Date.now() - t1 < 3_000) await Bun.sleep(20);
  expect(seen2[0]).toContain("older than this Walkie");
  // and the relay refuses a daemon of another protocol with a clear 426
  const { startRelay } = await import("../../src/relay/server.ts");
  const r = startRelay({ port: 0, hostname: "127.0.0.1" });
  stops.push(() => r.stop());
  const res = await fetch(`http://127.0.0.1:${r.port}/v1/daemon?v=1`, { headers: { upgrade: "websocket" } });
  expect(res.status).toBe(426);
  expect(res.headers.get("x-walkie-relay-protocol")).toBe("2");
});

// ---- round 5: deadlines, liveness, transport violations, per-room shares -------------------------------------------

/**
 * A raw TCP "relay" that completes the upgrade, says hello and confirms/announces what `script` writes; counts
 * connections. `read` false: never reads after the upgrade (so never answers a ping).
 */
async function scripted(script: (sock: net.Socket) => void, read = true): Promise<{ url: string; conns: () => number }> {
  let conns = 0;
  const srv = net.createServer((sock) => {
    conns += 1;
    let buf = Buffer.alloc(0);
    sock.on("error", () => undefined);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const s = buf.toString("latin1");
      if (s.indexOf("\r\n\r\n") < 0) return;
      const key = (/Sec-WebSocket-Key: (.*)\r\n/i.exec(s) as RegExpExecArray)[1]?.trim() ?? "";
      const acc = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
      sock.write(textFrame(JSON.stringify({ t: "hello", v: 2 })));
      sock.off("data", onData);
      if (read) sock.on("data", () => undefined); else sock.pause();
      script(sock);
    };
    sock.on("data", onData);
    stops.push(() => sock.destroy());
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  stops.push(() => srv.close());
  return { url: `ws://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, conns: () => conns };
}

async function waitFor(fn: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await Bun.sleep(20);
}

test("a relay that accepts TCP (or TLS) but never answers the upgrade: each attempt is given up on and retried", async () => {
  let conns = 0;
  const srv = net.createServer((s) => { conns += 1; s.on("error", () => undefined); s.on("data", () => undefined); stops.push(() => s.destroy()); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  stops.push(() => srv.close());
  const port = (srv.address() as net.AddressInfo).port;
  for (const url of [`ws://127.0.0.1:${port}`, `wss://localhost:${port}`]) {
    const before = conns;
    const link = new RelayLink(url, handlers, log, { establishMs: 300 });
    stops.push(() => link.stop());
    link.holdRoom(await roomOf(randomBytes(32)), randomBytes(32), true);
    await waitFor(() => conns - before >= 2, 6_000);
    expect(conns - before).toBeGreaterThanOrEqual(2); // the stuck attempt ended and the next one was made
    expect(link.violations).toBe(0);
    link.stop();
  }
}, 20_000);

test("liveness: an idle link whose relay stops answering is noticed (ping, no pong) and reconnected without a penalty", async () => {
  const key = randomBytes(32);
  const room = await roomOf(key);
  const peer = await scripted((sock) => { sock.write(textFrame(JSON.stringify({ t: "opened", room }))); }, true); // reads, never answers
  let downs = 0;
  const link = new RelayLink(peer.url, { ...handlers, down: () => { downs += 1; } }, log, { liveMs: 300, stallMs: 1_500 });
  stops.push(() => link.stop());
  link.holdRoom(room, key, true);
  expect(await link.opened(room, 3_000)).toBe(true);
  await waitFor(() => downs >= 1, 6_000);
  expect(downs).toBeGreaterThanOrEqual(1);
  expect(link.violations).toBe(0); // a dead path isn't the relay's fault
  await waitFor(() => peer.conns() >= 2, 5_000);
  expect(peer.conns()).toBeGreaterThanOrEqual(2);
}, 15_000);

test("liveness: an honest idle relay answers the liveness pings and the link stays up", async () => {
  const { startRelay } = await import("../../src/relay/server.ts");
  const r = startRelay({ port: 0, hostname: "127.0.0.1" });
  stops.push(() => r.stop());
  const key = randomBytes(32);
  const room = await roomOf(key);
  let downs = 0;
  const link = new RelayLink(`ws://127.0.0.1:${r.port}`, { ...handlers, down: () => { downs += 1; } }, log, { liveMs: 200, stallMs: 1_500 });
  stops.push(() => link.stop());
  link.holdRoom(room, key, true);
  expect(await link.opened(room, 3_000)).toBe(true);
  await Bun.sleep(4_000); // many liveness pings, each answered well within the stall time
  expect(downs).toBe(0);
  expect(link.connected).toBe(true);
  expect(link.violations).toBe(0);
}, 10_000);

test("a transport violation (bad framing from the relay) counts as a violation and holds the reconnect back", async () => {
  const peer = await scripted((sock) => { sock.write(Buffer.from([0x02, 0x00])); sock.write(Buffer.alloc(2 * 1_000)); });
  const link = new RelayLink(peer.url, handlers, log);
  stops.push(() => link.stop());
  link.holdRoom(await roomOf(randomBytes(32)), randomBytes(32), true);
  await waitFor(() => link.violations >= 1, 3_000);
  expect(link.violations).toBe(1);
  await Bun.sleep(2_500);
  expect(peer.conns()).toBe(1); // the penalty (≥ ~25 s) holds the next attempt back
}, 10_000);

test("a relay's frames over the per-connection budget end the link as a violation (charged per frame, not per message)", async () => {
  // 2 000 empty-bodied binary frames with no slot header would each be a violation anyway; use pongs: frames that are
  // never looked at as messages, and still pay.
  const peer = await scripted((sock) => { const p = Buffer.from([0x8a, 0x00]); sock.write(Buffer.concat(Array(5_000).fill(p))); });
  const link = new RelayLink(peer.url, handlers, log);
  stops.push(() => link.stop());
  link.holdRoom(await roomOf(randomBytes(32)), randomBytes(32), true);
  await waitFor(() => link.violations >= 1, 3_000);
  expect(link.violations).toBe(1);
});


// ---- round 6: shares that sum within the window, exact acknowledgements, slow honest uplinks, backoff ---------------

/** The text messages in a buffer of masked client frames; returns them and the unparsed rest. */
function clientTexts(buf: Buffer): { texts: string[]; rest: Buffer } {
  const texts: string[] = [];
  let at = 0;
  while (at + 2 <= buf.length) {
    const short = (buf[at + 1] as number) & 0x7f;
    const hlen = short === 126 ? 4 : short === 127 ? 10 : 2;
    if (at + hlen + 4 > buf.length) break;
    const len = short === 126 ? buf.readUInt16BE(at + 2) : short === 127 ? Number(buf.readBigUInt64BE(at + 2)) : short;
    if (at + hlen + 4 + len > buf.length) break;
    if (((buf[at] as number) & 0x0f) === 1) {
      const mask = buf.subarray(at + hlen, at + hlen + 4);
      const p = Buffer.from(buf.subarray(at + hlen + 4, at + hlen + 4 + len));
      for (let i = 0; i < p.length; i++) p[i] = (p[i] as number) ^ (mask[i & 3] as number);
      texts.push(p.toString("utf8"));
    }
    at += hlen + 4 + len;
  }
  return { texts, rest: buf.subarray(at) };
}

/** A relay that confirms `rooms`, puts a phone of each in slot i, reads everything, and answers each ping one ping late. */
async function lateEchoPeer(rooms: string[]): Promise<string> {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let held: string | null = null;
    sock.on("error", () => undefined);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const s = buf.toString("latin1");
        const end = s.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = (/Sec-WebSocket-Key: (.*)\r\n/i.exec(s) as RegExpExecArray)[1]?.trim() ?? "";
        const acc = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
        sock.write(textFrame(JSON.stringify({ t: "hello", v: 2 })));
        rooms.forEach((room, i) => {
          sock.write(textFrame(JSON.stringify({ t: "opened", room })));
          sock.write(textFrame(JSON.stringify({ t: "join", room, slot: i, gen: 1 })));
        });
        upgraded = true;
        buf = buf.subarray(end + 4);
      }
      const { texts, rest } = clientTexts(buf);
      buf = Buffer.from(rest);
      for (const t of texts) {
        const m = JSON.parse(t) as { t: string; n?: string };
        if (m.t !== "ping" || !m.n) continue;
        if (held) sock.write(textFrame(JSON.stringify({ t: "pong", n: held }))); // the previous ping, one late
        held = m.n;
      }
    });
    stops.push(() => sock.destroy());
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  stops.push(() => srv.close());
  return `ws://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
}

/** A relay (never reads: nothing is acknowledged) with a phone in each of `n` rooms; the link, joined. */
async function roomsLink(n: number): Promise<RelayLink> {
  const keys = Array.from({ length: n }, () => randomBytes(32));
  const rooms = await Promise.all(keys.map((k) => roomOf(k)));
  const peer = await scripted((sock) => {
    rooms.forEach((room, i) => {
      sock.write(textFrame(JSON.stringify({ t: "opened", room })));
      sock.write(textFrame(JSON.stringify({ t: "join", room, slot: i, gen: 1 })));
    });
  }, false);
  let joins = 0;
  const link = new RelayLink(peer.url, { ...handlers, join: () => { joins += 1; } }, log, { stallMs: 60_000 });
  stops.push(() => link.stop());
  rooms.forEach((room, i) => link.holdRoom(room, keys[i] as Uint8Array, true));
  await waitFor(() => joins === n, 5_000);
  expect(joins).toBe(n);
  return link;
}

/** A reply at the phone's response cap (256 KiB, sealed) and a full frame: what a room's first message can be. */
const REPLY = 256 * 1024 + 64;
const FULL = MAX_FRAME - 64;

for (const n of [1, 4, 8, 9, 16, 28, 32]) {
  for (const [label, size] of [["reply-sized", REPLY], ["full-frame", FULL]] as const) {
    test(`shares with ${n} room${n > 1 ? "s" : ""}, ${label} messages (first ones included): every room stays within a share of at least one full frame, and an idle room can still send a full frame and a reply (Opus r7 3, Codex r7 2)`, async () => {
      const { IDLE_HEADROOM, ROOM_SHARE_MIN, windowFor } = await import("../../src/daemon/mobile/relay-link.ts");
      const link = await roomsLink(n);
      expect(link.window()).toBe(windowFor(n));
      expect(link.share()).toBe(Math.floor((windowFor(n) - IDLE_HEADROOM) / n));
      expect(link.share()).toBeGreaterThanOrEqual(ROOM_SHARE_MIN); // at 28+ rooms too: never less than one reply
      // every room but the last sends until refused (nothing is ever acknowledged)
      const held: { release(): void; bytes: number }[] = [];
      let busy = 0;
      for (let slot = 0; slot < n - 1; slot++) {
        let mine = 0;
        for (let r = link.reserve(slot, size); r; r = link.reserve(slot, size)) { held.push(r); mine += r.bytes; }
        expect(mine).toBeGreaterThan(0); // its first message always goes
        expect(mine).toBeLessThanOrEqual(link.share()); // the first message counts against the share too
        busy += mine;
      }
      expect(link.unacked + busy).toBeLessThanOrEqual(link.window() - IDLE_HEADROOM); // busy rooms leave the headroom
      // the idle room can take a full frame, and (instead) a reply
      const full = link.reserve(n - 1, FULL);
      expect(full).not.toBe(null);
      full?.release();
      const reply = link.reserve(n - 1, REPLY);
      expect(reply).not.toBe(null);
      reply?.release();
      if (n > 1) expect(link.reserve(0, size)).toBe(null); // a room that used its share can't take more
      for (const r of held) r.release();
      expect(link.violations).toBe(0);
    });
  }
}

for (const n of [8, 9, 16, 32]) {
  test(`${n} idle rooms reserving a full first frame at once all get it, within the window (Codex r7 2)`, async () => {
    const link = await roomsLink(n);
    const held = Array.from({ length: n }, (_, slot) => link.reserve(slot, FULL));
    expect(held.every((r) => r !== null)).toBe(true);
    const total = held.reduce((a, r) => a + (r?.bytes ?? 0), 0);
    expect(link.unacked + total).toBeLessThanOrEqual(link.window());
    for (const r of held) r?.release();
  });
}

test("acknowledgements release a room's bytes exactly, even when they arrive a ping late (Codex r6 1)", async () => {
  const ka = randomBytes(32);
  const kb = randomBytes(32);
  const ra = await roomOf(ka);
  const rb = await roomOf(kb);
  const url = await lateEchoPeer([ra, rb]);
  let joins = 0;
  const link = new RelayLink(url, { ...handlers, join: () => { joins += 1; } }, log, { stallMs: 60_000 });
  stops.push(() => link.stop());
  link.holdRoom(ra, ka, true);
  link.holdRoom(rb, kb, true);
  await waitFor(() => joins === 2, 3_000);
  const size = 200_000;
  let refused = 0;
  for (let i = 0; i < 40; i++) { // 8 MB through room A, twice its share, acknowledged as it goes (one ping late)
    const r = link.reserve(0, size);
    if (!r) { refused += 1; await Bun.sleep(50); continue; }
    expect(link.send(0, new Uint8Array(size), false, r)).toBe("sent");
    await Bun.sleep(20);
  }
  expect(refused).toBe(0);
  // what is still charged to A is what the relay hasn't acknowledged: at most the last couple of messages
  expect(link.outstanding(ra)).toBeLessThanOrEqual(link.unacked);
  expect(link.outstanding(ra)).toBeLessThan(3 * (size + 5) + 256 * 1024);
  expect(link.violations).toBe(0);
});

test("a slow but honest relay (10 KiB/s uplink): a reply bigger than the stall time can carry is acknowledged, the link stays up", async () => {
  const { startRelay } = await import("../../src/relay/server.ts");
  for (const [minRate, stays] of [[undefined, true], [1e12, false]] as const) {
    const r = startRelay({ port: 0, hostname: "127.0.0.1" });
    stops.push(() => r.stop());
    const pport = await throttle(r.port, 10 * 1024);
    const key = randomBytes(32);
    const room = await roomOf(key);
    let slot = -1;
    const link = new RelayLink(`ws://127.0.0.1:${pport}`, { ...handlers, join: (_r: string, s: number) => { slot = s; } }, log,
      { stallMs: 2_000, ...(minRate ? { minRate } : {}) });
    stops.push(() => link.stop());
    link.holdRoom(room, key, true);
    expect(await link.opened(room, 5_000)).toBe(true);
    const phone = new WebSocket(`ws://127.0.0.1:${r.port}/v1/phone?room=${room}`);
    stops.push(() => phone.close());
    phone.binaryType = "arraybuffer";
    let got = 0;
    phone.onmessage = (ev) => { got += (ev.data as ArrayBuffer).byteLength; };
    const t0 = Date.now();
    while (slot < 0 && Date.now() - t0 < 3_000) await Bun.sleep(10);
    expect(link.send(slot, new Uint8Array(48 * 1024))).toBe("sent"); // ~5 s at 10 KiB/s: longer than the 2 s stall time
    const end = Date.now() + 7_000;
    while (Date.now() < end && link.connected && link.unacked > 0) await Bun.sleep(100);
    if (stays) {
      expect(link.connected).toBe(true);
      expect(link.unacked).toBe(0); // the ping right after the reply came back once it was read
      expect(link.violations).toBe(0);
      expect(got).toBeGreaterThanOrEqual(48 * 1024);
    } else {
      expect(link.violations).toBe(1); // judged by the fixed stall time alone, the same honest relay is dropped
    }
    link.stop();
  }
}, 30_000);

test("an upgrade answered with 503 (a proxy, a relay restarting) is a plain retry, not a violation", async () => {
  let conns = 0;
  const srv = net.createServer((s) => {
    conns += 1;
    s.on("error", () => undefined);
    s.once("data", () => s.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n"));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  stops.push(() => srv.close());
  const link = new RelayLink(`ws://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, handlers, log);
  stops.push(() => link.stop());
  link.holdRoom(await roomOf(randomBytes(32)), randomBytes(32), true);
  await waitFor(() => conns >= 2, 4_000);
  expect(conns).toBeGreaterThanOrEqual(2); // retried after ~1 s, not the ~30 s penalty
  expect(link.violations).toBe(0);
});

test("a relay that accepts and drops the link again and again is retried ever more slowly (backoff resets only after a stable minute)", async () => {
  const key = randomBytes(32);
  const room = await roomOf(key);
  const times: number[] = [];
  const peer = await scripted((sock) => {
    times.push(Date.now());
    sock.write(textFrame(JSON.stringify({ t: "opened", room })));
    setTimeout(() => sock.destroy(), 100);
  });
  const link = new RelayLink(peer.url, handlers, log);
  stops.push(() => link.stop());
  link.holdRoom(room, key, true);
  await Bun.sleep(8_000);
  // 1 s, 2 s, 4 s apart (±20 %): at most 4 connections in 8 s (a reset on every `opened` made it ~1 s apart: 7+)
  expect(peer.conns()).toBeLessThanOrEqual(4);
  expect(peer.conns()).toBeGreaterThanOrEqual(3);
  const gaps = times.slice(1).map((t, i) => t - (times[i] as number));
  expect((gaps[1] as number) > (gaps[0] as number)).toBe(true);
}, 15_000);

// ---- round 8: a stall limit that is a rate, liveness, room-lane controls ------------------------------------------

/** Client frames (masked) in a buffer: opcode and unmasked payload; and the unparsed rest. */
function clientFrames(buf: Buffer): { frames: { op: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { op: number; payload: Buffer }[] = [];
  let at = 0;
  while (at + 2 <= buf.length) {
    const short = (buf[at + 1] as number) & 0x7f;
    const hlen = short === 126 ? 4 : short === 127 ? 10 : 2;
    if (at + hlen + 4 > buf.length) break;
    const len = short === 126 ? buf.readUInt16BE(at + 2) : short === 127 ? Number(buf.readBigUInt64BE(at + 2)) : short;
    if (at + hlen + 4 + len > buf.length) break;
    const mask = buf.subarray(at + hlen, at + hlen + 4);
    const p = Buffer.from(buf.subarray(at + hlen + 4, at + hlen + 4 + len));
    for (let i = 0; i < p.length; i++) p[i] = (p[i] as number) ^ (mask[i & 3] as number);
    frames.push({ op: (buf[at] as number) & 0x0f, payload: p });
    at += hlen + 4 + len;
  }
  return { frames, rest: buf.subarray(at) };
}

type PeerMode = "honest" | "mute" | "silent";

/**
 * A relay with a phone in slot 0 of `room` that reads everything and answers pings: at once ("honest"), `delayMs`
 * apart one after another, or never ("mute": reads, never answers). "silent": stops reading and writing altogether (a
 * black hole). `pause`/`resume` stop and restart reading only. `seen` lists what it read, in order.
 */
async function controlledPeer(room: string) {
  const st = { mode: "honest" as PeerMode, delayMs: 0, nextPongAt: 0, seen: [] as string[], sock: null as net.Socket | null };
  const srv = net.createServer((sock) => {
    st.sock = sock;
    let buf = Buffer.alloc(0);
    let upgraded = false;
    sock.on("error", () => undefined);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const s = buf.toString("latin1");
        const end = s.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = (/Sec-WebSocket-Key: (.*)\r\n/i.exec(s) as RegExpExecArray)[1]?.trim() ?? "";
        const acc = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
        sock.write(textFrame(JSON.stringify({ t: "hello", v: 2 })));
        sock.write(textFrame(JSON.stringify({ t: "opened", room })));
        sock.write(textFrame(JSON.stringify({ t: "join", room, slot: 0, gen: 1 })));
        upgraded = true;
        buf = buf.subarray(end + 4);
      }
      const { frames, rest } = clientFrames(buf);
      buf = Buffer.from(rest);
      for (const f of frames) {
        if (f.op === 2) { st.seen.push(f.payload.byteLength < 64 ? `data:${f.payload.subarray(5).toString()}` : "data"); continue; }
        if (f.op !== 1) continue;
        const m = JSON.parse(f.payload.toString("utf8")) as { t: string; n?: string };
        st.seen.push(m.t);
        if (m.t !== "ping" || !m.n || st.mode !== "honest") continue;
        const pong = textFrame(JSON.stringify({ t: "pong", n: m.n }));
        if (!st.delayMs) { sock.write(pong); continue; }
        st.nextPongAt = Math.max(Date.now(), st.nextPongAt) + st.delayMs; // one after another, delayMs apart
        const tm = setTimeout(() => { if (st.mode === "honest") sock.write(pong); }, st.nextPongAt - Date.now());
        stops.push(() => clearTimeout(tm));
      }
    });
    stops.push(() => sock.destroy());
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  stops.push(() => srv.close());
  return {
    url: `ws://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, st,
    set(mode: PeerMode, delayMs = 0) { st.mode = mode; st.delayMs = delayMs; if (mode === "silent") st.sock?.pause(); },
    pause() { st.sock?.pause(); }, resume() { st.sock?.resume(); },
  };
}

async function joinedLink(peerUrl: string, room: string, key: Uint8Array, opts: ConstructorParameters<typeof RelayLink>[3]) {
  let joined = false;
  const link = new RelayLink(peerUrl, { ...handlers, join: () => { joined = true; } }, log, opts);
  stops.push(() => link.stop());
  link.holdRoom(room, key, true);
  await waitFor(() => joined, 5_000);
  expect(joined).toBe(true);
  await waitFor(() => link.unacked === 0, 3_000); // the room claim acknowledged: nothing outstanding
  return link;
}

for (const mode of ["mute", "silent"] as const) {
  test(`a relay that ${mode === "mute" ? "reads but stops echoing" : "stops reading and says nothing (a black hole)"} with a full window is ended once the lenient allowance runs out: max(stall, outstanding / MIN_RATE) without progress`, async () => {
    const key = randomBytes(32);
    const room = await roomOf(key);
    const peer = await controlledPeer(room);
    // 1 MiB/s: ~8 MiB outstanding buys ~8 s (at the real 2 KiB/s, ~68 min: slow detection is the accepted price).
    const link = await joinedLink(peer.url, room, key, { stallMs: 2_000, minRate: 1024 * 1024 });
    peer.set(mode);
    let sent = 0;
    for (let i = 0; i < 16; i++) if (link.send(0, new Uint8Array(FULL)) === "sent") sent += 1;
    expect(sent).toBeGreaterThanOrEqual(7); // the window filled
    const t0 = Date.now();
    await waitFor(() => !link.connected, 20_000);
    expect(link.connected).toBe(false);
    expect(link.violations).toBe(1); // phone data held: the relay's fault
    expect(Date.now() - t0).toBeGreaterThanOrEqual(6_000); // not before the allowance
  }, 30_000);
}

test("a kick goes after the same room's queued data: a revoked phone reads `revoked` before it is kicked (Opus r7 2)", async () => {
  const key = randomBytes(32);
  const room = await roomOf(key);
  const peer = await controlledPeer(room);
  const link = await joinedLink(peer.url, room, key, { stallMs: 60_000 });
  peer.pause();
  await Bun.sleep(100);
  peer.st.seen.length = 0;
  for (let i = 0; i < 8; i++) expect(link.send(0, new Uint8Array(900 * 1024))).toBe("sent"); // a backlog in the room's lane
  for (let i = 0; i < 20; i++) expect(link.send(0, new TextEncoder().encode(`ev${i}`), true)).toBe("sent"); // then small events
  expect(link.send(0, new TextEncoder().encode("REVOKED"), true)).toBe("sent");
  link.kick(0);
  await Bun.sleep(200);
  peer.resume();
  await waitFor(() => peer.st.seen.includes("kick"), 10_000);
  const seen = peer.st.seen;
  expect(seen.indexOf("data:REVOKED")).toBeGreaterThanOrEqual(0);
  expect(seen.indexOf("data:REVOKED")).toBeLessThan(seen.indexOf("kick"));
}, 20_000);

test("an honest relay just above the minimum rate holding a 7 MiB backlog stays up (80 KiB/s vs 64 KiB/s)", async () => {
  const { startRelay } = await import("../../src/relay/server.ts");
  const r = startRelay({ port: 0, hostname: "127.0.0.1" });
  stops.push(() => r.stop());
  const pport = await throttle(r.port, 80 * 1024);
  const key = randomBytes(32);
  const room = await roomOf(key);
  let slot = -1;
  const link = new RelayLink(`ws://127.0.0.1:${pport}`, { ...handlers, join: (_r: string, s: number) => { slot = s; } }, log,
    { stallMs: 2_500, minRate: 64 * 1024 });
  stops.push(() => link.stop());
  link.holdRoom(room, key, true);
  expect(await link.opened(room, 5_000)).toBe(true);
  const phone = new WebSocket(`ws://127.0.0.1:${r.port}/v1/phone?room=${room}`);
  stops.push(() => phone.close());
  await waitFor(() => slot >= 0, 3_000);
  for (let i = 0; i < 28; i++) link.send(slot, new Uint8Array(256 * 1024));
  const acked0 = link.unacked;
  await Bun.sleep(10_000); // several pings, each echoed 3.2 s after the one before
  expect(link.connected).toBe(true);
  expect(link.violations).toBe(0);
  expect(link.unacked).toBeLessThan(acked0); // the backlog is draining
}, 30_000);

// ---- round 9: a virtual reader instead of per-ping allowances; capacity that follows the rooms --------------------

/**
 * An honest relay behind a slow uplink, as seen from a real one: reads at `rate` bytes/s, echoes every ping as it reads
 * it, confirms every room it is asked for and puts a phone in it; and the daemon's socket takes at most `cap` bytes
 * beyond what the relay has read (a real uplink's small send buffer; loopback would buffer several MiB and hide when a
 * ping is really written).
 */
async function honestSlowRelay(rate: number) {
  let read = 0;
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let slot = 0;
    sock.on("error", () => undefined);
    sock.on("data", async (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const s = buf.toString("latin1");
        const end = s.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = (/Sec-WebSocket-Key: (.*)\r\n/i.exec(s) as RegExpExecArray)[1]?.trim() ?? "";
        const acc = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
        sock.write(textFrame(JSON.stringify({ t: "hello", v: 2 })));
        upgraded = true;
        buf = buf.subarray(end + 4);
      }
      const { frames, rest } = clientFrames(buf);
      buf = Buffer.from(rest);
      for (const f of frames) {
        if (f.op !== 1) continue;
        const m = JSON.parse(f.payload.toString("utf8")) as { t: string; n?: string; key?: string };
        if (m.t === "ping" && m.n) sock.write(textFrame(JSON.stringify({ t: "pong", n: m.n })));
        if (m.t === "open" && m.key) {
          const room = await roomOf(unb64u(m.key));
          sock.write(textFrame(JSON.stringify({ t: "opened", room })));
          sock.write(textFrame(JSON.stringify({ t: "join", room, slot: slot++, gen: 1 })));
        }
      }
    });
    stops.push(() => sock.destroy());
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  stops.push(() => srv.close());
  const proxy = net.createServer((down) => {
    const up = net.connect((srv.address() as net.AddressInfo).port, "127.0.0.1");
    up.on("data", (d) => down.write(d));
    const q: Buffer[] = [];
    let qBytes = 0;
    down.on("data", (d: Buffer) => { q.push(d); qBytes += d.length; if (qBytes > 64 * 1024) down.pause(); });
    const tick = setInterval(() => {
      let budget = rate / 20;
      while (budget > 0 && q.length) {
        const b = q[0] as Buffer;
        const n = Math.min(b.length, budget);
        up.write(b.subarray(0, n)); budget -= n; qBytes -= n; read += n;
        if (n === b.length) q.shift(); else q[0] = b.subarray(n);
      }
      if (qBytes < 32 * 1024) down.resume();
    }, 50);
    const end = () => { clearInterval(tick); up.destroy(); down.destroy(); };
    up.on("close", end); down.on("close", end); up.on("error", end); down.on("error", end);
    stops.push(end);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  stops.push(() => proxy.close());
  return { url: `ws://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`, read: () => read };
}

/** Makes the link's socket take at most `cap` bytes beyond what `read()` says the relay has read. */
function smallSendBuffer(link: RelayLink, read: () => number, cap: number): void {
  const rs = (link as unknown as { sock: { socket: { write(d: Uint8Array): number }; flush(): void } }).sock;
  const bs = rs.socket;
  const orig = bs.write.bind(bs);
  let taken = 0;
  const read0 = read();
  bs.write = (d: Uint8Array) => {
    const room = cap - (taken - (read() - read0));
    if (room <= 0) return 0;
    const w = orig(d.subarray(0, Math.min(room, d.byteLength)));
    taken += w;
    return w;
  };
  const tick = setInterval(() => { try { rs.flush(); } catch { /* closed */ } }, 20);
  stops.push(() => clearInterval(tick));
}

for (const n of [2, 4, 8]) {
  test(`an honest slow relay with ${n} rooms sending at once and a small send buffer is never a violator (Opus r8 HIGH; 320 KiB/s vs a 256 KiB/s minimum, the 10 vs 8 KiB/s case scaled)`, async () => {
    const relay = await honestSlowRelay(320 * 1024);
    const keys = Array.from({ length: n }, () => randomBytes(32));
    let joins = 0;
    const link = new RelayLink(relay.url, { ...handlers, join: () => { joins += 1; } }, log, { stallMs: 2_000, minRate: 256 * 1024 });
    stops.push(() => link.stop());
    for (const k of keys) link.holdRoom(await roomOf(k), k, true);
    await waitFor(() => joins === n, 5_000);
    expect(joins).toBe(n);
    await waitFor(() => link.unacked === 0, 3_000);
    smallSendBuffer(link, relay.read, 128 * 1024);
    const frame = new Uint8Array(256 * 1024);
    let sent = 0;
    for (let i = 0; i < 2; i++) if (link.send(0, frame) === "sent") sent += 1; // room 0 is already busy
    for (let slot = 0; slot < n; slot++) if (link.send(slot, frame) === "sent") sent += 1; // then every room at once
    expect(sent).toBe(n + 2);
    const bytes = (n + 2) * 256 * 1024;
    await waitFor(() => !link.connected || link.unacked === 0, (bytes / (320 * 1024)) * 1000 + 8_000);
    expect(link.violations).toBe(0);
    expect(link.connected).toBe(true);
    expect(link.unacked).toBe(0);
  }, 40_000);
}

/** A relay (never reads) that confirms `rooms`, puts phones in the first `joined`, and can join or leave more later. */
async function churnPeer(rooms: string[], joined: number) {
  let sock: net.Socket | null = null;
  const peer = await scripted((s) => {
    sock = s;
    rooms.forEach((room, i) => {
      s.write(textFrame(JSON.stringify({ t: "opened", room })));
      if (i < joined) s.write(textFrame(JSON.stringify({ t: "join", room, slot: i, gen: 1 })));
    });
  }, false);
  return {
    url: peer.url,
    join(i: number) { sock?.write(textFrame(JSON.stringify({ t: "join", room: rooms[i], slot: i, gen: 1 }))); },
    leave(i: number) { sock?.write(textFrame(JSON.stringify({ t: "leave", slot: i, gen: 1 }))); },
  };
}

async function churnLink(n: number, joined: number) {
  const keys = Array.from({ length: n }, () => randomBytes(32));
  const rooms = await Promise.all(keys.map((k) => roomOf(k)));
  const peer = await churnPeer(rooms, joined);
  let joins = 0;
  let leaves = 0;
  const link = new RelayLink(peer.url, { ...handlers, join: () => { joins += 1; }, leave: () => { leaves += 1; } }, log, { stallMs: 60_000 });
  stops.push(() => link.stop());
  rooms.forEach((room, i) => link.holdRoom(room, keys[i] as Uint8Array, true));
  await waitFor(() => joins === joined, 5_000);
  return { link, peer, joins: () => joins, leaves: () => leaves };
}

const fill = (link: RelayLink, slot: number, size: number): number => {
  let n = 0;
  for (let r = link.reserve(slot, size); r; r = link.reserve(slot, size)) {
    if (link.send(slot, new Uint8Array(size), false, r) !== "sent") break;
    n += 1;
  }
  return n;
};

test("rooms leaving shrink the window without failing a reservation already granted, or a kick (Codex r8 1)", async () => {
  const { link, peer, joins, leaves } = await churnLink(8, 1);
  expect(fill(link, 0, 256 * 1024)).toBeGreaterThanOrEqual(26); // alone, room 0 fills its large share
  for (let i = 1; i < 8; i++) peer.join(i);
  await waitFor(() => joins() === 8, 5_000);
  for (let i = 1; i < 7; i++) expect(link.send(i, new Uint8Array(REPLY), false, link.reserve(i, REPLY) ?? undefined)).toBe("sent");
  const held = link.reserve(7, REPLY);
  expect(held).not.toBe(null);
  for (let i = 1; i < 6; i++) peer.leave(i);
  await waitFor(() => leaves() === 5, 5_000);
  expect(link.send(7, new Uint8Array(REPLY), false, held as NonNullable<typeof held>)).toBe("sent"); // granted before
  const before = link.unacked;
  link.kick(7);
  expect(link.unacked).toBeGreaterThan(before); // the kick went out
  expect(link.violations).toBe(0);
});

test("with 14 rooms, 12 phones leaving shrink the window by more than 8 MiB: a granted reservation, `revoked` and the kick still go out (Opus r9 2, Kimi r9 1-2)", async () => {
  const { link, peer, joins, leaves } = await churnLink(14, 1);
  expect(fill(link, 0, 256 * 1024)).toBeGreaterThanOrEqual(26);
  for (let i = 1; i < 14; i++) peer.join(i);
  await waitFor(() => joins() === 14, 5_000);
  for (let i = 1; i < 13; i++) { const r = link.reserve(i, FULL); expect(r).not.toBe(null); link.send(i, new Uint8Array(FULL), false, r as NonNullable<typeof r>); }
  const held = link.reserve(13, REPLY);
  expect(held).not.toBe(null);
  const outstanding = link.unacked;
  for (let i = 1; i < 13; i++) peer.leave(i);
  await waitFor(() => leaves() === 12, 5_000);
  expect(outstanding).toBeGreaterThan(link.ceiling()); // the window shrank below what is outstanding
  expect(link.send(13, new Uint8Array(REPLY), false, held as NonNullable<typeof held>)).toBe("sent"); // granted before
  expect(link.send(13, new TextEncoder().encode("REVOKED"), true)).toBe("sent"); // small, unreserved: control limit
  const before = link.unacked;
  link.kick(13);
  expect(link.unacked).toBeGreaterThan(before);
  expect(link.violations).toBe(0);
});

test("phones joining after one room filled a large share: every new room can still send its first full frame (Opus r8 LOW)", async () => {
  const { link, peer, joins } = await churnLink(11, 1);
  expect(fill(link, 0, FULL)).toBeGreaterThanOrEqual(6);
  for (let i = 1; i < 11; i++) peer.join(i);
  await waitFor(() => joins() === 11, 5_000);
  for (let i = 1; i < 11; i++) {
    const r = link.reserve(i, FULL);
    expect(r).not.toBe(null);
    expect(link.send(i, new Uint8Array(FULL), false, r as NonNullable<typeof r>)).toBe("sent");
  }
  expect(link.unacked).toBeLessThanOrEqual(link.ceiling());
});

test("small messages count against the room's share (plus 16 KiB): they can't use up an idle room's full frame (Opus r8 LOW)", async () => {
  const { link } = await churnLink(4, 4);
  for (let i = 0; i < 3; i++) fill(link, i, REPLY);
  let smalls = 0;
  for (let i = 0; i < 20_000; i++) { const r = link.reserve(0, 200, true); if (!r) break; link.send(0, new Uint8Array(200), true, r); smalls += 1; }
  expect(smalls).toBeLessThan(20_000); // capped
  const full = link.reserve(3, FULL);
  expect(full).not.toBe(null);
  full?.release();
});

test("real scale, no scaling: one room, 262 208-byte replies, an honest relay at 10 KiB/s behind a 16 KiB or 48 KiB send buffer stays connected and drains (Opus r9 HIGH)", async () => {
  const run = async (cap: number, frames: number) => {
    const relay = await honestSlowRelay(10 * 1024);
    const key = randomBytes(32);
    let joined = false;
    const link = new RelayLink(relay.url, { ...handlers, join: () => { joined = true; } }, log); // production defaults
    stops.push(() => link.stop());
    link.holdRoom(await roomOf(key), key, true);
    await waitFor(() => joined, 5_000);
    await waitFor(() => link.unacked === 0, 3_000);
    smallSendBuffer(link, relay.read, cap);
    for (let i = 0; i < frames; i++) expect(link.send(0, new Uint8Array(262_208))).toBe("sent");
    await waitFor(() => !link.connected || link.unacked === 0, frames * 30_000 + 15_000);
    return { connected: link.connected, violations: link.violations, unacked: link.unacked };
  };
  const [a, b] = await Promise.all([run(16 * 1024, 2), run(48 * 1024, 2)]);
  expect(a).toEqual({ connected: true, violations: 0, unacked: 0 });
  expect(b).toEqual({ connected: true, violations: 0, unacked: 0 });
}, 120_000);
