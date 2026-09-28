// JSON-lines logger: logs/daemon.log rotated at 10 MB x 5; mirrors to stderr in foreground.
import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";

export type Level = "debug" | "info" | "warn" | "error";
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  file?: string; stderr?: boolean; level?: Level; maxBytes?: number; keep?: number;
}

export function createLogger(opts: LoggerOptions): Logger {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const keep = opts.keep ?? 5;
  const min = ORDER[opts.level ?? (process.env.WALKIE_LOG_LEVEL as Level | undefined) ?? "info"] ?? ORDER.info;
  let size = opts.file && existsSync(opts.file) ? statSync(opts.file).size : 0;

  function rotate(file: string): void {
    rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    if (existsSync(file)) renameSync(file, `${file}.1`);
    size = 0;
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
      try {
        if (size + line.length > maxBytes) rotate(opts.file);
        appendFileSync(opts.file, line, { mode: 0o600 });
        size += Buffer.byteLength(line);
      } catch {
        // Logging must never take the daemon down; stderr below still carries it.
      }
    }
    if (opts.stderr) process.stderr.write(line);
  }

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
