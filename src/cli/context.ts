// Shared CLI command context.
import { WalkieClient, WalkieError } from "../client/index.ts";
import { createWriteStream, openSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { agentSignals, underAgent, type AgentSignals } from "./agent-detect.ts";
import type { Args } from "./args.ts";
import { openTermInput } from "./prompt.ts";
import { writeErr, writeOut, writeStream } from "./stdio.ts";

export const EXIT = { ok: 0, error: 1, timeout: 2, unreachable: 3 } as const;

export interface Ctx {
  readonly args: Args;
  readonly json: boolean;
  /** Output goes to a model (FINAL Codex 5): reads carry the PROTOCOL §6 safety contract. */
  readonly forAgent: boolean;
  /**
   * Why this CLI counts as an agent's for person-only commands (an environment marker, an agent runtime among its
   * ancestor processes, --for-agent), or null for a person. Computed once, on first use (agent-detect.ts).
   */
  agentMarker(): string | null;
  /** The marker and whether the process table could be read (a diagnostic); defaults to agentMarker(). */
  agentSignals?(): AgentSignals;
  /** The terminal person-only commands confirm on (tests substitute one). */
  readonly person?: PersonIo;
  /** The daemon client; `underAgent` marks its requests as an agent's (AGENT-ADMIN-1: an unattended admin caller). */
  client(o?: { underAgent?: boolean }): WalkieClient;
  out(s: string): void;
  err(s: string): void;
  /** A line of a streaming command's output; rejects with OutputClosed when the reader went away (stdio.ts). */
  outStream?(s: string): Promise<void>;
}

export type Command = (ctx: Ctx) => Promise<number>;

/** Where a person-only command asks its person (stdin and stdout are both a terminal: a person is there to answer). */
export interface PersonIo {
  interactive(): boolean;
  /** Asks on the terminal (the prompt goes to stderr, so `--json` output stays clean) and returns the line typed. */
  ask(prompt: string): Promise<string>;
  /** A one-line diagnostic on stderr. */
  note(line: string): void;
}

/** How long the confirmation waits for an answer; WALKIE_CONFIRM_TIMEOUT_S may only shorten it. */
export const CONFIRM_TIMEOUT_MS = 120_000;

function confirmTimeoutMs(): number {
  const v = Number(process.env.WALKIE_CONFIRM_TIMEOUT_S);
  return Number.isFinite(v) && v > 0 ? Math.min(v * 1000, CONFIRM_TIMEOUT_MS) : CONFIRM_TIMEOUT_MS;
}

/**
 * The terminal to prompt on: /dev/tty itself (stdout stays free for `--json | jq`), else stderr. Opened synchronously:
 * createWriteStream("/dev/tty") opens later and, with no controlling terminal, raised an uncaught ENXIO (PRE5 RC INFO).
 */
function promptStream(): NodeJS.WritableStream {
  let fd: number;
  try { fd = openSync("/dev/tty", "w"); } catch { return process.stderr; }
  const s = createWriteStream("", { fd });
  s.on("error", () => { /* the terminal went away: nothing more to show */ });
  return s;
}

/** Asked and not answered: Ctrl-C, Ctrl-Z, Ctrl-\\, Ctrl-D (end of input) or the timeout. */
export class Unanswered extends Error {}

export const TERMINAL: PersonIo = {
  // Only stdin must be a person's terminal (what they type is the answer); stdout may be a pipe (`--json | jq`).
  interactive: () => process.stdin.isTTY === true,
  ask(prompt) {
    // A descriptor of its own on the terminal (/dev/tty), not process.stdin (SETUP-TTY: froze on macOS when stdin is /dev/tty).
    const term = openTermInput();
    if (!term) return Promise.reject(new Unanswered("no terminal"));
    const out = promptStream();
    const rl = createInterface({ input: term.input, output: out, terminal: true });
    return new Promise<string>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        term.input.off("keypress", onKey);
        rl.close();
        term.close();
        if (out !== process.stderr) (out as NodeJS.WritableStream & { end(): void }).end();
        fn();
      };
      const cancel = (why: string) => finish(() => reject(new Unanswered(why)));
      const timer = setTimeout(() => cancel("no answer in time"), confirmTimeoutMs());
      const onKey = (_s: unknown, key?: { sequence?: string }) => { if (key?.sequence === "\x1c") cancel("cancelled (Ctrl-\\)"); };
      term.input.on("keypress", onKey);
      rl.on("SIGINT", () => cancel("cancelled (Ctrl-C)"));
      rl.on("SIGTSTP", () => cancel("cancelled (Ctrl-Z)"));
      rl.on("close", () => cancel("cancelled (end of input)"));
      rl.question(prompt).then((a) => finish(() => resolve(a.trim())), () => cancel("cancelled"));
    });
  },
  note: (line) => writeErr(line + "\n"),
};

