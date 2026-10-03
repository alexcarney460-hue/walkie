import { expect, spyOn, test } from "bun:test";
import { ClaudeChild } from "../../src/daemon/orchestrator/process.ts";
import type { ClaudeSignal } from "../../src/daemon/orchestrator/claude-stream.ts";
import { OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";

/** Model stdout can still be queued when Bun resolves the process-exit promise. No real process is launched. */
function controlledChild(onSignal: (signal: ClaudeSignal) => void, onExit: () => void) {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
  const proc = {
    pid: 2_147_483_647, exitCode: 3, exited: Promise.resolve(3), stdout,
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    stdin: { write() {}, flush() {}, end() {} },
  };
  const launch = spyOn(Bun, "spawn").mockReturnValue(proc as unknown as ReturnType<typeof Bun.spawn>);
  // The fake process owns no OS process group. Exercise only stream/exit delivery here.
  const reap = spyOn(ClaudeChild.prototype as unknown as { reap(): Promise<void> }, "reap").mockResolvedValue();
  const child = new ClaudeChild("fake-claude", [], "/tmp", {}, { onSignal, onExit });
  launch.mockRestore();
  return {
    child,
    send(value: object) { output.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`)); },
    end() { output.close(); },
    async close() { try { await child.reaped; } finally { reap.mockRestore(); } },
  };
}

const init = { type: "system", subtype: "init", session_id: "known-session", model: "fake-model" };
const result = { type: "result", subtype: "success", session_id: "known-session", is_error: false, result: "answered" };
async function flushMicrotasks() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

test("queued init and result are delivered before exit invalidates the current child", async () => {
  const events: string[] = [];
  let current = true;
  const c = controlledChild((signal) => { if (current) events.push(signal.kind); }, () => { current = false; events.push("exit"); });
  try {
    await flushMicrotasks(); // process exit and stderr EOF arrived; stdout has not been delivered yet
    c.send(init);
    c.send(result);
    c.end();
    await c.child.exited;
    expect(events).toEqual(["init", "result", "exit"]);
  } finally { await c.close(); }
});

test("a resumed child that emitted init before crashing does not replay the crashing turn", async () => {
  const host: any = Object.create(OrchestratorHost.prototype);
  Object.assign(host, {
    state: { active: true, sessions: { thread: "known-session" } },
    childSession: "known-session", childResumed: true, childInit: false, childArgs: [],
    childStartedAt: Date.now(), stopping: false, attempt: 0, queue: [],
    turn: { id: "message", thread: "thread", texts: [], tools: [], item: { id: "message" } },
    log: { warn() {} }, save() {}, clearInterruptTimer() {}, endLive() {}, postReply() {},
    setState() {}, scheduleRestart() {},
  });
  const c = controlledChild((signal) => { if (host.child === c.child) host.onSignal(signal); },
    () => { if (host.child === c.child) host.onExit(3, ""); });
  host.child = c.child;
  try {
    await flushMicrotasks();
    c.send(init);
    c.end();
    await c.child.exited;
    expect(host.queue).toEqual([]);
    expect(host.state.sessions).toEqual({ thread: "known-session" });
    expect(host.turn).toBeNull();
  } finally { await c.close(); }
});

test("a descendant holding stdout open cannot postpone the exit callback indefinitely", async () => {
  const events: string[] = [];
  const c = controlledChild((signal) => events.push(signal.kind), () => events.push("exit"));
  try {
    const ended = await Promise.race([c.child.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
    expect(ended).toBe(true);
    expect(events).toEqual(["exit"]);
    c.send(init); // late data is no longer a signal from a running child
    c.end();
    await flushMicrotasks();
    expect(events).toEqual(["exit"]);
  } finally { await c.close(); }
});
