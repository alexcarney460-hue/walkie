// walkie talkie start|stop|status|model|access|say|log (PROTOCOL §8; `walkie orchestrator …` is the same command, kept
// for compatibility: ORCH-2 renamed it WalkieTalkie for people, the API and agent name stay "orchestrator"). The
// conversation is local to this machine (ORCH-FIX-11): these talk to this machine's own host; no other device reaches it.
import { adminCaller, adminCtx } from "../admin-gate.ts";
import { resolve } from "node:path";
import { WalkieClient } from "../../client/index.ts";
import { MODEL_ALIASES, ORCHESTRATOR_ACCESS, PERMISSION_MODES, validModel, type OrchMessage, type OrchestratorAccess, type OrchestratorView, type PermissionMode } from "../../protocol/orchestrator.ts";
import { bool, int, str, UsageError } from "../args.ts";
import { EXIT, readStdin, TERMINAL, type Ctx } from "../context.ts";
import { ago, c, hhmm, safeTerm } from "../format.ts";

const USAGE = "talkie start [--here] [--access platform|full] [--model m] [--cwd path] [--permission-mode default|acceptEdits|bypassPermissions] [--claude path]"
  + " | model <default|opus|sonnet|haiku|fable|full-id> | access <platform|full> | lead-eligible <on|off> | auto | stop | status | say <text…|-> [--new] [--thread id] [--timeout 600] | log [--limit 20]";

const START_HINT = "start it on this machine: walkie talkie start";

export async function orchestrator(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos[0];
  // Talking to it and reading its conversation are the person's alone (an agent's words would be read as theirs), never
  // an agent's: an agent runtime's marker or ancestor process, or --for-agent (agent-detect.ts). Starting, stopping and
  // its status are admin (AGENT-ADMIN-1): an agent of the person's may, audited by the daemon.
  // An unattended caller (no terminal) counts as an agent here too (fix round 2, Codex MEDIUM 4): the conversation is
  // reached from a person's terminal or the dashboard only.
  const marker = ctx.agentMarker();
  const agent = marker !== null || ctx.args.flags.get("for-agent") === true || adminCaller(ctx).kind === "agent";
  if (agent && sub === "lead-eligible") return refused(ctx, sub, marker);
  const admin = sub === "start" || sub === "stop" || sub === "status" || sub === "model" || sub === "access" || sub === "auto" || sub === undefined;
  if (agent && !admin) return refused(ctx, sub ?? "status", marker);
  // A person's client sends no agent header (never the environment's WALKIE_AGENT); an agent's is marked.
  const client = agent ? adminCtx(ctx, `talkie ${sub ?? "status"}`).client() : new WalkieClient({ agent: "" });
  switch (sub) {
    case "start": return start(ctx, client, agent);
    case "stop": return stop(ctx, client);
    case "model": return model(ctx, client);
    case "access": return access(ctx, client);
    case "lead-eligible": return leadEligible(ctx, client);
    case "auto": return auto(ctx, client);
    case "status": case undefined: return status(ctx, client);
    case "say": return say(ctx, client);
    case "log": return log(ctx, client);
    default: throw new UsageError(`unknown subcommand "${sub}" (${USAGE})`);
  }
}

async function leadEligible(ctx: Ctx, client: WalkieClient): Promise<number> {
  const value = ctx.args.pos[1];
  if ((value !== "on" && value !== "off") || ctx.args.pos.length !== 2) throw new UsageError("talkie lead-eligible on|off");
  const result = await client.orchestratorLeadEligible(value === "on");
  ctx.out(ctx.json ? JSON.stringify(result) : `WalkieTalkie VM leadership eligibility ${value}`);
  return EXIT.ok;
}

function refused(ctx: Ctx, sub: string, marker: string | null): number {
  ctx.err(`${c.red("walkie:")} talkie ${sub} is for people (agents may start, stop, configure and check it): WalkieTalkie takes instructions only from you, `
    + "typed in this machine's dashboard or your own terminal, never from an agent."
    + (marker ? ` This terminal looks like an agent's (${marker}); use the dashboard's WalkieTalkie tab or a plain terminal.` : ""));
  return EXIT.error;
}

