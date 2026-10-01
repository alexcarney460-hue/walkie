// Adversarial probe P1: authorization function + remote argv grammar vs the CLI child's own parse.
// Pure functions only. No network, no spawn.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalArgv, remoteArgvProblem } from "../../src/protocol/admin.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { PROFILES, profile, profileArgvProblem, profileIdFromArgv } from "../../src/daemon/provision/profiles.ts";
import { authorizeProvision, createGrant, readGrant, type Grant } from "../../src/daemon/provision/grant.ts";


const base: Grant = {
  team_id: "team-1", owner_node: "alex-node", target_node: "target-node", recipient: "kira", consent_text: "x", consent_version: 1, company_mode: true,
  launchers: ["@alex"], seat_cap: 3, profiles: [{ id: "developer-worker", version: PROFILES["developer-worker"].version }], created_at: Date.now(), expires_at: Date.now() + 90 * 86400_000,
};
const ctx = (extra: Record<string, unknown> = {}) => ({
  grant: base, teamId: "team-1", targetHandle: "kira", targetNode: "target-node", ownerHandle: "alex", actorHandle: "alex", actorNode: "alex-node", actorRole: "owner",
  ownerNodeCurrent: true, remoteAdmin: true, agentAdmin: true, profile: "developer-worker", ...extra,
});

test("F1: only the named owner passes", () => {
  // Noor: a different owner (different node, different handle) who is not named in the consent text.
  const noor = authorizeProvision(ctx({ actorHandle: "noor", actorNode: "noor-node", actorRole: "owner" }));
  console.log("F1 result for an un-named second owner:", noor);
  expect(noor).toBe("owner_not_consented");
  // a launcher that is NOT the named owner and NOT an owner is refused (control)
  expect(authorizeProvision(ctx({ actorHandle: "bob", actorNode: "bob-node", actorRole: "member" }))).toBe("not_authorized");
});

test("named launchers are not remote provision owners", () => {
  for (const l of ["alex", " @alex", "@alex/alex-mbp", "@ALEX"]) {
    const g = { ...base, launchers: [l] };
    const out = authorizeProvision(ctx({ grant: g, actorHandle: "alex", actorNode: "alex-node", actorRole: "member" }));
    console.log("launcher form", JSON.stringify(l), "->", out);
    expect(out).toBe("not_authorized");
  }
  expect(authorizeProvision(ctx({ grant: { ...base, launchers: ["@alex"] }, actorRole: "member" }))).toBe("not_authorized");
});

test("grant file: symlink, loose mode, unknown field, wrong types all fail closed", () => {
  const p = mkdtempSync("/tmp/enprov-p1-");
  try {
    const path = join(p, "provision-grant.json");
    // loose mode
    writeFileSync(path, JSON.stringify(base) + "\n", { mode: 0o644 }); chmodSync(path, 0o644);
    expect(() => readGrant(p)).toThrow();
    // symlink
    rmSync(path); writeFileSync(join(p, "real.json"), JSON.stringify(base), { mode: 0o600 }); symlinkSync(join(p, "real.json"), path);
    expect(() => readGrant(p)).toThrow();
    rmSync(path);
    // unknown field
    writeFileSync(path, JSON.stringify({ ...base, extra: 1 }) + "\n", { mode: 0o600 });
    expect(() => readGrant(p)).toThrow();
    // company_mode false
    writeFileSync(path, JSON.stringify({ ...base, company_mode: false }) + "\n", { mode: 0o600 });
    expect(() => readGrant(p)).toThrow();
    // profile not in enum
    writeFileSync(path, JSON.stringify({ ...base, profiles: [{ id: "custom", version: 2 }] }) + "\n", { mode: 0o600 });
    expect(() => readGrant(p)).toThrow();
    // createGrant refuses unknown version
    rmSync(path);
    expect(() => createGrant(p, { ...base, profiles: [{ id: "developer-worker", version: 999 }] })).toThrow();
  } finally { rmSync(p, { recursive: true, force: true }); }
});

test("F2: local same-user grant file is an audit record, not human proof", () => {
  const p = mkdtempSync("/tmp/enprov-p1-");
  try {
    writeFileSync(join(p, "provision-grant.json"), JSON.stringify({ ...base, consent_text: "I never saw any consent screen" }) + "\n", { mode: 0o600 });
    const g = readGrant(p);
    console.log("F2 forged grant accepted by readGrant; authorize ->", authorizeProvision(ctx({ grant: g })));
    expect(authorizeProvision(ctx({ grant: g }))).toBeNull();
    // there is no target node id in the grant: schema fields are exactly these
    console.log("F2 grant keys:", Object.keys(g as object).join(","));
  } finally { rmSync(p, { recursive: true, force: true }); }
});

test("profile id lookup: traversal, unicode, prototype names, whitespace all null", () => {
  const evil = ["../developer-worker", "developer-worker/../../x", "developer-worker ", " developer-worker", "Developer-Worker", "developer‐worker", "developer-worker​",
    "developer-worker\0", "__proto__", "constructor", "toString", "hasOwnProperty", "", "developer-worker\n", "developer%2dworker", "developer-worker;id", "*", "all"];
  for (const e of evil) { expect(profile(e)).toBeNull(); expect(profileArgvProblem(["apply", "--profile", e])).not.toBeNull(); expect(profileArgvProblem(["apply", `--profile=${e}`])).not.toBeNull(); }
});

