// Tailscale identity behind an interface so tests can inject a fake.
// Production: `tailscale whois --json <ip>`; results cached 60 s; failures are never cached as a pass.
import { existsSync } from "node:fs";

export interface WhoisResult { login: string; nodeName: string }
export interface SelfInfo { ip: string; login: string; nodeName: string }

export interface Identity {
  whois(ip: string, headers: Headers): Promise<WhoisResult | null>;
  /** This machine's tailnet address + owner, or an error string. */
  self(): Promise<SelfInfo | { error: string }>;
  readonly kind: "tailscale" | "fake";
}

const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const DENY_TTL_MS = 5_000;

export function tailscaleBinary(): string | null {
  const fromPath = Bun.which("tailscale");
  if (fromPath) return fromPath;
  if (process.platform === "darwin" && existsSync(MAC_APP_CLI)) return MAC_APP_CLI;
  return null;
}

/**
 * Environment for the Tailscale CLI. The macOS app-bundle CLI decides between "CLI" and "launch the GUI" from
 * terminal variables (TERM, TERM_PROGRAM, SHLVL); under launchd none are set, so without this it tries to start
 * the GUI and reports no IPv4 address. TAILSCALE_BE_CLI=1 forces CLI mode (no effect on Linux's tailscale).
 */
export function tailscaleEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return { ...out, TAILSCALE_BE_CLI: "1" };
}

async function run(bin: string, args: string[], timeoutMs = 5_000): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: tailscaleEnv() });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err };
  } finally {
    clearTimeout(timer);
  }
}

/** First DNS label of a Tailscale node name, sanitized to the Address machine segment. */
export function shortNodeName(name: string): string {
  const first = name.replace(/\.$/, "").split(".")[0] ?? "";
  const clean = first.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return clean || "node";
}

interface WhoisJson { Node?: { Name?: string; ComputedName?: string }; UserProfile?: { LoginName?: string } }

export function parseWhois(json: string): WhoisResult | null {
  try {
    const d = JSON.parse(json) as WhoisJson;
    const login = d.UserProfile?.LoginName;
    const name = d.Node?.Name || d.Node?.ComputedName;
    if (!login || !name || login === "tagged-devices") return null;
    return { login, nodeName: shortNodeName(name) };
  } catch {
    return null;
  }
}

export class TailscaleIdentity implements Identity {
  readonly kind = "tailscale" as const;
  private readonly cache = new Map<string, { at: number; value: WhoisResult }>();
  /** Short deny cache so unknown IPs can't make every request exec `tailscale whois`. */
  private readonly denied = new Map<string, number>();
  private readonly bin: string | null;

  constructor(bin: string | null = tailscaleBinary(), private readonly ttlMs = 60_000) {
    this.bin = bin;
  }

  async whois(ip: string, _headers: Headers): Promise<WhoisResult | null> {
    if (!this.bin || !/^[0-9a-fA-F:.]+$/.test(ip)) return null;
    const hit = this.cache.get(ip);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const miss = this.denied.get(ip);
    if (miss !== undefined && Date.now() - miss < DENY_TTL_MS) return null; // cached *denial* only
    try {
      const r = await run(this.bin, ["whois", "--json", ip]);
      const value = r.code === 0 ? parseWhois(r.out) : null;
      if (this.cache.size > 1024) this.cache.clear();
      if (this.denied.size > 1024) this.denied.clear();
      if (value) {
        this.cache.set(ip, { at: Date.now(), value });
        this.denied.delete(ip);
      } else {
        this.cache.delete(ip);
        this.denied.set(ip, Date.now());
      }
      return value;
    } catch {
      return null;
    }
  }

  async selfIp(): Promise<string | null> {
    if (!this.bin) return null;
    try {
      const r = await run(this.bin, ["ip", "-4"]);
      const ip = r.out.trim().split("\n")[0]?.trim();
      return r.code === 0 && ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
    } catch {
      return null;
    }
  }

  async self(): Promise<SelfInfo | { error: string }> {
    if (!this.bin) return { error: "tailscale CLI not found (install Tailscale or add it to PATH)" };
    const ip = await this.selfIp();
    if (!ip) return { error: "tailscale has no IPv4 address (is it logged in and connected?)" };
    const who = await this.whois(ip, new Headers());
    if (!who) return { error: `tailscale whois ${ip} failed` };
    return { ip, ...who };
  }
}

/**
 * Test identity: maps the caller's X-Walkie-Node header (or its IP) to a login.
 * ONLY constructed explicitly by tests/harnesses — never selected from env.
 */
export class FakeIdentity implements Identity {
  readonly kind = "fake" as const;
  constructor(
    private readonly me: SelfInfo,
    /** node id -> { login, nodeName }, shared across a test cluster. */
    private readonly byNode: Map<string, WhoisResult>,
    private readonly byIp: Map<string, WhoisResult> = new Map(),
  ) {}

  async whois(ip: string, headers: Headers): Promise<WhoisResult | null> {
    const node = headers.get("x-walkie-node");
    if (node) return this.byNode.get(node) ?? null;
    return this.byIp.get(ip) ?? null;
  }

  async self(): Promise<SelfInfo> { return this.me; }
}
