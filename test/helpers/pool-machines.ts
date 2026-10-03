// Machines built from real captures (test/fixtures): a DGX Spark's nvidia-smi and /proc/meminfo, a 16 GB Apple Mac's
// sysctl and vm_stat. The reports are made by the daemon's own parsers, so a test of the suggestions starts from what
// the machines said, not from a hand-written number.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDarwinAccel, parseNvidiaSmi } from "../../src/daemon/machine-stats/accel.ts";
import { darwinMem, linuxMem } from "../../src/daemon/machine-stats/parse.ts";
import type { GroupInput } from "../../src/pool/group.ts";
import type { MachineStats } from "../../src/protocol/machine-stats.ts";

export const FIXTURES = join(import.meta.dir, "..", "fixtures");
export const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), "utf8");

const base = (hostname: string, over: Partial<GroupInput>): Omit<GroupInput, "stats"> => ({
  node_id: new Bun.CryptoHasher("sha1").update(hostname).digest("hex").slice(0, 16), hostname, handle: "alex", online: true, self: false, rtt_ms: 2, ...over,
});

/** A DGX Spark (NVIDIA GB10): the captured nvidia-smi line and meminfo; `sys` says the GPU facts a daemon would send. */
export function spark(hostname: string, meminfoFile: string, over: Partial<GroupInput> = {}, smiFile = "machine-stats/nvidia-smi-gb10.txt"): GroupInput {
  const mem = linuxMem(fixture(meminfoFile), null);
  if (!mem) throw new Error(`no meminfo in ${meminfoFile}`);
  const stats: MachineStats = {
    at: 1, temp_c: 49, mem,
    accel: { chip: null, unified: false, gpu_limit: null, gpus: parseNvidiaSmi(fixture(smiFile)) },
  };
  return { ...base(hostname, over), stats, ...over };
}

/** This 16 GB Apple M5 Mac as it was captured, busy as it was (about 10 GB wired, swap in use). */
export function mac16(hostname = "alex-mac", over: Partial<GroupInput> = {}): GroupInput {
  const mem = darwinMem(fixture("pool-hf/machines/mac-m5-16gb-vm_stat.txt"), fixture("pool-hf/machines/mac-m5-16gb-sysctl.txt"));
  if (!mem) throw new Error("no Mac memory");
  const stats: MachineStats = { at: 1, temp_c: 55, mem, accel: { ...parseDarwinAccel("Apple M5", "1", "0"), gpus: [] } };
  return { ...base(hostname, over), stats, ...over };
}
