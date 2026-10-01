import { connect } from "node:net";

export interface SshServerStatus { enabled: boolean; detail: string }

/**
 * The port Walkie's own macOS SSH service (launchd `dev.walkie.sshd`, src/daemon/ssh/macos-service.ts) listens on, on
 * 127.0.0.1 and ::1 only. It is not 22 on purpose: port 22 is Remote Login's, which Walkie neither uses, opens nor needs,
 * so the two can never meet. This is the one place the number is written; the status probe, the Direct tunnel and the
 * service's config and plist all read it from here.
 */
export const MACOS_SSH_PORT = 22022;

/** The loopback port the SSH service answers on: Walkie's own on macOS, the machine's SSH server (Walkie's, on Linux and WSL) on 22. */
export function sshServicePort(platform: NodeJS.Platform = process.platform): number {
  return platform === "darwin" ? MACOS_SSH_PORT : 22;
}

/** What the status needs from the system, injectable so a test needs no sshd. There is nothing here that can run a process. */
export interface ServerProbeDeps {
  platform: NodeJS.Platform;
  /** Connects to 127.0.0.1:port; with `wantBanner`, also reads what the server says first (an SSH server sends its banner). */
  connect(port: number, wantBanner: boolean): Promise<{ state: "connected" | "refused" | "timeout"; banner: string }>;
}

export const realServerProbe: ServerProbeDeps = {
  platform: process.platform,
  connect: (port, wantBanner) => new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let banner = "";
    socket.setTimeout(1500);
    socket.once("connect", () => {
      const done = () => { socket.destroy(); resolve({ state: "connected", banner }); };
      if (!wantBanner) { done(); return; }
      // An SSH server speaks first; give it a moment, then settle with whatever arrived.
      socket.on("data", (chunk) => { banner += chunk.toString("latin1").slice(0, 64); if (banner.includes("\n")) done(); });
      setTimeout(done, 400);
    });
    socket.once("error", () => { socket.destroy(); resolve({ state: "refused", banner: "" }); });
    socket.once("timeout", () => { socket.destroy(); resolve({ state: "timeout", banner: "" }); });
  }),
};

/**
 * Whether the SSH server owner SSH needs answers on 127.0.0.1. On macOS that is Walkie's own service (dev.walkie.sshd),
 * which must speak an SSH banner on its own port, 22022: Remote Login is never consulted, opened or needed. On Linux and
 * WSL it is the machine's SSH server (the loopback one the enrollment installs) on port 22. Fully asynchronous: nothing
 * here can block the daemon's main thread (a process spawn used to, SSH review F10).
 */
export async function sshServerStatus(port?: number, deps: ServerProbeDeps = realServerProbe): Promise<SshServerStatus> {
  const target = port ?? sshServicePort(deps.platform);
  const own = deps.platform === "darwin";
  const answer = await deps.connect(target, own);
  if (answer.state === "refused") return { enabled: false, detail: own ? `Walkie's SSH service is not running (nothing listens on 127.0.0.1:${target})` : "no SSH server on 127.0.0.1" };
  if (answer.state === "timeout") return { enabled: false, detail: own ? `Walkie's SSH service did not answer on 127.0.0.1:${target} in time` : "SSH server probe timed out" };
  if (own) {
    return answer.banner.startsWith("SSH-")
      ? { enabled: true, detail: `Walkie's SSH service answers on 127.0.0.1:${target}` }
      : { enabled: false, detail: `something that is not an SSH server answers on 127.0.0.1:${target}, so Walkie's SSH service is not running` };
  }
  return { enabled: true, detail: "SSH server responds on 127.0.0.1" };
}
