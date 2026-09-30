import type { Core } from '../core.js';
import type { Event } from '../../protocol/schemas.js';

/** Export only already accepted authority transfers, in their applied order. */
export function rosterProof(core: Core): { genesis: Event; roster_events: Event[]; authority_chain: { event: Event; key: string }[] } {
  const genesis = core.store.teamCreate();
  if (!genesis) throw new Error('team genesis unavailable');
  const entries = core.rosterEntries();
  const selected = new Set<string>();
  const members = new Map<string, Event>();
  const nodes = new Map<string, Event>();
  const nodeAdmissions = new Map<string, Event>();
  const authority_chain: { event: Event; key: string }[] = [];
  members.set(genesis.body.owner_login as string, genesis);
  nodes.set(genesis.origin, genesis);
  for (const event of entries) {
    if (event.kind === 'team.member') members.set(event.body.login as string, event);
    if (event.kind === 'team.node') {
      nodes.set(event.body.node_id as string, event);
      const admission = members.get(event.body.login as string);
      if (admission) nodeAdmissions.set(event.body.node_id as string, admission);
    }
    if (event.kind !== 'team.authority') continue;
    const node = nodes.get(event.body.node_id as string);
    if (!node || node.body.revoked === true) throw new Error('authority admission unavailable');
    const member = members.get(node.kind === 'team.create' ? node.body.owner_login as string : node.body.login as string);
    if (!member || (member.kind !== 'team.create' && member.body.role !== 'owner')) throw new Error('authority owner admission unavailable');
    const admission = nodeAdmissions.get(event.body.node_id as string);
    if (admission && admission.kind !== 'team.create') selected.add(admission.id);
    if (member.kind !== 'team.create') selected.add(member.id);
    if (node.kind !== 'team.create') selected.add(node.id);
    selected.add(event.id);
    authority_chain.push({ event, key: node.kind === 'team.create' ? node.body.node_pubkey as string : node.body.pubkey as string });
  }
  // Keep every change to an owner login, including demotion and revocation, without
  // expanding proofs with ordinary members unrelated to ownership.
  const ownerLogins = new Set<string>([genesis.body.owner_login as string]);
  for (const event of entries) if (event.kind === 'team.member' && event.body.role === 'owner')
    ownerLogins.add(event.body.login as string);
  const roster_events = entries.filter(event => selected.has(event.id) ||
    event.kind === 'team.member' && ownerLogins.has(event.body.login as string) ||
    event.kind === 'team.node' && ownerLogins.has(event.body.login as string));
  return { genesis, roster_events, authority_chain };
}
