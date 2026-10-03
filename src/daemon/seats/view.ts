// GET /v1/seats (PROTOCOL §11): the seats this member can see, rebuilt from the seats channels' posts. A request is
// any valid `seat.op: run` post; its state and output count only when posted by the host machine's daemon itself
// (origin = the channel's node, agent `seats`), so a launcher can't fake a result.
import type { Event } from "../../protocol/schemas.ts";
import {
  DEFAULT_SEAT_MODE, SEATS_AGENT, SEATS_PREFIX, TERMINAL_STATES, seatOf, seatsChannel, seatsChannelNode,
  type AnySeatRun, type HostAvailability, type SeatHostView, type SeatView,
} from "../../protocol/seats.ts";
import type { Core } from "../core.ts";
import { seatsFor } from "./host.ts";
import type { SyncManager } from "../sync.ts";
import { agentRowView } from "../agent-view-cache.ts";

const PER_CHANNEL = 2_000;
const MAX_SEATS = 100;

/**
 * A host's availability: this machine's own from its seats host; another's from its latest host post in its seats
 * channel (only its own daemon speaks for it), when I am a member there; undefined when it never said.
 */
export function hostAvailability(core: Core, node: string): HostAvailability | undefined {
  if (node === core.nodeId) {
    const h = seatsFor(core);
    return h?.allowed ? h.availability() : undefined;
  }
  const channel = seatsChannel(node);
  const me = core.myHandle();
  if (!me || !core.roster.channels.get(channel)?.members?.includes(me)) return undefined;
  for (const row of core.store.queryEvents({ channel, kinds: ["msg.post"], agents: [SEATS_AGENT], roots: true, limit: 50 })) {
    const ev = JSON.parse(row.json) as Event;
    if (ev.origin !== node || ev.author.agent !== SEATS_AGENT) continue;
    const s = seatOf(ev.body);
    if (s?.op !== "host") continue;
    const { op: _op, v: _v, ...a } = s;
    return a;
  }
  return undefined;
}

/** Hosts: machines whose `seats` status is live, plus any whose seats channel I can see. */
export function seatHosts(core: Core, sync: SyncManager): SeatHostView[] {
  const r = core.roster;
  const me = core.myHandle();
  const out = new Map<string, SeatHostView>();
  const now = Date.now();
  // Only each machine's `seats` card matters here: the views of the thousands of other agents are not built (GET /v1/seats
  // is polled every 2 s by the Seats view).
  for (const row of core.store.agents()) {
    if (row.agent !== SEATS_AGENT) continue;
    const a = agentRowView(core, sync, row, now);
    if (!a) continue;
    const ch = r.channels.get(seatsChannel(a.node));
    out.set(a.node, {
      node: a.node, hostname: a.hostname, handle: a.handle, self: a.node === core.nodeId,
      allows: a.status.state !== "offline", member: !!(me && ch?.members?.includes(me)), channel: seatsChannel(a.node),
      ...(a.status.activity ? { activity: a.status.activity } : {}), online: a.node === core.nodeId || sync.isOnline(a.node, now),
    });
  }
  for (const ch of r.channels.values()) {
    const node = seatsChannelNode(ch.name);
    if (!node || out.has(node) || !me || !ch.members?.includes(me)) continue;
    const n = r.nodes.get(node);
    const m = n ? r.members.get(n.login) : undefined;
    if (!n || n.revoked || !m) continue;
    out.set(node, {
      node, hostname: n.hostname, handle: m.handle, self: node === core.nodeId, allows: false, member: true, channel: ch.name,
      online: node === core.nodeId || sync.isOnline(node, now),
    });
  }
  for (const [node, h] of out) {
    const a = h.allows || h.self ? hostAvailability(core, node) : undefined;
    if (a) out.set(node, { ...h, availability: a });
  }
  return [...out.values()].sort((a, b) => Number(b.self) - Number(a.self) || a.hostname.localeCompare(b.hostname));
}

