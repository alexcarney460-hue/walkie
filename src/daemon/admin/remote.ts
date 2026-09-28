// AGENT-ADMIN-1: remote admin, both ends. The caller's daemon resolves the machines and checks who may (an owner:
// any machine; anyone else: their own), then asks each target over the peer API (`POST /peer/v1/admin/run`). The
// target checks again with the roster's authenticated caller, its person's switches and the allow-list, runs
// `walkie <argv>` as its own OS user (no shell, stdin closed, a timeout, capped output), posts one audit line to the
// team naming the actor and mentioning its person, and returns the exit code and output.
import { redactSecrets } from "../../protocol/safety.ts";
import { canonicalArgv, remoteArgvProblem, remoteRosterProblem, REMOTE_ERRORS, DEFAULT_REMOTE_TIMEOUT_S, MAX_REMOTE_OUTPUT, RemoteRunReq, type RemoteRunRes } from "../../protocol/admin.ts";
import { walkieArgv } from "../../hooks/install.ts";
import type { Core } from "../core.ts";
import { HttpError, parseWith } from "../http.ts";
import { activeNodes, memberByHandle, nodeMember, type MemberRec, type NodeRec } from "../roster.ts";
import { appendAudit, recordAdmin } from "./audit.ts";
import { beginRun, claimSlot, MAX_RUNS, MAX_RUNS_PER_CALLER } from "./runs.ts";
import { readSwitches } from "./switches.ts";

/** Whether `caller` may administer `node` (an owner: any machine of the team; anyone else: their own). */
export function mayAdminister(core: Core, caller: MemberRec, node: NodeRec): { ok: true } | { ok: false; code: keyof typeof REMOTE_ERRORS; why: string } {
  const owner = nodeMember(core.roster, node.node_id);
  if (!owner) return { ok: false, code: "not_your_machine", why: `${node.hostname} is not an admitted machine of the team` };
  if (caller.role === "owner" || caller.handle === owner.handle) return { ok: true };
  return { ok: false, code: "not_your_machine", why: `${node.hostname} belongs to @${owner.handle}: ${REMOTE_ERRORS.not_your_machine}` };
}

/** Whether `caller` may administer THIS machine at all (checked before a remote admin request's body is read). */
export function mayAdministerHere(core: Core, caller: MemberRec): boolean {
  const mine = core.me();
  return !!mine && (caller.role === "owner" || caller.handle === mine.handle);
}

/** The machines `spec` names: a hostname or node id, a comma list, `all-mine` (the caller's own) or `all` (owners). */
export function resolveMachines(core: Core, spec: string): NodeRec[] {
  const me = core.me();
  if (!me) throw new HttpError(403, "forbidden", "this node is not an admitted member");
  const nodes = activeNodes(core.roster);
  if (spec === "all-mine") return nodes.filter((n) => nodeMember(core.roster, n.node_id)?.handle === me.handle);
  if (spec === "all") return nodes;
  const out: NodeRec[] = [];
  for (const name of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const hits = nodes.filter((n) => n.node_id === name || n.hostname === name);
    if (!hits.length) throw new HttpError(404, "not_found", `no admitted machine ${name}`);
    if (hits.length > 1) throw new HttpError(409, "ambiguous", `${hits.length} machines are named ${name}; give the node id (walkie admin machines --json)`);
    if (!out.includes(hits[0] as NodeRec)) out.push(hits[0] as NodeRec);
  }
  if (!out.length) throw new HttpError(400, "invalid", "name at least one machine");
  return out;
}

/** How long output may keep draining after the command exits or is killed (a grandchild may hold the pipes). */
const DRAIN_MS = 5_000;

/** Raw output kept past the cap, so a secret that crosses the cut is whole when it is redacted (round 3). */
const REDACT_MARGIN = 8 * 1024;

/**
 * The text returned for `raw` output (round 3): redacted FIRST, then cut to `max` characters, so a cut can never leave
 * part of a secret that no pattern matches any more. `raw` is at most max + REDACT_MARGIN bytes (capped() below).
 */
export function redactedOutput(raw: string, max = MAX_REMOTE_OUTPUT): { text: string; cut: boolean } {
  const clean = redactSecrets(raw).text;
  return clean.length > max ? { text: clean.slice(0, max), cut: true } : { text: clean, cut: false };
}

