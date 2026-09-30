import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";
import { liveMonitorPids, rig6, teardown, waitFor } from "./orchestrator-merge7-setup.ts";

const WT = new URL("../..", import.meta.url).pathname;
const CHILD = join(import.meta.dir, "orchestrator-merge7-monitor-child.ts");

test("separate monitor cleanup faults a running user and removes its socket before prepare", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-monitor-exit-"));
  const home = join(root, "walkie-talkie"); mkdirSync(home);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ result: true }) });
  let leaseLive = true;
  const faults: string[] = [];
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  const user = new TalkieOsUser(join(root, "daemon.sock"), () => false, {
    ready: () => true, privateHome: () => null, socketRoot: root,
    cleanupFile: join(root, "cleanup.sqlite"), leaseExpires: () => leaseLive ? Date.now() + 1_000 : 0,
    monitorFailure: (reason) => faults.push(reason),
    admin: async (_verb, generation) => ({ ok: true, name: "walkie-talkie", uid: 550_000, home, generation }),
    monitor: (file, run, cleanupFile) => {
      const child = Bun.spawn([process.execPath, CHILD, WT, file, run, cleanupFile, String(server.port)],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      children.push(child);
      return { kill: () => child.kill("SIGKILL"), exited: child.exited };
    },
  });
  try {
    await user.prepare();
    const socket = user.socket;
    const dir = user.leaseDirectory;
    leaseLive = false;
    await Promise.race([children[0]!.exited, Bun.sleep(5_000).then(() => { throw new Error("monitor did not exit"); })]);
    await Bun.sleep(50);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("cleaned the shell user while it was running");
    expect(user.active).toBe(false);
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    await user.prepare();
    expect(user.socket).not.toBe(socket);
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    await user.destroy().catch(() => undefined);
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("host stops after an unexpected separate-monitor cleanup", async () => {
  const r = await rig6({ destroyMs: 100 });
  try {
    await r.alex.client("").orchestratorStart({ access: "full" });
    const host = r.host();
    await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
    const file: string = host.shellUser.monitorFile;
    rmSync(file); mkdirSync(file);
    await waitFor(() => host.monitorFault, { what: "monitor fault", timeoutMs: 8_000 });
    await host.lifecycle;
    expect(host.shellUser.active).toBe(false);
    expect(host.view().state).not.toBe("working");
    expect(host.leadership.valid).toBe(false);
  } finally {
    await teardown(r);
    expect(liveMonitorPids(r)).toEqual([]);
  }
}, 20_000);
