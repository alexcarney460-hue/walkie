// SSE hub for GET /v1/stream: 64-client cap, 15 s heartbeat, channel filter,
// debounced (250 ms) agents/nodes snapshots, immediate event fan-out.
// Agents (WALKIE-LIVE-1): a client that opts in (`?agents=delta`) gets one full roster, then only the rows that
// changed, chained by a roster revision; everyone else keeps getting whole `agents` frames.
import type { AccountView, AgentView, AgentsPayload, Event, NodeView, StreamMessage } from "../protocol/schemas.ts";
import type { BoardDelta } from "../protocol/projects/schema.ts";
import { trackOp } from "./watchdog.ts";

export const MAX_SSE_CLIENTS = 64;
/** Per-client queued (unread) bytes before the client is dropped. */
export const SSE_MAX_QUEUED_BYTES = 1024 * 1024;

interface Client {
  readonly id: number;
  /** Agent roster as deltas after one snapshot (`?agents=delta`), not whole snapshots. */
  readonly agentsDelta: boolean;
  readonly channels: ReadonlySet<string> | null;
  /**
   * A person's dashboard on this machine (a dashboard session, no agent header): the only kind of stream that gets this
   * machine's orchestrator conversation (ORCH-FIX-12: never the phone tunnel, the CLI, an agent or a filtered stream).
   */
  readonly dashboard: boolean;
  readonly send: (chunk: string) => boolean;
  readonly close: () => void;
}

export interface HubProviders {
  /** The live roster and the archive's counts (views.ts agentsPayload). */
  agents(): AgentsPayload;
  nodes(): NodeView[];
  /** The team's pooled accounts (views.ts accountsView). */
  accounts?(): AccountView[];
  /** Whether the local member may see this event (restricted channels). */
  visible(ev: Event): boolean;
}

export type EventListener = (ev: Event) => void;

export interface OpenOptions {
  /** Send the agent roster as one snapshot then `agents.delta` frames (the hub adds the snapshot itself). */
  agentsDelta?: boolean;
  /** A person's dashboard session on this machine (no agent header): gets publishLocal frames. */
  dashboard?: boolean;
}

const enc = new TextEncoder();

/** A roster row's identity on the wire (agents.delta upsert / remove): the machine's node id and the agent name. */
export function agentRowKey(a: Pick<AgentView, "node" | "agent">): string {
  return `${a.node}/${a.agent}`;
}

export function frame(msg: StreamMessage): string {
  return `event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`;
}

export class Hub {
  private readonly clients = new Map<number, Client>();
  private readonly listeners = new Set<EventListener>();
  private nextId = 1;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private agentsTimer: ReturnType<typeof setTimeout> | null = null;
  private nodesTimer: ReturnType<typeof setTimeout> | null = null;
  private accountsTimer: ReturnType<typeof setTimeout> | null = null;
  private providers: HubProviders | null = null;
  /** The roster last sent (row JSON by id), its archive counts, its revision and the payload itself. */
  private baseline = new Map<string, string>();
  private baselineArchive = "";
  private rev = 0;
  private snapshot: AgentsPayload | null = null;

  constructor(private readonly heartbeatMs = 15_000, private readonly debounceMs = 250) {
    this.heartbeat = setInterval(() => this.broadcastRaw(": hb\n\n"), heartbeatMs);
  }

  setProviders(p: HubProviders): void { this.providers = p; }
  get size(): number { return this.clients.size; }

  /** In-process subscription (ask waiters). Returns an unsubscribe fn. */
  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  publishEvent(ev: Event): void {
    for (const fn of this.listeners) {
      try { fn(ev); } catch { /* a bad listener must not break fan-out */ }
    }
    if (this.providers && !this.providers.visible(ev)) return;
    const data = frame({ type: "event", event: ev });
    for (const c of this.clients.values()) {
      if (c.channels && (!ev.channel || !c.channels.has(ev.channel))) continue;
      this.sendTo(c, data);
    }
  }

