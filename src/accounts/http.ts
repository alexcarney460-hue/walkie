// The only network path of the usage poller. A fixed allow-list of exact URLs (the usage endpoints and Kimi's /me):
// anything else, a token or refresh endpoint in particular, is refused before a request is made. GET only, no
// redirects, 15 s timeout, 256 KB response cap. Errors carry FIXED codes only ("HTTP 429", "usage request failed
// (TimeoutError)"): never a response body or an exception's text, which could echo a token (ACCOUNTS-FIX-1, Codex 2).
import { scrubMessage } from "../integrations/scrub.ts";
import { VERSION } from "../daemon/version.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const USAGE_URLS = {
  claude: "https://api.anthropic.com/api/oauth/usage",
  codex: "https://chatgpt.com/backend-api/wham/usage",
  kimi: "https://api.kimi.com/coding/v1/usages",
  kimiMe: "https://api.kimi.com/coding/v1/me",
} as const;
const ALLOWED: ReadonlySet<string> = new Set(Object.values(USAGE_URLS));

export const USAGE_TIMEOUT_MS = 15_000;
export const USAGE_MAX_BYTES = 256 * 1024;
export const USER_AGENT = `walkie/${VERSION} (usage meter)`;

/** The longest a Retry-After header can hold polling off. */
export const MAX_RETRY_AFTER_MS = 6 * 3_600_000;

export class UsageHttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs: number | null = null) { super(message); }
}

/** An exception's class name if it is a plain identifier (never its message), else "Error". */
export function errorName(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  return /^[A-Za-z]{1,40}$/.test(name) ? name : "Error";
}

/** Retry-After as seconds or an HTTP date → ms from now, capped at MAX_RETRY_AFTER_MS; null when absent or invalid. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  const v = value?.trim() ?? "";
  if (!v) return null;
  if (/^[0-9]{1,10}$/.test(v)) return Math.min(MAX_RETRY_AFTER_MS, Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, t - now)) : null;
}

/** Whether a URL may be requested by the poller (exact match; tests assert every call against this). */
export function isAllowedUsageUrl(url: string): boolean {
  return ALLOWED.has(url);
}

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new UsageHttpError(res.status, "usage response too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new UsageHttpError(res.status, "usage response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** GET one allow-listed URL and parse JSON. Errors are fixed codes; `secret` is scrubbed from them as a last guard. */
export async function getUsageJson(fetchFn: FetchLike, url: string, headers: Record<string, string>, secret: string, timeoutMs = USAGE_TIMEOUT_MS): Promise<unknown> {
  if (!isAllowedUsageUrl(url)) throw new UsageHttpError(0, "refused: not a usage endpoint");
  const fail = (status: number, code: string, retry: number | null = null) => new UsageHttpError(status, scrubMessage(code, [secret], 120), retry);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers },
    });
  } catch (err) {
    throw fail(0, `usage request failed (${errorName(err)})`);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw fail(res.status, "usage endpoint redirected (refused)");
  }
  // Taken when the answer ARRIVES (Codex r3 LOW 2): a refusal's Retry-After holds even if its body can't be read.
  const retry = res.ok ? null : retryAfterMs(res.headers.get("retry-after"));
  let text: string;
  try {
    text = await readCapped(res, USAGE_MAX_BYTES);
  } catch (err) {
    if (err instanceof UsageHttpError) throw new UsageHttpError(err.status, err.message, retry);
    throw fail(res.status, `usage response read failed (${errorName(err)})`, retry);
  }
  if (!res.ok) throw fail(res.status, `HTTP ${res.status}`, retry);
  try {
    return JSON.parse(text);
  } catch {
    throw fail(res.status, "usage response is not JSON");
  }
}
