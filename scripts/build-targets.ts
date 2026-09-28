// Which targets scripts/build.ts compiles (kept apart so tests can import it; build.ts runs on import).
//   (no flag)                                   → this machine's target
//   --all                                       → every release target (darwin-x64 needs a cargo compile)
//   --targets darwin-arm64,linux-x64,linux-arm64 → that list (prereleases: n0's prebuilt iroh modules only)

export const ALL_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;

/** `bun-<os>-<arch>` targets for `bun build --compile`, from build.ts's arguments. */
export function buildTargets(argv: readonly string[], platform: string, arch: string): string[] {
  const all = argv.includes("--all");
  const i = argv.findIndex((a) => a === "--targets" || a.startsWith("--targets="));
  if (i === -1) return all ? ALL_TARGETS.map((t) => `bun-${t}`) : [`bun-${platform}-${arch}`];
  if (all) throw new Error("use --all or --targets, not both");
  const arg = argv[i] as string;
  const raw = arg.startsWith("--targets=") ? arg.slice("--targets=".length) : (argv[i + 1] ?? "");
  const list = [...new Set(raw.split(",").map((t) => t.trim()).filter(Boolean))];
  if (list.length === 0) throw new Error(`--targets: no targets given (from ${ALL_TARGETS.join(", ")})`);
  for (const t of list) {
    if (!(ALL_TARGETS as readonly string[]).includes(t)) throw new Error(`--targets: unknown target ${t} (from ${ALL_TARGETS.join(", ")})`);
  }
  return list.map((t) => `bun-${t}`);
}
