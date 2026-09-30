import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../protocol/canonical.ts";
import { ScheduleTask } from "../../protocol/talkie-schedule.ts";
import { ScheduleManagement, type ScheduleManagement as Management } from "../../protocol/talkie-management.ts";
import type { Core } from "../core.ts";
import { HttpError } from "../http.ts";
import { verifySig } from "../keys.ts";
import { nodeMember } from "../roster.ts";

const Agent = { agent: z.string().min(1).max(80).optional() };
const Input = z.object({ name: z.string().trim().min(1).max(80), cron: z.string().min(1).max(100), task: ScheduleTask }).strict();
const Body = z.union([
  z.object({ input: Input, ...Agent }).strict(),
  z.object({ id: z.string().uuid(), input: Input.partial().extend({ enabled: z.boolean().optional() }), ...Agent }).strict(),
  z.object({ id: z.string().uuid(), ...Agent }).strict(),
]);
export const SignedScheduleManagement = z.object({
  op: z.enum(["add", "edit", "remove", "reset"]), body: Body, audit_id: z.string().uuid(),
  requester: z.string().min(1).max(80), ts: z.number().int().nonnegative().safe(),
  target: z.string().min(1), term: z.number().int().nonnegative().safe(),
  sig: z.string().min(40).max(128),
}).strict();
export type SignedScheduleManagement = z.infer<typeof SignedScheduleManagement>;

export const SignedSchedulePeer = z.object({ body: z.unknown(), requester: z.string().min(1),
  ts: z.number().int().nonnegative().safe(), target: z.string().min(1),
  term: z.number().int().nonnegative().safe(), sig: z.string().min(40).max(128) }).strict();
export type SignedSchedulePeer = z.infer<typeof SignedSchedulePeer>;
export type SchedulePeerRoute = "lease" | "schedule-claim" | "schedule-progress" | "schedule-defaults" | "schedule-manage";

function signedPart(team: string, route: SchedulePeerRoute, body: unknown,
  request: Omit<SignedSchedulePeer, "body" | "sig">): string {
  const digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return canonicalJson({ team, route, digest, requester: request.requester, ts: request.ts,
    target: request.target, term: request.term });
}

export function signSchedulePeer(core: Core, route: SchedulePeerRoute, body: unknown): SignedSchedulePeer {
  if (!core.authority) throw new HttpError(409, "not_authority", "schedule authority is unknown");
  const fields = { requester: core.nodeId, ts: Date.now(), target: core.authority, term: core.authorityLeaseTerm };
  return { ...fields, body, sig: core.keys.sign(signedPart(core.teamId ?? "", route, body, fields)) };
}

export function verifySchedulePeer<T>(core: Core, nodeId: string, route: SchedulePeerRoute,
  wire: SignedSchedulePeer, schema: z.ZodType<T>): T {
  if (wire.requester !== nodeId) throw new HttpError(403, "forbidden", "requester is invalid");
  const offset = Date.now() - wire.ts;
  if (Math.abs(offset) > 120_000)
    throw new HttpError(403, "clock_skew", `schedule request clock offset ${offset} ms exceeds 120000 ms`);
  if (wire.target !== core.nodeId || wire.term !== core.authorityLeaseTerm || !core.isAuthority())
    throw new HttpError(409, "not_authority", "schedule request targets a different authority or term");
  const node = core.roster.nodes.get(nodeId);
  if (!node || !nodeMember(core.roster, nodeId)) throw new HttpError(403, "forbidden", "requesting node is not admitted");
  if (!verifySig(node.pubkey, signedPart(core.teamId ?? "", route, wire.body, wire), wire.sig))
    throw new HttpError(403, "forbidden", "bad schedule request signature");
  const parsed = schema.safeParse(wire.body);
  if (!parsed.success) throw new HttpError(400, "invalid", "schedule request body is invalid");
  return parsed.data;
}

export function signScheduleManagement(core: Core, request: Management): SignedScheduleManagement {
  if (request.op === "reset") throw new HttpError(403, "forbidden", "reset is available only on the authority machine");
  const { handle: _handle, machine: _machine, audit_id, op, ...body } = request;
  const signed = signSchedulePeer(core, "schedule-manage", { op, body, audit_id });
  return SignedScheduleManagement.parse({ op, body, audit_id, requester: signed.requester,
    ts: signed.ts, target: signed.target, term: signed.term, sig: signed.sig });
}

export function verifyScheduleManagement(core: Core, nodeId: string, wire: SignedScheduleManagement): Management {
  if (wire.op === "reset") throw new HttpError(403, "forbidden", "reset is available only on the authority machine");
  verifySchedulePeer(core, nodeId, "schedule-manage", { body: { op: wire.op, body: wire.body, audit_id: wire.audit_id },
    requester: wire.requester, ts: wire.ts, target: wire.target, term: wire.term, sig: wire.sig },
    z.object({ op: SignedScheduleManagement.shape.op, body: Body, audit_id: z.string().uuid() }).strict());
  const node = core.roster.nodes.get(nodeId);
  const member = nodeMember(core.roster, nodeId);
  if (!node || !member || member.role !== "owner") throw new HttpError(403, "forbidden", "requesting node is not an owner");
  const parsed = ScheduleManagement.safeParse({ op: wire.op, ...wire.body,
    audit_id: wire.audit_id, handle: member.handle, machine: node.hostname });
  if (!parsed.success) throw new HttpError(400, "invalid", "schedule request body is invalid");
  return parsed.data;
}
