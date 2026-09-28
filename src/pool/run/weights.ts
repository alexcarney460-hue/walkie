// Local weights for split-run stages (POOL-REAL-1). A stage's share of a model normally crosses the network: the
// head sends every weight tensor into the worker's rpc-server. Between atlas-wsl and hestia-wsl (both behind WSL's
// NAT) that ran at ~0.2 MB/s over Walkie, hours for a few GB. llama.cpp's RPC protocol has a way around it: before
// sending a weight tensor over 10 MiB the head asks SET_TENSOR_HASH with the tensor's FNV-1a 64 hash, and an
// rpc-server started with `-c` loads it from `$LLAMA_CACHE/rpc/<hash>` instead (ggml-rpc.cpp:717-735, 1483-1530 at
// b11205). So a machine that has the model's pinned GGUF (sha256-checked) can "prepare" it: every tensor over the
// threshold is copied out of the file into that cache, named by its hash. A stage of a prepared model then runs
// rpc-server with `-c` and LLAMA_CACHE pointed at it: only activations cross the network.
//
// The cache is written only here, from a checked file; the RPC guard zeroes the head's SET_TENSOR cache flag, so a
// head can't make the worker write files. It costs disk: about the model's size again (the tensors are copies).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { localPath, type ModelFiles } from "./gguf.ts";

/** Tensors larger than this are sent by hash first (ggml-rpc.cpp HASH_THRESHOLD, b11205). */
export const HASH_THRESHOLD = 10 * 1024 * 1024;
const MARKER = "WALKIE_WEIGHTS";
const READ_CHUNK = 16 * 1024 * 1024;

/** [type size, block size] per ggml_type 0..42 (b11205 libggml-base; the RPC guard carries the same table). */
const TYPE_TRAITS: ReadonlyArray<readonly [number, number]> = [[4, 1], [2, 1], [18, 32], [20, 32], [0, 0], [0, 0], [22, 32], [24, 32], [34, 32], [36, 32], [84, 256], [110, 256], [144, 256], [176, 256], [210, 256], [292, 256], [66, 256], [74, 256], [98, 256], [50, 256], [18, 32], [110, 256], [82, 256], [136, 256], [1, 1], [2, 1], [4, 1], [8, 1], [8, 1], [56, 256], [2, 1], [0, 0], [0, 0], [0, 0], [54, 256], [66, 256], [0, 0], [0, 0], [0, 0], [17, 32], [36, 64], [18, 128], [18, 64]];

/** FNV-1a 64 as ggml-rpc.cpp computes it, continued over chunks; the state is [high 32 bits, low 32 bits]. */
export function fnv1a64(buf: Uint8Array, state: readonly [number, number] = [0xcbf29ce4, 0x84222325]): [number, number] {
  let hi = state[0] >>> 0;
  let lo = state[1] >>> 0;
  for (let i = 0; i < buf.length; i++) {
    lo = (lo ^ buf[i]!) >>> 0;
    // (hi:lo) * 0x100000001b3 mod 2^64 = (hi:lo) * 0x1b3 + (lo << 40).
    const l = lo * 0x1b3;
    const nlo = l >>> 0;
    hi = (Math.imul(hi, 0x1b3) + (l - nlo) / 4294967296 + (lo << 8)) >>> 0;
    lo = nlo;
  }
  return [hi, lo];
}

export const hashHex = (s: readonly [number, number]): string => s[0].toString(16).padStart(8, "0") + s[1].toString(16).padStart(8, "0");

export interface GgufTensor { name: string; type: number; ne: number[]; offset: number; bytes: number }

/** Reads a GGUF file's header on demand. */
class Reader {
  private buf = new Uint8Array(0);
  private start = 0;
  pos = 0;
  constructor(private readonly fh: Awaited<ReturnType<typeof open>>) {}
  private async need(n: number): Promise<void> {
    if (this.pos + n <= this.start + this.buf.byteLength) return;
    const len = Math.max(n, 1024 * 1024);
    const b = new Uint8Array(len);
    const { bytesRead } = await this.fh.read(b, 0, len, this.pos);
    if (bytesRead < n) throw new Error("the GGUF header ends early");
    this.buf = b.subarray(0, bytesRead);
    this.start = this.pos;
  }
  async bytes(n: number): Promise<Uint8Array> { await this.need(n); const o = this.pos - this.start; this.pos += n; return this.buf.subarray(o, o + n); }
  async u32(): Promise<number> { const b = await this.bytes(4); return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true); }
  async u64(): Promise<number> {
    const b = await this.bytes(8);
    const v = new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("a GGUF count is out of range");
    return Number(v);
  }
  async str(): Promise<string> { const n = await this.u64(); if (n > 1 << 20) throw new Error("a GGUF string is too long"); return new TextDecoder().decode(await this.bytes(n)); }
}

const SCALAR: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

async function skipValue(r: Reader, type: number): Promise<number | null> {
  if (type === 8) { await r.str(); return null; }
  if (type === 9) {
    const et = await r.u32();
    const n = await r.u64();
    if (SCALAR[et]) { await r.bytes(SCALAR[et]! * n); return null; }
    for (let i = 0; i < n; i++) await skipValue(r, et);
    return null;
  }
  const size = SCALAR[type];
  if (!size) throw new Error(`unknown GGUF value type ${type}`);
  if (type === 4) return r.u32();
  await r.bytes(size);
  return null;
}

