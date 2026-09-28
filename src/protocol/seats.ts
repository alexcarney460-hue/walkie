// Remote seats conventions (PROTOCOL §11), shared by the daemon, CLI and dashboard. Pure: no I/O.
//
// A machine whose person opted in (`walkie seats allow`) runs agents (`claude -p` / `codex exec`) that allowed
// launchers start from their own machines. Everything travels as ordinary signed `msg.post` events in the host's
// restricted channel `seats-<host node id>`: a launch or stop request is a post by the launcher carrying a `seat`
// field; the host's answers (state changes, output, the result) are posts by the host daemon with agent `seats`,
// threaded under the request. The body's extra field is kept verbatim by every node (validation never strips a
// signed body), so older nodes store and relay these posts like any other message.
import { z } from "zod";
import { BlobHash, EventId, Handle, NodeId } from "./schemas.ts";

/** Prefix of a host machine's seats channel: `seats-<node id>`. */
export const SEATS_PREFIX = "seats-";
/** Agent name of the host daemon's posts and status in the seats channel. */
export const SEATS_AGENT = "seats";
/** A running seat's agent name (`seat-<short id>`): its WALKIE_AGENT, so its own Walkie calls are an agent's. */
export const SEAT_AGENT_PREFIX = "seat-";

export const SEAT_RUNTIMES = ["claude", "codex"] as const;
export type SeatRuntime = (typeof SEAT_RUNTIMES)[number];

/**
 * What the seat may do without asking (it can't ask: nobody is at the terminal). Claude: its --permission-mode.
 * Codex: default = `--sandbox read-only`, acceptEdits = `--sandbox workspace-write`, bypassPermissions =
 * `--dangerously-bypass-approvals-and-sandbox`.
 */
export const SEAT_MODES = ["default", "acceptEdits", "bypassPermissions"] as const;
export type SeatMode = (typeof SEAT_MODES)[number];
/**
 * Seats and compute sharing (split runs, src/pool/run/) never run on one machine together (Opus seats r9 HIGH): a
 * pool stage's rpc-server and a run head's llama-server listen on loopback, which a seat user can reach, and neither
 * can tell users apart. Both sides refuse with this, plus which one to turn off.
 */
export const SEATS_POOL_CONFLICT = "seats and compute sharing can't be on together on one machine: seats run other people's agents as separate users, and the shared model server can't tell users apart";
export const SEATS_POOL_CODE = "seats_pool_conflict";
/** The refusal when seats are on and a pool action is asked for. */
export const TURN_SEATS_OFF = `${SEATS_POOL_CONFLICT}. Seats are on here: turn them off first (walkie seats deny)`;
export const DEFAULT_SEAT_MODE: SeatMode = "acceptEdits";

/** The launcher's cap on its own running seats on one host (the host enforces it, and its own `max`). */
export const DEFAULT_MAX_CONCURRENT = 9;
/** The host's machine-wide cap on running seats unless its person sets `max` (1–64). */
export const DEFAULT_HOST_MAX = 3;
export const MAX_CONCURRENT_LIMIT = 64;
/** Hard wall-clock limit of a seat (seconds). */
export const DEFAULT_SEAT_TIMEOUT_S = 3_600;
export const MIN_SEAT_TIMEOUT_S = 10;
export const MAX_SEAT_TIMEOUT_S = 24 * 3_600;
export const MAX_SEAT_PROMPT = 24_000;
/** Characters of the prompt quoted in the request post's text (the full prompt is in `seat.prompt`). */
export const PROMPT_PREVIEW = 600;

export const SeatModel = z.string().min(1).max(100).regex(/^[A-Za-z0-9._\[\]:-]+$/);

