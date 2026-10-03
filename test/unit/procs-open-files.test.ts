// SystemProcessProvider.openFiles tells "this process holds nothing open" ([]) from "the lookup got no answer" (null): discovery
// backs off only on a real answer, and repeats a lookup that failed. The lsof branch is driven with stand-in `lsof` scripts.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemProcessProvider } from "../../src/daemon/procs.ts";

const dirs: string[] = [];
const realPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = realPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "procs-open-files-"));
  dirs.push(dir);
  return dir;
}

/** The provider's lsof path (macOS), whatever the host: the field only picks /proc over lsof. */
function lsofProvider(): SystemProcessProvider {
  const provider = new SystemProcessProvider();
  (provider as unknown as { linux: boolean }).linux = false;
  return provider;
}

function withLsof(script: string | null): void {
  const bin = scratch();
  if (script !== null) {
    writeFileSync(join(bin, "lsof"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "lsof"), 0o755);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
  } else process.env.PATH = bin; // an empty directory: there is no lsof to start
}

test("/proc: a file the process holds open is listed; a pid whose fd directory cannot be read gives no answer", async () => {
  if (process.platform !== "linux") return;
  const file = join(scratch(), "held.txt");
  writeFileSync(file, "x");
  const fd = openSync(file, "r");
  try {
    const provider = new SystemProcessProvider();
    expect(await provider.openFiles(process.pid)).toContain(realpathSync(file));
    expect(await provider.openFiles(2 ** 22 + 12_345)).toBeNull(); // no such process: /proc/<pid>/fd cannot be read
  } finally { closeSync(fd); }
});

test("lsof: a listing is parsed; an empty output is a real, empty answer", async () => {
  withLsof("printf 'p123\\nn/tmp/a\\nn/tmp/b c\\nf4\\n'");
  expect(await lsofProvider().openFiles(123)).toEqual(["/tmp/a", "/tmp/b c"]);
  withLsof("exit 1");
  expect(await lsofProvider().openFiles(123)).toEqual([]);
});

test("lsof: a command that cannot start, or whose output is over the cap, gives no answer, not an empty list", async () => {
  withLsof(null);
  expect(await lsofProvider().openFiles(123)).toBeNull(); // spawn failed
  withLsof("head -c 9000000 /dev/zero | tr '\\0' 'n'");
  expect(await lsofProvider().openFiles(123)).toBeNull(); // 9 MB > the 8 MB output cap
});
