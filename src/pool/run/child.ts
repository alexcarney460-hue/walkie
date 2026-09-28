// Child processes of split runs (llama-server, rpc-server), WALKIE-POOL-2 + POOL-3.
//
// Each runs under a small /bin/sh supervisor whose stdin is a pipe only this daemon writes to. If the daemon dies,
// however it dies (SIGKILL included), the pipe closes and the supervisor's watcher kills the child (TERM, then KILL
// after 5 s): no rpc-server or llama-server outlives the daemon that started it. On top of that, every child is
// recorded (PID + its start time + its executable name) in <home>/pool/children.json while it runs; a daemon that
// starts finds leftovers there and kills only a process whose start time and name still match (a reused PID is never
// touched). Children are stopped ONLY by the PIDs recorded here: SIGTERM to the supervisor (which forwards it),
// then SIGKILL to both after a grace period. stderr/stdout tails are kept in memory for error messages.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname } from "node:path";

const TAIL_BYTES = 8 * 1024;
const PID_LINE = /WALKIE_CHILD_PID=(\d+)/;

/**
 * The supervisor: runs the command in the background, reports its PID, forwards TERM, and kills it on stdin EOF.
 * The watcher is a sibling of the child, not its parent, so by the time it acts the child may have been reaped and
 * its PID reused: it kills only while the PID still shows the child's start time (POOL-4; the name isn't compared
 * here because it changes when the forked shell execs the program).
 */
export const SUPERVISOR = [
  'exec 3<&0 0</dev/null',
  '"$@" & c=$!',
  'id=$(ps -o lstart= -p "$c" 2>/dev/null)',
  'same() { [ -n "$id" ] && [ "$(ps -o lstart= -p "$c" 2>/dev/null)" = "$id" ]; }',
  'echo "WALKIE_CHILD_PID=$c" >&2',
  'trap \'kill -TERM "$c" 2>/dev/null\' TERM INT HUP',
  '( while read -r _ <&3; do :; done; same && kill -TERM "$c" 2>/dev/null; sleep 5; same && kill -KILL "$c" 2>/dev/null ) & w=$!',
  's=1; while kill -0 "$c" 2>/dev/null; do wait "$c"; s=$?; done',
  'kill "$w" 2>/dev/null',
  'exit "$s"',
].join("\n");

export interface Child {
  /** The real process (rpc-server / llama-server), not its supervisor. */
  readonly pid: number;
  /**
   * Records who the child is once it runs its program (after exec its name is the program's): its start time and
   * name are what a later SIGKILL and a restart's reaping check. Call once it is up.
   */
  confirm(): void;
  readonly supervisor: number;
  /** Resolves with the exit code once the supervisor has exited (null = killed by a signal). */
  readonly exited: Promise<number | null>;
  tail(): string;
  stop(graceMs?: number): Promise<void>;
  alive(): boolean;
}

export interface ChildRecord { pid: number; started: string; name: string; role: string }

/** `ps` facts that identify a process across PID reuse: its start time and executable name. */
export function processFacts(pid: number): { started: string; name: string } | null {
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-o", "comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const line = r.stdout.toString().trim();
  if (r.exitCode !== 0 || !line) return null;
  // lstart is a fixed 24-character date ("Sat Sep 26 19:54:36 2026"), then the command name.
  const started = line.slice(0, 24).trim();
  const name = line.slice(24).trim().split("/").pop() ?? "";
  return started && name ? { started, name } : null;
}

/** The record file of this daemon's children (one daemon per home). */
export class ChildRegistry {
  private recs: ChildRecord[] = [];
  /** Children being started (spawnChild before it has their PID): they may already run. */
  private starting = 0;
  constructor(private readonly file: string) {}

  /** A child of this daemon runs, or is being started (seats stay off meanwhile: Opus/Codex seats r10 MEDIUM). */
  busy(): boolean { return this.starting > 0 || this.recs.length > 0; }
  beginSpawn(): void { this.starting++; }
  endSpawn(): void { this.starting = Math.max(0, this.starting - 1); }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.recs), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  add(pid: number, role: string): void {
    const f = processFacts(pid);
    if (!f) return;
    this.recs = [...this.recs.filter((r) => r.pid !== pid), { pid, ...f, role }];
    this.save();
  }

  remove(pid: number): void {
    if (!this.recs.some((r) => r.pid === pid)) return;
    this.recs = this.recs.filter((r) => r.pid !== pid);
    this.save();
  }

  /**
   * At daemon start: kills every recorded child still alive AS RECORDED (same start time and name; a reused PID is
   * left alone), then forgets them all. Returns what it killed.
   */
  reap(): ChildRecord[] {
    let old: ChildRecord[] = [];
    try {
      if (existsSync(this.file)) old = JSON.parse(readFileSync(this.file, "utf8")) as ChildRecord[];
    } catch { old = []; }
    const killed: ChildRecord[] = [];
    for (const r of Array.isArray(old) ? old : []) {
      if (!Number.isInteger(r?.pid) || r.pid <= 1) continue;
      const now = processFacts(r.pid);
      if (!now || now.started !== r.started || now.name !== r.name) continue;
      try { process.kill(r.pid, "SIGKILL"); killed.push(r); } catch { /* gone */ }
    }
    this.recs = [];
    this.save();
    return killed;
  }
}

