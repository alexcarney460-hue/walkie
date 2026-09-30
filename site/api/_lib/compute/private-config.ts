// The PRIVATE control-plane config for rental compute: which provider, size, region and image back each tier, what it
// costs us, and our provider limits. It comes only from the env var COMPUTE_PRIVATE_CONFIG (JSON, set in Vercel, never
// committed) and is read only by the control plane. Nothing parsed here is ever copied into a customer-facing payload,
// customer log line or user-data (site/test/compute-no-cost.test.ts checks the payloads).
//
//   {
//     "tiers": {
//       "agent":    { "provider": "digitalocean", "instance_type": "<size slug>", "region": "nyc3",
//                     "image": "ubuntu-24-04-x64", "cost_per_hour_micros": 375000, "quota_group": "cpu" },
//       "agent-xl": { … }, "gpu-20": { … }, "gpu-48": { … }, "gpu-80": { … }
//     },
//     "quotas": { "cpu": 3, "gpu": 0 },   MACHINES we may hold at once per group (the provider account's limits)
//     "egress_cap_gb": 5000,              per machine: hard stop when its reported egress passes this
//     "egress_rate_mbit": 1000            legacy setting; never copied into cloud-init (public bandwidth is 1000 Mbit/s)
//   }
import { TIER_IDS, type TierId } from "./types.js";
import { tierSpec } from "./catalog.js";

export interface PrivateTier {
  readonly provider: string;
  /** The provider's size / instance type. */
  readonly instance_type: string;
  readonly region: string | null;
  readonly image: string | null;
  readonly cost_per_hour_micros: number;
  readonly quota_group: string;
}

export interface PrivateConfig {
  readonly team_authorities: Readonly<Record<string, string>>;
  readonly customer_teams: readonly string[];
  readonly internal_teams: readonly string[];
  readonly tiers: Readonly<Record<TierId, PrivateTier>>;
  readonly quotas: Readonly<Record<string, number>>;
  readonly egress_cap_gb: number;
  readonly egress_rate_mbit: number;
}

export class ConfigError extends Error {
  constructor(message: string) { super(message); }
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

function tier(id: TierId, raw: unknown, quotas: Readonly<Record<string, number>>): PrivateTier {
  if (!isObj(raw)) throw new ConfigError(`tier ${id} missing`);
  const { provider, instance_type: type, cost_per_hour_micros: cost, quota_group: group, region = null, image = null } = raw;
  if (typeof provider !== "string" || !NAME.test(provider)) throw new ConfigError(`tier ${id}: bad provider`);
  if (typeof type !== "string" || !NAME.test(type)) throw new ConfigError(`tier ${id}: bad instance_type`);
  // A real size configured at a token cost must not bypass the 2x margin check.
  const minimum = provider === 'fake' ? 0 : Math.ceil(tierSpec(id).price_per_hour_micros / 4);
  if (!isInt(cost, minimum, 1_000_000_000)) throw new ConfigError(`tier ${id}: bad cost`);
  if (typeof group !== "string" || !(group in quotas)) throw new ConfigError(`tier ${id}: unknown quota_group`);
  if (region !== null && !(typeof region === "string" && NAME.test(region))) throw new ConfigError(`tier ${id}: bad region`);
  if (image !== null && !(typeof image === "string" && NAME.test(image))) throw new ConfigError(`tier ${id}: bad image`);
  // A misconfiguration must never sell a tier below what it costs us.
  if (2 * cost > tierSpec(id).price_per_hour_micros) throw new ConfigError(`tier ${id}: price below 2x cost`);
  return { provider, instance_type: type, region: region as string | null, image: image as string | null, cost_per_hour_micros: cost, quota_group: group };
}

/** Parses COMPUTE_PRIVATE_CONFIG; throws ConfigError (whose message never includes a value) on anything off. */
export function parsePrivateConfig(text: string | undefined): PrivateConfig {
  if (!text?.trim()) throw new ConfigError("not configured");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError("not JSON");
  }
  if (!isObj(raw) || !isObj(raw.tiers) || !isObj(raw.quotas)) throw new ConfigError("tiers and quotas are required");
  const quotas: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.quotas)) {
    if (!NAME.test(k) || !isInt(v, 0, 100_000)) throw new ConfigError("bad quota");
    quotas[k] = v;
  }
  const tiers = {} as Record<TierId, PrivateTier>;
  for (const id of TIER_IDS) tiers[id] = tier(id, raw.tiers[id], quotas);
  const cap = raw.egress_cap_gb ?? 5000;
  const rate = raw.egress_rate_mbit ?? 1000;
  if (!isInt(cap, 1, 1_000_000)) throw new ConfigError("bad egress_cap_gb");
  if (!isInt(rate, 1, 100_000)) throw new ConfigError("bad egress_rate_mbit");
  const teams = (key: string): string[] => {
    const value = raw[key] ?? [];
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !/^[0-9a-f]{16}$/.test(v))) throw new ConfigError('bad team classification');
    return value;
  };
  const authorities = raw.team_authorities ?? {};
  if (!isObj(authorities) || Object.entries(authorities).some(([team, key]) => !/^[0-9a-f]{16}$/.test(team) || typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key))) throw new ConfigError('bad team authority');
  return { team_authorities: authorities as Record<string, string>, customer_teams: teams('customer_teams'), internal_teams: teams('internal_teams'), tiers, quotas, egress_cap_gb: cap, egress_rate_mbit: rate };
}
