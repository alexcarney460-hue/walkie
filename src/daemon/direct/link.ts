// Which transport this daemon runs, and the Walkie Direct endpoint's lifecycle.
//
// The mode is config.json `transport` when set, else what this node's own `team.node` says (a Direct-only node's
// record lists just "direct"; a v0.1 record means Tailscale), else undecided until `walkie init` / `walkie join`
// picks one. A Direct-only daemon never opens the tailnet listener. A Tailscale daemon loads iroh only when it is
// DUAL (PROTOCOL §4 "Mixed teams"): config.json `"direct": true` (`walkie direct enable`), or its record already
// serves both. A dual node keeps its tailnet listener and also serves the peer API over Direct, so machines that
// joined with an invite code (Direct-only) can reach it; the roster authority of a team with such machines is dual.
import type { TransportKind } from "../../protocol/schemas.ts";
import type { Config } from "../config.ts";
import type { Core } from "../core.ts";
import type { Logger } from "../logger.ts";
import type { PeerApi } from "../peer-api.ts";
import type { PeerClient } from "../peer-client.ts";
import { backoffDelay } from "../peer-link.ts";
import { directMemberByKey, servesDirect, transportsOf, withTransport } from "../roster.ts";
import type { SyncManager } from "../sync.ts";
import { DirectNet, type DirectDeps, type DirectOptions } from "./net.ts";

/**
 * config.transport, else this node's own roster record, else null (no team yet). A record serving both is a
 * Tailscale node that also runs Direct (dual): its mode is "tailscale".
 */
export function resolveMode(core: Core, config: Pick<Config, "transport">): TransportKind | null {
  if (config.transport) return config.transport;
  const mine = core.roster.nodes.get(core.nodeId);
  if (mine) return transportsOf(mine).includes("tailscale") ? "tailscale" : "direct";
  return null;
}

/** Whether a Tailscale (or undecided) node should also run Walkie Direct: config `direct`, or its record serves it. */
export function wantsDual(core: Core, config: Pick<Config, "transport" | "direct">): boolean {
  if (resolveMode(core, config) === "direct") return false;
  const mine = core.roster.nodes.get(core.nodeId);
  return config.direct === true || (!!mine && servesDirect(mine));
}

export interface DirectLinkDeps {
  core: Core; sync: SyncManager; client: PeerClient; api: PeerApi; log: Logger; options: DirectOptions;
  /** Stops the Tailscale listener when this daemon switches to Direct (undecided → direct at init/join). */
  stopTailscale: () => void;
  /** Binds the endpoint (tests inject failures); default DirectNet.start. */
  startNet?: (deps: DirectDeps, options: DirectOptions) => Promise<DirectNet>;
}

export interface DirectRetryOptions {
  /** First retry delay (default 2 s); doubles per failure up to retryMaxMs (default 60 s), with PeerLink's jitter. */
  retryBaseMs?: number; retryMaxMs?: number;
  /** Jitter source (tests). */
  random?: () => number;
}

export interface TransportControl {
  mode(): TransportKind | null;
  /** The transports this daemon serves now (a dual node: both). */
  serving(): TransportKind[];
  /**
   * Mixed teams: runs Walkie Direct alongside Tailscale on this node (`walkie direct enable`) and has the roster
   * record say so. Resolves once the endpoint is up; `advertised` says whether the record already serves Direct.
   */
  enableDual(): Promise<{ advertised: boolean; reason?: string }>;
  /** Starts Walkie Direct (idempotent) and makes it this daemon's transport. */
  enableDirect(): Promise<DirectNet>;
  /** The running endpoint (null when Direct isn't running). */
  direct(): { endpoint: string; relay: string | null } | null;
  /** The running endpoint's home relay, waiting up to `ms` for it (for an invite's hint). */
  relayHint(ms: number): Promise<string | null>;
}

/** A failed attempt to add "direct" to this node's record is retried at most this often (roster changes, ticks). */
const ADVERTISE_RETRY_MS = 30_000;

