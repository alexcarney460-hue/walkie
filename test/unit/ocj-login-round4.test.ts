import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createSeatUser, destroySeatUser, seatUserName } from "../../src/daemon/seats/admin.ts";
import { dropClaudeProjections } from "../../src/daemon/seats/runner.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";

const command = (...args: string[]) => Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" }).exitCode;
const clean = (root: string) => {
  command("chflags", "-R", "nouchg,nouappnd", root);
  command("chmod", "-R", "-N", root);
  rmSync(root, { recursive: true, force: true });
};

for (const attack of ["uchg-file", "uchg-dir", "acl-file", "acl-dir", "root-is-file"] as const) {
  test(`projection drop clears ${attack} and destroy still sweeps`, async () => {
    const root = mkdtempSync("/tmp/walkie-ocj-r4-");
    try {
      const world = fakeSeatWorld(root, join(root, "walkie-home"));
      expect((await createSeatUser(1, world.sys)).ok).toBe(true);
      const home = join(world.homes, seatUserName(1));
      const seats = join(home, "walkie-seats");
      const config = join(seats, "run-1", "claude-config");
      mkdirSync(config, { recursive: true });
      let credential = join(config, ".credentials.json");
      writeFileSync(credential, "fake-access", { mode: 0o600 });
      if (attack === "uchg-file") expect(command("chflags", "uchg", credential)).toBe(0);
      if (attack === "uchg-dir") expect(command("chflags", "uchg", config)).toBe(0);
      if (attack === "acl-file") expect(command("chmod", "+a", `${userInfo().username} deny delete`, credential)).toBe(0);
      if (attack === "acl-dir") expect(command("chmod", "+a", `${userInfo().username} deny delete_child`, config)).toBe(0);
      if (attack === "root-is-file") {
        const hidden = join(home, "hidden");
        renameSync(seats, hidden);
        writeFileSync(seats, "replacement");
        credential = join(hidden, "run-1", "claude-config", ".credentials.json");
      }
      if (attack !== "root-is-file") expect(dropClaudeProjections(home)).toBe(true);
      const result = await destroySeatUser(1, world.sys);
      expect(result).toMatchObject({ ok: true });
      expect(world.sweeps.length).toBeGreaterThan(0);
      expect(existsSync(credential)).toBe(false);
    } finally { clean(root); }
  });
}

test("a failed projection drop still reaches the general sweep before quarantine is decided", async () => {
  const root = mkdtempSync("/tmp/walkie-ocj-r4-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie-home"));
    expect((await createSeatUser(1, world.sys)).ok).toBe(true);
    const home = join(world.homes, seatUserName(1));
    const config = join(home, "walkie-seats", "run-1", "claude-config");
    mkdirSync(config, { recursive: true });
    const credential = join(config, ".credentials.json");
    writeFileSync(credential, "fake-access");
    world.broken.add("projection");
    expect(await destroySeatUser(1, world.sys)).toMatchObject({ ok: true });
    expect(world.sweeps.length).toBeGreaterThan(0);
    expect(existsSync(credential)).toBe(false);
  } finally { clean(root); }
});

test("a failed projection drop reaches the sweep even when service cleanup fails", async () => {
  const root = mkdtempSync("/tmp/walkie-ocj-r4-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie-home"));
    expect((await createSeatUser(1, world.sys)).ok).toBe(true);
    const home = join(world.homes, seatUserName(1));
    const config = join(home, "walkie-seats", "run-1", "claude-config");
    mkdirSync(config, { recursive: true });
    const credential = join(config, ".credentials.json");
    writeFileSync(credential, "fake-access");
    world.broken.add("projection");
    world.broken.add("services");
    const result = await destroySeatUser(1, world.sys);
    expect(result.ok).toBe(false);
    expect(result.left?.join(" ")).toContain("services:");
    expect(world.sweeps.length).toBeGreaterThan(0);
    expect(existsSync(credential)).toBe(false);
    world.broken.delete("projection");
    world.broken.delete("services");
    expect((await destroySeatUser(1, world.sys)).ok).toBe(true);
  } finally { clean(root); }
});
