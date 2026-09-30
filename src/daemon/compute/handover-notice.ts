import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { VENDOR_PUBLIC_KEY_B64 } from '../../license/vendor-key.ts';

const Notice = z.object({
  v: z.literal(1), team: z.string().regex(/^[0-9a-f]{16}$/), proposed_by: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  old_chain: z.string().regex(/^[0-9a-f]{64}$/), proposed_chain: z.string().regex(/^[0-9a-f]{64}$/),
  accounts: z.array(z.string().regex(/^ca_[0-9a-f]{16}$/)).max(1000),
  proposed_at: z.number().int(), completes_at: z.number().int().nullable(), objected: z.boolean(),
}).strict();
export type HandoverNotice = z.infer<typeof Notice>;

export function verifyHandoverNotice(value: string, team: string, publicKey = VENDOR_PUBLIC_KEY_B64): HandoverNotice | null {
  const parts = value.split('.');
  if (parts.length !== 2 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  const [payload, signature] = parts as [string, string];
  const raw = Buffer.from(payload, 'base64url'), sig = Buffer.from(signature, 'base64url');
  if (raw.toString('base64url') !== payload || sig.toString('base64url') !== signature || sig.length !== 64) return null;
  try {
    const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'base64').toString('base64url') } });
    if (!verify(null, Buffer.from(payload), key, sig)) return null;
    const parsed = Notice.safeParse(JSON.parse(raw.toString('utf8')));
    return parsed.success && parsed.data.team === team &&
      (parsed.data.completes_at === null || parsed.data.completes_at >= parsed.data.proposed_at + 86_400_000)
      ? parsed.data : null;
  } catch { return null; }
}

export function handoverNoticeText(n: HandoverNotice): string {
  return `Compute handover pending: ${n.proposed_by} proposes control of ${n.accounts.join(', ')}. ` +
    `${n.completes_at === null ? `A 24-hour objection window starts when another owner acknowledges this notice. Unacknowledged proposal expires ${new Date(n.proposed_at + 72 * 3_600_000).toISOString()}.` :
      `Completes ${new Date(n.completes_at).toISOString()} unless a current owner objects.`} ` +
    `Object: walkie compute handover object. Proposal ${n.proposed_chain}.`;
}
