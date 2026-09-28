// Account ids and the only labels that leave this machine: masked emails, known plan words and model names
// (protocol/accounts.ts MASKED_EMAIL_RE / PLAN_RE / MODEL_SCOPE_RE). Anything else a provider sends becomes null.
import { createHash } from "node:crypto";
import { MODEL_SCOPE_RE, PLAN_RE, type AccountProvider } from "../protocol/accounts.ts";

/** sha256(provider | ids…), first 24 hex. Stable across machines for the same provider account. */
export function accountId(provider: AccountProvider, ...ids: string[]): string {
  return createHash("sha256").update([provider, ...ids].join("|")).digest("hex").slice(0, 24);
}

/** A provider's model display name ("Opus", "Sonnet 4.5") when it is one; anything else is null. */
export function modelScope(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return MODEL_SCOPE_RE.test(t) ? t : null;
}

const PLAN_WORDS: Record<string, string> = {
  free: "Free", go: "Go", plus: "Plus", pro: "Pro", max: "Max", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu",
};

/** A provider plan string ("pro", "Plus") as a known plan word; anything else is null. */
function planWord(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const w = PLAN_WORDS[s.trim().toLowerCase()];
  return w && PLAN_RE.test(w) ? w : null;
}

/** "alice.walker@gmail.com" → "al***@gm***.com". Never more than two characters of either part. */
export function maskEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  const local = email.slice(0, at).replace(/[^A-Za-z0-9]/g, "");
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = (dot > 0 ? domain.slice(0, dot) : domain).replace(/[^A-Za-z0-9]/g, "");
  const tld = dot > 0 ? domain.slice(dot + 1).replace(/[^A-Za-z]/g, "").slice(0, 6) : "";
  if (!local || !host) return null;
  return `${local.slice(0, 2)}***@${host.slice(0, 2)}***${tld ? `.${tld}` : ""}`;
}

/** Claude's rate-limit tier ("default_claude_max_20x") or subscription ("max") as a short plan label. */
export function claudePlan(tier: unknown, subscription?: unknown): string | null {
  const t = typeof tier === "string" ? tier.toLowerCase() : "";
  const m = /max_(\d+)x/.exec(t);
  if (m) return `Max ${m[1]}x`;
  if (t.includes("max")) return "Max";
  if (t.includes("pro")) return "Pro";
  if (t.includes("team")) return "Team";
  if (t.includes("enterprise")) return "Enterprise";
  return planWord(subscription);
}

/** "pro" → "Pro"; only known plan words (anything else is null). */
export function titlePlan(plan: unknown): string | null {
  return planWord(plan);
}
