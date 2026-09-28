// Human output: ANSI colors only on a TTY with NO_COLOR unset; event/age formatting.
import type { Event, TeamView } from "../protocol/schemas.ts";

export const color = process.stdout.isTTY === true && !process.env.NO_COLOR;

function wrap(code: string): (s: string) => string {
  return (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
}
export const c = {
  dim: wrap("2"), bold: wrap("1"), red: wrap("31"), green: wrap("32"), yellow: wrap("33"),
  blue: wrap("34"), magenta: wrap("35"), cyan: wrap("36"), gray: wrap("90"),
};

export function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** Strips control characters so remote text can't drive the terminal. */
export function safeTerm(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "").replace(/[‪-‮⁦-⁩]/g, "");
}

export type HostMap = ReadonlyMap<string, string>;

export function hostMap(team: TeamView | null): Map<string, string> {
  return new Map((team?.nodes ?? []).map((n) => [n.node_id, n.hostname]));
}

export function who(ev: Event, hosts: HostMap): string {
  return "@" + [ev.author.handle, hosts.get(ev.author.node), ev.author.agent].filter(Boolean).join("/");
}

/** `14:02 #build @kira/kiras-mbp/ux  text` */
export function eventLine(ev: Event, hosts: HostMap): string {
  const b = ev.body as Record<string, unknown>;
  const chan = ev.channel ? c.cyan(`#${ev.channel}`) + " " : "";
  const head = `${c.gray(hhmm(ev.ts))} ${chan}${c.bold(who(ev, hosts))}`;
  let text: string;
  switch (ev.kind) {
    case "msg.post": text = String(b.text ?? ""); break;
    case "ask": text = `${c.yellow("ask")} → ${String(b.to)}: ${String(b.text ?? "")}  ${c.dim(`(${ev.id})`)}`; break;
    case "answer": text = `${b.declined ? c.red("declined") : c.green("answer")} ${c.dim(`re ${String(b.ask)}`)}: ${String(b.text ?? "")}`; break;
    case "artifact.share": text = `${c.magenta("shared")} ${String(b.name)} (${String(b.size)} B) ${c.dim(String(b.hash).slice(0, 12))}${b.note ? ` — ${String(b.note)}` : ""}`; break;
    case "agent.status": text = `${c.dim("status")} ${String(b.agent)} ${String(b.state)}${b.title ? ` — ${String(b.title)}` : ""}`; break;
    default: text = c.dim(ev.kind);
  }
  const indent = (b.thread as string | undefined) ? c.dim("  ↳ ") : "  ";
  return `${head}${indent}${safeTerm(text)}`;
}

export function pad(s: string, n: number): string {
  // Pads by visible width (ANSI codes excluded).
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + " ".repeat(Math.max(0, n - visible));
}
