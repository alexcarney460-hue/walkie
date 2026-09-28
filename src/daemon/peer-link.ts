// The peer API's lifecycle (v0.1.2). The listener binds to this node's Tailscale IPv4, which may not exist yet when
// launchd starts the daemon at login, and may change later. Until it binds, retry with jittered backoff (2 s growing
// to 60 s, forever); once up, re-check the address every 60 s and rebind, or disable and retry, when it moves or goes.
// A new address is re-pinned the way PROTOCOL §4 already allows: a member re-joins through the roster authority
// (which pins the source IP it observes), and the authority re-pins its own node with a `team.node`.
import type { Server } from "bun";
import type { Core } from "./core.ts";
import type { Identity } from "./identity.ts";
import { joinTeam } from "./join.ts";
import { transportFields } from "./roster.ts";
import type { Logger } from "./logger.ts";
import { PeerApi, authorityAddr, type TunnelSocketData } from "./peer-api.ts";
import type { PeerClient } from "./peer-client.ts";
import type { SyncManager } from "./sync.ts";

export interface PeerLinkOptions {
  /** First retry delay (default 2 s); doubles per failure up to retryMaxMs (default 60 s). */
  retryBaseMs?: number; retryMaxMs?: number;
  /** How often a bound listener re-checks the Tailscale address (default 60 s). */
  watchMs?: number;
  /** Jitter source (tests). */
  random?: () => number;
}

/** `/v1/diag` `peer_api`: what `walkie doctor` prints. */
export type PeerApiStatus =
  | { state: "up"; listen: string }
  | { state: "retrying"; reason: string; next_in_ms: number; attempt: number };

const NO_ADDRESS = "no Tailscale IPv4 and no WALKIE_PEER_HOST";

/** Retry delay for the n-th consecutive failure: base·2ⁿ capped at max, times a 0.8–1.2 jitter, never above max. */
export function backoffDelay(attempt: number, baseMs = 2_000, maxMs = 60_000, random: () => number = Math.random): number {
  const d = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.min(maxMs, Math.round(d * (0.8 + 0.4 * random())));
}

