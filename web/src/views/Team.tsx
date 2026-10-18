import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Lock, Plus, X } from "lucide-react";
import { RememberedDetails } from "../components/RememberedDetails.tsx";
import { PageHeader } from "../components/Shell.tsx";
import { Avatar, Section } from "../components/primitives.tsx";
import { displayName } from "../lib/format.ts";
import { hrefFor, useRoute } from "../lib/route.ts";
import { useStore } from "../state/store.tsx";
import { BillingPanel } from "./Billing.tsx";
import { AddMachineSheet } from "./AddMachineSheet.tsx";
import { FleetLinkList, FleetLinkSheet } from "./FleetLinks.tsx";
import { ChannelForm, InviteForm, PendingJoins } from "./TeamForms.tsx";
import { PhoneDevices } from "./PhoneDevices.tsx";
import { useCompute } from "../api/compute.ts";
import { AddComputeButton, AddComputeSheet, ComputeOnAuthority, CreditButton, authorityHost, computeAction, rentalStateLabel } from "./compute/AddComputeSheet.tsx";
import { RentedChip } from "./compute/RentedChip.tsx";
import { ACTIVE_STATES, COMPUTE_ALERT_TEXT } from "../../../src/protocol/compute.ts";
import { useHomeNeeds } from "./home/needs.tsx";

const ROLE_LABEL = { owner: "Owner", member: "Member", observer: "Observer" };

function FormSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const before = typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("keydown", keydown); before?.focus(); };
  }, []);
  return <div className="palette-layer" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="palette dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header className="dialog-head"><h2 className="dialog-title">{title}</h2><button ref={closeRef} type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}><X size={16} /></button></header>
      <div className="dialog-body">{children}</div>
    </div>
  </div>;
}

