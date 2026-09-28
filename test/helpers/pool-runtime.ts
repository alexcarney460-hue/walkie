// A llama.cpp runtime directory whose rpc server is a test stand-in (test/fixtures/pool/*.ts) and whose llama-server
// exits at once: split-run tests that don't need a real model. WALKIE-POOL-2/3.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function fakeRuntime(root: string, rpc: "fake-rpc" | "stuck-rpc" | "slow-rpc" = "fake-rpc"): string {
  const dir = join(root, `rt-${rpc}`);
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "ggml-rpc-server");
  const script = join(import.meta.dir, "../fixtures/pool", rpc === "stuck-rpc" ? "stuck-rpc.py" : `${rpc}.ts`);
  writeFileSync(bin, rpc === "stuck-rpc" ? `#!/bin/sh\nexec python3 "${script}" "$@"\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  const srv = join(dir, "llama-server");
  writeFileSync(srv, "#!/bin/sh\nexit 1\n");
  chmodSync(bin, 0o755);
  chmodSync(srv, 0o755);
  return dir;
}

/** A HELLO message as llama-server sends it first (cmd 14, 24 bytes of transport capabilities). */
export function helloMsg(caps = 0): Uint8Array {
  const b = new Uint8Array(9 + 24);
  b[0] = 14;
  new DataView(b.buffer).setBigUint64(1, 24n, true);
  b.fill(caps, 9);
  return b;
}

/** A message header: command byte + u64 little-endian payload size. */
export function msgHead(cmd: number, size: number): Uint8Array {
  const b = new Uint8Array(9);
  b[0] = cmd;
  new DataView(b.buffer).setBigUint64(1, BigInt(size), true);
  return b;
}

/** Stand-in rpc-servers aren't the pinned llama.cpp build: tests that use them accept them explicitly. */
export const ACCEPT_STANDIN = (): null => null;
