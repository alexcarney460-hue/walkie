import { createHash } from "node:crypto";
import { canonicalJson } from "../../protocol/canonical.ts";
import { SCHEDULE_CHANNEL } from "../../protocol/talkie-schedule.ts";
import type { Core } from "../core.ts";

export const SUMMARY_COOLDOWN_MS = 60 * 60_000;
const META = "talkie_capacity_summary_v1";
const PREFIX = "walkie-talkie-capacity-summary:v1:";
export interface CapacitySnapshot {
  machines: readonly { node: string; online: boolean }[];
  seats: readonly { node: string; free: number | null }[];
  accounts: readonly { key: string; state: string; windows: readonly { kind: string; scope: string | null; used_pct: number }[] }[];
}
export interface PostedSummary { fingerprint: string; at: number }

export function capacityFingerprint(snapshot: CapacitySnapshot): string {
  const state = {
    machines: snapshot.machines.map((m) => [m.node, m.online]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    seats: snapshot.seats.map((s) => [s.node, s.free]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    accounts: snapshot.accounts.map((a) => [a.key, a.state,
      a.windows.map((w) => [w.kind, w.scope, Math.floor(w.used_pct / 10)]).sort((x, y) => canonicalJson(x).localeCompare(canonicalJson(y)))])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

export function lastPostedSummary(core: Core): PostedSummary | null {
  const raw = core.store.getMeta(META);
  const local = raw ? parsePosted(raw) : null;
  const rows = core.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 2_147_483_647 });
  const replicated = rows.flatMap((row) => {
    try {
      const event = JSON.parse(row.json) as { body?: { text?: unknown }; author?: { agent?: string } };
      const text = event.body?.text;
      return !event.author?.agent && typeof text === "string" && text.startsWith(PREFIX)
        ? [parsePosted(text.slice(PREFIX.length))].filter((v): v is PostedSummary => v !== null) : [];
    } catch { return []; }
  }).sort((a, b) => b.at - a.at)[0] ?? null;
  return !local || (replicated && replicated.at > local.at) ? replicated : local;
}

function parsePosted(raw: string): PostedSummary | null {
  try {
    const value = JSON.parse(raw) as PostedSummary;
    return /^[a-f0-9]{64}$/.test(value.fingerprint) && Number.isSafeInteger(value.at) && value.at >= 0 ? value : null;
  } catch { return null; }
}

export function summaryDue(fingerprint: string, previous: PostedSummary | null, now: number): boolean {
  return (!previous || previous.fingerprint !== fingerprint) && (!previous || now - previous.at >= SUMMARY_COOLDOWN_MS);
}

export function recordPostedSummary(core: Core, fingerprint: string, at: number): void {
  core.emit("msg.post", { text: PREFIX + JSON.stringify({ fingerprint, at }) }, { channel: SCHEDULE_CHANNEL });
  core.store.setMeta(META, JSON.stringify({ fingerprint, at } satisfies PostedSummary));
}
