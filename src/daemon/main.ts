// Daemon entry: startDaemon(opts) returns a handle with stop() so tests can run
// several daemons in-process; runForeground() wires signals for `walkie daemon run`.
import { isCompiledWalkie } from "../hooks/install.ts";
import { refreshClaudeHooks } from "../hooks/refresh.ts";
import { startHookStatePrune } from "./hook-state-prune.ts";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { fileURLToPath } from "node:url";
import type { LicenseVerifier } from "../license/format.ts";
import { IntegrationSlots } from "../license/integrations.ts";
import { LicenseRenewer, type RenewOptions } from "../license/renew.ts";
import { LicenseService, serviceBaseFromEnv, type ServiceOptions } from "../license/service.ts";
import { MAX_BLOB_BYTES, sha256Hex, writeBlob } from "./blobs.ts";
import { loadConfig, type Config } from "./config.ts";
import { Core } from "./core.ts";
import { shortNodeName, TailscaleIdentity, type Identity, type SelfInfo } from "./identity.ts";
import { loadOrCreateKeys } from "./keys.ts";
import { LocalApi } from "./local-api.ts";
import { createLogger, type Level, type Logger } from "./logger.ts";
import { DirectLink } from "./direct/link.ts";
import type { DirectOptions } from "./direct/net.ts";
import { PeerApi } from "./peer-api.ts";
import { PeerClient } from "./peer-client.ts";
import { PeerLink, type PeerLinkOptions } from "./peer-link.ts";
import { defaultHome, ensureHome, pathsFor, type Paths } from "./paths.ts";
import type { RateLimits } from "./ratelimit.ts";
import { Hub } from "./sse.ts";
import { Store } from "./store.ts";
import { removeLegacyHermesFiles } from "./hermes-legacy.ts";
import { SyncManager, type SyncOptions } from "./sync.ts";
import { VERSION } from "./version.ts";
import { accountsView, agentsPayload, agentsView, nodesView } from "./views.ts";
import { TeamPoolState } from "./team-pool.ts";
import { AgentArchive } from "./agent-archive.ts";
import { AgentDiscovery, UNNAMED_MIN_AGE_MS, type DiscoveryOptions } from "./discovery.ts";
import { MachineStatsSampler, type SamplerOptions } from "./machine-stats/sampler.ts";
import { readAccel } from "./machine-stats/accel.ts";
import { locateRuntime, metalBudget } from "../pool/run/runtime.ts";
import { AccountsService, type AccountsOptions } from "../accounts/service.ts";
import { lazyVault } from "../accounts/vault/source.ts";
import { liveVaultSharing } from "./vault-lease.ts";
import { localTeamPolicy } from "../accounts/pool.ts";
import { LinearService } from "../integrations/linear-service.ts";
import { IntegrationManager, type ManagerOptions } from "../integrations/manager.ts";
import { Poster } from "../integrations/poster.ts";
import "../integrations/routes.ts"; // registers /v1/integrations, /v1/linear, /v1/meetings
import "../integrations/linear-import/routes.ts"; // registers /v1/import/linear (LINEAR-IMPORT-1)
import { LinearImportService } from "../integrations/linear-import/service.ts";
import "../pool/run/routes.ts"; // registers /v1/pool (WALKIE-POOL-2 split runs)
import { PoolService, type PoolOptions } from "../pool/run/service.ts";
import { PeerCallError } from "./peer-client.ts";
import { startSshBridge } from "./ssh/bridge.ts";
import { closeSshTunnelsQuietly } from "./ssh/tunnel.ts";
import { beginSshDaemon } from "./ssh/state.ts";
import type { PeerAddr } from "./transport.ts";
import type { End } from "../pool/run/tunnel.ts";
import { nodeMember } from "./roster.ts";
import { recordPeerSignature } from "./peer-capabilities.ts";
import "../accounts/routes.ts"; // registers /v1/accounts/reset and /v1/accounts/refresh
import "./mobile/routes.ts"; // registers /v1/mobile (Walkie on your phone)
import { MobileManager, type MobileOptions } from "./mobile/manager.ts";
import { OrchestratorHost, registerHost, type OrchestratorOptions } from "./orchestrator/host.ts";
import "./orchestrator/routes.ts"; // registers /v1/orchestrator
import "./orchestrator/schedule-routes.ts";
import "./projects/routes.ts"; // registers /v1/projects, /v1/tasks (WALKIE-PROJECTS-1)
import "./projects/room-routes.ts"; // registers /v1/projects/:ch/room, /v1/tasks/:ref/context (DATA-ROOM-1)
import "./admin/routes.ts"; // registers /v1/admin (AGENT-ADMIN-1: switches, audit, remote admin)
import "./provision/routes.ts"; // local enrollment grant and bounded profile status/apply
import { backfillEnrollment } from "./provision/grant.ts";
import "./ssh/routes.ts"; // owner SSH status and local revoke
import { postUpgradeNotice } from "./admin/audit.ts";
import { JoinStatusReporter } from "./join-status.ts";
import "./projects/steward-routes.ts"; // registers /v1/steward (FO-6 board steward)
import { StewardLoop, runSteward } from "./projects/steward-run.ts";
import { visibleProjects } from "./projects/service.ts";
import { ProjectsIndex } from "./projects/index.ts";
import { RestrictedMembership } from "./projects/members.ts";
import { authorityProjectQuota } from "./projects/service.ts";
import { SeatsHost, registerSeats, type SeatsOptions } from "./seats/host.ts";
import { seatHosts, seatsList } from "./seats/view.ts";
import "./seats/routes.ts"; // registers /v1/seats
import "./seats/repos-routes.ts"; // registers /v1/seats/repos (FO-2)
import { startWatchdog, stopWatchdog, trackOp, type LoopWatchdog } from "./watchdog.ts";
import "./compute/routes.ts"; // registers /v1/compute (RENT-2 rental compute)
import { registerCompute } from "./compute/routes.ts";
import { ComputeService, type ComputeOptions } from "./compute/service.ts";
import { ComputeSite, computeBaseFromEnv } from "./compute/site.ts";
import { RENTAL_COMPUTE_AVAILABLE_IN_THIS_VERSION } from "../protocol/compute-release.ts";
import { GuestRegistry } from "../mcp/guest-registry.ts";
import { guestData } from "../mcp/guest-data.ts";
import { GuestGateway, HmacTunnelAuth } from "../mcp/guest-gateway.ts";
import { GuestScope } from "../mcp/guest-scope.ts";
import { registerGuests } from "../mcp/guest-routes.ts";
import "../mcp/guest-routes.ts"; // registers person-only /v1/guests

