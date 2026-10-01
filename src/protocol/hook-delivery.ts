// Which hook event a status report came from, so the daemon can apply one event once when it reaches it twice (the
// same Grok event through two hooks: src/daemon/hook-dedupe.ts). An unsigned field of the local `POST /v1/status`
// request, like `provenance`: never signed and never replicated, so peers and the wire format do not change, and a
// daemon from before it ignores the field.
import { z } from "zod";

export const HookDelivery = z.object({
  /** The runtime's session id. */
  session: z.string().min(1).max(80),
  /** The runtime's own name for the event ("PostToolUse", "StopFailure"). */
  event: z.string().min(1).max(40),
  /**
   * When the runtime dispatched the event, as it wrote it. Grok's guide says only that the timestamp is stamped when the
   * hook dispatches (10-hooks.md); the daemon assumes every hook of one event is given the same value.
   */
  at: z.string().min(1).max(64),
  /** The tool call and the turn it belongs to, when the runtime names them: told apart events of one instant. */
  call: z.string().min(1).max(200).optional(),
  turn: z.string().min(1).max(160).optional(),
  /**
   * What tells two events of one name and one instant apart when the runtime names neither a call nor a turn: a
   * notification's type (idle_prompt, permission_prompt). As long as a notification type may be (80).
   */
  kind: z.string().min(1).max(80).optional(),
});
export type HookDelivery = z.infer<typeof HookDelivery>;

/** The identity a request carries; anything malformed is no identity (the report is applied as it always was). */
export function parseHookDelivery(v: unknown): HookDelivery | undefined {
  const parsed = HookDelivery.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

/** Two deliveries are the same event when every part matches, for the same agent. */
export function hookDeliveryKey(agent: string, d: HookDelivery): string {
  return JSON.stringify([agent, d.session, d.event, d.at, d.call ?? null, d.turn ?? null, d.kind ?? null]);
}
