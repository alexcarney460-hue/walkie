// A worker-side filter on the bytes a head sends into rpc-server (POOL-3, allow-lists since POOL-4). llama.cpp's
// RPC server has no authentication and has had remote code execution bugs; one is still OPEN in the pinned build
// b11205: CVE-2026-78147 / GHSA-f4vj-w5xq-5xph (issue ggml-org/llama.cpp#25289, closed "not planned"): tensors'
// `op` / `op_params` are deserialized unchecked (ggml-rpc.cpp:1417-1420 at b11205) and the custom ops call a
// FUNCTION POINTER read from op_params. Issue #25299 (not planned either) crashes the server with graph node id 0.
//
// So the guard parses the stream (b11205's wire format: `u8 cmd | u64 size | payload`, ggml/src/ggml-rpc/
// ggml-rpc.cpp) and lets through ONLY what llama-server itself sends for the models Walkie runs:
//   - the first message must be HELLO (cmd 14, 24 bytes); its transport capabilities are zeroed, so no connection
//     is upgraded to RDMA off the tunnel;
//   - commands: an ALLOW-LIST (ALLOWED_CMDS), each with its exact size where the server's struct is fixed;
//   - every rpc_tensor in every message that carries one (SET_TENSOR, SET_TENSOR_HASH, GET_TENSOR, COPY_TENSOR,
//     INIT_TENSOR, GET_ALLOC_SIZE, MEMSET_TENSOR, GRAPH_COMPUTE) must have an op in ALLOWED_OPS and a type below
//     GGML_TYPE_COUNT; GRAPH_COMPUTE is buffered whole (at most GRAPH_MAX) and must not name node id 0.
// Anything else closes the tunnel. The allow-lists were derived from real split runs through this guard in record
// mode (docs/audits/2026-09-26-opus-pool2-r2.md lists the observed sets). Layout and numbering are pinned to LLAMA_BUILD
// (ggml.h and ggml-rpc.cpp at the b11205 tag); stage.ts refuses any rpc-server binary that isn't that build.

/** Command numbers (ggml-rpc.cpp:61-82, b11205). */
export const CMD = {
  ALLOC_BUFFER: 0, GET_ALIGNMENT: 1, GET_MAX_SIZE: 2, BUFFER_GET_BASE: 3, FREE_BUFFER: 4, BUFFER_CLEAR: 5,
  SET_TENSOR: 6, SET_TENSOR_HASH: 7, GET_TENSOR: 8, COPY_TENSOR: 9, GRAPH_COMPUTE: 10, GET_DEVICE_MEMORY: 11,
  INIT_TENSOR: 12, GET_ALLOC_SIZE: 13, HELLO: 14, DEVICE_COUNT: 15, GRAPH_RECOMPUTE: 16, MEMSET_TENSOR: 17,
} as const;
const HELLO_SIZE = 24;
/** sizeof(rpc_tensor) (packed, ggml-rpc.cpp:40-56) and field offsets, checked by compiling the struct. */
export const RPC_TENSOR_SIZE = 296;
const TYPE_OFFSET = 8;
const OP_OFFSET = 52;
/** GGML_TYPE_COUNT (ggml.h:433, b11205). */
const TYPE_COUNT = 43;

/**
 * Commands llama-server sends, with the payload size the server requires for fixed structs (ggml-rpc.cpp:89-205,
 * sizes from the compiled packed structs), or "var" for variable payloads, and where rpc_tensors sit in it.
 * Not allowed: HELLO after the first message, RPC_CMD_NONE (18) and anything >= 19.
 */