async function capped(stream: ReadableStream<Uint8Array>, stop: Promise<void>): Promise<{ text: string; truncated: boolean }> {
  const keep = MAX_REMOTE_OUTPUT + REDACT_MARGIN;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = stream.getReader();
  let stopped = false;
  void stop.then(() => { stopped = true; void reader.cancel().catch(() => undefined); });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || stopped) break;
      if (size >= keep) { truncated = true; continue; } // keep draining so the child never blocks
      const room = keep - size;
      chunks.push(value.byteLength > room ? value.slice(0, room) : value);
      if (value.byteLength > room) truncated = true;
      size += Math.min(value.byteLength, room);
    }
  } catch { /* cancelled at the drain deadline */ }
  // Secrets never leave the machine in a remote command's output (fix round 2), redacted before the cut (round 3).
  const out = redactedOutput(new TextDecoder().decode(Buffer.concat(chunks)));
  return { text: out.text, truncated: truncated || stopped || out.cut };
}

/** The environment of a remote run's walkie: this daemon's, marked, with the run's token (the CLI takes both out). */
function runEnv(core: Core, token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "WALKIE_ADMIN_TOKEN") env[k] = v;
  return { ...env, WALKIE_HOME: core.paths.home, WALKIE_SOCKET: core.paths.socket, WALKIE_AGENT: "remote-admin", WALKIE_ADMIN_TOKEN: token, NO_COLOR: "1", WALKIE_SETUP_REEXEC: "1" };
}

export interface RunOutcome { exit: number; stdout: string; stderr: string; truncated: boolean; timed_out: boolean; revoked?: boolean }

/** How often a running remote command re-checks that its caller may still administer this machine (round 3). */
export const REAUTH_MS = 30_000;

export interface RunGuard {
  /** Still allowed? False ends the run (its whole process group), reported as `revoked`. */
  readonly authorized?: () => boolean;
  readonly recheckMs?: number;
}

/**
 * Runs `walkie <argv>` on this machine for a remote actor: this daemon's own home and socket, marked as an agent
 * (`WALKIE_AGENT=remote-admin`, so every gate applies) with the run's token (the gates then name the remote actor).
 * Its own process group: a timeout ends the whole tree (SIGTERM, then SIGKILL); output drains for at most 5 s more.
 */
export async function runAdminArgv(
  core: Core, argv: readonly string[], actor: string, notify: string | null, timeoutS: number, guard: RunGuard = {},
): Promise<RunOutcome> {
  const run = beginRun(core, { actor, notify });
  try {
    const child = Bun.spawn([...walkieArgv(), ...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true, env: runEnv(core, run.token) });
    const group = (sig: "SIGTERM" | "SIGKILL") => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    let timedOut = false;
    let stopDrain: () => void = () => undefined;
    const drainStop = new Promise<void>((r) => { stopDrain = r; });
    let revoked = false;
    const end = () => { group("SIGTERM"); setTimeout(() => group("SIGKILL"), 5_000).unref?.(); };
    const timer = setTimeout(() => { timedOut = true; end(); }, timeoutS * 1000);
    // The caller demoted, removed or revoked (or the person switched remote admin off) mid-run: the run ends (round 3).
    const recheck = guard.authorized ? setInterval(() => {
      if (revoked || guard.authorized?.()) return;
      revoked = true;
      end();
    }, guard.recheckMs ?? REAUTH_MS) : null;
    const exited = child.exited.then((code) => {
      clearTimeout(timer);
      if (recheck) clearInterval(recheck);
      setTimeout(stopDrain, DRAIN_MS).unref?.();
      return code;
    });
    const [out, err, exit] = await Promise.all([capped(child.stdout, drainStop), capped(child.stderr, drainStop), exited]);
    stopDrain();
    return {
      exit: timedOut ? 124 : revoked ? 125 : exit, stdout: out.text,
      stderr: revoked ? `${err.text}${err.text && !err.text.endsWith("\n") ? "\n" : ""}walkie admin: stopped: the caller may no longer administer this machine\n` : err.text,
      truncated: out.truncated || err.truncated, timed_out: timedOut, ...(revoked ? { revoked: true } : {}),
    };
  } finally {
    run.end();
  }
}

