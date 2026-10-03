import { useCallback, useEffect, useState } from "react";
import { Lock, Plus } from "lucide-react";
import type { NodeView } from "../api/types.ts";
import { LocalModelsSection } from "../components/LocalModels.tsx";
import { MachineStatsLine } from "../components/MachineStats.tsx";
import { PageHeader } from "../components/Shell.tsx";
import { Avatar, RelTime, Section, hueVar } from "../components/primitives.tsx";
import { displayName, machineHue } from "../lib/format.ts";
import { hrefFor, useRoute } from "../lib/route.ts";
import { useStore } from "../state/store.tsx";
import { BillingPanel } from "./Billing.tsx";
import { AddMachineSheet } from "./AddMachineSheet.tsx";
import { ChannelForm, InviteForm, PendingJoins } from "./TeamForms.tsx";
import { PhoneDevices } from "./PhoneDevices.tsx";
import { rentalForNode, useCompute } from "../api/compute.ts";
import { AddComputeButton, AddComputeSheet, rentalStateLabel } from "./compute/AddComputeSheet.tsx";
import { RentedChip } from "./compute/RentedChip.tsx";
import { ACTIVE_STATES, COMPUTE_ALERT_TEXT } from "../../../src/protocol/compute.ts";

const ROLE_LABEL = { owner: "Owner", member: "Member", observer: "Observer" };

/** How a machine is reached: Walkie Direct (by its key, no address to show) or its tailnet IP. */
function NetworkCell({ n }: { n: NodeView }) {
  if (n.transports?.includes("direct")) return <span className="chip" title="Peer-to-peer QUIC, dialed by the machine's key; encrypted relay when a direct path can't be punched">Direct</span>;
  return <span className="mono dim">{n.ip ? `Tailscale · ${n.ip}` : "Tailscale"}</span>;
}

/** Members admitted by a Walkie Direct invite have no Tailscale login. */
function loginLabel(login: string): string {
  return login.startsWith("direct:") ? "Direct invite" : login;
}

function SyncCell({ n }: { n: NodeView }) {
  if (n.self) return <span className="muted">local</span>;
  if (!n.online) return <span className="text-red">{n.sync.error ?? "unreachable"}</span>;
  if (n.sync.behind > 0) return <span className="text-amber tnum">{n.sync.behind} events behind</span>;
  return <span className="dim">in sync{n.sync.last_sync ? <> · <RelTime ts={n.sync.last_sync} long /></> : null}</span>;
}

