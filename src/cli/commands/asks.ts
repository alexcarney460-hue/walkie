// ask / inbox / answer
import type { AskView, Event } from "../../protocol/schemas.ts";
import { askViewJson, eventForModel } from "../agent-output.ts";
import { bool, channelArg, int, need, str, UsageError } from "../args.ts";
import { EXIT, readStdin, type Ctx } from "../context.ts";
import { ago, c, hostMap, safeTerm, who, type HostMap } from "../format.ts";

/** An answer's text as this reader should see it (FINAL Codex 5). */
function answerText(ctx: Ctx, a: Event, hosts: HostMap): string {
  return ctx.forAgent ? eventForModel(a, hosts) : safeTerm(String((a.body as { text?: string }).text ?? ""));
}

export async function ask(ctx: Ctx): Promise<number> {
  const to = need(ctx.args, 0, "address (@handle[/machine[/agent]])");
  if (!to.startsWith("@")) throw new UsageError("address must start with @, e.g. @kira");
  const rest = ctx.args.pos.slice(1);
  const text = rest.length === 1 && rest[0] === "-" ? await readStdin() : rest.join(" ");
  if (!text) throw new UsageError("missing question text");
  const timeout = int(ctx.args, "timeout", 300) as number;
  if (timeout < 1) throw new UsageError("--timeout must be >= 1");
  const chan = str(ctx.args, "channel");
  const client = ctx.client();
  const { event } = await client.ask({ to, text, timeout_s: timeout, channel: chan ? channelArg(chan) : undefined });
  if (!ctx.json) ctx.err(c.dim(`asked ${to} (${event.id}); waiting up to ${timeout}s…`));
  const view = await client.awaitAnswer(event.id, timeout);
  if (ctx.json) ctx.out(JSON.stringify(ctx.forAgent ? askViewJson(view) : view));
  const hosts = ctx.forAgent && !ctx.json ? hostMap(await client.team().catch(() => null)) : new Map<string, string>();
  if (view.state === "answered") {
    if (!ctx.json) for (const a of view.answers.filter((x) => !(x.body as { declined?: boolean }).declined)) ctx.out(answerText(ctx, a, hosts));
    return EXIT.ok;
  }
  if (!ctx.json) {
    const first = view.answers[0];
    if (view.state === "declined" && first) ctx.err(c.red(`declined: ${answerText(ctx, first, hosts)}`));
    else if (view.state === "declined") ctx.err(c.red("declined"));
    else ctx.err(c.yellow(`no answer within ${timeout}s`));
  }
  return EXIT.timeout;
}

function askLine(v: AskView, hosts: Map<string, string>, forAgent: boolean): string {
  const b = v.ask.body as { to: string; text: string; expires_at: number };
  const state = v.state === "open" ? c.yellow("open") : v.state === "answered" ? c.green("answered") : c.dim(v.state);
  const expires = v.expires_at ?? b.expires_at;
  const head = `${c.dim(v.ask.id)}  ${state}  ${c.bold(who(v.ask, hosts))} → ${b.to}`;
  if (forAgent) return `${head}  ${c.dim(`expires in ${ago(Date.now() - (expires - Date.now()))}`)}\n${eventForModel(v.ask, hosts)}`;
  return `${head}  ${safeTerm(b.text)}  ${c.dim(`expires in ${ago(Date.now() - (expires - Date.now()))}`)}`;
}

export async function inbox(ctx: Ctx): Promise<number> {
  const client = ctx.client();
  const { asks } = await client.asks({ state: bool(ctx.args, "all") ? undefined : "open", to: "me" });
  if (ctx.json) { ctx.out(JSON.stringify({ asks: ctx.forAgent ? asks.map(askViewJson) : asks })); return EXIT.ok; }
  if (!asks.length) { ctx.out(c.dim("inbox empty")); return EXIT.ok; }
  const hosts = hostMap(await client.team().catch(() => null));
  for (const v of asks) ctx.out(askLine(v, hosts, ctx.forAgent));
  return EXIT.ok;
}

export async function answer(ctx: Ctx): Promise<number> {
  const id = need(ctx.args, 0, "ask id");
  const rest = ctx.args.pos.slice(1);
  const text = rest.length === 1 && rest[0] === "-" ? await readStdin() : rest.join(" ");
  const declined = bool(ctx.args, "decline");
  if (!text && !declined) throw new UsageError("missing answer text");
  const res = await ctx.client().answer({ ask: id, text: text || "declined", declined: declined || undefined });
  ctx.out(ctx.json ? JSON.stringify(res) : `${declined ? c.yellow("declined") : c.green("answered")} ${id} → ${res.event.id}`);
  return EXIT.ok;
}
