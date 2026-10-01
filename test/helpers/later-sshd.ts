// "Port 22" for a test of an SSH server that starts LATER: a loopback port nothing listens on until `start()` runs, then a stock
// OpenSSH banner (an SSH server that is not Walkie's). `read` is what GET /v1/ssh/status says about it on Linux, through the daemon's
// own probe, so a flow that reads it before and after `start()` sees a real listener appear (22 itself is privileged here).
import type { SshStatus } from "../../src/cli/commands/doctor.ts";
import { realServerProbe, sshServerStatus } from "../../src/daemon/ssh/server.ts";

export interface LaterSshd {
  read(): Promise<SshStatus>;
  /** The stock sshd starts answering (once). */
  start(): void;
  stop(): void;
}

/** `base` is the rest of the status (grant, key, gate) the reads carry; only `server` comes from the port. */
export function laterSshd(base: SshStatus): LaterSshd {
  const reserved = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() {}, data() {}, close() {}, error() {} } });
  const port = reserved.port;
  reserved.stop(true);
  let server: { stop(force?: boolean): void } | null = null;
  return {
    read: async () => ({ ...base, server: await sshServerStatus(port, { ...realServerProbe, platform: "linux" }) }),
    start: () => {
      server ??= Bun.listen({ hostname: "127.0.0.1", port, socket: { open(sock) { sock.write("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n"); }, data() {}, close() {}, error() {} } });
    },
    stop: () => { server?.stop(true); server = null; },
  };
}
