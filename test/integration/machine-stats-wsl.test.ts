// WALKIE-TEMP-WSL: the real process path with a fake `powershell.exe` found under a wsl.conf automount root (never PATH). The fake records its argv and
// environment, so the test proves the fixed command, the minimal environment and closed stdin, then the parsed zones
// flow through the WSL-aware Linux reader.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxReader, run } from "../../src/daemon/machine-stats/read.ts";
import { findPowershell, POWERSHELL_QUERY, WIN_SAMPLE_MS, WindowsThermal } from "../../src/daemon/machine-stats/wsl.ts";

let dir: string;
const ZONES = '[{"Name":"\\\\_TZ.TZ00","HighPrecisionTemperature":3010,"Temperature":301},{"Name":"\\\\_TZ.THRM","HighPrecisionTemperature":3592,"Temperature":359}]';

beforeAll(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), "walkie-wsl-")); // a real path: the lookup refuses symlinked components
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fake(name: string, body: string): string {
  const d = mkdtempSync(join(dir, `${name}-`));
  const p = join(d, "powershell.exe");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return d;
}

test("a fake powershell.exe under the wsl.conf automount root: fixed argv, minimal environment, no stdin; its zones become the temperature", async () => {
  const root = mkdtempSync(join(dir, "root-"));
  const d = join(root, "c/Windows/System32/WindowsPowerShell/v1.0");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "powershell.exe"), `#!/bin/sh\n${[
    `for a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/argv.txt"`,
    `env > "${dir}/env.txt"`,
    `if read -r line; then echo "stdin: $line" > "${dir}/stdin.txt"; fi`,
    `printf '%s\\r\\n' '${ZONES}'`,
  ].join("\n")}\n`);
  chmodSync(join(d, "powershell.exe"), 0o755);
  // Real file checks: /mnt/c/... does not exist here, so the automount root's copy is the one found.
  const bin = await findPowershell({
    readText: async (p) => (p === "/etc/wsl.conf" ? `[automount]\nroot = ${root}/\n`
      : p === "/proc/self/mountinfo" ? `1 0 8:48 / / rw - ext4 /dev/sdd rw\n2 1 0:77 / ${root}/c rw - 9p C:\\134 rw,aname=drvfs;path=C:\\\n` : null),
    dev: async () => "0:77", // the temp dir is not really a 9p mount: stat is stubbed to agree with the synthetic table
  });
  expect(bin).toBe(join(d, "powershell.exe"));
  const thermal = new WindowsThermal({ run: (cmd, o) => run(cmd, { onTimeout: o.onTimeout }), interop: async () => [{ kind: "plain" as const }], powershell: async () => bin });
  const reader = linuxReader({ read: async () => ({ mem: null, temp_c: null }), wsl: async () => true, windows: () => thermal.read() });
  const r = await reader();
  expect(r.temp_c).toBe(86.1);
  expect(r.temp_zones).toEqual([{ name: "TZ00", c: 27.9 }, { name: "THRM", c: 86.1 }]);
  expect(readFileSync(join(dir, "argv.txt"), "utf8").split("\n").slice(0, 5)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_QUERY]);
  const env = readFileSync(join(dir, "env.txt"), "utf8").split("\n").filter(Boolean).map((l) => l.split("=")[0]).filter((k) => k !== "PWD" && k !== "SHLVL" && k !== "_");
  expect(env.sort()).toEqual(["LC_ALL", "PATH"]);
  expect(() => readFileSync(join(dir, "stdin.txt"))).toThrow();
});

test("a fake that fails or prints garbage: temperature n/a, no throw", async () => {
  for (const body of ["echo 'Get-CimInstance : Invalid class' >&2; exit 1", "echo 'not json'"]) {
    const d = fake("bad", body);
    const thermal = new WindowsThermal({ run: (cmd, o) => run(cmd, { onTimeout: o.onTimeout }), interop: async () => [{ kind: "plain" as const }], powershell: async () => join(d, "powershell.exe") });
    const r = await linuxReader({ read: async () => ({ mem: null, temp_c: null }), wsl: async () => true, windows: () => thermal.read() })();
    expect(r.temp_c).toBeNull();
    expect(thermal.failures).toBe(1);
  }
});

test("a fake that hangs is killed at the deadline; the route is skipped for 10 min, then asked again", async () => {
  const d = fake("hang", "sleep 30");
  let now = 0;
  let spawned = 0;
  const thermal = new WindowsThermal({
    run: (cmd, o) => { spawned++; return run(cmd, { timeoutMs: 300, onTimeout: o.onTimeout }); }, interop: async () => [{ kind: "plain" as const }],
    powershell: async () => join(d, "powershell.exe"), clock: () => now,
  });
  const t0 = Date.now();
  const w = await thermal.read();
  expect(Date.now() - t0).toBeLessThan(3_000);
  expect(w.zones).toBeNull();
  expect(thermal.failures).toBe(1);
  now += WIN_SAMPLE_MS;
  await thermal.read();
  expect(spawned).toBe(1); // skipped, not asked again within 10 min
  now += 24 * 60 * 60_000;
  await thermal.read();
  expect(spawned).toBe(2); // never off for good
});
