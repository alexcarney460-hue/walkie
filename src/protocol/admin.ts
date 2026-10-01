// AGENT-ADMIN-1: remote administration over Walkie (PROTOCOL §5 "Admin", §3 `/peer/v1/admin/run`). One generic route
// runs an allow-listed `walkie <command>` on a team machine, never a shell. Who may: a team owner (or an owner's agent)
// on any machine; anyone else on their own machines only. The target's person can refuse it (`walkie admin remote
// off`); a target on an older Walkie answers 404 (`target_outdated`).
import { z } from "zod";
import { isAbsolute } from "node:path";
import { parseArgs, UsageError } from "../cli/args.ts";
import { CLI_BOOLEANS } from "../cli/booleans.ts";
import { profileArgvProblem } from "../daemon/provision/profiles.ts";

/** `walkie <command> <sub>` allowed remotely; "" = the command with no subcommand (its status / list). */
export const REMOTE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  seats: ["", "list", "enable", "allow", "deny", "busy", "resume", "setup-user", "doctor"],
  accounts: ["", "vault", "add", "remove", "policy", "pick", "shims", "allow-proxy", "borrow"],
  pool: ["", "install", "share", "status", "stop", "run"],
  hooks: ["install", "uninstall"],
  // `access` (platform|full) is how much the person's own Claude may do: theirs, like `start --access` (pre.7 merge).
  // `auto` (pre.8, ORCH-2): back to automatic after a start or stop by hand.
  orchestrator: ["start", "stop", "status", "model", "auto"],
  talkie: ["start", "stop", "status", "model", "auto"],
  invite: ["*"],
  team: ["add-machine"],
  direct: ["enable"],
  doctor: [""],
  integrations: ["", "list", "enable", "disable", "run"],
  agents: ["admin"],
  admin: ["", "remote", "log"],
  provision: ["status", "apply"],
};

/** Never remotely, whatever the list above says (defence in depth: they run programs with an account's login). */
const REFUSED_ACCOUNTS: ReadonlySet<string> = new Set(["exec", "trust-cli"]);

/** Options that read the caller's stdin or name a program to run: never over the wire. */
const REFUSED_FLAGS = new Set(["--claude", "--claude-token-stdin", "--key", "--bin-dir"]);

/**
 * Options a remote caller may not set for a given command (AGENT-ADMIN-1 round 3), read from the parsed flags:
 * - seats `--env`: which of the machine's environment variables its seats get (API keys, tokens) stays its person's;
 * - pool install `--dir`: only the default location;
 * - orchestrator start `--permission-mode` / `--cwd` / `--access`: how much the person's own Claude may do, and where;
 * - integrations enable `--key-path`: a key file on that machine is its person's to name.
 */
const REFUSED_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  seats: ["env", "inherit-person-config"],
  "pool install": ["dir"],
  "orchestrator start": ["permission-mode", "cwd", "access"],
  "talkie start": ["permission-mode", "cwd", "access"],
  "integrations enable": ["key-path"],
};

/** Connectors that read a person's private data (meeting transcripts, dictation): never switched on remotely. */
export const PRIVATE_CONNECTORS: ReadonlySet<string> = new Set(["wispr", "fireflies"]);

export const MAX_ARGV = 64;
export const MAX_ARG = 1_000;
export const DEFAULT_REMOTE_TIMEOUT_S = 300;
export const MAX_REMOTE_TIMEOUT_S = 1_800;
/** Each of stdout / stderr the target returns. */
export const MAX_REMOTE_OUTPUT = 64 * 1024;

/**
 * Why `argv` (without the leading "walkie") can't run remotely, or null. The switches may only be turned OFF remotely
 * (`agents admin off`, `admin remote off`): turning them on stays the machine's person's, at that machine.
 */