// ---------------------------------------------------------------------------------------------------------
// Exhaustive argv grammar fuzz: what the remote allow-list accepts vs what the CLI child will actually do.
// ---------------------------------------------------------------------------------------------------------
const TOKENS = ["status", "apply", "revoke", "--profile", "--profile=developer-worker", "--profile=freight-worker", "developer-worker", "freight-worker",
  "--json", "--json=false", "--", "--yes", "-", "--profile=", "--url", "--help"];

// The CLI child, exactly as src/cli/main.ts + src/cli/commands/provision.ts decide it (read from the diff).
const NO_PROFILE_BOOL = new Set([...CLI_BOOLEANS].filter((x) => x !== "profile"));
function childDecision(rest: readonly string[]): { ok: boolean; sub?: string; id?: string; why?: string } {
  const problem = rest[0] === "revoke" ? (rest.length === 1 || (rest.length === 2 && rest[1] === "--json") ? null : "revoke takes no other arguments") : profileArgvProblem(rest);
  if (problem) return { ok: false, why: problem };
  let args;
  try { args = parseArgs(rest, NO_PROFILE_BOOL); } catch (e) { return { ok: false, why: (e as Error).message }; }
  if (args.flags.get("help") === true) return { ok: false, why: "help" };
  const sub = args.pos[0];
  if (sub === "revoke") return { ok: true, sub };
  const idv = args.flags.get("profile");
  const sel = typeof idv === "string" ? profile(idv) : null;
  if (!sel) return { ok: false, why: "no profile" };
  if (sub === "status" || sub === "apply") return { ok: true, sub, id: sel.id };
  return { ok: false, why: "usage" };
}

test("F3: exhaustive argv fuzz (<=5 tokens): remote allow-list vs profileIdFromArgv vs the CLI child", () => {
  const found = { allowed: 0, preCheckSkipped: [] as string[][], diverge: [] as { argv: string[]; pre: unknown; child: unknown }[], childProceedsButNoId: [] as string[][], revokeReachable: [] as string[][], canonicalDiffers: [] as string[][] };
  const seen = new Set<string>();
  const walk = (cur: string[], depth: number): void => {
    if (cur.length) {
      const argv = ["provision", ...cur];
      const problem = remoteArgvProblem(argv);
      if (problem === null) {
        found.allowed++;
        const canon = canonicalArgv(argv);
        if (!canon || JSON.stringify(canon) !== JSON.stringify(argv)) found.canonicalDiffers.push(argv);
        const preId = profileIdFromArgv(cur);
        const child = childDecision(cur);
        if (preId === null) found.preCheckSkipped.push(argv);
        if (child.ok && child.sub === "revoke") found.revokeReachable.push(argv);
        if (child.ok && child.id !== undefined && child.id !== preId) found.diverge.push({ argv, pre: preId, child });
        if (child.ok && child.id === undefined && child.sub !== "revoke") found.childProceedsButNoId.push(argv);
      }
    }
    if (depth === 5) return;
    for (const t of TOKENS) walk([...cur, t], depth + 1);
  };
  walk([], 0);
  // de-dupe for printing
  const uniq = (rows: string[][]) => [...new Set(rows.map((r) => JSON.stringify(r)))].filter((s) => !seen.has(s));
  console.log("F3 allowed by remote allow-list:", found.allowed);
  console.log("F3 allowed but profileIdFromArgv()==null:", found.preCheckSkipped.length);
  for (const s of uniq(found.preCheckSkipped).slice(0, 12)) console.log("   ", s);
  console.log("F3 child would run a DIFFERENT profile/sub than the pre-check saw:", found.diverge.length, JSON.stringify(found.diverge.slice(0, 5)));
  console.log("F3 child proceeds with no profile id:", found.childProceedsButNoId.length);
  console.log("F3 revoke reachable remotely:", found.revokeReachable.length);
  console.log("F3 canonical differs from input:", found.canonicalDiffers.length);
  expect(found.revokeReachable.length).toBe(0);
  expect(found.diverge.length).toBe(0);
  expect(found.canonicalDiffers.length).toBe(0);
  // Expected finding (LOW): pre-check skipped for `--profile --json <id>` style argv while the child then refuses it.
  expect(found.preCheckSkipped.length).toBe(0);
});

test("F3b: for allowed-but-pre-check-skipped argv the CLI child never proceeds to an API call", () => {
  const skipped: string[][] = [];
  const walk = (cur: string[], depth: number): void => {
    if (cur.length && remoteArgvProblem(["provision", ...cur]) === null && profileIdFromArgv(cur) === null) skipped.push(cur);
    if (depth === 4) return;
    for (const t of TOKENS) walk([...cur, t], depth + 1);
  };
  walk([], 0);
  const proceeding = skipped.filter((c) => { const d = childDecision(c); return d.ok; });
  console.log("F3b skipped argv:", skipped.length, "child proceeds:", proceeding.length, JSON.stringify(proceeding.slice(0, 4)));
  expect(proceeding.length).toBe(0);
});
