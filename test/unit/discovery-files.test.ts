import { expect, test } from "bun:test";
import { DiscoveryFiles, discoveryWorkerSpec, LOOKUP_FAILED } from "../../src/daemon/discovery-files.ts";

test("source checkout resolves the discovery worker next to its client", () => {
  expect(discoveryWorkerSpec()).toEndWith("/src/daemon/discovery-files-worker.ts");
});

test("a failing discovery worker backs off and warns once", async () => {
  let now = Date.now();
  const workers: FakeWorker[] = [];
  const warnings: string[] = [];
  const files = new DiscoveryFiles(false, { warn: (message) => { warnings.push(message); }, info: () => {} }, {
    now: () => now, retryBaseMs: 100,
    spawn: () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; },
  });
  try {
    expect(workers).toHaveLength(1);
    const first = files.openFile("/missing", Date.now() + 500);
    workers[0]!.onerror?.({} as ErrorEvent);
    expect(await first).toBe(LOOKUP_FAILED);
    for (let i = 0; i < 5; i++) expect(await files.openFile("/missing", Date.now() + 500)).toBe(LOOKUP_FAILED);
    expect(workers).toHaveLength(1);
    now += 100;
    const second = files.openFile("/missing", Date.now() + 500);
    expect(workers).toHaveLength(2);
    workers[1]!.onerror?.({} as ErrorEvent);
    expect(await second).toBe(LOOKUP_FAILED);
    expect(warnings).toEqual(["agent_discovery_worker_unavailable"]);
  } finally { files.close(); }
});

test("stalled session records share one request until their worker is abandoned", async () => {
  const workers: ReadyStalledWorker[] = [];
  const files = new DiscoveryFiles(false, undefined, {
    retryBaseMs: 20,
    spawn: () => { const worker = new ReadyStalledWorker(); workers.push(worker); return worker as unknown as Worker; },
  });
  try {
    const deadline = Date.now() + 1_500;
    const reads = Array.from({ length: 4 }, () => files.claudeSession(123, "/tmp/test-config", deadline));
    await Promise.resolve();
    expect(workers[0]!.sessionRequests).toBe(1);
    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 20);
    expect(await Promise.all(reads)).toEqual([undefined, undefined, undefined, undefined]);
    expect(timerFired).toBe(true);
    expect(workers[0]!.terminated).toBe(true);
    await Bun.sleep(30);
    const next = files.claudeSession(123, "/tmp/test-config", Date.now() + 1_500);
    await Promise.resolve();
    expect(workers[1]!.sessionRequests).toBe(1);
    expect(await next).toBeUndefined();
  } finally { files.close(); }
});

test("an expired hook-state read is abandoned as null", async () => {
  const files = new DiscoveryFiles(false, undefined, { spawn: () => new FakeWorker() as unknown as Worker });
  try { expect(await files.hookStates("/tmp", ["agent"], Date.now() + 30)).toBeNull(); }
  finally { files.close(); }
});

test("a silent worker times out at startup and expired calls leave no queued IDs", async () => {
  const workers: FakeWorker[] = [];
  const warnings: string[] = [];
  const files = new DiscoveryFiles(false, { warn: (message) => { warnings.push(message); }, info: () => {} }, {
    retryBaseMs: 20, startupTimeoutMs: 500,
    spawn: () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; },
  });
  try {
    const active = files.repoContext("/active", Date.now() + 700);
    const expired = await Promise.all(Array.from({ length: 100 }, (_, i) =>
      files.repoContext(`/queued-${i}`, Date.now() + 15)));
    expect(expired.every((row) => row === null)).toBe(true);
    const queued = files as unknown as { queue: number[]; pending: Map<number, { args: unknown[] }> };
    expect(queued.queue.map((id) => queued.pending.get(id)?.args)).toEqual([["/active"]]);
    await Bun.sleep(650);
    expect(await active).toBeNull();
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(warnings).toContain("agent_discovery_worker_unavailable");
  } finally { files.close(); }
}, 3_000);

test("a worker that never acknowledges policy is replaced without a queued call", async () => {
  const workers: FakeWorker[] = [];
  const warnings: string[] = [];
  const files = new DiscoveryFiles(false, { warn: (message) => { warnings.push(message); }, info: () => {} }, {
    retryBaseMs: 20, startupTimeoutMs: 500,
    spawn: () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; },
  });
  try {
    await Bun.sleep(650);
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(warnings).toContain("agent_discovery_worker_unavailable");
  } finally { files.close(); }
}, 2_000);

test("a slow policy acknowledgement leaves the full timeout for a healthy read", async () => {
  const workers: DelayedReadyWorker[] = [];
  const files = new DiscoveryFiles(false, undefined, {
    spawn: () => { const worker = new DelayedReadyWorker(); workers.push(worker); return worker as unknown as Worker; },
  });
  try {
    const read = files.openFile("/session", Date.now() + 1_500);
    expect(workers[0]!.operationCount).toBe(0);
    expect(await read).toBe("/session");
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
  } finally { files.close(); }
}, 2_000);

test("ready acknowledgements do not reset backoff for workers that crash on each operation", async () => {
  const workers: CrashOnOperationWorker[] = [];
  const files = new DiscoveryFiles(false, undefined, {
    retryBaseMs: 20,
    spawn: () => { const worker = new CrashOnOperationWorker(); workers.push(worker); return worker as unknown as Worker; },
  });
  try {
    expect(await files.repoContext("/crash", Date.now() + 1_000)).toBeNull();
    expect(workers).toHaveLength(2);
    expect((files as unknown as { failures: number }).failures).toBe(2);
  } finally { files.close(); }
}, 2_000);

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private closeListener: (() => void) | null = null;
  addEventListener(event: string, listener: () => void): void { if (event === "close") this.closeListener = listener; }
  sessionRequests = 0;
  terminated = false;
  postMessage(message: { id: number; op: string }): void {
    if (message.op === "claudeSession") {
      this.sessionRequests++;
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, started: true } } as MessageEvent));
    }
  }
  terminate(): void { this.terminated = true; queueMicrotask(() => this.closeListener?.()); }
}

class ReadyStalledWorker extends FakeWorker {
  override postMessage(message: { id: number; op: string }): void {
    if (message.op === "policy") {
      queueMicrotask(() => this.onmessage?.({ data: { id: 0, value: null } } as MessageEvent));
    } else super.postMessage(message);
  }
}

class CrashOnOperationWorker extends FakeWorker {
  override postMessage(message: { id: number; op: string }): void {
    if (message.op === "policy") {
      queueMicrotask(() => this.onmessage?.({ data: { id: 0, value: null } } as MessageEvent));
    } else {
      queueMicrotask(() => this.onerror?.({} as ErrorEvent));
    }
  }
}

class DelayedReadyWorker extends FakeWorker {
  operationCount = 0;
  private ready = false;
  private queued: { id: number; op: string } | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  override postMessage(message: { id: number; op: string }): void {
    if (message.op === "policy") {
      this.timers.push(setTimeout(() => {
        this.ready = true;
        this.onmessage?.({ data: { id: 0, value: null } } as MessageEvent);
        if (this.queued) this.respond(this.queued);
      }, 450));
      return;
    }
    this.operationCount++;
    if (this.ready) this.respond(message);
    else this.queued = message;
  }

  private respond(message: { id: number }): void {
    this.timers.push(setTimeout(() => {
      this.onmessage?.({ data: { id: message.id, value: "/session" } } as MessageEvent);
    }, 120));
  }

  override terminate(): void {
    for (const timer of this.timers) clearTimeout(timer);
    super.terminate();
  }
}
