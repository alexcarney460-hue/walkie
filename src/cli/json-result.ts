// The machine-readable result of `setup`, `hooks install|uninstall` and `daemon start|stop|restart` with --json:
// exactly one JSON object on stdout, {"ok":true,"command":…,…facts} or {"ok":false,"command":…,"error":{code,message}}.
// Prose goes to stderr meanwhile (what `daemon status --json` does: nothing but the object on stdout), the exit code is
// the one the prose path returns, and the command never prompts.
import { WalkieError } from "../client/index.ts";
import { UsageError } from "./args.ts";
import { errorForModel } from "./agent-output.ts";
import type { Ctx } from "./context.ts";
import { safeTerm } from "./format.ts";

export interface JsonError { code: string; message: string }
export type JsonFacts = Readonly<Record<string, unknown>>;

/** What a command did, for the result object. `exit` is the exit code; a non-zero exit with `error` is a failure result. */
export interface JsonOutcome {
  exit: number;
  facts?: JsonFacts;
  error?: JsonError;
  /** A child process already wrote the one result object (setup re-running itself from the installed binary). */
  delegated?: true;
}

export const okResult = (command: string, facts: JsonFacts = {}): JsonFacts => ({ ok: true, command, ...facts });
export const failResult = (command: string, error: JsonError, facts: JsonFacts = {}): JsonFacts => ({ ok: false, command, error, ...facts });

/** The stable code of a thrown error: the daemon's or client's own code, `usage` for a refused invocation, else `error`. */
export function errorCode(err: unknown): string {
  if (err instanceof WalkieError) return err.code || "error";
  if (err instanceof UsageError) return "usage";
  return "error";
}

/** The human message, worded like the prose path's stderr line (control characters out; defanged for a model). */
export function errorMessage(ctx: Pick<Ctx, "forAgent">, command: string, err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return ctx.forAgent ? errorForModel(command.split(" ")[0] ?? command, text, errorCode(err)) : safeTerm(text);
}

/** The same context with prose (`out`) sent to stderr, so stdout carries only the result object. */
export function quietCtx(ctx: Ctx): Ctx {
  const own = (value: unknown): PropertyDescriptor => ({ value, enumerable: true, writable: true, configurable: true });
  // Own, enumerable properties like the original's, so a command that spreads its context (hooks all) keeps `out` and `json`.
  return Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(ctx), out: own((s: string) => ctx.err(s)), outStream: own(undefined) }) as Ctx;
}

/**
 * Runs `run` with prose on stderr and writes its result object to stdout. A thrown error is written as a failure
 * object and then rethrown, so the CLI's own handler prints the prose line on stderr and picks the same exit code.
 */
export async function runJsonCommand(ctx: Ctx, command: string, run: (quiet: Ctx) => Promise<JsonOutcome>): Promise<number> {
  let outcome: JsonOutcome;
  try {
    outcome = await run(quietCtx(ctx));
  } catch (err) {
    ctx.out(JSON.stringify(failResult(command, { code: errorCode(err), message: errorMessage(ctx, command, err) })));
    throw err;
  }
  if (outcome.delegated) return outcome.exit;
  if (outcome.error) ctx.out(JSON.stringify(failResult(command, outcome.error, outcome.facts)));
  else if (outcome.exit !== 0) ctx.out(JSON.stringify(failResult(command, { code: "error", message: `${command} exited ${outcome.exit}` }, outcome.facts)));
  else ctx.out(JSON.stringify(okResult(command, outcome.facts)));
  return outcome.exit;
}
