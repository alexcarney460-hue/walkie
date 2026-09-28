// Paged re-validation after the authority chain grows (PROTOCOL §2, "Re-validation"). Anchored
// events never change verdict, so a new chain entry re-judges only UNANCHORED rows (seq above the
// chain's watermark for their origin, taken just before the new entries) that the entry can affect:
// the rows of the member's or node's origins, or of the channel. An ask that becomes accepted by any
// path (ingest, stub fill, a flip here) or changes verdict re-judges its stored answers as a job of
// its own. At most REVAL_PAGE rows are judged per pass, under one budget for every job kind; the
// rest continues on the next event-loop tick so ingest never stalls.
import type { BodyOf } from "../protocol/schemas.ts";
import type { ChainEntry } from "./chain.ts";
import type { Roster } from "./roster.ts";
import type { EventRow, RevalJob, Store } from "./store.ts";
import { trackOp } from "./watchdog.ts";

/** Hidden (signed, curable) non-roster rows kept per origin: the lowest seqs; beyond that only a header stub. */
export const HIDDEN_PER_ORIGIN_CAP = 1_000;
export const REVAL_PAGE = 1_000;

/**
 * The re-validation jobs a batch of new chain entries creates. `floor` is the chain's prefix-max
 * watermark just before the batch: rows at or below it were anchored already and keep their verdict.
 */
export function jobsFor(entries: readonly ChainEntry[], head: Roster, floor: Readonly<Record<string, number>>): RevalJob[] {
  const jobs: RevalJob[] = [];
  const originJob = (origin: string): RevalJob => ({ kind: "origin", origin, minSeq: (floor[origin] ?? 0) + 1 });
  for (const { ev } of entries) {
    if (ev.kind === "channel.upsert") {
      jobs.push({ kind: "channel", channel: (ev.body as BodyOf<"channel.upsert">).name, floor: { ...floor } });
    } else if (ev.kind === "team.member") {
      const login = (ev.body as BodyOf<"team.member">).login;
      for (const n of head.nodes.values()) if (n.login === login) jobs.push(originJob(n.node_id));
    } else if (ev.kind === "team.node") {
      jobs.push(originJob((ev.body as BodyOf<"team.node">).node_id));
    }
  }
  return jobs;
}

function keyOf(j: RevalJob): string {
  switch (j.kind) {
    case "origin": return `o:${j.origin}`;
    case "channel": return `c:${j.channel}`;
    case "answers": return `a:${j.ask}`;
    default: return "all";
  }
}

/** Two queued jobs for the same key cover the union of their rows. */
function merge(prev: RevalJob, job: RevalJob): RevalJob {
  if (prev.kind === "origin" && job.kind === "origin") return { ...job, minSeq: Math.min(prev.minSeq, job.minSeq) };
  if (prev.kind === "channel" && job.kind === "channel") {
    // An origin missing from either floor is 0 there, so it drops out of the pointwise minimum.
    const floor: Record<string, number> = {};
    for (const [o, v] of Object.entries(prev.floor)) {
      const w = job.floor[o];
      if (w !== undefined) floor[o] = Math.min(v, w);
    }
    return { ...job, floor };
  }
  return job;
}

export class Revalidator {
  private jobs: { job: RevalJob; after: number }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /**
   * Queued jobs live in memory; a `reval_pending` meta flag marks unfinished work so that a restart
   * in the middle re-judges every stored row once (see Core's constructor). Core also sets it in the
   * transaction that advances the chain, before the jobs exist.
   */
  constructor(
    private readonly store: Store,
    private readonly judge: (rows: readonly EventRow[]) => void,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** Whether the previous run stopped with work still queued. */
  get interrupted(): boolean { return this.store.getMeta("reval_pending") === "1"; }

  get pending(): number { return this.jobs.length; }

  /** Queues jobs; a job already queued restarts from the beginning (the chain changed under it). */
  enqueue(jobs: readonly RevalJob[]): void {
    for (const job of jobs) {
      const key = keyOf(job);
      const prev = this.jobs.find((j) => keyOf(j.job) === key)?.job;
      this.jobs = this.jobs.filter((j) => keyOf(j.job) !== key);
      this.jobs.push({ job: prev ? merge(prev, job) : job, after: 0 });
    }
    if (this.jobs.length) this.store.setMeta("reval_pending", "1");
  }

  /** Judges up to `budget` rows now and schedules the remainder for the next tick. */
  run(budget = REVAL_PAGE): void {
    while (budget > 0 && this.jobs.length) {
      const head = this.jobs[0] as { job: RevalJob; after: number };
      const limit = Math.min(budget, 500);
      const page = this.store.revalPage(head.job, head.after, limit);
      if (page.length) {
        head.after = (page[page.length - 1] as { rowid: number }).rowid;
        this.judge(page);
        budget -= page.length;
      }
      // `judge` may have queued answer jobs; the head is still this job unless it finished.
      if (page.length < limit) this.jobs = this.jobs.filter((j) => j !== head);
    }
    if (!this.jobs.length) this.store.setMeta("reval_pending", "0");
    this.schedule();
  }

  /** Continues queued jobs on a later event-loop tick (never inside the caller's ingest). */
  schedule(): void {
    if (!this.jobs.length || this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { trackOp("revalidate", () => this.run()); } catch (err) { this.onError(err); }
    }, 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
