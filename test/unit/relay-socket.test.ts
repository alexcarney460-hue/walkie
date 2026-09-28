// WALKIE-PWA-1 round 4 (Codex HIGH 1): the daemon's own WebSocket client for the relay, on the shipped runtime.
// Native pings are rate-limited and answered through the bounded queue; a message whose declared size is over the
// limit ends the connection before its payload is kept (fragmented ones too); ordinary traffic (text, binary,
// fragments, TLS) works.
import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RelaySocket } from "../../src/daemon/mobile/relay-socket.ts";

const stops: (() => void)[] = [];
afterEach(() => { for (const s of stops.splice(0)) s(); });

/** A server frame (unmasked). */
function frame(op: number, payload: Uint8Array | string, fin = true, declared?: number): Buffer {
  const p = Buffer.from(typeof payload === "string" ? Buffer.from(payload) : payload);
  const n = declared ?? p.length;
  let h: Buffer;
  if (n < 126) h = Buffer.from([(fin ? 0x80 : 0) | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = (fin ? 0x80 : 0) | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = (fin ? 0x80 : 0) | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}

/** A raw TCP peer: completes the upgrade, then runs `after(socket)`; `read` false stops reading for good. */
async function peer(after: (sock: net.Socket) => void, read = true, headers = "Upgrade: websocket\r\nConnection: Upgrade\r\n"): Promise<string> {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const s = buf.toString("latin1");
      if (s.indexOf("\r\n\r\n") < 0) return;
      const key = (/Sec-WebSocket-Key: (.*)\r\n/i.exec(s) as RegExpExecArray)[1]?.trim() ?? "";
      const acc = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}Sec-WebSocket-Accept: ${acc}\r\n\r\n`);
      sock.off("data", onData);
      if (!read) sock.pause(); else sock.on("data", () => undefined);
      after(sock);
    };
    sock.on("data", onData);
    sock.on("error", () => undefined);
    stops.push(() => sock.destroy());
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  stops.push(() => srv.close());
  return `ws://127.0.0.1:${(srv.address() as net.AddressInfo).port}/v1/daemon`;
}

interface Seen { opened: boolean; texts: string[]; binaries: number[]; bins: Uint8Array[]; closed: { code: number; reason: string; violation: boolean } | null }

type ClientOpts = Partial<{ maxText: number; maxBinary: number; maxQueued: number; ca: string; onFrame: (n: number) => boolean; establishMs: number; frameMs: number }>;

function client(url: string, o: ClientOpts = {}): { sock: RelaySocket; seen: Seen } {
  const seen: Seen = { opened: false, texts: [], binaries: [], bins: [], closed: null };
  const sock = RelaySocket.connect(url, {
    open: () => { seen.opened = true; },
    text: (t) => seen.texts.push(t),
    binary: (b) => { seen.binaries.push(b.byteLength); seen.bins.push(b); },
    close: (code, reason, violation) => { seen.closed = { code, reason, violation }; },
  }, { maxText: 1_024, maxBinary: 1 << 20, maxQueued: 64 * 1024, ...o });
  stops.push(() => sock.close());
  return { sock, seen };
}

async function until(fn: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(10); }
}

test("a peer that stops reading and keeps sending native pings: pings are rate-limited and the connection ends", async () => {
  const url = await peer((sock) => { for (let i = 0; i < 100; i++) sock.write(frame(9, "p".repeat(100))); }, false);
  const { sock, seen } = client(url);
  await until(() => seen.closed !== null);
  expect(seen.closed?.code).toBe(1008); // too many pings
  expect(sock.queued).toBe(0);
});

