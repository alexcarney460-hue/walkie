// The allow-list proxy in front of a served model's llama-server (POOL-REAL-1). llama-server listens on 127.0.0.1
// with its own API key that never leaves this daemon; this proxy (also 127.0.0.1 only) is what the machine's person
// and every connected member reach (members through their Walkie tunnel). It lets through only the OpenAI-compatible
// calls a client needs, each with a per-client bearer key the serving daemon minted:
//   GET /health, GET /v1/models, POST /v1/chat/completions, POST /v1/completions
// Everything else of llama-server (/slots with other clients' prompts, /props, /metrics, LoRA, tokenizer, infill,
// the web UI) answers 404 here. Bodies are capped (MAX_BODY), each key has at most MAX_ACTIVE requests in flight,
// and the key is swapped for llama-server's own before forwarding. Responses stream through (server-sent events).

/** Method + path pairs forwarded to llama-server. */
export const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["GET", "/health"], ["GET", "/v1/models"], ["POST", "/v1/chat/completions"], ["POST", "/v1/completions"],
];
/** Largest request body forwarded (an 8K-token conversation is well under 1 MiB of JSON). */
export const MAX_BODY = 4 * 1024 * 1024;
/** Requests one key may have in flight at once (llama-server runs one slot and queues the rest). */
export const MAX_ACTIVE = 4;
/** Bun.serve's idle timeout is per connection without bytes: a long non-streamed answer needs the maximum. */
const IDLE_TIMEOUT_S = 255;

export interface ProxyDeps {
  /** llama-server's loopback port and its API key. */
  upstream: () => { port: number; key: string } | null;
  /** The client a bearer key belongs to (a label for logs and counts), or null for an unknown key. */
  authorize: (key: string) => string | null;
  /** Called for each forwarded request, with the client's label. */
  onRequest?: (label: string) => void;
}

function err(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "Content-Type": "application/json" } });
}

/** A body past MAX_BODY is still read (and dropped) up to this much, so the connection stays usable for the next request. */
const DRAIN_MAX = 32 * 1024 * 1024;

/**
 * The body, or null when it is larger than `max` bytes. A too-large body is read to its end and dropped (up to
 * DRAIN_MAX): answering before the client finished sending left its bytes on a kept-alive connection, where the next
 * request was misread (431).
 */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > DRAIN_MAX) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    if (size <= max) chunks.push(value);
  }
  return size > max ? null : new Uint8Array(Buffer.concat(chunks));
}

export class ServeProxy {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly active = new Map<string, number>();
  constructor(private readonly d: ProxyDeps) {}

  get port(): number { return this.server?.port ?? 0; }

  start(): number {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: IDLE_TIMEOUT_S, fetch: (req) => this.handle(req) });
    return this.server.port ?? 0;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private release(key: string): void {
    const n = (this.active.get(key) ?? 1) - 1;
    if (n <= 0) this.active.delete(key); else this.active.set(key, n);
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!ALLOWED.some(([m, p]) => m === req.method && p === url.pathname)) return err(404, "not_found", "not available through Walkie");
    const m = /^Bearer ([0-9a-f]{48})$/.exec(req.headers.get("authorization") ?? "");
    const label = m ? this.d.authorize(m[1]!) : null;
    if (!m || !label) return err(401, "unauthorized", "a Walkie connection key is required (the key file walkie pool status names)");
    const key = m[1]!;
    const up = this.d.upstream();
    if (!up) return err(503, "not_ready", "the model is not serving yet");
    if ((this.active.get(key) ?? 0) >= MAX_ACTIVE) return err(429, "too_many_requests", `at most ${MAX_ACTIVE} requests at once per connection`);
    // The slot is taken BEFORE the body is read (POOL-REAL-1 p8-6): slow uploads count against the cap too, and every
    // way out below (too large, a broken body, an upstream error, the client leaving) gives it back.
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    let body: Uint8Array | null = null;
    try {
      body = req.method === "POST" ? await readCapped(req, MAX_BODY) : null;
    } catch {
      this.release(key);
      return err(400, "bad_body", "the request body could not be read");
    }
    if (req.method === "POST" && body === null) {
      this.release(key);
      return err(413, "too_large", `request bodies are limited to ${MAX_BODY / 1024 / 1024} MiB`);
    }
    this.d.onRequest?.(label);
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${up.port}${url.pathname}`, {
        method: req.method,
        headers: { Authorization: `Bearer ${up.key}`, "Content-Type": "application/json", Accept: req.headers.get("accept") ?? "*/*" },
        body: body && body.byteLength ? (body as unknown as BodyInit) : undefined,
        signal: req.signal,
      });
    } catch (e) {
      this.release(key);
      return err(502, "upstream_failed", `llama-server did not answer (${(e as Error).message.slice(0, 120)})`);
    }
    const headers = new Headers();
    for (const h of ["content-type", "cache-control"]) { const v = res.headers.get(h); if (v) headers.set(h, v); }
    if (!res.body) { this.release(key); return new Response(null, { status: res.status, headers }); }
    // The slot is given back when the answer ends, or when the client goes away mid-stream.
    let released = false;
    const done = (): void => { if (!released) { released = true; this.release(key); } };
    const reader = res.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        try {
          const { done: end, value } = await reader.read();
          if (end) { done(); ctl.close(); return; }
          ctl.enqueue(value);
        } catch (e) { done(); ctl.error(e); }
      },
      cancel(reason) { done(); void reader.cancel(reason).catch(() => undefined); },
    });
    return new Response(stream, { status: res.status, headers });
  }
}
