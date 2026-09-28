// init / invite / join / channel create / status / who
import { adminCtx, requireAdmin } from "../admin-gate.ts";
import { subagentLabel, subagentsText } from "../../protocol/subagents.ts";
import type { MemPressure } from "../../protocol/machine-stats.ts";
import { gb, memText, tempLevel, tempText } from "../../protocol/machine-stats-format.ts";
import { archiveCountText, hiddenByNode, needsPerson, shownByDefault, type ArchiveCount } from "../../protocol/agent-roster.ts";
import type { AgentView, MeView, NodeView, TeamView } from "../../protocol/schemas.ts";
import { agentDisplayName, ORCHESTRATOR_AGENT } from "../../protocol/orchestrator.ts";
import { agentViewJson, teamViewJson, WHO_NOTE } from "../agent-output.ts";
import { bool, channelArg, need, str, UsageError } from "../args.ts";
import { agentFrom, EXIT, requirePerson, type Ctx } from "../context.ts";
import { ago, c, pad, safeTerm } from "../format.ts";
import { planLine } from "./license.ts";
import { isolationLines, loginLines } from "./seats.ts";
import { allowTeamAgents, enableSeats } from "./seats-enable.ts";

/** --direct / --tailscale, or neither (the daemon decides: Tailscale when signed in, else Walkie Direct). */
export function transportFlag(ctx: Ctx): "direct" | "tailscale" | undefined {
  const direct = bool(ctx.args, "direct");
  const tailscale = bool(ctx.args, "tailscale");
  if (direct && tailscale) throw new UsageError("--direct and --tailscale are exclusive");
  return direct ? "direct" : tailscale ? "tailscale" : undefined;
}

/** What to tell an owner after creating a team: how teammates get in. */
export function inviteHint(me: MeView): string {
  return me.transport?.mode === "direct"
    ? `next: ${c.bold("walkie invite --handle <name>")} prints a one-time code; they run ${c.bold("walkie join <code>")}`
    : `next: ${c.bold(`walkie invite <tailscale-login> --handle <name>`)}, then they run ${c.bold(`walkie join ${joinTarget(me)}`)}`;
}

export async function init(ctx: Ctx): Promise<number> {
  const name = need(ctx.args, 0, "team name");
  const handle = str(ctx.args, "handle");
  if (!handle) throw new UsageError("--handle is required (your short name, e.g. --handle alex)");
  const me = await ctx.client().init(name, handle, transportFlag(ctx));
  const via = me.transport?.mode === "direct" ? " · Walkie Direct" : "";
  ctx.out(ctx.json ? JSON.stringify(me) : `${c.green("created team")} ${me.team?.name} (${me.team?.id}) — you are @${me.handle} (owner) on ${me.node.hostname}${via}
${inviteHint(me)}`);
  return EXIT.ok;
}

function roleArg(ctx: Ctx): string {
  const role = str(ctx.args, "role") ?? "member";
  if (!["owner", "member", "observer"].includes(role)) throw new UsageError("--role must be owner, member or observer");
  return role;
}

/** `walkie invite --handle kira`: a Walkie Direct invite code (single use, 7 days). */
async function inviteCode(ctx: Ctx, handle: string): Promise<number> {
  const client = await requireAdmin(ctx, `mint an invite code for @${handle}`, handle);
  const res = await client.inviteCode(handle, roleArg(ctx));
  if (ctx.json) { ctx.out(JSON.stringify(res)); return EXIT.ok; }
  const days = Math.max(1, Math.round((res.expires_at - Date.now()) / 86_400_000));
  ctx.out(`${c.green("invite")} for @${res.handle} (${res.role}${res.existing_member ? ", another machine" : ""}) · single use · expires in ${days} days\n\n` +
    `  ${c.bold(res.code)}\n\n` +
    `send it privately (anyone holding it can join as @${res.handle} once). They run:\n` +
    `  ${c.bold(`curl -fsSL ${INSTALL_URL} | sh -s -- --invite <code>`)}\n` +
    `already installed? ${c.bold("walkie join <code>")}`);
  return EXIT.ok;
}