test("pongs to a non-reading peer never queue past the limit", async () => {
  let s: net.Socket | null = null;
  const url = await peer((sock) => { s = sock; }, false);
  const { sock, seen } = client(url, { maxQueued: 4_096 });
  await until(() => seen.opened);
  // fill the kernel's buffer and then our own queue with data the peer won't read (small frames, until refused)
  let sent = 0;
  while (sock.send(new Uint8Array(100)) && sent < 1_000_000) { sent += 1; if (sent % 2_000 === 0) await Bun.sleep(1); }
  expect(sock.queued).toBeGreaterThan(4_096 - 200);
  expect(sock.queued).toBeLessThanOrEqual(4_096);
  (s as unknown as net.Socket).write(frame(9, "p".repeat(125))); // an allowed ping; its 131-byte pong doesn't fit
  await until(() => seen.closed !== null);
  expect(seen.closed?.reason).toBe("relay stopped reading"); // the pong didn't fit: the connection ends
});

test("a message declared over the limit ends the connection before its payload is kept", async () => {
  const url = await peer((sock) => { sock.write(frame(2, new Uint8Array(10), true, 64 * 1024 * 1024)); });
  const { seen } = client(url);
  await until(() => seen.closed !== null);
  expect(seen.closed?.code).toBe(1009);
  expect(seen.binaries).toEqual([]);
});

test("a fragmented message over the limit ends the connection at the fragment that passes it", async () => {
  const url = await peer((sock) => {
    sock.write(frame(2, new Uint8Array(700_000), false));
    sock.write(frame(0, new Uint8Array(0), false, 700_000)); // header only: judged before any of it arrives
  });
  const { seen } = client(url);
  await until(() => seen.closed !== null);
  expect(seen.closed?.code).toBe(1009);
  expect(seen.binaries).toEqual([]);
});

test("ordinary traffic: text, binary, a fragmented text, a masked server frame is refused", async () => {
  const url = await peer((sock) => {
    sock.write(frame(1, "hello"));
    sock.write(frame(2, new Uint8Array(70_000)));
    sock.write(frame(1, "par", false));
    sock.write(frame(0, "ts"));
  });
  const { sock, seen } = client(url);
  await until(() => seen.texts.length === 2);
  expect(seen.texts).toEqual(["hello", "parts"]);
  expect(seen.binaries).toEqual([70_000]);
  expect(sock.send("a message")).toBe(true);
  const masked = await peer((s2) => { const f = frame(1, "x"); f[1] = (f[1] as number) | 0x80; s2.write(Buffer.concat([f, Buffer.alloc(4)])); });
  const bad = client(masked);
  await until(() => bad.seen.closed !== null);
  expect(bad.seen.closed?.code).toBe(1002);
});

test("wss:// with the relay's certificate trusted; an untrusted certificate never opens", async () => {
  const dir = mkdtempSync("/tmp/walkie-tls-");
  stops.push(() => rmSync(dir, { recursive: true, force: true }));
  const gen = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stderr: "pipe" });
  expect(gen.exitCode).toBe(0);
  const cert = readFileSync(join(dir, "cert.pem"), "utf8");
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1", tls: { cert, key: readFileSync(join(dir, "key.pem"), "utf8") },
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: { open(ws) { ws.send("hi over tls"); }, message() { /* none */ } },
  });
  stops.push(() => server.stop(true));
  const trusted = client(`wss://localhost:${server.port}/v1/daemon`, { ca: cert });
  await until(() => trusted.seen.texts.length === 1);
  expect(trusted.seen.texts).toEqual(["hi over tls"]);
  const untrusted = client(`wss://localhost:${server.port}/v1/daemon`);
  await until(() => untrusted.seen.closed !== null);
  expect(untrusted.seen.opened).toBe(false);
  expect(untrusted.seen.closed?.reason).toContain("tls");
  // the right chain but another name: refused too (Bun doesn't check the name by itself)
  const wrongName = client(`wss://127.0.0.1:${server.port}/v1/daemon`, { ca: cert });
  await until(() => wrongName.seen.closed !== null);
  expect(wrongName.seen.opened).toBe(false);
});

// ---- round 5: fragments, frame budget, RFC 6455 strictness, deadlines ---------------------------------------------