/** A launch request (by a launcher, in the host's seats channel). The prompt is data: it is never parsed. */
export const SeatRun = z.object({
  op: z.literal("run"),
  v: z.literal(1),
  runtime: z.enum(SEAT_RUNTIMES),
  model: SeatModel.optional(),
  permission_mode: z.enum(SEAT_MODES).optional(),
  prompt: z.string().min(1).max(MAX_SEAT_PROMPT),
  /** A git bundle shared as an artifact in the same channel: cloned into the seat's directory. */
  bundle: BlobHash.optional(),
  timeout_s: z.number().int().min(MIN_SEAT_TIMEOUT_S).max(MAX_SEAT_TIMEOUT_S),
  max_concurrent: z.number().int().min(1).max(MAX_CONCURRENT_LIMIT),
}).strict();
export type SeatRun = z.infer<typeof SeatRun>;

/** A stop request (by a launcher): `seat` = the launch request's event id. */
export const SeatStop = z.object({ op: z.literal("stop"), v: z.literal(1), seat: EventId }).strict();
export type SeatStop = z.infer<typeof SeatStop>;

/** `queued`: accepted while the host's person uses the machine (busy); `paused`: SIGSTOPped for the same reason. */
export const SEAT_STATES = ["refused", "queued", "running", "paused", "done", "failed", "stopped", "timeout"] as const;
export type SeatStateName = (typeof SEAT_STATES)[number];
export const TERMINAL_STATES: ReadonlySet<string> = new Set(["refused", "done", "failed", "stopped", "timeout"]);

/** A state change (by the host daemon, agent `seats`). */
export const SeatState = z.object({
  op: z.literal("state"),
  v: z.literal(1),
  seat: EventId,
  state: z.enum(SEAT_STATES),
  reason: z.string().max(300).optional(),
  /** Home-relative directory of the seat on the host. */
  dir: z.string().max(300).optional(),
  exit_code: z.number().int().nullable().optional(),
  /** The seat's commits as a git bundle artifact (same channel, same thread). */
  bundle: BlobHash.optional(),
  commits: z.number().int().nonnegative().optional(),
  /** Files left changed but not committed. */
  dirty: z.number().int().nonnegative().optional(),
  /** queued/paused: when the host's person said they'd be done (ms), if they set a timer. */
  until: z.number().int().nonnegative().optional(),
}).strict();
export type SeatState = z.infer<typeof SeatState>;

/** Longest `walkie seats busy --for` (seconds). */
export const MAX_BUSY_S = 7 * 24 * 3_600;

/**
 * The host's availability (by the host daemon, not threaded), posted whenever it changes: `available`, or `busy`
 * while its person uses the machine (`walkie seats busy`): at most `max` seats run, `running` do, `paused` are
 * SIGSTOPped, `queued` wait. Launchers schedule elsewhere meanwhile.
 */
export const SeatHost = z.object({
  op: z.literal("host"),
  v: z.literal(1),
  state: z.enum(["available", "busy"]),
  max: z.number().int().min(0).max(MAX_CONCURRENT_LIMIT).optional(),
  running: z.number().int().nonnegative().optional(),
  paused: z.number().int().nonnegative().optional(),
  queued: z.number().int().nonnegative().optional(),
  /** Who set it: the host's person. */
  by: Handle.optional(),
  since: z.number().int().nonnegative().optional(),
  until: z.number().int().nonnegative().optional(),
}).strict();
export type SeatHost = z.infer<typeof SeatHost>;
/** A host's availability as views carry it (the `seat` field of its latest host post, minus op/v). */
export type HostAvailability = Omit<SeatHost, "op" | "v">;

/** A chunk of the seat's progress (by the host daemon); `n` counts from 1. */
export const SeatOutput = z.object({
  op: z.literal("output"),
  v: z.literal(1),
  seat: EventId,
  n: z.number().int().min(1),
  final: z.boolean().optional(),
}).strict();
export type SeatOutput = z.infer<typeof SeatOutput>;

export type SeatBody = SeatRun | SeatStop | SeatState | SeatOutput | SeatHost;

/** The `seat` field of a post, validated (null for an ordinary post or a malformed one). */
export function seatOf(body: unknown): SeatBody | null {
  const raw = typeof body === "object" && body !== null ? (body as { seat?: unknown }).seat : undefined;
  if (typeof raw !== "object" || raw === null) return null;
  const op = (raw as { op?: unknown }).op;
  const schema = op === "run" ? SeatRun : op === "stop" ? SeatStop : op === "state" ? SeatState : op === "output" ? SeatOutput
    : op === "host" ? SeatHost : null;
  const res = schema?.safeParse(raw);
  return res?.success ? (res.data as SeatBody) : null;
}

