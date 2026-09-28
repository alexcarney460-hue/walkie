// AGENT-ADMIN-1 local API (PROTOCOL §5 "Admin"): the switches, the audit log, the machine list and remote admin.
import { z } from "zod";
import { MAX_REMOTE_TIMEOUT_S, RemoteRunRes, remoteArgvProblem, REMOTE_ERRORS, MAX_ARG, MAX_ARGV } from "../../protocol/admin.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import { PeerCallError } from "../peer-client.ts";
import { nodeMember, type NodeRec } from "../roster.ts";
import { appendAudit, readAudit, recordAdmin } from "./audit.ts";
import { adminGate, agentCaller, AGENT_ADMIN_OFF, localActor, personOnly } from "./gate.ts";
import { mayAdminister, resolveMachines, servePeerAdmin } from "./remote.ts";
import { readSwitches, writeSwitch } from "./switches.ts";

/** What the last remote admin call to each machine found (`ok`, or an error code), for `walkie admin machines`. */
const lastResult = new WeakMap<object, Map<string, { at: number; result: string }>>();

function noteResult(c: RouteCtx, nodeId: string, result: string): void {
  const m = lastResult.get(c.core) ?? new Map<string, { at: number; result: string }>();
  lastResult.set(c.core, m);
  m.set(nodeId, { at: Date.now(), result });
}

/** `@handle/machine` (a person) or `@handle/machine/agent`. */
function actorOf(c: RouteCtx): string {
  return agentCaller(c) ? localActor(c) : `@${c.core.myHandle() ?? "unknown"}/${c.core.hostname}`;
}

route("GET", "/v1/admin", (c) => {
  const limit = Math.min(Math.max(Number(c.url.searchParams.get("limit") ?? "20") || 20, 1), 200);
  return json({ ...readSwitches(c.core.paths.config), machine: c.core.hostname, audit: readAudit(c.core.paths.home, limit) });
});

const SwitchesReq = z.object({ agent_admin: z.boolean().optional(), remote_admin: z.boolean().optional() }).strict();

/**
 * The person's switches. Anyone on this machine may turn one OFF (an agent too: the safe direction); turning one back
 * ON is the machine's person's, at this machine (the CLI in their own terminal, or the dashboard), never an agent's
 * and never a paired phone's.
 */
route("POST", "/v1/admin/switches", async (c) => {
  const b = parseWith(SwitchesReq, await readJson(c.req, LOCAL_BODY_MAX));
  const cur = readSwitches(c.core.paths.config);
  const turningOn = (b.agent_admin === true && !cur.agent_admin) || (b.remote_admin === true && !cur.remote_admin);
  if (turningOn) {
    personOnly(c, "turn an admin switch back on");
    if (c.via === "phone") throw new HttpError(403, "person_only", "an admin switch is turned back on at the machine (its dashboard or terminal), not from a phone");
  }
  let next = cur;
  const changes: string[] = [];
  for (const k of ["agent_admin", "remote_admin"] as const) {
    const v = b[k];
    if (v === undefined || v === cur[k]) continue;
    next = writeSwitch(c.core.paths.config, k, v);
    changes.push(`${k === "agent_admin" ? "agent admin" : "remote admin"} ${v ? "on" : "off"}`);
  }
  if (changes.length) recordAdmin(c.core, { actor: actorOf(c), action: `turned ${changes.join(", ")}`, machine: c.core.hostname, via: "local" }, { post: true });
  return json(next);
});

const AuditReq = z.object({ action: z.string().min(1).max(600) }).strict();

/** The CLI's own admin steps (the vault, hooks, sudo setup, …): audited like a daemon route. People aren't recorded. */
route("POST", "/v1/admin/audit", async (c) => {
  const b = parseWith(AuditReq, await readJson(c.req, LOCAL_BODY_MAX));
  if (!agentCaller(c)) return json({ recorded: false });
  adminGate(c, b.action);
  return json({ recorded: true });
});

/** The team's machines, and whether this caller may administer each remotely (and what the last try found). */
route("GET", "/v1/admin/machines", (c) => {
  requireTeam(c);
  const me = c.core.me();
  if (!me) throw new HttpError(403, "forbidden", "this node is not an admitted member");
  const seen = lastResult.get(c.core);
  const machines = resolveMachines(c.core, "all").map((n) => {
    const may = mayAdminister(c.core, me, n);
    const last = seen?.get(n.node_id);
    return {
      hostname: n.hostname, node_id: n.node_id, handle: nodeMember(c.core.roster, n.node_id)?.handle ?? null,
      self: n.node_id === c.core.nodeId, online: n.node_id === c.core.nodeId || c.sync.isOnline(n.node_id),
      can_admin: may.ok, ...(may.ok ? {} : { why: may.why }),
      ...(n.node_id === c.core.nodeId ? readSwitches(c.core.paths.config) : {}),
      ...(last ? { last_result: last.result, last_at: last.at } : {}),
    };
  });
  return json({ machines, role: me.role, handle: me.handle });
});

