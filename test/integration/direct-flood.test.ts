// DIRECT-FIX-2 (Opus r2 HIGH 1 / Codex r2 HIGH 1): a stranger floods the Walkie Direct server with handshakes
// it never finishes: real iroh endpoints dial through a UDP proxy that forwards their packets to the server and drops
// every server reply, ~40 attempts in 5 s. An admitted member dialing from another address must still get in while
// the attack runs. Before the fix the stalled handshakes held all 32 pending slots and the member was refused.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type * as Iroh from "@number0/iroh";
import { ALPN, DirectNet, type DirectLimits } from "../../src/daemon/direct/net.ts";
import { iroh } from "../../src/daemon/direct/iroh.ts";
import { sourceOf } from "../../src/daemon/direct/sources.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { createLogger } from "../../src/daemon/logger.ts";

const dir = mkdtempSync("/tmp/walkie-flood-");
const log = createLogger({ file: join(dir, "net.log") });
const closers: (() => Promise<unknown> | unknown)[] = [];
afterAll(async () => {
  // iroh's graceful close takes ~3 s per endpoint with handshakes still stalled: close them all at once, bounded.
  const t0 = performance.now();
  await Promise.all(closers.reverse().map((c) => Promise.race([Promise.resolve(c()).catch(() => undefined), Bun.sleep(10_000)])));
  console.log(`[metric] flood teardown: ${Math.round(performance.now() - t0)} ms`);
  rmSync(dir, { recursive: true, force: true });
}, 20_000);

/**
 * Upstream proxy port -> the host it stands in for: loopback has one IPv4 address, so a proxy given `host` makes
 * the server (via its test `sourceOf`) see its traffic as coming from that host on another network.
 */
const standIns = new Map<number, string>();
const standInSource = (a: Iroh.IncomingAddr) => {
  const port = a.kind === "ip" && a.addr?.startsWith("127.0.0.1:") ? Number(a.addr.split(":")[1]) : 0;
  const host = standIns.get(port);
  return sourceOf(host ? { kind: "ip", addr: `${host}:${port}` } : a);
};

/** A UDP proxy on 127.0.0.1 that forwards each client's datagrams to `target` and drops every reply. */
async function blackholeProxy(target: number, host?: string): Promise<{ port: number; forwarded: () => number; dropped: () => number }> {
  let forwarded = 0;
  let dropped = 0;
  const upstream = new Map<string, Promise<{ send: (b: Uint8Array) => void }>>();
  const up = (key: string) => {
    let u = upstream.get(key);
    if (!u) {
      u = Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data: () => { dropped++; } } }).then((s) => {
        closers.push(() => s.close());
        if (host) standIns.set(s.port, host);
        return { send: (b: Uint8Array) => { try { s.send(b, target, "127.0.0.1"); } catch { /* torn down */ } } };
      });
      upstream.set(key, u);
    }
    return u;
  };
  const front = await Bun.udpSocket({
    hostname: "127.0.0.1", port: 0,
    socket: { data: (_s, buf, port, addr) => { forwarded++; void up(`${addr}:${port}`).then((u) => u.send(buf)); } },
  });
  closers.push(() => front.close());
  return { port: front.port, forwarded: () => forwarded, dropped: () => dropped };
}

async function rawEndpoint(): Promise<Iroh.Endpoint> {
  const { Endpoint, RelayMode } = iroh();
  const b = Endpoint.builder();
  b.applyMinimal();
  b.relayMode(RelayMode.disabled());
  b.alpns([[...Buffer.from(ALPN)]]);
  b.bindAddr("127.0.0.1:0");
  const ep = await b.bind();
  closers.push(() => ep.close());
  return ep;
}

