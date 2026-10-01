import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive as ArchiveIcon, ArrowUpRight, ChevronRight, Laptop, Server } from "lucide-react";
import type { AgentState, AgentView, ArchiveCount, NodeView, TeamView } from "../../api/types.ts";
import { PageHeader } from "../../components/Shell.tsx";
import { LocalModelsCard } from "../../components/LocalModels.tsx";
import { ModelServerLoad } from "../../components/MachineStats.tsx";
import { Avatar, CopyCommand, EmptyState, StatePill, hueVar } from "../../components/primitives.tsx";
import { STATE_LABEL, STATE_RANK, askBody, canAnswer, displayName, hueFor, machineHue, needsAttention } from "../../lib/format.ts";
import { getRoute, hrefFor, navigate } from "../../lib/route.ts";
import { ago, useNow } from "../../lib/time.ts";
import { useStore } from "../../state/store.tsx";
import { archiveCountText, hiddenByNode, isArchived, shownByDefault } from "../../../../src/protocol/agent-roster.ts";
import { ActivityFeed } from "./ActivityFeed.tsx";
import { accountForAgent, AccountsRow } from "../../components/Accounts.tsx";
import type { AccountView } from "../../api/types.ts";
import { AgentGroupView, groupAgents } from "./Subagents.tsx";
import { ArchiveView } from "./Archive.tsx";
import { WalkieTalkieCard } from "../orchestrator/TalkieState.tsx";
import { rentalForNode, useCompute, type ComputeSnapshot } from "../../api/compute.ts";
import { AddComputeButton, AddComputeSheet } from "../compute/AddComputeSheet.tsx";
import { RentedChip } from "../compute/RentedChip.tsx";
import { projectCounts } from "../../lib/project-counts.ts";
import { useProjects } from "../../state/projects.ts";
import { api } from "../../api/client.ts";
import { LocalLagBanner, type LocalLag } from "./LocalLagBanner.tsx";

/** Mission Control shows working agents and those needing a person; the strip narrows it to one of those. */
type StateFilter = "all" | "working" | "waiting" | "blocked";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function sortAgents(list: AgentView[]): AgentView[] {
  return [...list].sort((a, b) => STATE_RANK[a.effective_state] - STATE_RANK[b.effective_state] || a.agent.localeCompare(b.agent));
}

function matches(a: AgentView, f: StateFilter): boolean {
  return f === "all" ? shownByDefault(a) : a.effective_state === f;
}

/** LiveView draws rows only for nodes belonging to listed team members. */
function defaultLiveAgents(shown: AgentView[], team: TeamView | null, nodes: NodeView[]): AgentView[] {
  return (team?.members ?? []).flatMap((member) => nodes.filter((node) => node.handle === member.handle)
    .flatMap((node) => shown.filter((agent) => agent.node === node.node_id)));
}

/** The live roster split: what Mission Control shows, and per machine what waits in the archive. */
export function useRosterSplit(): { shown: AgentView[]; hidden: ArchiveCount[]; archivedTotal: number } {
  const { agents, archive } = useStore();
  const now = Math.floor(useNow() / 30_000) * 30_000; // re-split every 30 s, not every render tick
  return useMemo(() => {
    // An agent the stream sent as live can have aged into the archive since (no new status announces that).
    const live = agents.map((a) => (isArchived(a, now) ? { ...a, archived: true } : a));
    const hidden = hiddenByNode(live, archive);
    return { shown: live.filter(shownByDefault), hidden, archivedTotal: hidden.reduce((n, h) => n + h.idle + h.offline, 0) };
  }, [agents, archive, now]);
}

