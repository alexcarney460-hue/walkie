// WALKIE-POOL-3 units: the RPC guard (CVE-2026-78147 class: custom ops' function pointers; node id 0; no RDMA
// upgrade), the WebSocket credit window in both directions, child records that never kill a reused PID, the
// supervisor, the install-directory guard, and a CPU-only head holding nothing.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_OPS, checkGraph, guardSelfTest, RPC_TENSOR_SIZE, RpcGuard, RpcRefused } from "../../src/pool/run/rpc-guard.ts";
import { ChildRegistry, processFacts, spawnChild } from "../../src/pool/run/child.ts";
import { installRuntime, TARGETS } from "../../src/pool/run/runtime.ts";
import { planRun } from "../../src/pool/run/plan.ts";
import { suggestCombined } from "../../src/pool/combined.ts";
import { WINDOW, WsEnd, type WsLike } from "../../src/pool/run/tunnel.ts";
import { helloMsg, msgHead } from "../helpers/pool-runtime.ts";
import type { GroupInput } from "../../src/pool/group.ts";
import type { MachineStats } from "../../src/protocol/machine-stats.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** A GRAPH_COMPUTE message: device 0, the node ids, one rpc_tensor per op (id i+1). */
function graph(nodes: bigint[], ops: number[]): Uint8Array {
  const size = 4 + 4 + nodes.length * 8 + 4 + ops.length * RPC_TENSOR_SIZE;
  const b = new Uint8Array(9 + size);
  const dv = new DataView(b.buffer);
  b.set(msgHead(10, size), 0);
  dv.setUint32(9 + 4, nodes.length, true);
  nodes.forEach((n, i) => dv.setBigUint64(9 + 8 + i * 8, n, true));
  const tAt = 9 + 8 + nodes.length * 8;
  dv.setUint32(tAt, ops.length, true);
  ops.forEach((op, i) => { dv.setBigUint64(tAt + 4 + i * RPC_TENSOR_SIZE, BigInt(i + 1), true); dv.setUint32(tAt + 4 + i * RPC_TENSOR_SIZE + 52, op, true); });
  return b;
}

/** Feeds `bytes` in chunks of `step` and joins what the guard lets through. */
function through(g: RpcGuard, bytes: Uint8Array, step: number): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.byteLength; i += step) for (const x of g.feed(bytes.subarray(i, i + step))) out.push(...x);
  return Uint8Array.from(out);
}

/** A tensor-bearing fixed message with every rpc_tensor's op set to `op`. */
function withTensor(cmd: number, size: number, op: number, at = 0): Uint8Array {
  const b = new Uint8Array(9 + size);
  b.set(msgHead(cmd, size), 0);
  new DataView(b.buffer).setUint32(9 + at + 52, op, true);
  return b;
}