/** A server on any address (v4 + v6), a member admitted by it, and the server's v4/v6 loopback addresses. */
async function world(limits: Partial<DirectLimits> = {}) {
  const serverKeys = generateKeys();
  const memberKeys = generateKeys();
  const book = new Map<string, string[]>();
  const srv = await DirectNet.start({
    keys: serverKeys, log, admitted: (pk) => pk === memberKeys.pubkey, handler: async () => new Response("ok"),
  }, { preset: "minimal", addressBook: book, limits, sourceOf: standInSource });
  closers.push(() => srv.stop());
  const addrs = book.get(srv.endpoint) ?? [];
  const v4 = addrs.find((a) => a.startsWith("127.0.0.1:")) as string;
  const v6 = addrs.find((a) => a.startsWith("[::1]:")) as string;
  // The member reaches the server over IPv6 loopback: another source address than the attacker's 127.0.0.1.
  const memberBook = new Map<string, string[]>([[srv.endpoint, [v6]]]);
  const member = await DirectNet.start({ keys: memberKeys, log, admitted: () => false, handler: async () => new Response("x") },
    { preset: "minimal", bindAddr: "[::1]:0", addressBook: memberBook, connectTimeoutMs: 8_000 });
  closers.push(() => member.stop());
  return { srv, serverKeys, member, v4Port: Number(v4.split(":").pop()) };
}

/** ~40 handshakes over `ms` from 8 attacker endpoints through the black-hole proxy; never awaited to completion. */
async function flood(serverKeys: ReturnType<typeof generateKeys>, proxyPort: number, ms = 5_000, attempts = 40): Promise<void> {
  await floodVia(serverKeys, [proxyPort], await Promise.all(Array.from({ length: 8 }, () => rawEndpoint())), ms, attempts);
}

/** `attempts` handshakes over `ms`, spread over the proxies and the attacker endpoints; never awaited to completion. */
async function floodVia(serverKeys: ReturnType<typeof generateKeys>, proxyPorts: number[], eps: Iroh.Endpoint[], ms: number, attempts: number): Promise<void> {
  const { EndpointAddr, EndpointId } = iroh();
  const id = [...Buffer.from(serverKeys.pubkey, "base64")];
  for (let i = 0; i < attempts; i++) {
    const to = new EndpointAddr(EndpointId.fromBytes(id), null, [`127.0.0.1:${proxyPorts[i % proxyPorts.length]}`]);
    void (eps[i % eps.length] as Iroh.Endpoint).connect(to, [...Buffer.from(ALPN)]).catch(() => undefined);
    await Bun.sleep(ms / attempts);
  }
}

async function memberTries(member: DirectNet, serverKeys: ReturnType<typeof generateKeys>, n: number): Promise<{ ok: number; errors: string[] }> {
  let ok = 0;
  const errors: string[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const res = await member.request({ ip: "", port: 0, pubkey: serverKeys.pubkey },
        { method: "GET", path: "/peer/v1/vv", headers: {}, signal: AbortSignal.timeout(8_000) });
      if (res.status === 200 && (await res.text()) === "ok") ok++;
    } catch (err) {
      errors.push((err as Error).message.slice(0, 80));
    }
    // A fresh connection per attempt (the cached one would hide a refused handshake).
    (member as unknown as { conns: Map<string, unknown> }).conns.clear();
  }
  return { ok, errors };
}

describe("Direct handshake flood (real iroh, loopback)", () => {
  test("a stranger stalling ~40 handshakes in 5 s can't lock an admitted member out", async () => {
    const w = await world();
    const proxy = await blackholeProxy(w.v4Port);
    await flood(w.serverKeys, proxy.port);
    const during = w.srv.stats();
    const tries = await memberTries(w.member, w.serverKeys, 9);
    console.log(`[evidence] flood: forwarded=${proxy.forwarded()} replies_dropped=${proxy.dropped()} pending=${during.pending} ` +
      `bySource=${JSON.stringify(Object.fromEntries(during.pendingBySource ?? []))} member ok=${tries.ok}/9 errors=${JSON.stringify(tries.errors.slice(0, 2))}`);
    expect(proxy.dropped()).toBeGreaterThan(0); // the server did answer the attacker; the proxy ate it
    expect(tries.ok).toBe(9);
  }, 90_000);

  test("under load, unvalidated sources get a QUIC Retry: a sender that can't see replies never starts a handshake", async () => {
    const w = await world({ retryAbove: 0 });
    const proxy = await blackholeProxy(w.v4Port);
    await flood(w.serverKeys, proxy.port, 2_000, 20);
    const during = w.srv.stats();
    const tries = await memberTries(w.member, w.serverKeys, 3);
    console.log(`[evidence] retry: forwarded=${proxy.forwarded()} pending=${during.pending} member ok=${tries.ok}/3`);
    expect(during.pending).toBe(0);
    expect(tries.ok).toBe(3);
  }, 60_000);
});

