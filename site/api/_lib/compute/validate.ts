// Hand validation of rental-compute request bodies (the site has no zod; same rules as src/protocol/compute.ts).
import {
  IDEMPOTENCY_KEY, IDLE_MINUTES_MAX, IDLE_MINUTES_MIN, isTierId, JOIN_CODE, MAX_MACHINES_PER_REQUEST, NODE_ID,
  RELEASE_TAG, RENTAL_ID, TEAM_ID, TIER_IDS, TOKEN, type MachineAsk, type RentReq, type TierId,
} from "./types.js";

type Obj = Record<string, unknown>;
export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
const onlyKeys = (o: Obj, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

export function checkTeam(o: Obj): Checked<{ team_id: string }> {
  if (!onlyKeys(o, ["team_id", "proof"])) return bad("unknown_field");
  return typeof o.team_id === "string" && TEAM_ID.test(o.team_id) ? { ok: true, value: { team_id: o.team_id } } : bad("invalid_team_id");
}

export function checkRent(o: Obj): Checked<RentReq> {
  if (!onlyKeys(o, ["idempotency_key", "machines", "codes", "walkie_version", "idle_minutes"])) return bad("unknown_field");
  if (typeof o.idempotency_key !== "string" || !IDEMPOTENCY_KEY.test(o.idempotency_key)) return bad("invalid_idempotency_key");
  if (!Array.isArray(o.machines) || o.machines.length < 1 || o.machines.length > TIER_IDS.length) return bad("invalid_machines");
  const seen = new Set<TierId>();
  const machines: MachineAsk[] = [];
  for (const m of o.machines as unknown[]) {
    if (typeof m !== "object" || m === null || Array.isArray(m) || !onlyKeys(m as Obj, ["tier", "count"])) return bad("invalid_machines");
    const { tier, count } = m as Obj;
    if (!isTierId(tier) || seen.has(tier)) return bad("invalid_tier");
    if (!isInt(count, 1, MAX_MACHINES_PER_REQUEST)) return bad("invalid_count");
    seen.add(tier);
    machines.push({ tier, count });
  }
  const total = machines.reduce((a, m) => a + m.count, 0);
  if (total > MAX_MACHINES_PER_REQUEST) return bad("too_many_machines");
  if (!Array.isArray(o.codes) || o.codes.length !== total) return bad("codes_mismatch");
  const codes = o.codes as unknown[];
  if (!codes.every((c) => typeof c === "string" && JOIN_CODE.test(c))) return bad("invalid_code");
  if (new Set(codes).size !== codes.length) return bad("duplicate_code");
  if (typeof o.walkie_version !== "string" || !RELEASE_TAG.test(o.walkie_version)) return bad("invalid_walkie_version");
  if (o.idle_minutes !== undefined && !isInt(o.idle_minutes, IDLE_MINUTES_MIN, IDLE_MINUTES_MAX)) return bad("invalid_idle_minutes");
  return {
    ok: true,
    value: {
      idempotency_key: o.idempotency_key, machines, codes: codes as string[], walkie_version: o.walkie_version,
      ...(o.idle_minutes !== undefined ? { idle_minutes: o.idle_minutes as number } : {}),
    },
  };
}

export function checkStart(o: Obj): Checked<{ rental_id: string; code: string }> {
  if (!onlyKeys(o, ["rental_id", "code"])) return bad("unknown_field");
  if (typeof o.rental_id !== "string" || !RENTAL_ID.test(o.rental_id)) return bad("invalid_rental_id");
  if (typeof o.code !== "string" || !JOIN_CODE.test(o.code)) return bad("invalid_code");
  return { ok: true, value: { rental_id: o.rental_id, code: o.code } };
}

export function checkStop(o: Obj): Checked<{ rental_id: string } | { all: true }> {
  if (o.all === true && onlyKeys(o, ["all"])) return { ok: true, value: { all: true } };
  if (!onlyKeys(o, ["rental_id"])) return bad("unknown_field");
  if (typeof o.rental_id !== "string" || !RENTAL_ID.test(o.rental_id)) return bad("invalid_rental_id");
  return { ok: true, value: { rental_id: o.rental_id } };
}

export function checkCredit(o: Obj, blocks: readonly number[]): Checked<{ block: number }> {
  if (!onlyKeys(o, ["block"])) return bad("unknown_field");
  return typeof o.block === "number" && blocks.includes(o.block) ? { ok: true, value: { block: o.block } } : bad("invalid_block");
}

export interface Heartbeat {
  rental_id: string; token: string; node_id?: string; busy_seats: number; pool_jobs: number;
  bootstrap_failed?: boolean; cpu_pct: number; gpu_pct?: number; egress_bytes: number;
}

export function checkHeartbeat(o: Obj): Checked<Heartbeat> {
  const keys = ["bootstrap_failed", "rental_id", "token", "node_id", "busy_seats", "pool_jobs", "cpu_pct", "gpu_pct", "egress_bytes"];
  if (!onlyKeys(o, keys)) return bad("unknown_field");
  if (typeof o.rental_id !== "string" || !RENTAL_ID.test(o.rental_id)) return bad("invalid_rental_id");
  if (typeof o.token !== "string" || !TOKEN.test(o.token)) return bad("invalid_token");
  if (o.node_id !== undefined && !(typeof o.node_id === "string" && NODE_ID.test(o.node_id))) return bad("invalid_node_id");
  if (o.bootstrap_failed !== undefined && typeof o.bootstrap_failed !== "boolean") return bad("invalid_load");
  if (!isInt(o.busy_seats, 0, 10_000) || !isInt(o.pool_jobs, 0, 10_000)) return bad("invalid_load");
  if (!isInt(o.cpu_pct, 0, 100)) return bad("invalid_load");
  if (o.gpu_pct !== undefined && !isInt(o.gpu_pct, 0, 100)) return bad("invalid_load");
  if (!isInt(o.egress_bytes, 0, Number.MAX_SAFE_INTEGER)) return bad("invalid_egress");
  return {
    ok: true,
    value: {
      rental_id: o.rental_id, token: o.token, busy_seats: o.busy_seats, pool_jobs: o.pool_jobs, cpu_pct: o.cpu_pct,
      egress_bytes: o.egress_bytes,
      ...(o.bootstrap_failed === true ? { bootstrap_failed: true } : {}),
      ...(o.node_id !== undefined ? { node_id: o.node_id as string } : {}),
      ...(o.gpu_pct !== undefined ? { gpu_pct: o.gpu_pct as number } : {}),
    },
  };
}
