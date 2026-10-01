// walkie mcp · walkie hook claude|codex · walkie hooks install|uninstall claude|codex
import { join } from "node:path";
import { runClaudeHook } from "../../hooks/claude.ts";
import { runCodexHook } from "../../hooks/codex.ts";
import { runKimiHook } from "../../hooks/kimi.ts";
import { runGrokHook } from "../../hooks/grok.ts";
import { runHermesHook } from "../../hooks/hermes.ts";
import { installKimi } from "../../hooks/install-kimi.ts";
import { grokHooksPath, installGrok } from "../../hooks/install-grok.ts";
import { installHermes } from "../../hooks/install-hermes.ts";
import { runSwitchHook } from "../../hooks/switch-channel.ts";
import { claudeSettingsPath, installClaude, installCodex } from "../../hooks/install.ts";
import { homeRelative } from "../../agent/identity.ts";
import { readHermesActivityProfiles } from "../../agent/share-policy.ts";
import { saveHermesActivityProfiles } from "../../daemon/config.ts";
import { defaultHome } from "../../daemon/paths.ts";
import { HERMES_ACTIVITY_PROFILES_MAX, HERMES_PROFILE } from "../../protocol/hermes-activity.ts";
import { runMcpServer } from "../../mcp/server.ts";
import { bool, need, str, UsageError, type Args } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c } from "../format.ts";
import { writeOut } from "../stdio.ts";
import { gateLocal, recordLocal } from "../admin-gate.ts";

export async function mcp(_ctx: Ctx): Promise<number> {
  await runMcpServer();
  await new Promise(() => undefined); // serve until stdin closes (the server exits the process)
  return EXIT.ok;
}

/** Hooks must never fail the host agent: always exit 0. */
export async function hook(ctx: Ctx): Promise<number> {
  const runtime = need(ctx.args, 0, "runtime (claude|codex|kimi|grok|hermes)");
  try {
    if (runtime === "claude") {
      const raw = await Promise.race([new Response(Bun.stdin.stream()).text(), Bun.sleep(1000).then(() => "")]);
      const out = await runClaudeHook(raw);
      if (out) writeOut(out + "\n");
    } else if (runtime === "kimi") {
      const raw = await Promise.race([new Response(Bun.stdin.stream()).text(), Bun.sleep(1000).then(() => "")]);
      await runKimiHook(raw);
    } else if (runtime === "grok") {
      const raw = await Promise.race([new Response(Bun.stdin.stream()).text(), Bun.sleep(1000).then(() => "")]);
      await runGrokHook(raw);
    } else if (runtime === "hermes") {
      const raw = await Promise.race([new Response(Bun.stdin.stream()).text(), Bun.sleep(1000).then(() => "")]);
      await runHermesHook(raw);
    } else if (runtime === "codex") {
      await runCodexHook(ctx.args.pos[ctx.args.pos.length - 1] ?? "");
    } else if (runtime === "switch") {
      const raw = await Promise.race([new Response(Bun.stdin.stream()).text(), Bun.sleep(1000).then(() => "")]);
      runSwitchHook(raw);
    }
  } catch { /* swallowed by design; see ~/.walkie/logs/hooks.log */ }
  return EXIT.ok;
}

/**
 * What the admin audit line says a hooks command did (`done`) or tried to do. For Grok it names each file touched: install also
 * writes the shared Claude hooks Grok reads. A command that did not get done says "tried to", so a line that says "installed"
 * is only ever one whose install succeeded.
 */
function hooksAuditLine(action: string, target: string, done: boolean, activity?: readonly string[]): string {
  const verb = action === "install" ? (done ? "installed" : "tried to install") : (done ? "removed" : "tried to remove");
  const what = `${verb} the Walkie hooks for ${target}`;
  // A Hermes command that sets the activity list changes what the team sees, so the line says how many profiles may now show activity text.
  if (target === "hermes" && activity) {
    return `${what}, with activity text ${activity.length ? `shown for ${activity.length} profile${activity.length === 1 ? "" : "s"}` : "hidden for every profile"}`;
  }
  if (target !== "grok") return what;
  const files = action === "install" ? [grokHooksPath(), claudeSettingsPath()] : [grokHooksPath()];
  return `${what} (${files.map(homeRelative).join(" and ")})`;
}

/** What an agent may not do while agent admin is off, for the refusal's sentence. */
const hooksRefusal = (action: string, target: string): string => `${action} the Walkie hooks for ${target}`;

/** The reason a failed hooks command gives, short and on one line, for the audit line. */
function failureReason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim();
  return `failed: ${text}`.slice(0, 280);
}

const GROK_SHARED_EVENTS = "session start and end, prompts, finished turns, tool results and notifications";

export async function hooks(ctx: Ctx): Promise<number> {
  const action = need(ctx.args, 0, "install|uninstall");
  const target = need(ctx.args, 1, "claude|codex|kimi|grok|hermes|all");
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
  // Hermes hooks go only into the profiles the person names, so a missing --profiles is a usage error before any gate or audit line.
  const hermesProfiles = target === "hermes" ? str(ctx.args, "profiles")?.split(",").map((p) => p.trim()) ?? [] : [];
  if (target === "hermes" && !hermesProfiles.length) throw new UsageError("Hermes needs --profiles default,name (explicit selection)");
  const activity = hermesActivityArg(ctx.args, target);
  // An agent's change to its runtimes' configuration is admin (AGENT-ADMIN-1): refused while agent admin is off, and audited
  // AFTER it ran, as what it was: done, or failed with the reason (a refusal of the gate is audited as refused). The line used
  // to be written first, so an install the settings file refused still left a line saying the hooks were installed.
  const audited = !opts.dryRun && (target === "claude" || target === "codex" || target === "kimi" || target === "grok" || target === "hermes");
  if (audited) await gateLocal(ctx, hooksRefusal(action, target), hooksAuditLine(action, target, false, activity));
  try {
    await runHooks(ctx, action, target, opts, hermesProfiles, activity);
  } catch (error) {
    if (audited) await recordLocal(ctx, hooksAuditLine(action, target, false, activity), failureReason(error));
    throw error;
  }
  if (audited) await recordLocal(ctx, hooksAuditLine(action, target, true, activity));
  return EXIT.ok;
}