export interface DaemonOptions {
  home?: string;
  /** Tests: enrolled person's scratch home for authorized_keys. */
  sshUserHome?: string;
  /** Tests: fake sshd's loopback port. */
  sshPort?: number;
  socket?: string;
  /** Defaults to TailscaleIdentity. Tests pass a FakeIdentity explicitly. */
  identity?: Identity;
  peerHost?: string;
  peerPort?: number;
  /** false disables the loopback dashboard listener. */
  localPort?: number | false;
  hostname?: string;
  sync?: SyncOptions;
  limits?: RateLimits;
  webDir?: string;
  logStderr?: boolean;
  logLevel?: Level;
  heartbeatMs?: number;
  /** AGENT-ADMIN-1: post the one-time "owners can now set Walkie up here" notice (default true; test clusters turn it off). */
  adminNotice?: boolean;
  /** Apply WALKIE_* env overrides to config (default true). */
  env?: boolean;
  writePid?: boolean;
  /** Tests only: simulate the startup enrollment migration boundary. */
  enrollmentBackfill?: (home: string) => boolean;
  /** Connector options (tests inject the HTTP layer and drive runs). */
  integrations?: ManagerOptions;
  /** Linear import (tests: another GraphQL URL, a fast schedule tick). */
  linearImport?: { url?: string; tickMs?: number };
  /** Daily license renewal on the authority (default on). false disables it. */
  licenseRenew?: Omit<RenewOptions, "service"> | false;
  /**
   * Tests only: the license service's fetch (and base). Production talks to SITE_ORIGIN; with env on,
   * WALKIE_DEV=1 + a loopback WALKIE_LICENSE_URL may point it at a local site (src/license/service.ts).
   */
  licenseService?: ServiceOptions;
  /** Tests only: verify licenses against a throwaway vendor key. */
  licenseVerifier?: LicenseVerifier;
  /** Tests only: the node clock (event timestamps, plan decisions). Default Date.now. */
  clock?: () => number;
  /** Peer API retry/watch timings (default: retry 2 s → 60 s jittered, re-check the Tailscale IP every 60 s). */
  peerLink?: PeerLinkOptions;
  /** Agent auto-discovery (config `discover_agents`, default on); false disables it, tests inject the process list. */
  discovery?: DiscoveryOptions | false;
  /** Orchestrator supervisor timings and the child's environment (tests). */
  orchestrator?: OrchestratorOptions;
  /** Remote seats: timings and the seats' environment (tests). */
  seats?: SeatsOptions;
  /** Machine stats (config `machine_stats`, default on); false disables it, tests inject readings. */
  machineStats?: SamplerOptions | false;
  /** Provider accounts (config `accounts`, default on); false disables it, tests inject files, fetch and clock. */
  accounts?: AccountsOptions | false;
  /** Walkie Direct endpoint options (tests: preset "minimal", a loopback bind and a shared address book). */
  direct?: DirectOptions;
  /** WALKIE-POOL-2 split runs (tests: the runtime directory, extra llama.cpp arguments, the stage lease). */
  pool?: PoolOptions;
  /** Tests can start the guest listener with a local fake tunnel assertion key. */
  guestGateway?: { port: number; tunnelKey: Uint8Array };
  /** Walkie on your phone (off until `walkie mobile pair`); tests point it at a local relay. */
  mobile?: MobileOptions;
  /** RENT-2 rental compute: the site (tests inject base + fetch), poll timing, a release tag for dev builds. */
  compute?: ComputeOptions;
}

