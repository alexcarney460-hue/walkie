// A small, bounded client for the public Hugging Face Hub API. Plain GETs to one fixed origin, no token, no cookies, a
// fixed User-Agent, nothing about the team or its machines. Every request has a timeout, every body a byte cap, the
// whole refresh a request budget and a deadline; the Hub's `ratelimit` header is read and a refresh stops before it is
// cut off. The one redirect the Hub uses (`resolve/main/<file>` to a relative `/api/resolve-cache/...`) is followed by
// hand and only within the same origin. docs/plans/LOCAL-MODELS-HF-1.md "Source".
import type { z } from "zod";

export const HF_ORIGIN = "https://huggingface.co";
export const USER_AGENT = "walkie-pool-suggestions";

export type HfErrorKind = "offline" | "rate_limited" | "http" | "malformed" | "too_large" | "timeout" | "budget" | "redirect";

export class HfError extends Error {
  constructor(readonly kind: HfErrorKind, message: string) { super(message); }
}

export interface HfClientOptions {
  fetch?: typeof fetch;
  /** Per request. */
  timeoutMs?: number;
  /** Requests a refresh may make in all. */
  maxRequests?: number;
  /** When the whole refresh must be over (ms epoch). */
  deadline?: number;
  now?: () => number;
  /** Stop a bucket when the Hub says fewer than this many requests are left in its window. */
  lowWater?: number;
}

export const DEFAULTS = { timeoutMs: 15_000, maxRequests: 450, lowWater: 30 } as const;
/** Largest bodies: a list page, a record, a config or a card. */
export const MAX = { list: 4 << 20, record: 1 << 20, text: 256 << 10 } as const;

type Bucket = "api" | "resolvers";
const bucketOf = (path: string): Bucket => (path.includes("/resolve/") || path.includes("/resolve-cache/") ? "resolvers" : "api");

export class HfClient {
  requests = 0;
  /** Requests this refresh may still make. */
  get remaining(): number { return Math.max(0, this.maxRequests - this.requests); }
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRequests: number;
  private readonly deadline: number | null;
  private readonly now: () => number;
  private readonly lowWater: number;
  private readonly exhausted = new Set<Bucket>();

  constructor(opts: HfClientOptions = {}) {
    this.doFetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxRequests = opts.maxRequests ?? DEFAULTS.maxRequests;
    this.deadline = opts.deadline ?? null;
    this.now = opts.now ?? Date.now;
    this.lowWater = opts.lowWater ?? DEFAULTS.lowWater;
  }

  /** A JSON document validated by `schema`; null when the Hub says it is not there or needs a login (401, 403, 404). */
  async json<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, max: number = MAX.record): Promise<T | null> {
    const text = await this.get(path, "application/json", max);
    if (text === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new HfError("malformed", `${path}: not JSON`); }
    const r = schema.safeParse(parsed);
    if (!r.success) throw new HfError("malformed", `${path}: ${r.error.issues[0]?.message ?? "unexpected shape"}`);
    return r.data;
  }

  /** Plain text (a config or a card), at most `max` bytes; null when it is not there or needs a login. */
  async text(path: string, max: number = MAX.text): Promise<string | null> {
    return this.get(path, "text/plain, application/json", max);
  }

  private async get(path: string, accept: string, max: number): Promise<string | null> {
    let url = new URL(path, HF_ORIGIN);
    for (let hop = 0; hop < 3; hop++) {
      const res = await this.once(url, accept);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!loc) throw new HfError("redirect", `${url.pathname}: a redirect with no target`);
        const next = new URL(loc, url);
        if (next.origin !== HF_ORIGIN) throw new HfError("redirect", `${url.pathname}: redirect to another origin refused`);
        url = next;
        continue;
      }
      if (res.status === 429) { await res.body?.cancel().catch(() => undefined); throw new HfError("rate_limited", "Hugging Face is rate limiting this machine"); }
      if (res.status === 401 || res.status === 403 || res.status === 404) { await res.body?.cancel().catch(() => undefined); return null; }
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new HfError("http", `${url.pathname}: HTTP ${res.status}`); }
      return readCapped(res, max, url.pathname);
    }
    throw new HfError("redirect", `${path}: too many redirects`);
  }

  private async once(url: URL, accept: string): Promise<Response> {
    const bucket = bucketOf(url.pathname);
    if (this.exhausted.has(bucket)) throw new HfError("rate_limited", "Hugging Face's request window for this machine is nearly used up");
    if (this.requests >= this.maxRequests) throw new HfError("budget", `more than ${this.maxRequests} requests`);
    const left = this.deadline === null ? Infinity : this.deadline - this.now();
    if (left <= 0) throw new HfError("timeout", "took too long");
    this.requests++;
    let res: Response;
    try {
      res = await this.doFetch(url.href, {
        method: "GET", redirect: "manual", credentials: "omit",
        headers: { accept, "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, left)),
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") throw new HfError("timeout", `${url.pathname}: no answer in time`);
      throw new HfError("offline", `Hugging Face could not be reached (${(err as Error).message || "network error"})`);
    }
    // `ratelimit: "api";r=498;t=88`: requests left in the window; stop the bucket before it runs out.
    const m = /;r=(\d+)/.exec(res.headers.get("ratelimit") ?? "");
    if (m && Number(m[1]) < this.lowWater) this.exhausted.add(bucket);
    return res;
  }
}

async function readCapped(res: Response, max: number, where: string): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel().catch(() => undefined); throw new HfError("too_large", `${where}: ${declared} bytes`); }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => undefined); throw new HfError("too_large", `${where}: more than ${max} bytes`); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

/**
 * `fn` over `items`, at most `limit` at a time, results in order. A fatal error (a rate limit, the budget, offline)
 * stops picking up new items and is thrown once the ones in flight are done; `fn` handles every other error itself.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let fatal: unknown = null;
  const worker = async (): Promise<void> => {
    while (fatal === null && next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]!, i); } catch (err) { fatal ??= err; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (fatal !== null) throw fatal;
  return out;
}

/** Errors that end a refresh: the rest are about one item and only skip it. */
export const isFatal = (err: unknown): boolean => err instanceof HfError && ["offline", "rate_limited", "budget", "timeout"].includes(err.kind);
