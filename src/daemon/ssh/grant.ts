import { z } from "zod";
import { canonicalJson } from "../../protocol/canonical.ts";
import { verifySig, type NodeKeys } from "../keys.ts";
import { ownerKeyLine } from "./authorized-keys.ts";

export const OwnerSshGrant = z.object({
  team_id: z.string().regex(/^[0-9a-f]{16}$/), owner_node: z.string().regex(/^[0-9a-f]{16}$/),
  owner_handle: z.string().min(1).max(80), recipient: z.string().min(1).max(80), invite_id: z.string().regex(/^[0-9a-f]{32}$/),
  public_key: z.string().min(1).max(300), expires_at: z.number().int().positive(),
  signature: z.string().min(1).max(128),
}).strict();
export type OwnerSshGrant = z.infer<typeof OwnerSshGrant>;

function signed(g: Omit<OwnerSshGrant, "signature">): string {
  return `walkie-owner-ssh-v1\n${canonicalJson(g)}`;
}

export function mintOwnerSshGrant(keys: NodeKeys, fields: Omit<OwnerSshGrant, "signature" | "owner_node">): OwnerSshGrant {
  ownerKeyLine(fields.team_id, fields.owner_handle, fields.public_key);
  const body = { ...fields, owner_node: keys.nodeId };
  return OwnerSshGrant.parse({ ...body, signature: keys.sign(signed(body)) });
}

export function verifyOwnerSshGrant(value: unknown, pubkey: string, now: number): OwnerSshGrant {
  const parsed = OwnerSshGrant.parse(value);
  ownerKeyLine(parsed.team_id, parsed.owner_handle, parsed.public_key);
  const { signature, ...body } = parsed;
  if (now >= parsed.expires_at || !verifySig(pubkey, signed(body), signature)) throw new Error("owner SSH grant signature or expiry is invalid");
  return parsed;
}

export function encodeOwnerSshGrant(g: OwnerSshGrant): string { return Buffer.from(JSON.stringify(g)).toString("base64url"); }
export function decodeOwnerSshGrant(encoded: string): OwnerSshGrant {
  if (!/^[A-Za-z0-9_-]{1,1200}$/.test(encoded)) throw new Error("invalid owner SSH grant encoding");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) throw new Error("invalid owner SSH grant encoding");
  return OwnerSshGrant.parse(JSON.parse(bytes.toString("utf8")) as unknown);
}
