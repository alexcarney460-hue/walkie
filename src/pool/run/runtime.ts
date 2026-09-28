// The llama.cpp runtime for split runs (WALKIE-POOL-2). Every machine in a run must run the SAME llama.cpp build: the
// RPC wire protocol between llama-server and rpc-server is versioned. Homebrew's llama.cpp is built on a ggml without
// GGML_RPC, so it has no RPC server; Walkie pins a GitHub release build and installs it with `walkie pool install`
// into <walkie home>/pool/llama/, checking the tarball's sha256 (GitHub's asset digest, recorded here).
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";

export const LLAMA_BUILD = "b11205";
const BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}`;

export interface RuntimeAsset { file: string; sha256: string; bytes: number }
export interface RuntimeTarget { id: string; label: string; assets: RuntimeAsset[] }

/** Pinned assets of build b11205 (sha256 = GitHub's release asset digest, read 2026-09-26). */
export const TARGETS: Readonly<Record<string, RuntimeTarget>> = {
  "darwin-arm64": { id: "darwin-arm64", label: "macOS (Apple Silicon, Metal)", assets: [{ file: `llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz`, sha256: "97b06f59ad15e2b4b6044ba7338c4e3f40354c6dc2b9c5cda234e2bd6b9fd65e", bytes: 11755672 }] },
  "darwin-x64": { id: "darwin-x64", label: "macOS (Intel)", assets: [{ file: `llama-${LLAMA_BUILD}-bin-macos-x64.tar.gz`, sha256: "1122a00cf6ce9e9ae687c1b71fef82e2f59bec2bea443f4746d94212b3124db1", bytes: 11309116 }] },
  "linux-x64": { id: "linux-x64", label: "Linux x64 (CPU)", assets: [{ file: `llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz`, sha256: "730ea8e54b97735abb46e46747999249719251f29753fcda97b5e2f2f3ea6912", bytes: 17403637 }] },
  "linux-x64-cuda": {
    id: "linux-x64-cuda", label: "Linux x64 with an NVIDIA GPU (CUDA 12.8)", assets: [
      { file: `llama-${LLAMA_BUILD}-bin-ubuntu-cuda-12.8-x64.tar.gz`, sha256: "2922888a8c1c946d829bd6d283ac9cc1b154fff951046a3e5cd74e8582427b56", bytes: 170927888 },
      { file: `cudart-llama-${LLAMA_BUILD}-bin-ubuntu-cuda-12.8-x64.tar.gz`, sha256: "d55fd64fd568e91bba77613317f40bba7a6c65d123c7e7f7598364314275a00b", bytes: 594377688 },
    ],
  },
  "linux-arm64": { id: "linux-arm64", label: "Linux arm64 (CPU)", assets: [{ file: `llama-${LLAMA_BUILD}-bin-ubuntu-arm64.tar.gz`, sha256: "9106753bff55e43c78ff595bf169a6bf01175f3d38f707866a1142553d4c437a", bytes: 13500061 }] },
};

/** This machine's target: CUDA when an NVIDIA GPU was found (machine stats `accel.gpus`), else the CPU build. */
export function targetFor(opts: { platform?: string; arch?: string; nvidia?: boolean } = {}): RuntimeTarget | null {
  const p = opts.platform ?? osPlatform();
  const a = opts.arch ?? osArch();
  if (p === "darwin") return TARGETS[a === "arm64" ? "darwin-arm64" : "darwin-x64"] ?? null;
  if (p === "linux" && a === "x64") return TARGETS[opts.nvidia ? "linux-x64-cuda" : "linux-x64"] ?? null;
  if (p === "linux" && a === "arm64") return TARGETS["linux-arm64"] ?? null;
  return null;
}

/** The one line a person runs on a machine that lacks the runtime. */
export const INSTALL_HINT = "walkie pool install";

/** What `walkie pool install` does, per OS, for people who'd rather do it by hand (no sha check: prefer the command). */
export function manualInstall(t: RuntimeTarget, dir = "~/.walkie/pool/llama"): string {
  return t.assets.map((a) => `mkdir -p ${dir} && curl -fsSL ${BASE}/${a.file} | tar -xz --strip-components=1 -C ${dir}`).join(" && ");
}

export interface Runtime {
  dir: string;
  server: string | null;
  rpc: string | null;
}

const RPC_NAMES = ["ggml-rpc-server", "rpc-server"];
const SERVER_NAMES = ["llama-server"];

function findIn(dir: string, names: readonly string[]): string | null {
  for (const n of names) {
    const p = join(dir, n);
    try { if (statSync(p).isFile()) return p; } catch { /* absent */ }
  }
  return null;
}

/**
 * Where the runtime is: `dir` (config `pool_llama_dir`, or WALKIE_LLAMA_DIR), else <home>/pool/llama. PATH is not
 * searched: a Homebrew llama-server has no RPC and another build may speak another RPC protocol version.
 */
export function locateRuntime(home: string, dir?: string): Runtime {
  const d = dir ?? process.env.WALKIE_LLAMA_DIR ?? join(home, "pool", "llama");
  return { dir: d, server: findIn(d, SERVER_NAMES), rpc: findIn(d, RPC_NAMES) };
}

export const hasRuntime = (r: Runtime): boolean => !!r.server && !!r.rpc;

async function download(url: string, dest: string, sha256: string, maxBytes: number, onProgress?: (done: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${url}`);
  const hash = createHash("sha256");
  const out = Bun.file(dest).writer();
  let done = 0;
  try {
    for await (const chunk of res.body) {
      done += chunk.byteLength;
      if (done > maxBytes) throw new Error(`download larger than expected (${maxBytes} bytes): ${url}`);
      hash.update(chunk);
      out.write(chunk);
      onProgress?.(done);
    }
  } finally {
    await out.end();
  }
  const got = hash.digest("hex");
  if (got !== sha256) throw new Error(`sha256 mismatch for ${url}: expected ${sha256}, got ${got}`);
}

