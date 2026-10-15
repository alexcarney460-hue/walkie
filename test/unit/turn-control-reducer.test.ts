import { expect, test } from "bun:test";
import { initialTurn, reduceTurn, reserveFollowUp, reserveSteer, type TurnIdentity } from "../../src/daemon/seats/turn-control-reducer.ts";
const id: TurnIdentity = { launch: `${"a".repeat(16)}:1`, target: "b".repeat(16), daemon_instance: "c".repeat(32), boot_generation: "d".repeat(32), seat_generation: "e".repeat(32), thread_id: "thread-1" };
test("matching start and quiescent completion advance revisions; waiting reservation is single use", () => {
  const preparing = initialTurn(id);
  const starting = reduceTurn(preparing, { kind: "start_sent", identity: id });
  expect(starting.phase).toBe("starting");
  const active = reduceTurn(starting, { kind: "started", identity: id, turn_id: "turn-1" });
  expect(active.phase).toBe("active");
  expect(reduceTurn(active, { kind: "completed", identity: id, turn_id: "turn-1", quiescent: false }).phase).toBe("active");
  const waiting = reduceTurn(active, { kind: "completed", identity: id, turn_id: "turn-1", quiescent: true });
  expect(waiting.phase).toBe("waiting");
  expect(waiting.revision).toBe(3);
  const reserved = reserveFollowUp(waiting, waiting.revision);
  expect(reserved?.phase).toBe("starting");
  expect(reserveFollowUp(reserved!, waiting.revision)).toBeNull();
  expect(reserveFollowUp(waiting, waiting.revision + 1)).toBeNull();
});
test("full identity and exact turn prevent stale completion and newest-turn retargeting", () => {
  const active = reduceTurn(reduceTurn(initialTurn(id), { kind: "start_sent", identity: id }), { kind: "started", identity: id, turn_id: "turn-1" });
  expect(reduceTurn(active, { kind: "completed", identity: { ...id, boot_generation: "f".repeat(32) }, turn_id: "turn-1", quiescent: true })).toEqual(active);
  expect(reduceTurn(active, { kind: "completed", identity: id, turn_id: "turn-2", quiescent: true })).toEqual(active);
  expect(reserveFollowUp(active, active.revision)).toBeNull();
  const steer = reserveSteer(active, "turn-1");
  expect(steer?.followup_reserved).toBe(true);
  expect(reserveSteer(steer!, "turn-1")).toBeNull();
  expect(reserveSteer(active, "turn-2")).toBeNull();
});
test("interrupt ACK alone is not observation; normal completion race is completed-before-interrupt", () => {
  const active = reduceTurn(reduceTurn(initialTurn(id), { kind: "start_sent", identity: id }), { kind: "started", identity: id, turn_id: "turn-1" });
  const pending = reduceTurn(active, { kind: "interrupt_sent", identity: id, turn_id: "turn-1" });
  expect(pending.phase).toBe("interrupt_pending");
  const ack = reduceTurn(pending, { kind: "interrupt_ack", identity: id, turn_id: "turn-1" });
  expect(ack.phase).toBe("interrupt_pending");
  expect(ack.outcome).toBe("runtime_accepted");
  expect(reduceTurn(ack, { kind: "completed", identity: id, turn_id: "turn-1", quiescent: true }).outcome).toBe("completed_before_interrupt");
  expect(reduceTurn(ack, { kind: "interrupted", identity: id, turn_id: "turn-1", quiescent: true }).outcome).toBe("interrupted_observed");
  expect(reduceTurn(ack, { kind: "interrupted", identity: id, turn_id: "turn-1", quiescent: false }).phase).toBe("interrupt_pending");
});
test("unknown and terminal cannot reopen; unknown asks for bounded owned teardown", () => {
  const active = reduceTurn(reduceTurn(initialTurn(id), { kind: "start_sent", identity: id }), { kind: "started", identity: id, turn_id: "turn-1" });
  const unknown = reduceTurn(active, { kind: "unknown", identity: id });
  expect(unknown.phase).toBe("unknown"); expect(unknown.teardown_required).toBe(true);
  expect(reduceTurn(unknown, { kind: "completed", identity: id, turn_id: "turn-1", quiescent: true })).toEqual(unknown);
  const terminal = reduceTurn(active, { kind: "terminal", identity: id });
  expect(reduceTurn(terminal, { kind: "started", identity: id, turn_id: "turn-2" })).toEqual(terminal);
});
