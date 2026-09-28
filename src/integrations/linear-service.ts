// Linear features driven by the local API: task enrichment (GET /v1/linear/issues, cached 5 min in a
// local table, never replicated) and "create from Walkie" (POST /v1/linear/issues).
//
// Export rule: every message an issue carries out of Walkie (the initiating event, its thread root and
// every reply) must be accepted, unredacted, currently visible to this node's member (the local read
// API's check) and in the initiating event's channel. Otherwise the export is refused with 403: a thread
// is never partially filled. Every upstream error is scrubbed of the configured keys before it leaves.
import { z } from "zod";
import { EventId, type Event } from "../protocol/schemas.ts";
import type { Core } from "../daemon/core.ts";
import { HttpError } from "../daemon/http.ts";
import type { BucketSpec } from "../daemon/ratelimit.ts";
import { TeamKey } from "./config.ts";
import { utcStamp } from "./fireflies.ts";
import { ExternalError } from "./http.ts";
import {
  CREATE_MUTATION, ISSUE_KEY_RE, MAX_KEYS_PER_REQUEST, createIssue, firstTeam, issuesByKeys, teamByKey, toInfo, type LinearApi,
} from "./linear.ts";
import type { IntegrationManager } from "./manager.ts";
import type { LinearIssueInfo, RunCtx } from "./types.ts";
import { BACKLINK_PREFIX, BACKLINK_RETRY_MS, backlinkText, type BacklinkJob } from "./linear-backlink.ts";

export const LINEAR_CACHE_MS = 5 * 60_000;
/** Linear API calls made for enrichment/create (not the activity poll): 20 per minute. */
const API_CAP: BucketSpec = { capacity: 20, perSecond: 20 / 60 };
const MAX_DESCRIPTION_CHARS = 50_000;
const MAX_THREAD_MESSAGES = 30;

export const CreateReq = z.object({
  title: z.string().trim().min(1).max(250),
  from: EventId.optional(),
  team: TeamKey.optional(),
  dry_run: z.boolean().optional(),
}).strict();
export type CreateReq = z.infer<typeof CreateReq>;

export interface IssuesResult { enabled: boolean; issues: Record<string, LinearIssueInfo | null>; error?: string }

export function parseKeys(raw: string | null): string[] {
  const keys = [...new Set((raw ?? "").split(",").map((k) => k.trim().toUpperCase()).filter(Boolean))];
  if (keys.length > MAX_KEYS_PER_REQUEST) throw new HttpError(400, "invalid", `at most ${MAX_KEYS_PER_REQUEST} keys`);
  const bad = keys.find((k) => !ISSUE_KEY_RE.test(k));
  if (bad !== undefined) throw new HttpError(400, "invalid", `not an issue key: ${bad.slice(0, 40)}`);
  return keys;
}

function textOf(ev: Event): string {
  const b = ev.body as { text?: unknown; note?: unknown; name?: unknown };
  if (typeof b.text === "string") return b.text;
  if (ev.kind === "artifact.share") return `[artifact ${String(b.name ?? "")}]${typeof b.note === "string" ? ` ${b.note}` : ""}`;
  return "";
}

const NOT_EXPORTABLE = "this thread can't be exported: every message in it must be visible to you and in the same channel";