export function Team() {
  const { team, me, agents, nodes } = useStore();
  const route = useRoute();
  const owner = me?.role === "owner";
  const canCreateChannel = owner || me?.role === "member";
  const compute = useCompute(owner);
  const { pending, pendingStatus } = useHomeNeeds();
  const [adding, setAdding] = useState<{ handle: string; name: string } | null>(null);
  const [renting, setRenting] = useState(false);
  const [fleet, setFleet] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const closeAdding = useCallback(() => setAdding(null), []);
  const closeRenting = useCallback(() => setRenting(false), []);
  const closeFleet = useCallback(() => setFleet(false), []);
  const closeInviting = useCallback(() => setInviting(false), []);
  const closeChannel = useCallback(() => setCreatingChannel(false), []);
  useEffect(() => {
    if (route.tab === "billing") document.getElementById("billing-h")?.scrollIntoView({ block: "start" });
  }, [route.tab, !!team?.plan]);
  if (!team) return null;
  const plan = team.plan ?? me?.plan ?? null;
  const rentals = (compute.state?.rentals ?? []).filter((r) => ACTIVE_STATES.has(r.state));

  return <div className="page team-page">
    <PageHeader title={team.name} meta={`${team.members.length} people · ${nodes.length} machines`} />
    {owner && (pending.length > 0 || pendingStatus === "error") && <Section title="Waiting to join" id="pending-h"><PendingJoins /></Section>}
    <Section title="Members" meta={`${team.members.length}`} id="members-h"
      actions={owner ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setInviting(true)}><Plus size={14} />Add a teammate</button> : undefined}>
      <div className="table-wrap"><table className="table table-compact"><thead><tr><th scope="col">Person</th><th scope="col">Login</th><th scope="col">Role</th><th scope="col" className="num">Machines</th><th scope="col" className="num">Agents</th></tr></thead>
        <tbody>{team.members.map((member) => <tr key={member.handle}>
          <td><span className="person-cell"><Avatar handle={member.handle} name={member.display_name ?? member.handle} size={22} /><span>{member.display_name ?? member.handle}</span>{member.handle === me?.handle && <span className="chip">you</span>}</span></td>
          <td data-label="Login">{member.login.startsWith("direct:") ? "Direct invite" : member.login}</td>
          <td data-label="Role"><span className={`role role-${member.role}`}>{ROLE_LABEL[member.role]}</span></td>
          <td className="num tnum" data-label="Machines">{nodes.filter((node) => node.handle === member.handle).length} {owner && <button type="button" className="btn btn-ghost btn-icon btn-sm add-machine-btn" aria-label={member.handle === me?.handle ? "Add another of my machines" : `Add a machine for @${member.handle}`} onClick={() => setAdding({ handle: member.handle, name: member.display_name ?? member.handle })}><Plus size={13} /></button>}</td>
          <td className="num tnum" data-label="Agents">{agents.filter((agent) => agent.handle === member.handle).length}</td>
        </tr>)}</tbody></table></div>
    </Section>
    <Section title="Machines" meta={`${nodes.filter((node) => node.online).length} of ${nodes.length} online`} id="machines-h"
      actions={owner ? <button type="button" className="btn btn-sm" title="One link that adds many machines" onClick={() => setFleet(true)}><Plus size={13} />Add machines</button> : undefined}>
      <div className="table-wrap"><table className="table table-compact"><thead><tr><th scope="col">Machine</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col">Open</th></tr></thead>
        <tbody>{nodes.map((node) => <tr key={node.node_id} className={node.online ? "machine-row" : "machine-row is-off"}>
          <td>{node.hostname}{node.self && <span className="chip">this machine</span>}</td>
          <td data-label="Owner">{displayName(team.members, node.handle)}</td>
          <td data-label="Status"><span className={`dot ${node.online ? "dot-on" : "dot-off"}`} aria-hidden="true" /> {node.online ? "Online" : "Offline"}</td>
          <td className="machine-open" data-label="Open"><a href={hrefFor({ view: "machine", node: node.node_id })}>Open</a></td>
        </tr>)}</tbody></table></div>
      {!owner && <p className="muted">To put Sqwakie on another of your machines, ask {team.members.filter((member) => member.role === "owner").map((member) => member.display_name ?? member.handle).join(" or ")} for an “Add a machine” link (or a fleet link, for many machines).</p>}
    </Section>
    {plan && <Section title="Billing" id="billing-h"><BillingPanel plan={plan} owner={owner} /></Section>}
    <Section title="Channels" meta={`${team.channels.length}`} id="channels-h"
      actions={canCreateChannel ? <button type="button" className="btn btn-sm" onClick={() => setCreatingChannel(true)}><Plus size={14} />New channel</button> : undefined}>
      <ul className="channel-rows">{team.channels.map((channel) => <li key={channel.name} className="channel-row">
        <a href={hrefFor({ view: "board", channel: channel.name })} className="channel-row-name">{channel.members ? <Lock size={12} aria-label="Restricted" /> : "#"}{channel.name}</a>
        <span className="channel-row-topic dim">{channel.topic ?? "No topic"}</span>
      </li>)}</ul>
    </Section>
    <RememberedDetails id="team-advanced" summary="Advanced" className="team-advanced">
      {owner && <Section title="Fleet links" id="fleet-h"><FleetLinkList /></Section>}
      {me?.role && <Section title="Devices" id="devices-h"><PhoneDevices /></Section>}
      <Section title="Integrations" id="integrations-h"><a href={hrefFor({ view: "integrations" })}>Set up integrations</a></Section>
      <Section title="Seats" id="seats-h"><a href={hrefFor({ view: "seats" })}>Open Seats</a></Section>
      {owner && <Section title="Rented machines" id="rentals-h">
        {compute.state?.alerts?.map((alert) => <p key={alert} role="alert">{COMPUTE_ALERT_TEXT[alert]}</p>)}
        {computeAction(compute) === "rent" && (compute.authorityRequired ? <ComputeOnAuthority host={authorityHost(nodes, team.authority)} /> : <AddComputeButton onOpen={() => setRenting(true)} />)}
        {computeAction(compute) === "credit" && <CreditButton onOpen={() => setRenting(true)} />}
        {rentals.length > 0 && <ul className="ac-rental-list">{rentals.map((rental) => <li key={rental.id} data-testid={rental.node_id && nodes.some((node) => node.node_id === rental.node_id) ? `rented-joined-${rental.id}` : `rented-pending-${rental.id}`}>
          {rental.node_id && nodes.some((node) => node.node_id === rental.node_id) ? <a href={hrefFor({ view: "machine", node: rental.node_id })}>{rental.name}</a> : <span>{rental.name}</span>}
          <RentedChip rental={rental} quotes={compute.quotes} canStop={owner} /><span>{rentalStateLabel(rental)}</span>
        </li>)}</ul>}
      </Section>}
    </RememberedDetails>
    {adding && <AddMachineSheet handle={adding.handle} name={adding.name} onClose={closeAdding} />}
    {renting && <AddComputeSheet onClose={closeRenting} />}
    {fleet && <FleetLinkSheet onClose={closeFleet} />}
    {inviting && <FormSheet title="Add a teammate" onClose={closeInviting}><InviteForm /></FormSheet>}
    {creatingChannel && <FormSheet title="New channel" onClose={closeChannel}><ChannelForm /></FormSheet>}
  </div>;
}
