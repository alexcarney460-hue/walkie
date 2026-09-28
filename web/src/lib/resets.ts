// One reset attempt from the confirmation sheet (ACCOUNTS-RESET-1..4). The DAEMON mints the attempt's id when the sheet
// opens (POST /v1/accounts/reset/prepare) and binds it to the account; the page never invents one, and the sheet never
// switches to another one. A double-click (or Enter pressed twice) sends ONE request; a retry reuses the id, which the
// daemon and Codex treat as the same attempt, so a retry can never use a second reset.
import type { ResetAttemptView, ResetResult } from "../api/types.ts";

export type UseReset = (account: string, requestId: string) => Promise<{ result: ResetResult }>;
export type PrepareReset = (account: string) => Promise<{ attempt: ResetAttemptView }>;

/**
 * The confirmation sheet's attempt, pinned for the sheet's lifetime (RESET-4, Codex r2 HIGH 1). The first prepared id
 * is the only one this sheet ever sends. Before its first send, a different id from the daemon means another window
 * finished it: "superseded", nothing is sent. After its first send (even if the answer never arrived) a different id
 * only means THIS attempt was resolved, so it is ignored, and every retry asks by the same id: the daemon replays a
 * final answer or reconciles an unconfirmed one with the same idempotency key and credit. Never a new attempt.
 */
export class ResetSheetFlow {
  openedFor: string | null = null;
  sent = false;
  superseded = false;
  private inflight: Promise<ResetResult | "superseded"> | null = null;

  constructor(readonly account: string, private readonly deps: { prepare: PrepareReset; use: UseReset }) {}

  onPrepared(v: ResetAttemptView): "accept" | "superseded" | "ignore" {
    if (this.openedFor === null) this.openedFor = v.id;
    if (v.id === this.openedFor) return "accept";
    if (this.sent) return "ignore";
    this.superseded = true;
    return "superseded";
  }

  /** Confirms (or retries) this sheet's attempt. A double-click is one request. */
  confirm(): Promise<ResetResult | "superseded"> {
    if (this.inflight) return this.inflight;
    const id = this.openedFor;
    if (this.superseded || id === null) return Promise.resolve("superseded");
    const run = async (): Promise<ResetResult | "superseded"> => {
      if (!this.sent) {
        // Right before the first send: is it still the attempt this sheet was opened for?
        const r = await this.deps.prepare(this.account);
        if (this.onPrepared(r.attempt) === "superseded") return "superseded";
      }
      this.sent = true;
      return (await this.deps.use(this.account, id)).result;
    };
    this.inflight = run().finally(() => { this.inflight = null; });
    return this.inflight;
  }
}