export class LinearService {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly core: Core, private readonly m: IntegrationManager) {}

  /** A context of the current Linear generation (fetch, store and poster fenced by it), or null when off. */
  private api(): { api: LinearApi; ctx: RunCtx } | null {
    if (!this.m.settings("linear").enabled) return null;
    let key: string | null;
    try {
      key = this.m.key("linear");
    } catch (err) {
      throw new HttpError(409, "not_configured", this.m.safeMessage(err));
    }
    if (!key) return null;
    const ctx = this.m.ctx("linear", key);
    return { api: { fetch: ctx.fetch, key, secrets: ctx.secrets }, ctx };
  }

  private takeApi(): boolean { return this.core.limiter.take("linear-api", API_CAP); }

  /** An upstream failure as a 502 whose message is scrubbed of every credential the operation used. */
  private upstream(err: unknown, fallback: string, bound: { ctx: RunCtx }): HttpError {
    return new HttpError(502, "upstream", err instanceof ExternalError ? this.m.safeMessage(err, bound.ctx.secrets()) : fallback);
  }

  /** Cached issue info for keys; missing or stale keys are fetched (one query per team). */
  async issues(keys: readonly string[]): Promise<IssuesResult> {
    const now = Date.now();
    const cached = this.m.state.linearCached(keys, LINEAR_CACHE_MS, now);
    let bound: { api: LinearApi; ctx: RunCtx } | null;
    try { bound = this.api(); } catch { bound = null; }
    const missing = keys.filter((k) => !cached.has(k));
    let error: string | undefined;
    if (bound && missing.length) {
      const inflightKey = missing.join(",");
      let p = this.inflight.get(inflightKey);
      if (!p) {
        p = this.fetchInto(bound, missing).finally(() => this.inflight.delete(inflightKey));
        this.inflight.set(inflightKey, p);
      }
      try { await p; } catch (err) { error = err instanceof ExternalError ? this.m.safeMessage(err, bound.ctx.secrets()) : "linear: lookup failed"; }
    }
    const fresh = this.m.state.linearCached(keys, LINEAR_CACHE_MS, Date.now());
    const issues: Record<string, LinearIssueInfo | null> = {};
    for (const k of keys) {
      const json = fresh.get(k);
      if (json === undefined) continue; // unknown: not fetched (disabled, error or rate cap)
      issues[k] = json === null ? null : (JSON.parse(json) as LinearIssueInfo);
    }
    return { enabled: bound !== null, issues, ...(error ? { error } : {}) };
  }

  private async fetchInto(bound: { api: LinearApi; ctx: RunCtx }, keys: string[]): Promise<void> {
    if (!this.takeApi()) throw new ExternalError("linear: lookup rate limit reached, retry shortly");
    const found = await issuesByKeys(bound.api, keys);
    const now = Date.now();
    const seen = new Set<string>();
    for (const i of found) {
      seen.add(i.identifier);
      bound.ctx.state.cacheLinear(i.identifier, JSON.stringify(toInfo(i)), now); // fenced: not after a remove
    }
    for (const k of keys) if (!seen.has(k)) bound.ctx.state.cacheLinear(k, null, now);
  }

  private okEvent(id: string): Event | null {
    const row = this.core.store.getRow(id);
    return row && row.status === "ok" && row.redacted === 0 ? (JSON.parse(row.json) as Event) : null;
  }

  /**
   * The thread an event belongs to, as issue description text (redacted, capped). The initiating event
   * must be visible (404 otherwise, like a local read); its root and every reply must be visible and in
   * its channel (403 otherwise).
   */
  threadText(from: string): { text: string; channel: string; root: string } {
    const ev = this.okEvent(from);
    if (!ev || !this.core.visible(ev) || !ev.channel) throw new HttpError(404, "not_found", "no such event in a channel");
    const channel = ev.channel;
    const exportable = (e: Event): boolean => e.channel === channel && this.core.visible(e);
    const rootId = typeof (ev.body as { thread?: unknown }).thread === "string" ? String((ev.body as { thread: string }).thread) : ev.id;
    const root = rootId === ev.id ? ev : this.okEvent(rootId);
    if (!root || !exportable(root)) throw new HttpError(403, "forbidden", NOT_EXPORTABLE);
    const replies = this.core.store.replies(root.id).map((r) => JSON.parse(r.json) as Event);
    if (!replies.every(exportable)) throw new HttpError(403, "forbidden", NOT_EXPORTABLE);
    const msgs = [root, ...replies].slice(0, MAX_THREAD_MESSAGES);
    const body = msgs.map((e) => `**@${e.author.handle}**${e.author.agent ? ` (${e.author.agent})` : ""} · ${utcStamp(e.ts)}${e.id === from ? " ← linked message" : ""}\n${textOf(e)}`).join("\n\n");
    const text = this.m.poster.clean(`From Walkie #${channel}:\n\n${body}`);
    return { text: text.length > MAX_DESCRIPTION_CHARS ? text.slice(0, MAX_DESCRIPTION_CHARS - 1) + "…" : text, channel, root: root.id };
  }

  /**
   * Creates the issue. With `from`, the backlink post is part of the result: the channel must be
   * postable BEFORE anything is created (FINAL Codex 6: an archived or invisible channel refuses the
   * whole export, 409 `post_failed`); if creation succeeds and the backlink still fails (the channel was
   * archived meanwhile, the connector was reconfigured, an emit error) the answer is a partial success,
   * `{issue, event: null, backlink: "queued", partial: true}` (207 at the route), and the backlink is
   * retried by the connector's next runs. The issue is never created twice for one failure.
   */
  async create(req: CreateReq): Promise<Record<string, unknown>> {
    const settings = this.m.settings("linear");
    const bound = this.api();
    if (!bound && !req.dry_run) throw new HttpError(409, "not_configured", "Linear isn't enabled on this machine (walkie integrations enable linear --key-path …)");
    const thread = req.from ? this.threadText(req.from) : null;
    if (thread && !req.dry_run) this.m.poster.ensureChannel(thread.channel); // PostError → 409 post_failed, before any mutation
    const backlink = req.from ? `\n\n---\nWalkie backlink: walkie://event/${req.from} (thread ${thread?.root}; \`walkie get --thread ${thread?.root}\`)` : "";
    const description = `${thread ? thread.text : "Created from Walkie."}${backlink}`;
    const teamKey = req.team ?? settings.default_team ?? settings.teams?.[0];
    let team: { id: string; key: string } | null = null;
    if (bound) {
      if (!this.takeApi()) throw new HttpError(429, "rate_limited", "Linear API rate limit reached; retry shortly");
      try {
        team = teamKey ? await teamByKey(bound.api, teamKey) : await firstTeam(bound.api);
      } catch (err) {
        throw this.upstream(err, "linear: team lookup failed", bound);
      }
      if (!team) throw new HttpError(404, "not_found", `no Linear team ${teamKey ?? "(none visible to this key)"}`);
    }
    const title = this.m.poster.clean(req.title, bound ? bound.ctx.secrets : undefined);
    const variables = { input: { teamId: team?.id ?? `<id of team ${teamKey ?? "(first visible team)"}>`, title, description } };
    if (req.dry_run) return { dry_run: true, mutation: CREATE_MUTATION, variables };
    if (!bound) throw new HttpError(409, "not_configured", "Linear isn't enabled on this machine");
    if (!this.takeApi()) throw new HttpError(429, "rate_limited", "Linear API rate limit reached; retry shortly");
    let issue: { identifier: string; title: string; url: string };
    try {
      issue = await createIssue(bound.api, variables.input);
    } catch (err) {
      throw this.upstream(err, "linear: create failed", bound);
    }
    if (!thread) return { issue, event: null };
    const job: BacklinkJob = { channel: thread.channel, thread: thread.root, identifier: issue.identifier, title: issue.title, url: issue.url };
    try {
      return { issue, event: await bound.ctx.poster.post("linear", job.channel, backlinkText(job), { thread: job.thread }) };
    } catch (err) {
      // The issue exists: report it, and let the connector's runs post the backlink when the channel allows.
      const now = Date.now();
      this.m.state.enqueueRetry("linear", `${BACKLINK_PREFIX}${issue.identifier}`, JSON.stringify(job), now + BACKLINK_RETRY_MS, now);
      this.core.log.warn("linear_backlink_queued", { issue: issue.identifier, err: this.m.safeMessage(err, bound.ctx.secrets()) });
      return { issue, event: null, backlink: "queued", partial: true };
    }
  }
}