/** The tensors of one GGUF file: type, shape, absolute offset of their data and their size in bytes. */
export async function readGgufTensors(path: string): Promise<GgufTensor[]> {
  const fh = await open(path, "r");
  try {
    const r = new Reader(fh);
    if (new TextDecoder().decode(await r.bytes(4)) !== "GGUF") throw new Error(`${path} is not a GGUF file`);
    const version = await r.u32();
    if (version < 2 || version > 3) throw new Error(`GGUF version ${version} is not supported`);
    const nTensors = await r.u64();
    const nKv = await r.u64();
    let alignment = 32;
    for (let i = 0; i < nKv; i++) {
      const key = await r.str();
      const v = await skipValue(r, await r.u32());
      if (key === "general.alignment" && typeof v === "number" && v > 0) alignment = v;
    }
    const infos: Omit<GgufTensor, "bytes">[] = [];
    for (let i = 0; i < nTensors; i++) {
      const name = await r.str();
      const nd = await r.u32();
      if (nd > 4) throw new Error(`tensor ${name} has ${nd} dimensions`);
      const ne: number[] = [];
      for (let d = 0; d < nd; d++) ne.push(await r.u64());
      const type = await r.u32();
      infos.push({ name, type, ne, offset: await r.u64() });
    }
    const dataStart = Math.ceil(r.pos / alignment) * alignment;
    return infos.map((t) => {
      const [ts, bs] = TYPE_TRAITS[t.type] ?? [0, 0];
      if (!ts || !bs) throw new Error(`tensor ${t.name} has an unknown type ${t.type}`);
      const [ne0 = 1, ...rest] = t.ne;
      const bytes = (ne0 / bs) * ts * rest.reduce((a, b) => a * b, 1);
      return { ...t, offset: dataStart + t.offset, bytes };
    });
  } finally {
    await fh.close();
  }
}

/** Where a pinned model's prepared weights live: <home>/pool/weights/<first file's sha256>/ (LLAMA_CACHE for rpc-server). */
export function weightsDir(home: string, mf: ModelFiles): string {
  return join(home, "pool", "weights", mf.files[0]!.sha256);
}

/** The prepared directory for `mf` if it is complete (its marker names every file's sha256), else null. */
export function preparedDir(home: string, mf: ModelFiles): string | null {
  const dir = weightsDir(home, mf);
  try {
    const marker = readFileSync(join(dir, MARKER), "utf8");
    return mf.files.every((f) => marker.includes(f.sha256)) ? dir : null;
  } catch {
    return null;
  }
}

export interface PrepareProgress { done: number; total: number }

/**
 * Copies every tensor over HASH_THRESHOLD of the (already checked) GGUF files into `<dir>/rpc/<fnv hash>`, then
 * writes the marker. Files already there (a prepare that was interrupted) are checked by size and kept.
 */
export async function prepareWeights(home: string, mf: ModelFiles, signal: AbortSignal, onProgress: (p: PrepareProgress) => void): Promise<{ dir: string; tensors: number; bytes: number }> {
  const dir = weightsDir(home, mf);
  const rpc = join(dir, "rpc");
  mkdirSync(rpc, { recursive: true, mode: 0o700 });
  const perFile = await Promise.all(mf.files.map(async (f) => ({ path: localPath(home, mf, f), tensors: (await readGgufTensors(localPath(home, mf, f))).filter((t) => t.bytes > HASH_THRESHOLD) })));
  const total = perFile.reduce((s, x) => s + x.tensors.reduce((a, t) => a + t.bytes, 0), 0);
  let done = 0;
  let count = 0;
  const chunk = new Uint8Array(READ_CHUNK);
  for (const { path, tensors } of perFile) {
    const fh = await open(path, "r");
    try {
      for (const t of tensors) {
        if (signal.aborted) throw new Error("prepare cancelled");
        let state: [number, number] = [0xcbf29ce4, 0x84222325];
        const tmp = join(rpc, `.part-${process.pid}`);
        const out = await open(tmp, "w", 0o600);
        try {
          for (let off = 0; off < t.bytes; off += READ_CHUNK) {
            const n = Math.min(READ_CHUNK, t.bytes - off);
            const { bytesRead } = await fh.read(chunk, 0, n, t.offset + off);
            if (bytesRead !== n) throw new Error(`${path}: short read in tensor ${t.name}`);
            const b = chunk.subarray(0, n);
            state = fnv1a64(b, state);
            await out.write(b);
            done += n;
            onProgress({ done, total });
          }
        } finally {
          await out.close();
        }
        const dest = join(rpc, hashHex(state));
        if (existsSync(dest) && statSync(dest).size === t.bytes) rmSync(tmp, { force: true });
        else renameSync(tmp, dest);
        count++;
      }
    } finally {
      await fh.close();
    }
  }
  writeFileSync(join(dir, MARKER), `${mf.repo}@${mf.revision}\n${mf.files.map((f) => f.sha256).join("\n")}\n`, { mode: 0o600 });
  return { dir, tensors: count, bytes: total };
}

/** Prepared weight directories under this home (for the published list and the disk-use line). */
export function preparedShas(home: string): string[] {
  try {
    return readdirSync(join(home, "pool", "weights")).filter((d) => existsSync(join(home, "pool", "weights", d, MARKER)));
  } catch {
    return [];
  }
}
