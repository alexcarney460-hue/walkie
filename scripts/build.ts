// Build single-file `walkie` binaries with the dashboard and the Walkie Direct (iroh) native module embedded.
//   bun scripts/build.ts            → current platform only
//   bun scripts/build.ts --all      → darwin-arm64, darwin-x64, linux-x64, linux-arm64
//   bun scripts/build.ts --targets darwin-arm64,linux-x64,linux-arm64   → that list (prereleases skip darwin-x64,
//                                     which needs a cargo compile; scripts/build-targets.ts)
// Generates src/daemon/embedded.gen.ts (gitignored) mapping URL path → embedded file, which the static handler
// prefers over web/dist on disk, and, per target, src/daemon/direct/iroh-native.gen.ts (gitignored, removed after
// the build) with a static require of that target's iroh `.node` file, which `bun build --compile` embeds.
//
// The iroh module is n0's official Node-API SDK, @number0/iroh (pinned in package.json):
//   darwin-arm64, linux-x64, linux-arm64: n0's prebuilt package for the target (glibc on Linux), fetched with
//     `npm pack` (registry integrity) and checked against scripts/iroh-napi/SHA256SUMS.
//   darwin-x64: n0 publishes no prebuilt; it is compiled here from the SDK's own Rust sources (shipped in the npm
//     package) with scripts/iroh-napi/Cargo.lock, for x86_64-apple-darwin (needs cargo and
//     `rustup target add x86_64-apple-darwin`; a macOS host).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildTargets } from "./build-targets.ts";
import { checkBuilt, parsePins, reuseCached, sha256File as sha256 } from "./iroh-cache.ts";