type Spec = { size: number | "var"; tensors: number[] };
export const ALLOWED_CMDS: ReadonlyMap<number, Spec> = new Map<number, Spec>([
  [CMD.DEVICE_COUNT, { size: 0, tensors: [] }],
  [CMD.ALLOC_BUFFER, { size: 12, tensors: [] }], // rpc_msg_alloc_buffer_req {u32 device, u64 size}
  [CMD.GET_ALIGNMENT, { size: 4, tensors: [] }],
  [CMD.GET_MAX_SIZE, { size: 4, tensors: [] }],
  [CMD.BUFFER_GET_BASE, { size: 8, tensors: [] }],
  [CMD.FREE_BUFFER, { size: 8, tensors: [] }],
  [CMD.BUFFER_CLEAR, { size: 9, tensors: [] }],
  [CMD.SET_TENSOR, { size: "var", tensors: [0] }], // | rpc_tensor | u8 cache_flag | u64 offset | data | (:1429)
  [CMD.SET_TENSOR_HASH, { size: 312, tensors: [0] }],
  [CMD.GET_TENSOR, { size: 312, tensors: [0] }],
  [CMD.COPY_TENSOR, { size: 592, tensors: [0, RPC_TENSOR_SIZE] }],
  [CMD.GRAPH_COMPUTE, { size: "var", tensors: [] }], // checked whole by checkGraph
  [CMD.GET_DEVICE_MEMORY, { size: 4, tensors: [] }],
  [CMD.INIT_TENSOR, { size: 296, tensors: [0] }],
  [CMD.GET_ALLOC_SIZE, { size: 3260, tensors: Array.from({ length: 11 }, (_, i) => 4 + i * RPC_TENSOR_SIZE) }],
  [CMD.GRAPH_RECOMPUTE, { size: 4, tensors: [] }], // re-runs the stored (already checked) graph
  [CMD.MEMSET_TENSOR, { size: 313, tensors: [0] }],
]);

/**
 * ggml ops a worker may be sent (enum ggml_op, ggml.h:492-604 at b11205; each name's line is given). This is exactly
 * the set observed through this guard in record mode in real split runs with llama-server b11205 (all layers on the
 * worker, flash attention on and off) of: stories15M (llama), Llama 3.3 (tiny random), Qwen3 0.6B, Phi-4 (tiny
 * random), gpt-oss (tiny random, MoE + sinks) and DeepSeek V3.1 (tiny random, MoE + MLA); "all" = every one of them.
 * Everything else is refused, custom ops (MAP_CUSTOM1/2/3, CUSTOM = 92-95: function pointers) and training ops
 * (96-99) included. A model needing an op not listed fails closed (the worker logs "op N refused").
 */
export const ALLOWED_OPS: ReadonlyMap<number, string> = new Map<number, string>([
  [0, "NONE"], // ggml.h:493; seen: all
  [2, "ADD"], // ggml.h:496; seen: all
  [3, "ADD_ID"], // ggml.h:497; seen: gpt-oss
  [7, "MUL"], // ggml.h:501; seen: all
  [8, "DIV"], // ggml.h:502; seen: deepseek
  [15, "SUM_ROWS"], // ggml.h:509; seen: deepseek
  [22, "CONCAT"], // ggml.h:516; seen: deepseek
  [25, "RMS_NORM"], // ggml.h:519; seen: all
  [29, "MUL_MAT"], // ggml.h:524; seen: all
  [30, "MUL_MAT_ID"], // ggml.h:525; seen: gpt-oss, deepseek
  [32, "SCALE"], // ggml.h:528; seen: phi-4, deepseek
  [35, "CONT"], // ggml.h:531; seen: flash attention off; deepseek
  [36, "RESHAPE"], // ggml.h:532; seen: all
  [37, "VIEW"], // ggml.h:533; seen: all
  [38, "PERMUTE"], // ggml.h:534; seen: all
  [39, "TRANSPOSE"], // ggml.h:535; seen: deepseek (flash attention off)
  [40, "GET_ROWS"], // ggml.h:536; seen: all
  [42, "SET_ROWS"], // ggml.h:538; seen: all
  [46, "SOFT_MAX"], // ggml.h:542; seen: gpt-oss; flash attention off
  [48, "ROPE"], // ggml.h:544; seen: all
  [50, "CLAMP"], // ggml.h:546; seen: deepseek
  [69, "ARGSORT"], // ggml.h:565; seen: gpt-oss, deepseek
  [73, "FILL"], // ggml.h:569; seen: deepseek
  [74, "FLASH_ATTN_EXT"], // ggml.h:571; seen: all (flash attention on)
  [91, "UNARY"], // ggml.h:589; seen: deepseek
  [100, "GLU"], // ggml.h:602; seen: all
]);

