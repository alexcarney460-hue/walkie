// config.json with defaults; env overrides WALKIE_PEER_PORT, WALKIE_LOCAL_PORT, WALKIE_PEER_HOST.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { HermesActivityProfiles } from "../protocol/hermes-activity.ts";
import { SEAT_RUNTIMES_V1, SeatRepoId } from "../protocol/seats.ts";
import { SeatToolPolicySchema } from "./seats/tool-policy.ts";
import { DEFAULT_LEASE_LIMIT, MAX_OWN_LEASE_LIMIT } from "./vault-lease-policy.ts";

/**
 * Remote seats on THIS machine (PROTOCOL §11): off unless the person opts in (`walkie seats enable`, or
 * `walkie setup … --allow-team-agents`). `launchers` narrows who may start seats (default: the team's owners at the
 * time of each request); `max` caps running seats here; `dir` is where each seat gets a fresh directory; `env` names
 * variables a seat may have besides the allowlist.
 */
export const SeatsConfig = z.object({
  allow: z.boolean().default(false),
  /** Explicit company seat mode. Legacy configs without it retain their ephemeral/same_user meaning. */
  mode: z.enum(["same_user", "seat_users"]).optional(),
  launchers: z.array(z.string().min(1).max(140)).max(50).optional(),
  max: z.number().int().min(1).max(64).optional(),
  /** Claude/Codex only (a released pre.5 daemon must still read this file after a rollback: FO-2). */
  runtimes: z.array(z.enum(SEAT_RUNTIMES_V1)).min(1).max(2).optional(),
  /**
   * FO-2: Kimi seats (v2 requests only, full access only): off unless its person turns them on (`walkie seats allow
   * --runtimes claude,codex,kimi`). Kept out of `runtimes` so an older daemon still parses the file.
   */
  kimi: z.boolean().optional(),
  /** Grok is v2-only and same-user; keep it outside the v1 runtimes list for old config readers. */
  grok: z.boolean().optional(),
  dir: z.string().min(1).max(1_000).optional(),
  /** Extra environment variable names a seat gets, on top of the allowlist (src/daemon/seats/runtime.ts). */
  env: z.array(z.string().min(1).max(64)).max(50).optional(),
  /**
   * The shell file sourced for each seat's login environment (default `seat-env` in the Walkie home, i.e.
   * ~/.walkie/seat-env): an absolute path, or `~/…` in the person's home. Set in config.json only (read at start).
   */
  env_file: z.string().min(1).max(1_000).refine((v) => v.startsWith("/") || v.startsWith("~/"), "an absolute path or ~/…").optional(),
  /**
   * Every seat runs as a fresh OS user created for it and destroyed after it, never reused (`walkie seats setup-user`
   * installs the root helper that does that). Unset: seats run as the daemon's own user, and only with `same_user`.
   */
  ephemeral: z.boolean().optional(),
  /** The root helper that creates and destroys seat users (/usr/local/libexec/walkie/walkie-seat-admin once set up). */
  admin: z.string().min(2).max(1_000).regex(/^\//).optional(),
  /** The root-owned runner sudo may run as the seat users (/usr/local/libexec/walkie/walkie-seat-runner once set up). */
  runner: z.string().min(2).max(1_000).regex(/^\//).optional(),
  /** Where the seat users' runtimes are (root-owned copies, /usr/local/libexec/walkie/runtimes once set up). */
  runtime_dir: z.string().min(2).max(1_000).regex(/^\//).optional(),
  /** The person accepted that seats run as the daemon's own user (`walkie seats allow --same-user`). */
  same_user: z.boolean().optional(),
  /** Explicit opt-in: same-user seats use this person's provider settings, CLAUDE.md and hooks. Default is a Walkie worker template. */
  inherit_person_config: z.boolean().optional(),
  /** The person accepted that seat users can read their home (`--accept-readable-home`). */
  accept_readable_home: z.boolean().optional(),
  /**
   * Which tools a seat on this machine may use (WALK-76). Absent: each runtime's own tools, as before.
   * Applied at every launch, or the launch is refused when that runtime has no tool flags. Older daemons strip
   * this key (the object is not strict) and drop it if they rewrite `seats`. Not a replicated field.
   */
  tools: SeatToolPolicySchema.optional(),
});
export type SeatsConfig = z.infer<typeof SeatsConfig>;

/**
 * FO-2 (FLEET-ORCH-1 §3.4): this machine's own clones of the team's repos, by repo id, for v2 seats that work in the
 * host's existing repo (`workspace.repo`). Absolute paths; older daemons ignore the key.
 */
export const FleetConfig = z.object({
  repos: z.record(SeatRepoId, z.string().min(2).max(1_000).regex(/^\//)).refine((r) => Object.keys(r).length <= 64, "at most 64 repos").optional(),
});
export type FleetConfig = z.infer<typeof FleetConfig>;

/**
 * FO-6 board steward on THIS machine: `auto` runs it every `interval_min` on every project this member stewards (an
 * owner, or the project's creator) whose steward is on. Off unless the person turns it on (`walkie board steward auto
 * on`): one machine per team should run it, the one with the repositories. `repos` maps a project prefix to local
 * repositories whose branches are evidence (besides the project's path rules).
 */
export const StewardConfig = z.object({
  auto: z.boolean().default(false),
  interval_min: z.number().int().min(5).max(1_440).default(15),
  stale_hours: z.number().int().min(1).max(720).default(24),
  repos: z.record(z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/), z.array(z.string().min(1).max(1_000)).max(10)).optional(),
  /** The one-time lease migration ran (steward-run.ts migrateLeases); set by every config this version writes. */
  lease_migrated: z.boolean().optional(),
});
export type StewardConfig = z.infer<typeof StewardConfig>;

export const ConfigSchema = z.object({
  peer_port: z.number().int().min(0).max(65535).default(7458),
  local_port: z.number().int().min(0).max(65535).default(7457),
  peer_host: z.string().optional(), // default: this node's Tailscale IPv4
  auto_admit: z.boolean().default(true),
  retention_days: z.number().int().min(1).default(90),
  redact: z.boolean().default(true),
  /** Show running Claude Code / Codex / Kimi sessions that have no hooks yet (src/daemon/discovery.ts). */
  discover_agents: z.boolean().default(true),
  seats: SeatsConfig.optional(),
  /** FO-2: v2 seats' repos on this machine (FleetConfig). */
  fleet: FleetConfig.optional(),
  steward: StewardConfig.optional(),
  /**
   * Status titles made from prompts (and Codex's last-reply line), for hooks and discovery alike
   * (src/agent/share-policy.ts). Off unless set to true; WALKIE_SHARE_PROMPTS=0 turns it off too.
   */
  share_prompts: z.boolean().default(false),
  /** Commands, file names, search patterns and URLs in activity lines (share-policy.ts). Off: fixed phrases only. */
  share_activity: z.boolean().default(false),
  /** The working directory in agent statuses (share-policy.ts). Off: repo name and branch only. */
  share_paths: z.boolean().default(false),
  /**
   * The Hermes profiles whose status may carry activity text (src/protocol/hermes-activity.ts; `walkie hooks install hermes
   * --activity name[,name]`). Every other Hermes profile shows its state only. A malformed value counts as [] rather than keeping the
   * daemon from starting or showing anything. A daemon from before this key ignores it (this object does not reject unknown keys).
   */
  hermes_activity_profiles: HermesActivityProfiles.catch([]).default([]),
  /** Report this machine's memory and temperature to the team (src/daemon/machine-stats/); false turns it off. */
  machine_stats: z.boolean().default(true),
  /** Seconds between machine-stats samples. */
  machine_stats_interval_s: z.number().int().min(5).max(3_600).default(30),
  /** Record the provider accounts running sessions use, read their usage and share it with the team (src/accounts/). */
  accounts: z.boolean().default(true),
  /**
   * v0.2: "direct" (Walkie Direct, iroh) or "tailscale". Unset: what this node's roster record says, else chosen at
   * `walkie init` / `walkie join` (src/daemon/direct/link.ts).
   */
  transport: z.enum(["tailscale", "direct"]).optional(),
  /**
   * v0.2 mixed teams: a Tailscale node also serves Walkie Direct (dual), so machines that joined with an invite code
   * can reach it (`walkie direct enable` sets it). The roster authority of a team with Direct-only machines needs it.
   */
  direct: z.boolean().optional(),
  /** v0.2: Walkie Direct relay URLs replacing n0's public relays; [] = no relay (direct paths only). */
  relays: z.array(z.string().url().max(200)).max(16).optional(),
  /**
   * WALKIE-POOL-2: this machine's owner lets teammates' split runs use its compute (`walkie pool share on`, the
   * dashboard toggle). Off by default; a person turns it on.
   */
  pool_share: z.boolean().default(false),
  /** The most memory (GB) a split run's stage may use here; null/absent = what is free when the run starts. */
  pool_share_max_gb: z.number().positive().max(16_384).nullable().optional(),
  /** Where the llama.cpp runtime is (default <walkie home>/pool/llama, where `walkie pool install` puts it). */
  pool_llama_dir: z.string().min(1).max(1024).optional(),
  /**
   * POOL-REAL-1: the transport split-run and served-model tunnels use to a machine that serves both: "auto" (the usual
   * one, Tailscale first), "tailscale" or "direct" (falls back to the usual one when unreachable). WALKIE_POOL_TRANSPORT
   * overrides it. A machine reachable over one transport only always uses that one.
   */
  pool_transport: z.enum(["auto", "tailscale", "direct"]).default("auto"),
  /** ACCOUNTS-2: a new `walkie claude` / `walkie codex` session does not start on an account whose window is at least
   *  this full (WALKIE_SWITCH_AT overrides). A running session moves only when its account hits the limit. */
  switch_threshold_pct: z.number().min(50).max(100).default(95),
  /** ACCOUNTS-2: this owner lets vault accounts whose policy is "shared" be handed to the named teammates. Off by
   *  default; the customer default stays owner-only. */
  vault_sharing: z.boolean().default(false),
  /** Own-person fleet hand-outs per node/hour (also the burst); teammates retain the fixed 10/hour limit. */
  vault_own_lease_limit: z.number().int().min(DEFAULT_LEASE_LIMIT).max(MAX_OWN_LEASE_LIMIT).catch(DEFAULT_LEASE_LIMIT),
  /** ACCOUNTS-2: this person may run on teammates' shared accounts — only when every own account is out (opt-in;
   *  `walkie accounts borrow on|off`). */
  borrow_shared: z.boolean().default(false),
  /** ACCOUNTS-2: keep HTTP(S)_PROXY / ALL_PROXY for credentialed launches (`walkie accounts allow-proxy on|off`). */
  allow_proxy: z.boolean().default(false),
  /**
   * AGENT-ADMIN-1: agents running on this machine as its OS user may do the setup this machine's person can (seats,
   * accounts, pool, hooks, orchestrator, invites, project settings), each audited to the team. On unless the person
   * turned it off (`walkie agents admin off`, the dashboard); absent in an older config = on. Only a person turns it
   * back on.
   */
  agent_admin: z.boolean().default(true),
  /**
   * AGENT-ADMIN-1: team owners (and their agents), and this person's own other machines, may run allow-listed admin
   * commands here over Walkie (`walkie admin --machine <this> …`). On unless the person turned it off
   * (`walkie admin remote off`); absent = on. Only this machine's person turns it back on.
   */
  remote_admin: z.boolean().default(true),
  /** Optional loopback-only HTTP MCP gateway; a trusted outbound tunnel proxy supplies signed assertions. */
  guest_gateway: z.object({
    port: z.number().int().min(1).max(65535),
    assertion_key_file: z.string().regex(/^\//).max(1_000),
  }).strict().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

function envPort(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number, got ${JSON.stringify(v)}`);
  return n;
}

/** Sets one field in config.json (0600), keeping the others as written; the running daemon's copy is not reloaded. */
export function saveConfigField(path: string, key: keyof Config, value: unknown): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const next = ConfigSchema.parse({ ...raw, [key]: value });
  writeFileSync(path, JSON.stringify({ ...raw, [key]: next[key] }, null, 2) + "\n", { mode: 0o600 });
}

export function loadConfig(path: string, env = true): Config {
  let raw: unknown = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`config.json is not valid JSON (${path}): ${(err as Error).message}`);
    }
  } else {
    writeFileSync(path, JSON.stringify(ConfigSchema.parse({}), null, 2) + "\n", { mode: 0o600 });
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`config.json invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  if (!env) return parsed.data;
  const peerPort = envPort("WALKIE_PEER_PORT");
  const localPort = envPort("WALKIE_LOCAL_PORT");
  return {
    ...parsed.data,
    ...(peerPort !== undefined ? { peer_port: peerPort } : {}),
    ...(localPort !== undefined ? { local_port: localPort } : {}),
    ...(process.env.WALKIE_PEER_HOST ? { peer_host: process.env.WALKIE_PEER_HOST } : {}),
  };
}

/** Writes `fleet` into config.json, keeping every other key exactly as the file has it. Atomic (temp file + rename), 0600. */
export function saveFleetConfig(path: string, fleet: FleetConfig): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...raw, fleet }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Writes `hermes_activity_profiles` into config.json (`walkie hooks install hermes --activity`), keeping every other key exactly as
 * the file has it and creating the file, and the Walkie home, when there are none. A file that is not a JSON object is refused and left
 * alone. Atomic (temp file + rename), 0600. Invalid names are refused before anything is written.
 */
export function saveHermesActivityProfiles(path: string, profiles: readonly string[]): void {
  const list = HermesActivityProfiles.parse([...new Set(profiles)]);
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object, so the activity profiles were not saved`);
    raw = parsed as Record<string, unknown>;
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...raw, hermes_activity_profiles: list }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Writes `seats` into config.json, keeping every other key exactly as the file has it (env overrides are never
 * persisted). Atomic (temp file + rename), 0600.
 */
export function saveSeatsConfig(path: string, seats: SeatsConfig): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...raw, seats }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
