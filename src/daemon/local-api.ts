// Local API transports: unix socket (0600, no token) and 127.0.0.1 loopback
// (token or dashboard session header + Host + Origin checks) which also serves the dashboard.
import type { Server } from "bun";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, lstatSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import type { Core } from "./core.ts";
import { DashboardSessions, type Session, type SessionOptions } from "./dashboard-sessions.ts";
import { ORCHESTRATOR_AGENT, ORCHESTRATOR_TOKEN_HEADER } from "../protocol/orchestrator.ts";
import { HttpError, errorResponse } from "./http.ts";
import { acquireInstanceLock, type InstanceLock } from "./instance-lock.ts";
import { dispatch, validAgentHeader, type RouteCtx } from "./local-routes.ts";
import { adminGate } from "./admin/gate.ts";
import { hostFor } from "./orchestrator/host.ts";
import type { TransportControl } from "./direct/link.ts";
import type { PeerClient } from "./peer-client.ts";
import type { PeerApiStatus } from "./peer-link.ts";
import type { SyncManager } from "./sync.ts";
import type { Integrations } from "../integrations/routes.ts";
import type { AccountsService } from "../accounts/service.ts";
import type { LicenseService } from "../license/service.ts";
import type { MobileManager } from "./mobile/manager.ts";
import type { ProjectsIndex } from "./projects/index.ts";
import { trackOp } from "./watchdog.ts";

export const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'";
const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
};

/** Dashboard files compiled into the binary by scripts/build.ts (absent in dev → serve web/dist). */
// @ts-ignore -- generated at build time; missing in dev (and then the catch serves web/dist)
const EMBEDDED: Record<string, string> | null = await import("./embedded.gen.ts")
  .then((m: { EMBEDDED: Record<string, string> }) => m.EMBEDDED)
  .catch(() => null);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

const PLACEHOLDER = `<!doctype html><html><head><meta charset="utf-8"><title>Walkie</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0b0d10;color:#e6e8eb;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:32rem;padding:2rem}code{background:#1a1e24;padding:.1em .35em;border-radius:4px}</style></head>
<body><main><h1>Walkie daemon is running</h1><p>The dashboard bundle is not built on this install.
The local API is up at <code>/v1/*</code>. Build it with <code>bun run web:build</code>.</p></main></body></html>`;

export interface LocalApiDeps {
  core: Core; sync: SyncManager; client: PeerClient; token: string; webDir: string;
  /** The current Tailscale identity error, if any (it clears when Tailscale comes up). */
  tailscaleError?: () => string | undefined;
  /** The peer API's state for `/v1/diag` (src/daemon/peer-link.ts). */
  peerApi?: () => PeerApiStatus;
  /** This daemon's own event-loop lag, distinct from another in-process test daemon. */
  localLag?: () => { max_ms: number; at: number } | null;
  /** Which transport this daemon runs; Walkie Direct's endpoint (src/daemon/direct/link.ts). */
  transport?: TransportControl;
  integrations?: Integrations;
  /** The vendor's license service (activation codes); absent → activation codes answer 503. */
  licenseService?: LicenseService;
  /** Writes a fresh local.token and returns it (`walkie token rotate`); absent → rotation answers 503. */
  rotateToken?: () => { token: string; path: string };
  /** Dashboard session timings (tests). */
  sessions?: SessionOptions;
  /** This machine's accounts service, for limit resets (null while accounts are off). */
  accounts?: () => AccountsService | null;
  /** Paired phones: pairing and the relay link (src/daemon/mobile/manager.ts); absent → `/v1/mobile` answers 404. */
  mobile?: MobileManager;
  /** The board index (WALKIE-PROJECTS-1). */
  projects?: ProjectsIndex;
}

function tokenEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The names of the cookies this request carries. */
function cookieNames(req: Request): Set<string> {
  const raw = req.headers.get("cookie");
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(";")) out.add(part.trim().split("=")[0] ?? "");
  return out;
}

