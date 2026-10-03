// The discovery file worker's recovery paths (WALK-83): a slow first load is not a failure, a worker that ignores terminate()
// does not switch enrichment off for good, a later outage warns again, and openFile tells "no answer" from "no such file".
import { expect, test } from "bun:test";
import { DiscoveryFiles, LOOKUP_FAILED } from "../../src/daemon/discovery-files.ts";

interface Message { id: number; op: string; args?: unknown[] }
interface Script {
  /** Milliseconds before the policy acknowledgement; null: never. */
  policyAckMs: number | null;
  /** Reply to an operation; undefined: never answers. */
  answer?: (message: Message) => { value?: unknown; error?: string } | undefined;
  /** terminate() ignored, like a worker stuck in a native read, until exit() is called. */
  ignoreTerminate?: boolean;
}

class ScriptedWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  exited = false;
  private closeListener: (() => void) | null = null;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  constructor(private readonly script: Script) {}
  addEventListener(event: string, listener: () => void): void { if (event === "close") this.closeListener = listener; }
  postMessage(message: Message): void {
    if (message.op === "policy") {
      if (this.script.policyAckMs === null) return;
      this.timers.push(setTimeout(() => this.onmessage?.({ data: { id: 0, value: null } } as MessageEvent), this.script.policyAckMs));
      return;
    }
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, started: true } } as MessageEvent));
    const reply = this.script.answer?.(message);
    if (reply) queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ...reply } } as MessageEvent));
  }
  terminate(): void {
    this.terminated = true;
    if (!this.script.ignoreTerminate) this.exit();
  }
  /** The thread finally ends (a blocked native read returned). */
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const timer of this.timers) clearTimeout(timer);
    queueMicrotask(() => this.closeListener?.());
  }
}

const healthy: Script = { policyAckMs: 0, answer: (m) => ({ value: m.op === "repoContext" ? { repo: String(m.args?.[0]), cwd: String(m.args?.[0]) } : null }) };
const stuck: Script = { policyAckMs: 0, ignoreTerminate: true }; // acknowledges policy, never answers, survives terminate()

test("a worker slower than one read to acknowledge its policy is not replaced at startup", async () => {
  const spawned: ScriptedWorker[] = [];
  const warnings: string[] = [];
  const files = new DiscoveryFiles(false, { warn: (m) => { warnings.push(m); }, info: () => {} }, {
    spawn: () => { const w = new ScriptedWorker({ ...healthy, policyAckMs: 700 }); spawned.push(w); return w as unknown as Worker; },
  });
  try {
    const read = files.repoContext("/slow-start", Date.now() + 3_000);
    expect((await read)?.repo).toBe("/slow-start");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.terminated).toBe(false);
    expect(warnings).toEqual([]);
  } finally { files.close(); }
}, 6_000);

test("a worker that never acknowledges is still replaced once the startup deadline passes", async () => {
  const spawned: ScriptedWorker[] = [];
  const files = new DiscoveryFiles(false, { warn: () => {}, info: () => {} }, {
    startupTimeoutMs: 80, retryBaseMs: 10,
    spawn: () => { const w = new ScriptedWorker(spawned.length === 0 ? { policyAckMs: null } : healthy); spawned.push(w); return w as unknown as Worker; },
  });
  try {
    await Bun.sleep(250);
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.terminated).toBe(true);
    expect((await files.repoContext("/after", Date.now() + 1_000))?.repo).toBe("/after");
  } finally { files.close(); }
}, 4_000);

test("a worker that ignores terminate() is abandoned and a replacement serves reads again", async () => {
  const spawned: ScriptedWorker[] = [];
  const files = new DiscoveryFiles(false, { warn: () => {}, info: () => {} }, {
    retryBaseMs: 10, retireGraceMs: 60,
    spawn: () => { const w = new ScriptedWorker(spawned.length === 0 ? stuck : healthy); spawned.push(w); return w as unknown as Worker; },
  });
  try {
    expect(await files.repoContext("/blocked", Date.now() + 2_000)).toBeNull(); // times out at 500 ms; the worker is replaced
    expect(spawned[0]!.terminated).toBe(true);
    expect(spawned[0]!.exited).toBe(false);
    await Bun.sleep(400); // past the grace and the backoff
    expect(spawned).toHaveLength(2);
    expect((await files.repoContext("/served", Date.now() + 1_000))?.repo).toBe("/served");
  } finally { files.close(); }
}, 6_000);

