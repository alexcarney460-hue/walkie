// `walkie team link …` (FLEET-LINK-1): one link that adds all of a business's machines.
//   walkie team link [--for @h] [--uses N | --unlimited] [--expires 7d|30d] [--approve] [--observer] [--owner-machines] [--json]
//   walkie team link list [--json]
//   walkie team link revoke <id>
// Minting and revoking are a person's (a confirmed terminal, like team add-machine); the daemon refuses agents too.
import type { FleetLinkMinted, FleetLinkView, FleetLinksView } from "../../protocol/fleet-link.ts";
import { FLEET_LINK_DEFAULT_DAYS, FLEET_LINK_DEFAULT_USES, FLEET_LINK_MAX_USES } from "../../protocol/fleet-link.ts";
import { bool, need, str, UsageError } from "../args.ts";
import { EXIT, requirePerson, type Ctx } from "../context.ts";
import { ago, c, pad, safeTerm } from "../format.ts";

/** "7d", "30d", "7" → days (1–30). */
export function expiresDays(v: string | undefined): number {
  if (v === undefined) return FLEET_LINK_DEFAULT_DAYS;
  const m = /^(\d{1,2})d?$/.exec(v.trim().toLowerCase());
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 30) throw new UsageError("--expires takes a number of days from 1d to 30d (e.g. 7d, 30d)");
  return n;
}

function usesArg(ctx: Ctx): number {
  const unlimited = bool(ctx.args, "unlimited");
  const raw = str(ctx.args, "uses");
  if (unlimited && raw !== undefined) throw new UsageError("--uses and --unlimited are exclusive");
  if (unlimited) return 0;
  if (raw === undefined) return FLEET_LINK_DEFAULT_USES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > FLEET_LINK_MAX_USES) throw new UsageError(`--uses takes 1 to ${FLEET_LINK_MAX_USES} (or --unlimited)`);
  return n;
}

function usesText(l: Pick<FleetLinkView, "uses" | "used" | "pending">): string {
  const taken = l.used + l.pending;
  return l.uses === 0 ? `${l.used} joined · no link limit` : `${l.used} joined · ${Math.max(0, l.uses - taken)} of ${l.uses} left`;
}

function daysLeft(ms: number): string {
  const d = Math.max(0, Math.round((ms - Date.now()) / 86_400_000));
  return d === 1 ? "1 day" : `${d} days`;
}

export async function teamLink(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos[1];
  if (sub === "list") return linkList(ctx);
  if (sub === "revoke") return linkRevoke(ctx);
  if (sub !== undefined) throw new UsageError(`unknown team link subcommand: ${sub} (list | revoke <id>, or no subcommand to make one)`);
  return linkMint(ctx);
}

async function linkMint(ctx: Ctx): Promise<number> {
  const target = str(ctx.args, "for")?.replace(/^@/, "");
  const uses = usesArg(ctx);
  const days = expiresDays(str(ctx.args, "expires"));
  const approve = bool(ctx.args, "approve");
  const observer = bool(ctx.args, "observer");
  const ownerMachines = bool(ctx.args, "owner-machines");
  const client = ctx.client();
  const whose = target ?? (await client.me()).handle ?? "you";
  await requirePerson(ctx, `make a link that adds ${uses === 0 ? "machines (no link limit; plan and machine limits still apply)" : `up to ${uses} machines`} as @${whose}'s`, whose);
  const res = await client.mintLink({ ...(target ? { for: target } : {}), uses, expires_days: days, approve, ...(observer ? { observer: true } : {}), ...(ownerMachines ? { owner_machines: true } : {}) });
  if (ctx.json) { ctx.out(JSON.stringify(res)); return EXIT.ok; }
  ctx.out(mintedText(res));
  return EXIT.ok;
}

export function mintedText(res: FleetLinkMinted): string {
  // E21b r2: a link with no use limit still admits machines only within the plan's machine limit and the node limits.
  const n = res.uses === 0 ? "no link limit (plan and machine limits still apply); machines" : `up to ${res.uses} machines`;
  return `${c.green("fleet link")} ${res.short} · ${n} join as @${res.handle}'s (${res.role}) · expires in ${daysLeft(res.expires_at)}` +
    `${res.approve ? " · each waits for an owner's approval" : ""}\n\n` +
    (res.role === "owner" ? "Owner-level access: these machines can mint links, remove members, move authority and read restricted channels.\n\n" : "") +
    `open this link on each machine (it shows the command to run):\n  ${c.bold(res.link)}\n\n` +
    `or run this on each machine (macOS, Linux):\n  ${c.bold(res.command)}\n` +
    `Windows (PowerShell, WSL2):\n  ${c.bold(res.windows_command)}\n` +
    `already installed there: ${c.bold("walkie join <the link>")}\n\n` +
    c.yellow(`anyone with this link can add machines as @${res.handle}'s until it's used up, expires or is revoked: `) +
    c.yellow(`walkie team link revoke ${res.short}`);
}

async function linkList(ctx: Ctx): Promise<number> {
  const view = await ctx.client().links();
  if (ctx.json) { ctx.out(JSON.stringify(view)); return EXIT.ok; }
  ctx.out(listText(view));
  return EXIT.ok;
}

export function listText(view: FleetLinksView, now = Date.now()): string {
  if (!view.links.length) return c.dim(`no fleet links (kept on the roster authority, ${safeTerm(view.authority)}); make one: walkie team link`);
  const lines = [c.dim(`fleet links (kept on the roster authority, ${safeTerm(view.authority)})`)];
  for (const l of view.links) {
    const state = l.state === "active" ? c.green("active") : l.state === "used_up" ? c.yellow("used up") : c.gray(l.state === "dead" ? `can't be used (${(l.reason ?? "").replace(/^link_/, "").replace(/_/g, " ")})` : l.state);
    const expiry = l.state === "active" ? `expires in ${daysLeft(l.expires_at)}` : l.revoked_at ? `revoked ${ago(l.revoked_at, now)} ago` : "";
    lines.push(`${pad(l.short, 9)} @${pad(l.handle, 14)} ${pad(state, 12)} ${usesText(l)}${l.pending ? ` · ${l.pending} waiting for approval` : ""}${expiry ? c.dim(` · ${expiry}`) : ""}${c.dim(` · by @${l.created_by}`)}`);
    for (const u of view.uses.filter((x) => x.link === l.id).slice(0, 20)) {
      lines.push(c.dim(`           ${pad(safeTerm(u.hostname), 22)} ${u.state}${u.reason ? ` (${safeTerm(u.reason).replace(/^link_/, "")})` : ""} · ${ago(u.at, now)} ago`));
    }
  }
  return lines.join("\n");
}

async function linkRevoke(ctx: Ctx): Promise<number> {
  const id = need(ctx.args, 2, "fleet link id (walkie team link list)").toLowerCase();
  if (!/^[0-9a-f]{6,32}$/.test(id)) throw new UsageError("a fleet link id is 6 to 32 hex characters (walkie team link list)");
  await requirePerson(ctx, `revoke the fleet link ${id}`, id);
  const res = await ctx.client().revokeLink(id);
  if (ctx.json) { ctx.out(JSON.stringify(res)); return EXIT.ok; }
  ctx.out(`${c.green("revoked")} fleet link ${res.link.short} — no more machines can join with it (${res.link.used} it admitted stay; revoke one with walkie team revoke <machine>)`);
  return EXIT.ok;
}
