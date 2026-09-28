// DIRECT-FIX-1 (Codex HIGH 1 + 2): the Walkie Direct server's connection budget, driven with simulated iroh
// handshakes. Pending handshakes are bounded before the first await and time out; one key can't hold the table;
// revocation closes a key's admitted connections, idle ones included.
import { describe, expect, test } from "bun:test";
import type * as Iroh from "@number0/iroh";
import { DirectNet, type DirectDeps, type DirectOptions } from "../../src/daemon/direct/net.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { createLogger } from "../../src/daemon/logger.ts";

interface FakeConn {
  closed: string | null;
  streams: bigint | null;
}

/** A completed connection from `pubkey` that stays idle (opens no streams) until it is closed. */
function fakeConn(pubkey: string): { conn: Iroh.Connection; state: FakeConn } {
  const state: FakeConn = { closed: null, streams: null };
  let onClose: () => void = () => undefined;
  const closed = new Promise<void>((r) => { onClose = r; });
  const conn = {
    alpn: () => [...Buffer.from("walkie/1")],
    remoteId: () => ({ toBytes: () => [...Buffer.from(pubkey, "base64")] }),
    setMaxConcurrentBiStreams: (n: bigint) => { state.streams = n; },
    acceptBi: () => closed.then(() => { throw new Error("connection closed"); }),
    close: (_code: bigint, reason: number[]) => { state.closed ??= Buffer.from(reason).toString() || "closed"; onClose(); },
  };
  return { conn: conn as unknown as Iroh.Connection, state };
}

let nextIp = 1;
/** A fresh IPv4 source (in its own /24) each call (so tests that aren't about sources aren't limited per source). */
const freshIp = (): Iroh.IncomingAddr => ({ kind: "ip", addr: `10.${(nextIp >> 8) & 255}.${nextIp++ & 255}.1:4433` });

interface FakeIncoming {
  inc: Iroh.Incoming;
  refused: () => boolean; accepted: () => boolean; retried: () => boolean; ignored: () => boolean;
}

/** An incoming connection from `from` (a validated address unless said otherwise) that completes when `connect` settles. */
function fakeIncoming(connect: () => Promise<Iroh.Connection>, from: Iroh.IncomingAddr = freshIp(), validated = true): FakeIncoming {
  let refused = false;
  let accepted = false;
  let retried = false;
  let ignored = false;
  const inc = {
    remoteAddr: async () => from,
    remoteAddrValidated: async () => validated,
    accept: async () => { accepted = true; return { connect }; },
    refuse: async () => { refused = true; },
    retry: async () => { retried = true; },
    ignore: async () => { ignored = true; },
  };
  return {
    inc: inc as unknown as Iroh.Incoming,
    refused: () => refused, accepted: () => accepted, retried: () => retried, ignored: () => ignored,
  };
}

const never = (): Promise<Iroh.Connection> => new Promise<Iroh.Connection>(() => undefined);

/** A DirectNet around a stand-in endpoint: only the server's accept path runs. */
function server(admitted: (pk: string) => boolean, limits: DirectOptions["limits"] = {}) {
  const ep = { close: async () => undefined, acceptNext: never };
  const deps: DirectDeps = { keys: generateKeys(), log: createLogger({}), admitted, handler: async () => new Response("x") };
  const net = Reflect.construct(DirectNet as unknown as new (...a: unknown[]) => DirectNet, [ep, deps, { limits }]);
  const priv = net as unknown as { accept(inc: Iroh.Incoming): Promise<void>; incoming: Set<unknown>; rosterChanged?: () => void };
  return { net, priv, ep, deps };
}

const tick = (ms = 0): Promise<void> => Bun.sleep(ms);

