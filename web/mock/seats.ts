// Mock remote seats (PROTOCOL §11) for the dashboard: this machine's opt-in, the team's hosts, and a seat that walks
// through requested -> running -> done with a few output posts. Seats and compute sharing refuse each other, like the
// daemon (Opus seats r9 HIGH). WALKIE_MOCK_SEATS=on starts with seats allowed here.
import { SEATS_POOL_CONFLICT, type SeatHostView, type SeatMode, type SeatRuntime, type SeatsLocalView, type SeatsView, type SeatView } from "../../src/protocol/seats.ts";
import type { NodeView } from "../../src/protocol/schemas.ts";

interface RunReq { machine: string; runtime: SeatRuntime; model?: string; permission_mode?: SeatMode; prompt: string; timeout_s?: number }

export class MockSeats {
  allow = process.env.WALKIE_MOCK_SEATS === "on";
  private busy: { max: number; until?: number } | null = null;
  private seats: SeatView[] = [];
  private seq = 100;

  constructor(private readonly nodes: () => NodeView[], private readonly me: () => string, private readonly poolOn: () => boolean) {}

  local(): SeatsLocalView {
    const running = this.seats.filter((s) => s.host.node === this.self()?.node_id && (s.state === "running" || s.state === "requested")).length;
    const conflict = this.poolOn() ? `${SEATS_POOL_CONFLICT}. Compute sharing is on here: turn it off first (walkie pool share off)` : null;
    return {
      allow: this.allow, ...(conflict ? { pool_conflict: conflict } : {}), launchers: [], runtimes: ["claude", "codex"], max: 3,
      dir: "~/.walkie/seats", channel: this.self() ? `seats-${this.self()!.node_id}` : null, channel_ok: true,
      ephemeral: true, same_user: false, readable_home: false, claude_login: "dedicated", codex_login: "machine",
      ...(this.allow && conflict ? { disabled_reason: conflict } : {}),
      running, paused: 0, queued: 0,
      availability: this.busy ? { state: "busy", max: this.busy.max, ...(this.busy.until ? { until: this.busy.until } : {}) } : { state: "available" },
    };
  }

  view(): SeatsView {
    const hosts: SeatHostView[] = this.nodes().map((n, i) => ({
      node: n.node_id, hostname: n.hostname, handle: n.handle, self: !!n.self,
      allows: n.self ? this.allow : i % 2 === 1, member: true, channel: `seats-${n.node_id}`, online: n.online,
      ...(n.self ? { availability: this.local().availability } : {}),
    }));
    return { local: this.local(), hosts, seats: [...this.seats].reverse() };
  }

  /** `allow` on or off; null when refused (the pool is on), with the message. */
  configure(allow: boolean): string | null {
    if (allow && this.poolOn()) return this.local().pool_conflict ?? SEATS_POOL_CONFLICT;
    this.allow = allow;
    if (!allow) this.seats = this.seats.map((s) => (s.host.node === this.self()?.node_id && !isEnded(s) ? { ...s, state: "stopped", reason: "seats turned off here", ended_at: Date.now() } : s));
    return null;
  }

  run(b: RunReq): SeatView | string {
    const host = this.nodes().find((n) => n.node_id === b.machine || n.hostname === b.machine);
    if (!host) return `no machine ${b.machine} in the team`;
    const self = this.self();
    const seat: SeatView = {
      id: `${self?.node_id ?? "0000000000000000"}:${++this.seq}`,
      host: { node: host.node_id, hostname: host.hostname, handle: host.handle },
      launcher: { handle: this.me(), hostname: self?.hostname ?? "this-mac" },
      runtime: b.runtime, ...(b.model ? { model: b.model } : {}), permission_mode: b.permission_mode ?? "acceptEdits",
      prompt: b.prompt, timeout_s: b.timeout_s ?? 3_600, max_concurrent: 9, requested_at: Date.now(), state: "requested", output: [],
    };
    this.seats = [...this.seats, seat];
    this.advance(seat.id);
    return seat;
  }

  stop(id: string): boolean {
    const s = this.seats.find((x) => x.id === id);
    if (!s || isEnded(s)) return false;
    this.update(id, { state: "stopped", reason: `stopped by @${this.me()}`, ended_at: Date.now() });
    return true;
  }

  setBusy(max: number, forS?: number): void { this.busy = { max, ...(forS ? { until: Date.now() + forS * 1000 } : {}) }; }
  resume(): void { this.busy = null; }

  private self(): NodeView | undefined { return this.nodes().find((n) => n.self); }

  private update(id: string, patch: Partial<SeatView>): void {
    this.seats = this.seats.map((s) => (s.id === id ? { ...s, ...patch } : s));
  }

  private advance(id: string): void {
    const lines = ["Reading the repository layout…", "Running the tests: 214 pass, 2 fail (auth/session.test.ts).", "Fixed the expired-session check; all 216 pass."];
    let n = 0;
    const t = setInterval(() => {
      const s = this.seats.find((x) => x.id === id);
      if (!s || isEnded(s)) { clearInterval(t); return; }
      if (s.state === "requested") { this.update(id, { state: "running", started_at: Date.now(), dir: "~walkie-s12/walkie-seats/20260926-1542" }); return; }
      const line = lines[n];
      if (line === undefined) { this.update(id, { state: "done", exit_code: 0, ended_at: Date.now(), commits: 1 }); clearInterval(t); return; }
      n++;
      this.update(id, { output: [...s.output, { id: `${s.id}-o${n}`, n, ts: Date.now(), text: line, ...(n === lines.length ? { final: true } : {}) }] });
    }, 1_200);
  }
}

function isEnded(s: SeatView): boolean { return ["done", "failed", "stopped", "timeout", "refused"].includes(s.state); }