/** A graph message is buffered whole to be checked. See GRAPH_MAX_NOTE. */
export const GRAPH_MAX = 16 * 1024 * 1024;
/**
 * Why 16 MiB: the largest graph llama-server sent in the measured runs was far smaller (docs/audits/
 * 2026-09-26-opus-pool2-r2.md), and a graph is n_nodes x 8 + n_tensors x 296 bytes: 16 MiB holds ~56 000 tensors,
 * more than a 94-layer MoE's per-stage graph. Worst-case memory per stage: MAX_TUNNELS x (tunnel WINDOW + GRAPH_MAX).
 */
export const GRAPH_MAX_NOTE = "per stage at most 4 x (8 MiB window + 16 MiB graph) = 96 MiB of daemon memory";

export class RpcRefused extends Error {}

export interface GuardEvent { cmd: number; size: number; ops: number[] }
export interface GuardOptions {
  /** The largest message (e.g. one tensor upload) this stage accepts, in bytes. */
  maxMessage: number;
  /** Tests and measurements only: other allow-lists (record mode passes everything below the counts). */
  cmds?: ReadonlyMap<number, Spec>;
  ops?: ReadonlySet<number> | ReadonlyMap<number, string>;
  /** Called for every message let through (measurement: which commands and ops llama-server really sends). */
  observe?: (e: GuardEvent) => void;
}

type State =
  | { at: "hello"; head: Uint8Array; got: number }
  | { at: "head"; head: Uint8Array; got: number }
  | { at: "buffer"; cmd: number; buf: Uint8Array; got: number; whole: boolean }
  | { at: "pass"; left: bigint };

/** How much of a SET_TENSOR is held to check its tensor: | rpc_tensor | u8 cache_flag | u64 offset |. */
const SET_TENSOR_HEAD = RPC_TENSOR_SIZE + 1 + 8;

export class RpcGuard {
  private st: State = { at: "hello", head: new Uint8Array(9 + HELLO_SIZE), got: 0 };
  private readonly cmds: ReadonlyMap<number, Spec>;
  private readonly ops: { has(op: number): boolean };
  constructor(private readonly o: GuardOptions) {
    this.cmds = o.cmds ?? ALLOWED_CMDS;
    this.ops = o.ops ?? ALLOWED_OPS;
  }

  /** The bytes to forward for `chunk` (possibly none yet, possibly rewritten); throws RpcRefused to close. */
  feed(chunk: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    let i = 0;
    while (i < chunk.byteLength) {
      const st = this.st;
      if (st.at === "hello" || st.at === "head") {
        const n = Math.min(st.head.byteLength - st.got, chunk.byteLength - i);
        st.head.set(chunk.subarray(i, i + n), st.got);
        st.got += n;
        i += n;
        if (st.at === "hello" && st.got >= 9 && (st.head[0] !== CMD.HELLO || view(st.head).getBigUint64(1, true) !== BigInt(HELLO_SIZE))) {
          throw new RpcRefused("the first message must be HELLO");
        }
        if (st.got === st.head.byteLength) out.push(...this.headDone(st.at, st.head));
      } else if (st.at === "pass") {
        const n = Number(st.left < BigInt(chunk.byteLength - i) ? st.left : BigInt(chunk.byteLength - i));
        out.push(chunk.subarray(i, i + n));
        i += n;
        st.left -= BigInt(n);
        if (st.left === 0n) this.next();
      } else {
        const n = Math.min(st.buf.byteLength - st.got, chunk.byteLength - i);
        st.buf.set(chunk.subarray(i, i + n), st.got);
        st.got += n;
        i += n;
        if (st.got === st.buf.byteLength) out.push(...this.bufferDone(st));
      }
    }
    return out;
  }

