// Only one process reads Hugging Face at a time, and a manual refresh waits its minute from the END of the last read.
// `walkie pool` builds its own ModelSource and the daemon has one: both share <home>/pool, so a refresh takes a lock
// there. A fake Hub answers (a gate holds the first read open); nothing touches the network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_STALE_MS, takeLock, takeoverPath, TAKEOVER_STALE_MS } from "../../src/pool/hf/refresh-lock.ts";
import { cachePath, lockPath, ModelSource, REFRESH_GAP_MS } from "../../src/pool/hf/source.ts";
import { fakeHub } from "../helpers/hf-fixtures.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "walkie-hf-lock-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const T0 = Date.parse("2026-10-01T22:00:00Z");
const clock = (t = T0) => ({ t, now() { return this.t; } });

/** A fetch that answers from the fake Hub but holds its first request until `release()` is called. */
function gated() {
  const hub = fakeHub();
  let release!: () => void;
  const open = new Promise<void>((r) => { release = r; });
  let first = true;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (first) { first = false; await open; }
    return hub.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { hub, fetch, release };
}

describe("one refresh at a time across processes", () => {
  test("a second source on the same home makes no request while the first is reading, and says why", async () => {
    const g = gated();
    const a = new ModelSource({ home, fetch: g.fetch, now: () => T0 });
    const second = fakeHub();
    const b = new ModelSource({ home, fetch: second.fetch, now: () => T0 });
    const running = a.load();
    await Promise.resolve();
    expect(existsSync(lockPath(home))).toBe(true);
    const v = await b.load();
    expect(second.calls.length).toBe(0);
    expect(v.source).toBe("built-in");
    expect(v.note).toContain("Another Walkie process is reading Hugging Face");
    g.release();
    const done = await running;
    expect(done.source).toBe("huggingface");
    expect(existsSync(lockPath(home))).toBe(false); // released
    // Afterwards the list is on disk and fresh: a third source reads it without a request.
    const third = fakeHub();
    const c = new ModelSource({ home, fetch: third.fetch, now: () => T0 });
    expect((await c.load()).state).toBe("fresh");
    expect(third.calls.length).toBe(0);
  });

  test("a source that takes the lock and finds the list fresh by then does not read it again", async () => {
    // A cache file as another process would have written it a moment earlier.
    const other = mkdtempSync(join(tmpdir(), "walkie-hf-lock-other-"));
    try {
      await new ModelSource({ home: other, fetch: fakeHub().fetch, now: () => T0 }).load();
      const written = readFileSync(cachePath(other), "utf8");
      const hub = fakeHub();
      let looks = 0;
      // The 1st look at the clock is the decision that a read is due; the 2nd is after the lock is taken. The other
      // process finishes in between.
      const now = () => {
        looks++;
        if (looks === 2) { mkdirSync(join(home, "pool"), { recursive: true }); writeFileSync(cachePath(home), written); }
        return T0;
      };
      const v = await new ModelSource({ home, fetch: hub.fetch, now }).load();
      expect(hub.calls.length).toBe(0);
      expect(v.source).toBe("huggingface");
      expect(v.state).toBe("fresh");
      expect(existsSync(lockPath(home))).toBe(false);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  test("the lock is released when the read fails", async () => {
    const hub = fakeHub();
    hub.inject("huggingface.co", () => { throw new TypeError("Unable to connect"); }, 10_000);
    const s = new ModelSource({ home, fetch: hub.fetch, now: () => T0 });
    const v = await s.load();
    expect(v.source).toBe("built-in");
    expect(existsSync(lockPath(home))).toBe(false);
  });

  test("a lock left by a process that is gone is taken over", async () => {
    mkdirSync(join(home, "pool"), { recursive: true });
    writeFileSync(lockPath(home), JSON.stringify({ pid: 2 ** 22 + 12345 })); // no such process
    const hub = fakeHub();
    const v = await new ModelSource({ home, fetch: hub.fetch, now: () => T0 }).load();
    expect(v.source).toBe("huggingface");
    expect(hub.calls.length).toBeGreaterThan(0);
  });

  test("a lock older than a refresh can last is taken over even if its pid looks alive", async () => {
    mkdirSync(join(home, "pool"), { recursive: true });
    writeFileSync(lockPath(home), JSON.stringify({ pid: process.pid }));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockPath(home), old, old);
    const hub = fakeHub();
    expect((await new ModelSource({ home, fetch: hub.fetch, now: () => T0 }).load()).source).toBe("huggingface");
  });

  test("a live holder is respected (a fresh lock whose process is alive)", async () => {
    mkdirSync(join(home, "pool"), { recursive: true });
    writeFileSync(lockPath(home), JSON.stringify({ pid: process.pid }));
    const hub = fakeHub();
    const v = await new ModelSource({ home, fetch: hub.fetch, now: () => T0 }).load();
    expect(hub.calls.length).toBe(0);
    expect(v.note).toContain("Another Walkie process");
  });

  test("a home that cannot be written still reads the list (no lock is possible)", async () => {
    writeFileSync(join(home, "pool"), "not a folder"); // pool/ is a file: no lock, no cache
    const hub = fakeHub();
    const v = await new ModelSource({ home, fetch: hub.fetch, now: () => T0 }).load();
    expect(v.source).toBe("huggingface");
  });
});

describe("a manual refresh waits its minute from the end of the last read", () => {
  test("a read that took 90 s leaves the list fresh at its end, so an immediate manual refresh waits", async () => {
    const hub = fakeHub();
    const c = clock();
    const slow = (async (input: string | URL | Request, init?: RequestInit) => { c.t += 600; return hub.fetch(input, init); }) as typeof globalThis.fetch;
    const s = new ModelSource({ home, fetch: slow, now: () => c.now() });
    const v = await s.load();
    expect(v.source).toBe("huggingface");
    expect(c.t - T0).toBeGreaterThan(60_000); // the read itself took over a minute of the (fake) clock
    expect(v.checkedAt).toBe(c.t); // stamped at the end
    const calls = hub.calls.length;
    await s.load({ refresh: true });
    expect(hub.calls.length).toBe(calls); // inside the gap: no new read
    c.t += REFRESH_GAP_MS + 1;
    await s.load({ refresh: true });
    expect(hub.calls.length).toBeGreaterThan(calls); // after it: reads again
  });
});

// ---- the lock itself (review LOW-C) ------------------------------------------------------------------------------------

const DEAD = 2 ** 22 + 54321; // no such process
const ago = (ms: number): Date => new Date(Date.now() - ms);
const lockFile = (content: string, mtime?: Date): void => {
  mkdirSync(join(home, "pool"), { recursive: true });
  writeFileSync(lockPath(home), content);
  if (mtime) utimesSync(lockPath(home), mtime, mtime);
};
const tokenIn = (path: string): string => (JSON.parse(readFileSync(path, "utf8")) as { token: string }).token;
const leftovers = (): string[] => (existsSync(join(home, "pool")) ? readdirSync(join(home, "pool")) : []);

describe("the lock is made whole, taken over once, and released only by its owner", () => {
  test("a lock holds its owner's pid and token, and leaves no temp file behind", () => {
    const r = takeLock(home);
    expect(typeof r).toBe("function");
    const held = JSON.parse(readFileSync(lockPath(home), "utf8")) as { pid: number; token: string };
    expect(held.pid).toBe(process.pid);
    expect(held.token.length).toBeGreaterThan(8);
    expect(leftovers().filter((f) => f.endsWith(".tmp"))).toEqual([]);
    (r as () => void)();
    expect(existsSync(lockPath(home))).toBe(false);
  });

  test("release removes the lock only while it still holds the owner's token", () => {
    const a = takeLock(home) as () => void;
    const mine = tokenIn(lockPath(home));
    // Another process took the lock over (it judged ours stale): its file is at the path now.
    writeFileSync(lockPath(home), JSON.stringify({ pid: process.pid, token: "someone-else" }));
    a();
    expect(existsSync(lockPath(home))).toBe(true);
    expect(tokenIn(lockPath(home))).toBe("someone-else");
    expect(mine).not.toBe("someone-else");
  });

  test("two processes that both judged a lock stale: the second does not delete the first's fresh lock", () => {
    lockFile(JSON.stringify({ pid: DEAD, token: "crashed" }));
    let first: (() => void) | "busy" | undefined;
    let freshToken = "";
    // The second process judged the stale lock, then the first completed its whole takeover; the second goes on.
    const second = takeLock(home, { afterJudgedStale: () => {
      first = takeLock(home);
      freshToken = tokenIn(lockPath(home));
    } });
    expect(typeof first).toBe("function"); // the first took it over
    expect(second).toBe("busy"); // the second looked again under the takeover file, found a fresh lock, and left it
    expect(existsSync(lockPath(home))).toBe(true);
    expect(tokenIn(lockPath(home))).toBe(freshToken); // the first's lock is still the first's
    (first as () => void)();
    expect(existsSync(lockPath(home))).toBe(false);
    expect(existsSync(takeoverPath(home))).toBe(false);
  });

  test("a takeover already in progress makes the second process wait, and leaves the stale lock alone", () => {
    lockFile(JSON.stringify({ pid: DEAD, token: "crashed" }));
    writeFileSync(takeoverPath(home), JSON.stringify({ pid: process.pid, token: "other" }));
    expect(takeLock(home)).toBe("busy");
    expect(tokenIn(lockPath(home))).toBe("crashed");
    rmSync(takeoverPath(home));
    expect(typeof takeLock(home)).toBe("function");
  });

  test("a takeover file left by a crash is cleared after its short window", () => {
    lockFile(JSON.stringify({ pid: DEAD, token: "crashed" }));
    writeFileSync(takeoverPath(home), JSON.stringify({ pid: DEAD, token: "crashed-takeover" }));
    expect(typeof takeLock(home)).toBe("function"); // a dead owner: stale at once
    rmSync(lockPath(home), { force: true });
    lockFile(JSON.stringify({ pid: DEAD, token: "crashed" }));
    writeFileSync(takeoverPath(home), JSON.stringify({ pid: process.pid }));
    const old = ago(TAKEOVER_STALE_MS + 5_000);
    utimesSync(takeoverPath(home), old, old);
    expect(typeof takeLock(home)).toBe("function"); // alive pid but older than a takeover can take
  });
});

describe("odd lock files", () => {
  test("an empty lock with a future date is busy, its window restarts from now, and it is stale after the usual time", () => {
    const future = new Date(Date.now() + 3600_000);
    lockFile("", future);
    expect(takeLock(home)).toBe("busy");
    expect(statSync(lockPath(home)).mtimeMs).toBeLessThan(Date.now() + 5_000); // no longer in the future
    const old = ago(LOCK_STALE_MS + 5_000);
    utimesSync(lockPath(home), old, old); // time passes
    expect(typeof takeLock(home)).toBe("function");
  });

  test("an empty lock is stale after the normal window, not before", () => {
    lockFile("", ago(60_000));
    expect(takeLock(home)).toBe("busy");
    const old = ago(LOCK_STALE_MS + 5_000);
    utimesSync(lockPath(home), old, old);
    expect(typeof takeLock(home)).toBe("function");
  });

  test("a future-dated lock whose owner is gone is stale at once", () => {
    lockFile(JSON.stringify({ pid: DEAD, token: "crashed" }), new Date(Date.now() + 3600_000));
    expect(typeof takeLock(home)).toBe("function");
  });

  test("a folder at the lock path: reported, and the read goes ahead without a lock", async () => {
    mkdirSync(lockPath(home), { recursive: true });
    const reasons: string[] = [];
    const r = takeLock(home, { report: (x) => reasons.push(x) });
    expect(typeof r).toBe("function"); // not "busy"
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("not a plain file");
    (r as () => void)(); // a no-op: the folder stays
    expect(statSync(lockPath(home)).isDirectory()).toBe(true);
    // And through a ModelSource: the list is read, and the event says why there was no lock.
    const hub = fakeHub();
    const events: string[] = [];
    const v = await new ModelSource({ home, fetch: hub.fetch, now: () => T0, log: (e) => events.push(e) }).load();
    expect(v.source).toBe("huggingface");
    expect(events).toContain("pool_models_lock_unusable");
  });

  test("a link at the lock path is not followed and is not a lock either", () => {
    mkdirSync(join(home, "pool"), { recursive: true });
    writeFileSync(join(home, "elsewhere"), JSON.stringify({ pid: process.pid }));
    symlinkSync(join(home, "elsewhere"), lockPath(home));
    const reasons: string[] = [];
    expect(typeof takeLock(home, { report: (x) => reasons.push(x) })).toBe("function");
    expect(reasons).toHaveLength(1);
    expect(readFileSync(join(home, "elsewhere"), "utf8")).toContain(String(process.pid)); // the target is untouched
  });
});