function stateLine(v: OrchestratorView): string {
  const l = v.local;
  if (l.state === "standby") return `${c.cyan("standby")}${l.lead ? ` (lead: ${safeTerm(l.lead)})` : " (no lead machine yet)"} — the team's WalkieTalkie runs on its lead machine`;
  if (l.state === "needs_login") return `${c.yellow("needs a model login")} — ${safeTerm(l.needs ?? "sign in to Claude Code on this machine (run: claude)")}`;
  if (l.state === "failed") return `${c.red("failed")} — ${safeTerm(l.last_error ?? "WalkieTalkie keeps failing")} · restart: walkie talkie start`;
  if (!l.running && l.stopped_by_hand) return `${c.yellow("stopped by you")} — resume it (automatic again): walkie talkie auto`;
  if (!l.running && l.auto) return `${c.dim("starting")} — it starts on its own on this machine`;
  if (!l.running) return `${c.yellow("not running")} — ${START_HINT}`;
  const state = l.state === "working" ? c.green("working") : c.dim(l.state);
  const extra = [l.model, l.started_at ? `started ${ago(l.started_at)} ago` : ""].filter(Boolean).join(" · ");
  return `running on this machine · ${state}${extra ? c.dim(` · ${extra}`) : ""}`;
}

async function start(ctx: Ctx, client: WalkieClient, agent: boolean): Promise<number> {
  if (agent && (str(ctx.args, "claude") !== undefined || str(ctx.args, "cwd") !== undefined)) {
    throw new UsageError("only a person can choose WalkieTalkie’s binary or folder");
  }
  const mode = str(ctx.args, "permission-mode");
  if (mode !== undefined && !PERMISSION_MODES.includes(mode as PermissionMode)) {
    throw new UsageError(`--permission-mode must be one of ${PERMISSION_MODES.join(", ")}`);
  }
  const modelName = str(ctx.args, "model");
  if (modelName !== undefined && !validModel(modelName)) throw new UsageError(MODEL_USAGE);
  const access = str(ctx.args, "access");
  if (access !== undefined && !ORCHESTRATOR_ACCESS.includes(access as OrchestratorAccess)) {
    throw new UsageError(`--access must be one of ${ORCHESTRATOR_ACCESS.join(", ")}`);
  }
  // ORCH-2: another machine leads the team's WalkieTalkie: starting here too means two running, so ask first.
  const now = await client.orchestrator();
  if (!now.local.running && now.local.lead && !bool(ctx.args, "here")) {
    const q = `WalkieTalkie is already running on ${safeTerm(now.local.lead)}; start here anyway? [y/N] `;
    const io = ctx.person ?? TERMINAL;
    if (!io.interactive()) { ctx.err(`${c.red("walkie:")} ${q.replace(" [y/N] ", "")} Pass --here to start it here too.`); return EXIT.error; }
    const a = await io.ask(q).catch(() => "");
    if (!/^y(es)?$/i.test(a.trim())) { ctx.out(c.dim("not started")); return EXIT.ok; }
  }
  const claude = str(ctx.args, "claude") ?? Bun.which("claude") ?? undefined;
  const view = await client.orchestratorStart({
    ...(modelName ? { model: modelName } : {}),
    ...(!agent ? { cwd: resolve(str(ctx.args, "cwd") ?? process.cwd()) } : {}),
    ...(mode ? { permission_mode: mode as PermissionMode } : {}),
    ...(access ? { access: access as OrchestratorAccess } : {}),
    ...(!agent && claude ? { claude: resolve(claude) } : {}),
    ...(!agent && process.env.PATH ? { path: process.env.PATH } : {}),
  });
  if (ctx.json) { ctx.out(JSON.stringify(view)); return EXIT.ok; }
  const l = view.local;
  ctx.out(`${c.green("WalkieTalkie started")} on this machine · Claude${l.model ? ` (${l.model})` : ""} · ${accessLabel(l)} · cwd ${l.cwd ?? "~"}`);
  ctx.out(c.dim(`talk to it: walkie talkie say "…"  or this machine's dashboard (WalkieTalkie tab); the conversation stays on this machine`));
  return EXIT.ok;
}

