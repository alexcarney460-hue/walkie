// DIRECT-FIX-2 (Opus r2 HIGH 1 + 2, Codex r2 HIGH 1, Opus r2 LOW 5 + 6): the Walkie Direct server budgets
// pending handshakes per source before any native work, keeps a source's slots until its native handshakes really
// end, gives admitted relay senders their own lane, sends QUIC Retry under load, evicts a member's stalest idle
// connection at its cap, and keeps accepting after an acceptNext error. Driven with simulated iroh objects.
import { describe, expect, test } from "bun:test";
import type * as Iroh from "@number0/iroh";
import { DirectNet, type DirectDeps, type DirectLimits } from "../../src/daemon/direct/net.ts";
import { ipSourceKey, sourceOf } from "../../src/daemon/direct/sources.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { createLogger } from "../../src/daemon/logger.ts";

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const tick = (ms = 0): Promise<void> => Bun.sleep(ms);
const hex = (pubkey: string): string => Buffer.from(pubkey, "base64").toString("hex");

interface Fake {
  inc: Iroh.Incoming; refused: () => boolean; accepted: () => boolean; retried: () => boolean; ignored: () => boolean;
}

function incoming(from: Iroh.IncomingAddr, opts: { validated?: boolean; connect?: () => Promise<Iroh.Connection> } = {}): Fake {
  const s = { refused: false, accepted: false, retried: false, ignored: false };
  const inc = {
    remoteAddr: async () => from,
    remoteAddrValidated: async () => opts.validated ?? true,
    accept: async () => { s.accepted = true; return { connect: opts.connect ?? never }; },
    refuse: async () => { s.refused = true; },
    retry: async () => { s.retried = true; },
    ignore: async () => { s.ignored = true; },
  };
  return {
    inc: inc as unknown as Iroh.Incoming,
    refused: () => s.refused, accepted: () => s.accepted, retried: () => s.retried, ignored: () => s.ignored,
  };
}

const ip = (addr: string): Iroh.IncomingAddr => ({ kind: "ip", addr });
const relay = (endpointId: string): Iroh.IncomingAddr => ({ kind: "relay", addr: "https://relay.example./", endpointId });

function server(admitted: (pk: string) => boolean, limits: Partial<DirectLimits> = {}, ep: object = { close: async () => undefined, acceptNext: never }) {
  const warnings: string[] = [];
  const log = { ...createLogger({}), warn: (msg: string) => { warnings.push(msg); } };
  const deps: DirectDeps = { keys: generateKeys(), log: log as DirectDeps["log"], admitted, handler: async () => new Response("x") };
  const net = Reflect.construct(DirectNet as unknown as new (...a: unknown[]) => DirectNet, [ep, deps, { limits }]);
  const priv = net as unknown as { accept(inc: Iroh.Incoming): Promise<void>; acceptLoop(): Promise<void>; incoming: Set<unknown>; stopped: boolean };
  return { net, priv, warnings };
}

async function offer(priv: { accept(inc: Iroh.Incoming): Promise<void> }, fakes: Fake[]): Promise<void> {
  for (const f of fakes) void priv.accept(f.inc);
  await tick();
}

