// Random identifiers and bearer tokens for rental compute. Tokens are 32 random bytes, base64url (43 chars); only
// their sha256 is stored, compared in constant time.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const newToken = (): string => randomBytes(32).toString("base64url");
export const newAccountId = (): string => `ca_${randomBytes(8).toString("hex")}`;
export const newRentalId = (): string => `r_${randomBytes(8).toString("hex")}`;
export const shortSuffix = (): string => randomBytes(2).toString("hex");

export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenMatches(token: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(tokenHash(token), "hex"), Buffer.from(storedHash, "hex"));
}