  private next(): void { this.st = { at: "head", head: new Uint8Array(9), got: 0 }; }

  private headDone(at: "hello" | "head", head: Uint8Array): Uint8Array[] {
    const cmd = head[0]!;
    const size = view(head).getBigUint64(1, true);
    if (at === "hello") {
      const out = head.slice();
      out.fill(0, 9); // no transport upgrade (RDMA) off the tunnel
      this.o.observe?.({ cmd, size: HELLO_SIZE, ops: [] });
      this.next();
      return [out];
    }
    const spec = this.cmds.get(cmd);
    if (!spec) throw new RpcRefused(`command ${cmd} refused`);
    if (spec.size !== "var" && size !== BigInt(spec.size)) throw new RpcRefused(`command ${cmd} with a ${size}-byte payload refused`);
    if (size > BigInt(this.o.maxMessage)) throw new RpcRefused(`a ${size}-byte message is over this stage's budget`);
    if (cmd === CMD.GRAPH_COMPUTE && size > BigInt(GRAPH_MAX)) throw new RpcRefused("graph too large");
    if (cmd === CMD.SET_TENSOR && size < BigInt(SET_TENSOR_HEAD)) throw new RpcRefused("malformed SET_TENSOR");
    const n = Number(size);
    // Held: fixed structs with tensors, a whole graph, and the head of a SET_TENSOR (its data then streams through).
    const hold = cmd === CMD.GRAPH_COMPUTE ? n : cmd === CMD.SET_TENSOR ? SET_TENSOR_HEAD : spec.tensors.length ? n : 0;
    if (hold > 0) {
      const buf = new Uint8Array(9 + hold);
      buf.set(head, 0);
      this.st = { at: "buffer", cmd, buf, got: 9, whole: hold === n };
      return [];
    }
    this.o.observe?.({ cmd, size: n, ops: [] });
    if (n === 0 && cmd === CMD.GRAPH_COMPUTE) throw new RpcRefused("malformed graph");
    this.st = n === 0 ? { at: "head", head: new Uint8Array(9), got: 0 } : { at: "pass", left: size };
    return [head.slice()];
  }

  private bufferDone(st: Extract<State, { at: "buffer" }>): Uint8Array[] {
    const payload = st.buf.subarray(9);
    let ops: number[];
    if (st.cmd === CMD.GRAPH_COMPUTE) ops = checkGraph(payload, this.ops);
    else {
      // SET_TENSOR's head holds only its tensor; the fixed structs hold every tensor they carry.
      const shapes = (this.cmds.get(st.cmd)?.tensors ?? []).map((at) => checkTensor(payload, at, this.ops));
      checkViews(shapes);
      ops = shapes.map((t) => t.op);
    }
    // POOL-REAL-1: a head never makes the worker write its tensor cache (rpc-server -c); only Walkie's own prepare
    // (weights.ts, from a checked file) writes it. SET_TENSOR's cache flag sits right after its rpc_tensor.
    if (st.cmd === CMD.SET_TENSOR) st.buf[9 + RPC_TENSOR_SIZE] = 0;
    const size = Number(view(st.buf).getBigUint64(1, true));
    this.o.observe?.({ cmd: st.cmd, size, ops });
    if (st.whole) this.next();
    else this.st = { at: "pass", left: BigInt(size - (st.buf.byteLength - 9)) };
    return [st.buf];
  }
}

function view(b: Uint8Array): DataView { return new DataView(b.buffer, b.byteOffset, b.byteLength); }

/**
 * [type size, block size] per ggml_type (0..42), read from b11205's libggml-base (ggml_type_size / ggml_blck_size);
 * [0, 0] = a removed type, which rpc-server refuses too (ggml-rpc.cpp:1386).
 */
