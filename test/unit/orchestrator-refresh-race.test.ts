import { expect, test } from "bun:test";
import { OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";

function refreshingHost() {
  const host: any = Object.create(OrchestratorHost.prototype);
  const replies: string[] = [];
  const switches: string[] = [];
  const item = { id: "turn-1", thread: "turn-1", text: "run a tool", ts: Date.now(), origin: {} };
  host.turn = { id: item.id, thread: item.thread, item, texts: ["tool completed"], tools: ["Bash"], toolCount: 1,
    size: 14, interrupted: false, refreshing: true };
  host.queue = [];
  host.child = {};
  host.log = { warn: () => undefined };
  host.clearInterruptTimer = () => undefined;
  host.endLive = () => undefined;
  host.setState = () => undefined;
  host.postReply = (_thread: string, text: string) => { replies.push(text); };
  host.status = () => undefined;
  host.pump = () => undefined;
  host.serial = (fn: () => Promise<void>) => fn();
  host.switchModel = async (note: string) => { switches.push(note); };
  return { host, replies, switches };
}

test("successful result racing refresh is posted once without repeating its tool", () => {
  const { host, replies, switches } = refreshingHost();
  host.finishTurn({ kind: "result", ok: true, subtype: "success", text: "tool completed" });
  expect(replies).toEqual(["tool completed"]);
  expect(host.queue).toEqual([]);
  expect(switches).toEqual(["_Claude login refreshed._"]);
});

test("only an acknowledged interrupted result is resumed", () => {
  const accepted = refreshingHost();
  accepted.host.onSignal({ kind: "control", requestId: "refresh-turn-1", ok: true });
  accepted.host.finishTurn({ kind: "result", ok: false, subtype: "error_during_execution", text: "" });
  expect(accepted.host.queue).toHaveLength(1);
  expect(accepted.replies).toEqual([]);

  const unconfirmed = refreshingHost();
  unconfirmed.host.finishTurn({ kind: "result", ok: false, subtype: "error_during_execution", text: "" });
  expect(unconfirmed.host.queue).toEqual([]);
  expect(unconfirmed.replies).toHaveLength(1);
});

test("child exit without an interrupted result does not replay the turn", () => {
  const { host, replies } = refreshingHost();
  host.childStartedAt = Date.now();
  host.childSession = "session-1";
  host.childResumed = false;
  host.stopping = false;
  host.scheduleRestart = () => undefined;
  host.onExit(1, "");
  expect(host.queue).toEqual([]);
  expect(replies).toHaveLength(1);
  expect(replies[0]).toContain("exited while replying");
});