export interface SpawnOptions { registry?: ChildRegistry; role?: string }

/** Starts `cmd` under the supervisor; resolves once the supervisor reported the real child's PID. */
export async function spawnChild(cmd: string[], env: Record<string, string | undefined>, opts: SpawnOptions = {}): Promise<Child> {
  opts.registry?.beginSpawn();
  try {
    return await startChild(cmd, env, opts);
  } finally {
    opts.registry?.endSpawn(); // recorded by then (add), or it never started
  }
}

async function startChild(cmd: string[], env: Record<string, string | undefined>, opts: SpawnOptions): Promise<Child> {
  const proc = Bun.spawn(["/bin/sh", "-c", SUPERVISOR, "walkie-child", ...cmd], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let tail = "";
  let alive = true;
  let reportPid: (n: number) => void = () => undefined;
  const pidSeen = new Promise<number>((resolve) => { reportPid = resolve; });
  const keep = async (s: ReadableStream<Uint8Array>): Promise<void> => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of s) {
        tail = (tail + dec.decode(chunk, { stream: true })).slice(-TAIL_BYTES);
        const m = PID_LINE.exec(tail);
        if (m) reportPid(Number(m[1]));
      }
    } catch { /* closed */ }
  };
  void keep(proc.stderr as ReadableStream<Uint8Array>);
  void keep(proc.stdout as ReadableStream<Uint8Array>);
  const exited = proc.exited.then((code) => { alive = false; return proc.signalCode ? null : code; });
  const pid = await Promise.race([pidSeen, exited.then(() => 0), Bun.sleep(5_000).then(() => 0)]);
  if (!pid) {
    try { process.kill(proc.pid, "SIGKILL"); } catch { /* gone */ }
    throw new Error(`could not start ${cmd[0]?.split("/").pop()}: ${tail.slice(-300)}`);
  }
  // Who they are now, to be sure a later SIGKILL still hits them and not a process that reused the PID (POOL-4).
  let childFacts = processFacts(pid);
  const supFacts = processFacts(proc.pid);
  const same = (p: number, f: ReturnType<typeof processFacts>): boolean => {
    const now = processFacts(p);
    return !!f && !!now && now.started === f.started && now.name === f.name;
  };
  opts.registry?.add(pid, opts.role ?? "child");
  void exited.then(() => opts.registry?.remove(pid));
  const endPipe = (): void => { try { void (proc.stdin as { end?: () => unknown }).end?.(); } catch { /* closed */ } };
  return {
    pid,
    confirm: () => {
      const f = processFacts(pid);
      if (!f || (childFacts && f.started !== childFacts.started)) return; // gone, or not our process any more
      childFacts = f;
      opts.registry?.add(pid, opts.role ?? "child");
    },
    supervisor: proc.pid,
    exited,
    tail: () => tail.replace(/^WALKIE_CHILD_PID=\d+\n?/m, ""),
    alive: () => alive,
    async stop(graceMs = 5_000) {
      if (!alive) return;
      try { process.kill(proc.pid, "SIGTERM"); } catch { /* gone */ }
      const done = await Promise.race([exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
      if (!done && alive) {
        for (const [p, f] of [[pid, childFacts], [proc.pid, supFacts]] as const) {
          if (same(p, f)) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
        }
        await exited;
      }
      endPipe(); // a watcher left behind by a SIGKILLed supervisor ends now, while the child's PID is still fresh
      opts.registry?.remove(pid);
    },
  };
}

/** A free TCP port on 127.0.0.1 (bound and released; the caller binds it again at once). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

/** Resolves once something accepts TCP connections on 127.0.0.1:port, false after `ms` or when `until` settles. */
export async function waitForPort(port: number, ms: number, until?: Promise<unknown>, cancelled?: () => boolean): Promise<boolean> {
  let over = false;
  void until?.then(() => { over = true; });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !over && !cancelled?.()) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect({ host: "127.0.0.1", port });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => resolve(false));
    });
    if (ok) return true;
    await Bun.sleep(100);
  }
  return false;
}

/** Resident memory of a process in bytes (`ps -o rss=`), or null when unreadable. */
export function residentBytes(pid: number): number | null {
  const r = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const kb = Number(r.stdout.toString().trim());
  return r.exitCode === 0 && Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
}

/**
 * The environment a child gets: a minimal one, never the daemon's (no tokens, no keys, no agent variables).
 * `libDir` joins LD_LIBRARY_PATH on Linux (the CUDA build's runtime libraries sit next to the binaries).
 */
export function minimalEnv(home: string, libDir: string | null): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    TMPDIR: home,
    LANG: "C",
    GGML_RPC_NO_RDMA: "1",
    ...(process.platform === "linux" && libDir ? { LD_LIBRARY_PATH: libDir } : {}),
  };
}
