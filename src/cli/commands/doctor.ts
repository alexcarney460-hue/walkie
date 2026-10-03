// walkie doctor: Tailscale, daemon, team, peers, clock skew, DB integrity, socket perms.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { claudeHooksDoctor } from "../../hooks/refresh.ts";
import { WalkieClient } from "../../client/index.ts";
import { tailscaleBinary, TailscaleIdentity } from "../../daemon/identity.ts";
import { defaultHome, pathsFor } from "../../daemon/paths.ts";
import { EXIT, type Ctx } from "../context.ts";
import { planLine } from "./license.ts";
import { c, safeTerm } from "../format.ts";
import type { MachineStats } from "../../protocol/machine-stats.ts";
import type { NodeView, TransportKind } from "../../protocol/schemas.ts";
import { enrollmentMode, grantSuspensionProblem, readGrant } from "../../daemon/provision/grant.ts";
import { observedStatus } from "../../daemon/provision/runner.ts";
import { executorFor } from "../../daemon/provision/executor.ts";
import { profile } from "../../daemon/provision/profiles.ts";
import { REVOCATION_UNSAVED_MESSAGE, sshRevocationProblem } from "../../daemon/ssh/state.ts";
import { join } from "node:path";
import { recSealCheck } from "../../daemon/orchestrator/rec-seal.ts";

type Level = "ok" | "warn" | "fail";
interface Check { level: Level; name: string; detail: string }

const MEMORY_WARNING = "this machine is low on memory and swapping; Walkie may stall: close idle apps or agents";

export function memoryCheck(stats: MachineStats | null | undefined): Check | null {
  const mem = stats?.mem;
  if (!mem) return null;
  const swapFull = mem.swap_total !== undefined && mem.swap_total > 0 && mem.swap_used / mem.swap_total > 0.8;
  return swapFull || mem.pressure === "critical"
    ? { level: "warn", name: "memory", detail: MEMORY_WARNING } : null;
}

const MARK: Record<Level, string> = { ok: c.green("✓"), warn: c.yellow("!"), fail: c.red("✗") };

async function tailscaleChecks(out: Check[]): Promise<void> {
  const bin = tailscaleBinary();
  if (!bin) { out.push({ level: "fail", name: "tailscale", detail: "CLI not found on PATH or in /Applications/Tailscale.app" }); return; }
  out.push({ level: "ok", name: "tailscale binary", detail: bin });
  const id = new TailscaleIdentity(bin);
  const ip = await id.selfIp();
  if (!ip) { out.push({ level: "fail", name: "tailscale ip", detail: "no IPv4 — is Tailscale logged in and connected?" }); return; }
  out.push({ level: "ok", name: "tailscale ip", detail: ip });
  const who = await id.whois(ip, new Headers());
  out.push(who
    ? { level: "ok", name: "whois self", detail: `${who.login} on ${who.nodeName}` }
    : { level: "fail", name: "whois self", detail: `tailscale whois ${ip} failed (tagged device or not logged in?)` });
}

/** `GET /v1/ssh/status`, as this machine's daemon answers it. */
export interface SshStatus {
  owner_key_present: boolean; owner_key_error?: string | null; tunnel_allowed: boolean; reason: string | null;
  server: { enabled: boolean; detail: string };
  /** This machine is the roster authority: it waits for its peers, not for an authority above it. */
  is_authority?: boolean;
  /** A revocation was saved nowhere (disk and team both failed): only this process's memory still refuses SSH. */
  revocation_unsaved?: boolean;
}

const WAITING_ON_AUTHORITY = "SSH waits for the team's authority to confirm access";
const WAITING_ON_PEERS = "SSH waits for every team machine that shares a transport with this one to confirm access (this machine is the team's authority)";

export function sshStatusChecks(ssh: SshStatus): Check[] {
  return [
    ...ssh.revocation_unsaved ? [{ level: "fail" as const, name: "owner ssh", detail: REVOCATION_UNSAVED_MESSAGE }] : [],
    { level: ssh.server.enabled ? "ok" : "warn", name: "ssh server", detail: ssh.server.detail },
    { level: ssh.owner_key_error ? "fail" : ssh.owner_key_present && !ssh.reason ? "ok" : "warn", name: "owner ssh key",
      detail: ssh.owner_key_error ?? (ssh.owner_key_present ? ssh.reason ? `still present; access denied (${ssh.reason})` : "authorized" : "absent") },
    { level: ssh.tunnel_allowed ? "ok" : "warn", name: "ssh tunnel", detail: ssh.tunnel_allowed ? "allowed through Walkie Direct"
      : ssh.reason === "ssh_team_waiting" ? ssh.is_authority ? WAITING_ON_PEERS : WAITING_ON_AUTHORITY : ssh.reason ?? "not allowed" },
  ];
}

