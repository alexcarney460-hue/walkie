// DIRECT-FIX-3 (Codex r3 HIGH 1 + 2, Opus r3 MEDIUM 1 + 2, Opus r3 LOW 4): hard bounds on the Walkie Direct
// server's native handshake work, driven with simulated iroh handshakes that never settle.
//  - a GLOBAL cap on native handshakes actually running (sum over every source and lane), released only when each
//    native handshake ends, with a share per path so stalled strangers can't take the members' or relay joiners' room;
//  - a per-MEMBER budget across that member's admitted keys on the relay member lane;
//  - an aggregate budget per IPv4 /24 and IPv6 /48, and general-lane slots only relay-path joiners can take.
import { describe, expect, test } from "bun:test";
import type * as Iroh from "@number0/iroh";
import { DirectNet, DEFAULT_DIRECT_LIMITS, type DirectDeps, type DirectLimits } from "../../src/daemon/direct/net.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { createLogger } from "../../src/daemon/logger.ts";

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const tick = (ms = 0): Promise<void> => Bun.sleep(ms);
const hex = (pubkey: string): string => Buffer.from(pubkey, "base64").toString("hex");

interface Fake { inc: Iroh.Incoming; refused: () => boolean; accepted: () => boolean }

function incoming(from: Iroh.IncomingAddr): Fake {
  const s = { refused: false, accepted: false };
  const inc = {
    remoteAddr: async () => from,
    remoteAddrValidated: async () => true,
    accept: async () => { s.accepted = true; return { connect: never }; },
    refuse: async () => { s.refused = true; },
    retry: async () => undefined,
    ignore: async () => undefined,
  };
  return { inc: inc as unknown as Iroh.Incoming, refused: () => s.refused, accepted: () => s.accepted };
}

const ip = (addr: string): Iroh.IncomingAddr => ({ kind: "ip", addr });
const relay = (endpointId: string): Iroh.IncomingAddr => ({ kind: "relay", addr: "https://relay.example./", endpointId });

/** A server whose roster maps each admitted key to its member's login. */
function server(members: ReadonlyMap<string, string>, limits: Partial<DirectLimits> = {}) {
  const ep = { close: async () => undefined, acceptNext: never };
  const deps: DirectDeps = {
    keys: generateKeys(), log: createLogger({}), handler: async () => new Response("x"),
    admitted: (pk) => members.has(pk), memberOf: (pk) => members.get(pk) ?? null,
  };
  const net = Reflect.construct(DirectNet as unknown as new (...a: unknown[]) => DirectNet, [ep, deps, { limits }]);
  const priv = net as unknown as { accept(inc: Iroh.Incoming): Promise<void> };
  return { net, priv };
}

async function offer(priv: { accept(inc: Iroh.Incoming): Promise<void> }, fakes: Fake[]): Promise<void> {
  for (const f of fakes) void priv.accept(f.inc);
  await tick();
}

const started = (fakes: Fake[]): number => fakes.filter((f) => f.accepted()).length;

