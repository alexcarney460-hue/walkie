#!/usr/bin/env bun
// Issues a team-bound license key by hand (comp licenses, support; the offline path that needs no
// activation code): signs with the vendor key at ~/keys/walkie-license-signing.key and prints the key
// on stdout. The key names one team (`walkie who` shows the team id) and activates only there. It is
// checked against the production verifier (the embedded vendor public key) before it is printed; a
// one-line summary goes to stderr. Never commit or log the output of this script. A comp license has
// no renewal token: issue a new one before it expires.
//
//   bun scripts/issue-license.ts --team 0123456789abcdef --plan team --seats 3 --email ops@example.com --days 35
//                                [--interval month|year] [--lic-id comp_acme] [--key-file path]
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LicenseInterval, LicensePlan, TEAM_ID, verifyLicense, type LicensePayload } from "../src/license/format.ts";
import { DAY_MS } from "../src/license/plans.ts";
import { signLicense } from "../src/license/sign.ts";

function flags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    out.set(a.slice(2), v);
    i++;
  }
  return out;
}

function main(): number {
  const f = flags(process.argv.slice(2));
  const plan = LicensePlan.parse(f.get("plan") ?? "team");
  const interval = LicenseInterval.parse(f.get("interval") ?? "month");
  const seats = Number(f.get("seats") ?? "");
  const days = Number(f.get("days") ?? "35");
  const email = f.get("email") ?? "";
  const team = f.get("team") ?? "";
  if (!TEAM_ID.test(team)) throw new Error("--team is required: the team id (16 hex characters, shown by `walkie who`)");
  if (!Number.isInteger(seats) || seats < 1) throw new Error("--seats must be a whole number >= 1");
  if (!Number.isFinite(days) || days <= 0 || days > 3660) throw new Error("--days must be 1..3660");
  if (!email.includes("@")) throw new Error("--email is required");
  const keyFile = f.get("key-file") ?? join(homedir(), "keys", "walkie-license-signing.key");
  if ((statSync(keyFile).mode & 0o077) !== 0) process.stderr.write(`warning: ${keyFile} is readable by others (chmod 600 it)\n`);
  const now = Date.now();
  const payload: LicensePayload = {
    v: 2, kind: "license", lic_id: f.get("lic-id") ?? `comp_${randomBytes(8).toString("hex")}`, plan, seats, email,
    interval, issued_at: now, expires_at: now + Math.round(days * DAY_MS), team,
  };
  const key = signLicense(payload, readFileSync(keyFile, "utf8"));
  const check = verifyLicense(key);
  if (!check.ok) throw new Error(`the signing key does not match the embedded vendor public key (${check.reason})`);
  process.stderr.write(`valid: team=${check.payload.team} plan=${check.payload.plan} seats=${check.payload.seats} expires=${new Date(check.payload.expires_at).toISOString()} lic_id=${check.payload.lic_id}\n`);
  process.stdout.write(key + "\n");
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`issue-license: ${(err as Error).message}\n`);
  process.exit(1);
}
