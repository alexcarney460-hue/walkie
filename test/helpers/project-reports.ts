// A throwaway team for the status report tests: alex, the team's owner, creator and roster authority, on a real Core with a
// projects index, a few projects (made by signed posts, so the plan's project quota never gets in the way), a list of agents
// the test sets, and teammates whose machines write events of their own. The clock is a mocked Date.now: it is what the
// store stamps every event it receives with, and "news" means received after the last report, so "after the report" is a
// tick later. It moves only when a test calls tick().
import { setSystemTime } from "bun:test";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import { createCard, updateProject, type WriteCtx } from "../../src/daemon/projects/service.ts";
import type { ReportDeps } from "../../src/daemon/projects/status-report.ts";
import { DEFAULT_COLUMNS, type CardView, type Column, type ProjectView } from "../../src/protocol/projects/schema.ts";
import type { AgentView, BodyOf, Event } from "../../src/protocol/schemas.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { feed, makeCore } from "./core.ts";
import { createTeam, ev, now, tnode } from "./events.ts";

export function reportsWorld(cleanups: (() => void)[]) {
  const alex = tnode("alex");
  const { team, create } = createTeam(alex);
  let wall = now();
  setSystemTime(new Date(wall));
  cleanups.push(() => setSystemTime());
  const core = makeCore(alex, team, cleanups, { clock: () => Date.now() });
  const idx = new ProjectsIndex(core, core.log);
  cleanups.push(() => idx.stop());
  core.onPostChange = (e, change) => idx.onPost(e, change);
  core.onRosterChange = () => idx.rosterChanged();
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, topic: "WalkieTalkie schedules", members: ["alex"] });
  idx.flushAll();
  const w: WriteCtx = { core, idx, client: {} as WriteCtx["client"], catchUp: async () => {} };
  let agents: AgentView[] = [];
  const deps: ReportDeps = { ...w, agents: () => agents };
  let count = 0;

  /** Moves the clock on (a second unless told otherwise) and returns the new time. */
  const tick = (ms = 1_000): number => { wall += ms; setSystemTime(new Date(wall)); return wall; };

  /** A project with one board (the default columns unless `columns`), switched to hourly reports unless `off`; `private` = restricted to the team's owners. */
  async function project(name: string, prefix: string, opts: { off?: boolean; description?: string; private?: boolean; columns?: Column[] } = {}): Promise<ProjectView> {
    const channel = `p-${(++count).toString(16).padStart(8, "0")}`;
    core.emit("channel.upsert", { name: channel, project: true, ...(opts.private ? { members: ["alex"] } : {}) });
    core.emit("msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name, prefix, ...(opts.description ? { description: opts.description } : {}) } } as BodyOf<"msg.post">, { channel });
    core.emit("msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: opts.columns ?? DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel });
    idx.flushAll();
    if (!opts.off) await updateProject(w, channel, { status_report: "hourly" });
    idx.flushAll();
    return idx.project(channel) as ProjectView;
  }
  const card = (p: ProjectView, title: string, extra: Partial<Parameters<typeof createCard>[2]> = {}): CardView => createCard(w, p.channel, { title, column: "todo", ...extra });

  /** An agent as the daemon's roster shows it: its state and activity began now unless `over` says otherwise. */
  const agent = (name: string, task: string, over: Partial<AgentView> = {}): AgentView => ({
    id: `alex/mbp/${name}`, handle: "alex", node: "n-other", hostname: "mbp", agent: name,
    status: { agent: name, state: "working", runtime: "claude-code", task }, updated_at: wall, state_since: wall, activity_since: wall, machine_online: true,
    effective_state: "working", archived: false, ...over,
  });

  /** A teammate with a machine of their own: what they write reaches this daemon as a remote event, at `ts` on their clock. */
  function teammate(handle: string, role: "member" | "owner" = "member") {
    const node = tnode(handle);
    core.emit("team.member", { login: node.login, handle, role });
    core.emit("team.node", { node_id: node.keys.nodeId, login: node.login, hostname: node.hostname, pubkey: node.keys.pubkey, ip: "127.0.0.1" });
    const post = (channel: string, body: Record<string, unknown>, ts?: number, agentName?: string): Event => {
      const e = ev(team, node, "msg.post", body as BodyOf<"msg.post">, { channel, ...(ts !== undefined ? { ts } : {}), ...(agentName ? { agent: agentName } : {}) });
      feed(core, [e]);
      idx.flushAll();
      return e;
    };
    return {
      node, post,
      /** A card created on their machine. */
      card: (p: ProjectView, title: string, ts?: number): Event => post(p.channel, {
        text: `New card: ${title}`, board: { v: 1, rev: 0, op: "card", board: (p.boards[0] as { id: string }).id, title, column: "todo", n: idx.db.maxN(p.channel) + 1 },
      }, ts),
      /** A comment they wrote on a card. */
      comment: (p: ProjectView, cardId: string, text: string, ts?: number): Event => post(p.channel, { text, thread: cardId }, ts),
    };
  }
  return { alex, team, core, idx, w, deps, project, card, agent, teammate, tick, wall: () => wall, setAgents: (list: AgentView[]) => { agents = list; } };
}