async function localChecks(out: Check[]): Promise<void> {
  const paths = pathsFor(defaultHome());
  out.push(...await provisionChecks(paths.home));
  out.push(...vaultProbeLogChecks(paths.home));
  try {
    out.push(...sshStatusChecks(await new WalkieClient().request<SshStatus>("GET", "/v1/ssh/status")));
  } catch { /* Older daemons do not have this route. */ }
  try {
    for (const r of claudeHooksDoctor({ home: paths.home })) out.push({ level: r.level, name: "claude hooks", detail: r.detail });
  } catch (err) {
    out.push({ level: "warn", name: "claude hooks", detail: `~/.claude/settings.json unreadable: ${(err as Error).message}` });
  }
  if (existsSync(paths.socket)) {
    const mode = statSync(paths.socket).mode & 0o777;
    out.push({ level: mode & 0o077 ? "fail" : "ok", name: "socket perms", detail: `${paths.socket} mode ${mode.toString(8)}` });
  }
  if (existsSync(paths.key)) {
    const mode = statSync(paths.key).mode & 0o777;
    out.push({ level: mode & 0o077 ? "fail" : "ok", name: "node key perms", detail: `mode ${mode.toString(8)}` });
  }
  const seal = recSealCheck(paths.home);
  if (seal) out.push(seal);
  if (existsSync(paths.db)) {
    try {
      const db = new Database(paths.db, { readonly: true });
      const r = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
      db.close();
      out.push({ level: r?.integrity_check === "ok" ? "ok" : "fail", name: "db integrity", detail: r?.integrity_check ?? "no result" });
    } catch (err) {
      out.push({ level: "fail", name: "db integrity", detail: (err as Error).message });
    }
  }
}

/** Recent owner-side reasons stay local; borrower probes always receive only `unavailable`. */
export function vaultProbeLogChecks(home: string): Check[] {
  const path = join(home, "logs", "daemon.log");
  let lines: string[];
  try { lines = readFileSync(path, "utf8").slice(-64 * 1024).split("\n"); }
  catch { return []; }
  const reasons: string[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { msg?: unknown; reason?: unknown };
      if (event.msg === "vault_probe_denied" && typeof event.reason === "string" && /^[a-z_]{1,48}$/.test(event.reason)) reasons.push(event.reason);
    } catch { /* partial or unrelated log line */ }
  }
  return [...new Set(reasons.slice(-5))].map((reason) => ({ level: "warn", name: "vault probe", detail: `recent owner-side refusal: ${reason}` }));
}

/** Local grant and every selected profile step; a receipt is evidence of setup, not seat readiness. */
export async function provisionChecks(home: string, mode: (home: string) => boolean = enrollmentMode): Promise<Check[]> {
  try {
    const grant = readGrant(home);
    const enrolled = mode(home);
    if (grant && !enrolled) return [{ level: "fail", name: "provision", detail: "root enrollment marker is missing: grant cannot authorize seats" }];
    if (enrolled && !grant) return [{ level: "fail", name: "provision", detail: "enrollment grant is missing: renew local consent, or disable seats and run walkie provision unenroll locally" }];
    if (!grant) return [];
    if (grant.owner_ssh) {
      const revocation = sshRevocationProblem(home);
      if (revocation && revocation !== "revoked") return [{ level: "fail", name: "owner ssh", detail: `SSH revocation incomplete: ${revocation}` }];
    }
    if (grantSuspensionProblem(home, grant)) return [{ level: "fail", name: "provision", detail: "grant suspended: SSH install failed; revoke and renew local consent" }];
    if (grant.revoked_at) return [{ level: "warn", name: "provision", detail: "enrollment grant revoked" }];
    if (grant.owner_ssh && grant.ssh_state !== "active") return [{ level: "fail", name: "provision", detail: "owner SSH enrollment pending or denied" }];
    if (grant.expires_at <= Date.now()) return [{ level: "fail", name: "provision", detail: "enrollment grant expired; renew local consent" }];
    if (grant.profiles.some((selected) => selected.version !== profile(selected.id)?.version)) {
      return [{ level: "fail", name: "provision", detail: "profile version changed: revoke the old grant, renew local consent, then run walkie provision reset --profile <id>" }];
    }
    const all = await Promise.all(grant.profiles.map(async ({ id }) => {
      const journal = await observedStatus(home, id, executorFor(home));
      return journal.steps.map((s) => ({
        level: s.state === "done" ? "ok" as const : ["failed", "uncertain", "started", "drift"].includes(s.state) ? "fail" as const : "warn" as const,
        name: `provision ${s.id}`, detail: `${id} v${journal.version}: ${s.state}${s.reason ? ` (${s.reason})` : s.state === "started" ? " (running or interrupted)" : ""}`,
      }));
    }));
    return all.flat();
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    return [{ level: "fail", name: "provision", detail: message.includes("walkie provision migrate-enrollment")
      ? "enrollment migration requires local elevation: run walkie provision migrate-enrollment"
      : message === "profile journal version mismatch"
        ? "profile version changed: renew local consent, then run walkie provision reset --profile <id>"
        : "private grant or receipt is unreadable" }];
  }
}

