// `walkie projects …`, `walkie tasks …`, `walkie task …` (WALKIE-PROJECTS-1): projects with native boards.
// Under an agent (PROTOCOL §6), card and project text is wrapped for the model; the CLI then speaks for that agent
// (WALKIE_AGENT, else the runtime's session), so the daemon applies the agent rules (no deletes, no moving a person's
// card, no project settings). A named agent may create projects and add boards for its person (AGENT-PROJECTS).
import { adminCaller } from "../admin-gate.ts";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WalkieClient } from "../../client/index.ts";
import { resolveAgentName } from "../../agent/identity.ts";
import { cardForModel, projectLineForModel, timelineForModel } from "../../protocol/projects/format.ts";
import { humanSize, roomFileForModel, roomUnavailableNote, taskContextForModel } from "../../protocol/projects/room-format.ts";
import type { CardView, ProjectView, ProjectsPayload } from "../../protocol/projects/schema.ts";
import { reportMode } from "../../protocol/projects/status-report.ts";
import { defang, wrapForModel } from "../../protocol/safety.ts";
import { bool, int, need, str, UsageError } from "../args.ts";
import { agentFrom, EXIT, readStdin, type Ctx } from "../context.ts";
import { ago, c, pad, safeTerm } from "../format.ts";

/** The client, speaking for the agent when an agent runs the CLI (so people-only actions are refused to it). */
export function client(ctx: Ctx): WalkieClient {
  const agent = agentFrom(ctx.args) ?? (ctx.forAgent ? resolveAgentName() ?? "agent-cli" : undefined);
  return new WalkieClient(agent ? { agent } : {});
}

/**
 * AGENT-ADMIN-1 fix round 2: for a person-level change (settings, archive / restore / delete, export, deleting or
 * restoring a card), an unattended caller (no terminal, no marker) is marked as an agent too, so the daemon's admin
 * gate applies to it and audits it; everything else keeps client().
 */
function adminClient(ctx: Ctx): WalkieClient {
  const agent = agentFrom(ctx.args) ?? (ctx.forAgent ? resolveAgentName() ?? "agent-cli" : undefined);
  const unattended = adminCaller(ctx).kind === "agent";
  return new WalkieClient({ ...(agent ? { agent } : {}), ...(unattended ? { underAgent: true } : {}) });
}

/**
 * The client for creating a project or a board: under an agent it must be a NAMED one (--agent, WALKIE_AGENT or the
 * runtime's session); an agent without a name is sent marked and unnamed, so the daemon answers 403 agent_unnamed
 * instead of creating it under the "agent-cli" fallback.
 */
export function creatorClient(ctx: Ctx): WalkieClient {
  const agent = agentFrom(ctx.args) ?? (ctx.forAgent ? resolveAgentName() ?? undefined : undefined);
  if (agent) return new WalkieClient({ agent });
  return new WalkieClient(ctx.forAgent ? { underAgent: true } : {});
}

function bar(done: number, counted: number, width = 16): string {
  const n = counted ? Math.round((done / counted) * width) : 0;
  return `${c.green("█".repeat(n))}${c.dim("░".repeat(width - n))}`;
}
function pct(done: number, counted: number): string {
  return counted ? `${Math.round((done / counted) * 100)}%` : "–";
}

function projectLine(p: ProjectView): string {
  return `${pad(c.bold(safeTerm(p.prefix)), 8)} ${pad(safeTerm(p.name).slice(0, 34), 36)} ${bar(p.meter.done, p.meter.counted)} ${pad(`${p.meter.done}/${p.meter.counted} ${pct(p.meter.done, p.meter.counted)}`, 14)} ${c.dim(`${p.boards.length} board${p.boards.length === 1 ? "" : "s"}${p.private ? " · private" : ""}${p.state !== "active" ? ` · ${p.state}` : ""} · ${ago(p.last_activity)} ago`)}`;
}

function columnName(p: Pick<ProjectView, "boards">, card: CardView): string {
  return p.boards.find((b) => b.id === card.board)?.columns.find((x) => x.id === card.column)?.name ?? card.column;
}