// DIRECT-FIX-3 (Opus r3 LOW 4, Codex r3 HIGH 1, Opus r3 MEDIUM 1 + 2): the same real-iroh flood from several
// proxies standing in for hosts on other networks, with the budget scaled down so a few endpoints saturate it.
describe("Direct multi-source flood (real iroh, loopback proxies as other networks)", () => {
  const scaled: Partial<DirectLimits> = {
    maxPendingHandshakes: 16, maxPendingDirect: 12, maxNativeDirect: 12, maxNativeHandshakes: 24,
    maxPendingPerSource: 4, maxPendingPerPrefix: 4, handshakeMs: 1_000, handshakeCeilingMs: 1_500,
  };

  test("six hosts inside one /24 are one budget: the member still gets in while they flood", async () => {
    const w = await world(scaled);
    const proxies = await Promise.all(Array.from({ length: 6 }, (_, i) => blackholeProxy(w.v4Port, `203.0.113.${i + 1}`)));
    const eps = await Promise.all(Array.from({ length: 6 }, () => rawEndpoint()));
    await floodVia(w.serverKeys, proxies.map((p) => p.port), eps, 3_000, 48);
    const during = w.srv.stats();
    const tries = await memberTries(w.member, w.serverKeys, 5);
    console.log(`[evidence] 6 hosts in one /24, 48 stalled attempts: native=${during.native} byPrefix=${JSON.stringify(Object.fromEntries(during.pendingByPrefix))} ` +
      `bySource=${JSON.stringify(Object.fromEntries(during.pendingBySource))} member ok=${tries.ok}/5 errors=${JSON.stringify(tries.errors.slice(0, 2))}`);
    expect(proxies.reduce((n, p) => n + p.forwarded(), 0)).toBeGreaterThan(0);
    expect(during.pendingByPrefix.get("net4:203.0.113.0/24") ?? 0).toBeLessThanOrEqual(4);
    expect(tries.ok).toBe(5);
  }, 90_000);

  test("waves from six networks past the ceiling: native handshakes never exceed the cap, and all come back when the flood ends", async () => {
    const w = await world(scaled);
    const proxies = await Promise.all(Array.from({ length: 6 }, (_, i) => blackholeProxy(w.v4Port, `198.51.${100 + i}.7`)));
    const eps = await Promise.all(Array.from({ length: 6 }, () => rawEndpoint()));
    let maxNative = 0;
    let maxPending = 0;
    const sampler = setInterval(() => {
      const s = w.srv.stats();
      maxNative = Math.max(maxNative, s.native);
      maxPending = Math.max(maxPending, s.pending);
    }, 20);
    try {
      for (let wave = 0; wave < 3; wave++) {
        await floodVia(w.serverKeys, proxies.map((p) => p.port), eps, 600, 36);
        await Bun.sleep(1_800); // past the ceiling: lane slots come back, native budgets don't
      }
    } finally {
      clearInterval(sampler);
    }
    const saturated = w.srv.stats();
    // The attacker goes away: its native handshakes end (QUIC idle timeout), every budget comes back.
    await Promise.all(eps.map((ep) => Promise.race([ep.close().catch(() => undefined), Bun.sleep(5_000)])));
    const t0 = performance.now();
    while (w.srv.stats().native > 0 && performance.now() - t0 < 60_000) await Bun.sleep(250);
    const after = w.srv.stats();
    const tries = await memberTries(w.member, w.serverKeys, 3);
    console.log(`[evidence] 3 waves x 36 from 6 networks: max native=${maxNative} (cap 12) max lane=${maxPending} at end native=${saturated.native} ` +
      `byPrefix=${JSON.stringify(Object.fromEntries(saturated.pendingByPrefix))}; after the flood native=${after.native} in ${Math.round(performance.now() - t0)} ms, ` +
      `sources=${after.pendingBySource.size} prefixes=${after.pendingByPrefix.size}; member ok=${tries.ok}/3`);
    expect(maxNative).toBeLessThanOrEqual(12);
    expect(maxPending).toBeLessThanOrEqual(12);
    expect(after.native).toBe(0);
    expect(after.pendingBySource.size).toBe(0);
    expect(after.pendingByPrefix.size).toBe(0);
    expect(tries.ok).toBe(3);
  }, 120_000);
});
