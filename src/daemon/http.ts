// Shared HTTP helpers: typed error envelope, JSON responses, body reading with caps.
import type { ZodType, ZodTypeDef } from "zod";

export class HttpError extends Error {
  /** `details` are extra fields of the error object (e.g. a 402 `plan_limit`'s limit/used/upgrade_url). */
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function errorResponse(err: unknown, log?: { error(m: string, f?: Record<string, unknown>): void }): Response {
  if (err instanceof HttpError) return json({ error: { ...err.details, code: err.code, message: err.message } }, err.status);
  log?.error("internal_error", { err: err instanceof Error ? `${err.name}: ${err.message}` : String(err), stack: err instanceof Error ? err.stack : undefined });
  return json({ error: { code: "internal", message: "internal error" } }, 500);
}

/** Reads the request body as bytes, enforcing a byte cap regardless of Content-Length honesty. */
export async function readBytes(req: Request, maxBytes: number, deadlineMs?: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "too_large", `body exceeds ${maxBytes} bytes`);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  let timedOut = false;
  const timer = deadlineMs === undefined ? null : setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, deadlineMs);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (timedOut) throw new HttpError(408, "read_timeout", "request body deadline exceeded");
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new HttpError(413, "too_large", `body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const bytes = await readBytes(req, maxBytes);
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "invalid", "body is not valid JSON");
  }
}

export function parseWith<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) {
    const msg = res.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new HttpError(400, "invalid", msg);
  }
  return res.data;
}

/** Normalizes IPv4-mapped IPv6 ("::ffff:1.2.3.4") to plain IPv4. */
export function normalizeIp(ip: string | undefined | null): string {
  if (!ip) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}