describe("per-source handshake budget", () => {
  test("one IP gets at most 4 native handshakes; another IP still gets in", async () => {
    const { net, priv } = server(() => false);
    const flood = Array.from({ length: 40 }, (_, i) => incoming(ip(`203.0.113.7:${40000 + i}`)));
    await offer(priv, flood);
    const other = incoming(ip("198.51.100.9:5000"));
    await offer(priv, [other]);
    const started = flood.filter((f) => f.accepted()).length;
    console.log(`[evidence] 40 stalled attempts from one IP (many ports): started=${started} refused=${flood.filter((f) => f.refused()).length} other_ip_started=${other.accepted()}`);
    expect(started).toBe(4);
    expect(flood.filter((f) => f.refused()).length).toBe(36);
    expect(other.accepted()).toBe(true);
    expect(net.stats().pendingBySource.get("ip:203.0.113.7")).toBe(4);
  });

  test("waves past the ceiling can't pile native work up: one source never has more than 4 running (Codex r2: 32→64→96→128)", async () => {
    const { net, priv } = server(() => false, { handshakeMs: 10, handshakeCeilingMs: 20 });
    let started = 0;
    for (let wave = 0; wave < 4; wave++) {
      const fakes = Array.from({ length: 32 }, (_, i) => incoming(ip(`203.0.113.7:${i + 1}`)));
      await offer(priv, fakes);
      started += fakes.filter((f) => f.accepted()).length;
      await tick(40); // past the ceiling: the lane slots come back
    }
    console.log(`[evidence] 4 waves x 32 never-settling handshakes from one IP: native started=${started} lane pending=${net.stats().pending} source held=${net.stats().pendingBySource.get("ip:203.0.113.7")}`);
    expect(started).toBe(4);
    expect(net.stats().pending).toBe(0); // the lane is free for everyone else
    expect(net.stats().pendingBySource.get("ip:203.0.113.7")).toBe(4);
  });

  test("the source slot comes back when the native handshake ends", async () => {
    const { net, priv } = server(() => false, { handshakeMs: 10, handshakeCeilingMs: 20 });
    let fail: (e: Error) => void = () => undefined;
    const f = incoming(ip("203.0.113.7:1"), { connect: () => new Promise<Iroh.Connection>((_, rej) => { fail = rej; }) });
    await offer(priv, [f]);
    await tick(40);
    expect(net.stats().pendingBySource.get("ip:203.0.113.7")).toBe(1);
    fail(new Error("idle timeout"));
    await tick();
    expect(net.stats().pendingBySource.size).toBe(0);
  });

  test("one IPv6 /64 is one source; IPv4-mapped IPv6 counts as the IPv4 address", () => {
    expect(ipSourceKey("[2001:db8:1:2:aaaa::1]:443")).toBe(ipSourceKey("[2001:db8:1:2:ffff:ffff:ffff:ffff]:9"));
    expect(ipSourceKey("[2001:db8:1:2::1]:443")).not.toBe(ipSourceKey("[2001:db8:1:3::1]:443"));
    expect(ipSourceKey("[::ffff:203.0.113.7]:1")).toBe(ipSourceKey("203.0.113.7:2"));
    expect(ipSourceKey("[fe80::1%en0]:1")).toBe("ip6:fe80:0:0:0::/64");
    const id = "ab".repeat(32);
    expect(sourceOf(relay(id))).toEqual({ key: `relay:${id}`, prefix: null, endpoint: id, via: "relay" });
    expect(sourceOf({ kind: "custom", description: "x" }).key).toBe("other");
  });

  test("unvalidated attempts over a limit are ignored (no packet to a maybe-spoofed address), not refused", async () => {
    const { priv } = server(() => false, { retryAbove: 1_000 });
    const fakes = Array.from({ length: 6 }, (_, i) => incoming(ip(`203.0.113.7:${i + 1}`), { validated: false }));
    await offer(priv, fakes);
    expect(fakes.filter((f) => f.accepted()).length).toBe(4);
    expect(fakes.filter((f) => f.ignored()).length).toBe(2);
    expect(fakes.some((f) => f.refused())).toBe(false);
  });
});

describe("Retry under load", () => {
  test("above retryAbove pending, an unvalidated UDP source is sent a Retry; a validated one goes ahead", async () => {
    const { net, priv } = server(() => false, { retryAbove: 3 });
    await offer(priv, Array.from({ length: 3 }, (_, i) => incoming(ip(`198.51.100.${i + 1}:1`))));
    expect(net.stats().pending).toBe(3);
    const spoofable = incoming(ip("192.0.2.1:1"), { validated: false });
    const validated = incoming(ip("192.0.2.2:1"), { validated: true });
    await offer(priv, [spoofable, validated]);
    expect(spoofable.retried()).toBe(true);
    expect(spoofable.accepted()).toBe(false);
    expect(validated.accepted()).toBe(true);
  });
});

describe("relay path lanes", () => {
  test("an admitted key arriving by relay has its own lane: a full direct lane doesn't lock it (or a relay joiner) out", async () => {
    const member = generateKeys().pubkey;
    const { net, priv } = server((pk) => pk === member);
    await offer(priv, Array.from({ length: 40 }, (_, i) => incoming(ip(`10.0.${i}.1:1`))));
    expect(net.stats().pending).toBe(24); // the direct path's share of the general lane (DIRECT-FIX-3)
    const m = incoming(relay(hex(member)));
    const stranger = incoming(relay(hex(generateKeys().pubkey)));
    const ipMember = incoming(ip("10.9.9.9:1")); // by IP the key is unknown until the handshake: the general lane
    await offer(priv, [m, stranger, ipMember]);
    console.log(`[evidence] direct share of the general lane full (24): relay member started=${m.accepted()} relay stranger started=${stranger.accepted()} ip attempt refused=${ipMember.refused()}`);
    expect(m.accepted()).toBe(true);
    expect(net.stats().pendingMembers).toBe(1);
    // DIRECT-FIX-3: the direct path can't take the general lane's last 8 slots; a relay stranger (a joiner) can.
    expect(stranger.accepted()).toBe(true);
    expect(ipMember.refused()).toBe(true);
  });

  test("relay strangers (ids are free to mint) share 16 native slots, held until each ends, so the IP path keeps room", async () => {
    const { net, priv } = server(() => false, { handshakeMs: 10, handshakeCeilingMs: 20 });
    const minted = Array.from({ length: 30 }, () => incoming(relay(hex(generateKeys().pubkey))));
    await offer(priv, minted);
    expect(minted.filter((f) => f.accepted()).length).toBe(16);
    expect(net.stats().pending).toBe(16);
    const byIp = incoming(ip("198.51.100.1:1"));
    await offer(priv, [byIp]);
    expect(byIp.accepted()).toBe(true);
    await tick(40); // past the ceiling: lane slots back, the relay pool is not
    const more = Array.from({ length: 5 }, () => incoming(relay(hex(generateKeys().pubkey))));
    await offer(priv, more);
    expect(net.stats().relayStrangers).toBe(16);
    expect(more.some((f) => f.accepted())).toBe(false);
  });

  test("one relay sender id holds at most 4, like an IP", async () => {
    const { priv } = server(() => false);
    const id = hex(generateKeys().pubkey);
    const fakes = Array.from({ length: 8 }, () => incoming(relay(id)));
    await offer(priv, fakes);
    expect(fakes.filter((f) => f.accepted()).length).toBe(4);
  });
});