describe("RPC guard (worker side, head -> rpc-server): allow-lists", () => {
  test("HELLO first, capabilities zeroed; allowed commands and a normal graph pass unchanged, at any chunking", () => {
    for (const step of [1, 7, 64, 100_000]) {
      const g = new RpcGuard({ maxMessage: GiB });
      const setTensor = Uint8Array.from([...withTensor(6, RPC_TENSOR_SIZE + 9 + 5, 0)]);
      const ok = graph([1n, 2n], [0, 29, 25, 48, 74, 100]);
      const out = through(g, Uint8Array.from([...helloMsg(9), ...msgHead(15, 0), ...setTensor, ...ok, ...msgHead(11, 4), 0, 0, 0, 0]), step);
      expect(out.subarray(0, 9)).toEqual(helloMsg(0).subarray(0, 9));
      expect(out.subarray(9, 33).every((x) => x === 0)).toBe(true); // no RDMA upgrade off the tunnel
      expect(out.byteLength).toBe(33 + 9 + setTensor.byteLength + ok.byteLength + 13);
    }
  });

  test("commands: only the allow-list, each at its exact struct size", () => {
    const g = () => { const x = new RpcGuard({ maxMessage: 1000 }); x.feed(helloMsg()); return x; };
    expect(() => new RpcGuard({ maxMessage: GiB }).feed(msgHead(6, 1))).toThrow(RpcRefused); // not HELLO first
    expect(() => g().feed(msgHead(18, 0))).toThrow(RpcRefused); // RPC_CMD_NONE
    expect(() => g().feed(msgHead(19, 0))).toThrow(RpcRefused);
    expect(() => g().feed(msgHead(14, 24))).toThrow(RpcRefused); // a second HELLO
    expect(() => g().feed(msgHead(1, 5))).toThrow(/5-byte payload/); // GET_ALIGNMENT is 4 bytes
    expect(() => g().feed(msgHead(6, 1001))).toThrow(/budget/);
    expect(() => g().feed(msgHead(6, 10))).toThrow(/malformed SET_TENSOR/);
    for (const [cmd, size] of [[15, 0], [0, 12], [1, 4], [2, 4], [3, 8], [4, 8], [5, 9], [11, 4], [16, 4]] as const) {
      expect(() => g().feed(msgHead(cmd, size))).not.toThrow();
    }
  });

  test("ops: an allow-list (observed in real runs); custom ops, training ops and unlisted ones (90, 96-99) are refused", () => {
    for (const op of [1, 34, 70, 90, 92, 93, 94, 95, 96, 97, 98, 99, 101, 4000]) {
      const g = new RpcGuard({ maxMessage: GiB });
      g.feed(helloMsg());
      expect(() => g.feed(graph([1n], [0, op]))).toThrow(RpcRefused);
    }
    for (const op of ALLOWED_OPS.keys()) {
      const g = new RpcGuard({ maxMessage: GiB });
      g.feed(helloMsg());
      expect(() => g.feed(graph([1n], [op]))).not.toThrow();
    }
    const g = new RpcGuard({ maxMessage: GiB });
    g.feed(helloMsg());
    expect(() => g.feed(graph([0n], [0]))).toThrow(/node id 0/);
    expect(() => checkGraph(new Uint8Array(10))).toThrow(/malformed/);
  });

  test("every tensor-bearing command is checked, not only graphs (INIT_TENSOR, GET_TENSOR, COPY_TENSOR's second tensor, GET_ALLOC_SIZE's srcs, SET_TENSOR's head)", () => {
    const refuse = (m: Uint8Array) => { const g = new RpcGuard({ maxMessage: GiB }); g.feed(helloMsg()); return () => g.feed(m); };
    expect(refuse(withTensor(12, 296, 95))).toThrow(/op 95/);
    expect(refuse(withTensor(8, 312, 95))).toThrow(/op 95/);
    expect(refuse(withTensor(9, 592, 95, RPC_TENSOR_SIZE))).toThrow(/op 95/);
    expect(refuse(withTensor(13, 3260, 95, 4 + 5 * RPC_TENSOR_SIZE))).toThrow(/op 95/);
    expect(refuse(withTensor(17, 313, 95))).toThrow(/op 95/);
    expect(refuse(withTensor(6, RPC_TENSOR_SIZE + 9 + 100, 95))).toThrow(/op 95/);
    const typed = withTensor(12, 296, 0);
    new DataView(typed.buffer).setUint32(9 + 8, 43, true); // GGML_TYPE_COUNT
    expect(refuse(typed)).toThrow(/type/);
  });

  test("POOL-5 shape checks: a VIEW past its source, a leaf with forged strides refused; legitimate views and quantized leaves pass", () => {
    const f32 = (ne: number[], nb: number[], extra: Record<number, [number, bigint | number]> = {}, op = 0, id = 1): Uint8Array => {
      const t = new Uint8Array(RPC_TENSOR_SIZE);
      const dv = new DataView(t.buffer);
      dv.setBigUint64(0, BigInt(id), true);
      dv.setUint32(52, op, true);
      ne.forEach((n, k) => dv.setUint32(20 + k * 4, n, true));
      nb.forEach((n, k) => dv.setUint32(36 + k * 4, n, true));
      for (const [at, [size, v]] of Object.entries(extra)) {
        if (size === 4) dv.setUint32(Number(at), Number(v), true); else dv.setBigUint64(Number(at), BigInt(v), true);
      }
      return t;
    };
    const graphOf = (...ts: Uint8Array[]): Uint8Array => {
      const size = 4 + 4 + 8 + 4 + ts.length * RPC_TENSOR_SIZE;
      const b = new Uint8Array(9 + size);
      b.set(msgHead(10, size), 0);
      const dv = new DataView(b.buffer);
      dv.setUint32(13, 1, true);
      dv.setBigUint64(17, 1n, true);
      dv.setUint32(25, ts.length, true);
      ts.forEach((t, i) => b.set(t, 29 + i * RPC_TENSOR_SIZE));
      return b;
    };
    const feed = (m: Uint8Array) => { const g = new RpcGuard({ maxMessage: GiB }); g.feed(helloMsg()); return () => g.feed(m); };
    const src = f32([16, 4, 1, 1], [4, 64, 256, 256]);
    const viewOf = (offs: number, ne: number[], nb: number[]) => f32(ne, nb, { 204: [8, 1], 212: [8, offs] }, 37, 2);
    expect(feed(graphOf(src, viewOf(64, [16, 3, 1, 1], [4, 64, 192, 192])))).not.toThrow(); // rows 1-3
    expect(feed(graphOf(src, viewOf(64, [16, 4, 1, 1], [4, 64, 256, 256])))).toThrow(/past its source/); // one row too many
    expect(feed(graphOf(src, viewOf(0, [16, 1, 1, 1], [4, 1 << 20, 1 << 20, 1 << 20])))).not.toThrow(); // ne 1: strides unused
    expect(feed(graphOf(src, viewOf(0, [2, 2, 1, 1], [4, 1 << 20, 4, 4])))).toThrow(/past its source/); // stride past the end
    expect(feed(graphOf(f32([16, 4, 1, 1], [4, 64, 1 << 30, 1 << 30]), f32([1, 1, 1, 1], [4, 4, 4, 4], {}, 29, 2)))).toThrow(/strides/);
    expect(feed(graphOf(f32([16, 4, 1, 1], [4, 128, 512, 512])))).toThrow(/strides/);
    // Q4_K (type 12: 144 bytes per 256): a 512 x 2 leaf, contiguous, passes; a row that isn't whole blocks doesn't.
    const q4k = (ne0: number) => { const t = f32([ne0, 2, 1, 1], [144, 144 * ne0 / 256, 144 * ne0 / 128, 144 * ne0 / 128]); new DataView(t.buffer).setUint32(8, 12, true); return t; };
    expect(feed(graphOf(q4k(512)))).not.toThrow();
    expect(feed(graphOf(q4k(300)))).toThrow(/whole blocks/);
    // A view whose source isn't in the message isn't judged (nothing to compare with).
    expect(feed(graphOf(viewOf(1 << 20, [16, 1, 1, 1], [4, 64, 64, 64])))).not.toThrow();
  });

  test("the self-test a stage runs before serving passes on this build of the guard", () => {
    expect(guardSelfTest()).toBeNull();
  });
});