/**
 * The header that carries a dashboard session (SEC-COOKIE-2). Never a cookie: browsers send 127.0.0.1 cookies to
 * every port, while the page keeps this value in its own origin's storage, which other ports can't read, and a
 * cross-origin page can't set a custom header without a CORS preflight this daemon never grants.
 */
export const SESSION_HEADER = "x-walkie-session";
/** Which token the saved dashboard sessions belong to: a short fingerprint (sha256), never the token itself. */
export function tokenGeneration(token: string): string {
  return createHash("sha256").update(`walkie-dashboard-sessions:${token}`).digest("hex").slice(0, 16);
}

/** The store meta key holding the dashboard sessions' hashes (dashboard-sessions.ts). */
export const SESSIONS_META = "dashboard_sessions";

/** Cookies earlier versions set: `walkie_token` (v0.1.3, the durable token) and `walkie_s_<port>` (SEC-COOKIE-1). */
function legacyCookies(port: number): string[] { return ["walkie_token", `walkie_s_${port}`]; }

/**
 * The routes a dashboard session may call: exactly what web/src/api/client.ts and its stream reader use.
 * Everything else on the loopback listener (authority transfer, join/init, member changes, diag, agent
 * status, uploads, …) needs the durable token as a bearer.
 */
const DASHBOARD_ROUTES: readonly (readonly [string, RegExp])[] = [
  ["GET", /^\/v1\/import\/linear\/status$/],
  ["POST", /^\/v1\/import\/linear\/(?:plan|run|resume|cancel|sync|settings)$/],
  ["GET", /^\/v1\/(?:me|team|agents|accounts|peers|events|asks|team\/pending|license|integrations|linear\/issues|stream|pool)$/],
  ["GET", /^\/v1\/events\/[^/]+$/],
  ["GET", /^\/v1\/artifacts\/[0-9a-f]{64}$/],
  // WALKIE-PROJECTS-1: projects, boards and cards (the dashboard is a person: every board action is open to it).
  ["GET", /^\/v1\/(?:projects|tasks)$/],
  ["GET", /^\/v1\/projects\/p-[0-9a-f]{8}(?:\/export)?$/],
  ["GET", /^\/v1\/tasks\/[^/]+$/],
  ["POST", /^\/v1\/(?:projects|tasks)$/],
  ["POST", /^\/v1\/projects\/p-[0-9a-f]{8}(?:\/boards(?:\/[0-9a-f]{16}(?::|%3[Aa])[0-9]+)?)?$/], // the board id's ":" arrives percent-encoded (encodeURIComponent)
  ["POST", /^\/v1\/tasks\/[^/]+(?:\/(?:comment|start|review|done|block|unblock))?$/],
  // DATA-ROOM-1: the project's Data Room tab and a card's files (list, upload, a file's history and bytes, rename / pin
  // / remove / attach). The upload is a room upload only (the project's channel), not the generic artifact upload.
  ["GET", /^\/v1\/projects\/p-[0-9a-f]{8}\/room(?:\/[^/]+(?:\/content)?)?$/],
  ["POST", /^\/v1\/projects\/p-[0-9a-f]{8}\/room(?:\/[^/]+)?$/],
  ["POST", /^\/v1\/(?:post|answer|team\/admit|team\/invite|team\/invite-code|team\/add-machine|channels|license)$/],
  ["POST", /^\/v1\/integrations\/[a-z]+(?:\/run)?$/],
  ["POST", /^\/v1\/accounts\/(?:reset|reset\/prepare|reset\/resolve|refresh)$/],
  ["DELETE", /^\/v1\/integrations\/[a-z]+$/],
  ["POST", /^\/v1\/pool\/(?:share|run|stop|serve|serve\/stop|connect|disconnect|install)$/], // WALKIE-POOL-2: the person at this machine's dashboard
  // The Seats view (PROTOCOL §11; Codex seats r9 MEDIUM 5): this machine's opt-in, launching and stopping seats, busy
  // and resume. Person-only like the rest (a dashboard session sends no agent header). Not the token or bundle
  // uploads: those are the CLI's.
  ["GET", /^\/v1\/seats(?:\/busy)?$/],
  ["POST", /^\/v1\/seats\/(?:config|run|stop|busy|resume)$/],
  // The Orchestrator tab (ORCH-FIX-11): this machine's host, its local conversation, sending and stopping a reply;
  // its Start and Stop buttons (PRE5-INT: start with the daemon's defaults only, orchestrator/routes.ts).
  ["GET", /^\/v1\/orchestrator(?:\/messages)?$/],
  ["GET", /^\/v1\/orchestrator\/schedules(?:\/next)?$/],
  ["POST", /^\/v1\/orchestrator\/schedules(?:\/[^/]+\/run-now)?$/],
  ["POST", /^\/v1\/orchestrator\/schedules\/[0-9a-f-]{36}\/reset$/],
  ["PATCH", /^\/v1\/orchestrator\/schedules\/[^/]+$/],
  ["DELETE", /^\/v1\/orchestrator\/schedules\/[^/]+$/],
  // ORCH-2: and its model picker (the chat header).
  ["POST", /^\/v1\/orchestrator\/(?:say|stop-reply|start|stop|model|access|auto)$/],
  // Team > Devices (WALKIE-PWA-1): pair a phone, list and revoke paired phones.
  ["GET", /^\/v1\/mobile$/],
  ["POST", /^\/v1\/mobile\/pair$/],
  ["DELETE", /^\/v1\/mobile\/devices\/[0-9a-f]{12}$/],
  // AGENT-ADMIN-1: the person's admin switches (the Seats view's "Agents set up Walkie" card) and the audit log.
  ["GET", /^\/v1\/admin$/],
  ["POST", /^\/v1\/admin\/switches$/],
  // RENT-2: "Add compute" (Machines, Mission Control): prices, the credit balance and rentals, renting, stopping and
  // a credit checkout link (the person pays in Stripe Checkout). Owner machines only (compute/routes.ts).
  ["GET", /^\/v1\/compute\/(?:quotes|state)$/],
  ["POST", /^\/v1\/compute\/(?:rent|stop|credit)$/],
];

