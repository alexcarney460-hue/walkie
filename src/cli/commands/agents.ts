// walkie mcp · walkie hook claude|codex · walkie hooks install|uninstall claude|codex
import { runClaudeHook } from "../../hooks/claude.ts";
import { runCodexHook } from "../../hooks/codex.ts";
import { runSwitchHook } from "../../hooks/switch-channel.ts";
import { installClaude, installCodex } from "../../hooks/install.ts";
import { runMcpServer } from "../../mcp/server.ts";
import { bool, need, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c } from "../format.ts";
import { writeOut } from "../stdio.ts";
import { auditLocal } from "../admin-gate.ts";

export async function mcp(_ctx: Ctx): Promise<number> {
  await runMcpServer();
  await new Promise(() => undefined); // serve until stdin closes (the server exits the process)
  return EXIT.ok;
}

/** Hooks must never fail the host agent: always exit 0. */
export async function hook(ctx: Ctx): Promise<number> {
  const runtime = need(ctx.args, 0, "runtime (claude|codex)");
  try {
    if (runtime === "claude") {
      const raw = await Promise.race([new Response(Bun.stdin.stream()).text(), Bun.sleep(1000).then(() => "")]);
      const out = await runClaudeHook(raw);
      if (out) writeOut(out + "\n");
    } else if (runtime === "codex") {
      await runCodexHook(ctx.args.pos[ctx.args.pos.length - 1] ?? "");
    } else if (runtime === "switch") {
      const raw = await Promise.race([new Response(Bun.stdin.stream()).text(), Bun.sleep(1000).then(() => "")]);
      runSwitchHook(raw);
    }
  } catch { /* swallowed by design; see ~/.walkie/logs/hooks.log */ }
  return EXIT.ok;
}

export async function hooks(ctx: Ctx): Promise<number> {
  const action = need(ctx.args, 0, "install|uninstall");
  const target = need(ctx.args, 1, "claude|codex|all");
  if (action !== "install" && action !== "uninstall") throw new UsageError(`unknown action ${action}`);
  if (target === "all") {
    // Every runtime Walkie connects (AGENT-ADMIN-1: one call for an agent setting a machine up).
    for (const t of ["claude", "codex"]) {
      const code = await hooks({ ...ctx, args: { ...ctx.args, pos: [action, t, ...ctx.args.pos.slice(2)] } });
      if (code !== EXIT.ok) return code;
    }
    return EXIT.ok;
  }
  const opts = { dryRun: bool(ctx.args, "dry-run"), uninstall: action === "uninstall" };
  // An agent's change to its runtimes' configuration is admin (AGENT-ADMIN-1): refused while agent admin is off, audited.
  if (!opts.dryRun && (target === "claude" || target === "codex")) await auditLocal(ctx, `${action === "install" ? "installed" : "removed"} the Walkie hooks for ${target}`);
  if (target === "claude") {
    const r = await installClaude(opts);
    ctx.out(`${c.green(opts.dryRun ? "would update" : "updated")} ${r.changed.join(", ")}\n${r.commands.map((x) => `  ${opts.dryRun ? "would run" : "ran"}: ${x}`).join("\n")}` +
      (opts.uninstall ? "" : `\nRestart Claude Code sessions to load the hooks. For instant push, launch with:\n  claude --dangerously-load-development-channels server:walkie`));
  } else if (target === "codex") {
    const r = await installCodex(opts);
    ctx.out(`${c.green(opts.dryRun ? "would update" : "updated")} ${r.changed.join(", ")}` +
      (r.notifySkipped ? `\n${c.yellow("note:")} config.toml already has a notify command; add \`walkie hook codex\` to it yourself to report Codex status.` : ""));
  } else {
    throw new UsageError(`unknown target ${target}`);
  }
  return EXIT.ok;
}
