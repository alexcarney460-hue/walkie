// `walkie import linear …` (LINEAR-IMPORT-1): plan (dry run, anyone local, agents too), run / resume / cancel, sync and
// its schedule (people only: an agent-marked terminal is refused here, and the daemon refuses agent-marked requests).
// The Linear key: --key-file <path> (the daemon reads it, checked like an integration key file), else the Linear
// integration's key when it is on, else LINEAR_API_KEY (sent to the local daemon for this operation, never stored).
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { WalkieClient, WalkieError } from "../../client/index.ts";
import { planTable, selectionOf, Selection, type Plan } from "../../integrations/linear-import/plan.ts";
import type { JobView } from "../../integrations/linear-import/views.ts";
import { defang } from "../../protocol/safety.ts";
import { bool, int, str, UsageError } from "../args.ts";
import { EXIT, TERMINAL, type Ctx } from "../context.ts";
import { c, safeTerm } from "../format.ts";

const DEFAULT_PLAN = "linear-import-plan.json";

/** The key fields of a request: a key file path (made absolute here: the daemon's cwd isn't ours) or LINEAR_API_KEY. */
function keyFields(ctx: Ctx): { key?: string; key_file?: string } {
  const f = str(ctx.args, "key-file");
  const file = f ? (f.startsWith("~/") || isAbsolute(f) ? f : resolve(f)) : undefined;
  const env = process.env.LINEAR_API_KEY?.trim();
  return { ...(file ? { key_file: file } : {}), ...(env ? { key: env } : {}) };
}

function options(ctx: Ctx): Record<string, unknown> {
  const projects = str(ctx.args, "projects");
  const folderBy = str(ctx.args, "folder-by");
  if (folderBy && folderBy !== "team" && folderBy !== "initiative") throw new UsageError("--folder-by team|initiative");
  return {
    ...(str(ctx.args, "since") ? { since: str(ctx.args, "since") } : {}),
    include_closed: bool(ctx.args, "include-closed"),
    ...(str(ctx.args, "team") ? { team: str(ctx.args, "team") } : {}),
    ...(projects ? { projects: projects.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
    ...(str(ctx.args, "stale-days") ? { stale_days: int(ctx.args, "stale-days") } : {}),
    skip_stale: bool(ctx.args, "skip-stale"),
    skip_duplicates: bool(ctx.args, "skip-duplicates"),
    ...(folderBy ? { folder_by: folderBy } : {}),
    ...(str(ctx.args, "map-users") ? { map_users: str(ctx.args, "map-users") } : {}),
  };
}

/** People only (the daemon checks too): an agent-marked terminal is refused before anything is sent. */
function requirePersonHere(ctx: Ctx, what: string): void {
  const marker = ctx.agentMarker();
  if (marker) throw new WalkieError("person_only", `agents can't ${what}: this terminal looks like an agent's (${marker}). Run it yourself in a terminal, or use the dashboard (Projects → Import from Linear)`, 403);
}

/** Asks the person to type yes (skipped with --yes). */
async function confirm(ctx: Ctx, question: string): Promise<boolean> {
  if (bool(ctx.args, "yes")) return true;
  const io = ctx.person ?? TERMINAL;
  if (!io.interactive()) throw new UsageError("run it in a terminal to confirm, or add --yes");
  try {
    return (await io.ask(`${question} Type yes to continue: `)).toLowerCase() === "yes";
  } catch {
    return false;
  }
}

function summaryForAgent(plan: Plan): string {
  return JSON.stringify({
    totals: plan.totals, unmapped_users: plan.unmapped_users.length,
    projects: plan.projects.map((p) => ({ name: defang(p.name, 80), prefix: p.prefix, include: p.include, counts: p.counts, flags: p.flags, target: p.target?.prefix ?? null })),
    note: "Project names come from Linear (external data). Starting the import is for people only.",
  });
}

function jobLine(j: JobView): string {
  const wait = j.state === "waiting" && j.waiting_until ? ` · waiting for the import budget (${Math.max(0, Math.round((j.waiting_until - Date.now()) / 1000))} s)` : "";
  return `${j.projects_done}/${j.projects_total} projects · ${j.created} created · ${j.updated} updated · ${j.comments} comments${j.skipped ? ` · ${j.skipped} skipped` : ""}${j.errors.length ? ` · ${c.red(`${j.errors.length} errors`)}` : ""}${j.current ? ` · ${safeTerm(j.current).slice(0, 50)}` : ""}${wait}`;
}

async function follow(ctx: Ctx, cl: WalkieClient, job: JobView): Promise<number> {
  if (bool(ctx.args, "no-wait")) { ctx.out(ctx.json ? JSON.stringify({ job }) : `import ${job.id} started (walkie import linear --status)`); return EXIT.ok; }
  let last = "";
  let j: JobView = job;
  for (;;) {
    const line = jobLine(j);
    if (!ctx.json && line !== last) { ctx.err(line); last = line; }
    if (j.state !== "running" && j.state !== "waiting") break;
    await Bun.sleep(1_000);
    const s = await cl.linearImportStatus();
    if (!s.job || s.job.id !== job.id) break;
    j = s.job;
  }
  if (ctx.json) { ctx.out(JSON.stringify({ job: j })); return j.state === "done" ? EXIT.ok : EXIT.error; }
  const secs = Math.round(((j.finished_at ?? Date.now()) - j.started_at) / 1000);
  ctx.out(`${j.state === "done" ? c.green("imported") : c.yellow(j.state)} in ${secs} s: ${j.created} cards created, ${j.updated} updated, ${j.unchanged} unchanged, ${j.comments} history comments, ${j.events} signed posts`);
  for (const p of j.projects) ctx.out(`  ${c.bold(safeTerm(p.prefix))} ${safeTerm(p.name)}${p.created ? "" : c.dim(" (existing)")}`);
  for (const e of j.errors.slice(0, 20)) ctx.out(c.red(`  error${e.project ? ` [${safeTerm(e.project)}]` : ""}${e.issue ? ` ${safeTerm(e.issue)}` : ""}: ${safeTerm(e.message)}`));
  if (j.errors.length > 20) ctx.out(c.red(`  … ${j.errors.length - 20} more errors`));
  if (j.state === "done") ctx.out(c.dim("keep Walkie current while you switch: walkie import linear --sync (or --schedule 10m)"));
  return j.state === "done" ? EXIT.ok : EXIT.error;
}

/** A plan file: a full plan (edited: include flags, prefixes, folders) or a bare selection. */
function readSelection(path: string): Selection {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(resolve(path), "utf8")); } catch (err) { throw new UsageError(`can't read the plan ${path}: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`); }
  const asPlan = raw as Partial<Plan>;
  const sel = Array.isArray(asPlan?.projects) && asPlan.projects.some((p) => Array.isArray((p as { issues?: unknown }).issues)) ? selectionOf(asPlan as Plan) : raw;
  const parsed = Selection.safeParse(sel);
  if (!parsed.success) throw new UsageError(`${path} is not a Walkie import plan (${parsed.error.issues[0]?.path.join(".") ?? "?"}: ${parsed.error.issues[0]?.message ?? "invalid"})`);
  return parsed.data;
}