export function dashboardRoute(method: string, path: string): boolean {
  return DASHBOARD_ROUTES.some(([m, re]) => m === method && re.test(path));
}

/** How a loopback `/v1` request authenticated; `signal` ends with the credential (logout, expiry, rotation). */
interface Credential { readonly session: Session | null; readonly signal: AbortSignal }
type TcpAuth = { early: Response } | { credential: Credential | null };

/** A dashboard login nonce lives this long and is exchanged once (FINAL Fable 5). */
export const AUTH_NONCE_TTL_MS = 60_000;
const AUTH_NONCE_MAX = 32;

export class LocalApi {
  private unixServer: Server<undefined> | null = null;
  private tcpServer: Server<undefined> | null = null;
  /** One-shot login nonces (minted over the unix socket only), by value → expiry. */
  private readonly nonces = new Map<string, number>();
  /** Dashboard sessions: the only thing the login cookie ever holds (never the durable token). */
  private readonly sessions: DashboardSessions;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private currentToken: string;
  /** Aborted when the token changes: requests the old token opened (streams) end with it. */
  private tokenGeneration = new AbortController();
  /** Held from before the socket is probed until stop (one daemon per socket path). */
  private lock: InstanceLock | null = null;
  /** The socket path this instance bound (removed on stop, before the lock is released). */
  private boundSocket: string | null = null;

  constructor(private readonly d: LocalApiDeps) {
    // Sessions' hashes are kept in the store's meta, so a daemon restart (an upgrade) doesn't sign dashboards out.
    const store = d.core.store as { getMeta?: (k: string) => string | null; setMeta?: (k: string, v: string) => void; deleteMeta?: (k: string) => void } | undefined;
    const persist = d.sessions?.persist ?? (store?.getMeta && store.setMeta && store.deleteMeta ? {
      load: () => store.getMeta!(SESSIONS_META),
      save: (v: string | null) => (v === null ? store.deleteMeta!(SESSIONS_META) : store.setMeta!(SESSIONS_META, v)),
    } : undefined);
    this.sessions = new DashboardSessions({ generation: tokenGeneration(d.token), ...d.sessions, ...(persist ? { persist } : {}) });
    this.currentToken = d.token;
  }

