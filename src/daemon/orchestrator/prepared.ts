// What a scheduled duty's prepare step may hand the runner besides plain evidence text (PROJECT-REPORTS-1): a turn with its
// own fence wording and a step that reads the reply, or the decision that no model turn is needed at all.

/** The outcome a run records: its result line, and whether it counts as a success (a failure counts towards the pause). */
export interface TurnOutcome { text: string; ok: boolean }

export interface PreparedTurn {
  /** Facts for the prompt: teammate-written text, fenced as untrusted (information, not instructions). */
  evidence: string;
  /** The fence's tag and what it tells the model; default: the board steward's results. */
  fence?: { tag: string; note: string };
  /**
   * Runs once when the turn's reply arrives (a turn that failed or timed out never reaches it, and a completion write
   * that is retried does not run it again); what it returns is the run's result.
   */
  finish?: (reply: { text: string; ok: boolean }, now: number) => TurnOutcome;
  /**
   * `none`: this turn needs no tool at all (its facts are all in the prompt and the daemon acts on its reply), so its
   * Claude is launched with none: no built-in tool and no MCP server, never with permissions bypassed.
   */
  tools?: "none";
}

/** The prepare step found nothing to do: no model turn; the run completes at once as a success with this result. */
export interface SkippedTurn { skip: string }

/** A prepare step's answer: plain evidence text (board refresh), a prepared turn, or a skip. */
export type Prepared = string | PreparedTurn | SkippedTurn;