/** The seats in every seats channel this member can see, newest first. */
export function seatsList(core: Core, only?: string): SeatView[] {
  const r = core.roster;
  const me = core.myHandle();
  const seats: SeatView[] = [];
  for (const ch of r.channels.values()) {
    if (!ch.name.startsWith(SEATS_PREFIX)) continue;
    const node = seatsChannelNode(ch.name);
    if (!node || !me || !ch.members?.includes(me)) continue;
    const hostNode = r.nodes.get(node);
    const hostMember = hostNode ? r.members.get(hostNode.login) : undefined;
    if (!hostNode || !hostMember) continue;
    const rows = core.store.queryEvents({ channel: ch.name, kinds: ["msg.post", "artifact.share"], limit: PER_CHANNEL });
    const events = rows.map((row) => JSON.parse(row.json) as Event).reverse();
    const byId = new Map<string, SeatView>();
    for (const ev of events) {
      const s = seatOf(ev.body);
      if (s?.op === "run") {
        byId.set(ev.id, runView(ev, s, { node, hostname: hostNode.hostname, handle: hostMember.handle }, r.nodes.get(ev.origin)?.hostname ?? ev.origin));
        continue;
      }
      // Only the host's own daemon speaks for the seat.
      if (ev.origin !== node || ev.author.agent !== SEATS_AGENT || !s) continue;
      const seat = s.op === "state" || s.op === "output" ? byId.get(s.seat) : undefined;
      if (!seat) continue;
      if (s.op === "output") {
        seat.output.push({ id: ev.id, n: s.n, ts: ev.ts, text: String((ev.body as { text?: unknown }).text ?? ""), ...(s.final ? { final: true } : {}) });
        continue;
      }
      if (s.op !== "state" || TERMINAL_STATES.has(seat.state)) continue;
      seat.state = s.state;
      if (s.reason) seat.reason = s.reason;
      else delete seat.reason; // each state carries its own reason (a pause's is over once the seat runs again)
      if (s.until !== undefined) seat.until = s.until;
      else delete seat.until;
      if (s.dir) seat.dir = s.dir;
      if (s.exit_code !== undefined) seat.exit_code = s.exit_code;
      if (s.bundle) seat.result_bundle = s.bundle;
      if (s.commits !== undefined) seat.commits = s.commits;
      if (s.dirty !== undefined) seat.dirty = s.dirty;
      if (s.file) seat.result_file_blob = s.file;
      if (s.file_error) seat.file_error = s.file_error;
      if (s.state === "running" && seat.started_at === undefined) seat.started_at = ev.ts;
      if (TERMINAL_STATES.has(s.state)) seat.ended_at = ev.ts;
    }
    // This machine's own seats: what it knows that the channel can't say yet (a resume held while the channel is
    // narrowed, an end whose post was withheld), for its person (WALK-74).
    const local = node === core.nodeId ? seatsFor(core) : undefined;
    for (const seat of byId.values()) {
      const note = local?.localState(seat.id);
      if (!note || TERMINAL_STATES.has(seat.state)) continue;
      seat.state = note.state;
      seat.reason = note.reason;
      delete seat.until;
      if (note.dir) seat.dir = note.dir;
      if (note.commits !== undefined) seat.commits = note.commits;
    }
    seats.push(...byId.values());
  }
  const filtered = only ? seats.filter((s) => s.id === only) : seats;
  return filtered.sort((a, b) => b.requested_at - a.requested_at).slice(0, MAX_SEATS);
}

function runView(ev: Event, run: AnySeatRun, host: SeatView["host"], hostname: string): SeatView {
  const v2 = run.v === 2 ? {
    v: 2 as const, prompt: "", brief: run.brief, ...(run.label ? { label: run.label } : {}), ...(run.workspace ? { workspace: run.workspace } : {}),
    ...(run.account ? { account: run.account } : {}), ...(run.result_file ? { result_file: run.result_file } : {}),
  } : { prompt: run.prompt, ...(run.bundle ? { bundle: run.bundle } : {}) };
  return {
    id: ev.id, host,
    launcher: { handle: ev.author.handle, hostname, ...(ev.author.agent ? { agent: ev.author.agent } : {}) },
    runtime: run.runtime, ...(run.model ? { model: run.model } : {}), permission_mode: run.permission_mode ?? DEFAULT_SEAT_MODE,
    ...v2, timeout_s: run.timeout_s, max_concurrent: run.max_concurrent,
    requested_at: ev.ts, state: "requested", output: [],
  };
}
