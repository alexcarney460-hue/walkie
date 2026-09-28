// ~/.walkie/integrations.json (0600): NON-secret connector settings only. API keys live in
// ~/.walkie/secrets/<connector> or in a user file referenced by key_path (see secrets.ts).
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ChannelName } from "../protocol/schemas.ts";

export const CONNECTOR_IDS = ["fireflies", "wispr", "linear"] as const;
export type ConnectorId = (typeof CONNECTOR_IDS)[number];
export const ConnectorIdSchema = z.enum(CONNECTOR_IDS);

export function isConnectorId(s: unknown): s is ConnectorId {
  return typeof s === "string" && (CONNECTOR_IDS as readonly string[]).includes(s);
}

/** Linear team key, e.g. "ALE". */
export const TeamKey = z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/);

const Common = {
  enabled: z.boolean().default(false),
  channel: ChannelName.optional(),
  key_path: z.string().min(1).max(1024).optional(),
  interval_s: z.number().int().min(30).max(86_400).optional(),
  /** Items older than this when the connector is first enabled are not posted (0 = only new ones). */
  backfill_hours: z.number().int().min(0).max(720).optional(),
  /**
   * Enabling waits for the roster authority (F3): the request is queued while it is offline, and the
   * connector turns on once its `team.integration` entry arrives. Set by the daemon, never by a request.
   */
  pending_enable: z.boolean().optional(),
};

export const FirefliesSettings = z.object({ ...Common }).strict();
export const WisprSettings = z.object({
  ...Common,
  /** Wispr Flow meetings directory (default: ~/Library/Application Support/Wispr Flow/meetings). */
  dir: z.string().min(1).max(1024).optional(),
  /** "claude" runs the user's own `claude -p` CLI (subscription, never an API key) for a summary. */
  summarize: z.enum(["off", "claude"]).optional(),
  /** Unfurl notes.wisprflow.ai/shared links posted in any channel (default true). */
  unfurl: z.boolean().optional(),
  /** Minutes without writes before a meeting counts as complete (default 10). */
  settle_minutes: z.number().int().min(1).max(240).optional(),
}).strict();
export const LinearSettings = z.object({
  ...Common,
  /** Post state transitions (default true). */
  activity: z.boolean().optional(),
  /** Also watch every issue of these teams, not only issues agents report as their task. */
  teams: z.array(TeamKey).max(10).optional(),
  /** Team for `walkie linear create` without --team. */
  default_team: TeamKey.optional(),
}).strict();

export const SETTINGS_SCHEMAS = { fireflies: FirefliesSettings, wispr: WisprSettings, linear: LinearSettings } as const;
export type ConnectorSettings = z.infer<typeof FirefliesSettings> & Partial<z.infer<typeof WisprSettings>> & Partial<z.infer<typeof LinearSettings>>;

export const IntegrationsFile = z.object({
  fireflies: FirefliesSettings.optional(),
  wispr: WisprSettings.optional(),
  linear: LinearSettings.optional(),
}).strict();
export type IntegrationsFile = z.infer<typeof IntegrationsFile>;

export const DEFAULTS: Record<ConnectorId, { channel: string; interval_s: number; backfill_hours: number }> = {
  fireflies: { channel: "meetings", interval_s: 300, backfill_hours: 24 },
  wispr: { channel: "meetings", interval_s: 60, backfill_hours: 24 },
  linear: { channel: "linear", interval_s: 120, backfill_hours: 0 },
};

export function channelOf(id: ConnectorId, s: ConnectorSettings): string {
  return s.channel ?? DEFAULTS[id].channel;
}
export function intervalOf(id: ConnectorId, s: ConnectorSettings): number {
  return (s.interval_s ?? DEFAULTS[id].interval_s) * 1000;
}

export function loadIntegrations(path: string): IntegrationsFile {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`integrations.json is not valid JSON (${path}): ${(err as Error).message}`);
  }
  const parsed = IntegrationsFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`integrations.json invalid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Atomic 0600 write (temp file + rename), so a crash never leaves a half-written config. */
export function saveIntegrations(path: string, cfg: IntegrationsFile): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