export class DirectLink implements TransportControl {
  private net: DirectNet | null = null;
  private starting: Promise<DirectNet> | null = null;
  private chosen: TransportKind | null;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** Direct runs alongside Tailscale (the tailnet listener stays up). */
  private dual: boolean;
  private advertising: Promise<{ advertised: boolean; reason?: string }> | null = null;
  private lastAdvertise = 0;
  private lastAdvertiseReason: string | null = null;
  private advertiseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly d: DirectLinkDeps, private readonly config: Pick<Config, "transport" | "direct">, private readonly retry: DirectRetryOptions = {},
  ) {
    this.chosen = resolveMode(d.core, config);
    this.dual = wantsDual(d.core, config);
  }

  /** Whether this daemon should run Direct at startup (a Direct-only team, or a dual node). */
  wantsDirect(): boolean {
    return this.dual || this.mode() === "direct";
  }

  /**
   * Boot on a Direct team: start the endpoint, and if that fails (no UDP socket yet, a native error), keep
   * retrying with jittered backoff (2 s growing to 60 s, forever) like the Tailscale peer link, instead of
   * leaving the node unreachable until a restart. The first attempt is awaited.
   */
  async startWithRetry(): Promise<void> {
    if (this.stopped || this.net) return;
    try {
      await (this.dual ? this.startDual() : this.enableDirect());
      if (this.attempt > 0) this.d.log.info("direct_started", { after_attempts: this.attempt + 1 });
      this.attempt = 0;
    } catch (err) {
      if (this.stopped) return;
      const next = backoffDelay(this.attempt, this.retry.retryBaseMs, this.retry.retryMaxMs, this.retry.random);
      this.attempt++;
      this.d.log.error("direct_start_failed", { err: (err as Error).message, attempt: this.attempt, next_in_ms: next });
      this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.startWithRetry(); }, next);
    }
  }

  /** The roster changed: connections of keys no longer admitted are closed (net.ts); a dual node re-checks its record. */
  rosterChanged(): void {
    this.net?.rosterChanged();
    // The authority's own re-pin is local (no throttle); another node's is a call to the authority.
    if (this.dual && this.net) void this.advertise(this.d.core.isAuthority());
  }

  mode(): TransportKind | null {
    if (this.net && !this.dual) return "direct";
    return this.chosen ?? resolveMode(this.d.core, this.config);
  }

  serving(): TransportKind[] {
    if (this.net && !this.dual) return ["direct"];
    const out: TransportKind[] = this.mode() === "direct" ? [] : ["tailscale"];
    return this.net ? [...out, "direct"] : out;
  }

  async enableDual(): Promise<{ advertised: boolean; reason?: string }> {
    if (this.mode() === "direct") return { advertised: true };
    this.dual = true;
    await this.startDual();
    return this.advertise(true);
  }

  private async startDual(): Promise<DirectNet> {
    const net = await this.start();
    void this.advertise();
    return net;
  }

  /**
   * Makes this node's `team.node` say it serves Direct (dual). The authority re-pins itself; any other node dials
   * the authority over Direct and `/join`s with its own key, which proves it holds it (peer-api.ts addDirect).
   * Needs a Direct-serving authority; until then it is retried on roster changes.
   */
  private advertise(force = false): Promise<{ advertised: boolean; reason?: string }> {
    if (!force && Date.now() - this.lastAdvertise < ADVERTISE_RETRY_MS) return Promise.resolve({ advertised: false, reason: "retrying" });
    this.advertising ??= this.advertiseOnce().then((res) => {
      if (!res.advertised && res.reason !== this.lastAdvertiseReason) this.d.log.warn("direct_advertise_pending", { reason: res.reason });
      this.lastAdvertiseReason = res.advertised ? null : res.reason ?? null;
      // Not on the record yet (the authority isn't reachable or doesn't serve Direct): try again later on its own.
      if (!res.advertised && !this.stopped && !this.advertiseTimer) {
        this.advertiseTimer = setTimeout(() => { this.advertiseTimer = null; if (this.dual && this.net) void this.advertise(true); }, ADVERTISE_RETRY_MS);
        (this.advertiseTimer as { unref?: () => void }).unref?.();
      }
      return res;
    }).finally(() => { this.advertising = null; this.lastAdvertise = Date.now(); });
    return this.advertising;
  }

  private async advertiseOnce(): Promise<{ advertised: boolean; reason?: string }> {
    try {
      return await this.tryAdvertise();
    } catch (err) {
      return { advertised: false, reason: (err as Error).message.slice(0, 160) };
    }
  }

  private async tryAdvertise(): Promise<{ advertised: boolean; reason?: string }> {
    const { core, client } = this.d;
    const mine = core.roster.nodes.get(core.nodeId);
    if (!mine || mine.revoked || !core.me()) return { advertised: false, reason: "not_admitted" };
    if (servesDirect(mine)) return { advertised: true };
    if (!this.net) return { advertised: false, reason: "direct_not_running" };
    if (core.isAuthority()) {
      core.emit("team.node", {
        node_id: mine.node_id, login: mine.login, hostname: mine.hostname, pubkey: mine.pubkey, ip: mine.ip, port: mine.port,
        endpoint: this.net.endpoint, transports: withTransport(mine, "direct"),
      });
      core.log.info("node_direct_enabled", { node: mine.node_id, self: true });
      return { advertised: true };
    }
    const a = core.authority ? core.roster.nodes.get(core.authority) : undefined;
    if (!a || !servesDirect(a)) return { advertised: false, reason: "authority_not_direct" };
    const addr = { ip: "", port: a.port, pubkey: a.pubkey };
    const res = await client.join(addr, { pubkey: core.keys.pubkey, hostname: core.hostname, ip: core.ip, port: core.peerPort });
    if (!res.admitted) return { advertised: false, reason: res.reason ?? "not_admitted" };
    // The authority pushes the new record too; pull its origin now so this node sees it at once.
    const vv = await client.vv(addr);
    await this.d.sync.catchUp(addr, a.node_id, vv.vv[a.node_id] ?? 0, a.node_id);
    core.drainPending();
    const now = core.roster.nodes.get(core.nodeId);
    return now && servesDirect(now) ? { advertised: true } : { advertised: false, reason: "record_not_synced" };
  }

  direct(): { endpoint: string; relay: string | null } | null {
    return this.net ? { endpoint: this.net.endpoint, relay: this.net.relayUrl() } : null;
  }

  async relayHint(ms: number): Promise<string | null> {
    return this.net ? this.net.online(ms) : null;
  }

  /** Makes Walkie Direct this daemon's only transport (init/join of a Direct team): the tailnet listener stops. */
  async enableDirect(): Promise<DirectNet> {
    if (this.chosen === "tailscale" && this.config.transport === "tailscale") {
      throw new Error("config.json sets transport to tailscale");
    }
    const net = await this.start();
    if (this.dual) {
      this.dual = false; // an undecided dual node founding or joining a Direct team
      this.chosen = "direct";
      this.d.stopTailscale();
      this.d.core.ip = "";
    }
    return net;
  }

  private start(): Promise<DirectNet> {
    if (this.net) return Promise.resolve(this.net);
    this.starting ??= this.startNet().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startNet(): Promise<DirectNet> {
    const { core, sync, client, api, log, options } = this.d;
    const net = await (this.d.startNet ?? ((deps, o) => DirectNet.start(deps, o)))({
      keys: core.keys, log,
      handler: (req, pubkey) => api.handle(req, { kind: "direct", pubkey }),
      tunnel: (path, headers, pubkey) => api.tunnelDirect(path, headers, pubkey), // WALKIE-POOL-2 split-run tunnels
      // The same predicate as the peer API's Direct gate (roster.ts directMemberByKey): a key counts as a member's,
      // for the budgets and the member lane, only when its record serves Direct. The login groups one person's
      // machines: a dual machine's is its Tailscale login, an invited Direct-only machine's `direct:<handle>` (or the
      // Tailscale login of the existing member the invite named).
      admitted: (pubkey) => directMemberByKey(core.roster, pubkey) !== null,
      memberOf: (pubkey) => directMemberByKey(core.roster, pubkey)?.login ?? null,
    }, options);
    if (this.stopped) { await net.stop(); throw new Error("daemon stopping"); }
    this.net = net;
    if (!this.dual) {
      this.chosen = "direct";
      this.d.stopTailscale();
      core.ip = "";
    }
    client.transports.direct = net;
    if (!sync.running) sync.start(); else sync.rosterChanged();
    return net;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.advertiseTimer) clearTimeout(this.advertiseTimer);
    this.advertiseTimer = null;
    const net = this.net ?? await this.starting?.catch(() => null) ?? null;
    this.net = null;
    this.d.client.transports.direct = null;
    await net?.stop();
  }
}