function cardLine(p: Pick<ProjectView, "boards">, card: CardView): string {
  const flags = [card.blocked ? c.red("blocked") : "", card.state !== "open" ? c.dim(card.state) : ""].filter(Boolean).join(" ");
  return `${pad(c.bold(safeTerm(card.key)), 10)} ${pad(safeTerm(card.title).slice(0, 48), 50)} ${pad(c.cyan(safeTerm(columnName(p, card))), 14)} ${pad(safeTerm(card.assignee ?? "–"), 26)} ${flags}`;
}

/**
 * A mutation's result (round-1 audit, Codex M9): under an agent the teammate-written text (title, name) goes through
 * the §6 wrapper like every read, and JSON is an allowlist with a trust field; a person sees the usual line.
 */
function taskOut(ctx: Ctx, verb: string, task: CardView): string {
  if (ctx.forAgent) {
    const text = wrapForModel({ id: task.id, kind: "card", channel: task.channel, author: task.created_by }, `${task.key} ${task.title}`, { maxLen: 400 });
    return ctx.json
      ? JSON.stringify({ task: { key: task.key, id: task.id, channel: task.channel, column: task.column, state: task.state, assignee: task.assignee, blocked: task.blocked, text }, trust: "team-member" })
      : `${verb} ${task.key}\n${text}`;
  }
  return ctx.json ? JSON.stringify({ task }) : `${c.green(verb)} ${safeTerm(task.key)} ${safeTerm(task.title)}`;
}

function mutationOut(ctx: Ctx, verb: string, project: ProjectView): string {
  if (ctx.forAgent) {
    return ctx.json
      ? JSON.stringify({ project: { channel: project.channel, prefix: project.prefix, state: project.state, text: projectLineForModel(project) }, trust: "team-member" })
      : `${verb} ${projectLineForModel(project)}`;
  }
  return ctx.json ? JSON.stringify({ project }) : `${c.green(verb)} ${safeTerm(project.name)} (${project.prefix})${project.state !== "active" ? ` · ${project.state}` : ""}`;
}

// ---- walkie projects ----------------------------------------------------------------------------------------------

async function list(ctx: Ctx): Promise<number> {
  const res: ProjectsPayload = await client(ctx).projects(bool(ctx.args, "all"));
  if (ctx.json) {
    ctx.out(JSON.stringify(ctx.forAgent ? { projects: res.projects.map((p) => ({ channel: p.channel, prefix: p.prefix, state: p.state, done: p.meter.done, counted: p.meter.counted, text: projectLineForModel(p), trust: "team-member" })), stubs: res.stubs.length } : res));
    return EXIT.ok;
  }
  if (ctx.forAgent) {
    ctx.out(res.projects.length ? res.projects.map(projectLineForModel).join("\n") : "(no projects)");
    return EXIT.ok;
  }
  if (!res.projects.length && !res.stubs.length) { ctx.out(c.dim("no projects yet (walkie projects create <name>)")); return EXIT.ok; }
  const folders = [...new Set(res.projects.map((p) => p.folder))].sort();
  for (const f of folders) {
    ctx.out(c.bold(safeTerm(f || "(no folder)")));
    for (const p of res.projects.filter((x) => x.folder === f)) ctx.out(`  ${projectLine(p)}`);
  }
  if (res.stubs.length) ctx.out(c.dim(`${res.stubs.length} private project${res.stubs.length === 1 ? "" : "s"} of the team's owners`));
  return EXIT.ok;
}

async function create(ctx: Ctx): Promise<number> {
  const name = ctx.args.pos.slice(1).join(" ");
  if (!name) throw new UsageError("missing project name");
  const paths = [...(str(ctx.args, "path") ? [{ path: str(ctx.args, "path") as string }] : []), ...(str(ctx.args, "repo") ? [{ repo: str(ctx.args, "repo") as string }] : [])];
  const { project } = await creatorClient(ctx).createProject({
    name, ...(str(ctx.args, "prefix") ? { prefix: (str(ctx.args, "prefix") as string).toUpperCase() } : {}),
    ...(str(ctx.args, "folder") ? { folder: str(ctx.args, "folder") } : {}), ...(bool(ctx.args, "private") ? { private: true } : {}),
    ...(paths.length ? { paths } : {}), ...(bool(ctx.args, "points") ? { meter: "points" } : {}),
    ...(str(ctx.args, "description") ? { description: str(ctx.args, "description") } : {}),
  });
  if (ctx.forAgent || ctx.json) ctx.out(mutationOut(ctx, "created", project));
  else ctx.out(`${c.green("created")} ${safeTerm(project.name)} (${project.prefix}) ${c.dim(project.channel)}${project.private ? c.dim(" · private: the team's owners") : ""}`);
  return EXIT.ok;
}

