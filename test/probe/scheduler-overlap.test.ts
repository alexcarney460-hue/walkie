import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

test("two real processes preserve both seat and Talkie scheduler denies", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".scheduler-overlap-"));
  mkdirSync(join(root, "walkie-home"), { recursive: true });
  const tree = join(import.meta.dir, "..", "..");
  const child = join(import.meta.dir, "scheduler-child.ts");
  const env = { ...process.env, TREE: tree, ROOT: root };
  try {
    const seat = Bun.spawn([process.execPath, child], { env: { ...env, ROLE: "seat" }, stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(120);
    const talkie = Bun.spawn([process.execPath, child], { env: { ...env, ROLE: "talkie" }, stdout: "pipe", stderr: "pipe" });
    expect(await seat.exited).toBe(0);
    expect(await talkie.exited).toBe(0);
    const log = readFileSync(join(root, "overlap.log"), "utf8");
    expect(log).toContain("seat done ok=true");
    expect(log).toContain("talkie done ok=true");
    for (const file of ["cron.deny", "at.deny"]) {
      expect(readFileSync(join(root, file), "utf8").trim().split("\n").sort()).toEqual(["walkie-s77", "walkie-talkie"]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
