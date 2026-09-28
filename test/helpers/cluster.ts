// In-process multi-daemon cluster for integration tests (usable by every lane).
// Each node gets its own WALKIE_HOME under a short /tmp dir (unix socket paths are
// limited to ~104 bytes on macOS), a random peer port on 127.0.0.1 and a
// FakeIdentity that maps the caller's X-Walkie-Node header to its login.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { FakeIdentity, type Identity, type WhoisResult } from "../../src/daemon/identity.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/main.ts";
import { DEFAULT_LIMITS, type RateLimits } from "../../src/daemon/ratelimit.ts";
import type { DiscoveryOptions } from "../../src/daemon/discovery.ts";
import type { OrchestratorOptions } from "../../src/daemon/orchestrator/host.ts";
import type { SeatsOptions } from "../../src/daemon/seats/host.ts";
import type { SamplerOptions } from "../../src/daemon/machine-stats/sampler.ts";
import type { AccountsOptions } from "../../src/accounts/service.ts";
import type { PeerLinkOptions } from "../../src/daemon/peer-link.ts";
import type { PoolOptions } from "../../src/pool/run/service.ts";
import type { SyncOptions } from "../../src/daemon/sync.ts";
import type { ManagerOptions } from "../../src/integrations/manager.ts";
import type { LicenseVerifier } from "../../src/license/format.ts";
import type { MobileOptions } from "../../src/daemon/mobile/manager.ts";
import type { ServiceOptions } from "../../src/license/service.ts";

// Every test node shares the 127.0.0.1 source IP, so the per-peer-IP bucket is widened.
export const TEST_LIMITS: RateLimits = {
  ...DEFAULT_LIMITS, humanWrite: { capacity: 100_000, perSecond: 10_000 }, peer: { capacity: 100_000, perSecond: 10_000 },
};
export const TEST_SYNC: SyncOptions = { intervalMs: 1_000, livenessMs: 3_000, pushTimeoutMs: 1_000 };

export interface NodeSpec {
  name: string; login: string; hostname?: string; limits?: RateLimits; sync?: SyncOptions;
  localPort?: number | false; autoAdmit?: boolean;
  /** Connector options (fake HTTP layer, manual runs). */
  integrations?: ManagerOptions;
  /** Linear import options (a fast schedule tick). */
  linearImport?: { url?: string; tickMs?: number };
  /** Verify licenses against a throwaway vendor key (test/helpers/license.ts). */
  licenseVerifier?: LicenseVerifier;
  /** The license service's fetch (e.g. the site's handlers in-process, test/integration/license-e2e.test.ts). */
  licenseService?: ServiceOptions;
  /** The node clock (plan decisions, event timestamps); default Date.now. */
  clock?: () => number;
  /** Wraps the node's FakeIdentity (e.g. a Tailscale that isn't up yet); default the FakeIdentity itself. */
  identity?: (fake: FakeIdentity) => Identity;
  /** AGENT-ADMIN-1: post the one-time upgrade notice at start (default off in tests). */
  adminNotice?: boolean;
  /** Peer API host; null derives it from the identity like production (default "127.0.0.1"). */
  peerHost?: string | null;
  /** Peer API retry/watch timings (src/daemon/peer-link.ts). */
  peerLink?: PeerLinkOptions;
  /** Agent discovery with an injected process list; default off (tests never report this machine's processes). */
  discovery?: DiscoveryOptions | false;
  /** Machine stats with injected readings; default off (tests never report this machine's memory or sensors). */
  machineStats?: SamplerOptions | false;
  /** Provider accounts with injected files/fetch; default off (tests never read this machine's logins). */
  accounts?: AccountsOptions | false;
  /** Walkie on your phone: a local relay (default: the production URL, never contacted unless a test pairs). */
  mobile?: MobileOptions;
  /**
   * Walkie Direct node: no Tailscale at all (its identity has none, no tailnet listener), an iroh endpoint on
   * loopback with no relays, found through the cluster's shared address book.
   */
  direct?: boolean;
  /**
   * A Tailscale node (fake identity, tailnet listener) that can also run Walkie Direct (mixed teams): the same
   * loopback iroh options as a Direct node, used once `walkie direct enable` (or config `direct`) turns it on.
   */
  dual?: boolean;
  /** WALKIE-POOL-2 split runs: runtime directory, extra llama.cpp arguments, stage lease. */
  pool?: PoolOptions;
  /** Orchestrator supervisor options (a fake claude on the child's PATH, fast restarts). */
  orchestrator?: OrchestratorOptions;
  /** Remote seats options (a fake claude/codex on the seats' PATH, fast flushes). */
  seats?: SeatsOptions;
  /** Serve this dashboard build on the loopback port (scripts/orchestrator-demo.ts); default none. */
  webDir?: string;
}

/** A machine without Tailscale (Walkie Direct nodes). */
export class NoTailscale implements Identity {
  readonly kind = "fake" as const;
  async whois(): Promise<WhoisResult | null> { return null; }
  async self(): Promise<{ error: string }> { return { error: "tailscale CLI not found (install Tailscale or add it to PATH)" }; }
}

export class TestNode {
  daemon: DaemonHandle | null = null;
  constructor(
    readonly cluster: Cluster, readonly spec: NodeSpec, readonly home: string, public peerPort: number,
  ) {}

