import type { BodyOf, Event } from "../../protocol/schemas.ts";
import type { StatusProvenance } from "../../protocol/status-projection.ts";

type Status = BodyOf<"agent.status">;
type Emit = (agent: string, body: Status, provenance?: StatusProvenance) => Event | null;

/** Bounds seat cards before they enter the ordinary per-agent status coalescer. */
export class SeatStatusThrottle {
  private readonly lastBody = new Map<string, string>();
  /** Latest requested state, including one currently queued behind the daemon's status coalescer. */
  private readonly latestState = new Map<string, Status["state"]>();
  private readonly lastSent = new Map<string, number>();
  private readonly recent: number[] = [];
  private readonly held = new Map<string, { body: Status; provenance?: StatusProvenance; stateChanged: boolean }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly emit: Emit, private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = (error) => console.error("seat status flush failed", error)) {}

  submit(agent: string, body: Status, provenance?: StatusProvenance): Event | null {
    if (this.stopped) return null;
    const stamp = this.now();
    const encoded = JSON.stringify(body);
    const previous = this.lastBody.get(agent);
    const previousState = this.latestState.get(agent);
    const stateChanged = previousState !== undefined && previousState !== body.state;
    const heartbeatDue = stamp - (this.lastSent.get(agent) ?? 0) >= 5 * 60_000;
    if (body.state !== "offline" && previous === encoded && !heartbeatDue) return null;
    this.latestState.set(agent, body.state);
    if (body.state === "offline") {
      this.held.delete(agent);
      this.lastBody.set(agent, encoded);
      this.lastSent.set(agent, stamp);
      return this.emit(agent, body, provenance);
    }
    this.expire(stamp);
    // State transitions (especially idle -> working) are meaningful immediately. The 10-second
    // per-seat interval is for activity-only changes; both paths still share the host bucket.
    const seatDue = stateChanged ? 0 : Math.max(0, (this.lastSent.get(agent) ?? -Infinity) + 10_000 - stamp);
    if (seatDue > 0 || this.recent.length >= 30) {
      this.held.set(agent, { body, stateChanged, ...(provenance ? { provenance } : {}) });
      this.schedule(Math.max(seatDue, this.recent.length >= 30 ? this.recent[0]! + 60_000 - stamp : 0));
      return null;
    }
    const event = this.emit(agent, body, provenance);
    if (event) {
      this.recent.push(stamp);
      this.lastBody.set(agent, encoded);
      this.lastSent.set(agent, stamp);
    }
    return event;
  }

  private expire(now: number): void { while (this.recent.length && this.recent[0]! <= now - 60_000) this.recent.shift(); }

  private schedule(delay: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, Math.max(1, delay));
    this.timer.unref?.();
  }

  flush(): void {
    if (this.stopped) return;
    const stamp = this.now();
    this.expire(stamp);
    for (const [agent, held] of this.held) {
      if ((!held.stateChanged && stamp - (this.lastSent.get(agent) ?? -Infinity) < 10_000) || this.recent.length >= 30) continue;
      let event: Event | null;
      try {
        event = this.emit(agent, held.body, held.provenance);
      } catch (error) {
        this.held.delete(agent); // Status is ephemeral; a later update may still be emitted.
        try { this.onError(error); } catch { /* logging must not escape the timer */ }
        continue;
      }
      if (event) {
        this.held.delete(agent);
        this.recent.push(stamp);
        this.lastBody.set(agent, JSON.stringify(held.body));
        this.lastSent.set(agent, stamp);
      }
    }
    if (this.held.size) {
      const seatWait = Math.min(...[...this.held].map(([a, value]) => {
        return value.stateChanged ? 0 : Math.max(0, (this.lastSent.get(a) ?? -Infinity) + 10_000 - stamp);
      }));
      this.schedule(Math.max(1, seatWait, this.recent.length >= 30 ? this.recent[0]! + 60_000 - stamp : 0));
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearPending();
  }

  clearPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.held.clear();
  }
}