describe("global cap on native handshakes (Codex r3 HIGH 1 / Opus r3 MEDIUM 2)", () => {
  test("waves of stalled handshakes from ever-fresh networks past the ceiling stop at the cap: 32 -> 64 -> ... no longer grows", async () => {
    const { net, priv } = server(new Map(), { handshakeMs: 5, handshakeCeilingMs: 10 });
    let total = 0;
    const perWave: number[] = [];
    for (let wave = 0; wave < 8; wave++) {
      // 32 attempts per wave, each from its own /24 (and so its own source): no per-source or per-prefix limit binds.
      const fakes = Array.from({ length: 32 }, (_, i) => incoming(ip(`10.${wave}.${i}.1:4433`)));
      await offer(priv, fakes);
      total += started(fakes);
      perWave.push(total);
      await tick(25); // past the ceiling: lane slots come back, the native handshakes don't end
    }
    const s = net.stats();
    console.log(`[evidence] 8 waves x 32 never-settling handshakes from fresh /24s: native started cumulative=${perWave.join("->")} ` +
      `native running=${s.native} lane pending=${s.pending}`);
    expect(total).toBe(DEFAULT_DIRECT_LIMITS.maxNativeDirect);
    expect(s.native).toBe(DEFAULT_DIRECT_LIMITS.maxNativeDirect);
    expect(s.pending).toBe(0);
  });

  test("with the direct path's native share used up, a member by relay and a joiner by relay still start", async () => {
    const member = generateKeys().pubkey;
    const { net, priv } = server(new Map([[member, "direct:mia"]]), { handshakeMs: 5, handshakeCeilingMs: 10 });
    for (let wave = 0; wave < 4; wave++) {
      await offer(priv, Array.from({ length: 32 }, (_, i) => incoming(ip(`10.${wave}.${i}.1:4433`))));
      await tick(25);
    }
    const byIp = incoming(ip("198.51.100.1:1"));
    const m = incoming(relay(hex(member)));
    const joiner = incoming(relay(hex(generateKeys().pubkey)));
    await offer(priv, [byIp, m, joiner]);
    console.log(`[evidence] direct share full (native=${net.stats().native}): new ip refused=${byIp.refused()} relay member started=${m.accepted()} relay joiner started=${joiner.accepted()}`);
    expect(byIp.refused()).toBe(true);
    expect(m.accepted()).toBe(true);
    expect(joiner.accepted()).toBe(true);
  });

  test("the sum over every path never exceeds maxNativeHandshakes, members included", async () => {
    const keys = Array.from({ length: 40 }, () => generateKeys().pubkey);
    const members = new Map(keys.map((k, i) => [k, `direct:m${i}`]));
    const { net, priv } = server(members, { handshakeMs: 5, handshakeCeilingMs: 10 });
    for (let wave = 0; wave < 4; wave++) {
      await offer(priv, [
        ...Array.from({ length: 32 }, (_, i) => incoming(ip(`10.${wave}.${i}.1:1`))),
        ...Array.from({ length: 16 }, () => incoming(relay(hex(generateKeys().pubkey)))),
        ...keys.flatMap((k) => Array.from({ length: 4 }, () => incoming(relay(hex(k))))),
      ]);
      await tick(25);
    }
    const s = net.stats();
    console.log(`[evidence] ip + relay strangers + 40 members, 4 waves: native=${s.native} (cap ${DEFAULT_DIRECT_LIMITS.maxNativeHandshakes}) relayStrangers=${s.relayStrangers}`);
    expect(s.native).toBe(DEFAULT_DIRECT_LIMITS.maxNativeHandshakes);
  });

  test("the connection cap counts running native handshakes, not just lane slots", async () => {
    const { net, priv } = server(new Map(), { handshakeMs: 5, handshakeCeilingMs: 10, maxConnections: 20 });
    for (let wave = 0; wave < 3; wave++) {
      await offer(priv, Array.from({ length: 16 }, (_, i) => incoming(ip(`10.${wave}.${i}.1:1`))));
      await tick(25);
    }
    expect(net.stats().native).toBe(20);
  });
});

describe("per-member budget on the relay member lane (Codex r3 HIGH 2)", () => {
  test("one member's 8 admitted keys can't fill the 32-slot member lane: another member's relay reconnect gets in", async () => {
    const attacker = Array.from({ length: 8 }, () => generateKeys().pubkey);
    const victim = generateKeys().pubkey;
    const members = new Map([...attacker.map((k) => [k, "direct:eve"] as const), [victim, "direct:sam"]]);
    const { net, priv } = server(members);
    const flood = attacker.flatMap((k) => Array.from({ length: 4 }, () => incoming(relay(hex(k)))));
    await offer(priv, flood);
    const v = incoming(relay(hex(victim)));
    await offer(priv, [v]);
    console.log(`[evidence] 8 keys x 4 relay attempts from one member: started=${started(flood)} refused=${flood.filter((f) => f.refused()).length} other member started=${v.accepted()}`);
    expect(started(flood)).toBe(DEFAULT_DIRECT_LIMITS.maxPendingPerMember);
    expect(v.accepted()).toBe(true);
    expect(net.stats().pendingByMember.get("direct:eve")).toBe(DEFAULT_DIRECT_LIMITS.maxPendingPerMember);
  });

  test("the member's slots are held until each native handshake ends, not just to the ceiling", async () => {
    const keys = Array.from({ length: 3 }, () => generateKeys().pubkey);
    const { priv } = server(new Map(keys.map((k) => [k, "direct:eve"])), { handshakeMs: 5, handshakeCeilingMs: 10 });
    const first = keys.flatMap((k) => Array.from({ length: 4 }, () => incoming(relay(hex(k)))));
    await offer(priv, first);
    await tick(25);
    const again = keys.flatMap((k) => Array.from({ length: 4 }, () => incoming(relay(hex(k)))));
    await offer(priv, again);
    expect(started(first)).toBe(8);
    expect(started(again)).toBe(0);
  });
});

