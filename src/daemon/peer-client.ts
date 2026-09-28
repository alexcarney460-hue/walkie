import { LeadGrant } from "./orchestrator/lease.ts";
// HTTP client for other daemons' peer API (PROTOCOL §4), over Tailscale or Walkie Direct (src/daemon/transport.ts).
// A peer is not trusted to send well-formed or small responses: bodies are read with a streaming byte cap and
// validated with zod.
import type { ZodType, ZodTypeDef } from "zod";
import {
  MAX_IDS_PER_FETCH, PeerEventsRes, PeerHelloRes, PeerJoinResSchema, PeerPushResSchema, PeerVvRes, RosterRequestRes,
  type PeerHello, type PeerJoinRes, type PeerPushRes, type PeerVv, type RosterRequest,
} from "../protocol/schemas.ts";
import { pickTransport, reachableOver, type NodeRec } from "./roster.ts";
import type { TransportKind } from "../protocol/schemas.ts";
import { Transports, addrLabel, peerUrl, type PeerAddr } from "./transport.ts";
import { ServeRes, StageRes, type ServeReq, type StageReq } from "../protocol/pool.ts";
import { TunnelRefused } from "./direct/net.ts";
import { WsEnd, type End } from "../pool/run/tunnel.ts";
import { BorrowedUsageRes, PeerLeaseRes, type PeerLeaseReq } from "./vault-lease.ts";
import { RemoteRunRes } from "../protocol/admin.ts";

export { peerUrl, type PeerAddr } from "./transport.ts";

/** A peer's refusal body (untrusted JSON) as a PeerCallError. */
function refusal(status: number, body: string): PeerCallError {
  try {
    const e = (JSON.parse(body) as { error?: { code?: unknown; message?: unknown } }).error;
    return new PeerCallError(status, typeof e?.code === "string" ? e.code.slice(0, 64) : `http_${status}`, typeof e?.message === "string" ? e.message.slice(0, 300) : "tunnel refused");
  } catch {
    return new PeerCallError(status, `http_${status}`, "tunnel refused");
  }
}

/** A Tailscale tunnel: Bun's WebSocket client (it sends custom headers), resolved once open. */
function wsTunnel(url: string, headers: Record<string, string>): Promise<End> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    const end = new WsEnd({ sendBytes: (b) => ws.send(b as Uint8Array<ArrayBuffer>), sendText: (t) => ws.send(t), close: () => ws.close() });
    let open = false;
    const timer = setTimeout(() => { if (!open) { ws.close(); reject(new PeerCallError(0, "unreachable", "tunnel did not open within 20 s")); } }, 20_000);
    ws.onopen = () => { open = true; clearTimeout(timer); resolve(end); };
    ws.onmessage = (ev) => end.message(ev.data as string | ArrayBuffer);
    ws.onclose = (ev) => {
      clearTimeout(timer);
      end.closed();
      if (!open) reject(new PeerCallError(0, "tunnel_refused", `tunnel refused or unreachable (${ev.code})`));
    };
    ws.onerror = () => undefined; // onclose follows
  });
}

export class PeerCallError extends Error {
  /** `raw` = the peer's error object as sent (untrusted; validate before use). */
  constructor(readonly status: number, readonly code: string, message: string, readonly raw?: unknown) { super(message); }
}

export interface PeerIdentityHeaders {
  team: () => string | null; nodeId: string;
  /** This node's own roster record: which transports it serves, for picking one per peer (PROTOCOL §4). */
  self?: () => Pick<NodeRec, "transports" | "ip"> | undefined;
}

type PeerNode = Pick<NodeRec, "ip" | "port" | "pubkey" | "transports">;

/** Largest JSON response accepted from a peer (servers byte-budget pages to PEER_PAGE_BUDGET). */
export const PEER_RESPONSE_MAX = 1024 * 1024;

