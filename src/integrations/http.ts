// Outbound HTTP for connectors: timeouts, byte caps and GraphQL error handling. Every body read here
// is untrusted external data; callers validate shapes with zod.
import type { ZodType, ZodTypeDef } from "zod";
import { scrubDeep, scrubMessage, secretsOfAuth } from "./scrub.ts";
import type { FetchLike } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_JSON_BYTES = 8 * 1024 * 1024;

/** An external service failed. `message` is safe to show (never contains the request's key). */
export class ExternalError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

/** Reads at most `max` bytes of a response body; returns null when it is larger (the rest is not read). */
export async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) { await res.body?.cancel().catch(() => undefined); return null; }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export interface GraphqlOptions {
  fetch: FetchLike; url: string; auth: string; service: string;
  query: string; variables?: Record<string, unknown>; timeoutMs?: number;
  /** Every other credential the operation may have used (the connector's configured keys, keys rotated out). */
  secrets?: () => readonly (string | null | undefined)[];
}

/**
 * POSTs a GraphQL query and validates `data` with `schema`. HTTP errors, GraphQL `errors` (when no
 * usable data came back), oversize bodies and shape mismatches all become ExternalError. The parsed
 * data is scrubbed (the request's key, `secrets`, secret patterns) in every string field before it
 * is returned, so nothing downstream can cache, format or truncate a credential (#2/#3).
 */
export async function graphql<T>(o: GraphqlOptions, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  // Upstream text can echo the request (Authorization included): every message is scrubbed of the
  // key BEFORE it is truncated, so a cut can't leave part of the key behind.
  const known = [...secretsOfAuth(o.auth), ...(o.secrets?.() ?? [])];
  const fail = (message: string, status = 0) => new ExternalError(scrubMessage(message, known), status);
  let res: Response;
  try {
    res = await o.fetch(o.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: o.auth },
      body: JSON.stringify({ query: o.query, variables: o.variables ?? {} }),
      signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw fail(`${o.service}: ${timeout ? "request timed out" : "network error"}`);
  }
  const bytes = await readCapped(res, MAX_JSON_BYTES);
  if (!bytes) throw fail(`${o.service}: response larger than ${MAX_JSON_BYTES} bytes`, res.status);
  let body: { data?: unknown; errors?: { message?: unknown }[] };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body;
  } catch {
    throw fail(`${o.service}: HTTP ${res.status}, response is not JSON`, res.status);
  }
  const firstError = Array.isArray(body?.errors) && body.errors.length ? scrubMessage(String(body.errors[0]?.message ?? "error"), known, 200) : null;
  if (res.status === 401 || res.status === 403) throw fail(`${o.service}: HTTP ${res.status} (check the API key)`, res.status);
  if (!res.ok) throw fail(`${o.service}: HTTP ${res.status}${firstError ? `: ${firstError}` : ""}`, res.status);
  if (body?.data === null || body?.data === undefined) throw fail(`${o.service}: ${firstError ?? "no data in response"}`, res.status);
  const parsed = schema.safeParse(body.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw fail(`${o.service}: unexpected response shape (${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"})`, res.status);
  }
  return scrubDeep(parsed.data, known);
}