/** Two WsEnds wired to each other in memory; `a` can be made to ignore credits (a misbehaving sender). */
function wired(): { a: WsEnd; b: WsEnd; raw: (x: Uint8Array) => void } {
  let a!: WsEnd, b!: WsEnd;
  const link = (to: () => WsEnd): WsLike => ({
    sendBytes: (x) => queueMicrotask(() => to().message(x.slice())),
    sendText: (t) => queueMicrotask(() => to().message(t)),
    close: () => queueMicrotask(() => to().closed()),
  });
  a = new WsEnd(link(() => b));
  b = new WsEnd(link(() => a));
  return { a, b, raw: (x) => b.message(x) };
}

describe("WebSocket credit window", () => {
  test("a polite sender stops at the window until the receiver consumes; nothing is lost", async () => {
    const { a, b } = wired();
    let sent = 0;
    const w = (async () => { for (let i = 0; i < 24; i++) { await a.write(new Uint8Array(MiB)); sent++; } })();
    await Bun.sleep(50);
    expect(sent * MiB).toBeLessThanOrEqual(WINDOW);
    expect(b.inbox.bytes).toBeLessThanOrEqual(WINDOW);
    let got = 0;
    while (got < 24 * MiB) got += (await b.read())!.byteLength;
    await w;
    expect(b.fault).toBeNull();
    expect(b.inbox.peak).toBeLessThanOrEqual(WINDOW);
  });

  test("either direction: a peer that sends past the window is cut off and its queue dropped", async () => {
    const faults: string[] = [];
    const recv = new WsEnd({ sendBytes: () => undefined, sendText: () => undefined, close: () => undefined }, (f) => faults.push(f));
    for (let i = 0; i < 9; i++) recv.message(new Uint8Array(MiB)); // nobody reads, the sender ignores credits
    expect(recv.fault).toBe("receive_budget_exceeded");
    expect(faults).toEqual(["receive_budget_exceeded"]);
    expect(recv.inbox.bytes).toBe(0);
    expect(await recv.read()).toBeNull();
  });

  test("a credit for more than was sent is a protocol error", () => {
    const e = new WsEnd({ sendBytes: () => undefined, sendText: () => undefined, close: () => undefined });
    e.message("a5");
    expect(e.fault).toBe("bad_credit");
  });
});