/** A completed connection; `busy` of its streams stay in flight (their request head never arrives). */
function conn(pubkey: string, busy = 0) {
  const state = { closed: null as string | null };
  let onClose: () => void = () => undefined;
  const closed = new Promise<void>((r) => { onClose = r; });
  let handed = 0;
  const bi = { send: { reset: async () => undefined }, recv: { readExact: never, stop: async () => undefined } };
  const c = {
    alpn: () => [...Buffer.from("walkie/1")],
    remoteId: () => ({ toBytes: () => [...Buffer.from(pubkey, "base64")] }),
    setMaxConcurrentBiStreams: () => undefined,
    acceptBi: () => (handed++ < busy ? Promise.resolve(bi) : closed.then(() => { throw new Error("closed"); })),
    close: (_c: bigint, reason: number[]) => { state.closed ??= Buffer.from(reason).toString() || "closed"; onClose(); },
  };
  return { conn: c as unknown as Iroh.Connection, state };
}

describe("per-key cap (Opus r2 LOW 5)", () => {
  test("a member at its cap reconnecting evicts its stalest idle connection instead of being refused", async () => {
    const key = generateKeys().pubkey;
    const { net, priv } = server(() => true);
    const old = Array.from({ length: 4 }, () => conn(key));
    for (const c of old) { await offer(priv, [incoming(ip(`10.1.1.${old.indexOf(c) + 1}:1`), { connect: async () => c.conn })]); await tick(2); }
    const fresh = conn(key);
    await offer(priv, [incoming(ip("10.1.1.9:1"), { connect: async () => fresh.conn })]);
    console.log(`[evidence] 5th connection of a member with 4 idle: fresh=${fresh.state.closed ?? "open"} evicted=${old.map((c) => c.state.closed ?? "open").join(",")}`);
    expect(fresh.state.closed).toBeNull();
    expect(old[0]?.state.closed).toBe("replaced");
    expect(old.slice(1).every((c) => c.state.closed === null)).toBe(true);
    expect(net.stats().admittedByKey.get(key)).toBe(4);
  });

  test("with all 4 connections busy, a 5th is still refused (bounded)", async () => {
    const key = generateKeys().pubkey;
    const { net, priv } = server(() => true);
    const busy = Array.from({ length: 4 }, () => conn(key, 1));
    for (const c of busy) await offer(priv, [incoming(ip(`10.2.2.${busy.indexOf(c) + 1}:1`), { connect: async () => c.conn })]);
    await tick(2);
    const fifth = conn(key);
    await offer(priv, [incoming(ip("10.2.2.9:1"), { connect: async () => fifth.conn })]);
    expect(fifth.state.closed).toBe("busy");
    expect(busy.every((c) => c.state.closed === null)).toBe(true);
    expect(net.stats().admittedByKey.get(key)).toBe(4);
  });

  test("a stranger at its cap is refused, not given eviction", async () => {
    const key = generateKeys().pubkey;
    const { priv } = server(() => false);
    const held = Array.from({ length: 4 }, () => conn(key));
    for (const c of held) await offer(priv, [incoming(ip(`10.3.3.${held.indexOf(c) + 1}:1`), { connect: async () => c.conn })]);
    const fifth = conn(key);
    await offer(priv, [incoming(ip("10.3.3.9:1"), { connect: async () => fifth.conn })]);
    expect(fifth.state.closed).toBe("busy");
    expect(held.every((c) => c.state.closed === null)).toBe(true);
  });
});

describe("accept loop (Opus r2 LOW 6)", () => {
  test("an acceptNext error is logged and the loop carries on", async () => {
    let calls = 0;
    const later = incoming(ip("10.4.4.4:1"));
    const ep = {
      close: async () => undefined,
      acceptNext: async () => {
        calls++;
        if (calls <= 2) throw new Error("transient");
        if (calls === 3) return later.inc;
        return never();
      },
    };
    const { priv, warnings } = server(() => false, {}, ep);
    void priv.acceptLoop();
    await tick(400);
    console.log(`[evidence] acceptNext calls=${calls} warnings=${JSON.stringify(warnings)} later accepted=${later.accepted()}`);
    expect(warnings.filter((w) => w === "direct_accept_failed").length).toBe(2);
    expect(later.accepted()).toBe(true);
    expect(calls).toBe(4);
    priv.stopped = true;
  });

  test("a closed endpoint (null) still ends the loop", async () => {
    let calls = 0;
    const ep = { close: async () => undefined, acceptNext: async () => { calls++; return null; } };
    const { priv } = server(() => false, {}, ep);
    await priv.acceptLoop();
    expect(calls).toBe(1);
  });
});
