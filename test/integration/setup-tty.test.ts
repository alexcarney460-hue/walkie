// SETUP-TTY: `curl … | sh` froze at setup's first question on macOS (v0.2.0-pre.4): the installer runs
// `walkie setup < /dev/tty` (its own stdin is the pipe), and Bun's process.stdin never delivers a keystroke when stdin
// is /dev/tty itself. Here setup runs in exactly that shape, on a real pseudo-terminal: a `sh` whose stdin is a pipe
// starts it with `< /dev/tty`; the terminal types at the account-switching question (y/N). Everything lives in a
// temporary HOME / WALKIE_HOME against a stand-in daemon (already on a team), never this machine's own Walkie.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fakeDaemon, type FakeDaemon } from "../helpers/fake-daemon.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PTY_RUN = join(ROOT, "test", "helpers", "pty-run.py");
const MAIN = join(ROOT, "src", "cli", "main.ts");
const havePython = ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"].some(existsSync) || Bun.which("python3") !== null;
const QUESTION = "(y/N)";

let daemon: FakeDaemon;
let root = "";

beforeAll(() => {
  daemon = fakeDaemon({ "GET /v1/me": { handle: "alex", role: "member", team: { name: "Crew" }, tailscale: { ok: false } } });
  root = mkdtempSync("/tmp/walkie-setup-tty-");
});
afterAll(() => { daemon?.stop(); if (root) rmSync(root, { recursive: true, force: true }); });