async function show(ctx: Ctx): Promise<number> {
  const cl = client(ctx);
  const ref = need(ctx.args, 1, "project");
  const channel = await channelOf(cl, ref);
  const { project, cards } = await cl.project(channel);
  if (ctx.json) { ctx.out(JSON.stringify(ctx.forAgent ? { project: projectLineForModel(project), status_report: reportMode(project), cards: cards.map((x) => ({ key: x.key, id: x.id, text: cardForModel(x, project), trust: "team-member" })) } : { project, cards })); return EXIT.ok; }
  if (ctx.forAgent) {
    ctx.out(projectLineForModel(project));
    ctx.out(`status report: ${reportMode(project)}`);
    ctx.out(cards.filter((x) => x.state === "open").map((x) => cardForModel(x, project)).join("\n") || "(no open cards)");
    return EXIT.ok;
  }
  ctx.out(projectLine(project));
  ctx.out(c.dim(`status report: ${reportMode(project)}${reportMode(project) === "hourly" ? " (WalkieTalkie writes it each hour something changed)" : ""}`));
  for (const b of project.boards) {
    ctx.out(`\n${c.bold(safeTerm(b.name))} ${bar(b.meter.done, b.meter.counted, 12)} ${b.meter.done}/${b.meter.counted}${b.state !== "active" ? c.dim(" (archived)") : ""}`);
    for (const col of b.columns) {
      const mine = cards.filter((x) => x.board === b.id && x.column === col.id && x.state === "open").sort((a, z) => (a.pos < z.pos ? -1 : 1));
      ctx.out(`  ${c.cyan(safeTerm(col.name))} ${c.dim(`${mine.length}${col.wip ? `/${col.wip}` : ""}`)}`);
      for (const x of mine) ctx.out(`    ${cardLine(project, x)}`);
    }
  }
  return EXIT.ok;
}

