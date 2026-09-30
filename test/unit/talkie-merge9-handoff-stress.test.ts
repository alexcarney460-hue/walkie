import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CleanupObligation } from "../../src/daemon/orchestrator/cleanup-obligation.ts";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";
import { waitFor } from "./orchestrator-merge7-setup.ts";

const WT = new URL("../..", import.meta.url).pathname;
const CHILD = join(import.meta.dir, "orchestrator-merge7-monitor-child.ts");

test("separate-process handoffs clear the obligation across helper outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-handoff-stress-"));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ result: true }) });
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  const faults: string[] = [];
  try {
    for (const [index, fail, destroyMs, flipMs] of [
      [0, true, 200, 0], [1, false, 500, 100], [2, true, 500, 300], [3, false, 200, 50],
    ] as const) {
      const dir = join(root, String(index));
      const home = join(dir, "walkie-talkie");
      mkdirSync(home, { recursive: true });
      const cleanupFile = join(dir, "cleanup.sqlite");
      let leaseLive = true;
      const user = new TalkieOsUser(join(dir, "daemon.sock"), () => false, {
        ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile,
        leaseExpires: () => leaseLive ? Date.now() + 1_000 : 0,
        monitorFailure: (reason) => faults.push(`${index}: ${reason}`),
        retrySleep: () => new Promise<void>(() => undefined),
        monitor: (file, run, state) => {
          const child = Bun.spawn([process.execPath, CHILD, WT, file, run, state, String(server.port)],
            { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
          children.push(child);
          return { kill: () => child.kill("SIGKILL"), exited: child.exited };
        },
        admin: async (verb, generation) => {
          if (verb === "talkie-destroy") {
            await Bun.sleep(destroyMs);
            return fail ? { ok: false, why: "helper could not verify removal" } : { ok: true };
          }
          return { ok: true, name: "walkie-talkie", uid: 550_000, home, generation };
        },
      });
      await user.prepare();
      const run = (user as any).generation as string;
      await Bun.sleep(300);
      const flip = setTimeout(() => { leaseLive = false; }, flipMs);
      try {
        if (fail) await expect(user.destroy()).rejects.toThrow("not verified");
        else await user.destroy();
        await waitFor(() => new CleanupObligation(cleanupFile).completed(run),
          { what: `cycle ${index} cleanup`, timeoutMs: 8_000 });
        expect(user.pendingCleanup).toBeNull();
      } finally { clearTimeout(flip); }
    }
    expect(faults).toEqual([]);
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
    for (const child of children) expect(() => process.kill(child.pid, 0)).toThrow();
  }
}, 30_000);