export function remoteArgvProblem(argv: readonly string[]): string | null {
  if (!argv.length) return "no command";
  if (argv.length > MAX_ARGV) return `at most ${MAX_ARGV} arguments`;
  for (const a of argv) {
    if (a.length > MAX_ARG || /[\0\r\n]/.test(a)) return "an argument is too long or has a line break";
  }
  const cmd = argv[0] as string;
  if (cmd === "provision") return profileArgvProblem(argv.slice(1));
  const subs = REMOTE_COMMANDS[cmd];
  if (!subs) return `walkie ${cmd} can't run remotely (allowed: ${Object.keys(REMOTE_COMMANDS).join(", ")})`;
  // The subcommand exactly as the walkie that runs it parses it (fix round 2, Opus HIGH): its own parser, its own
  // switch list, so a leading flag (`accounts --json exec`) can't hide the subcommand from this check.
  let pos: readonly string[];
  let flags: ReadonlyMap<string, string | true>;
  try {
    ({ pos, flags } = parseArgs(argv.slice(1), CLI_BOOLEANS));
  } catch (err) {
    return `the arguments don't parse (${err instanceof UsageError ? err.message : "invalid"})`;
  }
  const sub = pos[0] ?? "";
  if (!subs.includes("*") && !subs.includes(sub)) return `walkie ${cmd} ${sub || "(no subcommand)"} can't run remotely (allowed: ${subs.map((s) => s || "(none)").join(", ")})`;
  if (cmd === "seats" && flags.has("same-user") && (sub === "allow" || sub === "enable")) return "seat mode migration cannot run remotely: the machine's person runs walkie seats migrate --same-user there";
  if (cmd === "accounts" && REFUSED_ACCOUNTS.has(sub)) return `walkie accounts ${sub} can't run remotely (it runs a program with an account's credential)`;
  for (const a of argv) {
    const flag = a.split("=")[0] as string;
    if (REFUSED_FLAGS.has(flag)) return `${flag} can't be used remotely (it reads your terminal or names a program)`;
    if (a === "-") return "\"-\" (read stdin) can't be used remotely";
  }
  for (const key of [cmd, `${cmd} ${sub}`]) {
    for (const opt of REFUSED_OPTIONS[key] ?? []) {
      if (flags.has(opt)) return `--${opt} can't be used remotely with walkie ${key} (the machine's person sets it there)`;
    }
  }
  // seats allow --dir a/relative/path would resolve against the spawned admin run's own working directory on the
  // TARGET, not anything the caller meant: refused rather than silently wrong (a leading "~" is fine, expanded
  // against the target's own daemon user by seats/host.ts).
  if (cmd === "seats" && sub === "allow") {
    const dir = flags.get("dir");
    if (typeof dir === "string" && dir !== "~" && !dir.startsWith("~/") && !isAbsolute(dir)) {
      return "seats allow --dir must be an absolute path or start with ~/ when run remotely (the target's own working directory isn't meaningful here)";
    }
  }
  if (cmd === "integrations" && sub === "enable" && PRIVATE_CONNECTORS.has(pos[1] ?? "")) {
    return `walkie integrations enable ${pos[1]} can't run remotely: it reads the machine's person's private data (their meetings); they turn it on themselves`;
  }
  if (cmd === "invite" && flags.get("role") === "owner") return "an owner invite can't be minted remotely (a person at an owner's machine does that)";
  const third = pos[1];
  if ((cmd === "agents" || (cmd === "admin" && sub === "remote")) && third !== undefined && third !== "status" && third !== "off") {
    return "an admin switch can only be turned off remotely (its person turns it back on at the machine)";
  }
  if (cmd === "admin" && argv.some((a) => /^--machines?(=|$)/.test(a))) return "a remote admin command can't reach on to further machines";
  if (cmd === "accounts" && sub === "add" && pos[1] === "codex") return "walkie accounts add codex signs in through a browser at the machine: run it there";
  return null;
}

/**
 * The command in canonical form, `[command, --flag=value…, --switch…, "--", positional…]`: what the target validates
 * is exactly what it runs (fix round 2, Codex HIGH 1). The walkie that runs it parses this back to the same positionals
 * and flags (test/unit/agent-admin.test.ts checks the round trip). Null when it doesn't parse.
 */
export function canonicalArgv(argv: readonly string[]): string[] | null {
  if (!argv.length) return null;
  // The provision grammar is already exact; the global parser treats `--profile` as a boolean for accounts shims.
  if (argv[0] === "provision") return profileArgvProblem(argv.slice(1)) ? null : [...argv];
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs(argv.slice(1), CLI_BOOLEANS); } catch { return null; }
  const flags = [...parsed.flags].map(([k, v]) => (v === true ? `--${k}` : `--${k}=${v}`));
  return [argv[0] as string, ...flags, "--", ...parsed.pos];
}

/**
 * What the target's roster rules out (round 3): an invite or add-machine code that would admit a machine as an OWNER
 * (a current owner's handle keeps its role). `roleOf` answers the current role of a handle, or null.
 */
export function remoteRosterProblem(argv: readonly string[], roleOf: (handle: string) => string | null): string | null {
  if (argv[0] === "provision") return profileArgvProblem(argv.slice(1));
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs(argv.slice(1), CLI_BOOLEANS); } catch { return "the arguments don't parse"; }
  const handle = argv[0] === "team" && parsed.pos[0] === "add-machine" ? parsed.pos[1]
    : argv[0] === "invite" ? (typeof parsed.flags.get("handle") === "string" ? parsed.flags.get("handle") as string : undefined) : undefined;
  if (handle && roleOf(handle.replace(/^@/, "")) === "owner") return `a code for @${handle.replace(/^@/, "")} would admit an owner's machine: that is minted by a person at an owner's machine, not remotely`;
  return null;
}

export const RemoteRunReq = z.object({
  argv: z.array(z.string().max(MAX_ARG)).min(1).max(MAX_ARGV),
  /** The caller's agent (its name, or its runtime + "(unnamed)"); absent = a person. */
  agent: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._() -]*$/).optional(),
  timeout_s: z.number().int().min(1).max(MAX_REMOTE_TIMEOUT_S).optional(),
}).strict();
export type RemoteRunReq = z.infer<typeof RemoteRunReq>;

export const RemoteRunRes = z.object({
  machine: z.string().max(100), exit: z.number().int(), stdout: z.string(), stderr: z.string(), truncated: z.boolean(), timed_out: z.boolean(),
}).passthrough();
export type RemoteRunRes = z.infer<typeof RemoteRunRes>;

/** Machine-readable reasons a remote admin call didn't run (the CLI's --json `error.code`). */
export const REMOTE_ERRORS = {
  target_outdated: "that machine runs a Walkie without remote admin (v0.2.0-pre.6 or older): update it first",
  remote_admin_off: "remote admin is switched off on that machine by its person",
  agent_admin_off: "agent admin is switched off by that machine's person",
  not_your_machine: "only a team owner may administer another person's machine",
  not_allowed_remotely: "that command isn't on the remote admin allow-list",
  unreachable: "that machine isn't reachable right now",
} as const;