/** `seats-<node id>`. */
export function seatsChannel(node: string): string {
  return `${SEATS_PREFIX}${node}`;
}

/** The host node id whose seats channel this is, or null. */
export function seatsChannelNode(channel: string | undefined | null): string | null {
  if (!channel || !channel.startsWith(SEATS_PREFIX)) return null;
  const n = channel.slice(SEATS_PREFIX.length);
  return NodeId.safeParse(n).success ? n : null;
}

/** A seat's agent name from its request id ("a1b2c3d4e5f60718:42" → "seat-a1b2c3-42"). */
export function seatAgentName(requestId: string): string {
  const [origin = "", seq = "0"] = requestId.split(":");
  return `${SEAT_AGENT_PREFIX}${origin.slice(0, 6)}-${seq}`;
}

/**
 * What may appear in a machine's seats channel (SEATS-FIX-8; Opus r8 1, Codex r8 MEDIUM 4), judged by every replica:
 * the host daemon's own posts and shares (origin = the channel's node, agent `seats` or a seat's), and seat requests
 * (`run` / `stop` posts) from anyone who can post there. Nothing else, so the channel can't serve as a general
 * restricted channel (which the Free plan doesn't include). Null when allowed, else the rejection reason. A request's
 * text is exactly what the daemon writes (seatRequestText), so it carries nothing of its own (Opus r9 MEDIUM); asks
 * and answers are never allowed there (roster.ts, Opus r9 MEDIUM / Codex r9 MEDIUM 2).
 */
export function seatsChannelContent(ev: { kind: string; origin: string; channel?: string; author: { agent?: string }; body: unknown }): string | null {
  const node = seatsChannelNode(ev.channel);
  if (!node) return null;
  if (ev.kind === "ask" || ev.kind === "answer") return "seats_channel_protocol_only";
  if (ev.origin === node && isSeatAgent(ev.author.agent)) return null;
  if (ev.kind === "msg.post" && seatRequestText(ev.body)) return null;
  return "seats_channel_protocol_only";
}

/** A hostname as it may appear in a request's text: what the roster allows, one line, no control characters. */
const TEXT_HOST = /^[^\u0000-\u001f\u007f]{1,63}$/;

/**
 * Whether a post is a seat request exactly as `POST /v1/seats/run` / `seat stop` write it: `{text, seat}` (run) or
 * `{text, thread, seat}` (stop, threaded under its request), no mentions or artifacts, and the text the daemon's
 * format gives for its `seat` field (runText; the only free part is the host's hostname, checked for shape: it is
 * judged on every replica, whose roster may name the host differently later).
 */
export function seatRequestText(body: unknown): boolean {
  const s = seatOf(body);
  if (!s || typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b).sort().join(",");
  if (s.op === "stop") return keys === "seat,text,thread" && b.thread === s.seat && b.text === `Stop seat ${s.seat}`;
  if (s.op !== "run" || keys !== "seat,text" || typeof b.text !== "string") return false;
  const full = runText(s, "\u0000");
  const at = full.indexOf("\u0000"); // the hostname's place (a prompt's own NUL comes after it)
  const pre = full.slice(0, at);
  const post = full.slice(at + 1);
  const text = b.text;
  if (!text.startsWith(pre) || !text.endsWith(post) || text.length < pre.length + post.length) return false;
  return TEXT_HOST.test(text.slice(pre.length, text.length - post.length));
}

/** The repo bundle a seat request in a seats channel names (its reference: the request authorizes the fetch), or null. */
export function seatBundleRef(ev: { kind: string; channel?: string; body: unknown }): string | null {
  if (ev.kind !== "msg.post" || !seatsChannelNode(ev.channel)) return null;
  const s = seatOf(ev.body);
  return s?.op === "run" && s.bundle ? s.bundle : null;
}

