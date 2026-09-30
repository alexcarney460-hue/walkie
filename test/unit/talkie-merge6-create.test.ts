import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CleanupObligation } from "../../src/daemon/orchestrator/cleanup-obligation.ts";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

for (const createAnswer of [null, { ok: true, name: "wrong-user", uid: 550_000, home: "/tmp/wrong-user" }]) {
  test(`ambiguous create ${JSON.stringify(createAnswer)} keeps a qualified cleanup obligation`, async () => {
    const dir = mkdtempSync("/tmp/walkie-create-merge6-"); roots.push(dir);
    const home = join(dir, "walkie-talkie"); mkdirSync(home);
    const cleanupFile = join(dir, "cleanup.sqlite");
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const destroys: string[] = [];
    const user = new TalkieOsUser("/not-a-socket", () => false, {
      ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile,
      admin: async (verb, generation) => {
        if (verb === "talkie-create") return createAnswer;
        if (verb === "talkie-destroy") { destroys.push(generation ?? "missing"); await held; return { ok: true }; }
        return { ok: true, name: "walkie-talkie", uid: 550_000, home };
      },
    });
    await expect(user.prepare()).rejects.toThrow("could not be created");
    const run = user.pendingCleanup?.generation;
    if (!run) throw new Error("ambiguous create did not retain its generation");
    expect(destroys).toEqual([run]);
    expect(new CleanupObligation(cleanupFile).read()?.generation).toBe(run);
    release();
    await user.destroy();
    expect(user.pendingCleanup).toBeNull();
    expect(new CleanupObligation(cleanupFile).read()).toBeNull();
  });
}

test("explicitly refused create clears the generation without a destroy", async () => {
  const dir = mkdtempSync("/tmp/walkie-create-merge6-"); roots.push(dir);
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  let destroys = 0;
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir,
    admin: async (verb) => {
      if (verb === "talkie-create") return { ok: false, code: "refused", why: "create refused before account changes" };
      if (verb === "talkie-destroy") destroys++;
      return { ok: true, name: "walkie-talkie", uid: 550_000, home };
    },
  });
  await expect(user.prepare()).rejects.toThrow("create refused before account changes");
  expect(user.pendingCleanup).toBeNull();
  expect(destroys).toBe(0);
});
