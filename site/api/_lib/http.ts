// Response helpers for the billing functions. Every JSON body is `{error: code}` on failure and is
// never cached; nothing here ever echoes an env value.

const NO_STORE = { "Cache-Control": "no-store" };

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE },
  });
}

export function fail(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...extra }, status);
}

export function redirect(url: string, status = 303): Response {
  return new Response(null, { status, headers: { Location: url, ...NO_STORE } });
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
}

export function wantsHtml(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("text/html");
}

/** The site origin for redirects: SITE_URL when set, else the request's own origin. */
export function siteOrigin(req: Request, siteUrl: string | undefined): string {
  if (siteUrl) return siteUrl.replace(/\/+$/, "");
  return new URL(req.url).origin;
}

/** Logs an error without request data or secrets (Stripe errors carry only type/code/status). */
export function logError(where: string, err: unknown): void {
  const e = err as { type?: unknown; code?: unknown; statusCode?: unknown; name?: unknown };
  const detail = { type: e?.type ?? e?.name ?? "error", code: e?.code ?? null, status: e?.statusCode ?? null };
  process.stderr.write(`billing ${where} failed: ${JSON.stringify(detail)}\n`);
}

export function isHttpStatus(err: unknown, status: number): boolean {
  return (err as { statusCode?: unknown } | null)?.statusCode === status;
}
