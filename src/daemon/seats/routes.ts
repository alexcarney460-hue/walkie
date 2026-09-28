// Local API for remote seats (PROTOCOL §11): GET /v1/seats, POST /v1/seats/config|run|stop, GET|POST /v1/seats/busy,
// POST /v1/seats/resume.
import { adminGate } from "../admin/gate.ts";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { BlobHash, EventId, type BodyOf, type Event } from "../../protocol/schemas.ts";
import {
  DEFAULT_MAX_CONCURRENT, DEFAULT_SEAT_TIMEOUT_S, MAX_BUSY_S, MAX_CONCURRENT_LIMIT, MAX_SEAT_PROMPT, MAX_SEAT_TIMEOUT_S, MIN_SEAT_TIMEOUT_S,
  MAX_SEAT_BRIEF, SEATS_V2_CAP, SEAT_MODES, SEAT_RUNTIMES, SEAT_RUNTIMES_V1, SeatAccountKey, SeatLabel, SeatModel, SeatResultFile, SeatRunV2, SeatWorkspace, parseLauncher, runText, runTextV2,
  seatOf, seatsChannel, seatsChannelNode, type SeatRun, type SeatRuntime, type SeatsView,
} from "../../protocol/seats.ts";
import type { SeatsConfig } from "../config.ts";
import { HttpError, json, parseWith, readBytes, readJson } from "../http.ts";
import { MAX_BLOB_BYTES, readBlob, writeBlob } from "../blobs.ts";
import { LOCAL_BODY_MAX, limitWrite, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import { activeNodes, canSeeChannel } from "../roster.ts";
import { seatsFor } from "./host.ts";
import { KIMI_FULL_ACCESS_ONLY, seatEnvNameProblem } from "./runtime.ts";
import { hostAvailability, seatHosts, seatsList } from "./view.ts";

function host(c: RouteCtx) {
  const h = seatsFor(c.core);
  if (!h) throw new HttpError(503, "unavailable", "this daemon runs without seats");
  return h;
}

function view(c: RouteCtx, only?: string): SeatsView {
  return { local: host(c).view(), hosts: c.core.teamId ? seatHosts(c.core, c.sync) : [], seats: c.core.teamId ? seatsList(c.core, only) : [] };
}

route("GET", "/v1/seats", (c) => {
  const only = c.url.searchParams.get("seat") ?? undefined;
  if (only !== undefined && !EventId.safeParse(only).success) throw new HttpError(400, "invalid", "seat must be an event id");
  return json(view(c, only));
});

const ConfigReq = z.object({
  allow: z.boolean(),
  /** null = back to the default (the team's owners at the time of each request). */
  launchers: z.array(z.string().min(1).max(140)).max(50).nullable().optional(),
  max: z.number().int().min(1).max(MAX_CONCURRENT_LIMIT).nullable().optional(),
  runtimes: z.array(z.enum(SEAT_RUNTIMES)).min(1).max(3).nullable().optional(),
  dir: z.string().min(1).max(1_000).nullable().optional(),
  env: z.array(z.string().min(1).max(64)).max(50).nullable().optional(),
  /** Every seat as a fresh OS user made for it and destroyed after it (walkie seats setup-user). */
  ephemeral: z.boolean().nullable().optional(),
  admin: z.string().min(2).max(1_000).nullable().optional(),
  runner: z.string().min(2).max(1_000).nullable().optional(),
  runtime_dir: z.string().min(2).max(1_000).nullable().optional(),
  /** Seats may run as the daemon's own user: they can then act as this machine's person (SECURITY threat 13). */
  same_user: z.boolean().optional(),
  /** Seat users may read the person's home (it is open to other users): accepted knowingly. */
  accept_readable_home: z.boolean().optional(),
}).strict();

/** The audit line of a seats config change ("allowed seats: same-user, max 12, launchers @alex"). */
function seatsAction(b: z.infer<typeof ConfigReq>): string {
  const parts = [
    b.same_user ? "same-user" : null, b.ephemeral ? "a fresh OS user per seat" : null, b.max ? `max ${b.max}` : null,
    b.launchers?.length ? `launchers ${b.launchers.join(",")}` : b.launchers === null ? "launchers: the owners" : null,
    b.runtimes?.length ? `runtimes ${b.runtimes.join(",")}` : null, b.dir ? `dir ${b.dir}` : null, b.env?.length ? `env ${b.env.join(",")}` : null,
  ].filter(Boolean);
  return `${b.allow ? "allowed" : "turned off"} seats on this machine${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

/**
 * `walkie seats allow|deny`: this machine's own opt-in. Its person, or an agent of theirs (AGENT-ADMIN-1, audited); omitted fields keep their value. Turning seats
 * off is the machine's own emergency control: it works whatever the roster says (removed, revoked, observer).
 */
route("POST", "/v1/seats/config", async (c) => {
  const b = parseWith(ConfigReq, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, seatsAction(b));
  // The dashboard turns seats on or off (as seat users, or as the person); who may launch, runtimes, directories,
  // the runner, the helper and the rest stay with the CLI (Opus r10 LOW).
  const fields = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (c.via !== "cli" && fields.some((k) => k !== "allow" && k !== "same_user")) {
    throw new HttpError(403, "forbidden", "the dashboard only turns seats on or off; the rest is set with the CLI (walkie seats allow --help)");
  }
  if (b.allow) {
    requireTeam(c);
    if (c.core.me()?.role === "observer") throw new HttpError(403, "forbidden", "observers can't take seats (they can't post the results)");
  }
  for (const l of b.launchers ?? []) if (!parseLauncher(l)) throw new HttpError(400, "invalid", `not a launcher: ${l} (use @handle, @handle/machine or @handle/machine/agent)`);
  for (const n of b.env ?? []) {
    const problem = seatEnvNameProblem(n);
    if (problem) throw new HttpError(400, "invalid", problem);
  }
  if (b.dir && !(isAbsolute(b.dir) || b.dir === "~" || b.dir.startsWith("~/"))) throw new HttpError(400, "invalid", "dir must be an absolute path or start with ~/");
  if (b.runner && !isAbsolute(b.runner)) throw new HttpError(400, "invalid", "runner must be an absolute path");
  if (b.runtime_dir && !isAbsolute(b.runtime_dir)) throw new HttpError(400, "invalid", "runtime_dir must be an absolute path");
  if (b.admin && !isAbsolute(b.admin)) throw new HttpError(400, "invalid", "admin must be an absolute path");
  const h = host(c);
  const prev = h.settings;
  const pick = <K extends keyof SeatsConfig>(k: K, v: SeatsConfig[K] | null | undefined): Partial<SeatsConfig> => {
    if (v === undefined) return prev[k] !== undefined ? { [k]: prev[k] } : {};
    return v === null ? {} : { [k]: v };
  };
  const next: SeatsConfig = {
    allow: b.allow,
    // null (back to the owners) must stay null: `?.map` would turn it into undefined, "keep", and a named agent
    // would stay allowed after the reset (Codex HIGH 1).
    ...pick("launchers", b.launchers === null ? null : b.launchers?.map((l) => l.trim())),
    ...pick("max", b.max),
    // Kimi goes to its own key (config.json stays readable by an older daemon after a rollback: FO-2).
    ...runtimesPick(b.runtimes, prev),
    ...pick("dir", b.dir),
    ...pick("env", b.env === null ? null : b.env ? [...new Set(b.env)] : undefined),
    ...pick("ephemeral", b.ephemeral), ...pick("admin", b.admin), ...pick("runner", b.runner), ...pick("runtime_dir", b.runtime_dir), ...pick("same_user", b.same_user),
    ...pick("accept_readable_home", b.accept_readable_home),
    ...pick("env_file", undefined), // config.json only: never set through the API
  };
  // The host decides whether seats may run as configured (isolation.ts): seat users that are safe (not root, not
  // this user, not administrators, their own groups), a home they can't read, or the person's explicit --same-user.
  c.noTimeout();
  return json({ local: await h.configure(next) });
});

/** `runtimes` as config.json keeps it: Claude/Codex in `runtimes`, Kimi as `kimi` (a Kimi-only list is refused). */
function runtimesPick(list: SeatRuntime[] | null | undefined, prev: SeatsConfig): Partial<SeatsConfig> {
  if (list === undefined) return { ...(prev.runtimes ? { runtimes: prev.runtimes } : {}), ...(prev.kimi !== undefined ? { kimi: prev.kimi } : {}) };
  if (list === null) return {};
  const v1 = [...new Set(list.filter((r): r is "claude" | "codex" => r !== "kimi"))];
  if (!v1.length) throw new HttpError(400, "invalid", "list claude or codex too: a Kimi-only machine isn't supported yet (leaving --runtimes out allows Claude and Codex, not Kimi)");
  return { runtimes: v1, kimi: list.includes("kimi") };
}

const TokenReq = z.object({ token: z.string().regex(/^[A-Za-z0-9._~+/=-]{20,4096}$/, "not a token").nullable() }).strict();

/**
 * `walkie seats token set|clear`: a Claude token only this machine's seats use (optional; without one, seats run on
 * the machine's own Claude login). The machine's person only; the token never leaves this machine's Walkie home.
 */
route("POST", "/v1/seats/token", async (c) => {
  const b = parseWith(TokenReq, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, b.token ? "set the seats' own Claude token" : "cleared the seats' own Claude token");
  await host(c).setSeatToken(b.token);
  return json({ local: host(c).view() });
});

const RunReq = z.object({
  machine: z.string().min(1).max(100),
  runtime: z.enum(SEAT_RUNTIMES),
  model: SeatModel.optional(),
  permission_mode: z.enum(SEAT_MODES).optional(),
  /** v1: the prompt (inline in the request). v2: the brief's text, when `brief` isn't given. */
  prompt: z.string().min(1).max(MAX_SEAT_PROMPT).optional(),
  bundle: BlobHash.optional(),
  timeout_s: z.number().int().min(MIN_SEAT_TIMEOUT_S).max(MAX_SEAT_TIMEOUT_S).optional(),
  max_concurrent: z.number().int().min(1).max(MAX_CONCURRENT_LIMIT).optional(),
  // ---- v2 (FO-2): any of these (or runtime kimi) makes a `v: 2` request, which only hosts announcing seats_v2 run.
  v: z.literal(2).optional(),
  /** The brief's text (stored here as a blob; the request carries its hash, never the text). */
  brief: z.string().min(1).max(MAX_SEAT_BRIEF).optional(),
  label: SeatLabel.optional(),
  workspace: SeatWorkspace.optional(),
  account: SeatAccountKey.optional(),
  result_file: SeatResultFile.optional(),
}).strict();

/** Stores a v2 brief as a blob on this machine (the request is its reference; the host fetches it from here). */
function storeBrief(c: RouteCtx, text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_SEAT_BRIEF) throw new HttpError(400, "invalid", `the brief is over ${MAX_SEAT_BRIEF / 1000} KB`);
  const hash = writeBlob(c.core.paths.blobs, bytes);
  c.core.store.addBlob(hash, bytes.byteLength, "text/markdown", "seat-brief.md");
  return hash;
}

/** The admitted machine a launcher names (node id or hostname) and its seats channel, which I must be in. */
function target(c: RouteCtx, machine: string): { node: string; hostname: string; channel: string } {
  const n = activeNodes(c.core.roster).find((x) => x.node_id === machine || x.hostname === machine);
  if (!n) throw new HttpError(404, "not_found", `no admitted machine ${machine}`);
  const channel = seatsChannel(n.node_id);
  const ch = c.core.roster.channels.get(channel);
  const me = c.core.myHandle();
  if (!ch) throw new HttpError(409, "seats_not_allowed", `${n.hostname} doesn't take seats (its person turns them on with: walkie seats allow)`);
  if (!ch.members || !me || !ch.members.includes(me)) throw new HttpError(403, "forbidden", `you are not a launcher on ${n.hostname} (#${channel} doesn't include you)`);
  return { node: n.node_id, hostname: n.hostname, channel };
}

/**
 * `walkie seat run`: a signed launch request in the host's seats channel. The host decides (rules.ts); an agent's
 * request carries its name and is refused unless the host allows that agent by name.
 */
/**
 * A repo bundle for a seat request, stored on this machine only (no share: a seats channel carries seat requests
 * and the host's posts, nothing else, SEATS-FIX-8). The request that names it is its reference in the channel; the
 * host fetches it from here.
 */
route("POST", "/v1/seats/bundle", async (c) => {
  requireTeam(c);
  limitWrite(c);
  const bytes = await readBytes(c.req, MAX_BLOB_BYTES);
  if (bytes.byteLength === 0) throw new HttpError(400, "invalid", "empty bundle");
  const hash = writeBlob(c.core.paths.blobs, bytes);
  c.core.store.addBlob(hash, bytes.byteLength, "application/x-git-bundle", "seat-repo.bundle");
  return json({ hash });
});

/** Last-known pre-v2 replicas block dispatch, including offline and same-person nodes. */
export function requireV2Replicas(c: Pick<RouteCtx, "core" | "sync">, channel: string): void {
  for (const n of activeNodes(c.core.roster)) {
    if (n.node_id === c.core.nodeId) continue;
    const handle = c.core.roster.members.get(n.login)?.handle ?? null;
    if (!canSeeChannel(c.core.roster, channel, handle)) continue;
    const known = c.sync.peerCapabilities(n.node_id);
    if (known && !known.caps.includes(SEATS_V2_CAP)) {
      throw new HttpError(409, "seats_v2_replica_unsupported", `${n.hostname} replicates this seats channel but last advertised a pre-v2 version: update every channel replica before sending a v2 request`);
    }
  }
}

route("POST", "/v1/seats/run", async (c) => {
  requireTeam(c);
  const b = parseWith(RunReq, await readJson(c.req, LOCAL_BODY_MAX));
  limitWrite(c);
  const t = target(c, b.machine);
  if (b.bundle && !readBlob(c.core.paths.blobs, b.bundle)) {
    throw new HttpError(400, "invalid", "that repo bundle isn't on this machine (send it with POST /v1/seats/bundle, or walkie seat run --repo)");
  }
  const v2 = b.v === 2 || b.runtime === "kimi" || b.brief !== undefined || b.label !== undefined || b.workspace !== undefined || b.account !== undefined || b.result_file !== undefined;
  let seat: SeatRun | SeatRunV2;
  let text: string;
  // Never to a host whose daemon says it can't (a released pre.5 one ignores a v2 body): refused here instead.
  // The execution host must positively advertise support; protocol features do not depend on machine stats.
  if (v2 && t.node !== c.core.nodeId) {
    const capabilities = c.sync.peerCapabilities(t.node);
    if (!capabilities) {
      throw new HttpError(409, "seats_v2_unknown", `${t.hostname}'s Walkie hasn't said yet whether it takes v2 seat requests (no capabilities from it): retry in a minute`);
    }
    if (!capabilities.caps.includes(SEATS_V2_CAP)) {
      throw new HttpError(409, "seats_v2_unsupported", `${t.hostname} runs a Walkie that doesn't take v2 seat requests (Kimi, a brief, a workspace, an account or a result file): update it first`);
    }
  }
  if (v2) {
    requireV2Replicas(c, t.channel);
    if (b.bundle) throw new HttpError(400, "invalid", "a v2 request carries its repo as workspace (workspace.bundle for a delta bundle), not bundle");
    if (b.workspace?.bundle && !readBlob(c.core.paths.blobs, b.workspace.bundle)) {
      throw new HttpError(400, "invalid", "that workspace delta bundle isn't on this machine (send it with POST /v1/seats/bundle)");
    }
    if (b.runtime === "kimi" && b.permission_mode !== "bypassPermissions") throw new HttpError(400, "invalid", KIMI_FULL_ACCESS_ONLY);
    const briefSrc = b.brief ?? b.prompt;
    if (!briefSrc) throw new HttpError(400, "invalid", "a v2 request needs a brief (brief, or prompt)");
    const parsed = SeatRunV2.safeParse({
      op: "run", v: 2, runtime: b.runtime, ...(b.model ? { model: b.model } : {}), ...(b.permission_mode ? { permission_mode: b.permission_mode } : {}),
      brief: storeBrief(c, briefSrc), ...(b.label ? { label: b.label } : {}), ...(b.workspace ? { workspace: b.workspace } : {}),
      ...(b.account ? { account: b.account } : {}), ...(b.result_file ? { result_file: b.result_file } : {}),
      timeout_s: b.timeout_s ?? DEFAULT_SEAT_TIMEOUT_S, max_concurrent: b.max_concurrent ?? DEFAULT_MAX_CONCURRENT,
    });
    if (!parsed.success) throw new HttpError(400, "invalid", parsed.error.issues.map((i) => i.message).join("; ").slice(0, 300));
    seat = parsed.data;
    text = runTextV2(parsed.data, t.hostname);
  } else {
    if (!b.prompt) throw new HttpError(400, "invalid", "prompt is required");
    const run: SeatRun = {
      op: "run", v: 1, runtime: b.runtime as (typeof SEAT_RUNTIMES_V1)[number], ...(b.model ? { model: b.model } : {}), ...(b.permission_mode ? { permission_mode: b.permission_mode } : {}),
      prompt: b.prompt, ...(b.bundle ? { bundle: b.bundle } : {}),
      timeout_s: b.timeout_s ?? DEFAULT_SEAT_TIMEOUT_S, max_concurrent: b.max_concurrent ?? DEFAULT_MAX_CONCURRENT,
    };
    seat = run;
    text = runText(run, t.hostname);
  }
  const body = { text, seat } as unknown as BodyOf<"msg.post">;
  // An agent's request carries its name (hosts accept agents they name, never an unnamed one as its person: the CLI
  // under an agent's runtime marks its requests, add-machine's agent-detect.ts).
  if (c.underAgent && !c.agent) throw new HttpError(403, "agent_unnamed", "a seat request from an agent must name it (WALKIE_AGENT=<name>, or --agent): the host allows agents only by name");
  const event = c.core.emit("msg.post", body, { channel: t.channel, agent: c.agent });
  // Served to the host: we hold these bytes for this request (v2: the brief and the delta bundle).
  if (seat.v === 2) {
    c.core.store.addProvenance(t.channel, seat.brief);
    if (seat.workspace?.bundle) c.core.store.addProvenance(t.channel, seat.workspace.bundle);
  } else if (seat.bundle) c.core.store.addProvenance(t.channel, seat.bundle);
  // Whether its person is using it (the host decides; a busy host queues the launch unless it is below its limit).
  const availability = hostAvailability(c.core, t.node);
  return json({ event, seat: event.id, host: { ...t, ...(availability ? { availability } : {}) } });
});

const BusyReq = z.object({
  /** Seats that may keep running while the person uses the machine (default 1; 0 = none). */
  max: z.number().int().min(0).max(MAX_CONCURRENT_LIMIT).optional(),
  /** Resume by itself after this many seconds (default: until `POST /v1/seats/resume`). */
  for_s: z.number().int().min(1).max(MAX_BUSY_S).optional(),
}).strict();


/**
 * "I'm using this computer" (the machine's person only, like `seats allow`: no X-Walkie-Agent; the desktop tray
 * calls it over the unix socket, the dashboard over the loopback port). Returns this machine's seats view.
 */
route("GET", "/v1/seats/busy", (c) => json({ local: host(c).view() }));
route("POST", "/v1/seats/busy", async (c) => {
  const b = parseWith(BusyReq, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, `marked this machine busy (at most ${b.max ?? 1} seats${b.for_s ? ` for ${b.for_s} s` : ""})`);
  const by = c.core.myHandle() ?? "host";
  return json({ local: host(c).setBusy({ max: b.max ?? 1, by, ...(b.for_s !== undefined ? { forMs: b.for_s * 1000 } : {}) }) });
});
route("POST", "/v1/seats/resume", async (c) => {
  adminGate(c, "resumed seats (the person is done with this machine)");
  parseWith(z.object({}).strict(), await readJson(c.req, LOCAL_BODY_MAX)); // an empty body (or {})
  return json({ local: host(c).resume(c.core.myHandle() ?? "host") });
});

const StopReq = z.object({ seat: EventId }).strict();

/**
 * `walkie seat stop`: here if the seat runs on this machine (its person only, whatever the roster says: the
 * machine's own emergency control), else a stop request to its host.
 */
route("POST", "/v1/seats/stop", async (c) => {
  const b = parseWith(StopReq, await readJson(c.req, LOCAL_BODY_MAX));
  const local = seatsFor(c.core);
  if (local?.isRunning(b.seat)) {
    adminGate(c, `stopped seat ${b.seat} on this machine`);
    c.noTimeout();
    const r = await local.stopLocal(b.seat, c.core.myHandle() ?? "host");
    return json({ stopped: r.stopped ? "local" : "none", verified: r.verified, ...(r.why ? { why: r.why } : {}) });
  }
  requireTeam(c);
  const row = c.core.store.getRow(b.seat);
  const req = row && row.status === "ok" && row.redacted === 0 ? (JSON.parse(row.json) as Event) : null;
  const node = seatsChannelNode(req?.channel);
  if (!req || !node || seatOf(req.body)?.op !== "run" || !c.core.visible(req)) throw new HttpError(404, "not_found", "no such seat");
  const h = host(c);
  if (node === c.core.nodeId) {
    adminGate(c, `stopped seat ${b.seat} on this machine`);
    const r = await h.stopLocal(b.seat, c.core.myHandle() ?? "host");
    return json({ stopped: r.stopped ? "local" : "none", verified: r.verified, ...(r.why ? { why: r.why } : {}) });
  }
  // Like a launch: an agent's stop carries its name, never its person's (Codex r9 MEDIUM 1).
  if (c.underAgent && !c.agent) throw new HttpError(403, "agent_unnamed", "a seat stop from an agent must name it (WALKIE_AGENT=<name>, or --agent): the host allows agents only by name");
  limitWrite(c);
  const t = target(c, node);
  const event = c.core.emit("msg.post", {
    text: `Stop seat ${b.seat}`, thread: b.seat, seat: { op: "stop", v: 1, seat: b.seat },
  } as unknown as BodyOf<"msg.post">, { channel: t.channel, agent: c.agent });
  return json({ stopped: "requested", event });
});