/**
 * Person-only commands (invites, add-machine links, roles, the roster authority, revocations, the dashboard's login;
 * WALKIE-ADD-MACHINE-2/4/5). THE GATE is an interactive confirmation: stdin must be a terminal (stdout may be a pipe,
 * the prompt goes to /dev/tty), and the person types `confirm` (the handle or machine the command acts on, or "yes")
 * within 2 minutes; Ctrl-C/Ctrl-Z/Ctrl-\\/Ctrl-D cancel. Agents' tool runners (Claude Code's Bash tool, `kimi -p`,
 * `codex exec`, Aider's /run and test runner) give a command no terminal. Some give one: interactive Aider runs
 * commands on a pty (pexpect), Codex's unified exec can, and tmux or `ssh -tt` hand any caller a terminal; there the
 * extra signals (environment markers, ancestor processes: agent-detect.ts, refused first) are what may still stop an
 * agent. The daemon refuses the same routes to agent-marked requests too.
 */
export async function requirePerson(ctx: Ctx, what: string, confirm: string): Promise<void> {
  const io = ctx.person ?? TERMINAL;
  const signals = ctx.agentSignals?.() ?? { marker: ctx.agentMarker(), inspection: "ok" as const };
  if (signals.marker) {
    throw new WalkieError("person_only", `agents can't ${what}: this terminal looks like an agent's (${signals.marker}). `
      + "Run it yourself in a terminal, or use the dashboard", 403);
  }
  if (signals.inspection !== "ok") io.note(`note: process inspection ${signals.inspection}; relying on the terminal confirmation`);
  if (!io.interactive()) {
    throw new WalkieError("person_only", `only a person can ${what}, at a terminal: run this yourself in a terminal, or use the dashboard`, 403);
  }
  let answer: string;
  try {
    answer = await io.ask(`To ${what}, type ${confirm === "yes" ? "yes" : `"${confirm}"`} to confirm: `);
  } catch (e) {
    throw new WalkieError("not_confirmed", `not confirmed (${e instanceof Error ? e.message : "cancelled"}): nothing was done`, 400);
  }
  const bare = (v: string) => v.trim().replace(/^@/, "").toLowerCase();
  if (bare(answer) !== bare(confirm)) {
    throw new WalkieError("not_confirmed", `not confirmed (typed "${answer.slice(0, 40)}", expected "${confirm}"): nothing was done`, 400);
  }
}

export function agentFrom(args: Args): string | undefined {
  const v = args.flags.get("agent");
  return typeof v === "string" ? v : process.env.WALKIE_AGENT || undefined;
}

export function makeCtx(args: Args): Ctx {
  const agent = agentFrom(args);
  const flag = args.flags.get("for-agent") === true;
  let signals: AgentSignals | undefined;
  const signalsOnce = (): AgentSignals => (signals ??= agentSignals({ forAgentFlag: flag }));
  const markerOnce = (): string | null => signalsOnce().marker;
  return {
    args,
    json: args.flags.get("json") === true,
    // Output for a model (PROTOCOL §6 wrapping) when the flag, an environment marker or an agent runtime among the
    // ancestors says so (Kimi, Hermes and Aider set no variable). Lazy: the environment answers first, so hooks and
    // commands under Claude Code or Codex never read the process table for it.
    get forAgent() { return flag || underAgent() || signalsOnce().marker !== null; },
    agentMarker: markerOnce,
    agentSignals: signalsOnce,
    person: TERMINAL,
    // Every request of a CLI under an agent is marked, named or not: the daemon's person-only gate sees it.
    client: (o) => new WalkieClient({ agent, underAgent: o?.underAgent === true || markerOnce() !== null }),
    out: (s) => writeOut(s + "\n"),
    err: (s) => writeErr(s + "\n"),
    outStream: (s) => writeStream(1, s + "\n"),
  };
}

export async function readStdin(): Promise<string> {
  return (await new Response(Bun.stdin.stream()).text()).replace(/\n$/, "");
}