interface Diag {
  pending: number; conflicts: { origin: string; n: number }[]; peer_listen: string | null; now: number;
  /** v0.1.2+: the peer API's state; older daemons only report peer_listen. */
  peer_api?: { state: "up"; listen: string } | { state: "retrying"; reason: string; next_in_ms: number };
  /** v0.2: the transport, and Walkie Direct's endpoint while it runs. */
  transport?: "direct" | "tailscale" | null; direct?: { endpoint: string; relay: string | null } | null;
  stats?: MachineStats | null;
}

/** "walkie direct: endpoint … · relay …" on a Direct node. */
export function directCheck(diag: Diag): Check {
  const d = diag.direct;
  if (!d) return { level: "fail", name: "walkie direct", detail: "not running — see ~/.walkie/logs/daemon.log (direct_start_failed)" };
  return {
    level: d.relay ? "ok" : "warn", name: "walkie direct",
    detail: `endpoint ${d.endpoint.slice(0, 16)}… · ${d.relay ? `relay ${d.relay}` : "no relay yet (direct paths only until one connects)"}`,
  };
}

/** "peer api: retrying (next in Ns): <reason>" while the daemon waits for Tailscale (src/daemon/peer-link.ts). */
export function peerApiCheck(diag: Diag): Check {
  const p = diag.peer_api;
  if (p?.state === "retrying") return { level: "fail", name: "peer api", detail: `retrying (next in ${Math.ceil(p.next_in_ms / 1000)}s): ${p.reason}` };
  if (p?.state === "up") return { level: "ok", name: "peer api", detail: `listening on ${p.listen}` };
  return diag.peer_listen
    ? { level: "ok", name: "peer api", detail: `listening on ${diag.peer_listen}` }
    : { level: "fail", name: "peer api", detail: "not listening (no Tailscale IP)" };
}

/** Machine names in a doctor line: at most this many, then "and N more". */
const UNREACHED_NAMES_SHOWN = 8;

/**
 * Mixed teams (PROTOCOL §4 "Mixed teams"): machines this one shares no transport with, a Tailscale-only machine and a
 * Direct-only one. Their agents show here only while another machine that reaches them is in sync (the daemon's
 * `NodeView.unreached`); when none is, they are hidden, and the wording says which case it is. `serving` is what this
 * machine serves now. Nothing to say when it reaches every machine (a dual machine reaches both kinds).
 *
 * Always a warning, never a failure: it reports other machines' reachability, not this machine's health, and doctor's
 * exit status follows failures. The macOS company-machine join (a Direct-only machine) runs `walkie doctor` last and
 * treats a non-zero exit as a failed join, skipping its owner-SSH step.
 */
export function unreachedCheck(serving: readonly TransportKind[], nodes: readonly NodeView[]): Check | null {
  const gone = nodes.filter((n) => !n.self && n.unreached !== undefined);
  if (!gone.length) return null;
  const names = gone.map((n) => safeTerm(n.hostname));
  const list = names.length > UNREACHED_NAMES_SHOWN
    ? `${names.slice(0, UNREACHED_NAMES_SHOWN).join(", ")} and ${names.length - UNREACHED_NAMES_SHOWN} more` : names.join(", ");
  const many = gone.length > 1;
  const them = many ? "them" : "it";
  const their = many ? "their" : "its";
  const off = many ? "those machines are off" : "that machine is off";
  const directOnlyHere = serving.includes("direct") && !serving.includes("tailscale");
  const hidden = gone.every((n) => n.unreached?.vouched === false);
  const subject = `${gone.length} ${many ? "machines use" : "machine uses"} only ${directOnlyHere ? "Tailscale" : "Walkie Direct"} (${list})`;
  const effect = hidden
    ? `no machine that reaches ${them} is in sync now, so ${their} agents are hidden here (or ${off})`
    : `${their} agents show here only while another machine that reaches ${them} is in sync`;
  const fix = directOnlyHere ? "Tailscale is optional on this machine; the other machines should run walkie direct enable" : "walkie direct enable";
  return { level: "warn", name: "mixed transports", detail: `${subject} and this machine can't reach ${them}: ${effect}. Fix: ${fix}` };
}