  get d(): DaemonHandle {
    if (!this.daemon) throw new Error(`${this.spec.name} is stopped`);
    return this.daemon;
  }
  get socket(): string { return join(this.home, "walkie.sock"); }
  get hostname(): string { return this.spec.hostname ?? `${this.spec.name}-mbp`; }
  /** "127.0.0.1:<port>" for `walkie join`. */
  get peerAddr(): string { return `127.0.0.1:${this.peerPort}`; }
  client(agent?: string): WalkieClient { return new WalkieClient({ socket: this.socket, agent, timeoutMs: 15_000 }); }

  async start(): Promise<this> {
    if (this.spec.autoAdmit === false && !existsSync(join(this.home, "config.json"))) {
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.home, "config.json"), JSON.stringify({ auto_admit: false }));
    }
    const fake = new FakeIdentity(
      { ip: "127.0.0.1", login: this.spec.login, nodeName: this.hostname }, this.cluster.identities,
    );
    const direct = this.spec.direct === true;
    const identity = direct ? new NoTailscale() : this.spec.identity ? this.spec.identity(fake) : fake;
    const peerHost = direct ? null : this.spec.peerHost === undefined ? "127.0.0.1" : this.spec.peerHost;
    this.daemon = await startDaemon({
      home: this.home, socket: this.socket, identity, ...(peerHost !== null ? { peerHost } : {}), peerPort: this.peerPort,
      localPort: this.spec.localPort ?? 0, hostname: this.hostname, sync: this.spec.sync ?? TEST_SYNC,
      limits: this.spec.limits ?? TEST_LIMITS, webDir: this.spec.webDir ?? join(this.home, "no-web"), env: false, heartbeatMs: 15_000,
      integrations: this.spec.integrations ?? { autoRun: false },
      licenseRenew: false, adminNotice: this.spec.adminNotice ?? false, discovery: this.spec.discovery ?? false, machineStats: this.spec.machineStats ?? false, accounts: this.spec.accounts ?? false, ...(this.spec.peerLink ? { peerLink: this.spec.peerLink } : {}),
      ...(this.spec.orchestrator ? { orchestrator: this.spec.orchestrator } : {}),
      ...(this.spec.seats ? { seats: this.spec.seats } : {}),
      ...(this.spec.licenseVerifier ? { licenseVerifier: this.spec.licenseVerifier } : {}),
      ...(this.spec.clock ? { clock: this.spec.clock } : {}),
      ...(this.spec.mobile ? { mobile: this.spec.mobile } : {}),
      licenseService: this.spec.licenseService ?? { fetch: async () => { throw new Error("no license service in tests"); } },
      ...(direct ? { direct: { preset: "minimal" as const, bindAddr: "127.0.0.1:0", addressBook: this.cluster.addressBook }, peerLink: { retryBaseMs: 60_000, retryMaxMs: 60_000 } } : {}),
      ...(this.spec.dual ? { direct: { preset: "minimal" as const, bindAddr: "127.0.0.1:0", addressBook: this.cluster.addressBook } } : {}),
      ...(this.spec.pool ? { pool: this.spec.pool } : {}),
      ...(this.spec.linearImport ? { linearImport: this.spec.linearImport } : {}),
    });
    this.peerPort = this.daemon.peerPort ?? this.peerPort;
    if (!direct) this.cluster.identities.set(this.daemon.nodeId, { login: this.spec.login, nodeName: this.hostname });
    return this;
  }

  async stop(): Promise<void> {
    await this.daemon?.stop();
    this.daemon = null;
  }

  async restart(): Promise<this> {
    await this.stop();
    return this.start();
  }
}

export class Cluster {
  /** node id -> tailnet identity, shared by every node's FakeIdentity. */
  readonly identities = new Map<string, WhoisResult>();
  /** Walkie Direct: endpoint id (hex) → loopback socket addresses, filled by each Direct node as it binds. */
  readonly addressBook = new Map<string, string[]>();
  readonly root = mkdtempSync("/tmp/walkie-");
  readonly nodes: TestNode[] = [];

  async add(spec: NodeSpec): Promise<TestNode> {
    const node = new TestNode(this, spec, join(this.root, spec.name), 0);
    this.nodes.push(node);
    return node.start();
  }

  async close(): Promise<void> {
    for (const n of this.nodes) await n.stop().catch(() => undefined);
    rmSync(this.root, { recursive: true, force: true });
  }
}

export async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<NonNullable<T>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.what ?? "condition"}${last ? `: ${(last as Error).message}` : ""}`);
    await Bun.sleep(opts.intervalMs ?? 20);
  }
}

/** alex (owner) + kira (member) + kira's second machine, joined and synced. */
export async function standardTeam(c: Cluster): Promise<{ alex: TestNode; kira: TestNode; kira2: TestNode }> {
  const alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  const kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp" });
  const kira2 = await c.add({ name: "kira2", login: "kira@example.com", hostname: "kiras-studio" });
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "member");
  const j1 = await kira.client().join(alex.peerAddr);
  if (!j1.admitted) throw new Error(`kira join failed: ${j1.reason}`);
  const j2 = await kira2.client().join(kira.peerAddr); // via a member node → redirected to the owner
  if (!j2.admitted) throw new Error(`kira2 join failed: ${j2.reason}`);
  return { alex, kira, kira2 };
}
