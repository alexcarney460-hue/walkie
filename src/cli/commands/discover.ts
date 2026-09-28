// Read-only process census: no daemon connection, store, config, or session-state writes.
import { AgentDiscovery } from "../../daemon/discovery.ts";
import { createLogger } from "../../daemon/logger.ts";
import { bool, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { safeTerm } from "../format.ts";

export async function discover(ctx: Ctx): Promise<number> {
  if (!bool(ctx.args, "once")) throw new UsageError("discover requires --once");
  const scanner = new AgentDiscovery(undefined, createLogger({}), { home: "", unnamedMinAgeMs: 0 });
  const report = await scanner.report();
  ctx.out(ctx.json ? JSON.stringify(report) : report.agents.map((a) =>
    `${a.pid}\t${a.runtime} · ${a.launch}\t${a.state}\t${safeTerm(a.project ?? "unknown project")}\t${a.elapsed_ms === null ? "?" : Math.floor(a.elapsed_ms / 1000)}s`).join("\n"));
  return report.incomplete ? EXIT.error : EXIT.ok;
}
