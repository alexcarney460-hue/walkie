// The machine page (#/machines/<node-id>): everything the team knows about one machine, live over the stream. The
// header (owner, platform, Walkie version, how it is reached, roster authority), live stats, its agents (working and
// needing a person first; idle and archived agents in a collapsed section), the accounts its agents use, the largest
// local model it could run on its own, and open asks to or from it. Only data the daemon already shares: agent
// titles follow the team's share settings because they come from the same /v1/agents roster as Mission Control.
import { useCallback, useMemo, useState } from "react";
import { ChevronLeft, CircleHelp, Crown, Laptop, Server } from "lucide-react";
import type { AccountView, AgentView, AskView, NodeView } from "../../api/types.ts";
import { AccountTile, accountForAgent } from "../../components/Accounts.tsx";
import { AskAnswer } from "../../components/AskAnswer.tsx";
import { PickRow } from "../../components/LocalModels.tsx";
import { useModels, type ModelsInput } from "../../lib/models.ts";
import { Avatar, EmptyState, ErrorState, RelTime, hueVar } from "../../components/primitives.tsx";
import { askBody, canAnswer, displayName, effectiveAskState, machineHue, STATE_RANK } from "../../lib/format.ts";
import { getRoute, goBack, hrefFor, navigate, useRoute } from "../../lib/route.ts";
import { agoLong, useNow } from "../../lib/time.ts";
import { useStore } from "../../state/store.tsx";
import { bestLabel, rankingNote } from "../../../../src/pool/format.ts";
import { suggestTeam } from "../../../../src/pool/suggest.ts";
import { AgentCard } from "../mission/AgentCard.tsx";
import { MachineGauges } from "./MachineGauges.tsx";
import { useMachineArchive } from "./machine-archive.ts";

const OS_LABEL = { darwin: "macOS", linux: "Linux", win32: "Windows", other: "Other OS" } as const;
const ACTIVE = new Set(["working", "waiting", "blocked"]);

/** How this machine is reached from the one viewing the page. */
export function transportText(n: NodeView): string {
  if (n.self) return "This machine";
  const rtt = n.rtt_ms !== null ? ` · ${n.rtt_ms} ms` : "";
  if (n.via === "relay") return "Relayed through a teammate's machine";
  if (n.via === "direct" || (!n.via && n.transports?.includes("direct") && !n.transports.includes("tailscale"))) return `Walkie Direct${rtt}`;
  return `Tailscale${n.ip ? ` · ${n.ip}` : ""}${rtt}`;
}

/** Open asks sent to this machine (its person's address on it, or one of its agents) or asked from it. */
export function machineAsks(asks: readonly AskView[], n: NodeView, now: number): AskView[] {
  return asks.filter((v) => {
    if (effectiveAskState(v, now) !== "open") return false;
    if (v.ask.author.node === n.node_id) return true;
    const [handle, host] = askBody(v.ask).to.slice(1).split("/");
    return handle === n.handle && host === n.hostname;
  });
}

/** Live agents on the machine, split: working or needing a person first, then idle. */
export function splitAgents(agents: readonly AgentView[], nodeId: string): { active: AgentView[]; idle: AgentView[] } {
  const mine = agents.filter((a) => a.node === nodeId && !a.archived)
    .sort((a, b) => STATE_RANK[a.effective_state] - STATE_RANK[b.effective_state] || b.updated_at - a.updated_at);
  return { active: mine.filter((a) => ACTIVE.has(a.effective_state)), idle: mine.filter((a) => !ACTIVE.has(a.effective_state)) };
}

