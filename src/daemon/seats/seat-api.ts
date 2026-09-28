// The seats' own Walkie socket (PROTOCOL §11, SECURITY.md threat 13). A running seat never gets its host daemon's
// local API (that speaks as the host's person to anyone who omits X-Walkie-Agent): its WALKIE_SOCKET is this
// separate unix socket, and its WALKIE_SEAT_TOKEN a credential the daemon issued for that one seat. Every request
// needs the token; the daemon, not the caller, decides who speaks (the seat's own agent `seat-<id>`), and the only
// thing it can do is post progress in its own thread of the host's seats channel. The token dies with the seat.
import type { Server } from "bun";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { PostReq, type Event } from "../../protocol/schemas.ts";
import { HttpError, errorResponse, json, parseWith, readJson } from "../http.ts";
import type { Logger } from "../logger.ts";
import { verifySeatSocketDir } from "./seat-user.ts";

const BODY_MAX = 64 * 1024;

export interface SeatPoster {
  /** Posts `text` as the seat `seatId` in its own thread; throws HttpError when it may not. */
  postAsSeat(seatId: string, body: { channel: string; text: string; thread?: string }): Event;
}

function tokenEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class SeatApi {
  private server: Server<undefined> | null = null;
  /** seat id → its token. */
  private readonly tokens = new Map<string, string>();

  constructor(public socket: string, private readonly poster: SeatPoster, private readonly log: Logger) {}

  get listening(): boolean { return this.server !== null; }

  /**
   * Listens on the socket: 0600 in the daemon's home, or (`shared`, seats run as the seat user) 0666 in a 0711
   * directory of the daemon's own that the seat user can reach; either way every request needs a live seat token.
   */
  start(shared = false): void {
    try {
      if (shared) verifySeatSocketDir(dirname(this.socket));
      rmSync(this.socket, { force: true });
      this.server = Bun.serve({
        unix: this.socket,
        maxRequestBodySize: BODY_MAX,
        fetch: (req: Request) => this.handle(req),
        error: (err: Error) => errorResponse(err, this.log),
      } as unknown as Parameters<typeof Bun.serve>[0]) as Server<undefined>;
      chmodSync(this.socket, shared ? 0o666 : 0o600);
    } catch (err) {
      this.server = null;
      this.log.warn("seats_socket_failed", { err: (err as Error).message });
    }
  }

  /** Listens at another path (the seat user was set or cleared): the seats' tokens stay valid. */
  move(socket: string, shared: boolean): void {
    this.server?.stop(true);
    this.server = null;
    rmSync(this.socket, { force: true });
    this.socket = socket;
    this.start(shared);
  }

  stop(): void {
    this.tokens.clear();
    this.server?.stop(true);
    this.server = null;
    rmSync(this.socket, { force: true });
  }

  /** A fresh credential for one seat (replacing any earlier one). */
  issue(seatId: string): string {
    const token = randomBytes(32).toString("hex");
    this.tokens.set(seatId, token);
    return token;
  }

  revoke(seatId: string): void { this.tokens.delete(seatId); }

  private seatFor(req: Request): string {
    const authz = req.headers.get("authorization");
    const presented = authz?.startsWith("Bearer ") ? authz.slice(7).trim() : "";
    if (presented) for (const [id, t] of this.tokens) if (tokenEq(t, presented)) return id;
    throw new HttpError(401, "unauthorized", "this socket serves running Walkie seats only (a valid WALKIE_SEAT_TOKEN is required)");
  }

  private async handle(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/v1/healthz" && req.method === "GET") return json({ ok: true, seat: true });
      const seat = this.seatFor(req);
      if (url.pathname !== "/v1/post" || req.method !== "POST") {
        throw new HttpError(403, "forbidden", "a seat's Walkie access is limited to posting in its own thread of the seats channel");
      }
      const b = parseWith(PostReq, await readJson(req, BODY_MAX));
      // The body arrives after the headers were authenticated: the seat may have ended (its token revoked) meanwhile.
      if (this.seatFor(req) !== seat) throw new HttpError(401, "unauthorized", "this seat is over");
      if (b.artifacts?.length) throw new HttpError(403, "forbidden", "a seat can't attach artifacts (its commits come back as the result bundle)");
      const event = this.poster.postAsSeat(seat, { channel: b.channel, text: b.text, ...(b.thread ? { thread: b.thread } : {}) });
      return json({ event, redactions: [] });
    } catch (err) {
      return errorResponse(err, this.log);
    }
  }
}
