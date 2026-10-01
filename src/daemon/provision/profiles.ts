/** Fixed profile metadata ships with Walkie. Remote callers may select only an id. */
export type ProfileId = "developer-worker" | "freight-worker";
export type StepKind = "check" | "node_archive" | "npm_locked" | "installer_elevation";
export interface Step {
  readonly id: string;
  readonly kind: StepKind;
  readonly version: string;
  readonly command?: string;
  readonly package?: string;
  readonly destructive: boolean;
}
export interface Profile { readonly id: ProfileId; readonly version: number; readonly steps: readonly Step[] }

const developer: readonly Step[] = [
  { id: "walkie-daemon", kind: "check", version: "current-release", command: "walkie", destructive: false },
  { id: "bun", kind: "check", version: "1.3", command: "bun", destructive: false },
  { id: "node", kind: "node_archive", version: "22.20.0", command: "node", destructive: true },
  { id: "pnpm", kind: "npm_locked", version: "10.34.3", command: "pnpm", package: "pnpm", destructive: true },
  { id: "claude-code", kind: "npm_locked", version: "2.1.285", command: "claude", package: "@anthropic-ai/claude-code", destructive: true },
  { id: "codex", kind: "npm_locked", version: "0.159.1", command: "codex", package: "@openai/codex", destructive: true },
  { id: "git", kind: "installer_elevation", version: "2.30", command: "git", destructive: false },
  { id: "build-tools", kind: "installer_elevation", version: "3.81", command: "make", destructive: false },
  { id: "jq", kind: "installer_elevation", version: "1.6", command: "jq", destructive: false },
  { id: "age", kind: "installer_elevation", version: "1.0", command: "age", destructive: false },
  { id: "openssh", kind: "installer_elevation", version: "8.0", command: "ssh", destructive: false },
  { id: "openssl", kind: "installer_elevation", version: "1.1", command: "openssl", destructive: false },
  { id: "unzip", kind: "installer_elevation", version: "6.0", command: "unzip", destructive: false },
] as const;

export const PROFILES: Readonly<Record<ProfileId, Profile>> = {
  "developer-worker": { id: "developer-worker", version: 3, steps: developer },
  "freight-worker": { id: "freight-worker", version: 3, steps: [
    ...developer,
    { id: "postgres-client", kind: "installer_elevation", version: "16", command: "psql", destructive: true },
    { id: "postgres-server", kind: "installer_elevation", version: "16", command: "postgres", destructive: true },
    { id: "chromium-deps", kind: "installer_elevation", version: "1", destructive: true },
  ] },
};

export function profile(id: string): Profile | null { return Object.hasOwn(PROFILES, id) ? PROFILES[id as ProfileId] : null; }

/** Exact remote grammar. No generic CLI flag parser may expand it. */
function parseProfileArgv(args: readonly string[]): { id: ProfileId | null; problem: string | null } {
  if (args[0] !== "status" && args[0] !== "apply") return { id: null, problem: "provision permits status or apply only" };
  if (args.includes("--profile") && args[args.indexOf("--profile") + 1] === "--json") {
    return { id: null, problem: "--profile requires its value before --json" };
  }
  const rest = args.slice(1).filter((a) => a !== "--json");
  if (args.filter((a) => a === "--json").length > 1) return { id: null, problem: "duplicate --json" };
  const pair = rest.length === 2 && rest[0] === "--profile" ? rest[1]
    : rest.length === 1 && rest[0]?.startsWith("--profile=") ? rest[0].slice(10) : null;
  if (!pair) return { id: null, problem: "name exactly one --profile <fixed-id>" };
  return profile(pair) ? { id: pair as ProfileId, problem: null } : { id: null, problem: "unknown provisioning profile" };
}

export function profileArgvProblem(args: readonly string[]): string | null { return parseProfileArgv(args).problem; }
export function profileIdFromArgv(args: readonly string[]): ProfileId | null {
  return parseProfileArgv(args).id;
}
