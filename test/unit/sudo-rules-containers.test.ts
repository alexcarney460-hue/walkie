// Opt-in (WALKIE_SUDO_CONTAINERS=1, with docker and bun on this host): test/sudo-rules-containers.sh writes the seat users' sudo
// rules with this repo's own code and runs them through the real sudo of throwaway Ubuntu containers (24.04 sudo, 25.10 and 26.04
// sudo-rs). Skipped otherwise, so the normal suite never starts a container.
import { expect, test } from "bun:test";
import { join } from "node:path";

function dockerAvailable(): boolean {
  try { return Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0; } catch { return false; }
}

const enabled = process.env.WALKIE_SUDO_CONTAINERS === "1" && dockerAvailable();

test.skipIf(!enabled)("the seat users' sudo rules work through the real sudo of each container image", () => {
  const r = Bun.spawnSync(["bash", join(import.meta.dir, "..", "sudo-rules-containers.sh"), "rules"], { stdout: "pipe", stderr: "pipe" });
  const text = `${r.stdout.toString()}${r.stderr.toString()}`;
  console.log(text);
  expect(text).not.toContain("FAIL:");
  expect(r.exitCode).toBe(0);
}, 900_000);
