// JSON-lines logger: logs/daemon.log rotated at 10 MB x 5; mirrors to stderr in foreground.
// The file write is asynchronous. appendFileSync on this thread stalled the daemon whenever the
// log volume was dirty (memory pressure evicts the page cache; the write then waits on the disk).
import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type Level = "debug" | "info" | "warn" | "error";
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** A stuck disk must not grow the queue without bound. Oldest lines are dropped. */
const MAX_QUEUED_LINES = 2_000;

export interface LoggerOptions {
  file?: string; stderr?: boolean; level?: Level; maxBytes?: number; keep?: number;
  /** The file write (tests substitute a stalled one). Default: appendFile. */
  append?: (file: string, text: string) => Promise<void>;
}

export function createLogger(opts: LoggerOptions): Logger & { flush(): Promise<void> } {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const keep = opts.keep ?? 5;
  const min = ORDER[opts.level ?? (process.env.WALKIE_LOG_LEVEL as Level | undefined) ?? "info"] ?? ORDER.info;
  const append = opts.append ?? ((file: string, text: string) => appendFile(file, text, { mode: 0o600 }));
  let size = opts.file && existsSync(opts.file) ? statSync(opts.file).size : 0;
  let queue: string[] = [];
  let pumping = false;
  let tail: Promise<void> = Promise.resolve();

  function rotate(file: string): void {
    rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    if (existsSync(file)) renameSync(file, `${file}.1`);
    size = 0;
  }

  async function writeLines(file: string, lines: string[]): Promise<void> {
    let chunk = "";
    const flushChunk = async (): Promise<void> => {
      if (!chunk) return;
      if (size > 0 && size + chunk.length > maxBytes) rotate(file);
      const text = chunk;
      chunk = "";
      await mkdir(dirname(file), { recursive: true });
      await append(file, text);
      size += Buffer.byteLength(text);
      if (size > maxBytes) rotate(file);
    };
    for (const line of lines) {
      if (chunk.length > 0 && chunk.length + line.length > maxBytes) await flushChunk();
      chunk += line;
    }
    await flushChunk();
  }

  function kick(): void {
    if (pumping || !opts.file) return;
    pumping = true;
    const file = opts.file;
    tail = tail.then(async () => {
      try {
        while (queue.length) {
          const lines = queue;
          queue = [];
          try { await writeLines(file, lines); }
          catch { /* logging must never take the daemon down */ }
        }
      } finally {
        pumping = false;
        if (queue.length) kick();
      }
    });
  }

  function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < min) return;
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n";
    } catch {
      line = JSON.stringify({ ts: new Date().toISOString(), level, msg, fields: "unserializable" }) + "\n";
    }
    if (opts.file) {
      queue.push(line);
      if (queue.length > MAX_QUEUED_LINES) queue.splice(0, queue.length - MAX_QUEUED_LINES);
      kick();
    }
    if (opts.stderr) process.stderr.write(line);
  }

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    /** Resolves once every line queued so far has been written (or dropped because the disk rejected it). */
    flush: async () => {
      for (let i = 0; i < 100 && (queue.length || pumping); i++) {
        kick();
        await tail;
      }
    },
  };
}
