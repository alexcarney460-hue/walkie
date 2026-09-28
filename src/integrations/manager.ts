// IntegrationManager: owns integrations.json, the connectors' schedules (interval with jitter,
// jittered exponential backoff on errors), the per-connector rate cap and the status views.
// Integrations are off until configured. Nothing here is replicated.
//
// Each connector has a configuration generation. Any configure/remove (and daemon stop) ends the
// current generation: its poll timer and scheduled callbacks are cancelled, its AbortController aborts
// in-flight fetches, and every state write or post of work captured under it throws before it happens
// (RunCtx: generation-checked store, poster and fetch). Removal therefore can't be undone by a late run.
import { join } from "node:path";
import { z } from "zod";
import { ChannelName, type Event } from "../protocol/schemas.ts";
import type { Core } from "../daemon/core.ts";
import { HttpError } from "../daemon/http.ts";
import type { BucketSpec } from "../daemon/ratelimit.ts";
import {
  CONNECTOR_IDS, SETTINGS_SCHEMAS, TeamKey, channelOf, intervalOf, isConnectorId, loadIntegrations, saveIntegrations,
  type ConnectorId, type ConnectorSettings, type IntegrationsFile,
} from "./config.ts";
import { fireflies } from "./fireflies.ts";
import { ISSUE_KEY_RE, makeLinear } from "./linear.ts";
import type { Poster } from "./poster.ts";
import { scrubMessage, scrubSecrets } from "./scrub.ts";
import { SecretError, deleteSecret, hasSecret, readKeyFile, resolveKey, storeSecret, validKey } from "./secrets.ts";
import { IntegrationStore, STORE_READS } from "./state.ts";
import type { SummarizeOptions } from "./summarize.ts";
import type { Connector, FetchLike, IntegrationView, RunCtx } from "./types.ts";
import { makeWispr } from "./wispr.ts";

/** Posts per connector: 30 per hour, bursts of 30. */
export const DEFAULT_RATE_CAP: BucketSpec = { capacity: 30, perSecond: 30 / 3600 };
const MAX_BACKOFF_MS = 60 * 60_000;
const FIRST_RUN_DELAY_MS = 1_000;
/** Keys remembered per connector after a rotation (each one is scrubbed from every later output). */
const USED_KEYS_PER_CONNECTOR = 8;

export interface ManagerOptions {
  fetch?: FetchLike;
  rateCap?: BucketSpec;
  summarize?: SummarizeOptions;
  /** false: never schedule runs automatically (tests drive runNow). Default true. */
  autoRun?: boolean;
  random?: () => number;
}

/** POST /v1/integrations/:id body. Connector-specific fields are re-checked by that connector's schema. */
export const ConfigureReq = z.object({
  enabled: z.boolean().optional(),
  key: z.string().max(1024).optional(),
  key_path: z.string().min(1).max(1024).optional(),
  channel: ChannelName.optional(),
  interval_s: z.number().int().optional(),
  backfill_hours: z.number().int().optional(),
  dir: z.string().min(1).max(1024).optional(),
  summarize: z.enum(["off", "claude"]).optional(),
  unfurl: z.boolean().optional(),
  settle_minutes: z.number().int().optional(),
  activity: z.boolean().optional(),
  teams: z.array(TeamKey).max(10).optional(),
  default_team: TeamKey.optional(),
}).strict();
export type ConfigureReq = z.infer<typeof ConfigureReq>;

/** Work of an ended configuration generation (disabled, reconfigured or removed connector). */
export class CancelledError extends Error {
  constructor(id: ConnectorId) {
    super(`${id}: cancelled (the integration was reconfigured, disabled or removed)`);
    this.name = "CancelledError";
  }
}

interface Generation {
  readonly n: number;
  readonly ctrl: AbortController;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  readonly keyed: Map<string, { t: ReturnType<typeof setTimeout>; at: number }>;
  /** External ids claimed under this generation (stale the moment it ends, #8). */
  readonly claims: Set<string>;
}