export async function invite(ctx: Ctx): Promise<number> {
  const handle = str(ctx.args, "handle");
  if (!handle) throw new UsageError("--handle is required");
  if (ctx.args.pos.length === 0) return inviteCode(ctx, handle);
  const login = need(ctx.args, 0, "tailscale login (e.g. kira@github)");
  const client = await requireAdmin(ctx, `add ${login} to the team as @${handle}`, handle);
  const role = roleArg(ctx);
  const res = await client.invite(login, handle, role, str(ctx.args, "name"));
  if (ctx.json) { ctx.out(JSON.stringify(res)); return EXIT.ok; }
  const me = await client.me();
  ctx.out(`${c.green("invited")} ${login} as @${handle} (${role})\n` +
    `send them this (installs, then joins your team):\n  ${c.bold(`curl -fsSL ${INSTALL_URL} | sh -s -- --join ${joinTarget(me)}`)}\n` +
    `already installed? they run: ${c.bold(`walkie setup --join ${joinTarget(me)}`)}`);
  return EXIT.ok;
}

export async function join(ctx: Ctx): Promise<number> {
  const peer = need(ctx.args, 0, "invite code, or a teammate's Tailscale host / 100.x IP");
  // --allow-team-agents (alias --allow-seats) is the one-step opt-in (walkie seats enable): the person's, or an agent of
  // theirs applying the flag it was given (AGENT-ADMIN-1; audited once the machine is on the team).
  const allowSeatsToo = allowTeamAgents(ctx);
  if (allowSeatsToo) ctx = adminCtx(ctx, "let the team start agents on this machine");
  const res = await ctx.client().join(peer);
  if (res.admitted && !ctx.json) ctx.out(`${c.green("joined")} ${res.team?.name} as @${res.handle} (${res.role}) on ${res.node.hostname}`);
  const seatsView = res.admitted && allowSeatsToo
    ? await enableSeats(ctx, { sameUser: bool(ctx.args, "same-user"), acceptReadableHome: bool(ctx.args, "accept-readable-home") })
    : null;
  if (ctx.json) { ctx.out(JSON.stringify(seatsView ? { ...res, seats: seatsView } : res)); return res.admitted && (!allowSeatsToo || seatsView) ? EXIT.ok : EXIT.error; }
  if (res.admitted) {
    if (seatsView) {
      for (const line of isolationLines(seatsView)) ctx.out(line);
      for (const line of loginLines(seatsView)) ctx.out(line);
    }
    return allowSeatsToo && !seatsView ? EXIT.error : EXIT.ok;
  }
  const why: Record<string, string> = {
    not_member: "your Tailscale login is not on this team's roster — ask an owner to run: walkie invite <your-login> --handle <you>",
    pending_approval: "join request queued — an owner must approve it in the dashboard, then run walkie join again",
    not_authority: "the team's roster authority wasn't reachable to admit this machine — try again when it is online",
    plan_limit: "the team's plan has no room for another machine (Free includes 4) — an owner can run: walkie upgrade",
    node_limit: "the team's machine limit is reached — an owner can revoke unused machines",
    forbidden: "this machine was revoked from the team — an owner must re-admit it",
    invite_used: "that invite was already used — ask an owner for a new one (walkie invite --handle <you>)",
    invite_expired: "that invite expired — ask an owner for a new one (walkie invite --handle <you>)",
    invite_wrong_team: "that invite is for another team",
    invite_bad_signature: "that invite doesn't verify — copy the whole code again",
    invite_malformed: "that invite doesn't verify — copy the whole code again",
    invite_issuer_unknown: "the machine that made that invite isn't on the team",
    invite_issuer_not_owner: "the machine that made that invite no longer belongs to an owner — ask an owner for a new one",
    invite_predates_removal: "that invite was made before you were removed from the team — ask an owner for a new one",
  };
  ctx.err(c.red(`not admitted: ${why[res.reason ?? ""] ?? res.reason ?? "unknown reason"}`));
  return EXIT.error;
}

/**
 * `walkie direct enable` (mixed teams): this Tailscale machine also serves Walkie Direct, so teammates who joined
 * with an invite code can reach it. Run it on the roster authority before minting invite codes on a Tailscale team.
 */
export async function directCmd(ctx: Ctx): Promise<number> {
  const sub = need(ctx.args, 0, "subcommand (enable)");
  if (sub !== "enable") throw new UsageError(`unknown direct subcommand: ${sub}`);
  const res = await ctx.client().request<{ transports: string[]; advertised: boolean; reason?: string; direct: { endpoint: string; relay: string | null } | null }>("POST", "/v1/direct/enable", {}, 60_000);
  if (ctx.json) { ctx.out(JSON.stringify(res)); return EXIT.ok; }
  const endpoint = res.direct ? ` · endpoint ${res.direct.endpoint.slice(0, 16)}…` : "";
  ctx.out(`${c.green("walkie direct")} on — this machine serves ${res.transports.join(" + ")}${endpoint}`);
  ctx.out(res.advertised
    ? "the team's roster lists it; owners can now mint invite codes: walkie invite --handle <name>"
    : c.yellow(`not on the roster yet (${res.reason ?? "pending"}); it retries on its own. The roster authority must run walkie direct enable first.`));
  return EXIT.ok;
}