  get tcpPort(): number | null { return this.tcpServer?.port ?? null; }
  /** The durable local-API token (changes on `walkie token rotate`). */
  get token(): string { return this.currentToken; }

  /**
   * `walkie dashboard` asks for one of these over the unix socket (the caller already proved it is
   * this OS user) and opens `/auth?nonce=…`: the token itself never appears on a command line, in a
   * URL, in shell history or in the browser's history (FINAL Fable 5).
   */
  mintNonce(now = Date.now()): { nonce: string; expires_at: number } {
    for (const [n, exp] of this.nonces) if (exp <= now) this.nonces.delete(n);
    while (this.nonces.size >= AUTH_NONCE_MAX) this.nonces.delete(this.nonces.keys().next().value as string);
    const nonce = randomBytes(32).toString("hex");
    const expires_at = now + AUTH_NONCE_TTL_MS;
    this.nonces.set(nonce, expires_at);
    return { nonce, expires_at };
  }

  /** Consumes a nonce: true once for a live one, false for anything else. */
  private takeNonce(presented: string, now = Date.now()): boolean {
    let hit: string | null = null;
    for (const n of this.nonces.keys()) if (tokenEq(n, presented)) hit = n; // constant-time per entry; the map is tiny
    if (hit === null) return false;
    const exp = this.nonces.get(hit) ?? 0;
    this.nonces.delete(hit);
    return exp > now;
  }

  /**
   * Removes a stale socket file, and only that: the file is removed when connecting to it is refused
   * (nothing listens). If something accepts the connection, it is a live process: a healthy daemon →
   * "already listening"; one that doesn't answer in time (a busy machine) is still live, so startup refuses
   * rather than unlinking its socket and stranding it. Callers hold the instance lock (startUnix), so no
   * other daemon of this version can be binding the path meanwhile.
   */
  static async clearStaleSocket(path: string, probeMs = 500): Promise<void> {
    if (!existsSync(path)) return;
    const reach = await socketReach(path, probeMs);
    if (reach === "dead") { unlinkSync(path); return; }
    if (reach === "live") {
      let res: Response | null = null;
      try {
        res = await fetch("http://walkie/v1/healthz", { unix: path, signal: AbortSignal.timeout(probeMs) } as RequestInit);
      } catch { /* indeterminate: below */ }
      if (res?.ok) throw new Error(`another walkie daemon is already listening on ${path}`);
    }
    throw new Error(
      `a process is listening on ${path} but did not answer as a walkie daemon within ${probeMs} ms; not removing it. ` +
      "If no walkie daemon is running (walkie daemon status), remove the file and start again.",
    );
  }

  async startUnix(path: string): Promise<void> {
    // The lock comes first: two starters can't both find the socket stale and one unlink the other's.
    this.lock = acquireInstanceLock(path);
    await LocalApi.clearStaleSocket(path);
    // Bun's unix-socket options type omits idleTimeout, but the runtime honours it; without
    // it the default 10 s idle timeout kills long-polls and quiet SSE streams.
    const unixOpts = {
      unix: path,
      maxRequestBodySize: 26 * 1024 * 1024,
      idleTimeout: 0,
      fetch: (req: Request, server: Server<undefined>) => this.handle(req, "unix", server),
      error: (err: Error) => errorResponse(err, this.d.core.log),
    };
    this.unixServer = Bun.serve(unixOpts as unknown as Parameters<typeof Bun.serve>[0]) as Server<undefined>;
    this.boundSocket = path;
    chmodSync(path, 0o600);
  }