/** A canonical command as a person would type it: command, positionals, then options. */
function readable(canonical: readonly string[]): string[] {
  const cut = canonical.indexOf("--");
  return cut < 0 ? [...canonical] : [canonical[0] as string, ...canonical.slice(cut + 1), ...canonical.slice(1, cut)];
}

/** A one-line summary of the command for the audit post. */
function commandLine(argv: readonly string[]): string {
  return `walkie ${argv.map((a) => (/^[\w@./:,=+-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}`;
}

/** The caller, as the roster has it now, may still administer this machine, and its person still allows remote admin. */
function stillAuthorized(core: Core, nodeId: string, handle: string): boolean {
  const cur = nodeMember(core.roster, nodeId);
  if (!cur || cur.role === "removed" || cur.handle !== handle || !mayAdministerHere(core, cur)) return false;
  const sw = readSwitches(core.paths.config);
  return sw.remote_admin && sw.agent_admin;
}

/**
 * The target's side (`POST /peer/v1/admin/run`): `member` on `nodeId` is the peer API's authenticated caller.
 */
export async function servePeerAdmin(core: Core, nodeId: string, member: MemberRec, raw: unknown): Promise<RemoteRunRes> {
  const b = parseWith(RemoteRunReq, raw);
  const callerNode = core.roster.nodes.get(nodeId);
  const self = core.roster.nodes.get(core.nodeId);
  const mine = core.me();
  if (!callerNode || !self || !mine) throw new HttpError(409, "no_team", "this machine is not an admitted member");
  const actor = `@${member.handle}/${callerNode.hostname}${b.agent ? `/${b.agent}` : ""}`;
  const refuse = (status: number, code: string, why: string): never => {
    appendAudit(core, { actor, action: commandLine(b.argv), machine: core.hostname, via: "remote", refused: code });
    throw new HttpError(status, code, why);
  };
  const may = mayAdminister(core, member, self);
  if (!may.ok) refuse(403, may.code, may.why);
  const sw = readSwitches(core.paths.config);
  if (!sw.remote_admin) refuse(403, "remote_admin_off", `${REMOTE_ERRORS.remote_admin_off} (${core.hostname}; they turn it back on with: walkie admin remote on)`);
  // The command runs here as an agent-marked walkie, so this machine's agent admin switch applies to it as well.
  if (!sw.agent_admin) refuse(403, "agent_admin_off", `${REMOTE_ERRORS.agent_admin_off} (${core.hostname})`);
  const problem = remoteArgvProblem(b.argv);
  if (problem) refuse(400, "not_allowed_remotely", problem);
  // What was checked is what runs: the canonical form, re-checked (fix round 2, Codex HIGH 1).
  const argv = canonicalArgv(b.argv);
  if (!argv || remoteArgvProblem(argv)) refuse(400, "not_allowed_remotely", "the command has no canonical form that passes the allow-list");
  // The caller as the roster has it NOW, not as it was when the request arrived (fix round 2, Codex HIGH 3): revoked,
  // removed or demoted while the body was on its way is refused.
  const current = nodeMember(core.roster, nodeId);
  if (!current || current.role === "removed" || !mayAdministerHere(core, current) || current.handle !== member.handle) {
    refuse(403, "not_your_machine", `the calling machine or its member no longer may administer ${core.hostname}`);
  }
  const rosterProblem = remoteRosterProblem(argv as string[], (h) => memberByHandle(core.roster, h)?.role ?? null);
  if (rosterProblem) refuse(400, "not_allowed_remotely", rosterProblem);
  const release = claimSlot(core, nodeId);
  if (!release) refuse(429, "busy", `${core.hostname} is running as many remote admin commands as it takes (${MAX_RUNS}, ${MAX_RUNS_PER_CALLER} per calling machine): retry when one finishes`);
  let res: RunOutcome;
  try {
    res = await runAdminArgv(core, argv as string[], actor, mine.handle, b.timeout_s ?? DEFAULT_REMOTE_TIMEOUT_S, {
      authorized: () => stillAuthorized(core, nodeId, member.handle),
    });
  } finally {
    release?.();
  }
  recordAdmin(core, {
    actor, via: "remote", machine: core.hostname,
    action: `ran \`${commandLine(readable(argv as string[]))}\` (${res.timed_out ? "timed out" : `exit ${res.exit}`})`,
  }, { post: true, notify: mine.handle });
  return { machine: core.hostname, ...res };
}