function Header({ node }: { node: NodeView }) {
  const { team, me, nodes } = useStore();
  const now = useNow();
  const sys = node.stats?.sys;
  const version = node.self ? me?.version : sys?.version;
  const behind = !node.self && me?.version && version && version !== me.version;
  const authority = node.authority ?? (team?.authority === node.node_id);
  const Icon = (node.stats?.accel?.gpus.length ?? 0) > 0 || sys?.os === "linux" ? Server : Laptop;
  const others = nodes.filter((n) => n.handle === node.handle).length;
  return (
    <header className="mh" style={hueVar("--mh", machineHue(node.hostname))}>
      <button type="button" className="btn btn-ghost btn-sm mh-back" onClick={() => goBack({ view: "team" })}>
        <ChevronLeft size={15} strokeWidth={2} aria-hidden="true" />
        Back
      </button>
      <div className="mh-main">
        <span className={`mh-icon${node.online ? " is-on" : ""}`} aria-hidden="true"><Icon size={26} strokeWidth={1.6} /></span>
        <div className="mh-text">
          <h1 className="page-title mh-title mono">{node.hostname}</h1>
          <p className="mh-status">
            <span className={`mh-dot${node.online ? " is-on" : ""}`} aria-hidden="true" />
            {node.online ? "Online" : node.last_seen ? <>Offline · last seen {agoLong(node.last_seen, now)}</> : "Offline · never seen"}
            {node.self && <span className="chip">this machine</span>}
            {authority && <span className="chip mh-authority"><Crown size={11} strokeWidth={2} aria-hidden="true" />roster authority</span>}
          </p>
        </div>
      </div>
      <dl className="mh-facts">
        <div>
          <dt>Owner</dt>
          <dd className="mh-owner">
            <Avatar handle={node.handle} name={displayName(team?.members, node.handle)} size={18} />
            {displayName(team?.members, node.handle)} <span className="muted mono">@{node.handle}</span>
            {others > 1 && <span className="muted"> · {others} machines</span>}
          </dd>
        </div>
        <div>
          <dt>System</dt>
          <dd>{[sys ? `${OS_LABEL[sys.os]} · ${sys.arch}` : null, node.stats?.accel?.chip ?? null].filter(Boolean).join(" · ") || "not reported"}</dd>
        </div>
        <div>
          <dt>Walkie</dt>
          <dd className="mono">{version ?? "not reported"}{behind && <span className="mh-behind"> · your machine: {me?.version}</span>}</dd>
        </div>
        <div>
          <dt>Connection</dt>
          <dd>{transportText(node)}</dd>
        </div>
      </dl>
    </header>
  );
}

/** Idle live agents plus the machine's archive (loaded when the section opens, a page at a time). */
function IdleAndArchived({ node, idle, onOpen }: { node: NodeView; idle: AgentView[]; onOpen: (id: string) => void }) {
  const { archive, accounts, agents } = useStore();
  const [open, setOpen] = useState(false);
  const counts = archive.find((c) => c.node === node.node_id);
  const archivedCount = (counts?.idle ?? 0) + (counts?.offline ?? 0);
  const a = useMachineArchive(node.node_id, open, archivedCount);
  // An archived agent that started working again is live: it shows above, not twice.
  const liveIds = new Set(agents.filter((x) => x.node === node.node_id && !x.archived).map((x) => x.id));
  const archived = a.rows.filter((x) => !liveIds.has(x.id)).sort((x, y) => y.updated_at - x.updated_at);
  const total = idle.length + archivedCount;
  if (total === 0) return null;
  const known = a.total ?? archivedCount;
  return (
    <details className="mdx-more" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span>Idle and archived</span>
        <span className="seg-n tnum">{total}</span>
      </summary>
      <div className="agent-grid">
        {[...idle, ...archived].map((x) => <AgentCard key={x.id} agent={x} account={accountForAgent(accounts, x)} onOpen={onOpen} />)}
      </div>
      {a.loading && <p className="muted mdx-note">Loading the archive…</p>}
      {a.error && <ErrorState message={a.error} onRetry={a.retry} compact />}
      {!a.loading && !a.error && a.more && (
        <div className="mdx-archive-more">
          <span className="muted tnum" data-testid="archive-partial">Showing {a.rows.length} of {known} archived</span>
          <button type="button" className="btn btn-sm" onClick={a.loadMore}>Show more</button>
          <a className="text-link" href={hrefFor({ view: "mission", tab: "archive", machine: node.hostname })}>Open the full archive</a>
        </div>
      )}
    </details>
  );
}

function AgentsSection({ node }: { node: NodeView }) {
  const { agents, accounts } = useStore();
  const { active, idle } = useMemo(() => splitAgents(agents, node.node_id), [agents, node.node_id]);
  const onOpen = useCallback((id: string) => navigate({ ...getRoute(), agent: id }), []);
  return (
    <section className="section" aria-labelledby="mdx-agents-h">
      <header className="section-head">
        <h2 className="section-title" id="mdx-agents-h">Agents</h2>
        <span className="section-count tnum">{active.length} running</span>
      </header>
      {active.length === 0 ? (
        <EmptyState title={node.online ? `Nothing running on ${node.hostname} right now` : `${node.hostname} is offline`}>
          <p>{node.online ? "Agents show up here the moment a Claude Code, Codex or Kimi session starts working on this machine." : "Its agents come back here when the machine is online again."}</p>
        </EmptyState>
      ) : (
        <div className="agent-grid">
          {active.map((a) => <AgentCard key={a.id} agent={a} account={accountForAgent(accounts, a)} onOpen={onOpen} />)}
        </div>
      )}
      <IdleAndArchived node={node} idle={idle} onOpen={onOpen} />
    </section>
  );
}

