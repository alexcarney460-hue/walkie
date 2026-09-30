import type { Core } from "../core.ts";
import type { Schedule } from "../../protocol/talkie-schedule.ts";

export const CAPACITY_ASK_COOLDOWN_MS = 2 * 60 * 60_000;
export interface CapacityAskState { target: string; lastAsked: number; answer: "answered" | "denied" | "unanswered" }

/** Ask and answer events are signed, durable team records; reconstruct the latest state per target. */
export function capacityAskState(core: Core, targets: readonly string[], now = Date.now()): CapacityAskState[] {
  if (!targets.length) return [];
  const wanted = new Set(targets);
  const asks = core.store.queryEvents({ kinds: ["ask"], since_ts: now - CAPACITY_ASK_COOLDOWN_MS, limit: 2_147_483_647 });
  const latest = new Map<string, { id: string; ts: number }>();
  for (const row of asks) {
    let event: { id?: unknown; ts?: unknown; author?: { agent?: unknown }; body?: { to?: unknown } };
    try { event = JSON.parse(row.json) as typeof event; } catch { continue; }
    const to = event.body?.to;
    if (event.author?.agent !== "orchestrator" || typeof to !== "string"
      || typeof event.id !== "string" || typeof event.ts !== "number" || now - event.ts >= CAPACITY_ASK_COOLDOWN_MS) continue;
    for (const target of wanted) {
      if (target !== to && !target.startsWith(`${to}/`)) continue;
      const prior = latest.get(target);
      if (!prior || event.ts > prior.ts || (event.ts === prior.ts && event.id > prior.id)) latest.set(target, { id: event.id, ts: event.ts });
    }
  }
  return [...latest].map(([target, ask]) => {
    const answers = core.store.replies(ask.id).flatMap((row) => {
      try {
        const event = JSON.parse(row.json) as { id?: unknown; ts?: unknown; kind?: unknown; body?: { declined?: unknown } };
        return event.kind === "answer" && typeof event.id === "string" && typeof event.ts === "number" ? [event] : [];
      } catch { return []; }
    }).sort((a, b) => (a.ts as number) - (b.ts as number) || (a.id as string).localeCompare(b.id as string));
    const first = answers[0];
    return { target, lastAsked: ask.ts, answer: first ? first.body?.declined === true ? "denied" : "answered" : "unanswered" };
  });
}

export function eligibleCapacityTargets(core: Core, targets: readonly string[], now = Date.now(),
  checkedAt: Readonly<Record<string, number>> = {}): string[] {
  const recent = new Set(capacityAskState(core, targets, now).map((s) => s.target));
  return [...new Set(targets)].filter((target) => !recent.has(target)
    && (checkedAt[target] === undefined || now - checkedAt[target] >= CAPACITY_ASK_COOLDOWN_MS));
}

export function latestCapacityChecks(schedules: readonly Pick<Schedule, "capacity_checked_at">[]): Record<string, number> {
  const latest: Record<string, number> = {};
  for (const schedule of schedules) {
    for (const [target, checked] of Object.entries(schedule.capacity_checked_at ?? {})) {
      latest[target] = Math.max(latest[target] ?? 0, checked);
    }
  }
  return latest;
}
