import { tmpdir } from "node:os";
// X7 (Codex HIGH follow-up): the real helper's createTalkieUser returns { ok: false, code: "failed", why: "could not
// create walkie-talkie: <err>; cleanup: <why>" } when a create failed AFTER it made OS changes and its own rollback
// ALSO failed (src/daemon/seats/talkie-user.ts:67-68). os-user.ts:277 treats every ok === false as "nothing to clean":
// the generation is dropped, no obligation is recorded and no retry is armed.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const WT = new URL("../..", import.meta.url).pathname;
const { TalkieOsUser } = await import(`${WT}/src/daemon/orchestrator/os-user.ts`);
const { CleanupObligation } = await import(`${WT}/src/daemon/orchestrator/cleanup-obligation.ts`);
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

test("create failed and its rollback failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-x7-")); roots.push(dir);
  const home = join(dir, "walkie-talkie"); mkdirSync(home);
  const cleanupFile = join(dir, "cleanup.sqlite");
  const calls: string[] = [];
  const retry = new Promise<void>(() => undefined);
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile, retrySleep: async () => { calls.push("retry-timer"); await retry; },
    admin: async (verb: string, generation?: string) => {
      calls.push(`${verb}${generation ? `(${generation.slice(0, 8)})` : ""}`);
      if (verb === "talkie-create") return { ok: false, code: "failed", why: "could not create walkie-talkie: dscl . -create failed; cleanup: 1 process of it survived SIGKILL for 5 s" };
      if (verb === "talkie-destroy") return { ok: false, code: "failed", why: "1 process of it survived SIGKILL for 5 s" };
      return { ok: true, name: "walkie-talkie", uid: 550_000, home };
    },
  });
  const err = await user.prepare().then(() => null, (e: Error) => e.message);
  await Bun.sleep(100);
  const out = { err, pending: user.pendingCleanup, durable: new CleanupObligation(cleanupFile).read(), generation: (user as any).generation, calls };
  expect(out.pending).not.toBeNull();
  expect(out.durable?.generation).toBe(out.generation);
  expect(calls.some((call) => call.startsWith("talkie-destroy("))).toBe(true);
});
