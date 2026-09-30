// WALKIE-POOL-3: the round-1 audit findings, as regressions.
//   HIGH   a head that ignores "pause" can't grow the worker daemon's memory (hard receive budget closes it);
//          a well-behaved head feeding a stalled rpc-server stays open and bounded
//   MED    the worker's own memory budget (a head's claimed bytes are checked against what is free HERE)
//   MED    Stop / sharing off during startup cancel it
//   MED    concurrent tunnel opens can't overshoot MAX_TUNNELS (Tailscale WebSocket and Walkie Direct CONNECT)
//   LOW    a head demoted to observer mid-run loses its stage
// (Orphans on daemon death: pool-orphans.test.ts.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PeerCallError } from "../../src/daemon/peer-client.ts";
import { newPeerNonce, signPeerRequest } from "../../src/daemon/peer-sig.ts";
import { WINDOW } from "../../src/pool/run/tunnel.ts";
import { MAX_TUNNELS } from "../../src/pool/run/stage.ts";
import { RPC_TENSOR_SIZE } from "../../src/pool/run/rpc-guard.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { ACCEPT_STANDIN, fakeRuntime, helloMsg, msgHead } from "../helpers/pool-runtime.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
let c: Cluster;
const run = (ch: string): string => ch.repeat(32);
const addrOn = (from: TestNode, to: TestNode) => from.d.client.addrOf(from.d.core.roster.nodes.get(to.d.nodeId)!)!;
const stagesOf = (n: TestNode) => (n.d.core.pool as unknown as { stages: { cur: { tunnels: Set<{ inbox?: { bytes: number; peak: number }; fault?: string | null }> } | null } }).stages;

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (err) { return err instanceof PeerCallError ? `${err.status}:${err.code}` : (err as Error).message; }
}

/** A team of two: alex (head) and a worker with the given stand-in rpc-server and free memory. */
async function pair(name: string, rpc: "fake-rpc" | "stuck-rpc" | "slow-rpc", opts: { free?: number; direct?: boolean } = {}): Promise<{ alex: TestNode; kira: TestNode }> {
  const dir = fakeRuntime(c.root, rpc);
  const freeMemory = async () => opts.free ?? 8 * GiB;
  const alex = await c.add({ name: `${name}-a`, login: `alex-${name}@example.com`, hostname: `alex-${name}`, direct: !!opts.direct, pool: { llamaDir: dir, verifyRuntime: ACCEPT_STANDIN, freeMemory } });
  const kira = await c.add({ name: `${name}-k`, login: `kira-${name}@example.com`, hostname: `kira-${name}`, direct: !!opts.direct, pool: { llamaDir: dir, verifyRuntime: ACCEPT_STANDIN, leaseMs: 120_000, freeMemory } });
  await alex.client().init(`team-${name}`, "alex");
  if (opts.direct) {
    const inv = await alex.client().inviteCode("kira", "member");
    expect((await kira.client().join(inv.code)).admitted).toBe(true);
  } else {
    await alex.client().invite(`kira-${name}@example.com`, "kira", "member");
    expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);
  }
  await kira.client().poolShare(true, null);
  return { alex, kira };
}

beforeAll(() => { c = new Cluster(); });
afterAll(async () => { if (!process.env.KEEP) await c.close(); else console.log("ROOT", c.root); });