/** A hold on one configuration generation of a connector. */
export interface Lease {
  readonly id: ConnectorId;
  readonly gen: Generation;
  readonly signal: AbortSignal;
  alive(): boolean;
  /** Throws CancelledError once the generation ended. */
  check(): void;
}

function newGeneration(n: number): Generation {
  return { n, ctrl: new AbortController(), timers: new Set(), keyed: new Map(), claims: new Set() };
}

/** Store view whose writes throw once the lease's generation ended (reads pass through); claims are noted. */
function guardedStore(store: IntegrationStore, check: () => void, onClaim: (externalId: string) => void): IntegrationStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const v: unknown = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (typeof prop === "string" && STORE_READS.has(prop)) return fn.bind(target);
      if (prop === "claim") {
        return (...args: unknown[]) => { check(); const won = fn.apply(target, args); if (won) onClaim(String(args[1])); return won; };
      }
      return (...args: unknown[]) => { check(); return fn.apply(target, args); };
    },
  });
}

export class IntegrationManager {
  readonly state: IntegrationStore;
  readonly fetch: FetchLike;
  private cfg: IntegrationsFile;
  private readonly connectors: Record<ConnectorId, Connector>;
  private readonly timers = new Map<ConnectorId, ReturnType<typeof setTimeout>>();
  /** The run in progress per connector and the generation it belongs to (#8). */
  private readonly running = new Map<ConnectorId, { gen: number; p: Promise<void> }>();
  private readonly gens = new Map<ConnectorId, Generation>();
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  private readonly rateCap: BucketSpec;
  private readonly autoRun: boolean;
  private readonly random: () => number;

  constructor(private readonly core: Core, readonly poster: Poster, opts: ManagerOptions = {}) {
    this.state = new IntegrationStore(core.store);
    const orphans = this.state.recoverClaims(); // claims of the previous process: stale now (#5)
    if (orphans) core.log.info("integration_claims_recovered", { n: orphans });
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.rateCap = opts.rateCap ?? DEFAULT_RATE_CAP;
    this.autoRun = opts.autoRun !== false;
    this.random = opts.random ?? Math.random;
    this.connectors = { fireflies, wispr: makeWispr(opts.summarize), linear: makeLinear(() => this.taskKeys()) };
    this.cfg = this.loadOrEmpty();
    poster.setSecretSource(() => this.knownSecrets());
  }

  get configPath(): string { return join(this.core.paths.home, "integrations.json"); }

  private loadOrEmpty(): IntegrationsFile {
    try {
      return loadIntegrations(this.configPath);
    } catch (err) {
      this.core.log.error("integrations_config_invalid", { err: (err as Error).message });
      return {};
    }
  }

  settings(id: ConnectorId): ConnectorSettings {
    return (this.cfg[id] ?? { enabled: false }) as ConnectorSettings;
  }

  start(): void {
    this.unsubscribe = this.core.hub.subscribe((ev) => this.onEvent(ev));
    for (const id of CONNECTOR_IDS) if (this.settings(id).enabled) this.schedule(id, FIRST_RUN_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const id of CONNECTOR_IDS) this.endGeneration(id);
  }

  // ---- generations ----------------------------------------------------------------------

  private generation(id: ConnectorId): Generation {
    const g = this.gens.get(id);
    if (g) return g;
    const fresh = newGeneration(1);
    this.gens.set(id, fresh);
    return fresh;
  }

  /**
   * Ends the current generation: cancels its callbacks, aborts its fetches, fences its writes, and
   * makes the claims it holds stale (nothing under it can complete them; the next run takes them over).
   */
  private endGeneration(id: ConnectorId): void {
    const g = this.generation(id);
    for (const t of g.timers) clearTimeout(t);
    g.timers.clear();
    g.keyed.clear();
    g.ctrl.abort(new CancelledError(id));
    this.gens.set(id, newGeneration(g.n + 1));
    if (g.claims.size) this.state.staleClaims(id, [...g.claims]);
    g.claims.clear();
  }