describe("aggregate budget above /64 and relay-joiner slots (Opus r3 MEDIUM 1)", () => {
  test("a routed /48 is one budget, not hundreds of /64 sources", async () => {
    const { net, priv } = server(new Map());
    const fakes = Array.from({ length: 200 }, (_, i) => incoming(ip(`[2001:db8:77:${i.toString(16)}::1]:443`)));
    await offer(priv, fakes);
    const other = incoming(ip("[2001:db8:78::1]:443"));
    await offer(priv, [other]);
    console.log(`[evidence] 200 /64s inside one /48: started=${started(fakes)} another /48 started=${other.accepted()} lane=${net.stats().pending}`);
    expect(started(fakes)).toBe(DEFAULT_DIRECT_LIMITS.maxPendingPerPrefix);
    expect(other.accepted()).toBe(true);
  });

  test("an IPv4 /24 is one budget (IPv4-mapped IPv6 included)", async () => {
    const { priv } = server(new Map());
    const fakes = [
      ...Array.from({ length: 20 }, (_, i) => incoming(ip(`203.0.113.${i + 1}:1`))),
      ...Array.from({ length: 5 }, (_, i) => incoming(ip(`[::ffff:203.0.113.${100 + i}]:1`))),
    ];
    await offer(priv, fakes);
    expect(started(fakes)).toBe(DEFAULT_DIRECT_LIMITS.maxPendingPerPrefix);
  });

  test("a fixed set of real addresses filling the direct lane leaves slots only relay-path joiners can take", async () => {
    const { net, priv } = server(new Map());
    const fixed = Array.from({ length: 40 }, (_, i) => incoming(ip(`10.${i}.0.1:1`)));
    await offer(priv, fixed);
    const joiners = Array.from({ length: 10 }, () => incoming(relay(hex(generateKeys().pubkey))));
    await offer(priv, joiners);
    const reserve = DEFAULT_DIRECT_LIMITS.maxPendingHandshakes - DEFAULT_DIRECT_LIMITS.maxPendingDirect;
    console.log(`[evidence] 40 direct sources vs lane ${DEFAULT_DIRECT_LIMITS.maxPendingHandshakes}: direct started=${started(fixed)} relay joiners started=${started(joiners)}/10 lane=${net.stats().pending}`);
    expect(started(fixed)).toBe(DEFAULT_DIRECT_LIMITS.maxPendingDirect);
    expect(started(joiners)).toBe(reserve);
    expect(reserve).toBeGreaterThan(0);
  });
});

