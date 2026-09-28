// post / get / reply / subscribe
import type { Event } from "../../protocol/schemas.ts";
import { eventForModel, eventJson } from "../agent-output.ts";
import { bool, channelArg, int, need, str, UsageError } from "../args.ts";
import { EXIT, readStdin, type Ctx } from "../context.ts";
import { c, eventLine, hostMap, safeTerm, type HostMap } from "../format.ts";
import { OutputClosed } from "../stdio.ts";

/** One event as this reader should see it: the §6 wrapper for a model, the usual line for a person. */
function line(ctx: Ctx, ev: Event, hosts: HostMap): string {
  if (ctx.json) return JSON.stringify(ctx.forAgent ? eventJson(ev) : ev);
  return ctx.forAgent ? eventForModel(ev, hosts) : eventLine(ev, hosts);
}

async function textArg(ctx: Ctx, i: number): Promise<string> {
  const rest = ctx.args.pos.slice(i);
  if (rest.length === 0) throw new UsageError("missing text");
  if (rest.length === 1 && rest[0] === "-") return readStdin();
  return rest.join(" ");
}

export async function post(ctx: Ctx): Promise<number> {
  const channel = channelArg(need(ctx.args, 0, "channel"));
  const text = await textArg(ctx, 1);
  const res = await ctx.client().post({ channel, text, thread: str(ctx.args, "thread"), raw: bool(ctx.args, "raw") || undefined });
  const redactions = res.redactions ?? [];
  if (ctx.json) ctx.out(JSON.stringify(res));
  else ctx.out(`${c.green("posted")} ${res.event.id} to #${channel}${redactions.length ? c.yellow(`  (redacted: ${redactions.join(", ")})`) : ""}`);
  return EXIT.ok;
}

export async function get(ctx: Ctx): Promise<number> {
  const client = ctx.client();
  const chanArg = ctx.args.pos[0];
  const q = {
    channel: chanArg ? channelArg(chanArg) : undefined,
    thread: str(ctx.args, "thread"),
    kinds: str(ctx.args, "kinds") ?? "msg.post,artifact.share,ask,answer",
    limit: int(ctx.args, "limit", 30),
  };
  const { events } = await client.events(q);
  if (ctx.json) { ctx.out(JSON.stringify({ events: ctx.forAgent ? events.map(eventJson) : events })); return EXIT.ok; }
  if (!events.length) { ctx.out(c.dim("no messages")); return EXIT.ok; }
  const hosts = hostMap(await client.team().catch(() => null));
  for (const ev of [...events].reverse()) ctx.out(line(ctx, ev, hosts));
  return EXIT.ok;
}

export async function reply(ctx: Ctx): Promise<number> {
  const id = need(ctx.args, 0, "event id");
  const text = await textArg(ctx, 1);
  const client = ctx.client();
  const { event } = await client.event(id);
  if (event.kind === "ask") {
    const res = await client.answer({ ask: event.id, text });
    ctx.out(ctx.json ? JSON.stringify(res) : `${c.green("answered")} ${event.id} → ${res.event.id}`);
    return EXIT.ok;
  }
  const b = event.body as { thread?: string };
  const root = b.thread ?? event.id;
  if (!event.channel) throw new UsageError(`event ${id} has no channel to reply in`);
  const res = await client.post({ channel: event.channel, text, thread: root });
  ctx.out(ctx.json ? JSON.stringify(res) : `${c.green("replied")} ${res.event.id} in #${event.channel} (thread ${root})`);
  return EXIT.ok;
}

export async function subscribe(ctx: Ctx): Promise<number> {
  const channels = ctx.args.pos.map(channelArg);
  const client = ctx.client();
  let hosts = hostMap(await client.team().catch(() => null));
  const ac = new AbortController();
  process.on("SIGINT", () => { ac.abort(); process.exit(0); });
  let backoff = 500;
  for (;;) {
    try {
      for await (const msg of client.stream(channels.length ? channels : undefined, ac.signal)) {
        backoff = 500;
        if (msg.type !== "event") {
          if (msg.type === "nodes") hosts = new Map(msg.nodes.map((n) => [n.node_id, n.hostname]));
          continue;
        }
        const ev: Event = msg.event;
        if (ev.kind === "agent.status" && !bool(ctx.args, "status")) continue;
        const text = line(ctx, ev, hosts);
        if (ctx.outStream) await ctx.outStream(text); else ctx.out(text);
      }
    } catch (err) {
      // The reader went away (`walkie subscribe | head -n 1`): the subscription ends (fix round 1, Codex 9).
      if (err instanceof OutputClosed) { ac.abort(); return EXIT.ok; }
      if (ac.signal.aborted) return EXIT.ok;
      if (bool(ctx.args, "once")) throw err;
      ctx.err(c.dim(`stream lost (${safeTerm((err as Error).message)}); reconnecting`));
    }
    if (bool(ctx.args, "once")) return EXIT.ok;
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 10_000);
  }
}