test("a hung filesystem leaves at most three stuck threads (two abandoned, one still waited on), and the cap lifts when one exits", async () => {
  const spawned: ScriptedWorker[] = [];
  const files = new DiscoveryFiles(false, { warn: () => {}, info: () => {} }, {
    retryBaseMs: 10, retireGraceMs: 50,
    spawn: () => { const w = new ScriptedWorker(stuck); spawned.push(w); return w as unknown as Worker; },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await files.repoContext(`/blocked-${i}`, Date.now() + 2_000);
      await Bun.sleep(250);
    }
    // The first two stuck workers are abandoned; the third is waited on, not abandoned, so no fourth thread is built.
    for (let i = 0; i < 4; i++) { await files.repoContext("/more", Date.now() + 700); await Bun.sleep(120); }
    expect(spawned).toHaveLength(3);
    spawned[0]!.exit();
    await Bun.sleep(800); // the waited-on worker is abandoned at its next grace check, and a replacement follows the backoff
    expect(spawned).toHaveLength(4);
  } finally { files.close(); }
}, 20_000);

test("a second outage after a recovery warns again", async () => {
  const spawned: ScriptedWorker[] = [];
  const warnings: string[] = [];
  const files = new DiscoveryFiles(false, { warn: (m) => { warnings.push(m); }, info: () => {} }, {
    retryBaseMs: 10,
    spawn: () => {
      const w = new ScriptedWorker(spawned.length === 0 ? { policyAckMs: 0, answer: () => undefined } : healthy);
      spawned.push(w);
      return w as unknown as Worker;
    },
  });
  try {
    const first = files.repoContext("/one", Date.now() + 2_000);
    await Bun.sleep(20);
    spawned[0]!.onerror?.({} as ErrorEvent); // first outage
    await first;
    await Bun.sleep(60);
    expect((await files.repoContext("/two", Date.now() + 1_000))?.repo).toBe("/two"); // recovered
    expect(warnings).toEqual(["agent_discovery_worker_unavailable"]);
    spawned.at(-1)!.onerror?.({} as ErrorEvent); // a later outage
    await Bun.sleep(30);
    expect(warnings).toEqual(["agent_discovery_worker_unavailable", "agent_discovery_worker_unavailable"]);
  } finally { files.close(); }
}, 6_000);

test("openFile says whether the worker answered: a path, no such file, or no answer", async () => {
  const answers = new Map<string, string | null>([["/there", "/there"], ["/gone", null]]);
  const files = new DiscoveryFiles(false, undefined, {
    spawn: () => new ScriptedWorker({ policyAckMs: 0, answer: (m) => (answers.has(String(m.args?.[0])) ? { value: answers.get(String(m.args?.[0])) } : undefined) }) as unknown as Worker,
  });
  try {
    expect(await files.openFile("/there", Date.now() + 1_000)).toBe("/there");
    expect(await files.openFile("/gone", Date.now() + 1_000)).toBeNull();
    expect(await files.openFile("/unanswered", Date.now() + 60)).toBe(LOOKUP_FAILED); // deadline passed with no reply
    expect(await files.openFile("/there", Date.now() - 1)).toBe(LOOKUP_FAILED); // already past its deadline
  } finally { files.close(); }
  expect(await files.openFile("/there", Date.now() + 1_000)).toBe(LOOKUP_FAILED); // closed
}, 4_000);

test("openFile reports no answer while the worker is down, not a missing file", async () => {
  const files = new DiscoveryFiles(false, { warn: () => {}, info: () => {} }, {
    retryBaseMs: 10_000,
    spawn: () => new ScriptedWorker({ policyAckMs: 0, answer: () => undefined }) as unknown as Worker,
  });
  try {
    const first = files.openFile("/x", Date.now() + 2_000);
    expect(await first).toBe(LOOKUP_FAILED); // the 500 ms operation timer fires; the worker is replaced
    expect(await files.openFile("/x", Date.now() + 2_000)).toBe(LOOKUP_FAILED); // retry backoff: no worker at all
  } finally { files.close(); }
}, 6_000);
