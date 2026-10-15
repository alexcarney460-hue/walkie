/** Browser URLs are public HTTPS/HTTP pages. The denylist covers finance, mail, and social accounts. */
import { isSeatAgent, SEATS_AGENT } from "../../protocol/seats.ts";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const DENIED = [
  "bankofamerica.com", "chase.com", "wellsfargo.com", "citi.com", "capitalone.com", "usbank.com", "ally.com",
  "americanexpress.com", "schwab.com", "fidelity.com", "paypal.com", "venmo.com", "wise.com", "revolut.com",
  "stripe.com", "coinbase.com",
  "gmail.com", "mail.google.com", "accounts.google.com", "outlook.com", "outlook.live.com", "live.com",
  "mail.yahoo.com", "yahoo.com", "icloud.com", "aol.com", "proton.me", "protonmail.com", "zoho.com", "fastmail.com",
  "facebook.com", "instagram.com", "x.com", "twitter.com", "linkedin.com", "tiktok.com", "reddit.com",
  "discord.com", "whatsapp.com", "telegram.org", "t.me", "threads.net", "snapchat.com", "pinterest.com", "bsky.app",
];

function privateAddress(host: string): boolean {
  const v6 = host.toLowerCase().replace(/^\[|\]$/g, "");
  // Use only IPv4 DNS answers. This also excludes every spelling of IPv6 loopback,
  // unique-local, link-local and mapped private IPv4 without a parser ambiguity.
  if (isIP(v6) === 6) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = -1, b = -1, c = -1] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
}

export function browserUrl(raw: string, extra: readonly string[]): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("browser URL must be absolute HTTP or HTTPS"); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || isIP(host.replace(/^\[|\]$/g, "")) !== 0 || privateAddress(host))
    throw new Error("browser URL must be a public HTTP or HTTPS page without credentials");
  if ([...DENIED, ...extra].some((domain) => host === domain || host.endsWith(`.${domain}`)))
    throw new Error("browser domain is blocked on this machine");
  return url.href;
}

/** Check every browser request, including subresources and redirects, before Chromium handles it. */
export async function browserRequestUrl(raw: string, extra: readonly string[],
  resolve: typeof lookup = lookup): Promise<string> {
  return (await browserRequestAddress(raw, extra, resolve)).url;
}

export async function browserRequestAddress(raw: string, extra: readonly string[],
  resolve: typeof lookup = lookup): Promise<{ url: string; address: string; family: number }> {
  const safe = browserUrl(raw, extra);
  const addresses = await resolve(new URL(safe).hostname, { all: true, verbatim: true });
  const publicV4 = addresses.filter(({ address }) => isIP(address) === 4 && !privateAddress(address));
  if (!publicV4.length)
    throw new Error("browser request resolves to a local or private address");
  return { url: safe, address: publicV4[0]!.address, family: 4 };
}

export interface Control { role: string; name: string; type: string; download?: boolean; autocomplete?: string;
  id?: string; fieldName?: string; label?: string; placeholder?: string; ariaLabel?: string; href?: string; scriptHandler?: boolean; form?: string }
const SENSITIVE_NAMES = ["password", "passcode", "passphrase", "secret", "token", "apikey", "privatekey",
  "recovery", "seed", "securityanswer", "onetimecode", "securitycode", "cvv", "cvc", "csc",
  "card", "credit", "debit", "iban", "routing", "accountnumber", "expiry", "expir"];
function sensitiveName(value: string): boolean {
  const words = value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/^\d+|\d+$/g, "");
  const collapsed = words.replace(/[\s_.-]+/g, "");
  return SENSITIVE_NAMES.some((pattern) => collapsed.includes(pattern))
    || /(?:^|[\s_.-])(?:cc|pan|pin|otp)(?=$|[\s_.-])/.test(words);
}
export function secretField(c: Pick<Control, "name" | "type" | "autocomplete" | "id" | "fieldName" | "label" | "placeholder" | "ariaLabel">): boolean {
  return c.type === "password" || [c.name, c.id, c.fieldName, c.label, c.placeholder, c.ariaLabel, c.autocomplete]
    .some((value) => !!value && sensitiveName(value));
}
export function sensitiveValue(value: string, c: Pick<Control, "name" | "id" | "fieldName" | "label">): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(digits)) {
    let sum = 0;
    for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
      let n = Number(digits[i]);
      if (double) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    if (sum % 10 === 0) return true;
  }
  return /^\d{3,4}$/.test(value) && [c.name, c.id, c.fieldName, c.label].some((name) =>
    !!name && /securitycode|cvv|cvc|csc/.test(name.toLowerCase().replace(/[\s_.-]+/g, "")));
}
export class BrowserQuota {
  private readonly actions = new Map<string, number[]>();
  constructor(private readonly file?: string) {}

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("browser quota store is invalid");
    this.actions.clear();
    for (const [key, times] of Object.entries(parsed)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(times) || !times.every((n) => Number.isSafeInteger(n) && n >= 0))
        throw new Error("browser quota store is invalid");
      this.actions.set(key, times);
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(Object.fromEntries(this.actions)), { mode: 0o600, flag: "wx" });
    renameSync(temp, this.file);
  }

  take(key: string, now = Date.now()): void {
    this.load();
    const quotaKey = this.file ? createHash("sha256").update(key).digest("hex") : key;
    for (const [oldKey, times] of this.actions) {
      const live = times.filter((at) => now - at < 3_600_000);
      if (live.length) this.actions.set(oldKey, live); else this.actions.delete(oldKey);
    }
    const recent = this.actions.get(quotaKey) ?? [];
    if (recent.length >= 60) throw new Error("browser rate limit: 60 actions per conversation per hour");
    this.actions.set(quotaKey, [...recent, now]);
    this.save();
  }
}

export function seatMayBrowse(enabled: boolean, allowed: readonly string[], seat: string): boolean {
  return enabled && seat !== SEATS_AGENT && isSeatAgent(seat) && allowed.includes(seat);
}
