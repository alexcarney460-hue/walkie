// walkie integrations [list|enable|disable|remove|run] · walkie linear create
import { adminCtx } from "../admin-gate.ts";
import type { IntegrationView } from "../../integrations/types.ts";
import { linearResultJson } from "../agent-output.ts";
import { bool, channelArg, int, need, str, UsageError } from "../args.ts";
import { EXIT, readStdin, type Ctx } from "../context.ts";
import { ago, c, safeTerm } from "../format.ts";

const IDS = ["fireflies", "wispr", "linear"];

function connectorArg(ctx: Ctx, i: number): string {
  const id = need(ctx.args, i, "integration (fireflies, wispr or linear)");
  if (!IDS.includes(id)) throw new UsageError(`unknown integration "${id}" (fireflies, wispr or linear)`);
  return id;
}

function line(v: IntegrationView): string {
  const state = !v.enabled ? c.dim("off".padEnd(6)) : v.last_error ? c.red("error".padEnd(6)) : c.green("on".padEnd(6));
  const key = v.needs_key ? (v.key_source === "key_path" ? `key ${v.key_path}` : v.key_source === "secret" ? "key stored" : c.yellow("no key")) : "no key needed";
  const last = v.last_ok ? `synced ${ago(v.last_ok)} ago` : v.last_run ? `ran ${ago(v.last_run)} ago` : "never ran";
  const err = v.last_error ? `\n    ${c.red(safeTerm(v.last_error))}` : "";
  return `${v.name.padEnd(11)} ${state} #${v.channel.padEnd(10)} ${key} · ${last} · ${v.items_posted} posted${err}`;
}

function list(ctx: Ctx, views: IntegrationView[]): number {
  if (ctx.json) { ctx.out(JSON.stringify({ integrations: views })); return EXIT.ok; }
  for (const v of views) ctx.out(line(v));
  return EXIT.ok;
}

async function enableBody(ctx: Ctx): Promise<Record<string, unknown>> {
  const a = ctx.args;
  const body: Record<string, unknown> = { enabled: true };
  const key = str(a, "key");
  if (key !== undefined) {
    if (key !== "-") throw new UsageError("pass --key - and pipe the key on stdin (keeps it out of shell history), or use --key-path");
    body.key = (await readStdin()).trim();
  }
  const keyPath = str(a, "key-path");
  if (keyPath) body.key_path = keyPath;
  const channel = str(a, "channel");
  if (channel) body.channel = channelArg(channel);
  const interval = int(a, "interval");
  if (interval !== undefined) body.interval_s = interval;
  const backfill = int(a, "backfill-hours");
  if (backfill !== undefined) body.backfill_hours = backfill;
  const dir = str(a, "dir");
  if (dir) body.dir = dir;
  const summarize = str(a, "summarize");
  if (summarize) body.summarize = summarize;
  if (bool(a, "no-unfurl")) body.unfurl = false;
  const teams = str(a, "teams");
  if (teams) body.teams = teams.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  const team = str(a, "default-team");
  if (team) body.default_team = team.toUpperCase();
  if (bool(a, "no-activity")) body.activity = false;
  return body;
}

export async function integrations(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos[0] ?? "list";
  // AGENT-ADMIN-1: changes are admin; an agent or an unattended caller is marked (the daemon gates and audits it).
  const client = sub === "list" ? ctx.client() : adminCtx(ctx, `change integrations (${sub})`).client();
  if (sub === "list") return list(ctx, (await client.integrations()).integrations);
  if (sub === "enable") {
    const id = connectorArg(ctx, 1);
    const res = await client.configureIntegration(id, await enableBody(ctx));
    if (ctx.json) ctx.out(JSON.stringify(res));
    else if (res.queued) ctx.out(`${c.yellow("queued")} ${res.integration.name}: the roster authority is offline; it turns on once the authority accepts (see: walkie integrations)`);
    else ctx.out(`${c.green("enabled")} ${res.integration.name} → #${res.integration.channel} (first sync starts now; see: walkie integrations)`);
    return EXIT.ok;
  }
  if (sub === "disable") {
    const id = connectorArg(ctx, 1);
    const res = await client.configureIntegration(id, { enabled: false });
    ctx.out(ctx.json ? JSON.stringify(res) : `${c.yellow("disabled")} ${res.integration.name} (settings and key kept; \`walkie integrations remove ${id}\` forgets them)`);
    return EXIT.ok;
  }
  if (sub === "remove") {
    const id = connectorArg(ctx, 1);
    const res = await client.removeIntegration(id);
    ctx.out(ctx.json ? JSON.stringify(res) : `${c.yellow("removed")} ${res.integration.name}: settings, stored key and sync state forgotten`);
    return EXIT.ok;
  }
  if (sub === "run") {
    const id = connectorArg(ctx, 1);
    const res = await client.runIntegration(id);
    if (ctx.json) { ctx.out(JSON.stringify(res)); return EXIT.ok; }
    ctx.out(line(res.integration));
    return res.integration.last_error ? EXIT.error : EXIT.ok;
  }
  throw new UsageError(`unknown subcommand "${sub}" (list, enable, disable, remove, run)`);
}

export async function linear(ctx: Ctx): Promise<number> {
  const sub = need(ctx.args, 0, "subcommand (create)");
  if (sub !== "create") throw new UsageError(`unknown subcommand "${sub}" (create)`);
  const title = ctx.args.pos.slice(1).join(" ").trim();
  if (!title) throw new UsageError("missing title");
  const res = await ctx.client().linearCreate({
    title, from: str(ctx.args, "from"), team: str(ctx.args, "team")?.toUpperCase(), dry_run: bool(ctx.args, "dry-run") || undefined,
  });
  // FINAL-2 Codex 3: for a model, previews (thread text as the description), results and partial successes
  // all go through the same formatter; a person sees the daemon's answer as is.
  if (ctx.forAgent) { ctx.out(JSON.stringify(linearResultJson(res), null, ctx.json ? 0 : 2)); return EXIT.ok; }
  if (ctx.json || res.dry_run) { ctx.out(JSON.stringify(res, null, ctx.json ? 0 : 2)); return EXIT.ok; }
  if (res.issue) ctx.out(`${c.green("created")} ${res.issue.identifier} ${safeTerm(res.issue.title)}\n${res.issue.url}${res.event ? c.dim(`\nlinked in thread (${res.event.id})`) : ""}`);
  return EXIT.ok;
}