  /**
   * This machine's own orchestrator conversation and its live progress (PROTOCOL §8): to this machine's dashboards
   * only (unfiltered dashboard-session streams). Never stored here, never to the phone tunnel, the CLI or an agent.
   */
  publishLocal(msg: StreamMessage): void {
    const data = frame(msg);
    for (const c of this.clients.values()) {
      if (!c.dashboard || c.channels) continue;
      this.sendTo(c, data);
    }
  }

  /** Events a roster change made invalid: clients drop them (ids only, no content). */
  publishHidden(ids: readonly string[]): void {
    if (!ids.length) return;
    this.broadcastRaw(frame({ type: "hidden", ids: [...ids] }));
  }

  /** A project's board changed (WALKIE-PROJECTS-1): only to clients that may see its channel (and follow it, if filtered). */
  publishBoard(delta: BoardDelta): void {
    if (this.providers && !this.providers.visible({ channel: delta.channel } as Event)) return;
    const data = frame({ type: "board", ...delta });
    for (const c of this.clients.values()) {
      if (c.channels && !c.channels.has(delta.channel)) continue;
      this.sendTo(c, data);
    }
  }

  agentsChanged(): void {
    if (this.agentsTimer) return;
    this.agentsTimer = setTimeout(() => {
      this.agentsTimer = null;
      if (this.clients.size) trackOp("stream_agents", () => this.flushAgents("timer"));
    }, this.debounceMs);
  }

  /**
   * Reads the roster now and makes it the new baseline: whole-snapshot clients get it all, delta clients get the rows
   * that differ from the previous baseline (nothing when nothing changed).
   */
  private flushAgents(reason: "timer" | "open"): void {
    // A pending debounce still fires after a connect: whole-snapshot clients hear of the change it was for (the
    // connect's own baseline read may have skipped telling them), and delta clients get nothing new from it.
    if (reason === "timer" && this.agentsTimer) { clearTimeout(this.agentsTimer); this.agentsTimer = null; }
    if (!this.providers) return;
    const first = this.snapshot === null;
    const payload = this.providers.agents();
    // Keyed by node id + agent (agentRowKey), never the display id: two machines of one person can share a hostname
    // and so a display id (Codex r1 #1), which would merge their rows and lose or duplicate one on the client.
    const rows = new Map(payload.agents.map((a) => [agentRowKey(a), JSON.stringify(a)]));
    const upsert: AgentView[] = payload.agents.filter((a) => this.baseline.get(agentRowKey(a)) !== rows.get(agentRowKey(a)));
    const remove = [...this.baseline.keys()].filter((id) => !rows.has(id));
    const archiveKey = JSON.stringify([payload.archive, payload.archive_rev ?? null]);
    const changed = this.snapshot === null || upsert.length > 0 || remove.length > 0 || archiveKey !== this.baselineArchive;
    const base = this.rev;
    if (changed) {
      this.rev += 1;
      this.baseline = rows;
      this.baselineArchive = archiveKey;
    }
    this.snapshot = payload;
    // A client connecting reads the baseline for its own snapshot; the others hear only of real changes (Opus r1 LOW:
    // every dashboard connect used to re-send the whole roster to every other client). The very first baseline is
    // nobody's change: no delta client holds a chain yet, and whole-snapshot clients got the roster when they opened.
    if (reason === "open" && (!changed || first)) return;
    let full: string | null = null;
    let delta: string | null = null;
    for (const c of this.clients.values()) {
      if (!c.agentsDelta) {
        full ??= frame({ type: "agents", rev: this.rev, ...payload });
        this.sendTo(c, full);
      } else if (changed) {
        delta ??= frame({
          type: "agents.delta", base, rev: this.rev, upsert, remove, archive: payload.archive,
          ...(payload.archive_rev !== undefined ? { archive_rev: payload.archive_rev } : {}),
        });
        this.sendTo(c, delta);
      }
    }
  }

