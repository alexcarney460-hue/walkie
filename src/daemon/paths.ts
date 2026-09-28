// File layout under WALKIE_HOME (PROTOCOL §7).
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string; key: string; token: string; db: string; blobs: string; logs: string;
  log: string; config: string; socket: string; pid: string; out: string;
}

export function defaultHome(): string {
  return process.env.WALKIE_HOME ?? join(homedir(), ".walkie");
}

export function pathsFor(home: string, socketOverride?: string): Paths {
  return {
    home,
    key: join(home, "node.key"),
    token: join(home, "local.token"),
    db: join(home, "walkie.db"),
    blobs: join(home, "blobs"),
    logs: join(home, "logs"),
    log: join(home, "logs", "daemon.log"),
    config: join(home, "config.json"),
    socket: socketOverride ?? process.env.WALKIE_SOCKET ?? join(home, "walkie.sock"),
    pid: join(home, "daemon.pid"),
    out: join(home, "logs", "daemon.out"),
  };
}

/** Creates the home tree with owner-only permissions. */
export function ensureHome(p: Paths): void {
  for (const dir of [p.home, p.blobs, p.logs]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(p.home, 0o700);
}