/** Downloads the pinned build for `t`, checks every tarball's sha256, extracts into `dir` (replacing it). */
export async function installRuntime(t: RuntimeTarget, dir: string, onProgress?: (file: string, done: number, total: number) => void): Promise<Runtime> {
  // The directory is replaced: only an empty one, or one Walkie installed before (its WALKIE_BUILD marker).
  if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, "WALKIE_BUILD"))) {
    throw new Error(`${dir} is not empty and wasn't installed by walkie pool install; choose an empty directory`);
  }
  const staging = `${dir}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const a of t.assets) {
      const tgz = join(staging, a.file);
      await download(`${BASE}/${a.file}`, tgz, a.sha256, a.bytes + 1024, (d) => onProgress?.(a.file, d, a.bytes));
      const tar = Bun.spawnSync(["tar", "-xzf", tgz, "--strip-components=1", "-C", staging], { stderr: "pipe" });
      if (tar.exitCode !== 0) throw new Error(`could not extract ${a.file}: ${tar.stderr.toString().slice(0, 300)}`);
      rmSync(tgz, { force: true });
    }
    const found = locateRuntime("", staging);
    if (!hasRuntime(found)) throw new Error(`the ${LLAMA_BUILD} tarball has no llama-server or rpc server (${readdirSync(staging).slice(0, 12).join(", ")})`);
    for (const p of [found.server, found.rpc]) if (p) chmodSync(p, 0o755);
    writeFileSync(join(staging, "WALKIE_BUILD"), `${LLAMA_BUILD} ${t.id}\n`, { mode: 0o644 });
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    return locateRuntime("", dir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/** The pinned build this directory holds, if Walkie installed it ("b11205 darwin-arm64"). */
export function installedBuild(dir: string): string | null {
  const p = join(dir, "WALKIE_BUILD");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
}

/**
 * The rpc-server executables and RPC libraries of the pinned build (POOL-4), per target: sha256 of the files inside
 * the release tarballs (extracted and hashed 2026-09-26). A stage refuses to start any rpc-server that isn't one of
 * these (a Homebrew build, another release, a modified binary, whatever `pool_llama_dir` / WALKIE_LLAMA_DIR names):
 * the RPC guard is written against this build's wire format.
 */
export const PINNED_RPC: Readonly<Record<string, { server: string; lib: string }>> = {
  "darwin-arm64": { server: "cf4a3e386648bb496f69b013fc02059d0a58102833c99883f2bd455b13f9ca30", lib: "d9af4bf21c5a8dc63c1ce207245c8b26b1717c3163465135e9573f19709326b4" },
  "darwin-x64": { server: "bf7f43754e45f4f6562830c2bcf166bd1fcda798148779d517b326912af2fde8", lib: "3ed537f6ec8c2454ffb29d09403165007ca5f17158170bdba83eb0c9b900eaa2" },
  "linux-x64": { server: "cf0e9afb2bab5567c3f2f34d6d3d9bd2bdf52e843536ac4d381d1df42e07a069", lib: "7694117304505874119805566f3fe47c4c83452492590816dacc97e8470415e4" },
  "linux-x64-cuda": { server: "dbc04e8826b3c5c5f47f0ba3dcb4279691f2c5a9ec564a434410cdc9150f4a56", lib: "00edb40a3cd8c52fd5a7e02f04dd99f3d4bdc52b41e8df6c9ccc8f2bfa3da1cb" },
  "linux-arm64": { server: "55bfb44214c498e9977f352aa5746c9daefc1d2fd0dd4543c05194093f2aac23", lib: "8f9bb015d2011a068a55310b816a884661e2f6e5b14c2fde36914cd22ad6b862" },
};

const hashCache = new Map<string, { key: string; sha: string }>();
function sha256File(path: string): string {
  const real = realpathSync(path);
  const st = statSync(real);
  const key = `${st.size}:${st.mtimeMs}:${st.ino}`;
  const hit = hashCache.get(real);
  if (hit && hit.key === key) return hit.sha;
  const sha = createHash("sha256").update(readFileSync(real)).digest("hex");
  hashCache.set(real, { key, sha });
  return sha;
}

/** The RPC library next to the server (libggml-rpc.so / .dylib, symlinks resolved), or null. */
function rpcLib(dir: string): string | null {
  for (const n of ["libggml-rpc.so", "libggml-rpc.dylib"]) {
    const p = join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * null when `rt.rpc` and its RPC library are the pinned build (for any target), else why not. Only files are
 * compared, so the directory they came from doesn't matter.
 */
export function verifyPinnedRpc(rt: Runtime): string | null {
  if (!rt.rpc) return "no rpc-server";
  try {
    const server = sha256File(rt.rpc);
    const hit = Object.entries(PINNED_RPC).find(([, p]) => p.server === server);
    if (!hit) return `the rpc-server at ${rt.rpc} is not llama.cpp ${LLAMA_BUILD} as Walkie pins it (sha256 ${server.slice(0, 12)}…); run: ${INSTALL_HINT}`;
    const lib = rpcLib(dirname(realpathSync(rt.rpc))) ?? rpcLib(rt.dir);
    if (!lib || hit[1].lib !== sha256File(lib)) return `the RPC library next to ${rt.rpc} is missing or not the pinned ${LLAMA_BUILD} one; run: ${INSTALL_HINT}`;
    return null;
  } catch (err) {
    return `could not check the rpc-server: ${(err as Error).message}`;
  }
}