export async function channel(ctx: Ctx): Promise<number> {
  const sub = need(ctx.args, 0, "subcommand (create)");
  if (sub !== "create") throw new UsageError(`unknown channel subcommand: ${sub}`);
  const name = channelArg(need(ctx.args, 1, "channel name"));
  const membersRaw = str(ctx.args, "members");
  const members = membersRaw ? membersRaw.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean) : undefined;
  const isPublic = bool(ctx.args, "public");
  if (isPublic && members) throw new UsageError("--public and --members are exclusive");
  // Omitted fields keep their values (PROTOCOL §2): only --public makes a restricted channel team-wide.
  const res = await ctx.client().channel({ name, topic: str(ctx.args, "topic"), members, ...(isPublic ? { public: true } : {}) });
  ctx.out(ctx.json ? JSON.stringify(res) : `${c.green("channel")} #${name}${members ? ` (restricted to ${members.map((m) => "@" + m).join(", ")})` : isPublic ? " (public)" : ""}`);
  return EXIT.ok;
}

export async function status(ctx: Ctx): Promise<number> {
  const title = ctx.args.pos.join(" ");
  const agent = agentFrom(ctx.args) ?? "cli";
  const body: Record<string, unknown> = {
    agent, state: str(ctx.args, "state") ?? "working", runtime: str(ctx.args, "runtime") ?? "cli",
    ...(title ? { title } : {}), ...(str(ctx.args, "task") ? { task: str(ctx.args, "task") } : {}),
  };
  const res = await ctx.client().status(body, { title: "person", task: "person", activity: "phrase" }); // typed by a person
  ctx.out(ctx.json ? JSON.stringify(res) : res.event ? `${c.green("status")} ${agent}: ${body.state}${title ? ` — ${title}` : ""}` : c.dim("unchanged"));
  return EXIT.ok;
}

const STATE_COLOR: Record<string, (s: string) => string> = {
  working: c.green, idle: c.dim, waiting: c.yellow, blocked: c.red, offline: c.gray,
};

const LEVEL_COLOR: Record<MemPressure, (s: string) => string> = { normal: c.green, warn: c.yellow, critical: c.red };

/** "mem 11.7/16.0 GB (swap 2.7) · 67 °C", coloured by pressure / temperature band; grey (last known) when offline. */
export function statsDetail(n: NodeView): string {
  const s = n.stats;
  const swap = s?.mem && s.mem.swap_used >= 0.1 * 1024 ** 3 ? ` (swap ${gb(s.mem.swap_used)})` : "";
  const mem = `mem ${memText(s?.mem)}${swap}`;
  const temp = s?.temp_c == null ? "temp n/a" : `${tempText(s.temp_c)}${s.temp_src === "gpu" ? " GPU" : ""}`;
  if (!n.online) return c.gray(`${mem} · ${temp}${s ? " (last known)" : ""}`);
  const color = (l: MemPressure | null | undefined): ((x: string) => string) => (l ? LEVEL_COLOR[l] : c.dim);
  return `${color(s?.mem?.pressure)(mem)} · ${color(tempLevel(s?.temp_c ?? null))(temp)}`;
}

/**
 * People → machines → agents. By default (WALKIE-MISSION-1) only agents that are working or need a person are listed;
 * `hidden` (per machine: idle / offline agents left out) is shown as one line per machine pointing at the archive.
 * `hidden` undefined = every agent passed is listed (`walkie who --all`).
 */