  nodesChanged(): void {
    if (this.nodesTimer) return;
    this.nodesTimer = setTimeout(() => {
      this.nodesTimer = null;
      if (this.providers && this.clients.size) trackOp("stream_nodes", () => this.broadcastRaw(frame({ type: "nodes", nodes: this.providers?.nodes() ?? [] })));
    }, this.debounceMs);
  }

  accountsChanged(): void {
    if (this.accountsTimer) return;
    this.accountsTimer = setTimeout(() => {
      this.accountsTimer = null;
      trackOp("stream_accounts", () => {
        const list = this.providers?.accounts?.();
        if (list && this.clients.size) this.broadcastRaw(frame({ type: "accounts", accounts: list }));
      });
    }, this.debounceMs);
  }

  /**
   * Builds the SSE Response, or null when the client cap is reached. `expiresAt` (epoch ms): the credential's end
   * (a dashboard session's absolute deadline); nothing is delivered at or past it, and the stream closes then.
   * `dashboard`: a person's dashboard session on this machine (publishLocal).
   */
  open(channels: string[] | null, first: StreamMessage[], signal: AbortSignal, expiresAt?: number, opts: OpenOptions = {}): Response | null {
    if (this.clients.size >= MAX_SSE_CLIENTS) return null;
    const id = this.nextId++;
    const agentsDelta = opts.agentsDelta === true;
    const dashboard = opts.dashboard === true;
    // A delta client starts from the current baseline: flush pending changes to everyone else first, so the
    // snapshot it gets and the deltas that follow form one unbroken revision chain.
    const roster: StreamMessage[] = [];
    if (agentsDelta && this.providers) {
      this.flushAgents("open");
      if (this.snapshot) roster.push({ type: "agents", rev: this.rev, ...this.snapshot });
    }
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        let deadline: ReturnType<typeof setTimeout> | null = null;
        const client: Client = {
          id,
          agentsDelta,
          channels: channels?.length ? new Set(channels) : null,
          dashboard,
          send: (chunk) => {
            if (closed) return false;
            if (expiresAt !== undefined && Date.now() >= expiresAt) { client.close(); return false; }
            // A reader that doesn't keep up is dropped rather than buffered without bound.
            if ((controller.desiredSize ?? 0) <= 0) {
              try { controller.enqueue(enc.encode(": dropped: slow client\n\n")); } catch { /* closing anyway */ }
              return false;
            }
            try { controller.enqueue(enc.encode(chunk)); return true; } catch { return false; }
          },
          close: () => {
            if (closed) return;
            closed = true;
            if (deadline) clearTimeout(deadline);
            this.clients.delete(id);
            try { controller.close(); } catch { /* already closed */ }
          },
        };
        this.clients.set(id, client);
        if (expiresAt !== undefined) {
          deadline = setTimeout(() => client.close(), Math.min(2 ** 31 - 1, Math.max(0, expiresAt - Date.now())));
          (deadline as { unref?: () => void }).unref?.();
        }
        signal.addEventListener("abort", () => client.close(), { once: true });
        client.send(": connected\n\n");
        for (const m of [...first, ...roster]) client.send(frame(m));
      },
      cancel: () => { this.clients.get(id)?.close(); },
    }, { highWaterMark: SSE_MAX_QUEUED_BYTES, size: (chunk) => chunk?.byteLength ?? 0 });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  }

  private sendTo(c: Client, data: string): void {
    if (!c.send(data)) c.close();
  }

  private broadcastRaw(data: string): void {
    for (const c of this.clients.values()) this.sendTo(c, data);
  }

  close(): void {
    clearInterval(this.heartbeat);
    if (this.agentsTimer) clearTimeout(this.agentsTimer);
    if (this.nodesTimer) clearTimeout(this.nodesTimer);
    if (this.accountsTimer) clearTimeout(this.accountsTimer);
    for (const c of [...this.clients.values()]) c.close();
    this.listeners.clear();
  }
}
