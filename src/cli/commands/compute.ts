// walkie compute — rent machines for your team's agents (RENT-2, docs/plans/RENT-1.md): prepaid credit used per minute,
// five tiers, any number of machines in any mix; what doesn't fit our capacity yet is queued and starts on its own.
// Every line shows PRICES (never a cost). Renting and stopping are admin commands: a person confirms at the terminal
// (or passes --yes); an agent goes ahead while agent admin is on, audited in #general.
import { requireAdmin, adminCtx } from "../admin-gate.ts";
import { bool, int, str, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { ago, c, safeTerm } from "../format.ts";
import { WalkieError } from "../../client/index.ts";
import {
  COMPUTE_ALERT_TEXT, CREDIT_BLOCKS, CREDIT_LIFETIME_DAYS, CREDIT_TERMS, expiresInText, expiryText, IDLE_MINUTES_MAX, IDLE_MINUTES_MIN,
  parseMachineAsks, usd, type CreditBlock, type CreditLot, type LocalComputeState, type Quotes, type RentalView, type RentResult,
} from "../../protocol/compute.ts";

const USAGE = "walkie compute quotes | rent <tier>[=count] … [--idle <minutes>] [--yes] | list | stop <id|all> [--yes] | credit [buy 50|200|1000] | handover object";

/** "Each machine includes 1,024 GiB of outbound data per 730 hours, prorated by rented hours, then $0.02 per GiB." (the dashboard's words) */
export function egressText(q: Quotes): string {
  return `Each machine includes ${q.egress_included_gib.toLocaleString("en-US")} GiB of outbound data per 730 hours, prorated by rented hours, then ${usd(q.egress_price_per_gib_micros)} per GiB.`;
}

export function quotesText(q: Quotes): string {
  const rows = q.tiers.map((t) =>
    `${c.bold(t.id.padEnd(9))} ${t.name.padEnd(13)} ${usd(t.price_per_hour_micros).padStart(7)}/h  ${c.dim(`${usd(t.price_per_month_micros)}/month`)}` +
    `${t.min_minutes > 1 ? c.dim(` · ${t.min_minutes}-minute minimum`) : ""}\n` +
    `          ${c.dim(safeTerm(t.specs))}${t.good_for ? `\n          ${c.dim(safeTerm(t.good_for))}` : ""}`);
  if (!q.tiers.length) return c.dim("No machines are for rent right now.");
  return `${rows.join("\n")}\n${c.dim(egressText(q))}\n${c.dim(`Prepaid credit (${q.credit_blocks.map((b) => `$${b}`).join(" / ")}), used per minute; each machine needs its first hour covered to start. Credit is non-refundable and expires ${CREDIT_LIFETIME_DAYS} days after purchase. ${rentHint(q)}`)}`;
}

/** The example rent line: a tier the site has on sale (a CPU one when there is one), or why there is none. */
function rentHint(q: Quotes): string {
  if (q.available === false) return "Renting is not available right now.";
  const tier = q.tiers.find((t) => t.gpu === null) ?? q.tiers[0]!;
  return `Rent: walkie compute rent ${tier.id}=2`;
}

function rentalLine(r: RentalView): string {
  const state = r.state === "running" ? c.green(r.state) : r.state === "queued" ? c.yellow(`queued #${r.queue_position ?? "?"}`)
    : r.state === "ended" || r.state === "failed" ? c.dim(`${r.state}${r.end_reason ? ` (${r.end_reason})` : ""}`) : r.state;
  const since = r.started_at ? ` · since ${ago(r.started_at)}` : "";
  return `${c.bold(r.id)}  ${safeTerm(r.name).padEnd(20)} ${r.tier.padEnd(9)} ${state}  ${usd(r.price_per_hour_micros)}/h · used ${usd(r.spent_micros)}${c.dim(since)}`;
}

/** "$20.00 left of $50.00 · expires 2026-12-07 14:03 UTC (in 3 days)": a lot within 7 days is flagged (yellow). */
function lotLine(l: CreditLot, now: number): string {
  const line = `${usd(l.remaining_micros)} left of ${usd(l.purchased_micros)} · expires ${expiryText(l.expires_at)}`;
  return l.expiring_soon ? c.yellow(`${line} (${expiresInText(l.expires_at, now)})`) : line;
}

export function listText(s: LocalComputeState, now = Date.now()): string {
  if (s.account_id === null) return s.handover_pending_until
    ? `compute handover pending until ${new Date(s.handover_pending_until).toISOString()}`
    : c.dim("nothing rented yet — see prices: walkie compute quotes");
  const accounts = s.accounts && s.accounts.length > 1
    ? s.accounts.map(a => `${a.account_id}  balance ${usd(a.balance_micros)} · ${usd(a.burn_per_hour_micros)}/h`).join('\n') + '\n' : '';
  const active = s.rentals.filter((r) => r.state !== "ended" && r.state !== "failed");
  const head = active.length ? active.map(rentalLine).join("\n") : c.dim("no rented machines running or queued");
  const done = s.rentals.length - active.length;
  const alerts = (s.alerts ?? []).map((a) => `\n${c.yellow(COMPUTE_ALERT_TEXT[a])}`).join("");
  const soon = (s.credit_lots ?? []).filter((l) => l.expiring_soon)
    .map((l) => `\n${c.yellow(`${usd(l.remaining_micros)} of credit expires ${expiryText(l.expires_at)} (${expiresInText(l.expires_at, now)}): walkie compute credit`)}`).join("");
  return accounts + (done ? `${head}\n${c.dim(`${done} ended (walkie compute list --json for all)`)}` : head) + soon + alerts;
}

export function creditText(s: LocalComputeState, now = Date.now()): string {
  if (s.account_id === null) return s.handover_pending_until
    ? `compute handover pending until ${new Date(s.handover_pending_until).toISOString()}; credit purchases wait`
    : `balance ${usd(0)} — buy credit: walkie compute credit buy ${CREDIT_BLOCKS.join("|")}`;
  const frozen = s.status === "frozen" ? `\n${c.red("frozen: a payment was disputed or refunded; renting is off")}` : "";
  const burn = s.burn_per_hour_micros > 0
    ? `using ${usd(s.burn_per_hour_micros)}/h · ${s.hours_left === null ? "" : `${s.hours_left.toFixed(1)} h left`}`
    : c.dim("nothing running");
  const lots = s.credit_lots ?? [];
  const listed = lots.length
    ? `\n${lots.map((l) => `  ${lotLine(l, now)}`).join("\n")}${s.next_expiry_at ? `\nsoonest expiry ${expiryText(s.next_expiry_at)}` : ""}` : "";
  return `balance ${c.bold(usd(s.balance_micros))} · ${burn}${frozen}${listed}\n${c.dim(CREDIT_TERMS)}`;
}

export function rentText(r: RentResult): string {
  const head = r.replay ? c.dim("(already done: the same request was sent before)\n") : "";
  return `${head}${r.started} started, ${r.queued} queued · balance ${usd(r.balance_micros)}\n${r.rentals.map(rentalLine).join("\n")}\n` +
    c.dim("They join the team as your machines with seats on (a few minutes); queued ones start as capacity frees. Stop one: walkie compute stop <id>");
}

function creditBlock(v: string | undefined): CreditBlock {
  const n = Number(v);
  if (!(CREDIT_BLOCKS as readonly number[]).includes(n)) throw new UsageError(`credit comes in blocks of ${CREDIT_BLOCKS.map((b) => `$${b}`).join(", ")}: walkie compute credit buy 50`);
  return n as CreditBlock;
}

function openForPerson(ctx: Ctx, url: string): void {
  if (ctx.json || ctx.forAgent || bool(ctx.args, "no-open") || ctx.agentMarker()) return;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (Bun.which(opener)) Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
}

/**
 * The Sqwakie site's retryable refusals, which the daemon passes on as "the Sqwakie site refused: <code>": what each
 * means for the person at the terminal (lane C round 14). The site's licence checks answer these while they wait or tidy.
 */
const RETRY_HINTS: Readonly<Record<string, string>> = {
  licence_record_pruning: "the Sqwakie site is clearing ended licences from this team's record; this is temporary: run the command again",
  licence_backfill_pending: "the Sqwakie site is still preparing rental compute for existing licences; this is temporary: run the command again later",
  license_verification_unavailable: "the Sqwakie site couldn't check this team's licence just now; this is temporary: run the command again in a minute",
  compute_state_unavailable: "the Sqwakie site's compute service is briefly unavailable; this is temporary: run the command again in a minute",
};

/** A site refusal with a retry hint keeps its code and status and gets the hint as its message. */
function withRetryHint(err: unknown): unknown {
  const hint = err instanceof WalkieError ? RETRY_HINTS[err.code] : undefined;
  return hint && err instanceof WalkieError ? new WalkieError(err.code, hint, err.status, err.details) : err;
}

export async function compute(ctx: Ctx): Promise<number> {
  try { return await computeCommand(ctx); }
  catch (err) { throw withRetryHint(err); }
}

async function computeCommand(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos[0] ?? "list";
  const print = (v: unknown, text: string) => ctx.out(ctx.json ? JSON.stringify(v) : text);
  switch (sub) {
    case 'handover': {
      if (ctx.args.pos[1] !== 'object' || ctx.args.pos[2]) throw new UsageError(USAGE);
      const result = await adminCtx(ctx, 'object to compute account handover').client().computeHandoverObject();
      print(result, 'compute handover objected; accounts remain held for operator review');
      return EXIT.ok;
    }
    case "quotes": case "quote": {
      const q = await ctx.client().computeQuotes();
      print(q, quotesText(q));
      return EXIT.ok;
    }
    case "list": {
      const s = await ctx.client().computeState();
      print({ rentals: s.rentals }, listText(s));
      return EXIT.ok;
    }
    case "credit": case "credits": {
      if (ctx.args.pos[1] === "buy") {
        const block = creditBlock(ctx.args.pos[2]);
        const r = await adminCtx(ctx, "open a compute credit checkout").client().computeCredit(block, str(ctx.args, 'account'));
        print(r, `pay $${block} of compute credit here (Stripe Checkout):\n  ${c.bold(r.url)}`);
        openForPerson(ctx, r.url);
        return EXIT.ok;
      }
      if (ctx.args.pos[1] !== undefined) throw new UsageError(USAGE);
      const s = await ctx.client().computeState();
      print({ balance_micros: s.balance_micros, burn_per_hour_micros: s.burn_per_hour_micros, hours_left: s.hours_left, status: s.status,
        ...(s.account_id !== null && s.credit_lots ? { credit_lots: s.credit_lots, next_expiry_at: s.next_expiry_at ?? null } : {}) }, creditText(s));
      return EXIT.ok;
    }
    case "rent": {
      let machines;
      try { machines = parseMachineAsks(ctx.args.pos.slice(1)); } catch (e) { throw new UsageError(`${(e as Error).message} (${USAGE})`); }
      const idle = int(ctx.args, "idle");
      if (idle !== undefined && (idle < IDLE_MINUTES_MIN || idle > IDLE_MINUTES_MAX)) throw new UsageError(`--idle must be ${IDLE_MINUTES_MIN}–${IDLE_MINUTES_MAX} minutes`);
      const count = machines.reduce((a, m) => a + m.count, 0);
      const client = await requireAdmin(ctx, `rent ${count} machine${count === 1 ? "" : "s"} (${machines.map((m) => `${m.tier}×${m.count}`).join(", ")}), paid from your compute credit`, "yes");
      const r = await client.computeRent({ machines, ...(idle !== undefined ? { idle_minutes: idle } : {}),
        ...(str(ctx.args, 'account') ? { account_id: str(ctx.args, 'account') } : {}) });
      print(r, rentText(r));
      return EXIT.ok;
    }
    case "stop": {
      const target = ctx.args.pos[1];
      if (!target || (target !== "all" && !/^r_[0-9a-f]{16}$/.test(target))) throw new UsageError("walkie compute stop <rental id from: walkie compute list> | all");
      const client = await requireAdmin(ctx, target === "all" ? "stop and wipe every rented machine" : `stop and wipe the rented machine ${target}`, "yes");
      const account_id = str(ctx.args, 'account');
      const r = await client.computeStop(target === "all" ? { all: true, ...(account_id ? { account_id } : {}) }
        : { rental_id: target, ...(account_id ? { account_id } : {}) });
      print(r, `stopped ${r.stopped} (their disks are wiped; unused credit stays on the account until it expires)`);
      return EXIT.ok;
    }
    default:
      throw new UsageError(`unknown: walkie compute ${sub} (${USAGE})`);
  }
}
