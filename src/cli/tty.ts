// Prompts on the controlling terminal (/dev/tty), even when stdin is a pipe (`… | walkie accounts add claude`). The
// vault commands that change logins need a person at a terminal: no terminal, no prompt, no change.
import { openSync } from "node:fs";
import { ReadStream } from "node:tty";

export interface Tty {
  /** One line, echoed. */
  ask(question: string): Promise<string>;
  /** One line, not echoed (a token). */
  secret(question: string): Promise<string>;
  close(): void;
}

let override: Tty | null | undefined;
/** Tests: a scripted terminal (null = no terminal). */
export function setTtyForTests(t: Tty | null | undefined): void { override = t; }

export function openTty(): Tty | null {
  if (override !== undefined) return override;
  let fd: number;
  try { fd = openSync("/dev/tty", "r+"); } catch { return null; }
  const input = new ReadStream(fd);
  const write = (s: string) => process.stderr.write(s);
  const line = (question: string, hidden: boolean) => new Promise<string>((resolve, reject) => {
    write(question);
    let buf = "";
    input.setRawMode(true);
    input.resume();
    const done = (err: Error | null) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      write("\n");
      if (err) reject(err); else resolve(buf);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(null);
        if (ch === "\u0003" || ch === "\u0004") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") { if (buf) { buf = buf.slice(0, -1); if (!hidden) write("\b \b"); } continue; }
        if (ch < " ") continue;
        if (buf.length < 4096) { buf += ch; if (!hidden) write(ch); }
      }
    };
    input.on("data", onData);
  });
  return {
    ask: (q) => line(q, false),
    secret: (q) => line(q, true),
    close: () => { try { input.destroy(); } catch { /* closed */ } },
  };
}
