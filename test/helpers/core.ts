// A Core over a throwaway store, for unit tests that feed signed events directly.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "../../src/daemon/config.ts";
import { Core, type CoreDeps } from "../../src/daemon/core.ts";
import { FakeIdentity } from "../../src/daemon/identity.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { ensureHome, pathsFor } from "../../src/daemon/paths.ts";
import { Hub } from "../../src/daemon/sse.ts";
import { Store } from "../../src/daemon/store.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { now, type TNode } from "./events.ts";

/** `opts` may inject a license verifier (a throwaway vendor key) or another plan clock. */
export function makeCore(self: TNode, team: string, cleanups: (() => void)[], opts: Pick<CoreDeps, "licenseVerifier" | "clock" | "limits" | "boardBounds"> & Partial<Pick<CoreDeps, "identity">> = {}): Core {
  const dir = mkdtempSync("/tmp/walkie-core-");
  const paths = pathsFor(dir);
  ensureHome(paths);
  const store = new Store(join(dir, "walkie.db"));
  store.setMeta("team", team);
  const hub = new Hub(60_000, 5);
  const core = new Core({
    paths, config: ConfigSchema.parse({}), log: createLogger({}), keys: self.keys, store,
    hub, hostname: self.hostname, ip: "127.0.0.1", login: self.login, peerPort: 7458, clock: now, ...opts,
    identity: opts.identity ?? new FakeIdentity({ ip: "127.0.0.1", login: self.login, nodeName: self.hostname }, new Map()),
  });
  cleanups.push(() => { core.close(); hub.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return core;
}

/** A second Core over the same store and home, as after a daemon restart (the first one is abandoned). */
export function reopen(core: Core, self: TNode, opts: Pick<CoreDeps, "boardBounds"> = {}): Core {
  core.close();
  return new Core({
    paths: core.paths, config: core.config, log: core.log, keys: self.keys, store: core.store, identity: core.identity,
    hub: core.hub, hostname: self.hostname, ip: "127.0.0.1", login: self.login, peerPort: 7458,
    clock: core.clock, licenseVerifier: core.licenseVerifier, ...opts,
  });
}

export function feed(core: Core, events: readonly Event[]): void {
  for (const e of events) core.ingest(e, "remote");
}

/** Runs queued re-validation pages and pending drains to completion (they normally continue on later ticks). */
export async function settle(core: Core): Promise<void> {
  for (let i = 0; i < 1_000 && core.busy > 0; i++) await Bun.sleep(1);
}

export function statusOf(core: Core, id: string): string {
  const row = core.store.getRow(id);
  if (!row) return core.store.hasPending(id) ? "pending" : "absent";
  if (row.redacted === 1) return row.status === "junk" ? "junk" : "stub";
  return row.status;
}