/** The opcodes of the (masked) client frames in `b`. */
function clientOps(b: Buffer): number[] {
  const ops: number[] = [];
  let at = 0;
  while (at + 2 <= b.length) {
    const short = (b[at + 1] as number) & 0x7f;
    const hlen = short === 126 ? 4 : short === 127 ? 10 : 2;
    const len = short === 126 ? b.readUInt16BE(at + 2) : short === 127 ? Number(b.readBigUInt64BE(at + 2)) : short;
    ops.push((b[at] as number) & 0x0f);
    at += hlen + 4 + len;
  }
  return ops;
}

/** Writes `buf` repeatedly (`times` in all), honouring backpressure; resolves when all is written or the socket ends. */
function pump(sock: net.Socket, buf: Buffer, times: number): void {
  let left = times;
  const go = () => {
    while (left > 0 && !sock.destroyed) { left -= 1; if (!sock.write(buf)) { sock.once("drain", go); return; } }
  };
  go();
}

test("empty continuation frames (02 00, then 00 00 x 1,000,000): closed at once, memory bounded, event loop responsive", async () => {
  const block = Buffer.alloc(2 * 32_768); // 32 768 empty continuation frames
  const url = await peer((sock) => { sock.write(Buffer.from([0x02, 0x00])); pump(sock, block, 31); }); // ~1 015 000 frames
  Bun.gc(true);
  const rss0 = process.memoryUsage().rss;
  let late = 0;
  const tick = setInterval(() => undefined, 10);
  let last = Date.now();
  const lag = setInterval(() => { const now = Date.now(); late = Math.max(late, now - last - 20); last = now; }, 20);
  const { seen } = client(url, { maxBinary: (1 << 20) + 5 });
  const t0 = Date.now();
  await until(() => seen.closed !== null, 5_000);
  expect(Date.now() - t0).toBeLessThan(2_000);
  expect(seen.closed?.code).toBe(1002); // an empty non-final fragment is a violation
  expect(seen.closed?.violation).toBe(true);
  await Bun.sleep(200);
  clearInterval(tick);
  clearInterval(lag);
  expect(late).toBeLessThan(250); // a timer still fires on time
  Bun.gc(true);
  expect((process.memoryUsage().rss - rss0) / 2 ** 20).toBeLessThan(48);
});

test("tiny non-empty fragments: past MAX_FRAGMENTS the message is refused; 1 MiB in 1-byte fragments never builds up", async () => {
  const { MAX_FRAGMENTS } = await import("../../src/daemon/mobile/relay-socket.ts");
  const one = Buffer.from([0x00, 0x01, 0x07]);
  const url = await peer((sock) => { sock.write(Buffer.from([0x02, 0x01, 0x07])); pump(sock, Buffer.concat(Array(4096).fill(one)), 256); }); // 1 MiB of 1-byte fragments
  const frames: number[] = [];
  const { seen } = client(url, { onFrame: (n) => { frames.push(n); return true; } });
  await until(() => seen.closed !== null);
  expect(seen.closed?.code).toBe(1009);
  expect(seen.closed?.reason).toBe("too many fragments");
  expect(seen.binaries).toEqual([]);
  expect(frames.length).toBe(MAX_FRAGMENTS + 1); // each fragment paid as it arrived; the one past the cap ended it
  // up to the cap, a fragmented message is reassembled exactly
  const parts = Array.from({ length: MAX_FRAGMENTS }, (_, i) => Buffer.alloc(1_000 + i, i));
  const ok = await peer((sock) => {
    parts.forEach((p, i) => sock.write(frame(i === 0 ? 2 : 0, p, i === parts.length - 1)));
  });
  const good = client(ok);
  await until(() => good.seen.bins.length === 1);
  expect(Buffer.from(good.seen.bins[0] as Uint8Array).equals(Buffer.concat(parts))).toBe(true);
  expect(good.seen.closed).toBe(null);
});

test("every frame pays the budget as its header arrives: over it, the connection ends as a violation", async () => {
  const url = await peer((sock) => { for (let i = 0; i < 100; i++) sock.write(frame(1, `m${i}`)); });
  let paid = 0;
  const { seen } = client(url, { onFrame: () => ++paid <= 10 });
  await until(() => seen.closed !== null);
  expect(seen.texts.length).toBe(10);
  expect(seen.closed?.code).toBe(1008);
  expect(seen.closed?.violation).toBe(true);
});

