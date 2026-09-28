// WALKIE-PWA-1 units: the handshake and channel (src/mobile/crypto.ts), pairing secrets, the device store, the
// phone allow-list, the development URL override and the terminal QR.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  b64u, Channel, daemonReply, hkdfKey, pairingKeys, phoneFinish, phoneHello, ProtocolError, randomBytes, readHello, roomOf, unb64u,
} from "../../src/mobile/crypto.ts";
import { DeviceSessions, DEVICE_IDLE_MS, DEVICE_MAX, DEVICE_MAX_MS, deviceName } from "../../src/daemon/mobile/devices.ts";
import { PairingSecrets, PAIR_MAX_FAILURES, PAIR_TTL_MS } from "../../src/daemon/mobile/pairing.ts";
import { mobileRoute, STREAM_TYPES } from "../../src/daemon/mobile/tunnel.ts";
import { APP_URL, mobileUrlsFromEnv, RELAY_URL } from "../../src/daemon/mobile/manager.ts";
import { qrRows } from "../../src/daemon/mobile/qr.ts";
import { renderQr } from "../../src/cli/commands/mobile.ts";

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);

async function handshake(kid = "pair", phonePsk?: CryptoKey, daemonPsk?: CryptoKey): Promise<{ phone: Channel; daemon: Channel }> {
  const psk = await hkdfKey(randomBytes(32));
  const h = await phoneHello(kid);
  const { frame, channel: daemon } = await daemonReply(readHello(h.frame), daemonPsk ?? psk);
  const phone = await phoneFinish(h.state, frame, phonePsk ?? psk);
  return { phone, daemon };
}

describe("handshake", () => {
  test("both sides end up with one channel, both directions", async () => {
    const { phone, daemon } = await handshake();
    expect(text(await daemon.open(await phone.seal(bytes("hi daemon"))))).toBe("hi daemon");
    expect(text(await phone.open(await daemon.seal(bytes("hi phone"))))).toBe("hi phone");
    expect(text(await phone.open(await daemon.seal(bytes("again"))))).toBe("again");
  });

  test("a phone with the wrong key refuses the daemon's reply (key confirmation)", async () => {
    await expect(handshake("pair", await hkdfKey(randomBytes(32)))).rejects.toBeInstanceOf(ProtocolError);
  });

  test("a relay can't answer for the daemon without the PSK", async () => {
    await expect(handshake("pair", undefined, await hkdfKey(randomBytes(32)))).rejects.toBeInstanceOf(ProtocolError);
  });

  test("the key id is bound into the keys", async () => {
    const psk = await hkdfKey(randomBytes(32));
    const h = await phoneHello("pair");
    const hello = readHello(h.frame);
    const { frame } = await daemonReply({ ...hello, kid: "d:0123456789ab" }, psk);
    await expect(phoneFinish(h.state, frame, psk)).rejects.toBeInstanceOf(ProtocolError);
  });

  test("malformed hellos are refused", () => {
    expect(() => readHello(new Uint8Array([2, 123, 125]))).toThrow(ProtocolError);
    expect(() => readHello(bytes("\u0001not json"))).toThrow(ProtocolError);
    expect(() => readHello(bytes(`\u0001${JSON.stringify({ v: 1, kid: "root", e: "AAAA" })}`))).toThrow(ProtocolError);
    expect(() => readHello(new Uint8Array(2_000).fill(1))).toThrow(ProtocolError);
  });

  test("an invalid ephemeral key is refused", async () => {
    const psk = await hkdfKey(randomBytes(32));
    await expect(daemonReply({ kid: "pair", e: new Uint8Array(65) }, psk)).rejects.toBeInstanceOf(ProtocolError);
    await expect(daemonReply({ kid: "pair", e: new Uint8Array(33).fill(4) }, psk)).rejects.toBeInstanceOf(ProtocolError);
  });
});

