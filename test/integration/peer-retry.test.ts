// v0.1.2: the peer API comes up when Tailscale does, with no restart. Found in production: launchd restarted the
// daemon before Tailscale answered, it logged peer_api_disabled and stayed unreachable until a manual restart.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeIdentity, Identity, SelfInfo, WhoisResult } from "../../src/daemon/identity.ts";
import { backoffDelay } from "../../src/daemon/peer-link.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const NO_IP = "tailscale has no IPv4 address (is it logged in and connected?)";
const FAST = { retryBaseMs: 30, retryMaxMs: 200, watchMs: 100 };

/** A Tailscale whose self() follows a script: unavailable, then up, then moved, as the test says. */
class ScriptedIdentity implements Identity {
  readonly kind = "fake" as const;
  calls = 0;
  constructor(private readonly fake: FakeIdentity, private readonly me: SelfInfo, public script: (call: number) => string | null) {}
  whois(ip: string, headers: Headers): Promise<WhoisResult | null> { return this.fake.whois(ip, headers); }
  async self(): Promise<SelfInfo | { error: string }> {
    const ip = this.script(++this.calls);
    return ip ? { ...this.me, ip } : { error: NO_IP };
  }
}

function scripted(login: string, nodeName: string, script: (call: number) => string | null): { ident: () => ScriptedIdentity; spec: (f: FakeIdentity) => Identity } {
  let made: ScriptedIdentity | null = null;
  return {
    ident: () => made as ScriptedIdentity,
    spec: (f) => (made = new ScriptedIdentity(f, { ip: "127.0.0.1", login, nodeName }, script)),
  };
}

async function walkie(node: TestNode, args: string[]) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket };
  return runAsPerson([process.execPath, CLI, ...args], env); // a person's terminal
}

async function roundTrip(a: TestNode, b: TestNode, text: string): Promise<void> {
  const { event } = await a.client().post({ channel: "general", text });
  await waitFor(async () => (await b.client().events({ channel: "general", kinds: "msg.post" })).events.some((e) => e.id === event.id),
    { what: `${a.spec.name} → ${b.spec.name}: ${text}`, timeoutMs: 15_000 });
}

function logOf(node: TestNode): string { return readFileSync(node.d.paths.log, "utf8"); }

async function listening(ip: string, port: number, nodeId: string): Promise<boolean> {
  const host = ip.includes(":") ? `[${ip}]` : ip;
  try {
    const r = await fetch(`http://${host}:${port}/peer/v1/hello`, { headers: { "X-Walkie-Node": nodeId }, signal: AbortSignal.timeout(1_000) });
    return r.status === 200;
  } catch {
    return false;
  }
}

let c: Cluster;
let alex: TestNode;

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", peerHost: null, peerLink: FAST });
  await alex.client().init("acme", "alex");
  for (const [login, handle] of [["kira@example.com", "kira"], ["bea@example.com", "bea"], ["dan@example.com", "dan"]] as const) {
    await alex.client().invite(login, handle, "member");
  }
});
afterAll(async () => { await c.close(); });

describe("backoff", () => {
  test("2 s growing to 60 s, jittered, never above the cap", () => {
    const lo = (n: number) => backoffDelay(n, 2_000, 60_000, () => 0);
    const hi = (n: number) => backoffDelay(n, 2_000, 60_000, () => 0.999999);
    expect(lo(0)).toBeGreaterThanOrEqual(1_600);
    expect(hi(0)).toBeLessThanOrEqual(2_400);
    expect(lo(1)).toBeGreaterThan(hi(0) - 1); // grows
    for (const n of [5, 6, 10, 50, 1_000]) {
      expect(hi(n)).toBeLessThanOrEqual(60_000);
      expect(lo(n)).toBeGreaterThanOrEqual(48_000);
    }
    expect(new Set(Array.from({ length: 20 }, () => backoffDelay(3, 2_000, 60_000))).size).toBeGreaterThan(1); // jittered
  });
});