test("unsolicited pongs don't use up the ping allowance; native pings still get their pongs", async () => {
  let got = Buffer.alloc(0);
  const url = await peer((sock) => {
    sock.on("data", (d: Buffer) => { got = Buffer.concat([got, d]); });
    for (let i = 0; i < 50; i++) sock.write(frame(10, "unasked"));
    for (let i = 0; i < 5; i++) sock.write(frame(9, `p${i}`));
    sock.write(frame(1, "after"));
  });
  const { seen } = client(url);
  await until(() => seen.texts.length === 1);
  await Bun.sleep(100);
  expect(seen.closed).toBe(null);
  expect(clientOps(got).filter((op) => op === 10).length).toBe(5); // one pong per ping, none for the pongs
});

test("RFC 6455: reserved opcodes, non-minimal lengths and bad close frames end the connection", async () => {
  const cases: [string, Buffer, number][] = [
    ["reserved control opcode", Buffer.from([0x8b, 0x00]), 1002],
    ["reserved data opcode", Buffer.from([0x83, 0x01, 0x00]), 1002],
    ["16-bit length under 126", Buffer.from([0x82, 126, 0x00, 0x05, 1, 2, 3, 4, 5]), 1002],
    ["64-bit length under 65536", Buffer.concat([Buffer.from([0x82, 127, 0, 0, 0, 0, 0, 0, 0, 5]), Buffer.alloc(5)]), 1002],
    ["close with a 1-byte payload", Buffer.from([0x88, 0x01, 0x03]), 1002],
    ["close with code 1005", Buffer.from([0x88, 0x02, 0x03, 0xed]), 1002],
    ["close with code 999", Buffer.from([0x88, 0x02, 0x03, 0xe7]), 1002],
    ["close with a bad UTF-8 reason", Buffer.from([0x88, 0x04, 0x03, 0xe8, 0xc3, 0x28]), 1007],
  ];
  for (const [label, bytes, code] of cases) {
    const url = await peer((sock) => { sock.write(bytes); });
    const { seen } = client(url);
    await until(() => seen.closed !== null);
    expect({ label, code: seen.closed?.code, violation: seen.closed?.violation }).toEqual({ label, code, violation: true });
  }
  // a valid close is an ordinary end
  const url = await peer((sock) => { sock.write(Buffer.from([0x88, 0x05, 0x03, 0xe8, 0x62, 0x79, 0x65])); });
  const { seen } = client(url);
  await until(() => seen.closed !== null);
  expect(seen.closed?.violation).toBe(false);
});

test("the upgrade answer must say Upgrade: websocket and Connection: upgrade, and pick no extension or subprotocol", async () => {
  const answers = [
    "Connection: Upgrade\r\n", // no Upgrade
    "Upgrade: websocket\r\n", // no Connection
    "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Extensions: permessage-deflate\r\n",
    "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: chat\r\n",
  ];
  for (const headers of answers) {
    const url = await peer((sock) => { sock.write(frame(1, "never seen")); }, true, headers);
    const { seen } = client(url);
    await until(() => seen.closed !== null);
    expect(seen.opened).toBe(false);
    expect(seen.texts).toEqual([]);
    expect(seen.closed?.violation).toBe(true);
  }
  // header names and the Connection token list are case- and order-insensitive
  const url = await peer((sock) => { sock.write(frame(1, "fine")); }, true, "upgrade: WebSocket\r\nconnection: keep-alive, Upgrade\r\n");
  const ok = client(url);
  await until(() => ok.seen.texts.length === 1);
});