describe("HIGH: receive budget", () => {
  test("a head that ignores 'pause' is cut off at the hard budget; the worker's queue never passes it", async () => {
    const { alex, kira } = await pair("flood", "stuck-rpc");
    const R = run("a");
    expect((await alex.d.client.stage(addrOn(alex, kira), { action: "start", run: R, bytes: 1024, model: "x" })).ok).toBe(true);
    // A raw WebSocket that never honours "pause": a valid HELLO, then one big tensor upload streamed flat out.
    const path = `/peer/v1/pool/tunnel/${R}`;
    const signed = signPeerRequest(alex.d.core.keys, { method: "GET", path, query: "", body: "", requester: alex.d.nodeId,
      target: kira.d.nodeId, team: alex.d.core.teamId!, ts: Date.now(), nonce: newPeerNonce() });
    const ws = new WebSocket(`ws://127.0.0.1:${kira.peerPort}${path}`, { headers: { "X-Walkie-Node": alex.d.nodeId,
      "X-Walkie-Team": alex.d.core.teamId!, ...signed } } as unknown as string[]);
    let acks = 0;
    let closed = false;
    ws.onmessage = (e) => { if (typeof e.data === "string" && e.data.startsWith("a")) acks++; };
    ws.onclose = () => { closed = true; };
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); setTimeout(() => rej(new Error("no open")), 5_000); });
    ws.send(helloMsg() as Uint8Array<ArrayBuffer>);
    ws.send(msgHead(6, 512 * MiB) as Uint8Array<ArrayBuffer>);
    ws.send(new Uint8Array(RPC_TENSOR_SIZE + 9)); // SET_TENSOR's own head: a plain F32 tensor (op NONE), then data // SET_TENSOR, within the stage's budget
    const chunk = new Uint8Array(MiB).fill(7);
    const stages = stagesOf(kira);
    const tun = await waitFor(() => [...stages.cur?.tunnels ?? []][0], { what: "the worker's tunnel end" });
    for (let i = 0; i < 160 && !closed; i++) {
      ws.send(chunk);
      while (ws.bufferedAmount > 4 * MiB && !closed) await Bun.sleep(1);
    }
    await waitFor(() => closed, { timeoutMs: 10_000, what: "the flooding tunnel closed by the worker" });
    const maxQueued = tun.inbox?.peak ?? -1;
    console.log(`[evidence] flood: sent past the ${WINDOW / MiB} MiB credit window (${acks} credit frame(s) received); worker queue peaked at ${(maxQueued / MiB).toFixed(1)} MiB; tunnel closed by the worker: ${closed} (${tun.fault})`);
    expect(tun.fault).toBe("receive_budget_exceeded");
    expect(maxQueued).toBeLessThanOrEqual(WINDOW + MiB); // the window + the one frame that overran it
    await waitFor(async () => (await kira.client().pool()).stage?.tunnels === 0, { what: "tunnel gone" });
    await alex.d.client.stage(addrOn(alex, kira), { action: "stop", run: R });
  }, 60_000);

  test("a well-behaved head feeding a stalled rpc-server pauses and stays connected, bounded", async () => {
    const { alex, kira } = await pair("polite", "stuck-rpc");
    const R = run("b");
    await alex.d.client.stage(addrOn(alex, kira), { action: "start", run: R, bytes: 1024, model: "x" });
    const end = await alex.d.client.tunnel(addrOn(alex, kira), R);
    await end.write(helloMsg());
    await end.write(msgHead(6, 256 * MiB));
    await end.write(new Uint8Array(RPC_TENSOR_SIZE + 9));
    const chunk = new Uint8Array(MiB);
    let sent = 0;
    const writer = (async () => { for (let i = 0; i < 64; i++) { await end.write(chunk); sent++; } })().catch(() => undefined);
    await Bun.sleep(2_500);
    let queued = 0;
    for (const t of stagesOf(kira).cur?.tunnels ?? []) queued = Math.max(queued, t.inbox?.bytes ?? 0);
    const st = (await kira.client().pool()).stage!;
    console.log(`[evidence] polite head, stalled consumer: ${sent} MiB written before the credit stop, worker queue ${(queued / MiB).toFixed(1)} MiB, tunnel open: ${st.tunnels === 1}`);
    expect(st.tunnels).toBe(1);
    expect(sent).toBeLessThan(64);
    expect(queued).toBeLessThanOrEqual(WINDOW);
    expect(queued).toBeGreaterThan(0);
    end.close();
    await writer;
    await alex.d.client.stage(addrOn(alex, kira), { action: "stop", run: R });
  }, 30_000);
});

describe("MEDIUM: the worker's own memory budget", () => {
  test("uncapped sharing: a stage bigger than what is free here (less 1 GiB) is refused, whatever the head claims", async () => {
    const { alex, kira } = await pair("budget", "fake-rpc", { free: 6 * GiB });
    expect(await code(alex.d.client.stage(addrOn(alex, kira), { action: "start", run: run("c"), bytes: 2 ** 52, model: "x" }))).toBe("507:insufficient_memory");
    expect(await code(alex.d.client.stage(addrOn(alex, kira), { action: "start", run: run("c"), bytes: 5.5 * GiB, model: "x" }))).toBe("507:insufficient_memory");
    expect(await code(alex.d.client.stage(addrOn(alex, kira), { action: "start", run: run("c"), bytes: 4 * GiB, model: "x" }))).toBe("ok");
    const cur = (kira.d.core.pool as unknown as { stages: { cur: { budget: number; bucket: { burst: number } } } }).stages.cur;
    expect(cur.budget).toBe(5 * GiB); // measured here, not the head's number
    expect(cur.bucket.burst).toBe(6 * GiB);
    await alex.d.client.stage(addrOn(alex, kira), { action: "stop", run: run("c") });
  });
});

describe("MEDIUM: cancelling a stage while it starts", () => {
  test("the head's Stop during startup kills the starting rpc-server; the start answers cancelled", async () => {
    const { alex, kira } = await pair("stopstart", "slow-rpc");
    const R = run("d");
    const starting = code(alex.d.client.stage(addrOn(alex, kira), { action: "start", run: R, bytes: 1024, model: "x" }));
    await waitFor(async () => (await kira.client().team()).nodes.find((n) => n.self)?.pool?.busy, { what: "stage starting" });
    await Bun.sleep(300);
    expect(await code(alex.d.client.stage(addrOn(alex, kira), { action: "stop", run: R }))).toBe("ok");
    expect(await starting).toBe("409:cancelled");
    expect((await kira.client().pool()).stage).toBeNull();
    expect((await kira.client().team()).nodes.find((n) => n.self)?.pool?.busy).toBe(false);
  }, 20_000);

  test("sharing turned off during startup: cancelled at once, never goes live", async () => {
    const { alex, kira } = await pair("offstart", "slow-rpc");
    const R = run("e");
    const starting = code(alex.d.client.stage(addrOn(alex, kira), { action: "start", run: R, bytes: 1024, model: "x" }));
    await Bun.sleep(500);
    await kira.client().poolShare(false);
    expect(await starting).toBe("409:cancelled");
    await Bun.sleep(3_500); // past the stand-in's slow start
    expect((await kira.client().pool()).stage).toBeNull();
  }, 20_000);
});