/**
 * `--activity name[,name]`, Hermes only: the profiles whose status may carry activity text (config.json hermes_activity_profiles).
 * `--activity ""` is the empty list, so it clears it; no flag leaves the list alone (undefined). A name Walkie cannot carry is a usage
 * error, not a silent drop: a typo must not read as "shown" or "hidden" by accident.
 */
function hermesActivityArg(args: Args, target: string): string[] | undefined {
  const raw = str(args, "activity");
  if (raw === undefined) return undefined;
  if (target !== "hermes") throw new UsageError("--activity is only for hermes");
  const names = [...new Set(raw.split(",").map((p) => p.trim()).filter(Boolean))];
  const bad = names.find((p) => !HERMES_PROFILE.test(p));
  if (bad !== undefined) throw new UsageError(`--activity names "${bad.slice(0, 40)}", which is not a Hermes profile name Walkie can carry (lowercase letters, digits and dashes, up to 32)`);
  if (names.length > HERMES_ACTIVITY_PROFILES_MAX) throw new UsageError(`--activity names more than ${HERMES_ACTIVITY_PROFILES_MAX} profiles`);
  return names;
}

/** What the person is told about activity text after a Hermes command: the list now in force, or what a dry run would set. */
function activityNote(profiles: readonly string[], dryRun: boolean, given: boolean): string {
  if (dryRun && given) {
    return profiles.length ? `would set the Hermes profiles that show activity text to: ${profiles.join(", ")}`
      : "would clear the Hermes profiles that show activity text: activity text stays hidden for every profile";
  }
  return profiles.length ? `Activity text is shown for: ${profiles.join(", ")}. Every other Hermes profile shows its state only.`
    : "Activity text is hidden for every Hermes profile unless it is listed with --activity name[,name].";
}

async function runHooks(ctx: Ctx, action: string, target: string, opts: { dryRun: boolean; uninstall: boolean }, hermesProfiles: readonly string[],
  activity: readonly string[] | undefined): Promise<void> {
  if (target === "claude") {
    const r = await installClaude(opts);
    ctx.out([
      `${c.green(opts.dryRun ? "would update" : "updated")} ${r.changed.join(", ")}`,
      ...r.commands.map((x) => `  ${opts.dryRun ? "would run" : "ran"}: ${x}`),
      ...(r.note ? [`${c.yellow("note:")} ${r.note}`] : []),
      ...(opts.uninstall || r.note ? [] : [`Restart Claude Code sessions to load the hooks. For instant push, launch with:\n  claude --dangerously-load-development-channels server:walkie`]),
    ].join("\n"));
  } else if (target === "codex") {
    const r = await installCodex(opts);
    ctx.out(`${c.green(opts.dryRun ? "would update" : "updated")} ${r.changed.join(", ")}` +
      (r.notifySkipped ? `\n${c.yellow("note:")} config.toml already has a notify command; add \`walkie hook codex\` to it yourself to report Codex status.` : ""));
  } else if (target === "kimi") {
    const r = await installKimi(opts);
    ctx.out(`${opts.dryRun ? "would update" : "updated"} ${r.changed.join(", ")}`);
  } else if (target === "grok") {
    const r = await installGrok(opts);
    // Grok also runs Walkie's Claude hooks (its Claude-compatibility scan: compat.claude.hooks), which own the rest of the events (src/hooks/grok-events.ts).
    ctx.out([
      `${opts.dryRun ? "would update" : "updated"} ${r.changed.join(", ")}`,
      opts.uninstall
        ? `Walkie's Claude hooks in ~/.claude/settings.json stay in place, since they are Claude Code's hooks too. Grok keeps reporting ${GROK_SHARED_EVENTS} through them until you run walkie hooks uninstall claude or turn off Grok's compat.claude.hooks.`
        : `The Grok file reports tool starts, failed tool calls and failed or cancelled turns. Walkie's hooks in ~/.claude/settings.json report ${GROK_SHARED_EVENTS}; Grok runs them through its Claude compatibility (compat.claude.hooks, on by default), so keep that on.`,
    ].join("\n"));
  } else if (target === "hermes") {
    const r = await installHermes({ ...opts, profiles: hermesProfiles });
    // The list is config.json's, written after the hooks: if the hooks fail the list is not touched, so nothing is shown that was not
    // before, and if this write fails the list stays as it was.
    if (activity !== undefined && !opts.dryRun) saveHermesActivityProfiles(join(defaultHome(), "config.json"), activity);
    ctx.out([
      `${opts.dryRun ? "would update" : "updated"} ${r.changed.join(", ")}`,
      "Hermes must consent to each shell hook and reload the chosen profiles before statuses appear.",
      ...(opts.uninstall && activity === undefined ? [] : [activityNote(activity ?? readHermesActivityProfiles(defaultHome()), opts.dryRun, activity !== undefined)]),
    ].join("\n"));
  } else {
    throw new UsageError(`unknown target ${target}`);
  }
}
