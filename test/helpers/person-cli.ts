// Runs the real CLI the way a person's terminal does: no agent runtime among its ancestor processes, and (with
// `tty`) a real pseudo-terminal on stdin and stdout, where the test types an answer once a prompt appears. Tests
// themselves often run under an agent (bun test started by Claude Code or Codex), and person-only commands look at the
// CLI's ancestors (src/cli/agent-detect.ts), so the command is started from an orphaned shell: once that shell's
// parent exits, it is reparented to init/launchd, and the CLI's ancestors are that shell and init only.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INNER = `#!/bin/sh
orig="$1"; d="$2"; shift 2
echo $$ > "$d/pid"
# Wait until the parent that started us has exited and we were reparented (to init/launchd, or to a Linux
# subreaper such as WSL's /init or systemd --user): then no agent runtime is among our ancestors.
# (orig is the starting shell's pid, passed in: by the time this runs it may already have exited.)
n=0
while [ "$(ps -o ppid= -p $$ | tr -d ' ')" = "$orig" ]; do n=$((n+1)); [ "$n" -gt 500 ] && break; sleep 0.01; done
if [ -f "$d/in" ]; then "$@" > "$d/out" 2> "$d/err" < "$d/in" & else "$@" > "$d/out" 2> "$d/err" < /dev/null & fi
echo $! > "$d/child"
wait $!
echo $? > "$d/code.tmp" && mv "$d/code.tmp" "$d/code"
`;

export interface CliResult { out: string; err: string; code: number }

export interface PersonOptions {
  /** Run on a pseudo-terminal (test/helpers/pty-run.py): stdin and stdout are a TTY; stderr shows in `out` too. */
  tty?: boolean;
  /** Typed on the terminal once `after` shows in the output (a prompt). */
  type?: { after: string; text: string };
  /** Piped to the command's stdin (without `tty`). */
  stdin?: string;
  timeoutMs?: number;
}

const PTY_RUN = join(import.meta.dir, "pty-run.py");

/** `argv` (the executable first) with exactly `env`, detached from this process's ancestry; waits for it to finish. */
export async function runAsPerson(argv: string[], env: Record<string, string>, opts: PersonOptions | number = {}): Promise<CliResult> {
  const o: PersonOptions = typeof opts === "number" ? { timeoutMs: opts } : opts;
  const dir = mkdtempSync("/tmp/walkie-person-");
  try {
    const inner = join(dir, "inner.sh");
    writeFileSync(inner, INNER, { mode: 0o755 });
    if (o.stdin !== undefined && !o.tty) writeFileSync(join(dir, "in"), o.stdin);
    const cmd = o.tty ? ["python3", PTY_RUN, o.type?.after ?? "", o.type?.text ?? "", ...argv] : argv;
    const p = Bun.spawn(["/bin/sh", "-c", '/bin/sh "$0" "$$" "$@" </dev/null >/dev/null 2>&1 &', inner, dir, ...cmd], {
      env, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    await p.exited;
    const deadline = Date.now() + (o.timeoutMs ?? 60_000);
    while (!existsSync(join(dir, "code"))) {
      if (Date.now() > deadline) {
        // Stop exactly what this run started (the orphaned shell and its command), then fail.
        for (const f of ["child", "pid"]) {
          try { process.kill(Number(readFileSync(join(dir, f), "utf8").trim()), "SIGKILL"); } catch { /* gone */ }
        }
        throw new Error(`timed out: ${argv.join(" ")}`);
      }
      await Bun.sleep(20);
    }
    return { out: readFileSync(join(dir, "out"), "utf8"), err: readFileSync(join(dir, "err"), "utf8"), code: Number(readFileSync(join(dir, "code"), "utf8").trim()) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A person-only command as a person runs it: on a terminal, typing `answer` at its "…to confirm:" prompt. The terminal
 * merges stderr into stdout: `out` is everything after the prompt line, and `err` is the same text (so error checks
 * read either); `transcript` is the whole terminal.
 */
export async function runConfirmed(argv: string[], env: Record<string, string>, answer: string): Promise<CliResult & { transcript: string }> {
  const r = await runAsPerson(argv, env, { tty: true, type: { after: "to confirm: ", text: answer } });
  // eslint-disable-next-line no-control-regex -- the terminal's cursor/erase sequences (readline) aren't text
  const transcript = r.out.replace(/\r+\n/g, "\n").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const at = transcript.indexOf("to confirm: ");
  let after = at < 0 ? transcript : transcript.slice(at + "to confirm: ".length);
  // The terminal echoes the answer (the prompt is written to /dev/tty, so the echo can be partial): drop it.
  if (at >= 0) {
    let k = answer.length;
    while (k > 0 && !after.startsWith(answer.slice(0, k))) k--;
    after = after.slice(k).replace(/^\n/, "");
  }
  return { out: after, err: after, code: r.code, transcript };
}
