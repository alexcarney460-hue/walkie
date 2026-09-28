// WALKIE-PWA-1: the relay (src/relay/server.ts). Rooms only the key holder can claim, forwarding by slot, and the
// limits that keep it available: frame size, message rate, phones per room, connections per address, connect rate.
import { afterEach, describe, expect, test } from "bun:test";
import { b64u, randomBytes, roomOf } from "../../src/mobile/crypto.ts";
import { CLOSE, MAX_FRAME, type RelayCtl } from "../../src/mobile/wire.ts";
import { ipKey, startRelay, type RelayHandle, type RelayOptions } from "../../src/relay/server.ts";

const relays: RelayHandle[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) try { s.close(); } catch { /* closed */ }
  for (const r of relays.splice(0)) r.stop();
});

function relay(o: RelayOptions = {}): RelayHandle {
  const r = startRelay({ port: 0, hostname: "127.0.0.1", connectRate: { capacity: 1_000, perSecond: 1_000 }, ...o });
  relays.push(r);
  return r;
}

interface Sock { ws: WebSocket; msgs: (string | Uint8Array)[]; closed: Promise<number>; opened: Promise<boolean> }

function connect(r: RelayHandle, path: string): Sock {
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}${path}`);
  ws.binaryType = "arraybuffer";
  sockets.push(ws);
  const msgs: (string | Uint8Array)[] = [];
  ws.onmessage = (ev) => msgs.push(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
  const closed = new Promise<number>((resolve) => { ws.onclose = (ev) => resolve(ev.code); });
  const opened = new Promise<boolean>((resolve) => { ws.onopen = () => resolve(true); ws.addEventListener("close", () => resolve(false)); });
  return { ws, msgs, closed, opened };
}

async function until<T>(fn: () => T | undefined | null | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

const ctl = (s: Sock) => s.msgs.filter((m): m is string => typeof m === "string").map((m) => JSON.parse(m) as RelayCtl);

async function daemonWithRoom(r: RelayHandle, key = randomBytes(32)): Promise<{ d: Sock; room: string; key: Uint8Array }> {
  const d = connect(r, "/v1/daemon?v=2");
  await d.opened;
  d.ws.send(JSON.stringify({ t: "open", key: b64u(key) }));
  const room = await roomOf(key);
  await until(() => ctl(d).some((m) => m.t === "opened" && m.room === room));
  return { d, room, key };
}

describe("relay", () => {
  test("health check", async () => {
    const r = relay();
    expect(await (await fetch(`http://127.0.0.1:${r.port}/healthz`)).text()).toBe("ok");
    expect((await fetch(`http://127.0.0.1:${r.port}/v1/phone?room=x`)).status).toBe(426);
  });

  test("forwards binary frames by slot both ways, and tells the daemon who joined and left", async () => {
    const r = relay();
    const { d, room } = await daemonWithRoom(r);
    const p = connect(r, `/v1/phone?room=${room}`);
    await p.opened;
    const join = await until(() => ctl(d).find((m) => m.t === "join")) as Extract<RelayCtl, { t: "join" }>;
    expect(join.room).toBe(room);
    p.ws.send(new Uint8Array([9, 8, 7]));
    const got = await until(() => d.msgs.find((m) => m instanceof Uint8Array)) as Uint8Array;
    const gen = (g: number) => [(g >>> 24) & 255, (g >>> 16) & 255, (g >>> 8) & 255, g & 255];
    expect([...got]).toEqual([join.slot, ...gen(join.gen), 9, 8, 7]);
    d.ws.send(new Uint8Array([join.slot, ...gen(join.gen + 1), 5, 5])); // another generation: dropped
    d.ws.send(new Uint8Array([join.slot, ...gen(join.gen), 1, 2]));
    const back = await until(() => p.msgs.find((m) => m instanceof Uint8Array)) as Uint8Array;
    expect([...back]).toEqual([1, 2]);
    p.ws.close();
    await until(() => ctl(d).some((m) => m.t === "leave" && m.slot === join.slot));
  });

  test("a phone for a room nobody holds is told the computer is offline", async () => {
    const r = relay();
    const p = connect(r, `/v1/phone?room=${await roomOf(randomBytes(32))}`);
    expect(await p.closed).toBe(CLOSE.daemonOffline);
  });

  test("when the daemon leaves, its phones are closed and the room is gone", async () => {
    const r = relay();
    const { d, room } = await daemonWithRoom(r);
    const p = connect(r, `/v1/phone?room=${room}`);
    await p.opened;
    d.ws.close();
    expect(await p.closed).toBe(CLOSE.daemonLeft);
    await until(() => r.stats().rooms === 0);
  });

  test("the daemon can kick a phone and close a room", async () => {
    const r = relay();
    const { d, room } = await daemonWithRoom(r);
    const p1 = connect(r, `/v1/phone?room=${room}`);
    await p1.opened;
    const j = await until(() => ctl(d).find((m) => m.t === "join")) as Extract<RelayCtl, { t: "join" }>;
    d.ws.send(JSON.stringify({ t: "kick", slot: j.slot, gen: j.gen + 1 })); // a generation that isn't there: ignored
    await Bun.sleep(50);
    expect(p1.ws.readyState).toBe(WebSocket.OPEN);
    d.ws.send(JSON.stringify({ t: "kick", slot: j.slot, gen: j.gen }));
    expect(await p1.closed).toBe(CLOSE.kicked);
    const p2 = connect(r, `/v1/phone?room=${room}`);
    await p2.opened;
    d.ws.send(JSON.stringify({ t: "close", room }));
    expect(await p2.closed).toBe(CLOSE.daemonLeft);
  });

  test("a held room is never handed to a second claimant (even one with the key); it frees when the holder leaves", async () => {
    const r = relay();
    const key = randomBytes(32);
    const first = await daemonWithRoom(r, key);
    const p = connect(r, `/v1/phone?room=${first.room}`);
    await p.opened;
    const second = connect(r, "/v1/daemon?v=2");
    await second.opened;
    second.ws.send(JSON.stringify({ t: "open", key: b64u(key) }));
    const refused = await until(() => ctl(second).find((m) => m.t === "error")) as Extract<RelayCtl, { t: "error" }>;
    expect(refused.room).toBe(first.room);
    await Bun.sleep(30);
    expect(p.ws.readyState).toBe(WebSocket.OPEN); // the holder's phone is untouched
    first.d.ws.close();
    expect(await p.closed).toBe(CLOSE.daemonLeft);
    second.ws.send(JSON.stringify({ t: "open", key: b64u(key) })); // now free
    await until(() => ctl(second).some((m) => m.t === "opened" && m.room === first.room));
    // a phone can't claim anything: text from a phone closes it
    const { room } = await daemonWithRoom(r);
    const q = connect(r, `/v1/phone?room=${room}`);
    await q.opened;
    q.ws.send(JSON.stringify({ t: "open", key: b64u(key) }));
    expect(await q.closed).toBe(CLOSE.bad);
  });

  test("a bad room key or control message closes the daemon", async () => {
    const r = relay();
    const d = connect(r, "/v1/daemon?v=2");
    await d.opened;
    d.ws.send(JSON.stringify({ t: "open", key: "short" }));
    expect(await d.closed).toBe(CLOSE.bad);
    const e = connect(r, "/v1/daemon?v=2");
    await e.opened;
    e.ws.send("{not json");
    expect(await e.closed).toBe(CLOSE.bad);
  });

  test(`frames over ${MAX_FRAME} bytes close the sender`, async () => {
    const r = relay();
    const { d, room } = await daemonWithRoom(r);
    const p = connect(r, `/v1/phone?room=${room}`);
    await p.opened;
    p.ws.send(new Uint8Array(MAX_FRAME + 2));
    expect([1006, 1009, 4400]).toContain(await p.closed); // Bun drops it (1006/1009) or the relay closes it (4400)
    expect(d.msgs.some((m) => m instanceof Uint8Array)).toBe(false);
  });

  test("at most four phones per room", async () => {
    const r = relay();
    const { room } = await daemonWithRoom(r);
    const ok = [0, 1, 2, 3].map(() => connect(r, `/v1/phone?room=${room}`));
    expect(await Promise.all(ok.map((s) => s.opened))).toEqual([true, true, true, true]);
    await until(() => r.stats().phones === 4);
    const fifth = connect(r, `/v1/phone?room=${room}`);
    expect(await fifth.closed).toBe(CLOSE.limit);
  });

  test("a socket over its message rate is closed", async () => {
    const r = relay({ messageRate: { capacity: 5, perSecond: 1 } });
    const { room } = await daemonWithRoom(r);
    const p = connect(r, `/v1/phone?room=${room}`);
    await p.opened;
    for (let i = 0; i < 10; i++) p.ws.send(new Uint8Array([i]));
    expect(await p.closed).toBe(CLOSE.limit);
  });

  test("connections per address and the connect rate are capped", async () => {
    const r = relay({ perIpConnections: 2 });
    const a = connect(r, "/v1/daemon?v=2");
    const b = connect(r, "/v1/daemon?v=2");
    expect(await Promise.all([a.opened, b.opened])).toEqual([true, true]);
    const c = connect(r, "/v1/daemon?v=2");
    expect(await c.opened).toBe(false);
    const slow = relay({ connectRate: { capacity: 2, perSecond: 0.001 } });
    const x = connect(slow, "/v1/daemon?v=2");
    const y = connect(slow, "/v1/daemon?v=2");
    expect(await Promise.all([x.opened, y.opened])).toEqual([true, true]);
    const z = connect(slow, "/v1/daemon?v=2");
    expect(await z.opened).toBe(false);
  });

  test("a client-address header counts only when configured (it can't be spoofed around the cap otherwise)", async () => {
    const as = (r: RelayHandle, ip: string): Promise<boolean> => {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}/v1/daemon?v=2`, { headers: { "fly-client-ip": ip } } as unknown as string[]);
      sockets.push(ws);
      return new Promise((resolve) => { ws.onopen = () => resolve(true); ws.onclose = () => resolve(false); });
    };
    const behindProxy = relay({ perIpConnections: 1, clientIpHeader: "fly-client-ip" });
    expect(await as(behindProxy, "1.1.1.1")).toBe(true);
    expect(await as(behindProxy, "2.2.2.2")).toBe(true);
    expect(await as(behindProxy, "1.1.1.1")).toBe(false);
    const direct = relay({ perIpConnections: 1 });
    expect(await as(direct, "1.1.1.1")).toBe(true);
    expect(await as(direct, "2.2.2.2")).toBe(false); // same socket address: the header is ignored
  });

  test("a room claim whose socket closes while the key is hashing claims nothing (deterministic)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const r = relay({ roomOf: async (key) => { await gate; return roomOf(key); } });
    const d = connect(r, "/v1/daemon?v=2");
    await d.opened;
    d.ws.send(JSON.stringify({ t: "open", key: b64u(randomBytes(32)) }));
    await Bun.sleep(30); // the claim is waiting on the hash
    d.ws.close();
    await d.closed;
    await until(() => r.stats().connections === 0);
    release();
    await Bun.sleep(30);
    expect(r.stats().rooms).toBe(0);
  });

  test("room operations run one at a time, in order: open then close leaves nothing", async () => {
    let calls = 0;
    const r = relay({ roomOf: async (key) => { calls += 1; await Bun.sleep(calls === 1 ? 40 : 0); return roomOf(key); } });
    const d = connect(r, "/v1/daemon?v=2");
    await d.opened;
    const key = randomBytes(32);
    const room = await roomOf(key);
    d.ws.send(JSON.stringify({ t: "open", key: b64u(key) }));
    d.ws.send(JSON.stringify({ t: "close", room }));
    await until(() => ctl(d).some((m) => m.t === "opened"));
    await Bun.sleep(20);
    expect(r.stats().rooms).toBe(0);
  });

  test("addresses: IPv4 as is, IPv6 by its /64", () => {
    expect(ipKey("1.2.3.4")).toBe("1.2.3.4");
    expect(ipKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(ipKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:0db8::1")).toBe("2001:db8:0:0::/64");
  });

  test("phone frame sizes at the boundaries: 0 and MAX_FRAME + 1 close that phone only; 1 and MAX_FRAME are forwarded", async () => {
    const r = relay();
    const { d, room } = await daemonWithRoom(r);
    const bins = () => d.msgs.filter((m): m is Uint8Array => m instanceof Uint8Array);
    for (const [n, forwarded] of [[0, false], [1, true], [MAX_FRAME, true], [MAX_FRAME + 1, false]] as const) {
      const p = connect(r, `/v1/phone?room=${room}`);
      await p.opened;
      const before = bins().length;
      p.ws.send(new Uint8Array(n).fill(9));
      if (forwarded) {
        const got = await until(() => bins()[before]);
        expect(got.byteLength).toBe(n + 5);
        p.ws.close();
      } else {
        expect(await p.closed).toBe(CLOSE.bad);
        await Bun.sleep(20);
        expect(bins().length).toBe(before);
      }
    }
    expect(d.ws.readyState).toBe(WebSocket.OPEN); // the daemon's link never noticed
  });

  test("a computer that stops reading: the room that sent the most lately loses its phones first; another room's phone stays", async () => {
    const net = await import("node:net");
    const { randomBytes: rb } = await import("node:crypto");
    const r = relay({ backpressureLimit: 512 * 1024, perIpConnections: 100 });
    // a raw daemon: upgrades, claims two rooms, then never reads again
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const masked = (text: string) => {
      const p = Buffer.from(text);
      const m = rb(4);
      const out = Buffer.alloc(2 + 4 + p.length);
      out[0] = 0x81; out[1] = 0x80 | p.length; m.copy(out, 2);
      for (let i = 0; i < p.length; i++) out[6 + i] = (p[i] as number) ^ (m[i & 3] as number);
      return out;
    };
    const sock = net.connect(r.port, "127.0.0.1");
    sockets.push({ close: () => sock.destroy() } as unknown as WebSocket);
    await new Promise<void>((res) => sock.on("connect", () => res()));
    sock.write(`GET /v1/daemon?v=2 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${rb(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    await Bun.sleep(100);
    sock.write(masked(JSON.stringify({ t: "open", key: b64u(keyA) })));
    sock.write(masked(JSON.stringify({ t: "open", key: b64u(keyB) })));
    await Bun.sleep(200);
    sock.pause(); // stop reading
    const a = connect(r, `/v1/phone?room=${await roomOf(keyA)}`);
    const b = connect(r, `/v1/phone?room=${await roomOf(keyB)}`);
    expect(await Promise.all([a.opened, b.opened])).toEqual([true, true]);
    b.ws.send(new Uint8Array(100)); // B: a little
    // A: a lot, until the relay closes it (the computer's socket backs up)
    let aClosed = false;
    a.closed.then(() => { aClosed = true; });
    for (let i = 0; i < 64 && !aClosed; i++) { a.ws.send(new Uint8Array(MAX_FRAME / 2)); await Bun.sleep(20); }
    expect(await a.closed).toBe(CLOSE.limit);
    expect(b.ws.readyState).toBe(WebSocket.OPEN); // the quiet room's phone was not the one dropped
  }, 20_000);
});