const RunReq = z.object({
  machines: z.string().min(1).max(2_000),
  argv: z.array(z.string().max(MAX_ARG)).min(1).max(MAX_ARGV),
  timeout_s: z.number().int().min(1).max(MAX_REMOTE_TIMEOUT_S).optional(),
}).strict();

interface RunResult {
  machine: string; node_id: string; ok: boolean;
  exit?: number; stdout?: string; stderr?: string; truncated?: boolean; timed_out?: boolean;
  error?: { code: string; message: string };
}

/** The agent part the target records (`cc-d7395a`, `claude-code (unnamed)`), or undefined for a person. */
function agentPart(c: RouteCtx): string | undefined {
  if (!agentCaller(c)) return undefined;
  return localActor(c).split("/").slice(2).join("/").slice(0, 64);
}

async function runOn(c: RouteCtx, n: NodeRec, argv: string[], timeoutS: number | undefined): Promise<RunResult> {
  const base = { machine: n.hostname, node_id: n.node_id };
  const fail = (code: string, message: string): RunResult => { noteResult(c, n.node_id, code); return { ...base, ok: false, error: { code, message } }; };
  const me = c.core.me();
  if (!me) return fail("forbidden", "this node is not an admitted member");
  const may = mayAdminister(c.core, me, n);
  if (!may.ok) return fail(may.code, may.why);
  const agent = agentPart(c);
  const body = { argv, ...(agent ? { agent } : {}), ...(timeoutS ? { timeout_s: timeoutS } : {}) };
  try {
    const res = n.node_id === c.core.nodeId
      ? await servePeerAdmin(c.core, c.core.nodeId, me, body)
      : await callPeer(c, n, body, timeoutS);
    noteResult(c, n.node_id, "ok");
    return { ...base, ok: res.exit === 0, exit: res.exit, stdout: res.stdout, stderr: res.stderr, truncated: res.truncated, timed_out: res.timed_out };
  } catch (err) {
    if (err instanceof HttpError) return fail(err.code, err.message);
    if (err instanceof PeerCallError) {
      if (err.status === 404) return fail("target_outdated", `${n.hostname}: ${REMOTE_ERRORS.target_outdated} (then retry)`);
      if (err.status === 0) return fail("unreachable", `${n.hostname}: ${REMOTE_ERRORS.unreachable} (${err.message})`);
      return fail(err.code, `${n.hostname}: ${err.message}`);
    }
    return fail("error", `${n.hostname}: ${(err as Error).message}`);
  }
}

async function callPeer(c: RouteCtx, n: NodeRec, body: Record<string, unknown>, timeoutS: number | undefined): Promise<RemoteRunRes> {
  const addr = c.client.addrOf(n);
  if (!addr) throw new PeerCallError(0, "unreachable", "no transport both machines serve");
  return c.client.adminRun(addr, body, ((timeoutS ?? 300) + 15) * 1000);
}

/**
 * `walkie admin --machine <m> <command…>`: runs an allow-listed walkie command on team machines (see
 * src/protocol/admin.ts). Several machines run in parallel; each has its own result.
 */
route("POST", "/v1/admin/run", async (c) => {
  requireTeam(c);
  const b = parseWith(RunReq, await readJson(c.req, LOCAL_BODY_MAX));
  const problem = remoteArgvProblem(b.argv);
  if (problem) throw new HttpError(400, "not_allowed_remotely", problem);
  if (agentCaller(c) && !readSwitches(c.core.paths.config).agent_admin) throw new HttpError(403, "agent_admin_off", AGENT_ADMIN_OFF);
  const targets = resolveMachines(c.core, b.machines);
  appendAudit(c.core, { actor: actorOf(c), action: `asked ${targets.map((t) => t.hostname).join(", ")} to run walkie ${b.argv.join(" ")}`.slice(0, 600), machine: c.core.hostname, via: "local" });
  c.noTimeout();
  const results = await Promise.all(targets.map((n) => runOn(c, n, b.argv, b.timeout_s)));
  return json({ results, ok: results.every((r) => r.ok) });
});