  startTcp(port: number): void {
    this.tcpServer = Bun.serve({
      hostname: "127.0.0.1",
      port,
      maxRequestBodySize: 26 * 1024 * 1024,
      idleTimeout: 255, // > the 120 s long-poll cap; SSE heartbeats every 15 s

      fetch: (req, server) => this.handle(req, "tcp", server),
      error: (err) => errorResponse(err, this.d.core.log),
    });
    this.sweeper = setInterval(() => this.sessions.sweep(), 60_000);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.sessions.close(); // streams end; the saved sessions stay valid for the next run
    this.tokenGeneration.abort();
    this.unixServer?.stop(true);
    this.tcpServer?.stop(true);
    // Only the socket this instance bound, and while still holding the lock: after release, the path may
    // already belong to the next daemon.
    if (this.boundSocket) {
      try { unlinkSync(this.boundSocket); } catch { /* already gone */ }
      this.boundSocket = null;
    }
    this.lock?.release();
    this.lock = null;
  }

  private async handle(req: Request, transport: "unix" | "tcp", server: Server<undefined>): Promise<Response> {
    if (transport === "unix") return this.route(req, "unix", server);
    const res = await this.route(req, "tcp", server);
    return this.clearLegacyCookies(req, res);
  }

  /** Any response to a request that still carries a cookie an earlier version set also clears it. */
  private clearLegacyCookies(req: Request, res: Response): Response {
    const names = cookieNames(req);
    const stale = legacyCookies(this.tcpServer?.port ?? 0).filter((n) => names.has(n));
    if (!stale.length) return res;
    const headers = new Headers(res.headers);
    for (const n of stale) headers.append("Set-Cookie", `${n}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/`);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  private async route(req: Request, transport: "unix" | "tcp", server: Server<undefined>): Promise<Response> {
    let release: (() => void) | null = null;
    try {
      const url = new URL(req.url);
      let auth: Credential | null = null;
      if (transport === "tcp") {
        const checked = this.checkTcp(req, url);
        if ("early" in checked) return checked.early;
        auth = checked.credential;
      }
      if (!url.pathname.startsWith("/v1/")) {
        if (transport === "tcp") return this.serveStatic(req, url);
        throw new HttpError(404, "not_found", "no such route");
      }
      if (url.pathname.startsWith("/v1/auth/")) return this.authRoute(req, url, transport);
      const session = auth?.session ?? null;
      // A credential's requests end with it: logout/expiry closes a session's open streams, and a token
      // rotation closes whatever the old token opened.
      const routeReq = auth ? new Request(req, { signal: AbortSignal.any([req.signal, auth.signal]) }) : req;
      if (session && url.pathname === "/v1/stream") {
        release = this.sessions.openStream(session);
        routeReq.signal.addEventListener("abort", release, { once: true });
      }
      return await trackOp(`${req.method} ${url.pathname}`, () => dispatch(this.routeCtx(routeReq, url, req, server,
        validAgentHeader(req.headers.get("x-walkie-agent")), session?.expiresAt, undefined, req.headers.get("x-walkie-under-agent") === "1",
        { via: session ? "dashboard" : "cli", listener: transport, ...(auth ? { signal: auth.signal } : {}) })));
    } catch (err) {
      release?.(); // a refused stream (e.g. 429) must not keep its session from idling out
      return errorResponse(err, this.d.core.log);
    }
  }

  private routeCtx(
    routeReq: Request, url: URL, req: Request, server: Server<undefined> | null, agent: string | undefined, credentialExpiresAt?: number,
    rateKey?: string, underAgent = false, origin: { via: RouteCtx["via"]; signal?: AbortSignal; listener?: "unix" | "tcp" } = { via: "cli" },
  ): RouteCtx {
    return {
      core: this.d.core, sync: this.d.sync, client: this.d.client, integrations: this.d.integrations,
      licenseService: this.d.licenseService, req: routeReq, url, agent, underAgent,
      noTimeout: () => server?.timeout(req, 0),
      tailscaleError: this.d.tailscaleError?.(),
      ...(this.d.peerApi ? { peerApi: this.d.peerApi } : {}),
      ...(this.d.localLag ? { localLag: this.d.localLag } : {}),
      ...(this.d.mobile ? { mobile: this.d.mobile } : {}),
      ...(this.d.projects ? { projects: this.d.projects } : {}),
      ...(this.d.transport ? { transport: this.d.transport } : {}),
      ...(credentialExpiresAt !== undefined ? { credentialExpiresAt } : {}),
      ...(rateKey ? { rateKey } : {}),
      via: origin.via, ...(origin.signal ? { credentialSignal: origin.signal } : {}),
      // The listener (ACCOUNTS-2 unix-only routes); a paired phone's request has none.
      ...(origin.listener ? { listener: origin.listener } : {}),
      ...(origin.via !== "phone" && req.headers.get(ORCHESTRATOR_TOKEN_HEADER) ? { orchestratorToken: req.headers.get(ORCHESTRATOR_TOKEN_HEADER) as string } : {}),
      ...(this.d.accounts ? { accounts: this.d.accounts } : {}),
      // A dashboard session on the loopback listener: the limit-reset routes are served to it only (ACCOUNTS-RESET).
      // A paired phone's request (serveAuthenticated) is not one, and its allow-list has no accounts route anyway.
      dashboard: origin.via === "dashboard",
    };
  }

  /**
   * Serves a request that arrived another way and is already authenticated (a paired phone's request through the
   * encrypted relay link, src/daemon/mobile/tunnel.ts, which also applies the phone's allow-list): a `/v1` route under
   * that credential, whose `signal` ends the request (a revoked phone's open stream closes). The caller is a person:
   * an X-Walkie-Agent header is ignored.
   */
  async serveAuthenticated(
    req: Request, url: URL, server: Server<undefined> | null, credential: { signal: AbortSignal; expiresAt: number; rateKey?: string } | null,
  ): Promise<Response> {
    try {
      if (!url.pathname.startsWith("/v1/")) throw new HttpError(404, "not_found", "no such route");
      const routeReq = credential ? new Request(req, { signal: AbortSignal.any([req.signal, credential.signal]) }) : req;
      return await trackOp(`phone ${req.method} ${url.pathname}`, () => dispatch(this.routeCtx(routeReq, url, req, server, undefined,
        credential?.expiresAt, credential?.rateKey, false, { via: "phone", ...(credential ? { signal: credential.signal } : {}) })));
    } catch (err) {
      return errorResponse(err, this.d.core.log);
    }
  }

  /** `/v1/auth/*`: login nonces, sign-out of every dashboard, token rotation. Unix socket only. */
  private authRoute(req: Request, url: URL, transport: "unix" | "tcp"): Response {
    // The loopback listener is exactly what these protect: a caller must prove it is this OS user.
    if (transport !== "unix") throw new HttpError(403, "forbidden", "this route is only served on the unix socket");
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "method not allowed");
    const body = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    // Person-only (WALKIE-ADD-MACHINE-2, ORCH-FIX-13): an agent-marked caller (an agent header, or the CLI saying it
    // runs under an agent) gets no dashboard session, can't sign out every dashboard and can't rotate the token. The
    // same-OS-user limit applies (SECURITY.md).
    // AGENT-ADMIN-1: a dashboard session is a credential handed out in plain text (the login link), so it stays a
    // person's; signing out every dashboard and rotating the token are admin actions an agent may take (audited).
    const namedAgent = validAgentHeader(req.headers.get("x-walkie-agent"));
    const token = req.headers.get(ORCHESTRATOR_TOKEN_HEADER);
    if (token !== null && (!hostFor(this.d.core)?.acceptsToken(token)
      || (namedAgent !== undefined && namedAgent !== ORCHESTRATOR_AGENT))) {
      throw new HttpError(403, "forbidden", "the orchestrator token requires the orchestrator agent identity");
    }
    const agent = token !== null ? ORCHESTRATOR_AGENT : namedAgent;
    const underAgent = token !== null || req.headers.get("x-walkie-under-agent") === "1";
    if ((agent || underAgent) && url.pathname === "/v1/auth/nonce") {
      throw new HttpError(403, "person_only", "agents can't open the dashboard (its login link is a credential in plain text); a person runs walkie dashboard in their own terminal");
    }
    if (url.pathname === "/v1/auth/logout" || url.pathname === "/v1/auth/rotate") {
      adminGate({ core: this.d.core, agent, underAgent, req }, url.pathname === "/v1/auth/logout" ? "signed out every dashboard session" : "rotated the local API token");
    }
    if (url.pathname === "/v1/auth/nonce") return body(this.mintNonce());
    if (url.pathname === "/v1/auth/logout") return body({ revoked: this.sessions.revokeAll() });
    if (url.pathname === "/v1/auth/rotate") {
      if (!this.d.rotateToken) throw new HttpError(503, "unavailable", "token rotation is not available on this daemon");
      const { token, path } = this.d.rotateToken();
      this.currentToken = token;
      this.tokenGeneration.abort();
      this.tokenGeneration = new AbortController();
      this.sessions.setGeneration(tokenGeneration(token)); // saved sessions of the old token never restore
      this.sessions.revokeAll();
      this.d.core.log.info("local_token_rotated", {});
      return body({ rotated: true, path });
    }
    throw new HttpError(404, "not_found", "no such route");
  }

