// Routing Middleware, scoped to /install.sh only: counts installer fetches as a Vercel Web Analytics server
// event ("install_sh") and passes the request through untouched, so the served bytes never change.
// Sends what @vercel/analytics/server's track() sends (user agent and forwarded IP for Vercel's own
// country/bot handling); stores nothing itself.
export const config = { matcher: ["/install.sh"] };

interface Ctx { waitUntil(p: Promise<unknown>): void }

export default function middleware(request: Request, context: Ctx): Response | undefined {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const ua = request.headers.get("user-agent") ?? "";
    const client = /^curl\//i.test(ua) ? "curl" : /^wget\//i.test(ua) ? "wget" : /mozilla/i.test(ua) ? "browser" : "other";
    const body = JSON.stringify({ o: `${url.origin}${url.pathname}`, ts: Date.now(), sdkn: "@vercel/analytics/server", sdkv: "2.0.1", r: "", en: "install_sh", ed: { client } });
    const send = fetch(new URL("/_vercel/insights/event", url.origin), {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": ua, "x-vercel-ip": request.headers.get("x-forwarded-for") ?? "", "x-va-server": "1" },
      body,
    }).then((r) => r.text()).catch(() => undefined);
    context.waitUntil(send);
    console.log(JSON.stringify({ metric: "install_sh", client, country: request.headers.get("x-vercel-ip-country") ?? "" }));
  }
  return undefined; // continue to the static file
}
