// Where an incoming Walkie Direct handshake comes from, before any handshake work (PROTOCOL §4 "Connection budget").
// iroh names the source of an `Incoming` without a handshake: a UDP address on the direct path, or, on the relay
// path, the relay URL plus the sender's endpoint id (which the relay authenticated when the sender connected to it).
// The server budgets pending handshakes per source, so one host can't take the whole table, and per network prefix
// (an IPv4 /24, an IPv6 /48), so one routed allocation can't act as hundreds of sources.
import type * as Iroh from "@number0/iroh";

export interface Source {
  /** The budget key: an IPv4 address, an IPv6 /64, or a relay-authenticated endpoint id. */
  readonly key: string;
  /** The aggregate budget key above the source: an IPv4 /24 or an IPv6 /48 (null on the relay path). */
  readonly prefix: string | null;
  /** The sender's endpoint id (hex), known before the handshake only on the relay path. */
  readonly endpoint: string | null;
  readonly via: "ip" | "relay" | "other";
}

const HEX_ID = /^[0-9a-f]{64}$/;

/** The 8 hextets of an IPv6 address (text form, no zone), or null. */
function hextets(v6: string): number[] | null {
  const halves = v6.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const part of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const head = parse(halves[0] as string);
  const tail = halves.length === 2 ? parse(halves[1] as string) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill >= 1 ? [...head, ...Array<number>(fill).fill(0), ...tail] : null;
}

/** An "ip:port" / "[ip6]:port" source as IPv4 octets or IPv6 hextets (IPv4-mapped IPv6 counts as its IPv4 address). */
function parseIp(addr: string): { v4: string } | { v6: number[] } | null {
  const v6 = /^\[([^\]%]+)(?:%[^\]]*)?\]:\d+$/.exec(addr);
  if (v6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v6[1] as string);
    if (mapped) return { v4: mapped[1] as string };
    const h = hextets(v6[1] as string);
    return h ? { v6: h } : null;
  }
  const v4 = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(addr);
  return v4 ? { v4: v4[1] as string } : null;
}

const hexJoin = (h: number[], n: number): string => h.slice(0, n).map((x) => x.toString(16)).join(":");

/**
 * The budget key of a UDP source "ip:port" / "[ip6]:port": the IPv4 address (ports are free to an attacker), or
 * the IPv6 /64 (one host typically holds a whole /64). An IPv4-mapped IPv6 address counts as its IPv4 address.
 */
export function ipSourceKey(addr: string): string {
  const p = parseIp(addr);
  if (!p) {
    const raw = /^\[([^\]%]+)/.exec(addr);
    return raw ? `ip6:${raw[1]}` : `ip?:${addr}`;
  }
  return "v4" in p ? `ip:${p.v4}` : `ip6:${hexJoin(p.v6, 4)}::/64`;
}

/**
 * The aggregate budget key of a UDP source: its IPv4 /24 or IPv6 /48 (a site's routed allocation: one host with a
 * /48 holds 65,536 /64s). An address that doesn't parse is its own prefix.
 */
export function ipPrefixKey(addr: string): string {
  const p = parseIp(addr);
  if (!p) return `net?:${ipSourceKey(addr)}`;
  if ("v4" in p) return `net4:${p.v4.split(".").slice(0, 3).join(".")}.0/24`;
  return `net6:${hexJoin(p.v6, 3)}::/48`;
}

export function sourceOf(a: Iroh.IncomingAddr): Source {
  if (a.kind === "ip" && a.addr) return { key: ipSourceKey(a.addr), prefix: ipPrefixKey(a.addr), endpoint: null, via: "ip" };
  if (a.kind === "relay") {
    const id = a.endpointId?.toLowerCase() ?? "";
    return HEX_ID.test(id)
      ? { key: `relay:${id}`, prefix: null, endpoint: id, via: "relay" }
      : { key: `relay?:${a.addr ?? ""}`, prefix: null, endpoint: null, via: "relay" };
  }
  return { key: "other", prefix: "other", endpoint: null, via: "other" };
}