describe("channel: tamper, replay, reorder", () => {
  test("a flipped bit anywhere fails authentication and the channel stays dead", async () => {
    const { phone, daemon } = await handshake();
    for (const at of [0, 1, 8, 9, 20]) {
      const pair = await handshake();
      const f = await pair.phone.seal(bytes("payload payload payload"));
      const bad = f.slice();
      bad[Math.min(at, bad.length - 1)] = (bad[Math.min(at, bad.length - 1)] as number) ^ 1;
      await expect(pair.daemon.open(bad)).rejects.toBeInstanceOf(ProtocolError);
      await expect(pair.daemon.open(f)).rejects.toThrow(); // dead after a failure
    }
    expect(text(await daemon.open(await phone.seal(bytes("ok"))))).toBe("ok");
  });

  test("a replayed frame is refused", async () => {
    const { phone, daemon } = await handshake();
    const f = await phone.seal(bytes("once"));
    await daemon.open(f);
    await expect(daemon.open(f)).rejects.toThrow(/replayed|out-of-order/);
  });

  test("reordered or dropped frames are refused", async () => {
    const { phone, daemon } = await handshake();
    await phone.seal(bytes("first"));
    const second = await phone.seal(bytes("second"));
    await expect(daemon.open(second)).rejects.toThrow(/out-of-order/);
  });

  test("a frame from another session is refused", async () => {
    const a = await handshake();
    const b = await handshake();
    await expect(b.daemon.open(await a.phone.seal(bytes("x")))).rejects.toBeInstanceOf(ProtocolError);
  });

  test("a frame reflected back to its sender is refused (keys differ per direction)", async () => {
    const { phone } = await handshake();
    await expect(phone.open(await phone.seal(bytes("echo")))).rejects.toBeInstanceOf(ProtocolError);
  });

  test("concurrent seals leave in counter order", async () => {
    const { phone, daemon } = await handshake();
    const frames = await Promise.all(Array.from({ length: 20 }, (_, i) => phone.seal(bytes(`m${i}`))));
    for (let i = 0; i < 20; i++) expect(text(await daemon.open(frames[i] as Uint8Array))).toBe(`m${i}`);
  });
});

describe("pairing secrets", () => {
  test("a pairing code is <room>.<secret>: the PSK comes from the secret; the room is claimed with a key that isn't in the code", async () => {
    const p = new PairingSecrets();
    const a = await p.mint();
    const [room, secret] = a.code.split(".");
    expect(room).toBe(a.room);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await roomOf(a.claimKey)).toBe(a.room);
    expect(a.code).not.toContain(b64u(a.claimKey));
    const k = await pairingKeys(a.code);
    expect(k.room).toBe(a.room);
    // the same secret gives the same PSK: a handshake with each side's key works
    const h = await phoneHello("pair");
    const { frame } = await daemonReply(readHello(h.frame), a.psk);
    await phoneFinish(h.state, frame, k.psk);
    await expect(pairingKeys("short")).rejects.toBeInstanceOf(ProtocolError);
    await expect(pairingKeys(b64u(randomBytes(16)))).rejects.toBeInstanceOf(ProtocolError); // a secret alone isn't a code
  });

  test("single use, 10 minutes, a few at a time, voided after repeated failures", async () => {
    let now = 1_000_000;
    const p = new PairingSecrets({ now: () => now });
    const a = await p.mint();
    expect(a.code).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(a.expires_at).toBe(now + PAIR_TTL_MS);
    expect(p.consume(a.room)).toBe(true);
    expect(p.consume(a.room)).toBe(false);
    const b = await p.mint();
    now += PAIR_TTL_MS;
    expect(p.get(b.room)).toBeNull();
    const c = await p.mint();
    for (let i = 1; i < PAIR_MAX_FAILURES; i++) expect(p.fail(c.room)).toBe(false);
    expect(p.fail(c.room)).toBe(true);
    expect(p.get(c.room)).toBeNull();
    const many = [await p.mint(), await p.mint(), await p.mint(), await p.mint()];
    expect(p.get((many[0] as { room: string }).room)).toBeNull(); // the oldest is dropped past three
    expect(p.size).toBe(3);
  });
});

