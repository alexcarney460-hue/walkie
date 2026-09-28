// WALKIE-POOL-2 security: split runs are opt-in per machine, person-only, and a stage's rpc-server is reachable only
// through a tunnel from the run's head, over the authenticated peer transport, while the run lives. Uses a stand-in
// rpc-server (an echo server, test/fixtures/pool/fake-rpc.ts) so it runs without llama.cpp.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DirectNet, TunnelRefused } from "../../src/daemon/direct/net.ts";
import { generateKeys } from "../../src/daemon/keys.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { PeerCallError } from "../../src/daemon/peer-client.ts";
import { WalkieError } from "../../src/client/index.ts";
import type { End } from "../../src/pool/run/tunnel.ts";
import { MAX_TUNNELS } from "../../src/pool/run/stage.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { ACCEPT_STANDIN, fakeRuntime, helloMsg } from "../helpers/pool-runtime.ts";

let c: Cluster;
let alex: TestNode, kira: TestNode, mallory: TestNode, eve: TestNode;
let fakeDir: string;

const run = (ch: string): string => ch.repeat(32);

/** The HTTP answer a tunnel upgrade gets on `to`'s peer API, as `from` (its node header; the fake whois maps it). */
async function upgradeStatus(from: TestNode, to: TestNode, r: string, team = alex.d.core.teamId!): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${to.peerPort}/peer/v1/pool/tunnel/${r}`, {
    headers: { "X-Walkie-Node": from.d.nodeId, "X-Walkie-Team": team, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": ("dGhlIHNh" + "bXBsZSBub25jZQ=="), "Sec-WebSocket-Version": "13" },
  });
  await res.body?.cancel();
  return res.status;
}
const addrOn = (from: TestNode, to: TestNode) => from.d.client.addrOf(from.d.core.roster.nodes.get(to.d.nodeId)!)!;

/** The stand-in echoes; the worker's RPC guard lets a HELLO through with its transport capabilities zeroed. */
async function echoes(end: End): Promise<boolean> {
  await end.write(helloMsg(7));
  let got = new Uint8Array(0);
  const deadline = Date.now() + 3_000;
  while (got.byteLength < 33 && Date.now() < deadline) {
    const b = await Promise.race([end.read(), Bun.sleep(3_000).then(() => null)]);
    if (!b) break;
    got = new Uint8Array([...got, ...b]);
  }
  return got.byteLength === 33 && got[0] === 14 && got.subarray(9).every((x) => x === 0);
}

async function rejects(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) { return err instanceof PeerCallError || err instanceof WalkieError ? `${err.status}:${err.code}` : (err as Error).message; }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  c = new Cluster();
  fakeDir = fakeRuntime(c.root);
  const pool = { llamaDir: fakeDir, verifyRuntime: ACCEPT_STANDIN };
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", pool });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp", pool: { ...pool, leaseMs: 60_000 } });
  mallory = await c.add({ name: "mallory", login: "mallory@example.com", hostname: "mallory-mbp", pool });
  eve = await c.add({ name: "eve", login: "eve@example.com", hostname: "eve-mbp", pool });
  await alex.client().init("acme", "alex");
  for (const [n, h] of [[kira, "kira"], [mallory, "mallory"]] as const) {
    await alex.client().invite(`${h}@example.com`, h, "member");
    expect((await n.client().join(alex.peerAddr)).admitted).toBe(true);
  }
  await eve.client().init("other-team", "eve"); // eve runs her own team
  await kira.client().poolShare(true, 8);
  await waitFor(async () => (await alex.client().team()).nodes.find((n) => n.hostname === "kiras-mbp")?.pool?.share, { what: "kira sharing seen", timeoutMs: 15_000 });
}, 60_000);

afterAll(async () => { await c.close(); });

describe("person only (like invites)", () => {
  test("AGENT-ADMIN-1: an agent can't share a machine, start or stop a run while its person has agent admin off; it may read the state", async () => {
    await kira.client().adminSwitches({ agent_admin: false });
    await alex.client().adminSwitches({ agent_admin: false });
    try {
      expect(await rejects(kira.client("claude").poolShare(false))).toBe("403:agent_admin_off");
      expect(await rejects(alex.client("claude").poolRun({ file: "/tmp/x.gguf", machines: ["kiras-mbp"] }))).toBe("403:agent_admin_off");
      expect(await rejects(alex.client("codex").poolStop())).toBe("403:agent_admin_off");
      expect((await kira.client("claude").pool()).share.on).toBe(true);
    } finally {
      await kira.client().adminSwitches({ agent_admin: true });
      await alex.client().adminSwitches({ agent_admin: true });
    }
  });

  test("the CLI under an agent runtime is refused while agent admin is off", async () => {
    await kira.client().adminSwitches({ agent_admin: false });
    try {
      const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../src/cli/main.ts"), "pool", "share", "off"], {
        env: { ...process.env, WALKIE_HOME: kira.home, WALKIE_SOCKET: kira.socket, CLAUDECODE: "1" }, stdout: "pipe", stderr: "pipe",
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString() + r.stdout.toString()).toContain("agent_admin_off");
      expect((await kira.client().pool()).share.on).toBe(true);
    } finally {
      await kira.client().adminSwitches({ agent_admin: true });
    }
  });
});

describe("opt-in per machine", () => {
  test("a machine whose owner didn't turn sharing on refuses a stage; the head's plan refuses it first", async () => {
    expect(await rejects(alex.d.client.stage(addrOn(alex, mallory), { action: "start", run: run("1"), bytes: 1024, model: "x" }))).toBe("403:not_sharing");
    await waitFor(async () => (await alex.client().team()).nodes.find((n) => n.hostname === "mallory-mbp")?.pool, { what: "mallory's pool state" });
    const gguf = join(c.root, "tiny.gguf");
    writeFileSync(gguf, "GGUF");
    expect(await rejects(alex.client().poolRun({ file: gguf, machines: ["mallory-mbp"] }))).toBe("409:not_sharing");
  });

  test("an observer's machine can't start a stage on a teammate's shared machine", async () => {
    const ob = await c.add({ name: "obs", login: "obs@example.com", hostname: "obs-mbp", pool: { llamaDir: fakeDir, verifyRuntime: ACCEPT_STANDIN  } });
    await alex.client().invite("obs@example.com", "obs", "observer");
    expect((await ob.client().join(alex.peerAddr)).admitted).toBe(true);
    await waitFor(() => !!ob.d.core.roster.nodes.get(kira.d.nodeId) && !!kira.d.core.roster.nodes.get(ob.d.nodeId), { what: "rosters synced" });
    expect(await rejects(ob.d.client.stage(addrOn(ob, kira), { action: "start", run: run("3"), bytes: 1024, model: "x" }))).toBe("403:forbidden");
  });

  test("a stage bigger than the owner's cap is refused", async () => {
    expect(await rejects(alex.d.client.stage(addrOn(alex, kira), { action: "start", run: run("2"), bytes: 9 * 1024 ** 3, model: "x" }))).toBe("413:over_cap");
  });
});

describe("tunnels: only the run's head, only while it runs", () => {
  const R = run("a");
  test("the head's tunnel reaches the stage; a teammate's machine and another team's machine are refused", async () => {
    expect((await alex.d.client.stage(addrOn(alex, kira), { action: "start", run: R, bytes: 1024, model: "tiny" })).ok).toBe(true);
    const stage = (await kira.client().pool()).stage!;
    expect(stage.head_hostname).toBe("alex-mbp");
    // The stand-in listens on loopback only.
    const lsof = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(stage.pid)], { stdout: "pipe" }).stdout.toString();
    const socks = lsof.split("\n").slice(1).filter(Boolean).map((l) => l.trim().split(/\s+/)[8]);
    expect(socks.length).toBeGreaterThan(0);
    expect(socks.every((s) => s?.startsWith("127.0.0.1:"))).toBe(true);

    const end = await alex.d.client.tunnel(addrOn(alex, kira), R);
    expect(await echoes(end)).toBe(true);
    end.close();
    // mallory is a member of the same team, but not the head of this run.
    expect(await rejects(mallory.d.client.tunnel(addrOn(mallory, kira), R))).toBe("0:tunnel_refused");
    expect(await upgradeStatus(mallory, kira, R)).toBe(403); // the stage: "only the machine that started this run"
    // eve is not in the team: kira's peer gate refuses her before any upgrade.
    expect(await upgradeStatus(eve, kira, R)).toBe(403);
    expect(await upgradeStatus(alex, kira, run("9"))).toBe(404); // no such run
    expect(await rejects(eve.d.client.tunnel({ ip: "127.0.0.1", port: kira.peerPort }, R))).toBe("0:tunnel_refused");
    // A plain HTTP request to the tunnel path from the head (no upgrade) is refused too.
    const plain = await fetch(`http://127.0.0.1:${kira.peerPort}/peer/v1/pool/tunnel/${R}`, { headers: { "X-Walkie-Node": alex.d.nodeId, "X-Walkie-Team": alex.d.core.teamId! } });
    expect(plain.status).toBe(426);
  });

  test(`at most ${MAX_TUNNELS} tunnels at once`, async () => {
    const ends: End[] = [];
    for (let i = 0; i < MAX_TUNNELS; i++) ends.push(await alex.d.client.tunnel(addrOn(alex, kira), R));
    await waitFor(async () => (await kira.client().pool()).stage?.tunnels === MAX_TUNNELS, { what: "tunnels counted" });
    expect(await rejects(alex.d.client.tunnel(addrOn(alex, kira), R))).toBe("0:tunnel_refused");
    expect(await upgradeStatus(alex, kira, R)).toBe(429);
    for (const e of ends) e.close();
    await waitFor(async () => (await kira.client().pool()).stage?.tunnels === 0, { what: "tunnels closed" });
  });

  test("renew and stop are the head's only; after Stop the rpc-server is gone and tunnels are refused", async () => {
    expect(await rejects(mallory.d.client.stage(addrOn(mallory, kira), { action: "stop", run: R }))).toBe("404:no_run");
    expect((await alex.d.client.stage(addrOn(alex, kira), { action: "renew", run: R })).ok).toBe(true);
    const pid = (await kira.client().pool()).stage!.pid;
    expect((await alex.d.client.stage(addrOn(alex, kira), { action: "stop", run: R })).ok).toBe(true);
    expect((await kira.client().pool()).stage).toBeNull();
    expect(Bun.spawnSync(["ps", "-p", String(pid), "-o", "pid="], { stdout: "pipe" }).stdout.toString().trim()).toBe("");
    expect(await rejects(alex.d.client.tunnel(addrOn(alex, kira), R))).toBe("0:tunnel_refused");
  });

  test("the head's machine revoked mid-run: the stage stops", async () => {
    const R2 = run("b");
    await mallory.d.client.stage(addrOn(mallory, kira), { action: "start", run: R2, bytes: 1024, model: "tiny" }).catch(() => undefined);
    // mallory doesn't share, but she may still HEAD a run on kira's shared machine.
    const st = await waitFor(async () => (await kira.client().pool()).stage, { what: "mallory's stage on kira" });
    expect(st.head_hostname).toBe("mallory-mbp");
    await alex.client().revokeNode(mallory.d.nodeId);
    await waitFor(async () => (await kira.client().pool()).stage === null, { timeoutMs: 15_000, what: "stage stopped after the head was revoked" });
  });

  test("sharing turned off: the stage stops and the machine refuses new ones", async () => {
    const R3 = run("c");
    await alex.d.client.stage(addrOn(alex, kira), { action: "start", run: R3, bytes: 1024, model: "tiny" });
    await kira.client().poolShare(false);
    expect((await kira.client().pool()).stage).toBeNull();
    expect(await rejects(alex.d.client.stage(addrOn(alex, kira), { action: "start", run: run("d"), bytes: 1024, model: "tiny" }))).toBe("403:not_sharing");
    await kira.client().poolShare(true, 8);
  });
});