/** Whether an agent name is one the host daemon owns (its own `seats`, or a running seat's). */
export function isSeatAgent(agent: string | undefined): boolean {
  return agent === SEATS_AGENT || (!!agent && agent.startsWith(SEAT_AGENT_PREFIX));
}

/**
 * One launcher entry of the host's config: `@alex` (the person, from any of their machines), `@alex/alex-mac` (the
 * person at that machine) or `@alex/alex-mac/orchestrator` (that agent on that machine; agents are allowed only
 * when named this way).
 */
export interface LauncherEntry { handle: string; machine?: string; agent?: string }

const LAUNCHER_RE = /^@?([a-z][a-z0-9-]{0,23})(?:\/([a-z0-9][a-z0-9.-]{0,62})(?:\/([a-z0-9][a-z0-9._-]{0,47}))?)?$/;

export function parseLauncher(s: string): LauncherEntry | null {
  const m = LAUNCHER_RE.exec(s.trim());
  if (!m || !Handle.safeParse(m[1]).success) return null;
  return { handle: m[1] as string, ...(m[2] ? { machine: m[2] } : {}), ...(m[3] ? { agent: m[3] } : {}) };
}

export function launcherLabel(e: LauncherEntry): string {
  return `@${[e.handle, e.machine, e.agent].filter(Boolean).join("/")}`;
}

/** The request post's text: who asked for what, with the prompt quoted as a preview (the full prompt is `seat.prompt`). */
export function runText(run: SeatRun, hostname: string): string {
  const head = `Seat request: ${run.runtime}${run.model ? ` (${run.model})` : ""} on ${hostname} · ${run.permission_mode ?? DEFAULT_SEAT_MODE}`
    + `${run.bundle ? " · with repo bundle" : ""} · limit ${Math.round(run.timeout_s / 60)} min`;
  const preview = run.prompt.length > PROMPT_PREVIEW ? `${run.prompt.slice(0, PROMPT_PREVIEW)}…` : run.prompt;
  return `${head}\n\n${preview.split("\n").map((l) => `> ${l}`).join("\n")}`;
}

export function stateText(s: SeatState): string {
  const label: Record<SeatStateName, string> = {
    refused: "Seat refused", queued: "Seat queued", running: "Seat running", paused: "Seat paused", done: "Seat finished", failed: "Seat failed",
    stopped: "Seat stopped", timeout: "Seat timed out",
  };
  const bits = [
    s.reason, s.dir ? `in ${s.dir}` : "", s.exit_code !== undefined && s.exit_code !== null ? `exit ${s.exit_code}` : "",
    s.commits ? `${s.commits} commit${s.commits === 1 ? "" : "s"} (bundle attached)` : "", s.dirty ? `${s.dirty} uncommitted file${s.dirty === 1 ? "" : "s"}` : "",
    s.until ? `until ${clock(s.until)}` : "",
  ].filter(Boolean);
  return `${label[s.state]}${bits.length ? `: ${bits.join(" · ")}` : ""}`;
}

/** A time of day as "15:40 UTC" (posts are read on other machines, in other time zones). */
function clock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/** A host post's text: "arvid-mac is busy (…)" / "arvid-mac is available for seats again". */
export function hostText(h: HostAvailability, hostname: string): string {
  if (h.state === "available") return `${hostname} is available for seats again`;
  return `${hostname} is busy: ${busyDetail(h)}${h.until ? ` until ${clock(h.until)}` : ""}. New seats queue here meanwhile.`;
}

/** "its person is using it · limit 1 · 1 running · 2 paused · 0 queued". */
export function busyDetail(h: HostAvailability): string {
  return [`${h.by ? `@${h.by}` : "its person"} is using it`, `limit ${h.max ?? 0}`, `${h.running ?? 0} running`, `${h.paused ?? 0} paused`, `${h.queued ?? 0} queued`].join(" · ");
}

// ---- views (GET /v1/seats) ------------------------------------------------------------------------------