  /** A hold on the current generation of `id`. */
  lease(id: ConnectorId): Lease {
    const gen = this.generation(id);
    const alive = () => !this.stopped && this.gens.get(id) === gen;
    return {
      id, gen, signal: gen.ctrl.signal, alive,
      check: () => { if (!alive()) throw new CancelledError(id); },
    };
  }

  // ---- secrets ---------------------------------------------------------------------------

  /**
   * Every key this daemon has used (per connector, most recent last, bounded): a key file rotated
   * while a request using the old key is in flight, or after external data holding it was fetched,
   * still gets scrubbed (#4). In memory only; never returned or logged.
   */
  private readonly usedKeys = new Map<ConnectorId, string[]>();

  private noteUsed(id: ConnectorId, key: string): void {
    const prev = (this.usedKeys.get(id) ?? []).filter((k) => k !== key);
    this.usedKeys.set(id, [...prev, key].slice(-USED_KEYS_PER_CONNECTOR));
  }

  /** Every configured key this daemon can read now, plus the keys it used recently (for scrubbing; never returned or logged). */
  knownSecrets(): string[] {
    const out = new Set<string>();
    for (const id of CONNECTOR_IDS) {
      if (!this.connectors[id].needsKey) continue;
      try {
        const k = resolveKey(this.core.paths.home, id, this.settings(id).key_path);
        if (k) { out.add(k); this.noteUsed(id, k); }
      } catch { /* unreadable or unsafe key file: nothing to scrub with, it was never used */ }
      for (const k of this.usedKeys.get(id) ?? []) out.add(k);
    }
    return [...out];
  }

  /** scrubMessage with every known key (plus `extra`, e.g. the key a run is using). */
  safeMessage(err: unknown, extra: readonly (string | null)[] = [], max = 300): string {
    const msg = err instanceof Error ? err.message : String(err);
    return scrubMessage(msg, [...extra, ...this.knownSecrets()], max);
  }

  // ---- views --------------------------------------------------------------------------

  private keySource(id: ConnectorId): "secret" | "key_path" | null {
    if (hasSecret(this.core.paths.home, id)) return "secret";
    return this.settings(id).key_path ? "key_path" : null;
  }

  view(id: ConnectorId): IntegrationView {
    const c = this.connectors[id];
    const s = this.settings(id);
    const row = this.state.row(id);
    const { enabled: _e, key_path: _k, channel: _c, ...rest } = s;
    return {
      id, name: c.name, enabled: !!s.enabled, needs_key: c.needsKey,
      configured: !c.needsKey || this.keySource(id) !== null,
      key_source: this.keySource(id), key_path: s.key_path ?? null,
      channel: channelOf(id, s), settings: rest,
      last_run: row?.last_run ?? null, last_ok: row?.last_ok ?? null, last_error: row?.last_error ?? null,
      items_posted: row?.items_posted ?? 0, next_run: s.enabled ? row?.next_run ?? null : null,
      running: this.running.has(id),
    };
  }

  views(): IntegrationView[] { return CONNECTOR_IDS.map((id) => this.view(id)); }

  // ---- configuration ---------------------------------------------------------------------

  private save(next: IntegrationsFile): void {
    saveIntegrations(this.configPath, next);
    this.cfg = next;
  }

  /**
   * The target channel must already exist (connectors never create channels): 409 `unknown_channel`
   * with the command that creates it; the dashboard offers a button that does the same as the person.
   */
  private requireChannel(name: string): void {
    const core = this.core;
    if (!core.teamId || !core.me()) throw new HttpError(409, "no_team", "this node is not in a team yet (run: walkie init or walkie join)");
    const ch = core.roster.channels.get(name);
    if (!ch) {
      const hint = `walkie channel create ${name}`;
      throw new HttpError(409, "unknown_channel", `#${name} doesn't exist yet. Create it first: ${hint}`, { channel: name, hint });
    }
    if (!core.visible({ channel: name })) throw new HttpError(403, "forbidden", `#${name} is restricted and you are not a member`);
    if (ch.archived) throw new HttpError(409, "conflict", `#${name} is archived`);
  }