describe("MEDIUM: concurrent tunnel opens can't overshoot the cap", () => {
  for (const direct of [false, true]) {
    test(`${direct ? "Walkie Direct CONNECT" : "Tailscale WebSocket"}: 12 opens at once -> at most ${MAX_TUNNELS}`, async () => {
      const { alex, kira } = await pair(direct ? "grants-d" : "grants-t", "fake-rpc", { direct });
      const R = run("f");
      await alex.d.client.stage(addrOn(alex, kira), { action: "start", run: R, bytes: 1024, model: "x" });
      const settled = await Promise.allSettled(Array.from({ length: 12 }, () => alex.d.client.tunnel(addrOn(alex, kira), R)));
      const open = settled.filter((s) => s.status === "fulfilled").length;
      await Bun.sleep(500);
      const counted = (await kira.client().pool()).stage?.tunnels;
      console.log(`[evidence] ${direct ? "direct" : "tailscale"}: 12 concurrent opens -> ${open} opened, worker counts ${counted}`);
      expect(open).toBeLessThanOrEqual(MAX_TUNNELS);
      expect(counted).toBeLessThanOrEqual(MAX_TUNNELS);
      for (const s of settled) if (s.status === "fulfilled") s.value.close();
      await waitFor(async () => (await kira.client().pool()).stage?.tunnels === 0, { what: "tunnels closed" });
      // Slots come back: a new tunnel opens again.
      const again = await alex.d.client.tunnel(addrOn(alex, kira), R);
      again.close();
      await alex.d.client.stage(addrOn(alex, kira), { action: "stop", run: R });
    }, 60_000);
  }
});

describe("POOL-4: only the pinned build", () => {
  test("a worker whose rpc-server isn't llama.cpp b11205 as pinned refuses the stage (wrong_runtime), whatever directory it came from", async () => {
    const dir = fakeRuntime(c.root, "fake-rpc");
    const freeMemory = async () => 8 * GiB;
    const owner = await c.add({ name: "pin-o", login: "own-pin@example.com", hostname: "own-pin", pool: { llamaDir: dir, freeMemory } });
    const head = await c.add({ name: "pin-h", login: "head-pin@example.com", hostname: "head-pin", pool: { llamaDir: dir, freeMemory } });
    await owner.client().init("team-pin", "own");
    await owner.client().invite("head-pin@example.com", "hp", "member");
    expect((await head.client().join(owner.peerAddr)).admitted).toBe(true);
    await owner.client().poolShare(true, null);
    const err = await head.d.client.stage(addrOn(head, owner), { action: "start", run: run("7"), bytes: 1024, model: "x" }).then(() => null, (e: unknown) => e as PeerCallError);
    expect(`${err?.status}:${err?.code}`).toBe("409:wrong_runtime");
    expect(err?.message).toContain("not llama.cpp b11205");
    expect((await owner.client().pool()).stage).toBeNull();
  });
});

describe("LOW: a head demoted to observer mid-run", () => {
  test("loses its stage at once, and can't start another", async () => {
    const dir = fakeRuntime(c.root, "fake-rpc");
    const freeMemory = async () => 8 * GiB;
    const owner = await c.add({ name: "demo-o", login: "own-demo@example.com", hostname: "own-demo", pool: { llamaDir: dir, verifyRuntime: ACCEPT_STANDIN, freeMemory } });
    const head = await c.add({ name: "demo-h", login: "head-demo@example.com", hostname: "head-demo", pool: { llamaDir: dir, verifyRuntime: ACCEPT_STANDIN, freeMemory } });
    await owner.client().init("team-demo", "own");
    await owner.client().invite("head-demo@example.com", "hd", "member");
    expect((await head.client().join(owner.peerAddr)).admitted).toBe(true);
    await owner.client().poolShare(true, null);
    const R = run("9");
    expect((await head.d.client.stage(addrOn(head, owner), { action: "start", run: R, bytes: 1024, model: "x" })).ok).toBe(true);
    await owner.client().setRole("hd", "observer");
    await waitFor(async () => (await owner.client().pool()).stage === null, { timeoutMs: 10_000, what: "stage stopped on demotion" });
    await waitFor(() => head.d.core.roster.members.get("head-demo@example.com")?.role === "observer", { what: "demotion synced" });
    expect(await code(head.d.client.stage(addrOn(head, owner), { action: "start", run: run("8"), bytes: 1024, model: "x" }))).toBe("403:forbidden");
  }, 30_000);
});