const TYPE_TRAITS: ReadonlyArray<readonly [number, number]> = [[4, 1], [2, 1], [18, 32], [20, 32], [0, 0], [0, 0], [22, 32], [24, 32], [34, 32], [36, 32], [84, 256], [110, 256], [144, 256], [176, 256], [210, 256], [292, 256], [66, 256], [74, 256], [98, 256], [50, 256], [18, 32], [110, 256], [82, 256], [136, 256], [1, 1], [2, 1], [4, 1], [8, 1], [8, 1], [56, 256], [2, 1], [0, 0], [0, 0], [0, 0], [54, 256], [66, 256], [0, 0], [0, 0], [0, 0], [17, 32], [36, 64], [18, 128], [18, 64]];

/** rpc_tensor field offsets (packed, ggml-rpc.cpp:40-56): ne[4] u32 @20, nb[4] u32 @36, view_src u64 @204, view_offs u64 @212. */
const NE_OFFSET = 20;
const NB_OFFSET = 36;
const VIEW_SRC_OFFSET = 204;
const VIEW_OFFS_OFFSET = 212;

interface Shape { id: bigint; type: number; op: number; ne: bigint[]; nb: bigint[]; viewSrc: bigint; viewOffs: bigint }

function shapeAt(dv: DataView, at: number): Shape {
  const u32 = (o: number): bigint => BigInt(dv.getUint32(at + o, true));
  return {
    id: dv.getBigUint64(at, true), type: dv.getUint32(at + TYPE_OFFSET, true), op: dv.getUint32(at + OP_OFFSET, true),
    ne: [0, 1, 2, 3].map((i) => u32(NE_OFFSET + i * 4)), nb: [0, 1, 2, 3].map((i) => u32(NB_OFFSET + i * 4)),
    viewSrc: dv.getBigUint64(at + VIEW_SRC_OFFSET, true), viewOffs: dv.getBigUint64(at + VIEW_OFFS_OFFSET, true),
  };
}

/** ggml_nbytes as b11205 computes it (stride-aware; 0 when any ne is 0), exact in BigInt. */
export function nbytes(t: Pick<Shape, "type" | "ne" | "nb">): bigint {
  if (t.ne.some((n) => n === 0n)) return 0n;
  const [ts, bs] = TYPE_TRAITS[t.type] ?? [0, 0];
  const tail = t.ne.slice(1).reduce((s, n, i) => s + (n - 1n) * t.nb[i + 1]!, 0n);
  return bs === 1 ? BigInt(ts) + (t.ne[0]! - 1n) * t.nb[0]! + tail : (t.ne[0]! * t.nb[0]!) / BigInt(bs) + tail;
}

/**
 * POOL-5 shape checks, only where legitimate graphs can't differ (verified on every measured model): a leaf (op
 * NONE, not a view) must be laid out contiguously for its type (nb[0] = type size, nb[1] = nb[0] x ne[0] / block
 * size, nb[2] = nb[1] x ne[1], nb[3] = nb[2] x ne[2], ne[0] a whole number of blocks). Views are checked in
 * checkViews. Nothing here reads tensor DATA or op_params: parameters of allowed ops still reach llama.cpp unchecked.
 */
function checkLeafLayout(t: Shape): void {
  // Not a leaf, a view, a null placeholder (id 0: an absent src in GET_ALLOC_SIZE) or empty (reaches no memory).
  if (t.op !== 0 || t.viewSrc !== 0n || t.id === 0n || t.ne.some((n) => n === 0n)) return;
  const [ts, bs] = TYPE_TRAITS[t.type] ?? [0, 0];
  if (ts === 0 || bs === 0) throw new RpcRefused("tensor type refused");
  const b = BigInt(bs);
  if (t.ne[0]! % b !== 0n) throw new RpcRefused("leaf tensor row isn't whole blocks");
  const want = [BigInt(ts), (BigInt(ts) * t.ne[0]!) / b];
  want.push(want[1]! * t.ne[1]!, want[1]! * t.ne[1]! * t.ne[2]!);
  if (t.nb.some((n, i) => n !== want[i])) throw new RpcRefused(`leaf tensor strides don't match its shape (type ${t.type}, ne [${t.ne.join(",")}], nb [${t.nb.join(",")}])`);
}