describe("device store", () => {
  const dir = () => mkdtempSync("/tmp/walkie-dev-");

  test("keys are persisted 0600, listed without the key, and survive a reload", () => {
    const d = dir();
    const file = join(d, "devices.json");
    const s = new DeviceSessions(file);
    const { key, device } = s.create("Alex's iPhone");
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(unb64u(key).byteLength).toBe(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(s.list())).not.toContain(key);
    const again = new DeviceSessions(file);
    expect(again.keyOf(device.id)).toBe(key);
    rmSync(d, { recursive: true, force: true });
  });

  test("30 days idle or 90 days absolute ends a device; touch keeps it alive until the absolute end", () => {
    const d = dir();
    let now = 5_000_000;
    const s = new DeviceSessions(join(d, "devices.json"), { now: () => now });
    const a = s.create("a").device;
    now += DEVICE_IDLE_MS - 1;
    expect(s.touch(a.id)).toBe(true);
    now += DEVICE_IDLE_MS - 1;
    expect(s.keyOf(a.id)).not.toBeNull();
    now += 1;
    expect(s.keyOf(a.id)).toBeNull();
    const b = s.create("b").device;
    for (let t = 0; t < DEVICE_MAX_MS; t += DEVICE_IDLE_MS / 2) { now += DEVICE_IDLE_MS / 2; if (now < b.expires_at) expect(s.touch(b.id)).toBe(true); }
    expect(s.touch(b.id)).toBe(false);
    rmSync(d, { recursive: true, force: true });
  });

  test("revoke, revoke all, and a cap on paired devices", () => {
    const d = dir();
    let now = 1;
    const s = new DeviceSessions(join(d, "devices.json"), { now: () => now++ });
    const ids = Array.from({ length: DEVICE_MAX + 2 }, (_, i) => s.create(`p${i}`).device.id);
    expect(s.size).toBe(DEVICE_MAX);
    expect(s.keyOf(ids[0] as string)).toBeNull(); // least recently used went first
    expect(s.revoke(ids[5] as string)).toBe(true);
    expect(s.revoke(ids[5] as string)).toBe(false);
    expect(s.revokeAll()).toBe(DEVICE_MAX - 1);
    expect(s.list()).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });

  test("a malformed file is ignored, never trusted", () => {
    const d = dir();
    const file = join(d, "devices.json");
    writeFileSync(file, JSON.stringify({ devices: [{ id: "zz", key: "k" }, { id: "0123456789ab", key: "short", name: "x", created_at: 1, last_seen: 1, expires_at: 2 }] }));
    expect(new DeviceSessions(file).list()).toEqual([]);
    writeFileSync(file, "{not json");
    expect(new DeviceSessions(file).list()).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });

  test("device names are one printable line", () => {
    expect(deviceName("iPhone\u0000\n<script>")).toBe("iPhone script");
    expect(deviceName("")).toBe("Phone");
    expect(deviceName(42)).toBe("Phone");
    expect(deviceName("x".repeat(100)).length).toBe(40);
  });
});

describe("the phone allow-list", () => {
  test("Mission Control only", () => {
    for (const [m, p] of [["GET", "/v1/me"], ["GET", "/v1/team"], ["GET", "/v1/agents"], ["GET", "/v1/peers"], ["GET", "/v1/events"],
      ["GET", "/v1/events/0123456789abcdef:12"], ["GET", "/v1/asks"], ["POST", "/v1/post"], ["POST", "/v1/answer"]] as const) {
      expect({ m, p, ok: mobileRoute(m, p) }).toEqual({ m, p, ok: true });
    }
    for (const [m, p] of [["GET", "/v1/accounts"], ["GET", "/v1/license"], ["GET", "/v1/integrations"], ["POST", "/v1/team/invite"],
      ["POST", "/v1/team/member"], ["POST", "/v1/ask"], ["POST", "/v1/status"], ["GET", "/v1/stream"], ["POST", "/v1/me"],
      ["GET", "/v1/asks/x"], ["GET", "/v1/mobile"], ["POST", "/v1/mobile/pair"], ["DELETE", "/v1/post"], ["GET", "/v1/events/a/b"],
      ["GET", "/v1/events/abc_DEF-1"], ["GET", "/v1/events/0123456789abcdef:0"], ["GET", "/v1/events/0123456789abcdef:1/x"]] as const) {
      expect({ m, p, ok: mobileRoute(m, p) }).toEqual({ m, p, ok: false });
    }
    expect(STREAM_TYPES.has("accounts")).toBe(false);
  });
});

