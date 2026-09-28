// walkie accounts [--json]: the team's provider accounts (Claude, Codex, Kimi, Grok) and how much usage each has
// left, pooled across every machine (ACCOUNTS-1 phase 1, watch-only; no token is ever part of the answer).
import {
  absTime, AVAILABLE_UNCONFIRMED, clockAvailability, clockRows, clockText, displayState, initials, leftPct, mainWindows, meterLevel,
  PROVIDER_NAME, reasonText, reloginStep, resetText, usageUntil, windowLabel, windowResetAt,
} from "../../protocol/accounts-format.ts";
import type { AccountView, AccountWindow } from "../../protocol/accounts.ts";
import { accountForModel, accountViewForModel, accountViewJson, ACCOUNTS_NOTE } from "../agent-output.ts";
import { EXIT, type Ctx } from "../context.ts";
import { UsageError } from "../args.ts";
import { vaultCommand } from "./vault.ts";
import { c, pad, safeTerm } from "../format.ts";

/** An account for a model: the agent-output contract (agent-output.ts accountViewJson). */
export const accountJson = accountViewJson;

const LEVEL_COLOR = { green: c.green, amber: c.yellow, red: c.red } as const;

function bar(a: AccountView, w: AccountWindow | undefined, now: number, tz?: string): string {
  if (!w) return c.dim(pad("n/a", 24));
  const left = leftPct(w);
  const cells = Math.round(left / 10);
  const paint = LEVEL_COLOR[meterLevel(left)];
  const at = windowResetAt(a.clock, w);
  const r = resetText(at, now);
  const when = at !== null && at > now ? ` (${absTime(at, now, tz)})` : "";
  return `${paint("█".repeat(cells))}${c.dim("░".repeat(10 - cells))} ${pad(paint(`${left}%`), 4)}${r ? c.dim(` ${r.replace("resets in ", "↻ ")}${when}`) : ""}`;
}

/**
 * RESET-CLOCK-1: the remembered reset times, counting down with no reading needed ("5-hour  resets in 2h 14m (3:10
 * PM)"), and whether the account should be usable again. Shown when there is no current reading to show them.
 */
function clockLines(a: AccountView, now: number, tz?: string): string[] {
  const avail = clockAvailability(a.clock, a.usage, now);
  const lines: string[] = [];
  if (avail.kind === "available_unconfirmed") lines.push(`  ${c.green(AVAILABLE_UNCONFIRMED)} ${c.dim(`— the limit reset at ${absTime(avail.since, now, tz)}; no reading since`)}`);
  if (avail.kind === "exhausted") lines.push(`  ${c.red("limit reached")} ${c.dim(`(last known) · ${avail.until !== null ? `${resetText(avail.until, now)} (${absTime(avail.until, now, tz)})` : "reset time not reported"}`)}`);
  for (const r of clockRows(a.clock, now)) {
    const when = r.resetsAt !== null ? ` (${absTime(r.resetsAt, now, tz)})` : "";
    lines.push(`  ${pad(safeTerm(r.label), 18)} ${c.dim(`${clockText(r, now)}${when}`)}`);
  }
  return lines;
}

export function renderAccounts(list: AccountView[], now = Date.now(), tz?: string): string {
  if (!list.length) {
    return `No accounts recorded yet. They appear once a Claude Code, Codex, Kimi or Grok session runs on a teammate's machine\n${c.dim("(discovery must be on: \"discover_agents\" and \"accounts\" in ~/.walkie/config.json).")}`;
  }
  const lines: string[] = [];
  for (const a of list) {
    const st = displayState(a.usage, now);
    const ws = mainWindows(a.usage);
    const where = a.machines.map((m) => `${m.handle}/${m.hostname}${m.agents.length ? ` (${m.agents.length})` : ""}`).join(", ");
    const head = `${c.bold(PROVIDER_NAME[a.provider] ?? a.provider)} ${safeTerm(a.label)}${a.plan ? c.dim(` · ${safeTerm(a.plan)}`) : ""}  ${c.dim(`[${a.owners.map(initials).join(",")}] ${safeTerm(where)}`)}`;
    lines.push(head);
    const leases = a.leases ?? [];
    if (a.vault || leases.length) {
      const pol = a.vault ? `switchable (${a.vault.policy}${a.vault.share_with?.length ? ` with ${a.vault.share_with.join(", ")}` : ""})` : "";
      const who = leases.length ? `${leases.length} session${leases.length === 1 ? "" : "s"}: ${leases.slice(0, 4).map((l) => `${l.handle}/${l.hostname}${l.agent ? ` ${l.agent}` : ""}`).join(", ")}` : "";
      lines.push(`  ${c.dim(safeTerm([pol, who].filter(Boolean).join(" · ")))}`);
    }
    if (a.claimed_by?.length) lines.push(`  ${c.dim(`also reported by ${safeTerm(a.claimed_by.join(", "))} (unverified, listed separately)`)}`);
    if (st === "relogin") {
      const host = a.machines[0]?.hostname ?? "that machine";
      lines.push(`  ${c.red("needs re-login")} — ${reloginStep(a.provider, safeTerm(host))}`);
      continue;
    }
    if (st === "unknown") {
      lines.push(`  ${c.dim(`usage unknown — ${reasonText(a.usage?.reason ?? null)}`)}`);
      lines.push(...clockLines(a, now, tz));
      continue;
    }
    const until = usageUntil(a.usage);
    const exhausted = st === "exhausted" ? `  ${c.red("exhausted")}${c.dim(until !== null ? ` · ${resetText(until, now)} (${absTime(until, now, tz)})` : " · reset time not reported")}` : "";
    if (exhausted) lines.push(exhausted);
    else if (clockAvailability(a.clock, a.usage, now).kind === "available_unconfirmed") lines.push(clockLines(a, now, tz)[0] as string);
    const rows: Array<[string, AccountWindow | undefined]> = [["5-hour", ws.session], ["Weekly", ws.weekly], ...ws.model.map((w) => [windowLabel(w), w] as [string, AccountWindow])];
    for (const [label, w] of rows) if (w || label !== "5-hour" || ws.weekly) lines.push(`  ${pad(safeTerm(label), 18)} ${bar(a, w, now, tz)}`);
    if (st === "stale" && a.usage) lines.push(`  ${c.yellow("stale")} ${c.dim(`— last reading ${Math.round((now - a.usage.at) / 60_000)} min ago${a.usage_host ? ` from ${safeTerm(a.usage_host)}` : ""}`)}`);
  }
  return lines.join("\n");
}

/** For a model: a note, then each account (validated, labels checked) wrapped as team-member text from its reporter. */
export function renderAccountsForModel(list: AccountView[], now = Date.now()): string {
  if (!list.length) return renderAccounts([], now);
  const blocks = list.map((a) => {
    const safe = accountViewForModel(a);
    return accountForModel(a, renderAccounts([safe], now));
  });
  return [`# ${ACCOUNTS_NOTE}`, ...blocks].join("\n");
}

export async function accounts(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos?.[0];
  if (sub && sub !== "list") {
    const r = await vaultCommand(ctx, sub);
    if (r !== null) return r;
    throw new UsageError(`unknown accounts command "${sub}" (add, remove, policy, vault, pick, exec, shims)`);
  }
  const { accounts: list } = await ctx.client().accounts();
  if (ctx.json) ctx.out(JSON.stringify(ctx.forAgent ? { accounts: list.map(accountViewJson), trust: "team-member", note: ACCOUNTS_NOTE } : { accounts: list }));
  else ctx.out(ctx.forAgent ? renderAccountsForModel(list) : renderAccounts(list));
  return EXIT.ok;
}