  /**
   * Host (DNS rebinding), auth and Origin (CSRF) checks for the loopback listener. `/v1` takes either the
   * durable token as a bearer (scripts) or a dashboard session in the X-Walkie-Session header; a session only
   * reaches the dashboard's routes and never works as a bearer. No cookie authorizes anything (SEC-COOKIE-2).
   */
  private checkTcp(req: Request, url: URL): TcpAuth {
    const port = this.tcpServer?.port ?? 0;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const host = req.headers.get("host") ?? "";
    if (!allowedHosts.includes(host)) throw new HttpError(403, "forbidden", "bad Host header");
    const allowedOrigins = allowedHosts.map((h) => `http://${h}`);
    if (url.pathname === "/auth") return { early: this.auth(req, url, host, port) };
    if (url.pathname === "/auth/logout") return { early: this.logout(req, host, allowedOrigins) };
    if (!url.pathname.startsWith("/v1/")) return { credential: null };

    const authz = req.headers.get("authorization");
    const bearer = authz?.startsWith("Bearer ") ? authz.slice(7).trim() : null;
    const viaBearer = bearer !== null && tokenEq(bearer, this.currentToken);
    const session = viaBearer ? null : this.sessionOf(req, host);
    if (!viaBearer && !session) {
      throw new HttpError(401, "unauthorized", "missing or invalid token, or the dashboard session ended (sign in again with: walkie dashboard)");
    }
    if (session && !dashboardRoute(req.method, url.pathname)) {
      throw new HttpError(403, "forbidden", "not available to a dashboard session (use the CLI)");
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.get("origin");
      if (origin !== null && !allowedOrigins.includes(origin)) throw new HttpError(403, "forbidden", "bad Origin");
      if (origin === null && session) throw new HttpError(403, "forbidden", "Origin required for dashboard writes");
    }
    return { credential: session ? { session, signal: session.signal } : { session: null, signal: this.tokenGeneration.signal } };
  }

