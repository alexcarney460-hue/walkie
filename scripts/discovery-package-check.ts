// Read-only release check. Build dist/walkie-darwin-arm64 before running this script.
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const binary = join(root, "dist", "walkie-darwin-arm64");
const probeBinary = join(root, "dist", "discovery-worker-probe");

function report(argv: string[]): { agents: Array<{ pid: number; project?: string }> } {
  const run = Bun.spawnSync(argv, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0 && run.exitCode !== 1) throw new Error(`${argv[0]} discover exited ${run.exitCode}`);
  const stdout = new TextDecoder().decode(run.stdout);
  const value = JSON.parse(stdout) as { agents?: Array<{ pid: number; project?: string }> };
  if (!Array.isArray(value.agents)) throw new Error(`${argv[0]} did not return agents`);
  return { agents: value.agents };
}

const source = report(["bun", join(root, "src", "cli", "main.ts"), "discover", "--once", "--json"]);
const compiled = report([binary, "discover", "--once", "--json"]);
const byPid = new Map(source.agents.map((agent) => [agent.pid, agent.project]));
const shared = compiled.agents.filter((agent) => byPid.has(agent.pid));
const regressions = shared.filter((agent) => agent.project !== byPid.get(agent.pid));
const unknown = shared.filter((agent) => agent.project === undefined && byPid.get(agent.pid) !== undefined);
const projects = (agents: typeof source.agents) => [...new Set(agents.map((agent) => agent.project ?? "unknown project"))].sort();
const buildProbe = Bun.spawnSync(["bun", "build", "--compile", "--target=bun-darwin-arm64",
  "--define", "WALKIE_EMBEDDED=true", join(root, "src", "cli", "discovery-worker-probe.ts"),
  join(root, "src", "daemon", "discovery-files-worker.ts"), "--outfile", probeBinary],
{ cwd: root, stdout: "pipe", stderr: "pipe" });
if (buildProbe.exitCode !== 0) throw new Error("compiled discovery worker probe failed to build");
const probeRun = Bun.spawnSync([probeBinary], { cwd: root, stdout: "pipe", stderr: "pipe" });
const probe = JSON.parse(new TextDecoder().decode(probeRun.stdout)) as
  { constructed: number; errors: number; contextReturned: boolean };
const result = { source: { agents: source.agents.length, projects: projects(source.agents) },
  compiled: { agents: compiled.agents.length, projects: projects(compiled.agents) },
  sharedPids: shared.length, projectRegressions: regressions.length, unknownRegressions: unknown.length,
  workerProbe: probe };
console.log(JSON.stringify(result));
if (!shared.length || regressions.length || unknown.length || probeRun.exitCode !== 0
  || probe.constructed !== 1 || probe.errors !== 0 || !probe.contextReturned) process.exit(1);
