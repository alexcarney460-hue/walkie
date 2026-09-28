// llama-server's device list and arguments for a split run (WALKIE-POOL-2). Pure.
//
// `llama-server --list-devices --rpc a,b` prints one line per device: "  MTL0: Apple M5 (12124 MiB, ...)",
// "  RPC0: 127.0.0.1:50611 (16384 MiB, ...)". Walkie picks the first device each rpc-server endpoint exposes and
// the head's own first accelerator (not BLAS, not RPC); layers are split over them with --tensor-split in proportion
// to the bytes each machine holds. A head without an accelerator holds no layers in v1.

export interface Device { name: string; desc: string }

export function parseDevices(out: string): Device[] {
  const devs: Device[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s{2}([A-Za-z]+\d+):\s+(.*)$/.exec(line);
    if (m) devs.push({ name: m[1]!, desc: m[2]! });
  }
  return devs;
}

/** The first device of each rpc endpoint ("127.0.0.1:port"), in endpoint order; null where none was listed. */
export function rpcDevices(devs: readonly Device[], endpoints: readonly string[]): (string | null)[] {
  return endpoints.map((ep) => devs.find((d) => d.name.startsWith("RPC") && d.desc.startsWith(`${ep} `))?.name ?? null);
}

/** The head's own accelerator (Metal, CUDA, Vulkan...), if any. */
export function localDevice(devs: readonly Device[]): string | null {
  return devs.find((d) => !d.name.startsWith("RPC") && !d.name.startsWith("BLAS"))?.name ?? null;
}

/** "3,1,2" from bytes per device (integers keep the argument short; 0-byte devices aren't listed). */
export function tensorSplit(bytes: readonly number[]): string {
  const total = bytes.reduce((s, b) => s + b, 0) || 1;
  return bytes.map((b) => Math.max(1, Math.round((b / total) * 1000))).join(",");
}