/** One rpc_tensor at `at` in `p`: op on the allow-list, type below GGML_TYPE_COUNT, leaf layout. Returns its shape. */
function checkTensor(p: Uint8Array, at: number, ops: { has(op: number): boolean }): Shape {
  if (p.byteLength < at + RPC_TENSOR_SIZE) throw new RpcRefused("malformed tensor");
  const t = shapeAt(view(p), at);
  if (!ops.has(t.op)) throw new RpcRefused(`op ${t.op} refused`);
  if (t.type >= TYPE_COUNT) throw new RpcRefused("tensor type refused");
  checkLeafLayout(t);
  return t;
}

/**
 * Views whose source is in the same message: view_offs + the view's (strided) byte extent must fit in the source's
 * extent (what ggml asserts when it builds a view, ggml.c ggml_new_tensor_impl; rpc-server copies view_offs
 * unchecked, ggml-rpc.cpp:1708).
 */
function checkViews(ts: readonly Shape[]): void {
  const byId = new Map(ts.map((t) => [t.id, t] as const));
  for (const t of ts) {
    if (t.viewSrc === 0n) continue;
    const src = byId.get(t.viewSrc);
    if (!src) continue;
    if (t.viewOffs + nbytes(t) > nbytes(src)) throw new RpcRefused("view reaches past its source tensor");
  }
}

/**
 * | device u32 | n_nodes u32 | nodes u64 x n | n_tensors u32 | rpc_tensor x m | (graph_compute, ggml-rpc.cpp:1712-1739).
 * Returns the ops seen.
 */
export function checkGraph(p: Uint8Array, ops: { has(op: number): boolean } = ALLOWED_OPS): number[] {
  const dv = view(p);
  if (p.byteLength < 12) throw new RpcRefused("malformed graph");
  const nNodes = dv.getUint32(4, true);
  const tensorsAt = 8 + nNodes * 8 + 4;
  if (p.byteLength < tensorsAt) throw new RpcRefused("malformed graph");
  for (let k = 0; k < nNodes; k++) {
    if (dv.getBigUint64(8 + k * 8, true) === 0n) throw new RpcRefused("graph node id 0 refused");
  }
  const nTensors = dv.getUint32(8 + nNodes * 8, true);
  if (p.byteLength !== tensorsAt + nTensors * RPC_TENSOR_SIZE) throw new RpcRefused("malformed graph");
  const shapes: Shape[] = [];
  for (let t = 0; t < nTensors; t++) shapes.push(checkTensor(p, tensorsAt + t * RPC_TENSOR_SIZE, ops));
  checkViews(shapes);
  return shapes.map((t) => t.op);
}

// ---- self-test (stage start) ---------------------------------------------------------------------------------

function msg(cmd: number, payload: Uint8Array): Uint8Array {
  const b = new Uint8Array(9 + payload.byteLength);
  b[0] = cmd;
  view(b).setBigUint64(1, BigInt(payload.byteLength), true);
  b.set(payload, 9);
  return b;
}

/** A tensor for the self-test: op, and optionally a real f32 shape, a view source and offset. */
interface TestTensor { op: number; ne?: number[]; nb?: number[]; viewSrc?: number; viewOffs?: number }

