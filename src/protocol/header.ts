// Event headers (the part `hsig` signs), stubs derived from them, and a JSON depth guard.
import { PROTOCOL_VERSION, type Event, type EventHeader, type Kind, type Stub } from "./schemas.ts";

/** Maximum nesting depth of any value accepted from a peer (PROTOCOL §2 rule 1). */
export const MAX_JSON_DEPTH = 32;

export function eventHeader(ev: Pick<Event, "v" | "team" | "id" | "origin" | "seq" | "ts" | "kind" | "channel">): EventHeader {
  return {
    v: ev.v, team: ev.team, id: ev.id, origin: ev.origin, seq: ev.seq, ts: ev.ts, kind: ev.kind,
    ...(ev.channel !== undefined ? { channel: ev.channel } : {}),
  };
}

/** The header a stub claims, in the receiving team (stubs don't carry v/team: they are implied). */
export function stubHeader(stub: Stub, team: string): EventHeader {
  return {
    v: PROTOCOL_VERSION, team, id: stub.id, origin: stub.origin, seq: stub.seq, ts: stub.ts, kind: stub.kind,
    ...(stub.channel !== undefined ? { channel: stub.channel } : {}),
  };
}

/** The stub standing in for an event. Legacy events without `hsig` yield an unverifiable stub. */
export function stubOf(ev: Event): Stub {
  return {
    id: ev.id, origin: ev.origin, seq: ev.seq, ts: ev.ts, kind: ev.kind as Kind,
    ...(ev.channel !== undefined ? { channel: ev.channel } : {}), hsig: ev.hsig ?? "", redacted: true,
  };
}

/** Iterative (no recursion) check that a JSON value nests at most `max` levels. */
export function jsonDepthOk(value: unknown, max = MAX_JSON_DEPTH): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop() as [unknown, number];
    if (v === null || typeof v !== "object") continue;
    if (d >= max) return false;
    const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
    for (const c of children) if (c !== null && typeof c === "object") stack.push([c, d + 1]);
  }
  return true;
}
