// Source-only turn-control wire contract. No native adapter or launch path is enabled here.
import { z } from "zod";
import { AgentName, EventId, Handle, NodeId } from "./schemas.ts";

export const SEATS_TURN_CONTROL_CAP = "seats_turn_control_v1";
export const SeatControlLaunch = z.object({ v: z.literal(1), adapter: z.literal("codex-app-server") }).strict();
const utf8 = new TextEncoder();
const Generation = z.string().regex(/^[0-9a-f]{32}$/);
const RuntimeId = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/);
export const SeatControlPrincipal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), node: NodeId, handle: Handle }).strict(),
  z.object({ kind: z.literal("agent"), node: NodeId, handle: Handle, agent: AgentName }).strict(),
]);
export type SeatControlPrincipal = z.infer<typeof SeatControlPrincipal>;
const Binding = {
  launch: EventId,
  principal: SeatControlPrincipal,
  target: NodeId,
  daemon_instance: Generation,
  boot_generation: Generation,
  seat_generation: Generation,
  adapter: z.literal("codex-app-server"),
  thread_id: RuntimeId,
  control_id: Generation,
};
const FollowUp = z.object({
  op: z.literal("control"), v: z.literal(1), ...Binding,
  action: z.literal("follow_up"),
  expected_turn_id: RuntimeId.optional(), expected_revision: z.number().int().nonnegative().optional(),
  text: z.string().min(1).refine((value) => utf8.encode(value).byteLength <= 8192, "8 KiB UTF-8 maximum"),
}).strict().refine((value) => (value.expected_turn_id === undefined) !== (value.expected_revision === undefined), "one target");
const Interrupt = z.object({
  op: z.literal("control"), v: z.literal(1), ...Binding,
  action: z.literal("interrupt"), expected_turn_id: RuntimeId,
}).strict();
export const SeatControlIntent = z.union([FollowUp, Interrupt]);
export type SeatControlIntent = z.infer<typeof SeatControlIntent>;

/** Canonical post text contains no follow-up text. Signed body binds the full intent. */
export function controlRequestText(intent: SeatControlIntent): string {
  return `Seat control ${intent.action} ${intent.control_id} for ${intent.launch}`;
}
export function parseControlPost(body: unknown): SeatControlIntent | null {
  if (!body || typeof body !== "object") return null;
  const post = body as Record<string, unknown>;
  if (Object.keys(post).sort().join(",") !== "seat,text,thread") return null;
  const parsed = SeatControlIntent.safeParse(post.seat);
  if (!parsed.success || post.thread !== parsed.data.launch || post.text !== controlRequestText(parsed.data)) return null;
  if (utf8.encode(JSON.stringify(body)).byteLength > 16 * 1024) return null;
  return parsed.data;
}

export interface ControlCapabilityEvidence { node: string; caps: readonly string[]; observed_mono_ms: number; authenticated: boolean }
export interface ControlCapabilitySnapshot { issued_mono_ms: number; readers: readonly string[]; evidence: readonly ControlCapabilityEvidence[]; history_compatible: boolean }
/** Caller supplies the current admitted non-revoked reader set, including offline nodes, on every check. */
export function controlCapabilityReady(snapshot: ControlCapabilitySnapshot, currentReaders: readonly string[], host: string, nowMonoMs: number): boolean {
  const snapshotAge = nowMonoMs - snapshot.issued_mono_ms;
  if (!snapshot.history_compatible || !Number.isFinite(snapshotAge) || snapshotAge < 0 || snapshotAge > 30_000) return false;
  const captured = [...new Set(snapshot.readers)].sort();
  const current = [...new Set(currentReaders)].sort();
  if (captured.length !== snapshot.readers.length || current.length !== currentReaders.length || JSON.stringify(captured) !== JSON.stringify(current)) return false;
  const required = new Set([...current, host]);
  if (snapshot.evidence.length !== required.size) return false;
  for (const item of snapshot.evidence) {
    if (!required.delete(item.node) || !item.authenticated || !item.caps.includes(SEATS_TURN_CONTROL_CAP)) return false;
    const age = nowMonoMs - item.observed_mono_ms;
    if (!Number.isFinite(age) || age < 0 || age > 30_000) return false;
  }
  return required.size === 0;
}

/** The authenticated event author, not a client claim, must equal the original full launch principal. */
export function sameControlPrincipal(original: SeatControlPrincipal, authenticated: SeatControlPrincipal): boolean {
  return original.kind === authenticated.kind && original.node === authenticated.node && original.handle === authenticated.handle
    && (original.kind === "person" || (authenticated.kind === "agent" && original.agent === authenticated.agent));
}

export const SeatControlOutcome = z.enum(["requested", "runtime_accepted", "interrupted_observed", "completed_before_interrupt", "rejected", "unknown"]);
export type SeatControlOutcome = z.infer<typeof SeatControlOutcome>;
export const SeatControlReceipt = z.object({
  op: z.literal("control_result"), v: z.literal(1), launch: EventId, control_id: Generation,
  boot_generation: Generation, seat_generation: Generation, revision: z.number().int().nonnegative(),
  outcome: SeatControlOutcome,
}).strict();
export type SeatControlReceipt = z.infer<typeof SeatControlReceipt>;
export function foldControlReceipt(current: SeatControlReceipt | undefined, next: SeatControlReceipt): SeatControlReceipt | undefined {
  if (current && (current.launch !== next.launch || current.control_id !== next.control_id || current.boot_generation !== next.boot_generation || current.seat_generation !== next.seat_generation)) return current;
  if (current && next.revision <= current.revision) return current;
  if (current && ["interrupted_observed", "completed_before_interrupt", "rejected", "unknown"].includes(current.outcome)) return current;
  if (current?.outcome === "runtime_accepted" && next.outcome === "requested") return current;
  return next;
}
export function controlReceiptView(receipt: SeatControlReceipt): Pick<SeatControlReceipt, "control_id" | "revision" | "outcome"> {
  return { control_id: receipt.control_id, revision: receipt.revision, outcome: receipt.outcome };
}