describe("development URLs", () => {
  test("only loopback, only with WALKIE_DEV=1, never in a release build", () => {
    const env = { WALKIE_DEV: "1", WALKIE_RELAY_URL: "ws://127.0.0.1:9999", WALKIE_MOBILE_APP_URL: "http://localhost:8000/m" };
    expect(mobileUrlsFromEnv(env, false)).toEqual({ relayUrl: "ws://127.0.0.1:9999", appUrl: "http://localhost:8000/m" });
    expect(mobileUrlsFromEnv(env, true)).toEqual({ relayUrl: RELAY_URL, appUrl: APP_URL });
    expect(mobileUrlsFromEnv({ ...env, WALKIE_DEV: undefined }, false)).toEqual({ relayUrl: RELAY_URL, appUrl: APP_URL });
    expect(mobileUrlsFromEnv({ WALKIE_DEV: "1", WALKIE_RELAY_URL: "wss://evil.example", WALKIE_MOBILE_APP_URL: "https://evil.example/m" }, false))
      .toEqual({ relayUrl: RELAY_URL, appUrl: APP_URL });
    expect(APP_URL).toBe("https://getwalkie.vercel.app/m");
  });
});

describe("QR", () => {
  test("a square matrix, rendered two rows per line with a quiet zone", () => {
    const rows = qrRows("https://getwalkie.vercel.app/m#pair=AAAAAAAAAAAAAAAAAAAAAA");
    expect(rows.length).toBeGreaterThanOrEqual(21);
    expect(rows.every((r) => r.length === rows.length)).toBe(true);
    expect(rows[0]?.startsWith("1111111")).toBe(true); // finder pattern
    const out = renderQr(rows).split("\n");
    expect(out.length).toBe(Math.ceil((rows.length + 4) / 2));
  });
});

describe("the reset page (round 2)", () => {
  test("nothing is cleared by loading it: no Clear-Site-Data header, the reset runs only from the button", async () => {
    const vercel = await Bun.file(new URL("../../site/vercel.json", import.meta.url)).text();
    expect(vercel).not.toContain("Clear-Site-Data");
    const html = await Bun.file(new URL("../../site/m/reset.html", import.meta.url)).text();
    expect(html).toContain('id="reset"');
    const js = await Bun.file(new URL("../../site/m/reset.js", import.meta.url)).text();
    const handler = js.indexOf('addEventListener("click"');
    expect(handler).toBeGreaterThan(0);
    for (const call of ["deleteDatabase", "caches.delete", "unregister"]) expect(js.indexOf(call)).toBeGreaterThan(handler);
  });
});

describe("tunnel intake (Opus r2 4)", () => {
  test("while the handshake is pending, a frame bigger than a hello ends the link at once (nothing is queued)", async () => {
    const { TunnelSession } = await import("../../src/daemon/mobile/tunnel.ts");
    const { RateLimiter } = await import("../../src/daemon/ratelimit.ts");
    let kicked = 0;
    let queued = 0;
    const s = new TunnelSession({
      kind: "pair", room: "r", send: () => "sent" as const, reserve: () => ({ bytes: 0, counted: () => 0, release: () => undefined }), kick: () => { kicked += 1; },
      psk: () => new Promise(() => undefined), // the handshake never finishes
      register: () => { throw new Error("no"); }, registered: () => undefined, info: () => null,
      touch: () => true, live: () => true, expiresAt: () => null, usage: () => ({ inflight: 0, streams: 0 }),
      unpair: () => undefined, handshakeFailed: () => undefined,
      queue: (b: number) => { queued += b; return true; }, channelExists: () => true,
      serve: () => { throw new Error("no"); }, limiter: new RateLimiter(),
      log: { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined } as never,
    });
    const h = await phoneHello("pair");
    s.onFrame(h.frame);
    await Bun.sleep(5);
    expect(kicked).toBe(0);
    s.onFrame(new Uint8Array(1024 * 1024));
    expect(kicked).toBe(1); // synchronously, before copying
    expect(queued).toBe(h.frame.byteLength); // only the hello was ever queued
    s.dispose();
  });
});