test("establishment deadline: a peer that accepts TCP but never answers (or trickles) the upgrade is given up on", async () => {
  const silent = net.createServer((s) => { s.on("error", () => undefined); s.on("data", () => undefined); stops.push(() => s.destroy()); });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
  stops.push(() => silent.close());
  const port = (silent.address() as net.AddressInfo).port;
  for (const url of [`ws://127.0.0.1:${port}/`, `wss://localhost:${port}/`]) { // TCP, and TLS whose ClientHello is never answered
    const { seen } = client(url, { establishMs: 300 });
    const t0 = Date.now();
    await until(() => seen.closed !== null);
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(seen.opened).toBe(false);
    expect(seen.closed?.violation).toBe(false);
  }
  const trickle = net.createServer((s) => {
    s.on("error", () => undefined);
    const answer = Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n");
    let i = 0;
    const t = setInterval(() => { if (i < answer.length) s.write(answer.subarray(i, ++i)); }, 50);
    s.on("close", () => clearInterval(t));
    stops.push(() => { clearInterval(t); s.destroy(); });
  });
  await new Promise<void>((r) => trickle.listen(0, "127.0.0.1", () => r()));
  stops.push(() => trickle.close());
  const tr = client(`ws://127.0.0.1:${(trickle.address() as net.AddressInfo).port}/`, { establishMs: 400 });
  await until(() => tr.seen.closed !== null);
  expect(tr.seen.opened).toBe(false);
});

test("frame deadline: a frame dripped a byte at a time (or a header left half-sent) is closed", async () => {
  const drip = await peer((sock) => {
    sock.write(Buffer.from([0x82, 126, 0x03, 0xe8])); // a 1 000-byte binary frame...
    const t = setInterval(() => { if (!sock.destroyed) sock.write(Buffer.from([0x01])); }, 50); // ...one byte per 50 ms
    stops.push(() => clearInterval(t));
  });
  const a = client(drip, { frameMs: 400 });
  const t0 = Date.now();
  await until(() => a.seen.closed !== null);
  expect(Date.now() - t0).toBeLessThan(1_500);
  expect(a.seen.closed?.reason).toBe("frame too slow");
  expect(a.seen.closed?.violation).toBe(true);
  const half = await peer((sock) => { sock.write(Buffer.from([0x82])); });
  const b = client(half, { frameMs: 300 });
  await until(() => b.seen.closed !== null);
  expect(b.seen.closed?.reason).toBe("frame too slow");
  // a quick sequence of ordinary frames isn't affected
  const quick = await peer((sock) => { for (let i = 0; i < 20; i++) setTimeout(() => sock.write(frame(1, `q${i}`)), i * 30); });
  const c = client(quick, { frameMs: 300 });
  await until(() => c.seen.texts.length === 20);
  expect(c.seen.closed).toBe(null);
});

test("an IPv6 relay address (bracketed in the URL) connects, and its certificate is checked against the bare address", async () => {
  const dir = mkdtempSync("/tmp/walkie-tls6-");
  stops.push(() => rmSync(dir, { recursive: true, force: true }));
  const gen = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=ipv6",
    "-addext", "subjectAltName=IP:::1", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stderr: "pipe" });
  expect(gen.exitCode).toBe(0);
  const cert = readFileSync(join(dir, "cert.pem"), "utf8");
  const server = Bun.serve({
    port: 0, hostname: "::1", tls: { cert, key: readFileSync(join(dir, "key.pem"), "utf8") },
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: { open(ws) { ws.send("hi over v6"); }, message() { /* none */ } },
  });
  stops.push(() => server.stop(true));
  const c = client(`wss://[::1]:${server.port}/v1/daemon`, { ca: cert });
  await until(() => c.seen.texts.length === 1 || c.seen.closed !== null);
  expect(c.seen.closed).toBe(null);
  expect(c.seen.texts).toEqual(["hi over v6"]);
});

// ---- round 6 ------------------------------------------------------------------------------------------------------

