// Request bodies of the license service (bind, renew): a JSON object of at most MAX_BODY_BYTES.
// Lives in _lib/: Vercel never serves underscore-prefixed paths as functions.
import { fail } from "./http.js";

export const MAX_BODY_BYTES = 8 * 1024;

export async function readJsonObject(req: Request): Promise<{ value: Record<string, unknown> } | { response: Response }> {
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return { response: fail(413, "too_large") };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { response: fail(400, "invalid_json") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { response: fail(400, "invalid_json") };
  return { value: parsed as Record<string, unknown> };
}