export function renderWho(team: TeamView, agents: AgentView[], now = Date.now(), hidden?: readonly ArchiveCount[]): string {
  const lines: string[] = [];
  const online = team.nodes.filter((n) => n.online).length;
  const working = agents.filter((a) => a.effective_state === "working").length;
  const attention = agents.filter((a) => needsPerson(a.effective_state)).length;
  const rest = hidden ? hidden.reduce((n, h) => n + h.idle + h.offline, 0) : agents.length - working - attention;
  lines.push(`${c.bold(team.name)} ${c.dim(`(${team.id})`)} · ${team.nodes.length} machines · ${online} online · ${working} working · ${attention} need a person · ${rest} idle or offline`);
  if (team.plan) lines.push(c.dim(`plan: ${planLine(team.plan, now)}`));
  for (const m of team.members) {
    lines.push(`${c.bold("@" + m.handle)}  ${c.dim(m.role)}${m.display_name ? c.dim(` · ${m.display_name}`) : ""}`);
    const nodes = team.nodes.filter((n: NodeView) => n.handle === m.handle);
    if (!nodes.length) lines.push(c.dim("    (no machines joined yet)"));
    for (const n of nodes) {
      const dot = n.online ? c.green("●") : c.gray("○");
      const detail = n.self ? c.dim("this machine") : n.online ? `${n.rtt_ms ?? "?"} ms${n.sync.behind ? c.yellow(` · ${n.sync.behind} behind`) : ""}` : c.gray(n.last_seen ? `offline · seen ${ago(n.last_seen, now)} ago` : "offline · not seen yet");
      const net = n.transports?.includes("direct") ? (n.transports.includes("tailscale") ? " · tailscale+direct" : " · direct") : "";
      lines.push(`  ${dot} ${pad(n.hostname, 22)} ${detail}${c.dim(net)}${n.via === "relay" ? c.dim(" · via relay") : ""}${n.authority ? c.dim(" · roster authority") : ""}`);
      lines.push(`    ${pad("", 22)} ${statsDetail(n)}`);
      for (const a of agents.filter((x) => x.node === n.node_id)) {
        const st = a.effective_state;
        const label = a.status.title ?? (a.status.parent ? subagentLabel(a.status.subagent_type) : undefined);
        // ORCH-2: an orchestrator's line names its model.
        const model = a.agent === ORCHESTRATOR_AGENT && a.status.model ? `· ${a.status.model}` : "";
        const title = [label, a.status.task ? `(${a.status.task})` : "", model].filter(Boolean).join(" ");
        const subs = subagentsText(a.subagents?.working ?? 0);
        // A sub-agent (WALKIE-MISSION-SUB-1) is marked as its session's child.
        const name = a.status.parent ? `↳ ${a.agent}` : agentDisplayName(a.agent); // ORCH-2: WalkieTalkie
        lines.push(`      ${pad(name, 20)} ${pad((STATE_COLOR[st] ?? c.dim)(st), 9)} ${pad(safeTerm(title).slice(0, 60), 62)} ${c.dim(ago(a.updated_at, now))}${subs ? c.dim(` · ${subs}`) : ""}`);
      }
      const h = hidden?.find((x) => x.node === n.node_id);
      const text = h ? archiveCountText(h) : "";
      if (text) lines.push(c.dim(`      ${text} in the archive (walkie agents archive --machine ${safeTerm(n.hostname)})`));
    }
  }
  return lines.join("\n");
}

/**
 * `walkie team authority <node-or-hostname>`: move roster authority to another owner machine.
 * `walkie team revoke <node-or-hostname>`: revoke one machine (owner); the member keeps their other machines.
 * `walkie team role <handle> <role>`: change a member's role (owner).
 */
const ROLES = ["owner", "member", "observer", "removed"];

export async function teamCmd(ctx: Ctx): Promise<number> {
  const sub = need(ctx.args, 0, "subcommand (add-machine | authority | revoke | role)");
  if (sub === "role") return teamRole(ctx);
  if (sub === "add-machine") return addMachine(ctx);
  if (sub !== "authority" && sub !== "revoke") throw new UsageError(`unknown team subcommand: ${sub}`);
  const node = need(ctx.args, 1, "machine (node id or hostname)");
  if (sub === "revoke") {
    const res = await (await requireAdmin(ctx, `revoke the machine ${node}`, node)).revokeNode(node);
    if (ctx.json) { ctx.out(JSON.stringify(res)); return EXIT.ok; }
    ctx.out("queued" in res ? c.yellow("queued: the roster authority is offline; the machine is revoked when it comes back") : `${c.green("revoked")} ${node} — its key is refused from now on; it can't rejoin, even with a new invite`);
    return EXIT.ok;
  }
  await requirePerson(ctx, `move the roster authority to ${node}`, node); // a person's alone (AGENT-ADMIN-1 §3)
  const res = await ctx.client().setAuthority(node);
  if (ctx.json) { ctx.out(JSON.stringify(res)); return EXIT.ok; }
  ctx.out("queued" in res ? c.yellow("queued: the roster authority is offline; it moves when the authority comes back") : `${c.green("roster authority")} → ${node}`);
  return EXIT.ok;
}