/** Parses "host", "host:port", "[v6]:port" with a default port. */
export function parsePeerTarget(target: string, defaultPort: number): PeerAddr {
  const t = target.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (v6) return { ip: v6[1] as string, port: v6[2] ? Number(v6[2]) : defaultPort };
  const m = /^([A-Za-z0-9.-]+)(?::(\d+))?$/.exec(t);
  if (!m) throw new Error(`invalid peer address: ${target}`);
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in ${target}`);
  return { ip: m[1] as string, port };
}

/** Reads a response body, aborting as soon as it passes `max` bytes (never buffers more than that). */
export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new PeerCallError(res.status, "too_large", `peer response exceeds ${max} bytes`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new PeerCallError(res.status, "too_large", `peer response exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export class PeerClient {
  constructor(private readonly id: PeerIdentityHeaders, readonly transports: Transports = new Transports()) {}

  /**
   * Where to reach a roster node (PROTOCOL §4 "Mixed teams"): over a transport both machines serve, Tailscale first
   * (its pinned tailnet ip:port), else Walkie Direct (its node key, only while this daemon runs Direct). Null when
   * they share none: that peer's events reach this node through machines that serve both.
   */
  addrOf(n: PeerNode): PeerAddr | null {
    const via = pickTransport(this.localTransports(), n);
    if (via === "tailscale") return { ip: n.ip, port: n.port };
    return via === "direct" ? { ip: n.ip, port: n.port, pubkey: n.pubkey } : null;
  }

  /**
   * POOL-REAL-1: `n`'s address over one given transport, when both machines serve it now (Direct only while this
   * daemon's endpoint runs), else null. Pool tunnels pick their transport with it (main.ts poolAddr).
   */
  addrVia(n: PeerNode, kind: TransportKind): PeerAddr | null {
    if (!reachableOver(this.localTransports()).includes(kind) || !reachableOver(n).includes(kind)) return null;
    return kind === "tailscale" ? { ip: n.ip, port: n.port } : { ip: n.ip, port: n.port, pubkey: n.pubkey };
  }

  /** Whether this daemon can reach `n` directly at all. */
  reaches(n: PeerNode): boolean { return this.addrOf(n) !== null; }

  /**
   * What this node serves, as a peer would judge it: its roster record (a peer's gate checks the record, not what
   * runs here), with Direct only while the endpoint runs. Before admission (no record): the transport it runs.
   */
  private localTransports(): Pick<NodeRec, "transports" | "ip"> {
    const rec = this.id.self?.();
    if (!rec) return this.transports.direct ? { transports: ["direct"], ip: "" } : { ip: "0.0.0.0" };
    const serves = rec.transports ?? ["tailscale"];
    return { ip: rec.ip, transports: this.transports.direct ? serves : serves.filter((t) => t !== "direct") };
  }

  /** One exchange over the address's transport; a transport-level failure is `unreachable`. */
  private async send(addr: PeerAddr, method: string, path: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal): Promise<Response> {
    const t = this.transports.for(addr);
    if (!t) throw new PeerCallError(0, "unreachable", `${addrLabel(addr)} unreachable (Walkie Direct is not running on this machine)`);
    try {
      return await t.request(addr, { method, path, headers, ...(body !== undefined ? { body } : {}), signal });
    } catch (err) {
      // Tailscale keeps its v0.1 text (the error class only); a Direct failure says why (iroh's reason, trimmed).
      const why = t.kind === "direct" && err instanceof Error && err.name !== "AbortError" ? `: ${err.message.slice(0, 160)}` : "";
      throw new PeerCallError(0, "unreachable", `${addrLabel(addr)} unreachable (${(err as Error).name}${why})`);
    }
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = { "X-Walkie-Node": this.id.nodeId };
    const team = this.id.team();
    if (team) headers["X-Walkie-Team"] = team;
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  private async call<T>(
    addr: PeerAddr, method: string, path: string, schema: ZodType<T, ZodTypeDef, unknown>, body?: unknown, timeoutMs = 2_000,
  ): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await this.send(addr, method, path, this.headers(body !== undefined), body === undefined ? undefined : JSON.stringify(body), signal);
    let data: unknown = {};
    try {
      const bytes = await readCapped(res, PEER_RESPONSE_MAX);
      data = bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {};
    } catch (err) {
      if (err instanceof PeerCallError) throw err;
      throw new PeerCallError(res.status, "bad_response", "peer sent non-JSON");
    }
    if (!res.ok) {
      const e = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      const code = typeof e?.code === "string" ? e.code.slice(0, 64) : `http_${res.status}`;
      const message = typeof e?.message === "string" ? e.message.slice(0, 300) : res.statusText;
      throw new PeerCallError(res.status, code, message, e);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new PeerCallError(res.status, "bad_response", "peer response has the wrong shape");
    return parsed.data;
  }

  hello(addr: PeerAddr, timeoutMs = 5_000): Promise<PeerHello> {
    return this.call(addr, "GET", "/peer/v1/hello", PeerHelloRes, undefined, timeoutMs);
  }
  join(addr: PeerAddr, body: { pubkey: string; hostname: string; ip: string; port: number; invite?: string }): Promise<PeerJoinRes> {
    // A Direct join may first have to find the authority through a relay and discovery.
    return this.call(addr, "POST", "/peer/v1/join", PeerJoinResSchema, body, addr.pubkey ? 30_000 : 10_000);
  }
  vv(addr: PeerAddr): Promise<PeerVv> { return this.call(addr, "GET", "/peer/v1/vv", PeerVvRes, undefined, 5_000); }
  pull(addr: PeerAddr, origin: string, after: number, limit = 500): Promise<{ events: unknown[] }> {
    // status_stubs=1: this node accepts superseded agent.status events as stubs (MISSION-1 fix round 3).
    const qs = new URLSearchParams({ origin, after: String(after), limit: String(limit), status_stubs: "1" });
    return this.call(addr, "GET", `/peer/v1/events?${qs}`, PeerEventsRes, undefined, 10_000);
  }
  /** Fetches specific events (stub fill, PROTOCOL §3); the peer applies the same visibility rules. */
  pullIds(addr: PeerAddr, ids: readonly string[]): Promise<{ events: unknown[] }> {
    const qs = new URLSearchParams({ ids: ids.slice(0, MAX_IDS_PER_FETCH).join(","), status_stubs: "1" });
    return this.call(addr, "GET", `/peer/v1/events?${qs}`, PeerEventsRes, undefined, 10_000);
  }
  push(addr: PeerAddr, events: unknown[], timeoutMs = 2_000): Promise<PeerPushRes> {
    return this.call(addr, "POST", "/peer/v1/events", PeerPushResSchema, { events }, timeoutMs);
  }
  /** ACCOUNTS-2: asks the owner's machine for a setup-token hand-out (reply sealed to our ephemeral key). */
  leadLease(addr: PeerAddr): Promise<LeadGrant> {
    return this.call(addr, "POST", "/peer/v1/orchestrator/lease", LeadGrant, {}, 5_000);
  }
  borrowedUsage(addr: PeerAddr, account: string, grant: string) {
    return this.call(addr, "POST", "/peer/v1/vault/usage", BorrowedUsageRes, { account, grant }, 5_000);
  }
  vaultLease(addr: PeerAddr, body: PeerLeaseReq): Promise<PeerLeaseRes> {
    return this.call(addr, "POST", "/peer/v1/vault/lease", PeerLeaseRes, body, 10_000);
  }
  /** Asks the roster authority to append a roster event (PROTOCOL §4); `event` is the authority's. */
  rosterRequest(addr: PeerAddr, req: RosterRequest): Promise<{ event?: unknown }> {
    return this.call(addr, "POST", "/peer/v1/roster-request", RosterRequestRes, req, 10_000);
  }

  /** AGENT-ADMIN-1: runs an allow-listed walkie command on that machine (a 404 = an older Walkie without it). */
  adminRun(addr: PeerAddr, body: Record<string, unknown>, timeoutMs: number): Promise<RemoteRunRes> {
    return this.call(addr, "POST", "/peer/v1/admin/run", RemoteRunRes, body, timeoutMs);
  }

  /** WALKIE-POOL-2: start / renew / stop this machine's stage of a split run on a worker. */
  stage(addr: PeerAddr, body: StageReq): Promise<StageRes> {
    return this.call(addr, "POST", "/peer/v1/pool/stage", StageRes, body, body.action === "start" ? 30_000 : 5_000);
  }

  /**
   * WALKIE-POOL-2: one tunnel connection into a worker's stage. Walkie Direct: a CONNECT stream on the node-key
   * connection; Tailscale: a WebSocket on the peer API port with the usual identity headers (the worker's gate runs
   * `tailscale whois` on the source address before upgrading).
   */
  async tunnel(addr: PeerAddr, run: string): Promise<End> {
    return this.tunnelTo(addr, `/peer/v1/pool/tunnel/${run}`);
  }

  /** POOL-REAL-1: start / connect to / renew / disconnect from / stop a model a machine serves whole. */
  serve(addr: PeerAddr, body: ServeReq): Promise<ServeRes> {
    return this.call(addr, "POST", "/peer/v1/pool/serve", ServeRes, body, body.action === "start" ? 30_000 : 10_000);
  }

  /** A tunnel connection to any tunnel path of a peer (split-run stages, served models' proxies). */
  async tunnelTo(addr: PeerAddr, path: string): Promise<End> {
    if (addr.pubkey) {
      const t = this.transports.direct;
      if (!t?.openTunnel) throw new PeerCallError(0, "unreachable", `${addrLabel(addr)} unreachable (Walkie Direct is not running on this machine)`);
      try {
        return await t.openTunnel(addr, path, this.headers(false), AbortSignal.timeout(20_000));
      } catch (err) {
        if (err instanceof TunnelRefused) throw refusal(err.status, err.body);
        throw new PeerCallError(0, "unreachable", `${addrLabel(addr)} unreachable (${(err as Error).message.slice(0, 160)})`);
      }
    }
    return wsTunnel(peerUrl(addr, path).replace(/^http:/, "ws:"), this.headers(false));
  }

  /** Fetches blob bytes for a share in `channel`; the peer serves them only with provenance for (channel, hash). */
  async blob(addr: PeerAddr, hash: string, channel: string, maxBytes: number): Promise<Uint8Array | null> {
    try {
      const path = `/peer/v1/blobs/${hash}?${new URLSearchParams({ channel })}`;
      const res = await this.send(addr, "GET", path, this.headers(false), undefined, AbortSignal.timeout(60_000));
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      return await readCapped(res, maxBytes);
    } catch {
      return null;
    }
  }
}