export interface SeatView {
  /** The launch request's event id. */
  id: string;
  host: { node: string; hostname: string; handle: string };
  launcher: { handle: string; hostname: string; agent?: string };
  runtime: SeatRuntime; model?: string; permission_mode: SeatMode;
  prompt: string; bundle?: string; timeout_s: number; max_concurrent: number;
  requested_at: number;
  /** "requested" until the host answers. */
  state: SeatStateName | "requested";
  reason?: string; dir?: string; exit_code?: number | null;
  result_bundle?: string; commits?: number; dirty?: number;
  started_at?: number; ended_at?: number;
  /** queued/paused: when the host's person said they'd be done (ms). */
  until?: number;
  /** The host's output posts, in order (text is scrubbed by the host). */
  output: Array<{ id: string; n: number; ts: number; text: string; final?: boolean }>;
}

export interface SeatHostView {
  node: string; hostname: string; handle: string; self: boolean;
  /** The host announces seats as allowed (its `seats` status is not offline). */
  allows: boolean;
  /** I am a member of its seats channel (a launcher or the host's person). */
  member: boolean;
  channel: string;
  activity?: string;
  online: boolean;
  /** Whether its person is using it (from its latest host post; only for members of its seats channel, and itself). */
  availability?: HostAvailability;
}

export interface SeatsLocalView {
  allow: boolean;
  /**
   * Something of the pool is on here (compute sharing, a stage, a run), so seats can't be allowed (or, allowed, don't
   * launch): the refusal, naming what to turn off (Opus seats r9 HIGH).
   */
  pool_conflict?: string;
  /** The configured launchers, or [] when they default to the team's owners. */
  launchers: string[];
  runtimes: SeatRuntime[];
  /** Seats running at once here (the person's `max`, else DEFAULT_HOST_MAX). */
  max: number;
  /** Extra environment variable names seats get here (besides the allowlist). */
  env?: string[];
  dir: string;
  channel: string | null;
  /** The channel exists, is restricted and holds only this machine's person and the launchers. */
  channel_ok: boolean;
  channel_error?: string;
  /** Every seat runs as a fresh OS user, created for it and destroyed after it (`walkie seats setup-user`). */
  ephemeral: boolean;
  /** The person accepted that seats run as their own user (`--same-user`): a seat can then act as them. */
  same_user: boolean;
  /** The person accepted that seat users can read their home (`--accept-readable-home`). */
  readable_home: boolean;
  /**
   * The Claude login seats run on (and can read while they run): `machine` = this machine's own (its token or
   * credentials), `dedicated` = a token set for seats only (`walkie seats token set`).
   */
  claude_login: "dedicated" | "machine" | "unavailable";
  /** Codex's: `machine` (its own sign-in: as seat users, its auth.json handed to each run), or `unavailable`. */
  codex_login?: "machine" | "unavailable";
  /** Seat users whose destroy could not be verified: something of them may remain (listed until it is). */
  quarantined?: string[];
  /** Why new seat users wait: the helper's pending ids couldn't be listed at start (retried every 30 s). */
  reconcile_error?: string;
  /** Why each one isn't verified removed (the user helper's answer), when it said. */
  quarantine_why?: Record<string, string>;
  /**
   * Seats are allowed in config.json but do not run, and why (e.g. no seat users and no --same-user, a seat user
   * that is root or an administrator, a readable home): with the command that fixes it.
   */
  disabled_reason?: string;
  /** Seats here, whatever their phase (paused included); `queued` wait for the busy limit or a free seat. */
  running: number;
  paused: number;
  queued: number;
  /** `busy` while this machine's person uses it (`walkie seats busy`), else `available`. */
  availability: HostAvailability;
  /**
   * The installed root-owned runner and user helper against this daemon's Walkie (release builds, once seat users are
   * set up): `stale` after a `walkie update` until `walkie seats setup-user --apply` reinstalls them; `unknown` when a
   * copy's version couldn't be read (never shown as current).
   */
  helper_version?: { state: "current" | "stale" | "unknown"; want: string; copies: Array<{ path: string; version: string | null; why?: string }>; problem?: string };
}

export interface SeatsView { local: SeatsLocalView; hosts: SeatHostView[]; seats: SeatView[] }
