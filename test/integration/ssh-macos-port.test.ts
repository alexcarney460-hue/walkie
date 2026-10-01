// WALK-67 lane 8, round 2: the Direct tunnel's target. On macOS the daemon dials Walkie's own SSH service on 127.0.0.1:22022
// (dev.walkie.sshd), never port 22 (Remote Login's); on Linux and WSL it still dials the machine's SSH server on 22. A real
// daemon in a Cluster, a real grant and gate, and a loopback listener standing in for the service: the platform is the only
// thing changed, for the one call that picks the port.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { Cluster, waitFor } from "../helpers/cluster.ts";
import { consentSsh, echoServer, isolatedTeam } from "../helpers/ssh-team.ts";
import { MACOS_SSH_PORT } from "../../src/daemon/ssh/server.ts";
import { sshTunnelGrant } from "../../src/daemon/ssh/tunnel.ts";

setDefaultTimeout(60_000);
let sshd: Awaited<ReturnType<typeof echoServer>>;
beforeAll(async () => { sshd = await echoServer(); });
afterAll(async () => { await sshd?.close(); });

/** A loopback listener on the macOS service's port that counts the connections it gets; null when something already owns the port. */
async function standIn(): Promise<{ connections: () => number; close: () => Promise<void> } | null> {
  let count = 0;
  const server: Server = createServer((socket) => { count++; socket.on("data", (b) => socket.write(b)); socket.on("error", () => undefined); });
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(MACOS_SSH_PORT, "127.0.0.1", () => resolve(true));
  });
  if (!listening) return null;
  return { connections: () => count, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The port is chosen when sshTunnelGrant is CALLED, so the platform only has to read as `platform` for that call. */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try { return fn(); } finally { Object.defineProperty(process, "platform", original); }
}

function liveEnd() {
  let finish = (): void => undefined;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  return { end: { read: () => done.then(() => null), write: async () => undefined, close: finish, done }, finish };
}

async function dial(platform: NodeJS.Platform): Promise<() => void> {
  const isolated = new Cluster();
  const team = await isolatedTeam(isolated, `ssh-port-${platform}`, sshd.port);
  await consentSsh(team);
  await waitFor(() => team.worker.d.sync.sshTeamConfirmed(), { what: "baseline confirmation" });
  const { end, finish } = liveEnd();
  // No explicit port: the default the daemon uses when nothing overrides it.
  const grant = withPlatform(platform, () => sshTunnelGrant(team.worker.d.core, team.lead.d.nodeId, undefined, team.home, { caller: "person" }));
  void grant.accept(end as never).catch(() => undefined);
  await Bun.sleep(500);
  return () => { finish(); void isolated.close(); };
}

test("on macOS the tunnel dials Walkie's own service on 22022", async () => {
  const service = await standIn();
  if (!service) { console.warn(`port ${MACOS_SSH_PORT} is in use on this machine: skipped`); return; }
  let release = (): void => undefined;
  try {
    release = await dial("darwin");
    expect(service.connections()).toBe(1);
  } finally { release(); await service.close(); }
});

test("on Linux the tunnel does not touch 22022: it dials port 22", async () => {
  const service = await standIn();
  if (!service) { console.warn(`port ${MACOS_SSH_PORT} is in use on this machine: skipped`); return; }
  let release = (): void => undefined;
  try {
    release = await dial("linux");
    expect(service.connections()).toBe(0);
  } finally { release(); await service.close(); }
});