/** `walkie team role <handle> <role>`: an owner changes a member's role (`removed` takes them off the team). */
async function teamRole(ctx: Ctx): Promise<number> {
  const handle = need(ctx.args, 1, "handle").replace(/^@/, "");
  const role = need(ctx.args, 2, `role (${ROLES.join(", ")})`);
  if (!ROLES.includes(role)) throw new UsageError(`role must be one of ${ROLES.join(", ")}`);
  // Removing a member stays a person's (AGENT-ADMIN-1 §3); any other role change is admin (an agent may, audited).
  const client = role === "removed" ? (await requirePerson(ctx, `remove @${handle} from the team`, handle), ctx.client()) : await requireAdmin(ctx, `make @${handle} ${role}`, handle);
  const res = await client.setRole(handle, role);
  const queued = (res as { queued?: boolean }).queued === true;
  ctx.out(ctx.json ? JSON.stringify(res) : queued ? c.yellow("queued: the roster authority is offline; the change applies when it comes back") : `${c.green("role")} @${handle} → ${role}`);
  return EXIT.ok;
}

/**
 * `walkie team add-machine <handle> [--json]` (owner, a person): one more machine for a current member — the
 * shareable link (the code only in its #fragment) and the install command pinned to this release. A person confirms
 * at a terminal by typing the handle (requirePerson); agents are refused, and the daemon refuses agent-marked calls.
 */
async function addMachine(ctx: Ctx): Promise<number> {
  const handle = need(ctx.args, 1, "handle (a current member, e.g. arvid)").replace(/^@/, "");
  const res = await (await requireAdmin(ctx, `mint an add-machine link for @${handle}`, handle)).addMachine(handle);
  if (ctx.json) { ctx.out(JSON.stringify(res)); return EXIT.ok; }
  const days = Math.max(1, Math.round((res.expires_at - Date.now()) / 86_400_000));
  ctx.out(`${c.green("add a machine")} for @${res.handle} (${res.role}) · works once, only for @${res.handle} · expires in ${days} days\n\n` +
    `send them this link (privately):\n  ${c.bold(res.link)}\n\n` +
    `or the command to run on the new machine:\n  ${c.bold(res.command)}\n` +
    (res.team_agents ? c.dim("(the installer asks them once whether the team may start agents on that machine; no is the default)") + "\n" : "") + "\n" +
    c.yellow(`anyone with this link or command can join once as one of @${res.handle}'s machines`));
  return EXIT.ok;
}

/** `walkie who --all` lists at most this many agents (newest first); the rest are counted. */
const WHO_ALL_LIMIT = 1_000;

/** `walkie who [--all]`: working agents and those needing a person; --all adds idle and offline ones (the archive). */
export async function whoCmd(ctx: Ctx): Promise<number> {
  const client = ctx.client();
  const all = bool(ctx.args, "all");
  const [team, payload] = await Promise.all([client.team(), client.agents(all ? { scope: "all", limit: WHO_ALL_LIMIT } : {})]);
  const listed = all ? payload.agents : payload.agents.filter(shownByDefault);
  const hidden = all ? undefined : hiddenByNode(payload.agents, payload.archive);
  // FINAL Codex 5: a model reads status titles as teammate text: defanged and labelled, never as instructions.
  // Release gate 2026-09-26 (Codex 1 / Fable 1): the team too (channel topics, peers' sync errors) is rebuilt
  // from an allowlist for a model's `--json`; a person's output is unchanged.
  const shown = ctx.forAgent ? listed.map(agentViewJson) : listed;
  // --all lists at most one page (the newest ARCHIVE_PAGE_MAX): say so when there are more (fix round 1, Opus 10).
  const notListed = all ? Math.max(0, (payload.total ?? listed.length) - listed.length) : 0;
  if (ctx.json) ctx.out(JSON.stringify({ team: ctx.forAgent ? teamViewJson(team) : team, agents: shown, ...(hidden ? { hidden } : {}), ...(all ? { total: payload.total ?? listed.length, truncated: notListed > 0 } : {}) }));
  else {
    const more = notListed ? `\n${c.dim(`… ${notListed} older agents not listed (walkie agents archive --machine <m> --offset <n>)`)}` : "";
    ctx.out(`${ctx.forAgent ? `${WHO_NOTE}\n` : ""}${renderWho(team, shown, Date.now(), hidden)}${more}`);
  }
  return EXIT.ok;
}

const INSTALL_URL = "https://getwalkie.vercel.app/install.sh";

/** "100.x.y.z", plus ":port" when the peer port isn't the default. */
function joinTarget(me: { node: { ip: string; port: number } }): string {
  return me.node.port && me.node.port !== 7458 ? `${me.node.ip}:${me.node.port}` : me.node.ip;
}