function ProjectCountStrip({ shown }: { shown: readonly AgentView[] }) {
  const { projects } = useProjects();
  const counts = useMemo(() => projectCounts(shown, projects), [shown, projects]);
  if (!counts.length) return null;
  return (
    <ul className="project-counts" aria-label="Projects agents are working on" data-testid="project-counts">
      {counts.map((item) => {
        const label = `${item.name}${item.prefix ? ` (${item.prefix})` : ""}: ${plural(item.count, "agent")}`;
        return (
          <li key={item.channel ?? "none"} className={`chip project-count-chip${item.channel ? "" : " is-unmatched"}`} title={label}>
            <span className="sr-only">{label}</span>
            <span className="project-count-name" aria-hidden="true">{item.name}</span>
            <span className="project-count-n tnum" aria-hidden="true">{item.count}</span>
          </li>
        );
      })}
    </ul>
  );
}

function SummaryStrip({ agents, nodes, onPick, active }: { agents: AgentView[]; nodes: NodeView[]; onPick: (f: StateFilter) => void; active: StateFilter }) {
  const count = (s: AgentState) => agents.filter((a) => a.effective_state === s).length;
  const online = nodes.filter((n) => n.online).length;
  const stats: Array<{ id: StateFilter; n: number; label: string; tone: string }> = [
    { id: "working", n: count("working"), label: STATE_LABEL.working, tone: "working" },
    { id: "waiting", n: count("waiting"), label: STATE_LABEL.waiting, tone: "waiting" },
    { id: "blocked", n: count("blocked"), label: STATE_LABEL.blocked, tone: "blocked" },
  ];
  return (
    <div className="summary" role="group" aria-label="Show only">
      {stats.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`summary-stat tone-${s.tone} ${active === s.id ? "is-active" : ""} ${s.n === 0 ? "is-zero" : ""}`}
          onClick={() => onPick(active === s.id ? "all" : s.id)}
          aria-pressed={active === s.id}
        >
          <span className="summary-n tnum">{s.n}</span>
          <span className="summary-label"><span className="summary-dot" aria-hidden="true" />{s.label}</span>
        </button>
      ))}
      <div className="summary-stat summary-static">
        <span className="summary-n tnum">{online}<span className="summary-of">/{nodes.length}</span></span>
        <span className="summary-label">machines online</span>
      </div>
    </div>
  );
}

/** Open asks for you that no listed agent's row already offers (a person's ask, an agent that isn't waiting). */
function useAsksForMe(agents: AgentView[]) {
  const { asks, me, agents: roster } = useStore();
  const now = useNow();
  return asks.filter((v) => canAnswer(v, me?.handle ?? null, roster, now)
    && !agents.some((a) => v.ask.author.agent === a.agent && v.ask.author.node === a.node));
}

/**
 * At the top when anything needs the person (LIVE-3, Opus r1 UX): the Needs you section sits below every machine's
 * working agents, which on a busy fleet is far down. One line with the count; it jumps to the section.
 */
function NeedsYouBanner({ agents }: { agents: AgentView[] }) {
  const forMe = useAsksForMe(agents);
  const n = agents.length + forMe.length;
  if (!n) return null;
  const jump = () => document.querySelector(".attention")?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <button type="button" className="needs-banner" onClick={jump} data-testid="needs-you-banner">
      <span className="needs-banner-dot" aria-hidden="true" />
      <span>Needs you <span className="tnum">({n})</span></span>
      <span className="needs-banner-go muted">Jump to it</span>
    </button>
  );
}

