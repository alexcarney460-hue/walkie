// One pool job per machine (POOL-REAL-1 fix round, Codex p8 HIGH 1): serving a model, heading a split run, running a
// stage of someone else's run, and installing the runtime all compete for the same GPU memory and runtime directory.
// A job takes the machine's single reservation SYNCHRONOUSLY, before its first await, and keeps it through starting,
// running and stopping; it gives it back only when its teardown has finished (children gone, memory returned). A
// second job is refused at once with what holds the machine.
import { HttpError } from "../../daemon/http.ts";

export type JobKind = "serve" | "head" | "stage" | "install";

export interface JobHolder { kind: JobKind; id: string; since: number }

export interface Reservation {
  readonly kind: JobKind;
  readonly id: string;
  /** Gives the machine back; idempotent. */
  release(): void;
  /** Whether it still holds the machine. */
  held(): boolean;
}

const WHAT: Record<JobKind, string> = {
  serve: "serving a model",
  head: "running a split run from here",
  stage: "running a stage of another machine's split run",
  install: "installing the llama.cpp runtime",
};

export class PoolJobs {
  private cur: (JobHolder & { token: object }) | null = null;
  constructor(private readonly changed: () => void = () => undefined) {}

  holder(): JobHolder | null { return this.cur ? { kind: this.cur.kind, id: this.cur.id, since: this.cur.since } : null; }

  busy(): boolean { return this.cur !== null; }

  /** Why the machine is busy, in plain words, or null. */
  why(): string | null { return this.cur ? `this machine is ${WHAT[this.cur.kind]}` : null; }

  /** Takes the machine for `kind`, or throws 409 busy naming what holds it. Synchronous: no await can interleave. */
  reserve(kind: JobKind, id: string): Reservation {
    if (this.cur) throw new HttpError(409, "busy", `${this.why()}; one pool job at a time (walkie pool status)`);
    const token = {};
    this.cur = { kind, id, since: Date.now(), token };
    this.changed();
    return {
      kind, id,
      held: () => this.cur?.token === token,
      release: () => {
        if (this.cur?.token !== token) return;
        this.cur = null;
        this.changed();
      },
    };
  }
}