export function Team() {
  const { team, me, agents, nodes } = useStore();
  const route = useRoute();
  const plan = team?.plan ?? me?.plan ?? null;
  useEffect(() => {
    if (route.tab === "billing") document.getElementById("billing-h")?.scrollIntoView({ block: "start" });
    if (route.tab === "models") document.getElementById("models-h")?.scrollIntoView({ block: "start" });
  }, [route.tab, !!plan]);
  const [adding, setAdding] = useState<{ handle: string; name: string } | null>(null);
  const closeAdding = useCallback(() => setAdding(null), []);
  const [renting, setRenting] = useState(false);
  const closeRenting = useCallback(() => setRenting(false), []);
  const owner = me?.role === "owner";
  const compute = useCompute(owner);
  if (!team) return null;
  // RENT-2: rentals that haven't joined as a machine yet (queued, starting) are listed under the table.
  const unjoined = (compute.state?.rentals ?? []).filter((r) => ACTIVE_STATES.has(r.state) && !(r.node_id && nodes.some((n) => n.node_id === r.node_id)));
  const canCreateChannel = me?.role === "owner" || me?.role === "member";

  return (
    <div className="page">
      <PageHeader
        title={team.name}
        meta={<>Team <span className="mono">{team.id}</span> · you are {me?.role ? ROLE_LABEL[me.role].toLowerCase() : "a guest"}{me?.transport?.mode === "direct" ? <> · Walkie Direct</> : me?.tailscale.login ? <> as <span className="mono">{me.tailscale.login}</span></> : null}</>}
      />
      <div className="team-grid">
        <div className="team-main">
          <Section title="Members" meta={`${team.members.length}`} id="members-h">
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr><th scope="col">Person</th><th scope="col">Login</th><th scope="col">Role</th><th scope="col" className="num">Machines</th><th scope="col" className="num">Agents</th></tr>
                </thead>
                <tbody>
                  {team.members.map((m) => (
                    <tr key={m.handle}>
                      <td>
                        <span className="person-cell">
                          <Avatar handle={m.handle} name={m.display_name ?? m.handle} size={22} />
                          <span>{m.display_name ?? m.handle}</span>
                          <span className="mono muted">@{m.handle}</span>
                          {m.handle === me?.handle && <span className="chip">you</span>}
                        </span>
                      </td>
                      <td className="mono dim" data-label="Login">{loginLabel(m.login)}</td>
                      <td data-label="Role"><span className={`role role-${m.role}`}>{ROLE_LABEL[m.role]}</span></td>
                      <td className="num tnum" data-label="Machines">
                        <span className="machines-cell">
                          {nodes.filter((n) => n.handle === m.handle).length}
                          {owner && (
                            <button type="button" className="btn btn-ghost btn-icon btn-sm add-machine-btn" onClick={() => setAdding({ handle: m.handle, name: m.display_name ?? m.handle })}
                              aria-label={m.handle === me?.handle ? "Add another of my machines" : `Add a machine for @${m.handle}`} title={m.handle === me?.handle ? "Add another of my machines" : `Add a machine for @${m.handle}`}>
                              <Plus size={13} strokeWidth={2} aria-hidden="true" />
                            </button>
                          )}
                        </span>
                      </td>
                      <td className="num tnum" data-label="Agents">{agents.filter((a) => a.handle === m.handle).length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Machines" meta={`${nodes.filter((n) => n.online).length} of ${nodes.length} online`} id="machines-h"
            actions={owner && compute.quotes?.available === true ? <AddComputeButton onOpen={() => setRenting(true)} /> : undefined}>
            {compute.state?.alerts?.map(alert => <p key={alert} role="alert">{COMPUTE_ALERT_TEXT[alert]}</p>)}
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr><th scope="col">Machine</th><th scope="col">Owner</th><th scope="col">Network</th><th scope="col" className="num">Latency</th><th scope="col">Sync</th></tr>
                </thead>
                <tbody>
                  {nodes.map((n) => (
                    <tr key={n.node_id} className={n.online ? "machine-row" : "machine-row is-off"} style={hueVar("--mh", machineHue(n.hostname))}>
                      <td>
                        <span className="person-cell">
                          <span className={`dot ${n.online ? "dot-on" : "dot-off"}`} aria-label={n.online ? "online" : "offline"} />
                          <a className="mono text-link host-link" href={hrefFor({ view: "machine", node: n.node_id })} title="Open machine details">{n.hostname}</a>
                          {n.self && <span className="chip">this machine</span>}
                          {n.authority && <span className="chip" title="Writes the team roster; owners' changes go through it">roster authority</span>}
                          {(() => { const r = rentalForNode(compute.state, n.node_id); return r ? <RentedChip rental={r} quotes={compute.quotes} canStop={owner} /> : null; })()}
                        </span>
                        <MachineStatsLine node={n} part="cell" />
                      </td>
                      <td data-label="Owner">{displayName(team.members, n.handle)}</td>
                      <td data-label="Network"><NetworkCell n={n} /></td>
                      <td className="num tnum" data-label="Latency">{n.self ? "–" : n.online && n.rtt_ms !== null ? `${n.rtt_ms} ms` : <span className="muted">last seen {n.last_seen ? <RelTime ts={n.last_seen} long /> : "never"}</span>}</td>
                      <td data-label="Sync"><SyncCell n={n} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {unjoined.length > 0 && (
              <ul className="ac-rental-list rented-pending" aria-label="Rented machines not joined yet">
                <li className="rented-pending-h muted">Rented, not joined yet</li>
                {unjoined.map((r) => (
                  <li key={r.id} className="ac-rental" data-testid={`rented-pending-${r.id}`}>
                    <span className="mono">{r.name}</span>
                    <RentedChip rental={r} quotes={compute.quotes} canStop={owner} />
                    <span className={`chip ac-state is-${r.state}`}>{rentalStateLabel(r)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="What your team could run locally" meta="estimate" id="models-h">
            <LocalModelsSection nodes={nodes} />
          </Section>

          <Section title="Seats" id="seats-h">
            <p className="panel-empty">Start Claude Code or Codex agents on a teammate's machine, on its own sign-in, once its person allows it. <a className="text-link" href={hrefFor({ view: "seats" })}>Open Seats</a></p>
          </Section>
          <Section title="Channels" meta={`${team.channels.length}`} id="channels-h">
            <ul className="channel-rows">
              {team.channels.map((c) => (
                <li key={c.name} className="channel-row">
                  <a href={hrefFor({ view: "board", channel: c.name })} className="channel-row-name mono">
                    {c.members ? <Lock size={12} strokeWidth={1.75} aria-label="Restricted" /> : "#"}{c.name}
                  </a>
                  <span className="channel-row-topic dim">{c.topic ?? <span className="muted">No topic</span>}</span>
                  <span className="channel-row-meta muted tnum">
                    {c.members ? `${c.members.map((h) => `@${h}`).join(" ")} · ` : ""}{c.count} posts{c.last_ts ? <> · <RelTime ts={c.last_ts} long /></> : null}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>

        <div className="team-side">
          {plan && (
            <Section title="Billing" id="billing-h">
              <BillingPanel plan={plan} owner={owner} />
            </Section>
          )}
          {owner && (
            <Section title="Waiting to join" id="pending-h">
              <PendingJoins />
            </Section>
          )}
          {owner && (
            <Section title="Add a teammate" id="invite-h">
              <InviteForm />
            </Section>
          )}
          {canCreateChannel && (
            <Section title="New channel" id="newch-h">
              <ChannelForm />
            </Section>
          )}
          {me?.role && (
            <Section title="Devices" id="devices-h">
              <PhoneDevices />
            </Section>
          )}
          <Section title="Integrations" id="integrations-h">
            <p className="panel-empty">Fireflies, Wispr Flow and Linear post meeting and issue context into channels. <a className="text-link" href={hrefFor({ view: "integrations" })}>Set up integrations</a></p>
          </Section>
          {!owner && (
            <p className="panel-empty">Only owners can add teammates, add machines or approve them: to put Walkie on another of your machines, ask {team.members.filter((m) => m.role === "owner").map((m) => m.display_name ?? m.handle).join(" or ")} for an &ldquo;Add a machine&rdquo; link.</p>
          )}
        </div>
      </div>
      {adding && <AddMachineSheet handle={adding.handle} name={adding.name} onClose={closeAdding} />}
      {renting && <AddComputeSheet onClose={closeRenting} />}
    </div>
  );
}