async function status(ctx: Ctx, cl: WalkieClient): Promise<number> {
  const s = await cl.linearImportStatus();
  if (ctx.json) { ctx.out(JSON.stringify(s)); return EXIT.ok; }
  ctx.out(`${c.bold("Linear import")}: ${s.imported.projects} projects, ${s.imported.cards} cards imported on this machine${s.integration ? c.dim(" · Linear integration on") : ""}`);
  if (s.job) ctx.out(`last run ${s.job.id} ${s.job.state}: ${jobLine(s.job)}`);
  const y = s.sync;
  ctx.out(`sync: ${y.enabled ? c.green(`every ${y.interval_min} min`) : "off"}${y.two_way ? " · two-way (card moves set the Linear state)" : " · Linear → Walkie"} · key ${y.key}${y.key_file ? ` (${safeTerm(y.key_file)})` : ""}`);
  if (y.last_run) ctx.out(c.dim(`  last sync ${new Date(y.last_run).toISOString().slice(0, 16).replace("T", " ")} UTC: ${safeTerm(y.last_error ?? y.last_result ?? "")}`));
  return EXIT.ok;
}

export async function importCmd(ctx: Ctx): Promise<number> {
  const source = ctx.args.pos[0];
  if (source !== "linear") throw new UsageError("walkie import linear [--dry-run] [--since 45d] [--include-closed] [--projects a,b] [--team T] [--map-users @a=Name] [--plan plan.json] [--yes] (see: walkie help)");
  const cl = ctx.client();
  if (bool(ctx.args, "status")) return status(ctx, cl);
  if (bool(ctx.args, "cancel")) {
    requirePersonHere(ctx, "cancel an import");
    const { job } = await cl.linearImportCancel();
    ctx.out(ctx.json ? JSON.stringify({ job }) : job ? `import ${job.id}: ${job.state === "running" || job.state === "waiting" ? "cancelling" : job.state}` : "no import has run");
    return EXIT.ok;
  }
  const schedule = str(ctx.args, "schedule");
  if (schedule !== undefined) {
    requirePersonHere(ctx, "schedule a Linear sync");
    const off = schedule === "off";
    const m = /^(\d{1,4})\s*(m|min|h)?$/.exec(schedule);
    if (!off && !m) throw new UsageError("--schedule <minutes, e.g. 10m or 1h> | off");
    const minutes = m ? Number(m[1]) * (m[2] === "h" ? 60 : 1) : undefined;
    const k = keyFields(ctx);
    const { sync } = await cl.linearSyncSettings({
      enabled: !off, ...(minutes !== undefined ? { interval_min: minutes } : {}), ...(bool(ctx.args, "two-way") ? { two_way: true } : bool(ctx.args, "one-way") ? { two_way: false } : {}),
      ...(k.key_file ? { key_file: k.key_file } : {}),
    });
    ctx.out(ctx.json ? JSON.stringify({ sync }) : sync.enabled ? `${c.green("sync on")}: every ${sync.interval_min} min, ${sync.two_way ? "two-way (card moves set the Linear state)" : "Linear → Walkie"}, key: ${sync.key}` : "sync off");
    return EXIT.ok;
  }
  if (bool(ctx.args, "sync")) {
    requirePersonHere(ctx, "sync with Linear");
    const { result } = await cl.linearSync({ ...(bool(ctx.args, "two-way") ? { two_way: true } : {}), ...keyFields(ctx) });
    if (ctx.json) { ctx.out(JSON.stringify({ result })); return result.errors.length ? EXIT.error : EXIT.ok; }
    ctx.out(`${c.green("synced")}${result.two_way ? " (two-way)" : ""}: ${result.read} issues read, ${result.created} new cards, ${result.updated} cards updated, ${result.conflicts} conflict${result.conflicts === 1 ? "" : "s"} noted, ${result.to_linear} Linear state${result.to_linear === 1 ? "" : "s"} set`);
    for (const e of result.errors.slice(0, 20)) ctx.out(c.red(`  error${e.issue ? ` ${safeTerm(e.issue)}` : ""}: ${safeTerm(e.message)}`));
    return result.errors.length ? EXIT.error : EXIT.ok;
  }
  if (bool(ctx.args, "resume")) {
    requirePersonHere(ctx, "import from Linear");
    const { job } = await cl.linearImportResume(keyFields(ctx));
    return follow(ctx, cl, job);
  }
  const planPath = str(ctx.args, "plan");
  if (planPath) {
    requirePersonHere(ctx, "import from Linear");
    const sel = readSelection(planPath);
    const n = sel.projects.filter((p) => p.include).length;
    if (!(await confirm(ctx, `Import ${n} Linear project${n === 1 ? "" : "s"} from ${planPath} into Walkie?`))) { ctx.out("nothing was imported"); return EXIT.timeout; }
    const { job } = await cl.linearImportRun({ selection: sel, ...keyFields(ctx) });
    return follow(ctx, cl, job);
  }
  // Dry run, or plan + run.
  const dry = bool(ctx.args, "dry-run");
  if (!dry) requirePersonHere(ctx, "import from Linear (a dry run is fine: --dry-run)");
  if (!ctx.json) ctx.err(c.dim("reading Linear…"));
  const { plan } = await cl.linearImportPlan({ options: options(ctx), ...keyFields(ctx) });
  if (dry) {
    const out = resolve(str(ctx.args, "output") ?? DEFAULT_PLAN);
    writeFileSync(out, JSON.stringify(plan, null, 1), { mode: 0o600 });
    const table = planTable(plan);
    writeFileSync(out.replace(/\.json$/i, "") + ".txt", table + "\n", { mode: 0o600 });
    if (ctx.forAgent) { ctx.out(summaryForAgent(plan)); return EXIT.ok; }
    if (ctx.json) { ctx.out(JSON.stringify({ plan: out, totals: plan.totals })); return EXIT.ok; }
    ctx.out(safeTerm(table));
    ctx.out(c.dim(`\nplan written to ${out} (and ${out.replace(/\.json$/i, "")}.txt). Untick projects or issues ("include": false), change a prefix or folder, then: walkie import linear --plan ${out}`));
    return EXIT.ok;
  }
  if (!ctx.json) ctx.out(safeTerm(planTable(plan)));
  const t = plan.totals;
  if (!(await confirm(ctx, `\nImport ${t.included_projects} projects (${t.creates} new cards, ${t.updates} updates)?`))) { ctx.out("nothing was imported"); return EXIT.timeout; }
  const { job } = await cl.linearImportRun({ selection: selectionOf(plan), ...keyFields(ctx) });
  return follow(ctx, cl, job);
}