/** A project reference (channel, prefix or name) → its channel. */
export async function channelOf(cl: WalkieClient, ref: string): Promise<string> {
  if (/^p-[0-9a-f]{8}$/.test(ref)) return ref;
  const { projects } = await cl.projects();
  const up = ref.toUpperCase();
  const hit = projects.find((p) => p.prefix === up) ?? projects.find((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (!hit) throw new UsageError(`no project ${ref} (see: walkie projects)`);
  return hit.channel;
}

async function set(ctx: Ctx, state?: "active" | "archived" | "deleted"): Promise<number> {
  const cl = adminClient(ctx);
  const channel = await channelOf(cl, need(ctx.args, 1, "project"));
  const body: Record<string, unknown> = {
    ...(state ? { state } : {}), ...(str(ctx.args, "name") ? { name: str(ctx.args, "name") } : {}),
    ...(str(ctx.args, "folder") !== undefined ? { folder: str(ctx.args, "folder") } : {}),
    ...(str(ctx.args, "prefix") ? { prefix: (str(ctx.args, "prefix") as string).toUpperCase() } : {}),
    ...(bool(ctx.args, "private") ? { private: true } : bool(ctx.args, "public") ? { private: false } : {}),
    ...(str(ctx.args, "path") ? { paths: [{ path: str(ctx.args, "path") }] } : {}),
  };
  if (!Object.keys(body).length) throw new UsageError("nothing to change (--name, --folder, --prefix, --private|--public, --path)");
  const { project } = await cl.updateProject(channel, body);
  ctx.out(mutationOut(ctx, "updated", project));
  return EXIT.ok;
}

/**
 * `walkie projects report <project> [on|off]` (PROJECT-REPORTS-1): WalkieTalkie's hourly plain-English status report for a
 * project. With no verb it only says which. Switching is for people (the project's creator and the team's owners): the
 * daemon refuses an agent's request, and says why.
 */
async function reportCmd(ctx: Ctx): Promise<number> {
  const cl = client(ctx);
  const channel = await channelOf(cl, need(ctx.args, 1, "project"));
  const verb = ctx.args.pos[2];
  if (verb !== undefined && verb !== "on" && verb !== "off") throw new UsageError("usage: walkie projects report <project> [on|off]");
  const { project } = verb ? await cl.updateProject(channel, { status_report: verb === "on" ? "hourly" : "off" }) : await cl.project(channel);
  const mode = reportMode(project);
  ctx.out(ctx.json ? JSON.stringify({ project: project.prefix, status_report: mode })
    : `${safeTerm(project.prefix)}: hourly status report ${mode === "hourly" ? c.green("on") : c.yellow("off")}`);
  return EXIT.ok;
}

async function boardCmd(ctx: Ctx): Promise<number> {
  const cl = creatorClient(ctx);
  const channel = await channelOf(cl, need(ctx.args, 1, "project"));
  const verb = need(ctx.args, 2, "add");
  if (verb !== "add") throw new UsageError("walkie projects board <project> add <name>");
  const name = ctx.args.pos.slice(3).join(" ");
  if (!name) throw new UsageError("missing board name");
  const { board } = await cl.createBoard(channel, { name });
  ctx.out(ctx.forAgent
    ? (ctx.json ? JSON.stringify({ board: { id: board.id, name: defang(board.name, 40) }, trust: "team-member" }) : `added board ${defang(board.name, 40)} (${board.id})`)
    : ctx.json ? JSON.stringify({ board }) : `${c.green("added")} board ${safeTerm(board.name)}`);
  return EXIT.ok;
}

async function exportCmd(ctx: Ctx): Promise<number> {
  const cl = adminClient(ctx);
  const channel = await channelOf(cl, need(ctx.args, 1, "project"));
  const format = (str(ctx.args, "format") ?? "csv") as "csv" | "json" | "ndjson";
  if (!["csv", "json", "ndjson"].includes(format)) throw new UsageError("--format csv|json|ndjson");
  const text = await cl.exportProject(channel, format);
  const out = str(ctx.args, "output");
  if (!out) { process.stdout.write(text); return EXIT.ok; }
  writeFileSync(resolve(out), text, { mode: 0o600 });
  ctx.out(`${c.green("exported")} ${resolve(out)}`);
  return EXIT.ok;
}

export async function projectsCmd(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos[0] ?? "list";
  switch (sub) {
    case "list": return list(ctx);
    case "create": return create(ctx);
    case "show": return show(ctx);
    case "set": return set(ctx);
    case "archive": return set(ctx, "archived");
    case "restore": return set(ctx, "active");
    case "delete": return set(ctx, "deleted");
    case "board": return boardCmd(ctx);
    case "report": return reportCmd(ctx);
    case "fact": return (await import("./projects-page.ts")).factCmd(ctx); // PROJECT-PAGES-1 (loaded when used: it imports this file)
    case "screen": return (await import("./projects-page.ts")).screenCmd(ctx);
    case "export": return exportCmd(ctx);
    default: throw new UsageError(`unknown projects command "${sub}" (list|create|show|set|archive|restore|delete|board|report|fact|screen|export)`);
  }
}

// ---- walkie tasks / walkie task -----------------------------------------------------------------------------------

export async function tasksCmd(ctx: Ctx): Promise<number> {
  const res = await client(ctx).tasks({
    ...(str(ctx.args, "project") ? { project: str(ctx.args, "project") } : {}),
    ...(bool(ctx.args, "mine") ? { assignee: "me" } : str(ctx.args, "assignee") ? { assignee: str(ctx.args, "assignee") } : {}),
    ...(str(ctx.args, "search") ? { q: str(ctx.args, "search") } : {}),
    ...(str(ctx.args, "state") ? { state: str(ctx.args, "state") } : {}),
    ...(str(ctx.args, "role") ? { role: str(ctx.args, "role") } : {}),
    limit: int(ctx.args, "limit", 50),
  });
  const projectOf = (t: CardView) => res.projects.find((p) => p.channel === t.channel) ?? { name: "?", boards: [] };
  if (ctx.json) {
    ctx.out(JSON.stringify(ctx.forAgent
      ? { tasks: res.tasks.map((t) => ({ key: t.key, id: t.id, channel: t.channel, state: t.state, column: t.column, assignee: t.assignee, text: cardForModel(t, projectOf(t)), trust: "team-member" })), total: res.total }
      : res));
    return EXIT.ok;
  }
  if (ctx.forAgent) { ctx.out(res.tasks.map((t) => cardForModel(t, projectOf(t))).join("\n") || "(no tasks)"); return EXIT.ok; }
  if (!res.tasks.length) { ctx.out(c.dim("no tasks for this filter")); return EXIT.ok; }
  for (const t of res.tasks) ctx.out(cardLine(projectOf(t), t));
  if (res.truncated) ctx.out(c.dim(`… ${res.total - res.tasks.length} more (--limit)`));
  return EXIT.ok;
}

async function textRest(ctx: Ctx, from: number, what: string): Promise<string> {
  const rest = ctx.args.pos.slice(from);
  if (rest.length === 1 && rest[0] === "-") return readStdin();
  const t = rest.join(" ");
  if (!t) throw new UsageError(`missing ${what}`);
  return t;
}

function address(cl: WalkieClient, v: string): string | null {
  if (v === "none" || v === "-") return null;
  if (v === "me") return "me";
  if (!v.startsWith("@")) throw new UsageError(`assignee is an address such as @kira or @kira/kiras-mbp/cc-1 (or me / none)`);
  void cl;
  return v;
}

async function showTask(ctx: Ctx, ref: string): Promise<number> {
  const d = await client(ctx).task(ref);
  if (ctx.json) { ctx.out(JSON.stringify(ctx.forAgent ? { key: d.card.key, id: d.card.id, text: cardForModel(d.card, d.project, { body: true }), timeline: timelineForModel(d.card, d.timeline), agents: d.agents.map((a) => defang(a.id, 160)), trust: "team-member" } : d)); return EXIT.ok; }
  const files = d.files ?? [];
  if (ctx.forAgent) {
    ctx.out(cardForModel(d.card, d.project, { body: true }));
    if (d.agents.length) ctx.out(`agents on it: ${d.agents.map((a) => `@${defang(a.id, 160)} [${a.effective_state}]`).join(", ")}`);
    if (files.length) ctx.out(`files attached (Data Room: walkie room ${defang(d.project.prefix, 12)} get <name>):\n${files.map((f) => roomFileForModel(f)).join("\n")}`);
    ctx.out(timelineForModel(d.card, d.timeline));
    return EXIT.ok;
  }
  ctx.out(cardLine(d.project, d.card));
  if (d.card.body) ctx.out(`\n${safeTerm(d.card.body)}\n`);
  if (d.card.labels.length) ctx.out(c.dim(`labels: ${safeTerm(d.card.labels.join(", "))}`));
  if (d.agents.length) ctx.out(c.dim(`agents on it: ${d.agents.map((a) => `@${safeTerm(a.id)} (${a.effective_state})`).join(", ")}`));
  if (files.length) ctx.out(c.dim(`files: ${files.map((f) => `${f.pinned ? "★ " : ""}${safeTerm(f.name)} (v${f.version}, ${humanSize(f.size)})`).join(", ")}`));
  for (const t of d.timeline) {
    const by = `@${t.author.handle}${t.author.agent ? `/${t.author.agent}` : ""}`;
    const what = t.kind === "comment" ? safeTerm(t.text ?? "") : `${t.kind === "create" ? "created" : "set"} ${Object.keys(t.changes ?? {}).join(", ")}${t.ignored ? c.yellow(` (ignored: ${t.ignored})`) : ""}`;
    ctx.out(`  ${c.gray(ago(t.ts))} ${c.bold(safeTerm(by))} ${what}`);
  }
  return EXIT.ok;
}

export async function taskCmd(ctx: Ctx): Promise<number> {
  const cl = client(ctx);
  const sub = need(ctx.args, 0, "task key or command");
  const done = (task: CardView, verb: string) => {
    ctx.out(taskOut(ctx, verb, task));
    return EXIT.ok;
  };
  switch (sub) {
    case "create": {
      const project = need(ctx.args, 1, "project");
      const title = await textRest(ctx, 2, "title");
      const assignee = str(ctx.args, "assign");
      const { task } = await cl.createTask({
        project, title, ...(str(ctx.args, "column") ? { column: str(ctx.args, "column") } : {}),
        ...(assignee ? { assignee: address(cl, assignee) === "me" ? await selfAddress(cl) : address(cl, assignee) } : {}),
        ...(str(ctx.args, "label") ? { labels: (str(ctx.args, "label") as string).split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        ...(str(ctx.args, "estimate") ? { estimate: int(ctx.args, "estimate") } : {}), ...(str(ctx.args, "due") ? { due: str(ctx.args, "due") } : {}),
        ...(str(ctx.args, "body") ? { body: str(ctx.args, "body") } : {}),
      });
      return done(task, "created");
    }
    case "move": return done((await cl.updateTask(need(ctx.args, 1, "task"), { column: need(ctx.args, 2, "column") })).task, "moved");
    case "assign": {
      const who = address(cl, need(ctx.args, 2, "assignee"));
      return done((await cl.updateTask(need(ctx.args, 1, "task"), { assignee: who === "me" ? (await selfAddress(cl)) : who })).task, "assigned");
    }
    case "start": {
      const { task } = await cl.taskAction(need(ctx.args, 1, "task"), "start");
      done(task, "started");
      // Under an agent: the project's pinned documents and the card's files (DATA-ROOM-1), wrapped for the model.
      if (ctx.forAgent && !ctx.json) {
        const room = await cl.taskContext(task.ref, true).then(taskContextForModel).catch((err: unknown) => {
          ctx.err(`walkie task start: the Data Room context of ${task.ref} failed: ${safeTerm(err instanceof Error ? err.message : String(err))}`);
          return roomUnavailableNote(err);
        });
        if (room) ctx.out(room);
      }
      return EXIT.ok;
    }
    case "review": case "done": case "unblock":
      return done((await cl.taskAction(need(ctx.args, 1, "task"), sub)).task, sub === "done" ? "done" : sub === "unblock" ? "unblocked" : "in review");
    case "block": {
      const reason = ctx.args.pos.slice(2).join(" ") || undefined;
      return done((await cl.taskAction(need(ctx.args, 1, "task"), "block", reason)).task, "blocked");
    }
    case "comment": {
      const ref = need(ctx.args, 1, "task");
      const res = await cl.commentTask(ref, await textRest(ctx, 2, "comment"));
      return done(res.task, "commented on");
    }
    case "edit": {
      const body: Record<string, unknown> = {
        ...(str(ctx.args, "title") ? { title: str(ctx.args, "title") } : {}), ...(str(ctx.args, "body") ? { body: str(ctx.args, "body") } : {}),
        ...(str(ctx.args, "label") !== undefined ? { labels: (str(ctx.args, "label") as string).split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        ...(str(ctx.args, "estimate") ? { estimate: int(ctx.args, "estimate") } : {}), ...(str(ctx.args, "due") ? { due: str(ctx.args, "due") } : {}),
      };
      if (!Object.keys(body).length) throw new UsageError("nothing to change (--title, --body, --label a,b, --estimate n, --due YYYY-MM-DD)");
      return done((await cl.updateTask(need(ctx.args, 1, "task"), body)).task, "updated");
    }
    case "delete": return done((await adminClient(ctx).updateTask(need(ctx.args, 1, "task"), { state: "deleted" })).task, "deleted");
    case "archive": return done((await cl.updateTask(need(ctx.args, 1, "task"), { state: "archived" })).task, "archived");
    case "restore": return done((await adminClient(ctx).updateTask(need(ctx.args, 1, "task"), { state: "open" })).task, "restored");
    case "show": return showTask(ctx, need(ctx.args, 1, "task"));
    default: return showTask(ctx, sub);
  }
}

async function selfAddress(cl: WalkieClient): Promise<string> {
  const me = await cl.me();
  return cl.agent ? `@${me.handle}/${me.node.hostname}/${cl.agent}` : `@${me.handle}`;
}
