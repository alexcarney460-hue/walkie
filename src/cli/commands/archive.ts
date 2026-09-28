// `walkie agents archive [--machine m] [--search q] [--limit n] [--offset n] [--json]` (WALKIE-MISSION-1): the agents
// Mission Control and `walkie who` leave out, idle or offline, newest first, per machine, with their last title and
// last seen. The daemon filters by machine and search BEFORE it cuts the page (fix round 1, Codex 6); the list is
// filtered again here so a daemon from before that change (which ignores the filters) gives the same answer.
import { switchCmd } from "./admin.ts";
import { archiveCountText, countByNode, matchesSearch, shownByDefault } from "../../protocol/agent-roster.ts";
import type { AgentView } from "../../protocol/schemas.ts";
import { agentViewJson, WHO_NOTE } from "../agent-output.ts";
import { int, need, str, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { ago, c, pad, safeTerm } from "../format.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

/** Idle / offline agents (live roster and archive), filtered by machine (hostname or node id) and search. */
export function archiveList(agents: readonly AgentView[], opts: { machine?: string; search?: string; limit?: number }): AgentView[] {
  return agents
    .filter((a) => !shownByDefault(a))
    .filter((a) => !opts.machine || a.hostname === opts.machine || a.node === opts.machine)
    .filter((a) => !opts.search || matchesSearch(a, opts.search))
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, opts.limit ?? DEFAULT_LIMIT);
}

export function renderArchive(list: readonly AgentView[], total: number, now = Date.now(), offset = 0): string {
  if (!list.length) return c.dim("the archive is empty for this filter");
  const lines: string[] = [];
  const hosts = [...new Set(list.map((a) => a.hostname))];
  for (const host of hosts) {
    const mine = list.filter((a) => a.hostname === host);
    const count = countByNode(mine)[0];
    lines.push(`${c.bold(safeTerm(host))} ${c.dim(`@${mine[0]?.handle ?? "?"} · ${count ? archiveCountText(count) : ""}`)}`);
    for (const a of mine) {
      const st = a.effective_state;
      const title = [a.status.title, a.status.task ? `(${a.status.task})` : ""].filter(Boolean).join(" ") || c.dim("(no title)");
      const where = a.status.repo ? `${a.status.repo}${a.status.branch ? `@${a.status.branch}` : ""}` : "";
      lines.push(`  ${pad(safeTerm(a.agent), 20)} ${pad(st === "idle" ? c.dim(st) : c.gray(st), 8)} ${pad(safeTerm(title).slice(0, 56), 58)} ${pad(safeTerm(where).slice(0, 30), 32)} ${c.dim(`seen ${ago(a.updated_at, now)} ago`)}`);
    }
  }
  const more = total - offset - list.length;
  if (more > 0) lines.push(c.dim(`… ${more} more (use --offset ${offset + list.length}, --limit, --machine or --search)`));
  return lines.join("\n");
}

async function archiveCmd(ctx: Ctx): Promise<number> {
  const limit = int(ctx.args, "limit", DEFAULT_LIMIT) ?? DEFAULT_LIMIT;
  if (limit < 1 || limit > MAX_LIMIT) throw new UsageError(`--limit must be 1–${MAX_LIMIT}`);
  const offset = int(ctx.args, "offset", 0) ?? 0;
  if (offset < 0) throw new UsageError("--offset must be 0 or more");
  const machine = str(ctx.args, "machine");
  const search = str(ctx.args, "search");
  const payload = await ctx.client().agents({
    scope: "all", states: ["idle", "offline"], limit, ...(offset ? { offset } : {}),
    ...(machine ? { node: machine } : {}), ...(search ? { q: search } : {}),
  });
  // A current daemon already filtered and paged (total counts every match); an older one sent every agent.
  const paged = payload.total !== undefined && payload.offset !== undefined;
  const every = archiveList(payload.agents, { machine, search, limit: paged ? limit : MAX_LIMIT * 1_000 });
  const list = paged ? every : every.slice(offset, offset + limit);
  const total = paged ? payload.total as number : every.length;
  if (ctx.json) {
    ctx.out(JSON.stringify({ agents: ctx.forAgent ? list.map(agentViewJson) : list, total, offset, truncated: offset + list.length < total }));
    return EXIT.ok;
  }
  const shown = ctx.forAgent ? list.map(agentViewJson) : list;
  ctx.out(`${ctx.forAgent ? `${WHO_NOTE}\n` : ""}${renderArchive(shown, total, Date.now(), offset)}`);
  return EXIT.ok;
}

/** `walkie agents <subcommand>`. */
export async function agentsCmd(ctx: Ctx): Promise<number> {
  const sub = need(ctx.args, 0, "subcommand (archive | admin)");
  if (sub === "archive") return archiveCmd(ctx);
  if (sub === "admin") return switchCmd(ctx, "agent_admin", ctx.args.pos[1]); // AGENT-ADMIN-1 kill switch
  throw new UsageError(`unknown agents subcommand: ${sub}`);
}