function AttentionList({ agents, onOpen }: { agents: AgentView[]; onOpen: (id: string) => void }) {
  const { asks, team } = useStore();
  const now = useNow();
  const forMe = useAsksForMe(agents);
  if (!agents.length && !forMe.length) return null;
  return (
    <section className="attention" aria-labelledby="attention-h">
      <h2 className="section-title" id="attention-h">Needs you <span className="section-count tnum">{agents.length + forMe.length}</span></h2>
      {forMe.length > 0 && (
        <a className="attention-asks" href={hrefFor({ view: "asks" })} data-testid="attention-asks">
          <span className="tnum">{forMe.length}</span> open {forMe.length === 1 ? "ask" : "asks"} for you
          <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden="true" />
        </a>
      )}
      {agents.length > 0 && <ul className="attention-list">
        {agents.map((a) => {
          const openAsk = asks.find((v) => v.state === "open" && v.ask.author.agent === a.agent && v.ask.author.node === a.node && askBody(v.ask).expires_at > now);
          return (
            <li key={a.id} className={`attention-row is-${a.effective_state}`}>
              <button type="button" className="attention-main" onClick={() => onOpen(a.id)}>
                <StatePill state={a.effective_state} />
                <span className="attention-who">
                  <span className="mono">{a.agent}</span>
                  <span className="muted"> · {displayName(team?.members, a.handle).split(" ")[0]} · {a.hostname}</span>
                </span>
                <span className="attention-title truncate">{a.status.title}</span>
                <span className="attention-time tnum muted">{ago(a.updated_at, now)}</span>
              </button>
              <span className="attention-cta-slot">
                {openAsk && (
                  <a className="btn btn-sm attention-cta" href={hrefFor({ view: "asks" })}>
                    Answer ask <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden="true" />
                  </a>
                )}
              </span>
            </li>
          );
        })}
      </ul>}
    </section>
  );
}

function ArchiveLink({ node, count }: { node: NodeView; count: ArchiveCount | undefined }) {
  const text = count ? archiveCountText(count) : "";
  if (!text) return null;
  return (
    <a className="machine-archive" href={hrefFor({ view: "mission", tab: "archive", machine: node.hostname })} data-testid={`archive-link-${node.hostname}`}>
      <ArchiveIcon size={12} strokeWidth={1.75} aria-hidden="true" />
      <span className="tnum">{text}</span>
      <span>in the archive</span>
      <ChevronRight size={12} strokeWidth={1.75} aria-hidden="true" />
    </a>
  );
}

function MachineBlock({ node, agents, hidden, accounts, onOpen, filtered, compute, owner }: {
  node: NodeView; agents: AgentView[]; hidden: ArchiveCount | undefined; accounts: AccountView[]; onOpen: (id: string) => void; filtered: boolean;
  compute: ComputeSnapshot; owner: boolean;
}) {
  const rental = rentalForNode(compute.state, node.node_id);
  const Icon = /mbp|air|x1|laptop|studio|macbook/.test(node.hostname) ? Laptop : Server;
  const sync = !node.online ? (node.sync.error ?? "unreachable") : node.sync.behind > 0 ? `syncing, ${node.sync.behind} behind` : "in sync";
  const known = agents.length + (hidden ? hidden.idle + hidden.offline : 0);
  const working = agents.filter((a) => a.effective_state === "working").length;
  return (
    <div className={`machine ${node.online ? "" : "is-offline"}`} data-testid={`machine-${node.hostname}`} style={hueVar("--mh", machineHue(node.hostname))}>
      <div className="machine-head">
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" className="machine-icon" />
        <span className="machine-name mono">{node.hostname}</span>
        {node.self && <span className="chip">this machine</span>}
        {rental && <RentedChip rental={rental} quotes={compute.quotes} canStop={owner} />}
        <span className={`machine-live tnum${working ? " is-on" : ""}`} data-testid={`machine-live-${node.hostname}`}>{working} working</span>
        <span className={`dot ${node.online ? "dot-on" : "dot-off"}`} aria-hidden="true" />
        <span className="machine-stat tnum">{node.online ? (node.self ? "local" : `${node.rtt_ms ?? "?"} ms`) : "offline"}</span>
        <span className={`machine-stat ${node.online && node.sync.behind > 0 ? "is-warn" : ""} ${!node.online ? "is-bad" : ""}`}>{sync}</span>
      </div>
      {!!node.stats?.model_servers?.length && <p className="machine-quiet"><ModelServerLoad stats={node.stats} /></p>}
      {agents.length > 0 && (
        <div className="agent-grid">
          {groupAgents(agents).map((g) => <AgentGroupView key={g.agent.id} group={g} account={accountForAgent(accounts, g.agent)} onOpen={onOpen} />)}
        </div>
      )}
      {agents.length === 0 && !filtered && known > 0 && <p className="machine-quiet">Nothing working on this machine right now.</p>}
      {agents.length === 0 && !filtered && known === 0 && (
        <div className="machine-empty">
          <span>No agents reporting from this machine.</span>
          <CopyCommand command="walkie hooks install claude" />
        </div>
      )}
      <ArchiveLink node={node} count={hidden} />
    </div>
  );
}

