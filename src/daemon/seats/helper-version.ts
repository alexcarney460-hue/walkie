// Is the root-owned seat runner/helper (walkie seats setup-user --apply: copies of the walkie binary in
// /usr/local/libexec/walkie) from this Walkie? `walkie update` replaces the person's walkie, never those copies, so
// after an update a fix in the helper (e.g. pre.5's macOS seat users) isn't there until setup-user runs again.
// Read-only: each copy is installed 0755, so the person can run `<copy> version` without sudo. It is run only once its
// path is root's and nobody else's to write (runnerPathProblem), with an empty environment, from /, with a timeout.
import { statSync } from "node:fs";
import { runnerPathProblem } from "./seat-user.ts";

/** One installed copy: the version it reports, or why it couldn't be told. */
export interface HelperCopy { path: string; version: string | null; why?: string }

/**
 * `current`: every copy reports this walkie's version; `stale`: one reports another; `unknown`: one couldn't be read
 * (never counted as current).
 */
export interface HelperVersion { state: "current" | "stale" | "unknown"; want: string; copies: HelperCopy[] }

/** Runs `path version` and returns its stdout, or null (not started, non-zero exit, timed out). */
export type RunVersion = (path: string) => string | null;

export const VERSION_TIMEOUT_MS = 5_000;
export const UNKNOWN_RETRY_MS = 60_000;

export const realRunVersion: RunVersion = (path) => {
  try {
    const r = Bun.spawnSync([path, "version"], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore", cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeout: VERSION_TIMEOUT_MS,
    });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch {
    return null;
  }
};

/** The same, without blocking (the daemon: its event loop never waits on a copy; killed at the timeout). */
export type RunVersionAsync = (path: string) => Promise<string | null>;

export const realRunVersionAsync: RunVersionAsync = async (path) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([path, "version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", cwd: "/", env: { PATH: "/usr/bin:/bin" } });
  } catch {
    return null;
  }
  const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, VERSION_TIMEOUT_MS);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
    return code === 0 ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** `walkie 0.2.0-pre.4` → `0.2.0-pre.4`; anything else → null. */
export function parseVersionLine(out: string | null): string | null {
  const m = /^walkie (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?)\s*$/.exec((out ?? "").trim());
  return m ? m[1]! : null;
}

export interface HelperVersionDeps {
  /** Why the copy at a path can't be trusted to run (default runnerPathProblem: root's chain, executable). */
  pathProblem?: (path: string) => string | null;
  run?: RunVersion;
}

function copyOf(path: string, bad: string | null, out: string | null): HelperCopy {
  if (bad) return { path, version: null, why: bad };
  const version = parseVersionLine(out);
  return version ? { path, version } : { path, version: null, why: `${path} version didn't report a Walkie version` };
}

function summarize(copies: HelperCopy[], want: string): HelperVersion {
  const state = copies.some((c) => c.version === null) ? "unknown" : copies.every((c) => c.version === want) ? "current" : "stale";
  return { state, want, copies };
}

const defaultPathProblem = (p: string) => runnerPathProblem(p);

/** The copies at `paths` against `want` (this walkie's VERSION), blocking (the CLI's doctor). Pure given its deps. */
export function helperVersion(paths: readonly string[], want: string, deps: HelperVersionDeps = {}): HelperVersion {
  const pathProblem = deps.pathProblem ?? defaultPathProblem;
  const run = deps.run ?? realRunVersion;
  return summarize(paths.map((path) => { const bad = pathProblem(path); return copyOf(path, bad, bad ? null : run(path)); }), want);
}

/** The same without blocking (the daemon's seats view). */
export async function helperVersionAsync(paths: readonly string[], want: string, deps: HelperVersionAsyncDeps = {}): Promise<HelperVersion> {
  const pathProblem = deps.pathProblem ?? defaultPathProblem;
  const run = deps.runAsync ?? realRunVersionAsync;
  const copies = await Promise.all(paths.map(async (path) => { const bad = pathProblem(path); return copyOf(path, bad, bad ? null : await run(path)); }));
  return summarize(copies, want);
}

export interface HelperVersionAsyncDeps {
  pathProblem?: (path: string) => string | null;
  runAsync?: RunVersionAsync;
}

/** Whether `a` is an older version than `b` (Bun's semver order), or null when it can't tell. */
export function olderThan(a: string, b: string): boolean | null {
  try { return Bun.semver.order(a, b) < 0; } catch { return null; }
}

/** The doctor's line for a stale or unknown result (null when current). */
export function helperVersionProblem(v: HelperVersion): string | null {
  if (v.state === "current") return null;
  const found = v.copies.map((c) => `${c.path.replace(/^.*\//, "")} ${c.version ?? "unknown"}`).join(", ");
  if (v.state === "unknown") {
    const why = v.copies.find((c) => c.why)?.why;
    return `the seat helper's version is unknown (${found}; this walkie is ${v.want})${why ? `: ${why}` : ""}`;
  }
  const other = v.copies.find((c) => c.version !== v.want)?.version ?? "";
  const age = olderThan(other, v.want) === false ? "a newer" : "an older";
  return `the seat helper is from ${age} Walkie (${found}; this walkie is ${v.want})`;
}

/** A copy's identity for the cache: it changes when the copy is reinstalled. */
export type StatFn = (p: string) => { ino: number; size: number; mtimeMs: number; ctimeMs: number } | null;

/**
 * The daemon's check, never on its event loop's critical path (PRE5 RC LOW): `peek` answers from the last result and
 * starts a check in the background when a copy changed (inode, size or times: a `walkie seats setup-user --apply`),
 * or an unknown result is a minute old. Until the first check for the copies as they are now ends, it answers null.
 */
export class HelperVersionCache {
  private key: string | null = null;
  private value: HelperVersion | null = null;
  private at = 0;
  /** The key a check is running for (null: none). */
  private checking: string | null = null;
  private running: Promise<void> = Promise.resolve();
  constructor(private readonly deps: HelperVersionAsyncDeps & { stat?: StatFn; now?: () => number } = {}) {}

  peek(paths: readonly string[], want: string): HelperVersion | null {
    const stat: StatFn = this.deps.stat ?? ((p) => { try { return statSync(p); } catch { return null; } });
    const key = JSON.stringify([want, ...paths.map((p) => { const s = stat(p); return s ? [p, s.ino, s.size, s.mtimeMs, s.ctimeMs] : [p, null]; })]);
    const now = (this.deps.now ?? Date.now)();
    const due = key !== this.key || !this.value || (this.value.state === "unknown" && now - this.at >= UNKNOWN_RETRY_MS);
    if (due && this.checking !== key) {
      this.checking = key;
      this.running = helperVersionAsync(paths, want, this.deps).then((v) => {
        if (this.checking !== key) return; // superseded by a newer check
        this.key = key;
        this.value = v;
        this.at = (this.deps.now ?? Date.now)();
        this.checking = null;
      }, () => { if (this.checking === key) this.checking = null; });
    }
    return this.key === key ? this.value : null;
  }

  /** Tests: the check in flight, if any, has ended. */
  settled(): Promise<void> { return this.running; }
}
