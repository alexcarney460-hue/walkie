// walkie compute — rent machines for your team's agents (RENT-2, docs/plans/RENT-1.md): prepaid credit used per minute,
// five tiers, any number of machines in any mix; what doesn't fit our capacity yet is queued and starts on its own.
// Every line shows PRICES (never a cost). Renting and stopping are admin commands: a person confirms at the terminal
// (or passes --yes); an agent goes ahead while agent admin is on, audited in #general.
import { requireAdmin, adminCtx } from "../admin-gate.ts";
import { bool, int, str, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { ago, c, safeTerm } from "../format.ts";
import {
  CREDIT_BLOCKS, IDLE_MINUTES_MAX, IDLE_MINUTES_MIN, parseMachineAsks, usd, type CreditBlock, type LocalComputeState,
  type Quotes, type RentalView, type RentResult,
} from "../../protocol/compute.ts";

const USAGE = "walkie compute quotes | rent <tier>[=count] … [--idle <minutes>] [--yes] | list | stop <id|all> [--yes] | credit [buy 50|200|1000] | handover object";

/** "Each machine includes 1,024 GiB of outbound data, then $0.02 per GiB." */
export function egressText(q: Quotes): string {
  return `Each machine includes ${q.egress_included_gib.toLocaleString("en-US")} GiB of outbound data, then ${usd(q.egress_price_per_gib_micros)} per GiB.`;
}

export function quotesText(q: Quotes): string {
  const rows = q.tiers.map((t) =>
    `${c.bold(t.id.padEnd(9))} ${t.name.padEnd(13)} ${usd(t.price_per_hour_micros).padStart(7)}/h  ${c.dim(`${usd(t.price_per_month_micros)}/month`)}` +
    `${t.min_minutes > 1 ? c.dim(` · ${t.min_minutes}-minute minimum`) : ""}\n` +
    `          ${c.dim(safeTerm(t.specs))}${t.good_for ? `\n          ${c.dim(safeTerm(t.good_for))}` : ""}`);
  return `${rows.join("\n")}\n${c.dim(egressText(q))}\n${c.dim(`Prepaid credit (${q.credit_blocks.map((b) => `$${b}`).join(" / ")}), used per minute; each machine needs its first hour covered to start. Rent: walkie compute rent agent=2 gpu-20`)}`;
}

function rentalLine(r: RentalView): string {
  const state = r.state === "running" ? c.green(r.state) : r.state === "queued" ? c.yellow(`queued #${r.queue_position ?? "?"}`)
    : r.state === "ended" || r.state === "failed" ? c.dim(`${r.state}${r.end_reason ? ` (${r.end_reason})` : ""}`) : r.state;
  const since = r.started_at ? ` · since ${ago(r.started_at)}` : "";
  return `${c.bold(r.id)}  ${safeTerm(r.name).padEnd(20)} ${r.tier.padEnd(9)} ${state}  ${usd(r.price_per_hour_micros)}/h · used ${usd(r.spent_micros)}${c.dim(since)}`;
}

export function listText(s: LocalComputeState): string {
  if (s.account_id === null) return s.handover_pending_until
    ? `compute handover pending until ${new Date(s.handover_pending_until).toISOString()}`
    : c.dim("nothing rented yet — see prices: walkie compute quotes");
  const accounts = s.accounts && s.accounts.length > 1
    ? s.accounts.map(a => `${a.account_id}  balance ${usd(a.balance_micros)} · ${usd(a.burn_per_hour_micros)}/h`).join('\n') + '\n' : '';
  const active = s.rentals.filter((r) => r.state !== "ended" && r.state !== "failed");
  const head = active.length ? active.map(rentalLine).join("\n") : c.dim("no rented machines running or queued");
  const done = s.rentals.length - active.length;
  return accounts + (done ? `${head}\n${c.dim(`${done} ended (walkie compute list --json for all)`)}` : head);
}

export function creditText(s: LocalComputeState): string {
  if (s.account_id === null) return s.handover_pending_until
    ? `compute handover pending until ${new Date(s.handover_pending_until).toISOString()}; credit purchases wait`
    : `balance ${usd(0)} — buy credit: walkie compute credit buy ${CREDIT_BLOCKS.join("|")}`;
  const frozen = s.status === "frozen" ? `\n${c.red("frozen: a payment was disputed or refunded; renting is off")}` : "";
  const burn = s.burn_per_hour_micros > 0
    ? `using ${usd(s.burn_per_hour_micros)}/h · ${s.hours_left === null ? "" : `${s.hours_left.toFixed(1)} h left`}`
    : c.dim("nothing running");
  return `balance ${c.bold(usd(s.balance_micros))} · ${burn}${frozen}`;
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

export async function compute(ctx: Ctx): Promise<number> {
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
      print({ balance_micros: s.balance_micros, burn_per_hour_micros: s.burn_per_hour_micros, hours_left: s.hours_left, status: s.status }, creditText(s));
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
      print(r, `stopped ${r.stopped} (their disks are wiped; unused credit stays on the account)`);
      return EXIT.ok;
    }
    default:
      throw new UsageError(`unknown: walkie compute ${sub} (${USAGE})`);
  }
}