function graphPayload(ts: Array<number | TestTensor>, nodeId = 1n): Uint8Array {
  const p = new Uint8Array(8 + 8 + 4 + ts.length * RPC_TENSOR_SIZE);
  const dv = view(p);
  dv.setUint32(4, 1, true);
  dv.setBigUint64(8, nodeId, true);
  dv.setUint32(16, ts.length, true);
  ts.forEach((x, i) => {
    const t = typeof x === "number" ? { op: x } : x;
    const at = 20 + i * RPC_TENSOR_SIZE;
    dv.setBigUint64(at, BigInt(i + 1), true);
    dv.setUint32(at + OP_OFFSET, t.op, true);
    (t.ne ?? []).forEach((n, k) => dv.setUint32(at + NE_OFFSET + k * 4, n, true));
    (t.nb ?? []).forEach((n, k) => dv.setUint32(at + NB_OFFSET + k * 4, n, true));
    if (t.viewSrc) dv.setBigUint64(at + VIEW_SRC_OFFSET, BigInt(t.viewSrc), true);
    if (t.viewOffs) dv.setBigUint64(at + VIEW_OFFS_OFFSET, BigInt(t.viewOffs), true);
  });
  return p;
}

/** A 16-float f32 row (64 bytes, contiguous): the source the self-test's views look into. */
const ROW: TestTensor = { op: 0, ne: [16, 1, 1, 1], nb: [4, 64, 64, 64] };

/**
 * Runs known-good and known-bad streams through a fresh guard: null when every one is judged as it must be, else
 * what went wrong. A stage refuses to serve when this fails (a broken guard must never pass bytes unchecked).
 */
export function guardSelfTest(): string | null {
  const hello = msg(CMD.HELLO, new Uint8Array(HELLO_SIZE).fill(7));
  const good = [hello, msg(CMD.DEVICE_COUNT, new Uint8Array(0)), msg(CMD.GRAPH_COMPUTE, graphPayload([
    ROW, 29, 25, 48, { op: 37, ne: [8, 1, 1, 1], nb: [4, 32, 32, 32], viewSrc: 1, viewOffs: 32 }, // the row's second half
  ]))];
  const run = (parts: Uint8Array[]): { out: number; refused: boolean } => {
    const g = new RpcGuard({ maxMessage: 1 << 30 });
    let out = 0;
    try {
      for (const p of parts) for (const x of g.feed(p)) out += x.byteLength;
      return { out, refused: false };
    } catch (err) {
      if (err instanceof RpcRefused) return { out, refused: true };
      throw err;
    }
  };
  const ok = run(good);
  if (ok.refused || ok.out !== good.reduce((s, p) => s + p.byteLength, 0)) return "a known-good stream was refused or altered";
  const bad: Array<[string, Uint8Array[]]> = [
    ["custom op", [hello, msg(CMD.GRAPH_COMPUTE, graphPayload([0, 95]))]],
    ["op outside the allow-list", [hello, msg(CMD.GRAPH_COMPUTE, graphPayload([0, 98]))]],
    ["node id 0", [hello, msg(CMD.GRAPH_COMPUTE, graphPayload([29], 0n))]],
    ["unknown command", [hello, msg(18, new Uint8Array(0))]],
    ["no HELLO", [msg(CMD.DEVICE_COUNT, new Uint8Array(0))]],
    ["custom op in INIT_TENSOR", [hello, msg(CMD.INIT_TENSOR, graphPayload([95]).subarray(20, 20 + RPC_TENSOR_SIZE))]],
    // Hostile parameters on ALLOWED ops (POOL-5): a VIEW reaching past its source, a leaf with forged strides.
    ["view past its source", [hello, msg(CMD.GRAPH_COMPUTE, graphPayload([ROW, { op: 37, ne: [16, 1, 1, 1], nb: [4, 64, 64, 64], viewSrc: 1, viewOffs: 64 }]))]],
    ["leaf with forged strides", [hello, msg(CMD.GRAPH_COMPUTE, graphPayload([{ op: 0, ne: [16, 4, 1, 1], nb: [4, 1 << 30, 1 << 30, 1 << 30] }, 29]))]],
  ];
  for (const [what, parts] of bad) if (!run(parts).refused) return `a ${what} got through`;
  return null;
}