describe("Direct connection budget", () => {
  test("pending handshakes are bounded before native work: the rest are refused without starting", async () => {
    const { net, priv } = server(() => false);
    const all = Array.from({ length: 100 }, () => fakeIncoming(never));
    for (const f of all) void priv.accept(f.inc);
    await tick();
    const refused = all.filter((f) => f.refused()).length;
    const started = all.filter((f) => f.accepted()).length;
    console.log(`[evidence] 100 stalled handshakes from 100 sources: refused=${refused} started=${started} pending=${net.stats().pending}`);
    // The direct path takes 24 of the 32-slot general lane; 8 stay for relay-path joiners (DIRECT-FIX-3).
    expect(started).toBe(24);
    expect(refused).toBe(76);
    expect(net.stats().pending).toBe(24);
  });

  test("a stalled handshake times out; its slot frees when the native handshake ends, and the late connection is closed", async () => {
    const { net, priv } = server(() => true, { handshakeMs: 30, handshakeCeilingMs: 5_000 });
    const key = generateKeys().pubkey;
    const late = fakeConn(key);
    let finish: (c: Iroh.Connection) => void = () => undefined;
    const f = fakeIncoming(() => new Promise<Iroh.Connection>((r) => { finish = r; }));
    const done = priv.accept(f.inc);
    await tick(60);
    await done; // accept gave up at the timeout
    expect(net.stats().pending).toBe(1); // native handshake still running: its reservation is still held
    finish(late.conn);
    await tick();
    expect(net.stats().pending).toBe(0);
    expect(net.stats().pendingBySource.size).toBe(0);
    expect(late.state.closed).toBe("timeout");
    expect(priv.incoming.size).toBe(0);
  });

  test("a handshake that never settles natively gives its lane slot back at the ceiling, but not its source slot", async () => {
    const { net, priv } = server(() => true, { handshakeMs: 20, handshakeCeilingMs: 50 });
    const from = freshIp();
    await priv.accept(fakeIncoming(never, from).inc);
    expect(net.stats().pending).toBe(1);
    await tick(80);
    expect(net.stats().pending).toBe(0);
    expect(net.stats().pendingBySource.get(`ip:${from.addr?.split(":")[0]}`)).toBe(1); // native work may still run
  });

  test("one authenticated key holds at most 4 connections (newest kept, idle ones replaced); other keys still get in", async () => {
    const { priv } = server(() => true);
    const key = generateKeys().pubkey;
    const conns = Array.from({ length: 10 }, () => fakeConn(key));
    for (const c of conns) void priv.accept(fakeIncoming(async () => c.conn).inc);
    await tick();
    const open = conns.filter((c) => c.state.closed === null).length;
    console.log(`[evidence] 10 connections from one admitted key: open=${open} held=${priv.incoming.size}`);
    expect(open).toBe(4);
    // Idle ones make room for the newest (DIRECT-FIX-2, Opus r2 LOW 5): still never more than 4 held.
    expect(conns.filter((c) => c.state.closed === "replaced").length).toBe(6);
    const other = fakeConn(generateKeys().pubkey);
    void priv.accept(fakeIncoming(async () => other.conn).inc);
    await tick();
    expect(other.state.closed).toBeNull();
    expect(priv.incoming.size).toBe(5);
  });

  test("revocation closes the key's admitted connections, idle ones included, and frees their slots", async () => {
    const revoked = new Set<string>();
    const { priv } = server((pk) => !revoked.has(pk));
    const key = generateKeys().pubkey;
    const keep = generateKeys().pubkey;
    const theirs = Array.from({ length: 3 }, () => fakeConn(key));
    const ours = fakeConn(keep);
    for (const c of [...theirs, ours]) void priv.accept(fakeIncoming(async () => c.conn).inc);
    await tick();
    expect(priv.incoming.size).toBe(4);
    revoked.add(key);
    priv.rosterChanged?.();
    await tick();
    console.log(`[evidence] after revoking one key: closed=${theirs.filter((c) => c.state.closed).length}/3 held=${priv.incoming.size}`);
    expect(theirs.every((c) => c.state.closed === "revoked")).toBe(true);
    expect(ours.state.closed).toBeNull();
    expect(priv.incoming.size).toBe(1);
  });

  test("a key admitted while connected gets the member stream limit (and loses the 30 s lifetime)", async () => {
    const admitted = new Set<string>();
    const { priv } = server((pk) => admitted.has(pk), { unadmittedLifetimeMs: 40 });
    const key = generateKeys().pubkey;
    const c = fakeConn(key);
    void priv.accept(fakeIncoming(async () => c.conn).inc);
    await tick();
    expect(c.state.streams).toBe(4n);
    admitted.add(key);
    priv.rosterChanged?.();
    expect(c.state.streams).toBe(64n);
    await tick(80);
    expect(c.state.closed).toBeNull();
  });
});