const root = join(import.meta.dir, "..");
const dist = join(root, "web", "dist");
const gen = join(root, "src", "daemon", "embedded.gen.ts");
const irohGen = join(root, "src", "daemon", "direct", "iroh-native.gen.ts");
const cache = join(root, ".cache", "iroh");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function run(cmd: string[], cwd = root): void {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${p.exitCode})`);
}

const irohVersion = (JSON.parse(readFileSync(join(root, "node_modules", "@number0", "iroh", "package.json"), "utf8")) as { version: string }).version;
const pins = parsePins(readFileSync(join(root, "scripts", "iroh-napi", "SHA256SUMS"), "utf8"));

/** n0's prebuilt module for a target, from the npm registry, verified against the pinned SHA-256. */
function prebuilt(pkgTarget: string): string {
  const file = `iroh.${pkgTarget}.node`;
  const dir = join(cache, irohVersion, pkgTarget);
  const out = join(dir, "package", file);
  if (!existsSync(out)) {
    mkdirSync(dir, { recursive: true });
    const p = Bun.spawnSync(["npm", "pack", "--silent", `@number0/iroh-${pkgTarget}@${irohVersion}`], { cwd: dir, stdout: "pipe", stderr: "inherit" });
    if (p.exitCode !== 0) throw new Error(`npm pack @number0/iroh-${pkgTarget}@${irohVersion} failed`);
    const tgz = new TextDecoder().decode(p.stdout).trim().split("\n").pop() as string;
    run(["tar", "-xzf", tgz], dir);
  }
  const want = pins.get(`${irohVersion}/${file}`);
  const got = sha256(out);
  if (!want) throw new Error(`no pinned SHA-256 for ${irohVersion}/${file} in scripts/iroh-napi/SHA256SUMS (got ${got})`);
  if (got !== want) throw new Error(`${file}: SHA-256 ${got} does not match the pin ${want}`);
  return out;
}

/**
 * darwin-x64: compile the SDK's own crate (n0 ships no prebuilt for Intel Macs). A cached compile is reused only
 * when it matches a `<version>/iroh.darwin-x64.node` pin in SHA256SUMS; otherwise it is rebuilt from a clean crate.
 */
function builtFromSource(): string {
  const file = "iroh.darwin-x64.node";
  const out = join(cache, irohVersion, "darwin-x64", file);
  const want = pins.get(`${irohVersion}/${file}`);
  if (reuseCached(out, want)) return out;
  const src = join(cache, irohVersion, "darwin-x64", "crate");
  const sdk = join(root, "node_modules", "@number0", "iroh");
  rmSync(src, { recursive: true, force: true });
  mkdirSync(join(src, "src"), { recursive: true });
  for (const f of readdirSync(join(sdk, "src"))) copyFileSync(join(sdk, "src", f), join(src, "src", f));
  copyFileSync(join(sdk, "build.rs"), join(src, "build.rs"));
  copyFileSync(join(sdk, "Cargo.toml"), join(src, "Cargo.toml"));
  appendFileSync(join(src, "Cargo.toml"), '\n[profile.release]\nstrip = true\nlto = "thin"\n');
  copyFileSync(join(root, "scripts", "iroh-napi", "Cargo.lock"), join(src, "Cargo.lock"));
  run(["cargo", "build", "--release", "--locked", "--target", "x86_64-apple-darwin"], src);
  copyFileSync(join(src, "target", "x86_64-apple-darwin", "release", "libnumber0_iroh.dylib"), out);
  const got = checkBuilt(out, file, want);
  if (!want) console.log(`${file} built from source, SHA-256 ${got} (unpinned: the next build compiles it again)`);
  return out;
}

function irohModule(os: string, arch: string): string {
  if (os === "darwin" && arch === "arm64") return prebuilt("darwin-arm64");
  if (os === "darwin" && arch === "x64") return builtFromSource();
  if (os === "linux" && arch === "x64") return prebuilt("linux-x64-gnu");
  if (os === "linux" && arch === "arm64") return prebuilt("linux-arm64-gnu");
  throw new Error(`no iroh module for ${os}-${arch}`);
}

let files: string[] = [];
try {
  files = walk(dist);
} catch {
  console.error("web/dist missing — run `bun run web:build` first");
  process.exit(1);
}

const lines = [
  "// @ts-nocheck -- GENERATED by scripts/build.ts; do not edit, not committed.",
  ...files.map((f, i) => `import f${i} from ${JSON.stringify("../../" + relative(root, f))} with { type: "file" };`),
  "export const EMBEDDED: Record<string, string> = {",
  ...files.map((f, i) => `  ${JSON.stringify("/" + relative(dist, f))}: f${i},`),
  "};",
  "",
];
writeFileSync(gen, lines.join("\n"));

const targets = buildTargets(process.argv.slice(2), process.platform, process.arch);
mkdirSync(join(root, "dist"), { recursive: true });

const version = (await Bun.file(join(root, "package.json")).json()).version as string;
try {
  for (const target of targets) {
    const [, os, arch] = target.split("-") as [string, string, string];
    const native = irohModule(os, arch);
    writeFileSync(irohGen, [
      "// @ts-nocheck -- GENERATED by scripts/build.ts for one target; do not edit, not committed.",
      `export default () => require(${JSON.stringify(relative(join(root, "src", "daemon", "direct"), native))});`,
      "",
    ].join("\n"));
    const out = join(root, "dist", `walkie-${os}-${arch === "x64" ? "x86_64" : arch}`);
    // No .env / bunfig.toml / tsconfig / package.json of the working directory is ever loaded by the release binary:
    // a project's files must never set Walkie's own environment when `walkie` runs inside it (ACCOUNTS-2 round 4,
    // Codex 1), and it also runs as root (the seat-admin helper) and as seat users (seats, Opus r6 LOW 3).
    const p = Bun.spawnSync(["bun", "build", "--compile", "--minify", `--target=${target}`,
      "--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv", "--no-compile-autoload-tsconfig", "--no-compile-autoload-package-json",
      `--define`, `WALKIE_VERSION=${JSON.stringify(version)}`, "--define", "WALKIE_EMBEDDED=true",
      // Workers are separate entry points, served relative to the bundle root (src/) in the binary.
      join(root, "src", "cli", "main.ts"), join(root, "src", "daemon", "machine-stats", "thermal-worker.ts"),
      join(root, "src", "daemon", "discovery-files-worker.ts"),
      "--outfile", out], { stdout: "inherit", stderr: "inherit" });
    if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
    console.log(`built ${relative(root, out)} (iroh ${irohVersion}: ${relative(root, native)})`);
  }
} finally {
  // Source runs load the SDK from node_modules for the host; a leftover target module would break them.
  rmSync(irohGen, { force: true });
}
