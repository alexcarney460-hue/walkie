import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";

const WT = new URL("../..", import.meta.url).pathname;

test("repeated failed daemon cleanup hands off without monitor exit 3", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-merge8-loop-"));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ result: true }) });
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  const users: TalkieOsUser[] = [];
  const codes: number[] = [];
  const faults: string[] = [];
  try {
    for (let cycle = 0; cycle < 20; cycle++) {
      const dir = join(root, String(cycle));
      mkdirSync(join(dir, "walkie-talkie"), { recursive: true });
      let leaseLive = true;
      let exit: Promise<number> = Promise.resolve(-1);
      const user = new TalkieOsUser(join(dir, "daemon.sock"), () => false, {
        ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile: join(dir, "cleanup.sqlite"),
        leaseExpires: () => leaseLive ? Date.now() + 1_000 : 0,
        monitorFailure: (reason) => faults.push(reason),
        retrySleep: () => new Promise<void>(() => undefined),
        monitor: (file, run, cleanupFile) => {
          const proc = Bun.spawn([process.execPath, join(import.meta.dir, "orchestrator-merge7-monitor-child.ts"),
            WT, file, run, cleanupFile, String(server.port)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
          children.push(proc);
          exit = proc.exited;
          return { kill: () => proc.kill("SIGKILL"), exited: proc.exited };
        },
        admin: async (verb, generation) => {
          if (verb === "talkie-destroy") { await Bun.sleep(700); return { ok: false, why: "helper failed" }; }
          return { ok: true, name: "walkie-talkie", uid: 550_000, home: join(dir, "walkie-talkie"),
            ...(generation ? { generation } : {}) };
        },
      });
      users.push(user);
      await user.prepare();
      await Bun.sleep(400);
      const cleanup = user.destroy().catch(() => undefined);
      await Bun.sleep(150);
      leaseLive = false;
      await cleanup;
      const code = await Promise.race([exit, Bun.sleep(5_000).then(() => -1)]);
      codes.push(code);
      expect(code).toBe(0);
    }
    expect(faults).toEqual([]);
  } finally {
    for (const user of users) Object.assign(user, { monitorRestarts: 3, monitorFile: null });
    for (const proc of children) proc.kill("SIGKILL");
    await Promise.all(children.map((proc) => proc.exited));
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
    expect(children.every((proc) => { try { process.kill(proc.pid, 0); return false; } catch { return true; } })).toBe(true);
  }
  expect(codes).toHaveLength(20);
}, 90_000);