export async function daemonChecks(out: Check[]): Promise<void> {
  const client = new WalkieClient({ timeoutMs: 5_000 });
  try {
    const h = await client.healthz();
    out.push({ level: "ok", name: "daemon", detail: `up, v${h.version} (${client.socket})` });
  } catch {
    out.push({ level: "fail", name: "daemon", detail: `not reachable at ${client.socket} — run: walkie daemon start` });
    return;
  }
  const me = await client.me();
  const direct = me.transport?.mode === "direct";
  if (!me.tailscale.ok && !direct) out.push({ level: "warn", name: "daemon tailscale", detail: me.tailscale.error ?? "identity unavailable" });
  const diag = await client.request<Diag>("GET", "/v1/diag");
  const memory = memoryCheck(diag.stats);
  if (memory) out.push(memory);
  out.push(direct ? directCheck(diag) : peerApiCheck(diag));
  if (!direct && me.transport?.transports?.includes("direct")) out.push(directCheck(diag)); // a dual machine: both
  if (!me.team) { out.push({ level: "warn", name: "team", detail: "none yet — walkie setup, walkie join <invite-code>, or walkie init <name> --handle <you>" }); return; }
  out.push({ level: me.handle ? "ok" : "fail", name: "team", detail: `${me.team.name} (${me.team.id}) as @${me.handle ?? "?"} (${me.role ?? "not admitted"})` });
  if (me.plan) {
    const over = me.plan.seats.limit !== null && me.plan.seats.used > me.plan.seats.limit;
    out.push({ level: me.plan.status === "grace" || over ? "warn" : "ok", name: "plan", detail: planLine(me.plan) });
  }
  if (diag.pending) out.push({ level: "warn", name: "pending events", detail: `${diag.pending} held awaiting roster/ask` });
  for (const cf of diag.conflicts) out.push({ level: "fail", name: "conflict", detail: `origin ${cf.origin}: ${cf.n} conflicting event(s) — that node may have lost its DB` });
  const { nodes } = await client.peers();
  for (const n of nodes.filter((x) => !x.self)) {
    const label = `peer ${n.hostname}`;
    if (n.via === "relay") {
      // Mixed teams: no transport in common (Tailscale-only vs Direct-only); its events come through dual machines.
      out.push({ level: n.online ? "ok" : "warn", name: label, detail: `${n.online ? "online" : "offline"}, synced through other machines (no transport in common)` });
      continue;
    }
    if (!n.online) { out.push({ level: "warn", name: label, detail: `offline${n.sync.error ? ` (${n.sync.error})` : ""}` }); continue; }
    out.push({ level: n.sync.behind ? "warn" : "ok", name: label, detail: `${n.rtt_ms ?? "?"} ms rtt, ${n.sync.behind} behind` });
    if (n.sync.skew_ms !== undefined && Math.abs(n.sync.skew_ms) > 5_000) {
      out.push({ level: "warn", name: `clock ${n.hostname}`, detail: `skew ${(n.sync.skew_ms / 1000).toFixed(1)} s vs this machine` });
    }
  }
  const unreached = unreachedCheck(me.transport?.transports ?? nodes.find((x) => x.self)?.transports ?? ["tailscale"], nodes);
  if (unreached) out.push(unreached);
}

/** The daemon's transport (null when it isn't reachable or hasn't picked one). */
async function daemonMode(): Promise<"direct" | "tailscale" | null> {
  try {
    return (await new WalkieClient({ timeoutMs: 5_000 }).me()).transport?.mode ?? null;
  } catch {
    return null;
  }
}

export async function doctor(ctx: Ctx): Promise<number> {
  const checks: Check[] = [];
  // A Walkie Direct node doesn't use Tailscale: its checks would only be noise.
  if (await daemonMode() === "direct") checks.push({ level: "ok", name: "transport", detail: "Walkie Direct (Tailscale not needed)" });
  else await tailscaleChecks(checks);
  await daemonChecks(checks);
  await localChecks(checks);
  if (ctx.json) ctx.out(JSON.stringify({ checks }));
  else for (const ch of checks) ctx.out(`${MARK[ch.level]} ${ch.name.padEnd(18)} ${ch.detail}`);
  return checks.some((x) => x.level === "fail") ? EXIT.error : EXIT.ok;
}
