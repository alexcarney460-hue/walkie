// walkie doctor: Tailscale, daemon, team, peers, clock skew, DB integrity, socket perms.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { claudeHooksDoctor } from "../../hooks/refresh.ts";
import { WalkieClient } from "../../client/index.ts";
import { tailscaleBinary, TailscaleIdentity } from "../../daemon/identity.ts";
import { defaultHome, pathsFor } from "../../daemon/paths.ts";
import { EXIT, type Ctx } from "../context.ts";
import { planLine } from "./license.ts";
import { c } from "../format.ts";
import type { MachineStats } from "../../protocol/machine-stats.ts";

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

function localChecks(out: Check[]): void {
  const paths = pathsFor(defaultHome());
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

async function daemonChecks(out: Check[]): Promise<void> {
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
  localChecks(checks);
  if (ctx.json) ctx.out(JSON.stringify({ checks }));
  else for (const ch of checks) ctx.out(`${MARK[ch.level]} ${ch.name.padEnd(18)} ${ch.detail}`);
  return checks.some((x) => x.level === "fail") ? EXIT.error : EXIT.ok;
}