test("the phone's 4 000-character cut never splits a surrogate pair (round 5 INFO)", async () => {
  const { phoneEvent, PHONE_TEXT_MAX, PHONE_TEXT_MORE } = await import("../../src/daemon/mobile/projection.ts");
  const text = "a".repeat(PHONE_TEXT_MAX - 1) + "😀".repeat(10); // the cut falls between an emoji's two halves
  const ev = phoneEvent({ id: "e", kind: "msg.post", channel: "c", body: { text } }) as { body: { text: string; truncated: boolean } };
  expect(ev.body.truncated).toBe(true);
  expect(ev.body.text).toBe("a".repeat(PHONE_TEXT_MAX - 1) + PHONE_TEXT_MORE);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(ev.body.text)).toBe(false); // no lone high surrogate
  const even = phoneEvent({ id: "e", kind: "msg.post", channel: "c", body: { text: "a".repeat(PHONE_TEXT_MAX - 2) + "😀".repeat(10) } }) as { body: { text: string } };
  expect(even.body.text).toBe("a".repeat(PHONE_TEXT_MAX - 2) + "😀" + PHONE_TEXT_MORE);
});

test("the truncation marker comes only from the projection's own cut, never from a body's `truncated` field (Opus r7 INFO 4)", async () => {
  const { phoneEvent, PHONE_TEXT_MAX, PHONE_TEXT_MORE } = await import("../../src/daemon/mobile/projection.ts");
  const { cutAskView } = await import("../../src/daemon/views.ts");
  const spoofed = phoneEvent({ id: "e", kind: "msg.post", channel: "c", body: { text: "hi", truncated: true } }) as { body: Record<string, unknown> };
  expect(spoofed.body).toEqual({ text: "hi" }); // no marker, no "open on your computer" suffix
  // What the tunnel asks the local API for (text_max = PHONE_TEXT_MAX + 2) is still cut, and marked, by the projection,
  // whether the local API's cut fell between an emoji's halves or not.
  for (const text of ["b".repeat(9_000), "b".repeat(PHONE_TEXT_MAX + 1) + "😀".repeat(10)]) {
    const ask = { id: "a", kind: "ask", channel: "c", body: { to: "@me", text, expires_at: 1 } };
    const cut = cutAskView({ ask, answers: [], state: "open", expires_at: 1 } as never, PHONE_TEXT_MAX + 2);
    const ev = phoneEvent(cut.ask) as { body: { text: string; truncated?: boolean } };
    expect(ev.body.truncated).toBe(true);
    expect(ev.body.text.endsWith(PHONE_TEXT_MORE)).toBe(true);
    expect(ev.body.text.length).toBeLessThanOrEqual(PHONE_TEXT_MAX + PHONE_TEXT_MORE.length);
  }
});

test("a phone view stopped while its first load is in flight never schedules anything afterwards (Codex r6 4)", async () => {
  const { Mission } = await import("../../src/mobile/pwa/mission.ts");
  let finish: () => void = () => undefined;
  let subscribed = 0;
  const view = {
    stopped: false, cancelStream: null, refetch: null, resubscribe: null, ticker: null as ReturnType<typeof setInterval> | null,
    updatedAt: 0, loadedAt: 0,
    loadAll: () => new Promise<void>((r) => { finish = r; }),
    subscribe: () => { subscribed += 1; }, render: () => undefined, freshness: () => undefined,
  };
  const proto = Mission.prototype as unknown as { start(this: unknown): Promise<void>; stop(this: unknown): void; soon(this: unknown, fn: () => Promise<void>): void };
  const started = proto.start.call(view);
  proto.stop.call(view); // the link dropped during the load
  finish();
  await started;
  const leaked = view.ticker;
  if (leaked) clearInterval(leaked);
  expect(leaked).toBe(null);
  expect(subscribed).toBe(0);
  proto.soon.call(view, async () => undefined);
  expect(view.refetch).toBe(null);
});
