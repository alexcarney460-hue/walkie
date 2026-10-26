// Disk barrier for this node's own events (DAEMON-STALL).
//
// SQLite's synchronous=FULL fsyncs the WAL inside the commit, on whatever thread called it. This daemon
// has one thread. On macOS that fsync is F_FULLFSYNC unless fullfsync is off, and under memory pressure
// (the machine is paging) it blocks for seconds. While it runs, the unix socket is not read, so hooks time
// out with "daemon not reachable" and a restart changes nothing: the next signed event fsyncs again.
//
// Commits stay synchronous=NORMAL (the write returns when the frame is in the WAL; a process crash does
// not lose it). Peers are told only after an fsync of that WAL file, and that fsync runs on the libuv
// threadpool, not on the event loop. A power cut in the gap loses the event locally and nowhere else,
// so the sequence number is not reused for different content peers already hold.
import { open } from "node:fs/promises";

/** Fsync the WAL file. A missing WAL (nothing committed yet, or a memory database) is not an error. */
export async function fsyncWal(dbPath: string): Promise<void> {
  if (!dbPath || dbPath === ":memory:") return;
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(`${dbPath}-wal`, "r");
    await fh.sync();
  } catch {
    // No WAL yet.
  } finally {
    await fh?.close();
  }
}

/**
 * Coalesces durability barriers. `note()` covers every commit so far; `whenDurable(gen)` resolves once
 * a barrier that started after that note has finished. Barriers run one at a time, off the caller.
 */
export class WalSync {
  private pending = 0;
  private synced = 0;
  private pumping = false;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly waiters = new Map<number, Array<() => void>>();

  constructor(private readonly dbPath: string, private barrier: () => Promise<void> = () => fsyncWal(dbPath)) {}

  /** Tests: replace the disk barrier (a stuck disk must not be required to prove the loop stays free). */
  setBarrier(fn: () => Promise<void>): void { this.barrier = fn; }

  /** A commit has returned. The generation is covered by the next barrier. */
  note(): number {
    if (this.closed) return this.synced;
    const gen = ++this.pending;
    this.kick();
    return gen;
  }

  /** Resolves once generation `gen` (default: everything noted so far) is covered. */
  whenDurable(gen = this.pending): Promise<void> {
    if (gen <= this.synced) return Promise.resolve();
    return new Promise((resolve) => {
      if (gen <= this.synced) { resolve(); return; }
      const list = this.waiters.get(gen);
      if (list) list.push(resolve);
      else this.waiters.set(gen, [resolve]);
    });
  }

  /** Shutdown: don't start another barrier. Waiters are released so a closing daemon doesn't hang them. */
  close(): void {
    this.closed = true;
    this.synced = Math.max(this.synced, this.pending);
    this.wake();
  }

  private kick(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    this.tail = this.tail.then(() => this.pump());
  }

  private async pump(): Promise<void> {
    try {
      while (!this.closed && this.synced < this.pending) {
        const target = this.pending;
        try { await this.barrier(); }
        catch { /* the frame is already in the WAL; a barrier error must not wedge replication */ }
        if (this.closed) return;
        this.synced = Math.max(this.synced, target);
        this.wake();
      }
    } finally {
      this.pumping = false;
      if (!this.closed && this.synced < this.pending) this.kick();
    }
  }

  private wake(): void {
    for (const [gen, list] of [...this.waiters]) {
      if (gen > this.synced) continue;
      this.waiters.delete(gen);
      for (const resolve of list) resolve();
    }
  }
}