/** "platform access (Walkie tools allowed) · default permissions", or "full access". */
function accessLabel(l: OrchestratorView["local"]): string {
  return (l.access ?? "platform") === "full" ? "full access" : `platform access (Walkie tools allowed) · ${l.permission_mode ?? "default"} permissions`;
}

const MODEL_USAGE = `the model is default, ${MODEL_ALIASES.join(", ")} or a full model id (letters, digits and . _ : - [ ])`;

/** `walkie talkie auto` (pre.8): back to automatic, from a start or a stop by hand. */
async function auto(ctx: Ctx, client: WalkieClient): Promise<number> {
  const v = await client.orchestratorAuto();
  if (ctx.json) { ctx.out(JSON.stringify(v)); return EXIT.ok; }
  ctx.out(`${c.green("automatic")}: WalkieTalkie runs here when this machine leads the team, else it stands by`);
  return EXIT.ok;
}

/** `walkie talkie access platform|full` (ORCH-2): the access changes, keeping the conversation. */
async function access(ctx: Ctx, client: WalkieClient): Promise<number> {
  const name = ctx.args.pos[1];
  if (!name || ctx.args.pos.length > 2 || !ORCHESTRATOR_ACCESS.includes(name as OrchestratorAccess)) {
    throw new UsageError(`the access is ${ORCHESTRATOR_ACCESS.join(" or ")}`);
  }
  const v = await client.orchestratorAccess(name as OrchestratorAccess);
  if (ctx.json) { ctx.out(JSON.stringify(v)); return EXIT.ok; }
  ctx.out(`${c.green("access")} ${accessLabel(v.local)} (the conversation continues)`);
  return EXIT.ok;
}

/** `walkie talkie model <name>` (ORCH-2): switches the model, keeping the conversation. */
async function model(ctx: Ctx, client: WalkieClient): Promise<number> {
  const name = ctx.args.pos[1];
  if (!name || ctx.args.pos.length > 2 || !validModel(name)) throw new UsageError(MODEL_USAGE);
  const v = await client.orchestratorModel(name);
  if (ctx.json) { ctx.out(JSON.stringify(v)); return EXIT.ok; }
  const l = v.local;
  ctx.out(l.model_pending
    ? `${c.green("switching")} to ${safeTerm(l.model_pending)} when the reply in progress ends (the conversation continues)`
    : `${c.green("switched")} to ${safeTerm(l.model_setting ?? name)} (the conversation continues)`);
  return EXIT.ok;
}

async function stop(ctx: Ctx, client: WalkieClient): Promise<number> {
  const res = await client.orchestratorStop();
  if (ctx.json) { ctx.out(JSON.stringify(res)); return EXIT.ok; }
  ctx.out(res.stopped === "local"
    ? `${c.green("stopped")} WalkieTalkie on this machine (it stays stopped until you start it: walkie talkie start)`
    : c.dim("WalkieTalkie isn't running here; it stays stopped until you start it: walkie talkie start"));
  return EXIT.ok;
}

async function status(ctx: Ctx, client: WalkieClient): Promise<number> {
  const v = await client.orchestrator();
  if (ctx.json) { ctx.out(JSON.stringify(v)); return EXIT.ok; }
  ctx.out(`WalkieTalkie: ${stateLine(v)}`);
  if (v.local.logins) ctx.out(c.dim(`model logins here: ${v.local.logins.length ? v.local.logins.join(", ") : "none"}`));
  const l = v.local;
  if (l.running) ctx.out(c.dim(`session ${l.session ?? "-"} · cwd ${l.cwd ?? "-"} · ${accessLabel(l)} · restarts ${l.restarts}`));
  if (l.running) ctx.out(c.dim(`model ${safeTerm(l.model_setting ?? "default")}${l.model && l.model !== l.model_setting ? ` (running ${safeTerm(l.model)})` : ""}${l.model_pending ? ` · switching to ${safeTerm(l.model_pending)} after this reply` : ""}`));
  if (l.last_error && l.state !== "failed") ctx.out(c.yellow(`last error: ${safeTerm(l.last_error)}`));
  return EXIT.ok;
}

