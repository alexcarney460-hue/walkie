import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "../core.ts";
import type { PeerClient } from "../peer-client.ts";
import { PeerCallError } from "../peer-client.ts";
import { splice, tcpEnd } from "../../pool/run/tunnel.ts";
import { AgentName } from "../../protocol/schemas.ts";
import { classifySshCaller, socketPeerPid } from "./caller.ts";
import { readProcessStartTime, readProcessTable } from "../../cli/agent-detect.ts";

export const sshBridgePath = (home: string): string => join(home, "ssh-tunnel.sock");

function machine(core: Core, name: string): string | null {
  const matches = [...core.roster.nodes.values()].filter((n) => !n.revoked && (n.node_id === name || n.hostname === name));
  return matches.length === 1 ? matches[0]!.node_id : null;
}

async function serve(core: Core, client: PeerClient, socket: Socket): Promise<void> {
  const pid = socketPeerPid(socket);
  const peerStartTime = pid ? readProcessStartTime(pid) : null;
  const processTable = peerStartTime ? readProcessTable() : null;
  let header = Buffer.alloc(0);
  const request = await new Promise<string>((resolve, reject) => {
    const onData = (part: Buffer): void => {
      header = Buffer.concat([header, part]);
      const cut = header.indexOf(10);
      if ((cut < 0 ? header.length : cut) > 512) { reject(new Error("SSH tunnel request too large")); return; }
      if (cut < 0) return;
      socket.pause();
      socket.off("data", onData);
      if (cut + 1 < header.length) socket.unshift(header.subarray(cut + 1));
      resolve(header.subarray(0, cut).toString("utf8"));
    };
    socket.on("data", onData);
    socket.once("close", () => reject(new Error("SSH tunnel caller closed")));
  });
  const parsed: unknown = request.startsWith("{") ? JSON.parse(request) : { machine: request };
  if (!parsed || typeof parsed !== "object") throw new Error("invalid SSH tunnel request");
  const { machine: name, agent } = parsed as { machine?: unknown; agent?: unknown };
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error("invalid machine name");
  if (agent !== undefined && !AgentName.safeParse(agent).success) throw new Error("invalid SSH caller agent");
  const id = machine(core, name);
  const target = id ? core.roster.nodes.get(id) : null;
  const addr = target ? client.addrVia(target, "direct") : null;
  if (!addr) throw new Error("target_outdated: machine does not serve Walkie Direct");
  let remote;
  const caller = classifySshCaller(pid, processTable, agent as string | undefined, peerStartTime);
  try { remote = await client.tunnelTo(addr, "/peer/v1/ssh", caller); }
  catch (err) { if (err instanceof PeerCallError && err.status === 404) throw new Error("target_outdated: target does not support SSH tunnels"); throw err; }
  socket.write("OK\n");
  socket.resume();
  await splice(tcpEnd(socket), remote);
}

/** Private daemon-owned Unix socket. The caller must already run as the daemon's OS user. */
export async function startSshBridge(core: Core, client: PeerClient): Promise<{ path: string; stop(): Promise<void> }> {
  const path = sshBridgePath(core.paths.home);
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error("SSH tunnel socket path is occupied");
    unlinkSync(path);
  }
  const connections = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    void serve(core, client, socket).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message.slice(0, 160) : "unknown";
      core.log.warn("ssh_bridge_failed", { reason });
      socket.end(`ERR ${reason.replace(/[\r\n]/g, " ")}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    chmodSync(path, 0o600);
  } catch (err) { server.close(); throw err; }
  return { path, stop: async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { unlinkSync(path); } catch { /* closed */ }
  } };
}