export interface DaemonHandle {
  readonly home: string; readonly paths: Paths; readonly socket: string; readonly nodeId: string;
  /** The bound peer API port, or null while it is down (retrying). */
  readonly peerPort: number | null; readonly localPort: number | null; readonly token: string;
  readonly core: Core; readonly sync: SyncManager; readonly config: Config; readonly log: Logger;
  readonly integrations: IntegrationManager;
  /** The Linear import (LINEAR-IMPORT-1). */
  readonly linearImport: LinearImportService;
  /** The peer API client (Tailscale or Walkie Direct) and the transport this daemon runs. */
  readonly client: PeerClient; readonly transport: DirectLink;
  /** Walkie on your phone (tests inspect it). */
  readonly mobile: MobileManager;
  /** The board index (WALKIE-PROJECTS-1). */
  readonly projects: ProjectsIndex;
  stop(): Promise<void>;
}

/** POOL-REAL-1: the transport "auto" prefers for pool tunnels to a machine that serves both (decided by measurement). */
/** After a pool change, machine stats are sampled again this soon (fresh free VRAM for teammates' plans). */
const POOL_RESAMPLE_MS = 2_000;

export const POOL_AUTO_TRANSPORT: "tailscale" | "direct" = "direct";

export const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web/dist/", import.meta.url));

/**
 * v0.1.3: how long startup waits on Tailscale before the local socket is up. Healthy, `tailscale ip` + `whois`
 * answer well inside a second; past this the node starts under its OS hostname (as when Tailscale is down) and the
 * peer link keeps retrying, so the socket, and `walkie doctor`, never wait on a slow or stuck Tailscale CLI.
 */
export const IDENTITY_STARTUP_MS = 3_000;
/** A Tailscale lookup that has not settled by now counts as failed, so the peer link's retry loop can't wedge on it. */
export const IDENTITY_HANG_MS = 15_000;

/** p, or fallback() once ms pass without it settling. */
function settleWithin<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback()), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

function selfWithin(identity: Identity, ms: number): Promise<SelfInfo | { error: string }> {
  return settleWithin(identity.self(), ms, () => ({ error: `tailscale did not answer within ${ms / 1000} s` }));
}

/**
 * Mixed teams: fetches a share's bytes from its uploader for a peer that can't reach it (peer-api.ts fetchThrough).
 * One fetch per (hash, channel) at a time; the bytes must hash to `hash`.
 */