describe("lease", () => {
  test("a stage whose head stops renewing is stopped", async () => {
    const lessee = await c.add({ name: "lessee", login: "kira@example.com", hostname: "kiras-mini", pool: { llamaDir: fakeDir, verifyRuntime: ACCEPT_STANDIN, leaseMs: 1_500 } });
    expect((await lessee.client().join(alex.peerAddr)).admitted).toBe(true);
    await lessee.client().poolShare(true, 8);
    await waitFor(() => !!alex.d.core.roster.nodes.get(lessee.d.nodeId), { what: "lessee in alex's roster" });
    await alex.d.client.stage(addrOn(alex, lessee), { action: "start", run: run("e"), bytes: 1024, model: "tiny" });
    const pid = (await lessee.client().pool()).stage!.pid;
    await waitFor(async () => (await lessee.client().pool()).stage === null, { timeoutMs: 6_000, what: "lease expiry" });
    expect(Bun.spawnSync(["ps", "-p", String(pid), "-o", "pid="], { stdout: "pipe" }).stdout.toString().trim()).toBe("");
  });
});

describe("Walkie Direct tunnels", () => {
  test("a key that isn't an admitted machine is refused before the stage is asked", async () => {
    const d1 = await c.add({ name: "d1", login: "d1@example.com", hostname: "d1", direct: true, pool: { llamaDir: fakeDir, verifyRuntime: ACCEPT_STANDIN  } });
    const d2 = await c.add({ name: "d2", login: "d2@example.com", hostname: "d2", direct: true, pool: { llamaDir: fakeDir, verifyRuntime: ACCEPT_STANDIN  } });
    await d1.client().init("direct-team", "d1");
    const inv = await d1.client().inviteCode("d2", "member");
    expect((await d2.client().join(inv.code)).admitted).toBe(true);
    await d2.client().poolShare(true, 8);
    const R = run("f");
    await d1.d.client.stage(addrOn(d1, d2), { action: "start", run: R, bytes: 1024, model: "tiny" });
    const end = await d1.d.client.tunnel(addrOn(d1, d2), R);
    expect(await echoes(end)).toBe(true);
    end.close();
    const keys = generateKeys();
    const net = await DirectNet.start({ keys, log: createLogger({ file: `${c.root}/outsider.log` }), admitted: () => false, handler: async () => new Response("no", { status: 404 }) },
      { preset: "minimal", bindAddr: "127.0.0.1:0", addressBook: c.addressBook });
    try {
      const err = await net.openTunnel({ ip: "", port: 7458, pubkey: d2.d.core.keys.pubkey }, `/peer/v1/pool/tunnel/${R}`, { "X-Walkie-Team": d1.d.core.teamId! }, AbortSignal.timeout(10_000)).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(TunnelRefused);
      expect((err as TunnelRefused).status).toBe(403);
    } finally {
      await net.stop();
    }
    await d1.d.client.stage(addrOn(d1, d2), { action: "stop", run: R });
  }, 60_000);
});