describe("child processes", () => {
  test("records: a daemon start reaps a recorded child that still runs as recorded, never a reused PID", async () => {
    const dir = mkdtempSync("/tmp/walkie-reg-");
    try {
      const file = join(dir, "children.json");
      const victim = Bun.spawn(["sleep", "60"]);
      const bystander = Bun.spawn(["sleep", "61"]);
      await Bun.sleep(100);
      const facts = processFacts(bystander.pid)!;
      // The victim as recorded; the bystander under a record whose start time doesn't match (a reused PID).
      writeFileSync(file, JSON.stringify([
        { pid: victim.pid, ...processFacts(victim.pid)!, role: "rpc-server" },
        { pid: bystander.pid, started: "Mon Jan  1 00:00:00 2024", name: facts.name, role: "rpc-server" },
      ]));
      const killed = new ChildRegistry(file).reap();
      expect(killed.map((k) => k.pid)).toEqual([victim.pid]);
      await victim.exited;
      expect(bystander.killed || bystander.exitCode !== null).toBe(false);
      bystander.kill();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the supervisor reports the real PID and stop() ends the child; the child's environment is only what we pass", async () => {
    const dir = mkdtempSync("/tmp/walkie-sup-");
    try {
      const reg = new ChildRegistry(join(dir, "children.json"));
      const ch = await spawnChild(["/bin/sh", "-c", "env; exec sleep 60"], { PATH: "/usr/bin:/bin", HOME: dir }, { registry: reg, role: "test" });
      expect(ch.pid).not.toBe(ch.supervisor);
      await Bun.sleep(200);
      expect(ch.tail()).toContain(`HOME=${dir}`);
      expect(ch.tail()).not.toContain("WALKIE_");
      await ch.stop(2_000);
      let alive = true;
      try { process.kill(ch.pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("child identity (POOL-4)", () => {
  test("after confirm() the record names the program (not the shell), so a restart's reaping matches it", async () => {
    const dir = mkdtempSync("/tmp/walkie-conf-");
    try {
      const file = join(dir, "children.json");
      const ch = await spawnChild(["/bin/sleep", "60"], { PATH: "/usr/bin:/bin" }, { registry: new ChildRegistry(file), role: "rpc-server" });
      await Bun.sleep(150);
      ch.confirm();
      const rec = (JSON.parse(await Bun.file(file).text()) as { pid: number; name: string }[]).find((r) => r.pid === ch.pid)!;
      expect(rec.name).toBe("sleep");
      // A daemon that restarts on this home (its supervisor gone or not) reaps exactly this process.
      const killed = new ChildRegistry(file).reap();
      expect(killed.map((k) => k.pid)).toEqual([ch.pid]);
      await ch.exited;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("install directory", () => {
  test("a non-empty directory walkie didn't install is refused (nothing is deleted)", async () => {
    const dir = mkdtempSync("/tmp/walkie-inst-");
    try {
      mkdirSync(join(dir, "mine"));
      writeFileSync(join(dir, "mine", "precious.txt"), "keep");
      await expect(installRuntime(TARGETS["linux-x64"]!, join(dir, "mine"))).rejects.toThrow(/not empty/);
      expect(Bun.file(join(dir, "mine", "precious.txt")).size).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a CPU-only head holds no layers (v1)", () => {
  const node = (id: string, over: Partial<GroupInput>, accel: MachineStats["accel"]): GroupInput => ({
    node_id: id, hostname: id, handle: id, online: true, self: false, rtt_ms: 10,
    stats: { at: 1, temp_c: 40, mem: { total: 32 * GiB, used: 4 * GiB, swap_used: 0, pressure: "normal" }, accel } as MachineStats, ...over,
  });
  const SHARE = { share: true, cap: null, runtime: true, busy: false };
  const cpu = { chip: "Intel", unified: false, gpu_limit: null, gpus: [] };
  const mac = { chip: "Apple M4", unified: true, gpu_limit: null, gpus: [] };
  test("planned: the head gets 0 bytes, named or not; the estimate doesn't count it either", () => {
    const nodes = [node("me", { self: true, pool: SHARE }, cpu), node("kira", { pool: SHARE }, mac)];
    expect(planRun(nodes, 4 * GiB).stages.find((s) => s.self)!.bytes).toBe(0);
    expect(planRun(nodes, 4 * GiB, ["kira"]).stages.find((s) => s.self)!.bytes).toBe(0);
    expect(suggestCombined(nodes).runnable?.placement.every((p) => p.hostname !== "me")).toBe(true);
  });
});
