import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync("/tmp/walkie-prepare-merge6-"); roots.push(path); return path; };
const within = async (work: Promise<unknown>) => Promise.race([
  work.then(() => "resolved", () => "rejected"), Bun.sleep(500).then(() => "timed out"),
]);

test("prepare waiting on an earlier destroy ends its wait on Stop while cleanup continues", async () => {
  const dir = root();
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let destroying = false;
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir,
    admin: async (verb) => {
      if (verb === "talkie-destroy") { destroying = true; await held; }
      return { ok: true, name: "walkie-talkie", uid: 550_000, home };
    },
  });
  await user.prepare();
  const cleanup = user.destroy();
  expect(destroying).toBe(true);
  const controller = new AbortController();
  const preparing = user.prepare(controller.signal);
  controller.abort();
  expect(await within(preparing)).toBe("rejected");
  expect(user.pendingCleanup).not.toBeNull();
  release();
  await cleanup;
  expect(user.pendingCleanup).toBeNull();
});

test("failed post-create setup does not hold Stop behind a slow destroy", async () => {
  const dir = root();
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let destroying = false;
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: join(dir, "missing-parent"), cleanupFile: join(dir, "cleanup.sqlite"),
    admin: async (verb) => {
      if (verb === "talkie-destroy") { destroying = true; await held; }
      return { ok: true, name: "walkie-talkie", uid: 550_000, home };
    },
  });
  const controller = new AbortController();
  const preparing = user.prepare(controller.signal);
  for (let i = 0; i < 100 && !destroying; i++) await Bun.sleep(2);
  expect(destroying).toBe(true);
  controller.abort();
  expect(await within(preparing)).toBe("rejected");
  expect(user.pendingCleanup).not.toBeNull();
  release();
  await user.destroy();
  expect(user.pendingCleanup).toBeNull();
});