function hostPort(ip: string, port: number): string { return ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`; }

export interface PeerLinkDeps {
  core: Core; sync: SyncManager; client: PeerClient; identity: Identity; log: Logger;
  /** WALKIE_PEER_HOST / config peer_host / an explicit host: bind there, never follow Tailscale's address. */
  fixedHost?: string;
  port: number;
  /** A dual node's Walkie Direct side is up: sync keeps running over it while the tailnet listener is down. */
  directUp?: () => boolean;
}

export class PeerLink {
  private server: Server<TunnelSocketData> | null = null;
  private host: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private syncing = false;
  private attempt = 0;
  private nextAt = 0;
  private reason = "not started";
  private lastLoggedReason: string | null = null;
  private repinning = false;
  /** The address a re-join was accepted for (the authority may pin a different, observed one: don't loop). */
  private repinnedFor: string | null = null;
  /** The latest Tailscale identity error (meView / doctor), cleared when it answers. */
  tailscaleError: string | undefined;

  private readonly baseMs: number; private readonly maxMs: number; private readonly watchMs: number;
  private readonly random: () => number;

  constructor(private readonly d: PeerLinkDeps, opts: PeerLinkOptions = {}) {
    this.baseMs = opts.retryBaseMs ?? 2_000;
    this.maxMs = opts.retryMaxMs ?? 60_000;
    this.watchMs = opts.watchMs ?? 60_000;
    this.random = opts.random ?? Math.random;
  }

  get port(): number | null { return this.server?.port ?? null; }

  status(now = Date.now()): PeerApiStatus {
    if (this.server && this.host) return { state: "up", listen: hostPort(this.host, this.server.port ?? this.d.port) };
    return { state: "retrying", reason: this.reason, next_in_ms: Math.max(0, this.nextAt - now), attempt: this.attempt };
  }

  /** First attempt (awaited, so a healthy start is bound before `daemon_started`), then the retry/watch loop. */
  async start(): Promise<void> {
    await this.check();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.server?.stop(true);
    this.server = null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = Date.now() + ms;
    this.timer = setTimeout(() => { this.timer = null; void this.check(); }, ms);
  }

  /** One pass: read the identity, bind/rebind/disable, re-pin, schedule the next pass. Never throws. */
  private async check(): Promise<void> {
    if (this.stopped) return;
    let host: string | undefined;
    try {
      host = await this.address();
    } catch (err) {
      this.tailscaleError = (err as Error).message;
    }
    if (this.stopped) return;
    if (!host) return this.down(this.tailscaleError ?? NO_ADDRESS);
    if (!this.server || this.host !== host) {
      const err = this.bind(host);
      if (err) return this.down(err);
    }
    this.attempt = 0;
    this.lastLoggedReason = null;
    await this.repin();
    this.schedule(this.watchMs);
  }

  /** The host to bind: the fixed one, or this node's Tailscale IPv4. Also refreshes the login Tailscale reports. */
  private async address(): Promise<string | undefined> {
    const self = await this.d.identity.self();
    if ("error" in self) {
      this.tailscaleError = self.error;
      return this.d.fixedHost;
    }
    this.tailscaleError = undefined;
    if (this.d.core.login !== self.login) this.d.core.login = self.login;
    return this.d.fixedHost ?? self.ip;
  }

  /** Binds on host (closing a listener on an old address first); returns the error text on failure. */
  private bind(host: string): string | null {
    const core = this.d.core;
    const previous = this.server && this.host ? hostPort(this.host, this.server.port ?? this.d.port) : null;
    this.server?.stop(true);
    this.server = null;
    this.host = null;
    try {
      this.server = new PeerApi(core).start(host, this.d.port);
    } catch (err) {
      return `could not bind the peer API on ${hostPort(host, this.d.port)}: ${(err as Error).message}`;
    }
    this.host = host;
    core.ip = host;
    core.peerPort = this.server.port ?? this.d.port;
    const listen = hostPort(host, core.peerPort);
    if (previous) this.d.log.warn("peer_ip_changed", { from: previous, to: listen });
    this.d.log.info("peer_api_enabled", { listen, ...(previous ? { previous } : {}) });
    if (!this.syncing) {
      this.syncing = true;
      if (this.d.sync.running) this.d.sync.rosterChanged(); else this.d.sync.start();
    } else {
      this.d.sync.rosterChanged();
    }
    return null;
  }

  /** No usable address (or the bind failed): close the listener, stop sync, retry with backoff. */
  private down(reason: string): void {
    const core = this.d.core;
    if (this.server) {
      this.d.log.warn("peer_ip_changed", { from: this.host ? hostPort(this.host, this.server.port ?? this.d.port) : null, to: null });
      this.server.stop(true);
      this.server = null;
      this.host = null;
    }
    core.ip = "";
    if (this.syncing) {
      this.syncing = false;
      if (!this.d.directUp?.()) this.d.sync.stop();
    }
    this.reason = reason;
    const delay = backoffDelay(this.attempt, this.baseMs, this.maxMs, this.random);
    if (this.lastLoggedReason !== reason) {
      if (this.tailscaleError) this.d.log.warn("tailscale_unavailable", { error: this.tailscaleError });
      this.d.log.warn("peer_api_disabled", { reason, retry_in_ms: delay });
      this.lastLoggedReason = reason;
    } else {
      this.d.log.debug("peer_api_retry", { reason, attempt: this.attempt, retry_in_ms: delay });
    }
    this.attempt++;
    this.schedule(delay);
  }

  /**
   * Keeps this node's pinned `team.node` address in step with where it listens. The authority re-pins itself
   * (only for a Tailscale-derived address: a fixed host such as 0.0.0.0 is not a reachable address); a member
   * re-joins through the authority, which pins what it observes. Failures are logged and retried on the next pass.
   */
  private async repin(): Promise<void> {
    const core = this.d.core;
    if (this.repinning || !core.teamId) return;
    const mine = core.roster.nodes.get(core.nodeId);
    if (!mine || mine.revoked) return;
    const want = hostPort(core.ip, core.peerPort);
    if ((mine.ip === core.ip && mine.port === core.peerPort) || this.repinnedFor === want) return;
    this.repinning = true;
    try {
      if (core.isAuthority()) {
        if (this.d.fixedHost) return;
        core.emit("team.node", { node_id: mine.node_id, login: mine.login, hostname: mine.hostname, pubkey: mine.pubkey, ip: core.ip, port: core.peerPort, ...transportFields(mine) });
        core.log.info("node_repinned", { node: mine.node_id, ip: core.ip, port: core.peerPort, self: true });
        this.repinnedFor = want;
        return;
      }
      const authority = authorityAddr(core);
      if (!authority) {
        core.log.warn("node_repin_pending", { pinned: hostPort(mine.ip, mine.port), listen: want, reason: "no roster authority known" });
        return;
      }
      const target = hostPort(authority.ip, authority.port);
      const res = await joinTeam(core, this.d.sync, this.d.client, target);
      if (res.admitted) {
        this.repinnedFor = want;
        core.log.info("node_repin_requested", { authority: target, listen: want });
      } else {
        core.log.warn("node_repin_pending", { authority: target, listen: want, reason: res.reason ?? "not admitted" });
      }
    } catch (err) {
      const a = authorityAddr(core);
      core.log.warn("node_repin_pending", {
        pinned: hostPort(mine.ip, mine.port), listen: want, err: (err as Error).message,
        needs: `the roster authority${a ? ` (${a.hostname} at ${hostPort(a.ip, a.port)})` : ""} must be reachable to re-pin this node's new address; retrying every check, or run: walkie join ${a ? hostPort(a.ip, a.port) : "<authority>"}`,
      });
    } finally {
      this.repinning = false;
    }
  }
}
