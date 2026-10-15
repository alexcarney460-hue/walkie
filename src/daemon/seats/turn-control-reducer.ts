// Pure source-only turn reducer. No adapter is constructed by this module.
import type { SeatControlOutcome } from "../../protocol/seat-turn-control.ts";
export interface TurnIdentity {
  launch: string; target: string; daemon_instance: string; boot_generation: string; seat_generation: string; thread_id: string;
}
export type TurnPhase = "preparing" | "starting" | "active" | "waiting" | "interrupt_pending" | "stopping" | "terminal" | "unknown";
export interface TurnState {
  identity: TurnIdentity; phase: TurnPhase; revision: number; turn_id?: string; outcome?: SeatControlOutcome; teardown_required: boolean; followup_reserved: boolean;
}
type Base = { identity: TurnIdentity };
export type TurnEvent = Base & (
  | { kind: "start_sent" } | { kind: "started"; turn_id: string }
  | { kind: "completed" | "interrupted"; turn_id: string; quiescent: boolean }
  | { kind: "interrupt_sent" | "interrupt_ack"; turn_id: string }
  | { kind: "stop" | "terminal" | "unknown" }
);
export function initialTurn(identity: TurnIdentity): TurnState { return { identity: { ...identity }, phase: "preparing", revision: 0, teardown_required: false, followup_reserved: false }; }
function same(a: TurnIdentity, b: TurnIdentity): boolean {
  return a.launch === b.launch && a.target === b.target && a.daemon_instance === b.daemon_instance
    && a.boot_generation === b.boot_generation && a.seat_generation === b.seat_generation && a.thread_id === b.thread_id;
}
export function reduceTurn(state: TurnState, event: TurnEvent): TurnState {
  if (!same(state.identity, event.identity) || state.phase === "terminal" || state.phase === "unknown") return state;
  const move = (patch: Partial<TurnState>): TurnState => ({ ...state, ...patch, revision: state.revision + 1 });
  switch (event.kind) {
    case "start_sent": return state.phase === "preparing" ? move({ phase: "starting" }) : state;
    case "started": return state.phase === "starting" ? move({ phase: "active", turn_id: event.turn_id, outcome: undefined, followup_reserved: false }) : state;
    case "interrupt_sent": return state.phase === "active" && state.turn_id === event.turn_id ? move({ phase: "interrupt_pending", outcome: "requested" }) : state;
    case "interrupt_ack": return state.phase === "interrupt_pending" && state.turn_id === event.turn_id && state.outcome === "requested"
      ? move({ outcome: "runtime_accepted" }) : state;
    case "completed":
      if (!event.quiescent || state.turn_id !== event.turn_id) return state;
      if (state.phase === "active") return move({ phase: "waiting", turn_id: undefined, followup_reserved: false });
      if (state.phase === "interrupt_pending") return move({ phase: "waiting", turn_id: undefined, outcome: "completed_before_interrupt", followup_reserved: false });
      return state;
    case "interrupted": return event.quiescent && state.phase === "interrupt_pending" && state.turn_id === event.turn_id
      ? move({ phase: "waiting", turn_id: undefined, outcome: "interrupted_observed", followup_reserved: false }) : state;
    case "stop": return state.phase === "stopping" ? state : move({ phase: "stopping" });
    case "terminal": return move({ phase: "terminal", turn_id: undefined });
    case "unknown": return move({ phase: "unknown", teardown_required: true });
  }
}
/** Synchronous CAS: caller must keep the returned state before any await. */
export function reserveFollowUp(state: TurnState, expectedRevision: number): TurnState | null {
  return state.phase === "waiting" && !state.followup_reserved && state.revision === expectedRevision
    ? { ...state, phase: "starting", revision: state.revision + 1, outcome: "requested", followup_reserved: true } : null;
}
/** An active follow-up is bound to this exact turn and never becomes a start. */
export function reserveSteer(state: TurnState, expectedTurnId: string): TurnState | null {
  return state.phase === "active" && !state.followup_reserved && state.turn_id === expectedTurnId
    ? { ...state, revision: state.revision + 1, outcome: "requested", followup_reserved: true } : null;
}