function AccountsSection({ accounts, now }: { accounts: AccountView[]; now: number }) {
  if (!accounts.length) return null;
  return (
    <section className="section" aria-labelledby="mdx-acct-h">
      <header className="section-head">
        <h2 className="section-title" id="mdx-acct-h">Accounts on this machine</h2>
        <span className="section-count tnum">{accounts.length}</span>
        <a className="section-actions text-link" href={hrefFor({ view: "accounts" })}>All accounts</a>
      </header>
      <div className="acct-grid">{accounts.map((a) => <AccountTile key={a.key} account={a} now={now} />)}</div>
    </section>
  );
}

/** What this one machine could run (the machine page); exported for the tests and the phone-width render check. */
export function LocalModelSection({ node, models: override }: { node: NodeView; models?: ModelsInput }) {
  const models = useModels(override);
  const cat = models.view.catalog;
  const ranking = rankingNote(cat);
  const s = useMemo(() => suggestTeam([node], { cat }).headline, [node, cat]);
  if (!node.stats) return null;
  return (
    <section className="section lm-card mdx-lm" aria-labelledby="mdx-lm-h">
      <header className="lm-card-head">
        <h2 className="lm-card-title" id="mdx-lm-h">What it could run on its own</h2>
        <span className="lm-est">estimate</span>
      </header>
      {ranking && <p className="lm-card-note lm-ranking-note">{ranking}.</p>}
      {s?.single ? (
        <ul className="lm-picks">
          <PickRow label={`${bestLabel(s.single.model)} on this machine`} pick={s.single} cat={cat} />
          {s.faster && <PickRow label="Faster" pick={s.faster} cat={cat} />}
          {s.ifIdle && <PickRow label="If idle" pick={s.ifIdle} cat={cat} />}
        </ul>
      ) : (
        <p className="panel-empty">Nothing in the catalog fits in the memory free on {node.hostname} right now.</p>
      )}
    </section>
  );
}

function AsksSection({ list }: { list: AskView[] }) {
  const { me, agents } = useStore();
  const now = useNow();
  if (!list.length) return null;
  return (
    <section className="section" aria-labelledby="mdx-asks-h">
      <header className="section-head">
        <h2 className="section-title" id="mdx-asks-h">Open asks</h2>
        <span className="section-count tnum">{list.length}</span>
        <a className="section-actions text-link" href={hrefFor({ view: "asks" })}>All asks</a>
      </header>
      <ul className="mdx-asks">
        {list.map((v) => {
          const b = askBody(v.ask);
          return (
            <li key={v.ask.id} className="mdx-ask">
              <p className="mdx-ask-head">
                <CircleHelp size={14} strokeWidth={1.75} aria-hidden="true" />
                <span className="mono">{v.ask.author.agent ?? v.ask.author.handle}</span>
                <span className="muted">→</span>
                <span className="mono">{b.to}</span>
                <span className="muted"> · <RelTime ts={v.ask.ts} /></span>
              </p>
              <p className="mdx-ask-text">{b.text}</p>
              {canAnswer(v, me?.handle ?? null, agents, now) && me?.role !== "observer" && <AskAnswer view={v} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function MachineDetail() {
  const route = useRoute();
  const { nodes, team, accounts, asks } = useStore();
  const now = useNow();
  const node = nodes.find((n) => n.node_id === route.node) ?? team?.nodes.find((n) => n.node_id === route.node);
  const myAccounts = useMemo(() => accounts.filter((a) => a.machines.some((m) => m.node_id === route.node)), [accounts, route.node]);
  const openAsks = node ? machineAsks(asks, node, now) : [];
  if (!node) {
    return (
      <div className="page">
        <h1 className="sr-only">Machine not found</h1>
        <EmptyState title="We can't find that machine">
          <p>It may have left the team, or the link is from another team. <a className="text-link" href={hrefFor({ view: "team" })}>See every machine on the Team page</a>.</p>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="page mdx">
      <Header node={node} />
      {!node.online && (
        <p className="mdx-offline" role="status">
          {node.hostname} is offline. Stats and agents are what it last reported{node.last_seen ? `, ${agoLong(node.last_seen, now)}` : ""}.
        </p>
      )}
      <MachineGauges node={node} />
      <AgentsSection node={node} />
      <AsksSection list={openAsks} />
      <AccountsSection accounts={myAccounts} now={now} />
      <LocalModelSection node={node} />
    </div>
  );
}