  /** The live session in this request's X-Walkie-Session header, issued for this Host. */
  private sessionOf(req: Request, host: string): Session | null {
    const v = req.headers.get(SESSION_HEADER);
    return v ? this.sessions.check(v, host) : null;
  }

  /**
   * `GET /auth?nonce=…` (from `walkie dashboard`): a live one-shot nonce becomes a new dashboard session, handed
   * to the page in the redirect's URL fragment (`/#s=…`), which the browser never sends to any server. The page
   * moves it into its origin's sessionStorage and removes it from the address bar. No cookie carries it; the
   * cookies earlier versions set are cleared.
   */
  private auth(req: Request, url: URL, host: string, port: number): Response {
    if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "method not allowed");
    const n = url.searchParams.get("nonce") ?? "";
    if (!/^[0-9a-f]{64}$/.test(n) || !this.takeNonce(n)) throw new HttpError(401, "unauthorized", "invalid or expired login link (run: walkie dashboard)");
    const headers = new Headers({ Location: `/#s=${this.sessions.create(host)}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    for (const name of legacyCookies(port)) headers.append("Set-Cookie", `${name}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/`);
    return new Response(null, { status: 302, headers });
  }

  /** `POST /auth/logout` (the dashboard's sign-out): ends the session in the X-Walkie-Session header. */
  private logout(req: Request, host: string, allowedOrigins: string[]): Response {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "method not allowed");
    const origin = req.headers.get("origin");
    if (origin === null || !allowedOrigins.includes(origin)) throw new HttpError(403, "forbidden", "bad Origin");
    const v = req.headers.get(SESSION_HEADER);
    if (v && this.sessions.check(v, host)) this.sessions.revoke(v);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  private serveEmbedded(files: Record<string, string>, url: URL): Response {
    const hit = files[url.pathname];
    const path = hit ?? files["/index.html"];
    if (!path) return new Response(PLACEHOLDER, { headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
    const isIndex = !hit || url.pathname === "/index.html";
    const name = isIndex ? "/index.html" : url.pathname;
    return new Response(Bun.file(path), {
      headers: {
        "Content-Type": MIME[extname(name)] ?? "application/octet-stream",
        "Cache-Control": isIndex ? "no-cache" : name.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        ...SECURITY_HEADERS,
      },
    });
  }

  private serveStatic(req: Request, url: URL): Response {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method_not_allowed", "method not allowed");
    if (EMBEDDED) return this.serveEmbedded(EMBEDDED, url);
    const root = resolve(this.d.webDir);
    const index = join(root, "index.html");
    if (!existsSync(index)) return new Response(PLACEHOLDER, { headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
    let rel: string;
    try { rel = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, "invalid", "bad path"); }
    const file = resolve(root, "." + rel);
    const inside = file === root || file.startsWith(root + sep);
    const target = inside && existsSync(file) && statSync(file).isFile() ? file : index; // SPA fallback
    const isIndex = target === index;
    return new Response(readFileSync(target), {
      headers: {
        "Content-Type": MIME[extname(target)] ?? "application/octet-stream",
        "Cache-Control": isIndex ? "no-cache" : rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        ...SECURITY_HEADERS,
      },
    });
  }
}

/**
 * What a connect to the socket says: "dead" when it is refused (nothing listens), "live" when a process accepts
 * it, and "unknown" for anything else (a timeout, EACCES, …), which is never treated as dead. Bun reports a
 * refused unix socket as ENOENT, and also a socket it may not connect to (mode 000 — a live daemon's socket
 * included), so ENOENT on a path that is still a socket counts as refused only when this user may write to it
 * (connecting needs write permission); otherwise it is "unknown".
 */
function socketReach(path: string, ms: number): Promise<"dead" | "live" | "unknown"> {
  return new Promise((done) => {
    const sock = connect({ path });
    const finish = (v: "dead" | "live" | "unknown") => { clearTimeout(timer); sock.destroy(); done(v); };
    const timer = setTimeout(() => finish("unknown"), ms);
    sock.once("connect", () => finish("live"));
    sock.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") return finish("dead");
      if (err.code !== "ENOENT") return finish("unknown");
      finish(refusedOrGone(path) ? "dead" : "unknown");
    });
  });
}

/** After an ENOENT: true when the path is gone, not a socket, or a socket this user could have connected to. */
function refusedOrGone(path: string): boolean {
  let isSocket: boolean;
  try { isSocket = lstatSync(path).isSocket(); } catch { return true; }
  if (!isSocket) return true;
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
}
