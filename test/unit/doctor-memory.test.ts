import { expect, test } from "bun:test";
import { memoryCheck } from "../../src/cli/commands/doctor.ts";
import type { MachineStats } from "../../src/protocol/machine-stats.ts";
import { darwinMem, parseMeminfo } from "../../src/daemon/machine-stats/parse.ts";

const GiB = 1024 ** 3;
const fixture = (swapUsed: number, swapTotal: number | undefined, pressure: "normal" | "critical" = "normal"): MachineStats => ({
  at: 1, temp_c: null,
  mem: { total: 16 * GiB, used: 12 * GiB, swap_used: swapUsed, ...(swapTotal === undefined ? {} : { swap_total: swapTotal }), pressure },
});

test("doctor warns at more than 80% swap or critical pressure, using fixture machine stats", () => {
  expect(memoryCheck(fixture(8.1 * GiB, 10 * GiB))?.detail).toBe("this machine is low on memory and swapping; Walkie may stall: close idle apps or agents");
  expect(memoryCheck(fixture(8 * GiB, 10 * GiB))).toBeNull();
  expect(memoryCheck(fixture(1 * GiB, undefined, "critical"))?.level).toBe("warn");
  expect(memoryCheck(fixture(8 * GiB, undefined))).toBeNull();
  expect(memoryCheck(null)).toBeNull();
});

test("macOS and Linux fixture parsers retain swap capacity for doctor", () => {
  const mac = darwinMem('Mach Virtual Memory Statistics: (page size of 4096 bytes)\n"Pages wired down": 1.\n"Anonymous pages": 1.',
    'hw.memsize: 17179869184\nvm.swapusage: total = 10.00G used = 8.10G free = 1.90G');
  expect(mac?.swap_total).toBe(10 * GiB);
  expect(mac?.swap_used).toBe(Math.round(8.1 * GiB));
  expect(parseMeminfo('MemTotal: 16384000 kB\nMemAvailable: 4096000 kB\nSwapTotal: 10240000 kB\nSwapFree: 1000000 kB')?.swap_total).toBe(10240000 * 1024);
});
