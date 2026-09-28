// Shared integration types. A connector runs inside the local daemon of the machine it was configured
// on and only ever emits existing event kinds (msg.post, artifact.share) through Core.emit, authored as
// the local human handle with author.agent = the connector id (the dashboard's source badge).
import type { Event } from "../protocol/schemas.ts";
import type { Logger } from "../daemon/logger.ts";
import type { ConnectorId, ConnectorSettings } from "./config.ts";
import type { ConnectorPoster } from "./poster.ts";
import type { IntegrationStore } from "./state.ts";

/** fetch() as the connectors use it; tests inject a fake (the HTTP layer is always mockable). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Everything a connector run may touch. A context belongs to one configuration generation of its
 * connector: disabling, reconfiguring or removing the connector aborts `signal`, cancels `schedule`d
 * callbacks, makes `fetch` fail, and makes every `state` write and `poster` emit throw before it
 * happens, so work captured before the change can't publish or recreate state afterwards.
 */
export interface RunCtx {
  readonly id: ConnectorId;
  readonly settings: ConnectorSettings;
  /** API key (resolved from the secret file or key_path); null for keyless connectors. Never log it. */
  readonly key: string | null;
  /** Generation-checked store (reads pass; writes throw once the generation changed). */
  readonly state: IntegrationStore;
  /** Generation-checked writer (msg.post / artifact.share only). */
  readonly poster: ConnectorPoster;
  /** fetch bound to this generation's AbortSignal. */
  readonly fetch: FetchLike;
  readonly log: Logger;
  /** Aborted when this configuration generation ends. */
  readonly signal: AbortSignal;
  /** Still the current generation (and the daemon isn't stopping). */
  alive(): boolean;
  now(): number;
  /** Takes one item from the connector's rate cap; false = stop this run and continue next time. */
  take(): boolean;
  /** Team members for mention mapping: handle + optional display name. */
  members(): readonly { handle: string; display_name?: string }[];
  /** This daemon's node id. */
  readonly selfNode: string;
  /** Whether the local member may see an event (restricted channels). */
  visible(ev: Pick<Event, "channel">): boolean;
  /** A stored, accepted, unredacted event this member can see (null otherwise). */
  event(id: string): Event | null;
  /** Visible replies in a thread, oldest first. */
  replies(root: string): Event[];
  /** Redacts external text: every credential of this operation (`secrets`) plus secret-shaped tokens. */
  scrub(text: string): string;
  /**
   * Every credential this operation may have used: its own key (captured when the context was made,
   * so a key file rotated mid-request is still scrubbed), the configured keys, and keys used recently.
   */
  secrets(): readonly string[];
  /**
   * Runs async work later, owned by the manager (cancelled on stop and when the generation ends,
   * errors logged). With `key`, at most one callback per key is pending: the earlier one wins.
   */
  schedule(fn: () => Promise<void>, delayMs: number, key?: string): void;
}

export interface RunResult {
  /** Items (posts) published in this run. */
  readonly posted: number;
  /** True when the rate cap stopped the run early (the cursor keeps the position). */
  readonly capped?: boolean;
}

export interface Connector {
  readonly id: ConnectorId;
  readonly name: string;
  /** Needs an API key before it can run. */
  readonly needsKey: boolean;
  run(ctx: RunCtx): Promise<RunResult>;
  /** Accepted events seen by this daemon (any origin), for connectors that react to posts. */
  onEvent?(ev: Event, ctx: RunCtx): void;
}

export type { IntegrationView, LinearIssueInfo } from "./views.ts";
