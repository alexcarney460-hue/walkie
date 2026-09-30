// Site-owned copy of the src/protocol/schemas.ts event envelope. Keep the fields,
// defaults, and Zod object behavior in sync; site/test/site-protocol-parity.test.ts
// compares both parsers on signed and malformed roster/message vectors.
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
const Handle = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/);
const NodeId = z.string().regex(/^[0-9a-f]{16}$/);
const AgentName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/);
const ChannelName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const EventId = z.string().regex(/^[0-9a-f]{16}:[1-9][0-9]*$/);
const KindSchema = z.enum([
  'team.create', 'team.member', 'team.node', 'channel.upsert', 'team.license',
  'team.authority', 'team.integration', 'msg.post', 'ask', 'answer',
  'agent.status', 'artifact.share',
]);
const Author = z.object({ handle: Handle, node: NodeId, agent: AgentName.optional() });
export const UnsignedEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  team: z.string().regex(/^[0-9a-f]{16}$/),
  id: EventId,
  origin: NodeId,
  seq: z.number().int().positive(),
  ts: z.number().int(),
  author: Author,
  kind: KindSchema,
  channel: ChannelName.optional(),
  body: z.record(z.unknown()),
  hsig: z.string().max(200).optional(),
});
export type UnsignedEvent = z.infer<typeof UnsignedEvent>;
export const Event = UnsignedEvent.extend({ sig: z.string() });
export type Event = z.infer<typeof Event>;
export interface EventHeader {
  v: number; team: string; id: string; origin: string; seq: number; ts: number; kind: string; channel?: string;
}