describe("scaled multi-source flood (Opus r3 LOW 4)", () => {
  test("many sources over many networks, relay strangers, a greedy member and joiners at once: every bound holds", async () => {
    const L = DEFAULT_DIRECT_LIMITS;
    const eve = Array.from({ length: 8 }, () => generateKeys().pubkey);
    const honest = Array.from({ length: 6 }, () => generateKeys().pubkey);
    const members = new Map([...eve.map((k) => [k, "direct:eve"] as const), ...honest.map((k, i) => [k, `direct:h${i}`] as const)]);
    const { net, priv } = server(members, { handshakeMs: 5, handshakeCeilingMs: 10 });
    const honestStarted: boolean[] = [];
    const joinersStarted: boolean[] = [];
    let maxNative = 0;
    for (let wave = 0; wave < 6; wave++) {
      const attack = [
        // 6 proxies per wave: 3 IPv4 /24s x 16 hosts x 4 ports, 3 IPv6 /48s x 16 /64s x 4 ports.
        ...Array.from({ length: 192 }, (_, i) => incoming(ip(`10.${wave}.${i % 3}.${(i >> 2) % 16 + 1}:${1000 + (i & 3)}`))),
        ...Array.from({ length: 192 }, (_, i) => incoming(ip(`[2001:db8:${wave}${i % 3}:${((i >> 2) % 16).toString(16)}::1]:${1000 + (i & 3)}`))),
        ...Array.from({ length: 24 }, () => incoming(relay(hex(generateKeys().pubkey)))),
        ...eve.flatMap((k) => Array.from({ length: 4 }, () => incoming(relay(hex(k))))),
      ];
      await offer(priv, attack);
      const s = net.stats();
      maxNative = Math.max(maxNative, s.native);
      expect(s.native).toBeLessThanOrEqual(L.maxNativeHandshakes);
      expect(s.pending).toBeLessThanOrEqual(L.maxPendingHandshakes);
      expect(s.pendingMembers).toBeLessThanOrEqual(L.maxPendingMembers);
      expect(s.relayStrangers).toBeLessThanOrEqual(L.maxPendingRelayStrangers);
      for (const n of s.pendingBySource.values()) expect(n).toBeLessThanOrEqual(L.maxPendingPerSource);
      for (const n of s.pendingByPrefix.values()) expect(n).toBeLessThanOrEqual(L.maxPendingPerPrefix);
      for (const n of s.pendingByMember.values()) expect(n).toBeLessThanOrEqual(L.maxPendingPerMember);
      const h = incoming(relay(hex(honest[wave] as string)));
      const j = incoming(relay(hex(generateKeys().pubkey)));
      await offer(priv, [h, j]);
      honestStarted.push(h.accepted());
      joinersStarted.push(j.accepted());
      await tick(25);
    }
    const s = net.stats();
    console.log(`[evidence] 6 waves x (384 direct from 6 networks + 24 relay strangers + 32 greedy-member): max native=${maxNative} ` +
      `(cap ${L.maxNativeHandshakes}) final native=${s.native} honest relay members started=${honestStarted.filter(Boolean).length}/6 ` +
      `relay joiners started=${joinersStarted.filter(Boolean).length}/6 eve=${s.pendingByMember.get("direct:eve")}`);
    expect(honestStarted.every(Boolean)).toBe(true);
    expect(s.pendingByMember.get("direct:eve")).toBe(L.maxPendingPerMember);
  });
});

describe("the daemon wires member identity into the member lane", () => {
  test("DirectLink gives DirectNet the owning member's login for each admitted key (two machines, one member)", async () => {
    const { DirectLink } = await import("../../src/daemon/direct/link.ts");
    const { makeCore } = await import("../helpers/core.ts");
    const { tnode } = await import("../helpers/events.ts");
    const cleanups: (() => void)[] = [];
    try {
      const alex = tnode("alex", "direct:alex");
      const core = makeCore(alex, "0000000000000000", cleanups);
      core.store.deleteMeta("team");
      core.createTeam("acme", "alex", { login: alex.login });
      const body = (who: ReturnType<typeof tnode>) => ({
        node_id: who.keys.nodeId, login: who.login, hostname: who.hostname, pubkey: who.keys.pubkey, ip: "",
        endpoint: hex(who.keys.pubkey), transports: ["direct"],
      });
      core.emit("team.node", body(alex));
      const a = tnode("sam", "direct:sam", "sam-a");
      const b = tnode("sam", "direct:sam", "sam-b");
      core.emit("team.member", { login: "direct:sam", handle: "sam", role: "member" });
      core.emit("team.node", body(a));
      core.emit("team.node", body(b));
      let got: DirectDeps | null = null;
      const net = { endpoint: "ab", relayUrl: () => null, stop: async () => undefined, rosterChanged: () => undefined } as unknown as DirectNet;
      const link = new DirectLink({
        core, log: createLogger({}), sync: { running: true, rosterChanged: () => undefined, start: () => undefined },
        client: { transports: {} }, api: {}, stopTailscale: () => undefined,
        startNet: async (deps: DirectDeps) => { got = deps; return net; },
      } as unknown as ConstructorParameters<typeof DirectLink>[0], { transport: "direct" });
      cleanups.push(() => void link.stop());
      await link.enableDirect();
      const deps = got as DirectDeps | null;
      expect(deps?.memberOf?.(a.keys.pubkey)).toBe("direct:sam");
      expect(deps?.memberOf?.(b.keys.pubkey)).toBe("direct:sam");
      expect(deps?.memberOf?.(generateKeys().pubkey)).toBeNull();
    } finally {
      while (cleanups.length) cleanups.pop()?.();
    }
  });
});
