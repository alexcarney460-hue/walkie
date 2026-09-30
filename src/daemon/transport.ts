// How a daemon reaches a peer's API (PROTOCOL §4). The peer API is HTTP either way; only the connection under
// it changes:
//   tailscale  HTTP over the tailnet IP (the caller is identified by `tailscale whois`).
//   direct     Walkie Direct: one iroh QUIC bi-stream per request (ALPN walkie/1), dialed by the peer's node
//              key; the caller is identified by the key QUIC/TLS authenticated (src/daemon/direct/net.ts).
import type { TransportKind } from "../protocol/schemas.ts";
import { nodeIdFromPubkey } from "../protocol/ids.ts";
import type { End } from "../pool/run/tunnel.ts";

export interface PeerAddr {
  readonly ip: string; readonly port: number;
  /** Known roster node id, used to bind Tailscale request signatures to their receiver. */
  readonly nodeId?: string;
  /** Walkie Direct: dial this node key (base64) over iroh instead of ip:port. */
  readonly pubkey?: string;
  /** Walkie Direct: a relay URL hint (an invite's); discovery finds the node without it. */
  readonly relay?: string;
}

export interface PeerRequest {
  readonly method: string; readonly path: string; readonly headers: Record<string, string>;
  readonly body?: string; readonly signal: AbortSignal;
}

/** One HTTP exchange with a peer. The response body is streamed; callers read it with a byte cap. */
export interface Transport {
  readonly kind: TransportKind;
  request(addr: PeerAddr, req: PeerRequest): Promise<Response>;
  /** WALKIE-POOL-2: a raw byte tunnel (Walkie Direct: a CONNECT stream). Tailscale tunnels use a WebSocket instead. */
  openTunnel?(addr: PeerAddr, path: string, headers: Record<string, string>, signal: AbortSignal): Promise<End>;
}

export function peerUrl(addr: PeerAddr, path: string): string {
  const host = addr.ip.includes(":") ? `[${addr.ip}]` : addr.ip;
  return `http://${host}:${addr.port}${path}`;
}

/** Stable text for logs and per-peer bookkeeping: `ip:port`, or `direct:<node id>`. */
export function addrLabel(addr: PeerAddr): string {
  return addr.pubkey ? `direct:${nodeIdFromPubkey(addr.pubkey)}` : `${addr.ip}:${addr.port}`;
}

export const TAILSCALE_TRANSPORT: Transport = {
  kind: "tailscale",
  request: (addr, r) => fetch(peerUrl(addr, r.path), {
    method: r.method, headers: r.headers, body: r.body, signal: r.signal,
    redirect: "error", // a peer answers, it never sends us elsewhere (the identity headers would go with us)
  }),
};

/** The transports this daemon can dial; Direct is set once its endpoint is up (it may start later, at init/join). */
export class Transports {
  direct: Transport | null = null;
  readonly tailscale: Transport;
  constructor(tailscale: Transport = TAILSCALE_TRANSPORT) { this.tailscale = tailscale; }

  /** The transport for an address: Direct when it names a node key, else Tailscale. */
  for(addr: PeerAddr): Transport | null {
    return addr.pubkey ? this.direct : this.tailscale;
  }
}