describe("peer API retry", () => {
  test("restarted before Tailscale answers: the peer API comes up after N failed calls and a peer syncs, no restart", async () => {
    const kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp", peerHost: null, peerLink: FAST });
    expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);
    await roundTrip(alex, kira, "before the restart");
    await kira.stop();

    // launchd restart: Tailscale isn't answering for the first 3 calls.
    const s = scripted("kira@example.com", "kiras-mbp", (n) => (n <= 3 ? null : "127.0.0.1"));
    kira.spec.identity = s.spec;
    await kira.start();
    await waitFor(() => kira.d.peerPort !== null, { what: "peer API up", timeoutMs: 10_000 });
    expect(s.ident().calls).toBeGreaterThanOrEqual(4);
    const log = logOf(kira);
    expect(log).toContain("tailscale_unavailable");
    expect(log).toContain("peer_api_disabled");
    expect(log.lastIndexOf("peer_api_enabled")).toBeGreaterThan(log.lastIndexOf("peer_api_disabled"));
    const me = await kira.client().me();
    expect(me.tailscale.ok).toBe(true);
    expect(me.node.ip).toBe("127.0.0.1");

    await roundTrip(alex, kira, "after tailscale came up (push to kira)");
    await roundTrip(kira, alex, "after tailscale came up (from kira)");
    await waitFor(async () => (await alex.client().peers()).nodes.find((n) => n.node_id === kira.d.nodeId)?.online, { what: "kira online on alex" });
  });

  test("Tailscale IP changes: the peer API rebinds on the new IP and the authority re-pins the node", async () => {
    let ip: string | null = "127.0.0.1";
    const s = scripted("bea@example.com", "beas-mbp", () => ip);
    const bea = await c.add({ name: "bea", login: "bea@example.com", hostname: "beas-mbp", peerHost: null, peerLink: FAST, identity: s.spec });
    expect((await bea.client().join(alex.peerAddr)).admitted).toBe(true);
    await roundTrip(alex, bea, "hello bea");
    const port1 = bea.d.peerPort as number;
    const node = bea.d.nodeId;

    ip = "::1";
    await waitFor(async () => (await bea.client().me()).node.ip === "::1", { what: "bea moved to ::1" });
    const port2 = bea.d.peerPort as number;
    expect(await listening("::1", port2, node)).toBe(true);
    expect(await listening("127.0.0.1", port1, node)).toBe(false); // the old listener is gone
    // Re-joined through the authority, which pins the address it observes (loopback here) and the new port.
    await waitFor(() => alex.d.core.roster.nodes.get(node)?.port === port2, { what: "re-pinned on the authority" });
    expect(logOf(bea)).toContain("peer_ip_changed");

    ip = "127.0.0.1";
    await waitFor(async () => (await bea.client().me()).node.ip === "127.0.0.1", { what: "bea moved back" });
    const port3 = bea.d.peerPort as number;
    await waitFor(() => alex.d.core.roster.nodes.get(node)?.port === port3, { what: "re-pinned again" });
    await roundTrip(alex, bea, "after the move (to bea)");
    await roundTrip(bea, alex, "after the move (from bea)");
  });

  test("Tailscale disappears: the peer API is disabled, retries, and comes back", async () => {
    let up = true;
    const s = scripted("dan@example.com", "dans-mbp", () => (up ? "127.0.0.1" : null));
    const dan = await c.add({ name: "dan", login: "dan@example.com", hostname: "dans-mbp", peerHost: null, peerLink: FAST, identity: s.spec });
    expect((await dan.client().join(alex.peerAddr)).admitted).toBe(true);
    const port = dan.d.peerPort as number;
    up = false;
    await waitFor(() => dan.d.peerPort === null, { what: "peer API disabled" });
    expect(await listening("127.0.0.1", port, dan.d.nodeId)).toBe(false);
    expect((await dan.client().me()).tailscale.ok).toBe(false);
    up = true;
    await waitFor(() => dan.d.peerPort !== null, { what: "peer API back" });
    await roundTrip(alex, dan, "dan is back");
    await roundTrip(dan, alex, "dan says hi");
  });

  test("the authority's own IP changes: it re-pins itself", async () => {
    let ip: string | null = "127.0.0.1";
    const c2 = new Cluster();
    try {
      const s = scripted("owen@example.com", "owen-mbp", () => ip);
      const owen = await c2.add({ name: "owen", login: "owen@example.com", hostname: "owen-mbp", peerHost: null, peerLink: FAST, identity: s.spec });
      await owen.client().init("solo", "owen");
      ip = "::1";
      await waitFor(() => owen.d.core.roster.nodes.get(owen.d.nodeId)?.ip === "::1", { what: "authority re-pinned itself" });
      expect(owen.d.core.roster.nodes.get(owen.d.nodeId)?.port).toBe(owen.d.peerPort as number);
      expect(logOf(owen)).toContain("node_repinned");
    } finally {
      await c2.close();
    }
  });

  test("walkie doctor shows the retry while the peer API is down", async () => {
    const s = scripted("zed@example.com", "zed-mbp", () => null);
    const zed = await c.add({ name: "zed", login: "zed@example.com", peerHost: null, identity: s.spec, peerLink: { retryBaseMs: 20_000, retryMaxMs: 60_000, watchMs: 60_000 } });
    expect(zed.d.peerPort).toBeNull();
    const r = await walkie(zed, ["doctor", "--json"]);
    const checks = (JSON.parse(r.out) as { checks: { level: string; name: string; detail: string }[] }).checks;
    const peer = checks.find((x) => x.name === "peer api");
    expect(peer?.level).toBe("fail");
    expect(peer?.detail).toMatch(/^retrying \(next in \d+s\): tailscale has no IPv4 address/);
    const human = await walkie(zed, ["doctor"]);
    expect(human.out).toMatch(/peer api\s+retrying \(next in \d+s\): tailscale has no IPv4/);
  });
});