export function MissionControl() {
  const route = getRoute();
  const tab = route.tab === "archive" ? "archive" : "live";
  const { shown, hidden, archivedTotal } = useRosterSplit();
  const { me, team, nodes } = useStore();
  const counted = useMemo(() => defaultLiveAgents(shown, team, nodes), [shown, team, nodes]);
  const compute = useCompute(me?.role === "owner");
  const [renting, setRenting] = useState(false);
  const [localLag, setLocalLag] = useState<LocalLag | null>(null);
  const now = useNow();
  useEffect(() => {
    let active = true;
    const refresh = () => { void api.peers().then((res) => { if (active) setLocalLag(res.local_lag ?? null); }).catch(() => {}); };
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const closeRenting = useCallback(() => setRenting(false), []);
  return (
    <div className="mission">
      <div className="mission-main">
        <PageHeader title="Mission Control" actions={me?.role === "owner" && compute.quotes?.available === true ? <AddComputeButton onOpen={() => setRenting(true)} /> : undefined} />
        <LocalLagBanner lag={localLag} now={now} />
        {tab === "live" && <ProjectCountStrip shown={counted} />}
        <nav className="tabs" role="tablist" aria-label="Agents">
          <a role="tab" aria-selected={tab === "live"} href={hrefFor({ view: "mission" })} className={tab === "live" ? "tab-link is-on" : "tab-link"}>Live</a>
          <a role="tab" aria-selected={tab === "archive"} href={hrefFor({ view: "mission", tab: "archive" })} className={tab === "archive" ? "tab-link is-on" : "tab-link"} data-testid="archive-tab">
            Archive <span className="seg-n tnum">{archivedTotal}</span>
          </a>
        </nav>
        {tab === "archive" ? <ArchiveView machine={route.machine} /> : <LiveView shown={shown} hidden={hidden} />}
      </div>
      <ActivityFeed />
      {tab === "live" && <MissionExtras />}
      {renting && <AddComputeSheet onClose={closeRenting} />}
    </div>
  );
}

function LiveView({ shown, hidden }: { shown: AgentView[]; hidden: ArchiveCount[] }) {
  const { team, nodes, me, accounts } = useStore();
  const owner = me?.role === "owner";
  const compute = useCompute(owner);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [people, setPeople] = useState<string[]>([]);
  const open = useCallback((id: string) => navigate({ ...getRoute(), agent: id }), []);

  const members = useMemo(() => {
    const list = team?.members ?? [];
    return [...list].sort((a, b) => (a.handle === me?.handle ? -1 : b.handle === me?.handle ? 1 : 0));
  }, [team?.members, me?.handle]);

  const attention = useMemo(() => sortAgents(shown.filter((a) => needsAttention(a.effective_state) && (!people.length || people.includes(a.handle)))), [shown, people]);
  const filtering = stateFilter !== "all" || people.length > 0;
  const togglePerson = (h: string) => setPeople((p) => (p.includes(h) ? p.filter((x) => x !== h) : [...p, h]));
  const everyone = shown.length + hidden.reduce((n, h) => n + h.idle + h.offline, 0);

  const sections = members
    .filter((m) => !people.length || people.includes(m.handle))
    .map((m) => {
      const machines = nodes.filter((n) => n.handle === m.handle).map((n) => ({
        node: n,
        agents: sortAgents(shown.filter((a) => a.node === n.node_id && matches(a, stateFilter))),
        hidden: hidden.find((h) => h.node === n.node_id),
      }));
      const list = filtering ? machines.filter((x) => x.agents.length) : machines;
      return { member: m, machines: list, working: shown.filter((a) => a.handle === m.handle).length };
    })
    .filter((s) => s.machines.length || !filtering);

  return (
    <>
      <p className="mission-lede">
        {plural(shown.filter((a) => a.effective_state === "working").length, "agent")} working
        {attention.length > 0 && <> · {attention.length} need{attention.length === 1 ? "s" : ""} you</>}
        {" "}on {plural(nodes.length, "machine")}. Idle and ended agents are in the <a href={hrefFor({ view: "mission", tab: "archive" })}>Archive</a>.
      </p>
      <SummaryStrip agents={shown} nodes={nodes} active={stateFilter} onPick={setStateFilter} />
      <NeedsYouBanner agents={attention} />

      {members.length > 1 && (
        <div className="filters" role="toolbar" aria-label="Filter agents">
          <div className="people-filter" aria-label="People">
            {members.map((m) => {
              const on = people.includes(m.handle);
              return (
                <button key={m.handle} type="button" className={on ? "person-chip is-on" : "person-chip"} aria-pressed={on} onClick={() => togglePerson(m.handle)} title={m.display_name ?? m.handle}>
                  <Avatar handle={m.handle} name={m.display_name ?? m.handle} size={18} />
                  <span>{(m.display_name ?? m.handle).split(" ")[0]}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {everyone === 0 && !filtering ? (
        <EmptyState title="No agents are reporting yet" command="walkie hooks install claude">
          <p>
            Install the hooks on each machine and every Claude Code or Codex session shows up here. No tokens spent. Shared with your
            team: each session's state (working, idle, waiting, stuck, offline), runtime, model, machine, person, repo name and
            branch. Titles your agents set with <code>walkie_set_status</code> are shared; prompt text is not, unless{" "}
            <code>share_prompts</code> is on; commands, file names and notification text only with{" "}
            <code>share_activity</code> on; directory paths only with <code>share_paths</code> on (all off by default).
            Codex app / IDE sessions (<code>codex app-server</code>) are not discovered: they report when a turn ends and when they
            call <code>walkie_set_status</code>.
          </p>
        </EmptyState>
      ) : sections.length === 0 ? (
        <EmptyState title="Nothing matches these filters">
          <button type="button" className="btn btn-sm" onClick={() => { setStateFilter("all"); setPeople([]); }}>Clear filters</button>
        </EmptyState>
      ) : (
        sections.map(({ member, machines, working }) => (
          <section key={member.handle} className="person" aria-labelledby={`p-${member.handle}`}>
            <header className="person-head" style={hueVar("--ph", hueFor(member.handle))}>
              <Avatar handle={member.handle} name={member.display_name ?? member.handle} size={26} />
              <h2 className="person-name" id={`p-${member.handle}`}>{member.display_name ?? member.handle}</h2>
              <span className="person-handle mono">@{member.handle}</span>
              {member.handle === me?.handle && <span className="chip">you</span>}
              <span className="person-meta tnum">{plural(working, "active agent")} · {plural(nodes.filter((n) => n.handle === member.handle).length, "machine")}</span>
            </header>
            {machines.length ? (
              machines.map(({ node, agents: list, hidden: h }) => <MachineBlock key={node.node_id} node={node} agents={list} hidden={h} accounts={accounts} onOpen={open} filtered={filtering} compute={compute} owner={owner} />)
            ) : (
              <div className="machine-empty"><span>No machines joined yet.</span><CopyCommand command="walkie join <teammate-machine>" /></div>
            )}
          </section>
        ))
      )}

      {stateFilter === "all" && <AttentionList agents={attention} onOpen={open} />}
    </>
  );
}

/** Below the feed: provider accounts as one compact row (expands to the grid), then what the team could run locally. */
function MissionExtras() {
  const { nodes, accounts } = useStore();
  const now = useNow();
  return (
    <div className="mission-extras">
      <WalkieTalkieCard />
      <AccountsRow accounts={accounts} now={now} />
      <LocalModelsCard nodes={nodes} />
    </div>
  );
}