/** The installer's hand-off on a pty: `… | sh` runs setup with stdin redirected from /dev/tty. */
async function setupOnPty(type: string | null, extraEnv: Record<string, string> = {}): Promise<{ code: number | "hung"; screen: string; home: string }> {
  const home = mkdtempSync(join(root, "home-"));
  const script = `exec "${process.execPath}" "${MAIN}" setup --no-service --no-hooks < /dev/tty`;
  const env: Record<string, string> = {
    HOME: home, WALKIE_HOME: join(home, ".walkie"), WALKIE_SOCKET: daemon.socket, WALKIE_SETUP_REEXEC: "1",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh", TERM: "xterm", NO_COLOR: "1", ...extraEnv,
  };
  const argv = ["python3", PTY_RUN, type === null ? "" : QUESTION, type ?? "", "/bin/sh", "-c", 'printf "%s\\n" "$0" | /bin/sh', script];
  // The person reads the question first: typing at once can land before setup starts waiting and hide the freeze.
  const p = Bun.spawn(argv, { env: { ...env, PATH: `${env.PATH}:/opt/homebrew/bin:/usr/local/bin`, PTY_TYPE_DELAY_S: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = new Response(p.stdout).text();
  const code = await Promise.race([p.exited, Bun.sleep(20_000).then(() => "hung" as const)]);
  if (code === "hung") p.kill("SIGKILL");
  // eslint-disable-next-line no-control-regex -- readline's cursor/erase sequences aren't text
  const screen = (await out).replace(/\r+\n/g, "\n").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  return { code, screen, home };
}

describe.skipIf(!havePython || !existsSync("/dev/tty"))("walkie setup handed the terminal as /dev/tty (curl | sh)", () => {
  test("a typed y is read: account switching turns on", async () => {
    const r = await setupOnPty("y");
    expect(r.code).toBe(0);
    expect(r.screen).toContain("already in Crew as @alex");
    expect(r.screen).toContain(QUESTION);
    expect(r.screen).toMatch(/on — shims in .*\.walkie\/bin/);
    expect(existsSync(join(r.home, ".walkie", "bin", "claude"))).toBe(true);
    expect(r.screen).toContain("walkie dashboard");
  }, 30_000);

  test("Enter takes the default [n]", async () => {
    const r = await setupOnPty("");
    expect(r.code).toBe(0);
    expect(r.screen).toContain("not now (later: walkie accounts shims install --profile)");
    expect(existsSync(join(r.home, ".walkie", "bin", "claude"))).toBe(false);
  }, 30_000);

  test("no answer in time takes the default and setup finishes instead of hanging", async () => {
    const r = await setupOnPty(null, { WALKIE_PROMPT_TIMEOUT_S: "1" });
    expect(r.code).toBe(0);
    expect(r.screen).toContain("(no answer in time: n)");
    expect(r.screen).toContain("not now");
    expect(r.screen).toContain("walkie dashboard");
  }, 30_000);
});

// The `walkie seats enable` reads (the person-only confirmation, then sudo reading the terminal itself, then the hidden
// token and a y/N) in both shapes: stdin is the terminal as a person's shell hands it over, and stdin is /dev/tty from
// the installer's `… | sh`. Every read gets its own keystrokes, and the child's password goes to the child.
const PTY_SCRIPT = join(ROOT, "test", "helpers", "pty-script.py");
const FIXTURE = join(ROOT, "test", "fixtures", "prompt-seq.ts");

async function sequenceOnPty(shape: "terminal" | "installer"): Promise<{ code: number; screen: string }> {
  const run = `exec "${process.execPath}" "${FIXTURE}"`;
  const cmd = shape === "terminal" ? ["/bin/sh", "-c", run] : ["/bin/sh", "-c", 'printf "%s\\n" "$0" | /bin/sh', `${run} < /dev/tty`];
  const steps = [["to confirm: ", "yes\r"], ["Password:", "wrong\r"], ["Password:", "right\r"], ["token for seats: ", "sk-ant-abc\r"], ["(y/N) [n] ", "y\r"]];
  const p = Bun.spawn(["python3", PTY_SCRIPT, JSON.stringify(steps), ...cmd], {
    env: { HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin", TERM: "xterm", NO_COLOR: "1", PTY_TYPE_DELAY_S: "1", PTY_IDLE_S: "10" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  // eslint-disable-next-line no-control-regex -- readline's cursor/erase sequences aren't text
  return { code: await p.exited, screen: out.replace(/\r+\n/g, "\n").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "") };
}

describe.skipIf(!havePython || !existsSync("/dev/tty"))("seats enable's prompts around a sudo that reads the terminal", () => {
  for (const shape of ["terminal", "installer"] as const) {
    test(`every prompt reads its own answer (${shape})`, async () => {
      const r = await sequenceOnPty(shape);
      expect(r.code).toBe(0);
      expect(r.screen).toContain("CONFIRM=yes");
      expect(r.screen).toContain("Sorry, try again.");
      expect(r.screen).toContain("SUDO=ok after 2");
      expect(r.screen).toContain("SUDO_EXIT=0");
      expect(r.screen).toContain("TOKEN=sk-ant-abc (typed)");
      expect(r.screen).not.toMatch(/Claude token for seats: [^\n]*sk-ant/); // hidden: never echoed
      expect(r.screen).toContain("YN=y (typed)");
    }, 60_000);
  }
});

// PRE5 RC (Opus MEDIUM): a question that timed out left a read on the terminal (a pool thread inside read() on
// /dev/tty) that took the next question's answer (A1=timeout, then "yes" at Q2 read as A2=timeout) or a sudo-like
// child's first line. Now nothing of a finished question reads the terminal (prompt.ts polls it non-blocking).
const TIMEOUT_FIXTURE = join(ROOT, "test", "fixtures", "prompt-timeout.ts");

async function afterTimeoutOnPty(mode: "two" | "child", kind: "line" | "hidden" | "confirm", shape: "terminal" | "installer"): Promise<{ code: number; screen: string }> {
  const run = `exec "${process.execPath}" "${TIMEOUT_FIXTURE}" ${mode} ${kind}`;
  const cmd = shape === "terminal" ? ["/bin/sh", "-c", run] : ["/bin/sh", "-c", 'printf "%s\\n" "$0" | /bin/sh', `${run} < /dev/tty`];
  const steps = mode === "two" ? [["Q2 (y/N) ", "yes\r"]] : [["Password:", "secret\r"]];
  const p = Bun.spawn(["python3", PTY_SCRIPT, JSON.stringify(steps), ...cmd], {
    env: { HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin", TERM: "xterm", NO_COLOR: "1", PTY_TYPE_DELAY_S: "0.5", PTY_IDLE_S: "8", WALKIE_CONFIRM_TIMEOUT_S: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  // eslint-disable-next-line no-control-regex -- readline's cursor/erase sequences aren't text
  return { code: await p.exited, screen: out.replace(/\r+\n/g, "\n").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "") };
}

describe.skipIf(!havePython || !existsSync("/dev/tty"))("a question that timed out leaves nothing reading the terminal", () => {
  for (const kind of ["line", "hidden", "confirm"] as const) {
    test(`${kind}: Q1 times out, then Q2 is answered`, async () => {
      for (const shape of ["terminal", "installer"] as const) {
        const r = await afterTimeoutOnPty("two", kind, shape);
        expect({ shape, code: r.code }).toEqual({ shape, code: 0 });
        expect(r.screen).toMatch(/A1=(timeout|no answer in time)/);
        expect(r.screen).toContain("A2=typed:yes");
      }
    }, 60_000);

    test(`${kind}: a question times out, then a sudo-like child reading /dev/tty gets its first line`, async () => {
      for (const shape of ["terminal", "installer"] as const) {
        const r = await afterTimeoutOnPty("child", kind, shape);
        expect({ shape, code: r.code }).toEqual({ shape, code: 0 });
        expect(r.screen).toContain("CHILD_GOT=[secret]");
        expect(r.screen).toContain("CHILD_EXIT=0");
      }
    }, 60_000);
  }
});

describe.skipIf(!havePython || !existsSync("/dev/tty"))("the confirmation's cancel keys, and no controlling terminal", () => {
  test("Ctrl-Z, Ctrl-\\ and Ctrl-D each cancel one confirmation; the next reads its own answer", async () => {
    const steps = [["confirm0: ", "\u001a"], ["confirm1: ", "\u001c"], ["confirm2: ", "\u0004"], ["confirm3: ", "yes\r"]];
    const p = Bun.spawn(["python3", PTY_SCRIPT, JSON.stringify(steps), process.execPath, TIMEOUT_FIXTURE, "cancels"], {
      env: { HOME: root, PATH: "/usr/bin:/bin", TERM: "xterm", NO_COLOR: "1", PTY_IDLE_S: "8" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const screen = (await new Response(p.stdout).text()).replace(/\r+\n/g, "\n");
    expect(await p.exited).toBe(0);
    for (const line of ["C0=threw cancelled (Ctrl-Z)", "C1=threw cancelled (Ctrl-\\)", "C2=threw cancelled (end of input)", "C3=yes"]) expect(screen).toContain(line);
  }, 30_000);

  test("without a controlling terminal (stdin a terminal of its own): no uncaught ENXIO, the answer is read from stdin's device", async () => {
    const py = `
import os, subprocess, sys, time
m, s = os.openpty()
p = subprocess.Popen(sys.argv[1:], stdin=s, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
os.close(s); time.sleep(1.5); os.write(m, b"yes\\r")
try: out, _ = p.communicate(timeout=15)
except subprocess.TimeoutExpired: p.kill(); out, _ = p.communicate(); out += b"[HUNG]"
sys.stdout.write(out.decode("utf-8", "replace")); sys.exit(p.returncode or 0)`;
    const p = Bun.spawn(["python3", "-c", py, process.execPath, TIMEOUT_FIXTURE, "gate"], {
      env: { HOME: root, PATH: "/usr/bin:/bin", TERM: "xterm", NO_COLOR: "1", WALKIE_CONFIRM_TIMEOUT_S: "8" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out).not.toContain("ENXIO");
    expect(out).not.toContain("[HUNG]");
    expect(out).toContain("C0=yes");
  }, 30_000);
});
