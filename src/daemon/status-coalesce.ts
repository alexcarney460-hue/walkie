// Agent status is latest-wins, so a burst over the rate limit is coalesced
// instead of rejected: the newest body is held and emitted when the bucket
// refills. Hooks fire several times a second during parallel tool use; a 429
// there would leave the dashboard showing stale activity.
import type { BodyOf, Event } from "../protocol/schemas.ts";
import type { StatusProvenance } from "../protocol/status-projection.ts";
import { trackOp } from "./watchdog.ts";

type Status = BodyOf<"agent.status">;
interface Held { body: Status; provenance?: StatusProvenance; observedAt?: number }

export interface StatusSink {
  /** null = rate limited. `observedAt`: when the status was really observed, when that is not now (see Core.emit). */
  tryEmit(agent: string, body: Status, provenance?: StatusProvenance, final?: boolean, observedAt?: number): Event | null;
}

/** Global cap on held statuses (and their timers): rotating agent names can't grow memory without bound. */
export const MAX_HELD_AGENTS = 512;

export class StatusCoalescer {
  private readonly held = new Map<string, Held>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly sink: StatusSink, private readonly retryMs = 250) {}

  /** The event when emitted now; null when held for a trailing emit. */
  submit(agent: string, body: Status, provenance?: StatusProvenance, observedAt?: number): Event | null {
    const event = this.timers.has(agent) ? null : this.sink.tryEmit(agent, body, provenance, false, observedAt);
    if (event) return event;
    this.held.delete(agent); // re-insert: Map order is the LRU order
    this.held.set(agent, { body, ...(provenance ? { provenance } : {}), ...(observedAt !== undefined ? { observedAt } : {}) });
    if (!this.timers.has(agent)) this.schedule(agent);
    this.evict();
    return null;
  }

  /** Offline is terminal: cancel a queued update and try to sign it synchronously. */
  submitFinal(agent: string, body: Status, provenance?: StatusProvenance): Event | null {
    const timer = this.timers.get(agent);
    if (timer) clearTimeout(timer);
    this.timers.delete(agent);
    this.held.delete(agent);
    const event = this.sink.tryEmit(agent, body, provenance, true);
    if (event) return event;
    this.held.set(agent, { body, ...(provenance ? { provenance } : {}) });
    this.schedule(agent);
    return null;
  }

  /** The statuses waiting for a token (latest per agent). */
  heldStatuses(): Status[] {
    return [...this.held.values()].map((h) => h.body);
  }

  private evict(): void {
    while (this.held.size > MAX_HELD_AGENTS) {
      const oldest = this.held.keys().next().value as string;
      this.held.delete(oldest);
      const t = this.timers.get(oldest);
      if (t) clearTimeout(t);
      this.timers.delete(oldest);
    }
  }

  private schedule(agent: string): void {
    this.timers.set(agent, setTimeout(() => {
      this.timers.delete(agent);
      const held = this.held.get(agent);
      if (!held) return;
      try {
        if (trackOp("status_flush", () => this.sink.tryEmit(agent, held.body, held.provenance, false, held.observedAt))) this.held.delete(agent);
        else this.schedule(agent);
      } catch {
        this.held.delete(agent); // daemon stopping; status is ephemeral
      }
    }, this.retryMs));
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.held.clear();
  }
}