async function say(ctx: Ctx, client: WalkieClient): Promise<number> {
  const rest = ctx.args.pos.slice(1);
  const text = rest.length === 1 && rest[0] === "-" ? await readStdin() : rest.join(" ");
  if (!text.trim()) throw new UsageError("missing message text");
  const timeout = int(ctx.args, "timeout", 600) as number;
  if (timeout < 1) throw new UsageError("--timeout must be >= 1");
  const v = await client.orchestrator();
  if (!v.local.running) { ctx.err(`${c.red("walkie:")} WalkieTalkie isn't running on this machine${v.local.state === "standby" && v.local.lead ? ` (it runs on ${safeTerm(v.local.lead)}, the team's lead)` : ""}; ${START_HINT}`); return EXIT.error; }
  // The conversation `say` continues: the newest one on this machine, unless --new or --thread says otherwise.
  const latest = bool(ctx.args, "new") ? undefined : str(ctx.args, "thread") ?? (await client.orchestratorMessages({ limit: 1 })).messages.at(-1)?.thread;
  const { message } = await client.orchestratorSay(text, latest);
  if (!ctx.json) ctx.err(c.dim(`sent; waiting up to ${timeout}s…`));
  const deadline = Date.now() + timeout * 1000;
  let reply: OrchMessage | undefined;
  let mine: OrchMessage | undefined;
  while (Date.now() < deadline) {
    const { messages } = await client.orchestratorMessages({ thread: message.thread, limit: 200 });
    mine = messages.find((m) => m.id === message.id);
    // Matched by the message it answers (ORCH-FIX-13, Codex r13 MEDIUM 4), never by order: a reply to an earlier
    // message of the same conversation can be stored after this one.
    reply = messages.find((m) => m.role === "orchestrator" && m.reply_to === message.id);
    if (reply || mine?.state === "refused" || mine?.state === "dropped") break;
    await Bun.sleep(300);
  }
  if (ctx.json) {
    ctx.out(JSON.stringify({ sent: message, reply: reply ?? null, complete: !!reply }));
    return reply ? EXIT.ok : EXIT.timeout;
  }
  if (reply) { printMessage(ctx, reply); return EXIT.ok; }
  if (mine?.state === "refused" || mine?.state === "dropped") { ctx.err(c.yellow(`your message was ${mine.state} before it ran`)); return EXIT.error; }
  ctx.err(c.yellow(`no reply within ${timeout}s`));
  return EXIT.timeout;
}

function printMessage(ctx: Ctx, m: OrchMessage): void {
  if (m.tools?.length) ctx.out(c.dim(`⚙ ${safeTerm(m.tools.join(" · "))}`));
  ctx.out(safeTerm(m.text));
}

async function log(ctx: Ctx, client: WalkieClient): Promise<number> {
  const limit = int(ctx.args, "limit", 20) as number;
  const { messages } = await client.orchestratorMessages({ limit });
  if (ctx.json) { ctx.out(JSON.stringify({ messages })); return EXIT.ok; }
  if (!messages.length) { ctx.out(c.dim("no conversation yet")); return EXIT.ok; }
  let thread: string | null = null;
  for (const m of messages) {
    if (m.thread !== thread) { thread = m.thread; ctx.out(c.dim(`── conversation ${m.thread} ──`)); }
    const label = m.role === "person" ? c.cyan("you") : c.green("WalkieTalkie");
    const note = m.role === "person" && m.state && m.state !== "sent" ? c.yellow(` (${m.state})`) : "";
    ctx.out(`${c.gray(hhmm(m.ts))} ${label}${note} ›${m.tools?.length ? c.dim(` ⚙ ${safeTerm(m.tools.join(" · "))}`) : ""}`);
    ctx.out(safeTerm(m.text));
  }
  return EXIT.ok;
}