function blobRelay(core: Core, client: PeerClient): (nodeId: string, hash: string, channel: string) => Promise<boolean> {
  const inFlight = new Map<string, Promise<boolean>>();
  return (nodeId, hash, channel) => {
    const key = `${channel}:${hash}`;
    const running = inFlight.get(key);
    if (running) return running;
    const p = (async () => {
      const n = core.roster.nodes.get(nodeId);
      const addr = n ? client.addrOf(n) : null;
      if (!addr) return false;
      const got = await client.blob(addr, hash, channel, MAX_BLOB_BYTES);
      if (!got || sha256Hex(got) !== hash) return false;
      writeBlob(core.paths.blobs, got);
      core.store.addProvenance(channel, hash);
      return true;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  };
}

/**
 * SEC-COOKIE-2: through v0.1.3 the dashboard cookie WAS local.token, and browsers send 127.0.0.1 cookies to every
 * port, so a token from before this version may have leaked. The first start of this version replaces it once
 * (the marker records that); later starts keep the token. Nothing but the daemon reads local.token: the CLI, MCP
 * server and hooks use the unix socket; only a user's own scripts send it as a bearer (they re-read the file).
 */
function loadOrCreateToken(path: string): string {
  const marker = `${path}.rotated`;
  if (!existsSync(marker)) {
    const fresh = writeNewToken(path);
    writeFileSync(marker, `${VERSION}\n`, { mode: 0o600 });
    return fresh;
  }
  if (existsSync(path)) {
    const t = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  }
  return writeNewToken(path);
}

/** A fresh local.token, written 0600 and renamed into place (readers never see a partial file). */
function writeNewToken(path: string): string {
  const t = randomBytes(32).toString("hex");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, t + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return t;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const home = opts.home ?? defaultHome();
  const paths = pathsFor(home, opts.socket);
  ensureHome(paths);
  let enrollmentBlock: string | null = null;
  try {
    if (opts.enrollmentBackfill) opts.enrollmentBackfill(home);
    else backfillEnrollment(home);
  } catch (err) {
    const message = err instanceof Error ? err.message : "enrollment state is unreadable";
    enrollmentBlock = message.includes("walkie provision migrate-enrollment")
      ? "enrollment migration requires local elevation: run walkie provision migrate-enrollment"
      : "enrollment state is unreadable: seats refuse to start";
  }
  const log = createLogger({ file: paths.log, stderr: opts.logStderr, level: opts.logLevel });
  if (enrollmentBlock) log.warn("enrollment_startup_restricted", { reason: enrollmentBlock });
  const config = loadConfig(paths.config, opts.env !== false);
  const keys = loadOrCreateKeys(paths.key);
  const token = loadOrCreateToken(paths.token);
  const identity = opts.identity ?? new TailscaleIdentity();

  // Tailscale may not be answering yet (launchd at login), or be slow: the peer link retries until it does
  // (peer-link.ts). Only a bounded wait here, so the local socket below comes up regardless.
  const self = await selfWithin(identity, IDENTITY_STARTUP_MS);
  const hostname = opts.hostname ?? ("error" in self ? shortNodeName(osHostname()) : self.nodeName);
  const fixedHost = opts.peerHost ?? config.peer_host;
  const peerHost = fixedHost ?? ("error" in self ? undefined : self.ip);

  const store = new Store(paths.db);
  removeLegacyHermesFiles(paths.home);
  const hub = new Hub(opts.heartbeatMs);
  const core = new Core({
    paths, config, log, keys, store, identity, hub, limits: opts.limits, hostname,
    ...(opts.sshUserHome ? { sshUserHome: opts.sshUserHome } : {}),
    ip: peerHost ?? "", login: "error" in self ? null : self.login, peerPort: opts.peerPort ?? config.peer_port,
    ...(opts.licenseVerifier ? { licenseVerifier: opts.licenseVerifier } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  const licenseService = new LicenseService({ ...(opts.env !== false ? { base: serviceBaseFromEnv() } : {}), ...opts.licenseService });
  const renewer = opts.licenseRenew === false ? null : new LicenseRenewer(core, log, { ...opts.licenseRenew, service: licenseService });

  const client = new PeerClient({ team: () => core.teamId, nodeId: keys.nodeId, keys, self: () => core.roster.nodes.get(keys.nodeId) });
  let watchdog: LoopWatchdog | null = null;
  const sync = new SyncManager(core, client, { ...opts.sync,
    stallTotal: opts.sync?.stallTotal ?? (() => watchdog?.stallTotalMs() ?? 0),
  });
  const linkIdentity: Identity = { kind: identity.kind, whois: (ip, h) => identity.whois(ip, h), self: () => selfWithin(identity, IDENTITY_HANG_MS) };
  // Set below: a dual node keeps syncing over Walkie Direct while its tailnet listener is down.
  let directUp = (): boolean => false;
  const link = new PeerLink({
    core, sync, client, identity: linkIdentity, log, port: opts.peerPort ?? config.peer_port, ...(fixedHost ? { fixedHost } : {}),
    directUp: () => directUp(),
  }, opts.peerLink);
  // Walkie Direct: started now if this node is on a Direct team, or later by init/join (src/daemon/direct/link.ts).
  const direct = new DirectLink({
    core, sync, client, api: new PeerApi(core, { ...(opts.sshPort ? { port: opts.sshPort } : {}) }), log, stopTailscale: () => link.stop(),
    options: { ...(config.relays ? { relays: config.relays } : {}), ...opts.direct },
  }, config);
  directUp = () => direct.direct() !== null;
  // Projects (WALKIE-PROJECTS-1): boards folded from project channels' posts; restricted members follow the roster.
  const projects = new ProjectsIndex(core, log);
  const guestRegistry = new GuestRegistry(store);
  const guestSource = guestData(core, projects, client, sync.requestCatchUp);
  registerGuests(core, guestRegistry, guestSource);
  let guestGateway: GuestGateway | null = null;
  const restricted = new RestrictedMembership(core, log);
  const poster = new Poster({ core });
  const manager = new IntegrationManager(core, poster, opts.integrations);
  const linearImport = new LinearImportService({
    core, idx: projects, manager, client, catchUp: sync.requestCatchUp, log,
    ...(opts.integrations?.fetch ? { fetch: opts.integrations.fetch } : {}), ...(opts.linearImport ?? {}),
  });
  const integrations = { manager, linear: new LinearService(core, manager), linearImport };
  // FO-6: the board steward; runs only when this machine's person turned `steward.auto` on (steward-run.ts).
  const steward = new StewardLoop({ core, idx: projects, sync, client, catchUp: sync.requestCatchUp, linear: integrations.linear, log });
  const orchestrator = new OrchestratorHost({ core, log, client, catchUp: sync.requestCatchUp, nodes: () => nodesView(core, sync),
    capacitySnapshot: () => {
      const active = seatsList(core).filter((s) => ["running", "paused", "queued"].includes(s.state));
      return {
        machines: nodesView(core, sync).map((n) => ({ node: n.node_id, online: n.online })),
        seats: seatHosts(core, sync).map((h) => ({ node: h.node, free: !h.online || !h.allows ? 0
          : h.availability?.max === undefined ? null : Math.max(0, h.availability.max - active.filter((s) => s.host.node === h.node).length) })),
        accounts: accountsView(core, sync).map((a) => ({ key: a.key, state: a.usage?.state ?? "unknown",
          windows: (a.usage?.windows ?? []).map((w) => ({ kind: w.kind, scope: w.scope, used_pct: w.used_pct })) })),
      };
    },
    capacityTargets: () => agentsView(core, sync).filter((a) => a.machine_online && !a.archived &&
      a.effective_state !== "offline" && /orchestrator/i.test(`${a.agent} ${a.status.title ?? ""}`) &&
      !(a.node === core.nodeId && a.agent === "orchestrator"))
      .map((a) => `@${a.handle}/${a.hostname}/${a.agent}`),
    boardRefresh: async (canAct) => {
      const results: string[] = [];
      for (const p of visibleProjects({ core, idx: projects }).filter((p) => p.state === "active")) {
        if (!canAct()) throw new Error("WalkieTalkie lease expired");
        try {
          const r = await runSteward({ core, idx: projects, sync, client, catchUp: sync.requestCatchUp, linear: integrations.linear, log }, p.channel,
            { dryRun: false, caller: "loop", canAct });
          results.push(`${p.prefix}: ${r.applied.length} moves, ${r.plan.held.length} held, ${r.failed.length} failed`);
        } catch (err) { results.push(`${p.prefix}: ${String(err).slice(0, 200)}`); }
      }
      return results.join("\n").slice(0, 8_000);
    },
  }, opts.orchestrator);
  registerHost(core, orchestrator);
  // Set once the accounts service starts (below); the reset routes answer 404 until then.
  let accountsRef: AccountsService | null = null;
  const seats = new SeatsHost({ core, client, catchUp: sync.requestCatchUp, log, accounts: () => accountsView(core, sync) },
    { ...opts.seats, ...(enrollmentBlock ? { enrollmentBlock } : {}) });
  registerSeats(core, seats);
  // JOIN-STATUS-1: the one #general post after this machine is admitted (retried until the channel is synced).
  const joinStatus = new JoinStatusReporter(core, log);
  // Tests inject a local site; the shipped daemon never starts a rental poller in this version.
  const compute = RENTAL_COMPUTE_AVAILABLE_IN_THIS_VERSION || opts.compute?.site
    ? new ComputeService({ core, client, catchUp: sync.requestCatchUp, log, transport: () => direct }, {
      ...opts.compute, site: opts.compute?.site ?? new ComputeSite({ base: opts.env !== false ? computeBaseFromEnv() : undefined }),
    }) : null;
  if (compute) registerCompute(core, compute);
  // Paired phones' requests (through the encrypted relay link) run on the local API declared just below.
  const mobile = new MobileManager({
    core, log, home, serve: (req, url, credential) => local.serveAuthenticated(req, url, null, credential),
  }, { env: opts.env !== false, ...opts.mobile });
  const local: LocalApi = new LocalApi({
    core, sync, client, token, webDir: opts.webDir ?? DEFAULT_WEB_DIR, integrations, licenseService, mobile,
    rotateToken: () => ({ token: writeNewToken(paths.token), path: paths.token }),
    tailscaleError: () => link.tailscaleError, peerApi: () => link.status(), transport: direct, projects,
    localLag: () => watchdog?.recentLag() ?? null,
    accounts: () => accountsRef,
  });

  let statsSampler: MachineStatsSampler | null = null;
  let sshBridge: Awaited<ReturnType<typeof startSshBridge>> | null = null;
  try {
    core.onLocalEvent = (ev) => sync.push(ev);
    core.onRosterChange = () => {
      sync.rosterChanged(); direct.rosterChanged(); mobile.rosterChanged(); core.pool?.rosterChanged();
      projects.rosterChanged(); restricted.rosterChanged(); orchestrator.rosterChanged(); joinStatus.rosterChanged();
    };
    core.onPostChange = (ev, change) => projects.onPost(ev, change);
    projects.onDelta = (d) => hub.publishBoard(d);
    core.statusScrub = (b) => projects.scrubStatus(b);
    core.projectQuota = () => authorityProjectQuota(core, projects);
    // Mixed teams: an event its origin pushed here goes on to the peers that origin can't reach (sync.ts relay).
    core.onPeerEvent = (ev, from) => sync.relay(ev, from);
    core.reachedPeers = () => sync.reachedPeers();
    core.sshTeamConfirmed = () => sync.sshTeamConfirmed();
    core.peerRtts = () => sync.peerRtts();
    const addrOrThrow = (nodeId: string) => {
      const n = core.roster.nodes.get(nodeId);
      const addr = n && !n.revoked ? client.addrOf(n) : null;
      if (!addr) throw new PeerCallError(0, "unreachable", `${n?.hostname ?? nodeId} can't be reached from this machine (no transport in common)`);
      return addr;
    };
    // POOL-REAL-1: which transport pool tunnels use to a machine that serves both. "auto" = the usual choice
    // (addrOf: Tailscale first). Measured on atlas-wsl <-> hestia-wsl (docs/plans/POOL-REAL-1.md): Walkie Direct was
    // not clearly faster than Tailscale there, and right after a restart its address lookup can fail, so it is an
    // opt-in (config pool_transport / WALKIE_POOL_TRANSPORT) that falls back to the usual transport when unreachable.
    let resampleTimer: ReturnType<typeof setTimeout> | null = null;
    const poolTunnel = async (nodeId: string, open: (addr: PeerAddr) => Promise<End>): Promise<End> => {
      const usual = addrOrThrow(nodeId);
      const pref = (process.env.WALKIE_POOL_TRANSPORT ?? config.pool_transport) as "auto" | "tailscale" | "direct";
      const n = core.roster.nodes.get(nodeId);
      const via = pref !== "auto" && n && !n.revoked ? client.addrVia(n, pref) : null;
      if (!via || (via.pubkey ?? "") === (usual.pubkey ?? "")) return open(usual);
      try {
        return await open(via);
      } catch (err) {
        if (!(err instanceof PeerCallError) || err.status !== 0) throw err; // a refusal is an answer, not a path problem
        log.warn("pool_tunnel_fallback", { node: nodeId, from: pref, err: err.message.slice(0, 160) });
        return open(usual);
      }
    };
    core.pool = new PoolService({
      home: paths.home, configPath: paths.config, config, log,
      mayHead: (nodeId) => { const m = nodeMember(core.roster, nodeId); return !!m && m.role !== "observer"; },
      stats: () => core.machineStats,
      hostnameOf: (nodeId) => core.roster.nodes.get(nodeId)?.hostname ?? nodeId,
      // A pool job starting or ending moves GBs of GPU memory: sample again soon so teammates plan with fresh figures
      // (POOL-REAL-1: a run started right after another was refused on the 30 s old free-VRAM figure).
      changed: () => {
        hub.nodesChanged();
        if (!resampleTimer) {
          resampleTimer = setTimeout(() => { resampleTimer = null; void statsSampler?.tick(); }, POOL_RESAMPLE_MS);
          (resampleTimer as { unref?: () => void }).unref?.();
        }
      },
      stage: (nodeId, body) => client.stage(addrOrThrow(nodeId), body),
      tunnel: (nodeId, run) => poolTunnel(nodeId, (a) => client.tunnel(a, run)),
      serve: (nodeId, body) => client.serve(addrOrThrow(nodeId), body),
      tunnelTo: (nodeId, path) => poolTunnel(nodeId, (a) => client.tunnelTo(a, path)),
      seatsBlock: () => seats.poolBlock(),
    }, opts.pool);
    core.poolShare = () => core.pool?.published() ?? null;
    core.fetchBlob = blobRelay(core, client);
    hub.setProviders({
      agents: () => agentsPayload(core, sync), nodes: () => nodesView(core, sync), visible: (ev) => core.visible(ev),
      accounts: () => accountsView(core, sync),
    });

    await local.startUnix(paths.socket);
    beginSshDaemon(paths.home);
    sshBridge = await startSshBridge(core, client);
    const localPort = opts.localPort ?? config.local_port;
    if (localPort !== false) local.startTcp(localPort);
    const guestSetting = opts.guestGateway ?? (config.guest_gateway ? (() => {
      const path = config.guest_gateway.assertion_key_file;
      const file = statSync(path);
      if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error("guest assertion key file must be private (0600)");
      return { port: config.guest_gateway.port, tunnelKey: readFileSync(path) };
    })() : null);
    if (guestSetting) {
      guestGateway = new GuestGateway(guestRegistry, new GuestScope(guestSource), new HmacTunnelAuth(guestSetting.tunnelKey, Date.now,
        (subject, nonce) => guestRegistry.consumeNonce(subject, nonce)), Date.now,
        (guest) => !!core.teamId && !!core.me() && core.me()?.role !== "removed" && guest.node === core.nodeId && guest.owner === core.myHandle());
      guestGateway.listen(guestSetting.port);
    }
  } catch (err) {
    guestGateway?.stop();
    await sshBridge?.stop();
    local.stop();
    mobile.stop();
    hub.close();
    store.close();
    throw err;
  }

  core.drainPending();
  core.reduceOverCapBoards();
  projects.start();
  linearImport.start();
  steward.start();
  restricted.rosterChanged();
  if (direct.mode() === "direct") {
    // A Direct node never opens the tailnet listener. The endpoint binds a local UDP socket; relays and
    // hole-punching come up in the background. A failed start retries with jittered backoff (link.ts).
    await direct.startWithRetry();
  } else {
    // Binds the peer API and starts sync now if Tailscale answers, else keeps retrying in the background. A slow
    // first answer finishes in the background too: the rest of startup doesn't wait past the budget.
    await settleWithin(link.start(), IDENTITY_STARTUP_MS, () => undefined);
    // A dual node (config `direct`, or its record serves Direct) also runs the Walkie Direct endpoint.
    if (direct.wantsDirect()) await direct.startWithRetry();
  }
  manager.start();
  renewer?.start();
  mobile.start();
  compute?.start();
  // An upgrade (WALKIE-MISSION-SUB-1): Claude hooks an older version installed get this version's events (sub-agents).
  // Only a compiled install with the environment on: tests and runs from source never touch ~/.claude.
  if (opts.env !== false && isCompiledWalkie()) {
    try {
      const r = refreshClaudeHooks({ home: paths.home });
      if (r.status === "written") {
        log.info("claude_hooks_refreshed", { added: r.added });
        if (r.detail) log.warn("claude_hooks_marker_not_saved", { detail: r.detail });
      } else if (r.status === "read-only" || r.status === "hard-linked" || r.status === "changed-underneath") {
        log.warn("claude_hooks_not_refreshed", { status: r.status, detail: r.detail });
      }
    } catch (err) {
      log.warn("claude_hooks_refresh_failed", { err: (err as Error).message });
    }
  }
  // Running agent sessions that have no hooks yet (started before `walkie hooks install`).
  const discoverable = process.platform === "darwin" || process.platform === "linux" || !!(opts.discovery && opts.discovery.provider);
  const discovery = opts.discovery !== false && config.discover_agents && discoverable ? new AgentDiscovery(core, log, { share: () => core.sharePolicy(), hermesActivity: () => core.hermesActivityProfiles(), home: paths.home, ...(opts.discovery || { unnamedMinAgeMs: UNNAMED_MIN_AGE_MS }) }) : null;
  // ACCOUNTS-2: this machine's vault (switchable accounts; read-only here), for the poller and hand-outs.
  const vault = lazyVault(paths.home);
  core.vault = vault;
  core.vaultSharing = () => liveVaultSharing(paths.config);
  // COMPANY POOL: the team's pool setting (newest owner setting seen, kept on disk; off when unknown).
  const teamPool = new TeamPoolState(paths.home, paths.config);
  core.teamPool = () => teamPool.current(core, sync);
  // Provider accounts the running sessions use, their usage left, shared on `vv` (src/accounts/service.ts).
  const accounts = opts.accounts !== false && config.accounts
    ? new AccountsService(paths.home, log, (snap) => { core.accounts = snap; hub.accountsChanged(); }, { vault: vault, teamPolicy: () => localTeamPolicy(paths.config), poolOn: () => core.teamPolicy() === "company", ...(opts.accounts || {}) })
    : null;
  if (!accounts) {
    // An owner's machine with accounts off still tells the team its pool setting (an otherwise empty snapshot).
    const advertise = () => {
      const ad = localTeamPolicy(paths.config);
      const next = ad ? { at: Date.now(), accounts: [], team_policy: ad } : null;
      if (JSON.stringify(next?.team_policy ?? null) !== JSON.stringify(core.accounts?.team_policy ?? null)) { core.accounts = next; hub.accountsChanged(); }
    };
    advertise();
    const t = setInterval(advertise, 30_000);
    (t as { unref?: () => void }).unref?.();
  }
  accountsRef = accounts;
  if (accounts) {
    core.vaultRoomLeft = (id, now) => accounts.roomLeft(id, now);
    core.vaultRefresh = (id) => { accounts.refresh(id); };
    core.vaultRenew = (id) => accounts.renewCodex(id);
  }
  if (accounts && discovery) discovery.onScan = (found) => accounts.observe(found);
  accounts?.start();
  discovery?.start();
  // Idle and ended agents leave the live roster for the Agent archive, which stays bounded (agent-archive.ts).
  const archive = new AgentArchive(core, sync, log);
  archive.start();
  // Sub-agent hook state of sessions that ended or crashed (WALKIE-MISSION-SUB-1): at start and hourly.
  const stopHookPrune = startHookStatePrune(paths.home, core, log, () => discovery?.runningAgents() ?? null);
  orchestrator.init(); // resumes an orchestrator that ran here before a restart
  seats.init(); // takes seat requests again if this machine allows seats
  // This machine's memory and temperature, published to the team on `vv` (machine-stats/sampler.ts).
  const sampler = statsSampler = opts.machineStats !== false && config.machine_stats
    ? new MachineStatsSampler((st) => { core.machineStats = st; hub.nodesChanged(); }, log, {
      intervalMs: config.machine_stats_interval_s * 1_000,
      // Apple Silicon: Metal's working-set budget from the installed llama.cpp (POOL-REAL-1).
      ...(process.platform === "darwin" ? { readAccel: () => readAccel({ metalBudget: () => metalBudget(locateRuntime(paths.home, config.pool_llama_dir)) }) } : {}),
      ...(opts.machineStats || {}),
    })
    : null;
  sampler?.start();
  // Expires stale held events (unknown origins after 1 h, the rest after 24 h) and drains ready ones.
  const housekeeping = setInterval(() => trackOp("housekeeping", () => core.drainPending()), 5 * 60_000);
  // Names the operation behind any event-loop stall in the log (DAEMON-STALL-1).
  watchdog = startWatchdog(log);
  // The plan-clock floor moves at least hourly (audit M4); this node's integration slots on the chain
  // follow its settings (F3: a legacy enable asks for its slot, a queued enable turns on when it arrives).
  core.noteTime();
  const slots = new IntegrationSlots({ core, client, catchUp: sync.requestCatchUp }, manager, log);
  void slots.reconcile();
  const planClock = setInterval(() => core.noteTime(), 60 * 60_000);
  const announce = setInterval(() => void slots.reconcile(), 60_000);
  (planClock as { unref?: () => void }).unref?.();
  (announce as { unref?: () => void }).unref?.();
  if (opts.writePid) writeFileSync(paths.pid, String(process.pid) + "\n", { mode: 0o600 });
  if (opts.adminNotice !== false) postUpgradeNotice(core);
  // A restart between joining and posting (or the roster already being caught up at boot) needs one try here too:
  // the rest are retried from core.onRosterChange above.
  // An upgraded authority can attest possession of its own legacy founder key in the signed roster.
  recordPeerSignature(core, core.nodeId);
  joinStatus.rosterChanged();
  log.info("daemon_started", {
    version: VERSION, node: keys.nodeId, hostname, peer: link.port !== null ? `${core.ip}:${core.peerPort}` : null,
    local: local.tcpPort, socket: paths.socket, team: core.teamId, identity: identity.kind,
    transport: direct.mode(), ...(direct.direct() ? { endpoint: direct.direct()?.endpoint } : {}),
  });

  let stopped = false;
  return {
    home, paths, socket: paths.socket, nodeId: keys.nodeId, get peerPort() { return link.port; },
    localPort: local.tcpPort, get token() { return local.token; }, core, sync, config, log, integrations: manager, client, transport: direct, mobile,
    projects, linearImport,
    async stop() {
      if (stopped) return;
      stopped = true;
      closeSshTunnelsQuietly(core);
      await sshBridge?.stop();
      clearInterval(housekeeping);
      if (watchdog) stopWatchdog(watchdog);
      clearInterval(planClock);
      clearInterval(announce);
      await orchestrator.close();
      await seats.close();
      await core.pool?.stop().catch((err: unknown) => log.warn("pool_stop_failed", { err: (err as Error).message }));
      manager.stop();
      linearImport.stop();
      mobile.stop();
      projects.stop();
      steward.stop();
      restricted.stop();
      renewer?.stop();
      compute?.stopPoller();
      discovery?.stop();
      archive.stop();
      stopHookPrune();
      sampler?.stop();
      accounts?.stop();
      guestGateway?.stop();
      core.statuses.stop();
      core.close();
      sync.stop();
      local.stop();
      link.stop();
      await direct.stop();
      hub.close();
      store.close();
      if (opts.writePid) rmSync(paths.pid, { force: true });
      log.info("daemon_stopped", { node: keys.nodeId });
    },
  };
}

/** `walkie daemon run`: foreground daemon with clean shutdown on SIGTERM/SIGINT. */
export async function runForeground(opts: DaemonOptions = {}): Promise<void> {
  // ORCH-2: the real daemon starts WalkieTalkie on its own (the team's lead with a model login).
  const d = await startDaemon({ logStderr: true, writePid: true, ...opts, orchestrator: { auto: true, ...opts.orchestrator } });
  const shutdown = async (sig: string): Promise<void> => {
    d.log.info("signal", { sig });
    await d.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  await new Promise(() => undefined);
}

if (import.meta.main) {
  runForeground().catch((err: Error) => {
    process.stderr.write(`walkie daemon: ${err.message}\n`);
    process.exit(1);
  });
}
