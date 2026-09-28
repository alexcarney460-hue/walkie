// Reset attempts (WALKIE-ACCOUNTS-RESET-2/3): the daemon mints each attempt when the confirmation sheet opens and
// binds it to the account the person is confirming: the Walkie account id, the ChatGPT account id and the login
// directory, from ONE read of that login (codexAuthSnapshot). An email or sign-in-mode change with the same account id
// is the same account (RESET-3). The binding is kept for the attempt's whole life, final or not, so an id can never be
// used for another account. An unconfirmed attempt (the use was SENT, no answer) is kept per account, persisted in
// accounts.json and handed back instead of a new id until it is resolved: a retry reuses its id (Codex's idempotency
// key) and its credit, so it can never become a second reset. "Sent" is recorded apart from "running", so a daemon that
// stopped before sending reloads the attempt as not sent (open), not as unconfirmed.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ResetAttemptView, ResetResult } from "../protocol/accounts.ts";

export type AttemptState = "open" | "running" | "unconfirmed" | "final";

export interface Attempt {
  id: string;
  account: string;
  loginDir: string;
  chatgptAccount: string;
  creditId: string | null;
  state: AttemptState;
  result: ResetResult | null;
  createdAt: number;
  /** When a use was last sent (an unconfirmed attempt's re-read must be later than this). */
  triedAt: number | null;
  /** The use was handed to Codex (at least once); only then can the attempt be unconfirmed. */
  sent: boolean;
  /** The daemon stopped while this attempt ran but before it was sent (the sheet says "nothing was sent"). */
  interrupted: boolean;
}

/** An attempt nobody confirmed is dropped after this. */
export const OPEN_TTL_MS = 30 * 60_000;
/** A final attempt's answer is replayed for its id this long (a retried request, a second tab). */
export const FINAL_TTL_MS = 24 * 3_600_000;
/**
 * An attempt that may have been sent (unconfirmed, running, or sent and not final) never expires on a clock (RESET-4:
 * a forward clock jump must not release it): only Codex's own answer to a retry, or a person marking it checked
 * (resolve), releases it.
 */
export function unresolved(a: Pick<Attempt, "state" | "sent">): boolean {
  return a.state === "unconfirmed" || a.state === "running" || (a.sent && a.state !== "final");
}
export const MAX_ATTEMPTS = 64;
/** Rows read from the file at most (unconfirmed ones beyond the cap are never dropped by sweep, so allow slack). */
export const MAX_ATTEMPT_ROWS = 256;

const Outcome = z.enum(["reset", "already_used", "not_needed", "none", "login_changed", "unverified", "busy", "check_usage", "dismissed", "unconfirmed", "failed"]);
export const PersistedAttempt = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{16,64}$/),
  account: z.string().regex(/^[0-9a-f]{24}$/),
  login_dir: z.string().max(4096),
  chatgpt_account: z.string().min(1).max(200),
  credit_id: z.string().max(200).nullable(),
  state: z.enum(["open", "running", "unconfirmed", "final"]),
  result: z.object({ outcome: Outcome, left: z.number().int().min(0).max(99).nullable() }).nullable(),
  created_at: z.number(),
  tried_at: z.number().nullable(),
  sent: z.boolean(),
  interrupted: z.boolean().default(false),
});
export type PersistedAttempt = z.infer<typeof PersistedAttempt>;

export class ResetAttempts {
  private readonly byId = new Map<string, Attempt>();

  constructor(private readonly clock: () => number) {}

  get(id: string): Attempt | undefined { return this.byId.get(id); }

  /** The account's attempt that is not final yet (at most one: prepare hands it back instead of minting). */
  pendingFor(account: string): Attempt | undefined {
    return [...this.byId.values()].find((a) => a.account === account && a.state !== "final");
  }

  mint(binding: Pick<Attempt, "account" | "loginDir" | "chatgptAccount">): Attempt {
    const a: Attempt = { ...binding, id: randomUUID(), creditId: null, state: "open", result: null, createdAt: this.clock(), triedAt: null, sent: false, interrupted: false };
    this.byId.set(a.id, a);
    this.sweep();
    return a;
  }

  /** Replaces an attempt with an updated copy (the binding fields never change). */
  update(id: string, patch: Partial<Pick<Attempt, "creditId" | "state" | "result" | "triedAt" | "sent" | "interrupted">>): Attempt | undefined {
    const a = this.byId.get(id);
    if (!a) return undefined;
    const next = { ...a, ...patch };
    this.byId.set(id, next);
    return next;
  }

  drop(id: string): void { this.byId.delete(id); }

  /** Drops expired open and final attempts; an unresolved one is never dropped (see unresolved()). */
  sweep(): void {
    const now = this.clock();
    for (const [id, a] of this.byId) {
      if (unresolved(a)) continue;
      const age = now - (a.triedAt ?? a.createdAt);
      if (age > (a.state === "final" ? FINAL_TTL_MS : OPEN_TTL_MS)) this.byId.delete(id);
    }
    // Over the cap: the oldest finals go first, then the oldest open ones; unconfirmed ones are kept.
    const extra = this.byId.size - MAX_ATTEMPTS;
    if (extra > 0) {
      const order = (a: Attempt) => (a.state === "final" ? 0 : a.state === "open" ? 1 : 2);
      [...this.byId.values()].sort((x, y) => order(x) - order(y) || x.createdAt - y.createdAt).slice(0, extra).forEach((a) => {
        if (!unresolved(a)) this.byId.delete(a.id);
      });
    }
  }

  view(a: Attempt, reread: boolean): ResetAttemptView {
    return {
      id: a.id, account: a.account,
      earlier: a.state === "unconfirmed" && a.triedAt !== null ? { tried_at: a.triedAt, reread } : null,
      ...(a.interrupted ? { interrupted: true } : {}),
    };
  }

  toJSON(): PersistedAttempt[] {
    return [...this.byId.values()].map((a) => ({
      id: a.id, account: a.account, login_dir: a.loginDir, chatgpt_account: a.chatgptAccount,
      credit_id: a.creditId, state: a.state, result: a.result ? { outcome: a.result.outcome, left: a.result.left } : null,
      created_at: a.createdAt, tried_at: a.triedAt, sent: a.sent, interrupted: a.interrupted,
    }));
  }

  /**
   * Loads persisted attempt rows one by one. Returns how many rows could not be read: any is a reason to keep the
   * file's evidence and refuse resets (the caller's job). A running attempt that was sent may have gone through:
   * unconfirmed. One that was not sent is open again, marked interrupted ("nothing was sent").
   */
  load(rows: readonly unknown[]): number {
    let bad = 0;
    for (const raw of rows.slice(0, MAX_ATTEMPT_ROWS)) {
      const p = PersistedAttempt.safeParse(raw);
      if (!p.success) { bad++; continue; }
      const r = p.data;
      const running = r.state === "running";
      const state: AttemptState = running ? (r.sent ? "unconfirmed" : "open") : r.state === "unconfirmed" && !r.sent ? "open" : r.state;
      this.byId.set(r.id, {
        id: r.id, account: r.account, loginDir: r.login_dir, chatgptAccount: r.chatgpt_account,
        creditId: r.credit_id, state, result: r.result, createdAt: r.created_at,
        triedAt: running && r.sent ? r.tried_at ?? r.created_at : r.tried_at,
        sent: r.sent, interrupted: r.interrupted || (running && !r.sent),
      });
    }
    bad += Math.max(0, rows.length - MAX_ATTEMPT_ROWS);
    this.sweep();
    return bad;
  }
}