  /**
   * Enables/configures a connector. Throws HttpError(400) on invalid settings or keys. `dryRun` checks
   * everything and applies nothing (the route takes the plan's slot only for a valid configuration);
   * `pendingEnable` stores the settings enabled=false with `pending_enable` (the authority is offline,
   * F3): the connector turns on when its chain entry arrives (enablePending).
   */
  configure(id: ConnectorId, req: ConfigureReq, opts: { dryRun?: boolean; pendingEnable?: boolean } = {}): IntegrationView {
    const c = this.connectors[id];
    const { key, key_path, ...fields } = req;
    if (!c.needsKey && (key !== undefined || key_path !== undefined)) throw new HttpError(400, "invalid", `${c.name} doesn't use an API key`);
    if (key !== undefined && key_path !== undefined) throw new HttpError(400, "invalid", "send either key or key_path, not both");
    if (key !== undefined && !validKey(key.trim())) throw new HttpError(400, "invalid", "key must be a single printable token of 8 to 512 characters");
    if (key_path !== undefined) {
      try { readKeyFile(key_path); } catch (err) { throw new HttpError(400, "invalid", err instanceof SecretError ? err.message : "key_path is not readable"); }
    }
    const prev = this.settings(id);
    const enabling = opts.pendingEnable === true || req.enabled !== false;
    const merged: Record<string, unknown> = { ...prev, ...fields, enabled: enabling && !opts.pendingEnable };
    delete merged.pending_enable; // any explicit configuration supersedes a queued enable
    if (opts.pendingEnable) merged.pending_enable = true;
    if (key_path !== undefined) merged.key_path = key_path;
    if (key !== undefined) delete merged.key_path;
    const parsed = SETTINGS_SCHEMAS[id].safeParse(merged);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw new HttpError(400, "invalid", `${i?.path.join(".") || id}: ${i?.message ?? "invalid"}`);
    }
    if (enabling && c.needsKey && key === undefined && !parsed.data.key_path && !hasSecret(this.core.paths.home, id)) {
      throw new HttpError(400, "invalid", `${c.name} needs an API key (key or key_path)`);
    }
    if (enabling) this.requireChannel(channelOf(id, parsed.data as ConnectorSettings));
    if (opts.dryRun) return this.view(id);
    this.unschedule(id);
    this.endGeneration(id); // work captured under the old settings stops here
    if (key !== undefined) storeSecret(this.core.paths.home, id, key.trim());
    if (key_path !== undefined) deleteSecret(this.core.paths.home, id); // the file named by key_path now wins
    this.save({ ...this.cfg, [id]: parsed.data });
    this.core.log.info("integration_configured", { connector: id, enabled: parsed.data.enabled, pending: parsed.data.pending_enable === true, key_source: this.keySource(id) });
    if (parsed.data.enabled) this.schedule(id, FIRST_RUN_DELAY_MS);
    else this.state.setNextRun(id, null);
    return this.view(id);
  }

  /** A queued enable the authority accepted (its `team.integration` entry arrived): turn the connector on. */
  enablePending(id: ConnectorId): void {
    if (!this.settings(id).pending_enable) return;
    try {
      this.configure(id, { enabled: true });
      this.core.log.info("integration_enabled_after_queue", { connector: id });
    } catch (err) {
      this.core.log.warn("integration_pending_enable_failed", { connector: id, err: this.safeMessage(err) });
    }
  }

  /** Disables a connector and forgets its settings, stored secret, cursor, dedup marks and retries. */
  remove(id: ConnectorId): IntegrationView {
    this.unschedule(id);
    this.endGeneration(id); // nothing captured before this point can write again
    const { [id]: _drop, ...rest } = this.cfg;
    this.save(rest);
    deleteSecret(this.core.paths.home, id);
    this.state.reset(id);
    this.core.log.info("integration_removed", { connector: id });
    return this.view(id);
  }

  // ---- scheduling ------------------------------------------------------------------------

  private unschedule(id: ConnectorId): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private schedule(id: ConnectorId, delayMs: number): void {
    this.unschedule(id);
    if (this.stopped) return;
    this.state.setNextRun(id, Date.now() + delayMs);
    if (!this.autoRun) return;
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      void this.runNow(id).catch(() => undefined);
    }, delayMs));
  }

  /** Delay after a run: the interval ±10 %, or after failures min(interval·2^n, 1 h) ±25 %. */
  nextDelay(id: ConnectorId, failures: number): number {
    const interval = intervalOf(id, this.settings(id));
    if (failures <= 0) return Math.round(interval * (0.9 + 0.2 * this.random()));
    const base = Math.min(interval * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF_MS);
    return Math.round(base * (0.75 + 0.5 * this.random()));
  }

  private members(): { handle: string; display_name?: string }[] {
    return [...this.core.roster.members.values()]
      .filter((m) => m.role !== "removed")
      .map((m) => ({ handle: m.handle, ...(m.display_name ? { display_name: m.display_name } : {}) }));
  }

  private taskKeys(): string[] {
    const keys = new Set<string>();
    for (const row of this.core.store.agents()) {
      try {
        const task = (JSON.parse(row.body) as { task?: unknown }).task;
        if (typeof task === "string" && ISSUE_KEY_RE.test(task.trim().toUpperCase())) keys.add(task.trim().toUpperCase());
      } catch { /* malformed row: skip */ }
    }
    return [...keys];
  }

  private visibleEvent(id: string): Event | null {
    const row = this.core.store.getRow(id);
    if (!row || row.status !== "ok" || row.redacted === 1) return null;
    const ev = JSON.parse(row.json) as Event;
    return this.core.visible(ev) ? ev : null;
  }

  /** A context bound to the current generation of `id` (or to `lease`). */
  ctx(id: ConnectorId, key: string | null, lease: Lease = this.lease(id)): RunCtx {
    const gen = lease.gen;
    const state = guardedStore(this.state, lease.check, (ext) => gen.claims.add(ext));
    if (key) this.noteUsed(id, key);
    // The credentials of THIS operation: its key as captured now (a rotation mid-request changes the
    // file, not this list), the configured keys and every key used recently (#4).
    const secrets = (): readonly string[] => [...new Set([...(key ? [key] : []), ...this.knownSecrets()])];
    return {
      id, settings: this.settings(id), key, state, poster: this.poster.bind(lease.check, state, secrets), log: this.core.log,
      signal: lease.signal, secrets,
      alive: lease.alive,
      fetch: (url, init) => {
        if (!lease.alive()) return Promise.reject(new CancelledError(id));
        const signal = init?.signal ? AbortSignal.any([init.signal, lease.signal]) : lease.signal;
        return this.fetch(url, { ...init, signal });
      },
      now: () => Date.now(),
      take: () => this.core.limiter.take(`integration:${id}`, this.rateCap),
      members: () => this.members(),
      selfNode: this.core.nodeId,
      visible: (ev) => this.core.visible(ev),
      event: (eventId) => this.visibleEvent(eventId),
      replies: (root: string) => this.core.store.replies(root).map((r) => JSON.parse(r.json) as Event).filter((e) => this.core.visible(e)),
      scrub: (text) => scrubSecrets(text, secrets()),
      schedule: (fn, delayMs, taskKey) => {
        if (!lease.alive()) return;
        const at = Date.now() + delayMs;
        if (taskKey !== undefined) {
          const prev = gen.keyed.get(taskKey);
          if (prev && prev.at <= at) return;
          if (prev) { clearTimeout(prev.t); gen.timers.delete(prev.t); }
        }
        const t = setTimeout(() => {
          gen.timers.delete(t);
          if (taskKey !== undefined && gen.keyed.get(taskKey)?.t === t) gen.keyed.delete(taskKey);
          if (!lease.alive()) return;
          fn().catch((err) => {
            if (!lease.alive()) return;
            this.core.log.warn("integration_task_failed", { connector: id, err: this.safeMessage(err, [key]) });
          });
        }, delayMs);
        gen.timers.add(t);
        if (taskKey !== undefined) gen.keyed.set(taskKey, { t, at });
      },
    };
  }

  /** Resolves the key (and remembers it for scrubbing); a connector without one can't run. */
  key(id: ConnectorId): string | null {
    const k = this.connectors[id].needsKey ? resolveKey(this.core.paths.home, id, this.settings(id).key_path) : null;
    if (k) this.noteUsed(id, k);
    return k;
  }

  /**
   * Runs a connector now. A run of the CURRENT generation already in progress is joined; one of an
   * ended generation (the connector was reconfigured under it) is waited for and then a run of the
   * current generation follows (#8), so a replacement generation always gets its run and its timer.
   */
  async runNow(id: ConnectorId): Promise<IntegrationView> {
    for (;;) {
      const inflight = this.running.get(id);
      if (!inflight) break;
      await inflight.p;
      if (inflight.gen === this.generation(id).n) return this.view(id);
    }
    const gen = this.generation(id).n;
    const p = this.runOnce(id).finally(() => { if (this.running.get(id)?.gen === gen) this.running.delete(id); });
    this.running.set(id, { gen, p });
    await p;
    return this.view(id);
  }

  private async runOnce(id: ConnectorId): Promise<void> {
    const started = Date.now();
    const lease = this.lease(id);
    let key: string | null = null;
    try {
      if (!this.settings(id).enabled) throw new Error(`${this.connectors[id].name} is not enabled`);
      key = this.key(id);
      if (this.connectors[id].needsKey && !key) throw new Error(`${this.connectors[id].name}: no API key configured`);
      const res = await this.connectors[id].run(this.ctx(id, key, lease));
      if (!lease.alive()) return; // reconfigured/removed meanwhile: its state is not ours to write
      const next = started + this.nextDelay(id, 0);
      this.state.runOk(id, started, res.posted, next);
      if (res.posted || res.capped) this.core.log.info("integration_run", { connector: id, posted: res.posted, capped: !!res.capped });
      if (this.settings(id).enabled) this.schedule(id, Math.max(0, next - Date.now()));
    } catch (err) {
      if (this.stopped || !lease.alive()) return; // shutting down / reconfigured: nothing to record
      const message = this.safeMessage(err, [key]);
      const failures = (this.state.row(id)?.failures ?? 0) + 1;
      const next = started + this.nextDelay(id, failures);
      this.state.runFailed(id, started, message, 0, next);
      this.core.log.warn("integration_run_failed", { connector: id, failures, err: message });
      if (this.settings(id).enabled) this.schedule(id, Math.max(0, next - Date.now()));
    }
  }

  private onEvent(ev: Event): void {
    if (ev.kind === "team.integration") {
      const b = ev.body as { connector?: unknown; node?: unknown; enabled?: unknown };
      if (b.node === this.core.nodeId && b.enabled === true && isConnectorId(b.connector)) this.enablePending(b.connector);
      return;
    }
    for (const id of CONNECTOR_IDS) {
      const c = this.connectors[id];
      if (!c.onEvent || !this.settings(id).enabled) continue;
      try {
        c.onEvent(ev, this.ctx(id, null));
      } catch (err) {
        this.core.log.warn("integration_event_failed", { connector: id, err: this.safeMessage(err) });
      }
    }
  }

  channelFor(id: ConnectorId): string { return channelOf(id, this.settings(id)); }
}
