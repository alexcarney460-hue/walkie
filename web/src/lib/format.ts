import type { AgentState, AgentView, AskBody, AskView, Event, MemberView, Runtime } from "../api/types.ts";
import { cloudAddress, isCloudAgent } from "../../../src/protocol/guest-cloud.ts";

export const RUNTIME_LABEL: Record<Runtime, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  kimi: "Kimi",
  cli: "CLI",
  other: "Agent",
};

export const STATE_LABEL: Record<AgentState, string> = {
  working: "Working",
  waiting: "Waiting on you",
  blocked: "Stuck",
  idle: "Idle",
  offline: "Offline",
};

/** Sort order: the states a human must act on come first. */
export const STATE_RANK: Record<AgentState, number> = { blocked: 0, waiting: 1, working: 2, idle: 3, offline: 4 };

export function needsAttention(state: AgentState): boolean {
  return state === "blocked" || state === "waiting";
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? "?";
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : parts[0]?.[1] ?? "";
  return (a + b).toUpperCase();
}

/** Stable, calm hue per handle, kept away from the state colors' hues. */
export function hueFor(handle: string): number {
  let h = 0;
  for (const ch of handle) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hues = [210, 250, 285, 320, 190, 40, 100, 230];
  return hues[h % hues.length] ?? 210;
}

/**
 * A machine's accent hue (UI-POLISH-2): stable per hostname, so a machine wears the same colour in the rail, Mission
 * Control, the Team table and its own page. Kept off the state hues (red 25, amber 72, green 150).
 */
export function machineHue(hostname: string): number {
  let h = 0x811c9dc5; // FNV-1a: spreads short, similar hostnames apart
  for (const ch of hostname) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  const hues = [196, 214, 234, 256, 278, 300, 322, 344, 178, 112];
  return hues[h % hues.length] ?? 232;
}

/** A card label's or project prefix's hue: the same text is the same colour on every board. */
export function tagHue(text: string): number {
  let h = 3;
  for (const ch of text.toLowerCase()) h = (h * 37 + ch.charCodeAt(0)) >>> 0;
  const hues = [196, 222, 248, 274, 300, 326, 352, 176, 118];
  return hues[h % hues.length] ?? 235;
}

export function displayName(members: MemberView[] | undefined, handle: string): string {
  return members?.find((m) => m.handle === handle)?.display_name || handle;
}

export function firstName(members: MemberView[] | undefined, handle: string): string {
  return displayName(members, handle).split(" ")[0] ?? handle;
}

export function agentAddress(a: Pick<AgentView, "handle" | "hostname" | "agent" | "status">): string {
  return isCloudAgent(a) ? cloudAddress(a) : `@${a.handle}/${a.hostname}/${a.agent}`;
}

/** Hostname for an author node id, if known. */
export function hostFor(nodes: { node_id: string; hostname: string }[] | undefined, nodeId: string): string | undefined {
  return nodes?.find((n) => n.node_id === nodeId)?.hostname;
}

export function askBody(e: Event): AskBody {
  return e.body as AskBody;
}

/** The daemon's clamped expiry (a peer's clock can't keep an ask open); the body's only for old daemons. */
export function askExpiresAt(v: AskView): number {
  return v.expires_at ?? askBody(v.ask).expires_at;
}

export function effectiveAskState(v: AskView, now: number): AskView["state"] {
  if (v.state === "open" && askExpiresAt(v) <= now) return "expired";
  return v.state;
}

/**
 * Can this viewer answer the ask from the dashboard? Addressed to them (their
 * handle, machine or agent), or to any agent whose ask policy routes to a human.
 */
export function canAnswer(v: AskView, me: string | null, agents: AgentView[], now: number): boolean {
  if (!me || effectiveAskState(v, now) !== "open") return false;
  const to = askBody(v.ask).to;
  const [handle, host, agent] = to.slice(1).split("/");
  if (handle === me) return true;
  if (!host || !agent) return false;
  const target = agents.find((a) => a.handle === handle && a.hostname === host && a.agent === agent);
  return target?.status.ask_policy === "human";
}

export function addressedToMe(v: AskView, me: string | null): boolean {
  return !!me && askBody(v.ask).to.slice(1).split("/")[0] === me;
}

export function mimeKind(mime: string, name: string): "code" | "text" | "data" | "image" | "archive" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (/json|csv|xml|yaml/.test(mime) || /\.(json|csv|ya?ml)$/.test(name)) return "data";
  if (/diff|patch|javascript|typescript/.test(mime) || /\.(patch|diff|ts|tsx|js|py|go|rs|sql)$/.test(name)) return "code";
  if (/zip|tar|gzip/.test(mime)) return "archive";
  if (mime.startsWith("text/")) return "text";
  return "file";
}
