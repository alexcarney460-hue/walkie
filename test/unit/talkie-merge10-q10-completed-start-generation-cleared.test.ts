import { tmpdir } from "node:os";
// R9 probe Q10: 969ad22 lets Start accept a cleanup the monitor verified, but it keys on `cleaningRun = this.cleaning ? this.generation : null`.
// monitorExited(code 0, verified, finishing) sets this.generation = null (os-user.ts:222) while the daemon's own cleaning promise is still
// unsettled. A Start that begins in that window captures cleaningRun = null and rethrows the daemon's rejection although the uid is verified clean.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const WT = `${import.meta.dir}/../../`;
const OUT = tmpdir();
const { TalkieOsUser } = await import(`${WT}src/daemon/orchestrator/os-user.ts`);
const { CleanupObligation } = await import(`${WT}src/daemon/orchestrator/cleanup-obligation.ts`);

test("Start after the monitor verified cleanup and cleared this.generation, while the daemon's cleaning promise rejects", async () => {
  const root = mkdtempSync(join(OUT, "tmp-q10-"));
  const home = join(root, "walkie-talkie"); mkdirSync(home);
  const cleanupFile = join(root, "cleanup.sqlite");
  let user: any = null;
  try {
    const ob = new CleanupObligation(cleanupFile);
    expect(ob.record("G1")).toBe(true);
    expect(ob.clear("G1")).toBe(true); // the separate monitor verified removal and cleared the durable obligation
    user = new TalkieOsUser(join(root, "daemon.sock"), () => false, {
      ready: () => true, privateHome: () => null, socketRoot: root, cleanupFile,
      admin: async (_verb: string, generation?: string) => ({ ok: true, name: "walkie-talkie", uid: 550_000, home, ...(generation ? { generation } : {}) }),
    });
    let reject: (e: Error) => void = () => undefined;
    const cleaning = new Promise<void>((_r, rej) => { reject = rej; });
    Object.assign(user, { generation: null /* monitorExited(verified) cleared it */, cleaningGeneration: "G1", cleaning });
    const starting = user.prepare();
    reject(new Error("WalkieTalkie uid cleanup was not verified: the helper did not answer"));
    const outcome = await starting.then(() => "started", (e: Error) => `Start FAILED: ${e.message.slice(0, 90)}`);
    console.log("Q10", JSON.stringify({ outcome, pendingCleanup: user.pendingCleanup, durableCompleted: ob.completed("G1") }));
    expect(outcome).toBe("started");
  } finally {
    if (user) { Object.assign(user, { cleaning: null }); await user.destroy().catch(() => undefined); }
    rmSync(root, { recursive: true, force: true });
  }
});