test("operational Close codes (1001, 1012, 1013, 1014) end the connection normally, not as a violation", async () => {
  for (const code of [1001, 1012, 1013, 1014]) {
    const url = await peer((sock) => { sock.write(Buffer.from([0x88, 0x02, code >> 8, code & 0xff])); });
    const { seen } = client(url);
    await until(() => seen.closed !== null);
    expect({ code, violation: seen.closed?.violation, reason: seen.closed?.reason }).toEqual({ code, violation: false, reason: `closed by the relay (${code})` });
  }
});

test("a non-101 upgrade answer is an ordinary failure; a 101 with bad headers is a violation", async () => {
  const srv = net.createServer((s) => { s.on("error", () => undefined); s.once("data", () => s.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  stops.push(() => srv.close());
  const { seen } = client(`ws://127.0.0.1:${(srv.address() as net.AddressInfo).port}/`);
  await until(() => seen.closed !== null);
  expect(seen.closed?.violation).toBe(false);
  expect(seen.closed?.reason).toContain("502");
});

test("close reasons are cut by UTF-8 bytes (at most 123), on a character boundary", async () => {
  const { utf8Cut } = await import("../../src/daemon/mobile/relay-socket.ts");
  const long = "é".repeat(100); // 200 bytes
  const cut = utf8Cut(long, 123);
  expect(cut.byteLength).toBe(122); // 61 whole characters; the 62nd would need byte 123 and 124
  expect(new TextDecoder("utf-8", { fatal: true }).decode(cut)).toBe("é".repeat(61));
  expect(utf8Cut("short", 123).byteLength).toBe(5);
  // on the wire: the close frame's payload stays within a control frame's 125 bytes
  let got = Buffer.alloc(0);
  const url = await peer((sock) => { sock.on("data", (d: Buffer) => { got = Buffer.concat([got, d]); }); });
  const { sock, seen } = client(url);
  await until(() => seen.opened);
  sock.close(1000, "😀".repeat(80)); // 320 bytes of reason
  await until(() => got.length > 0);
  expect((got[0] as number) & 0x0f).toBe(8);
  expect((got[1] as number) & 0x7f).toBeLessThanOrEqual(125);
});

test("outbound lanes drain round-robin: one room's backlog doesn't hold back another's next message; `written` follows write order", async () => {
  let s: net.Socket | null = null;
  let got = Buffer.alloc(0);
  const url = await peer((sock) => { s = sock; sock.on("data", (d: Buffer) => { got = Buffer.concat([got, d]); }); }, false);
  const { sock, seen } = client(url, { maxQueued: 8 * 1024 * 1024 });
  await until(() => seen.opened);
  const order: string[] = [];
  const a = new Uint8Array(64 * 1024).fill(0x61);
  for (let i = 0; i < 60; i++) expect(sock.send(a, "room-a", () => order.push(`a${i}`))).toBe(true); // ~3.8 MiB backlog
  expect(sock.send(new Uint8Array(100).fill(0x62), "room-b", () => order.push("b"))).toBe(true);
  (s as unknown as net.Socket).resume();
  await until(() => order.length === 61, 5_000);
  const at = order.indexOf("b");
  expect(at).toBeGreaterThanOrEqual(0);
  expect(at).toBeLessThan(40); // not behind the whole backlog (the kernel took the first few before it was queued)
  expect(order.filter((x) => x !== "b")).toEqual(Array.from({ length: 60 }, (_, i) => `a${i}`)); // a lane stays in order
});

test("a fragmented message's first buffer is its declared length (no fixed 64 KiB for a 1-byte fragment)", async () => {
  let s: net.Socket | null = null;
  const url = await peer((sock) => { s = sock; sock.write(frame(2, new Uint8Array(1), false)); });
  const { sock, seen } = client(url);
  await until(() => seen.opened);
  await until(() => (sock as unknown as { msg: { buf: Uint8Array } | null }).msg !== null);
  expect((sock as unknown as { msg: { buf: Uint8Array } }).msg.buf.byteLength).toBe(1);
  (s as unknown as net.Socket).write(frame(0, new Uint8Array(70_000).fill(9)));
  await until(() => seen.bins.length === 1);
  expect(seen.bins[0]?.byteLength).toBe(70_001);
});
