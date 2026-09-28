// `walkie daemon install|uninstall`: launchd agent (macOS) or systemd user unit (Linux).
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SERVICE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export const LAUNCHD_LABEL = "dev.walkie.daemon";

/**
 * launchd's scheduling class (v0.1.3). "Background" (v0.1.0–0.1.2) runs the daemon at priority 4 with throttled CPU
 * and IO: on a loaded Mac it took ~100 s to reach its socket after an update. "Standard" is launchd's normal,
 * unthrottled class. "Interactive" is meant for processes that drive a UI the user is waiting on; the daemon isn't one.
 */
export const PROCESS_TYPE = "Standard";

export interface ServicePlan {
  readonly platform: "launchd" | "systemd";
  readonly path: string;
  readonly content: string;
  readonly load: readonly string[][];
  readonly unload: readonly string[][];
  readonly restart: readonly string[];
}

/** argv that runs `walkie daemon run` for this install (compiled binary or bun + script). */
export function daemonCommand(): string[] {
  const script = process.argv[1];
  if (script && /\.(ts|js|mjs)$/.test(script)) return [process.execPath, resolve(script), "daemon", "run"];
  return [process.execPath, "daemon", "run"];
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function launchdPlan(cmd: string[], home: string, env: Record<string, string>): ServicePlan {
  const path = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const envXml = Object.entries(env).map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${cmd.map((a) => `      <string>${xml(a)}</string>`).join("\n")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>ProcessType</key><string>${PROCESS_TYPE}</string>
    <key>StandardOutPath</key><string>${xml(join(home, "logs", "daemon.out"))}</string>
    <key>StandardErrorPath</key><string>${xml(join(home, "logs", "daemon.out"))}</string>
  </dict>
</plist>
`;
  const uid = String(process.getuid?.() ?? 501);
  return {
    platform: "launchd", path, content,
    load: [["launchctl", "bootstrap", `gui/${uid}`, path]],
    unload: [["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`]],
    restart: ["launchctl", "kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`],
  };
}

function systemdQuote(a: string): string {
  return /[\s"\\]/.test(a) ? `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : a;
}

function systemdPlan(cmd: string[], home: string, env: Record<string, string>): ServicePlan {
  const path = join(homedir(), ".config", "systemd", "user", "walkie.service");
  const content = `[Unit]
Description=Walkie daemon (team agent network)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
ExecStart=${cmd.map(systemdQuote).join(" ")}
${Object.entries(env).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`).join("\n")}
Restart=always
RestartSec=5
StandardOutput=append:${join(home, "logs", "daemon.out")}
StandardError=append:${join(home, "logs", "daemon.out")}

[Install]
WantedBy=default.target
`;
  return {
    platform: "systemd", path, content,
    load: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "walkie.service"]],
    unload: [["systemctl", "--user", "disable", "--now", "walkie.service"]],
    restart: ["systemctl", "--user", "restart", "walkie.service"],
  };
}

export function planService(home: string, platform: NodeJS.Platform = process.platform): ServicePlan {
  const cmd = daemonCommand();
  // Fixed, minimal PATH: the service must not inherit an interactive shell's (session-specific) PATH.
  // Tailscale is found via its app path on macOS or these dirs on Linux.
  const env: Record<string, string> = { WALKIE_HOME: home, PATH: SERVICE_PATH };
  if (platform === "darwin") return launchdPlan(cmd, home, env);
  if (platform === "linux") return systemdPlan(cmd, home, env);
  throw new Error(`service install is not supported on ${platform}; run: walkie daemon start`);
}

async function runAll(cmds: readonly string[][], ignoreErrors: boolean): Promise<void> {
  for (const cmd of cmds) {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    if (code !== 0 && !ignoreErrors) {
      throw new Error(`${cmd.join(" ")} exited ${code}: ${(await new Response(p.stderr).text()).trim()}`);
    }
  }
}

/** Writes the unit and loads it. With dryRun, returns the plan without touching anything. */
export async function installService(home: string, dryRun: boolean): Promise<ServicePlan> {
  const plan = planService(home);
  if (dryRun) return plan;
  mkdirSync(dirname(plan.path), { recursive: true });
  mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
  if (existsSync(plan.path)) await runAll(plan.unload, true);
  writeFileSync(plan.path, plan.content, { mode: 0o644 });
  await runAll(plan.load, false);
  return plan;
}

export async function uninstallService(home: string, dryRun: boolean): Promise<ServicePlan> {
  const plan = planService(home);
  if (dryRun) return plan;
  await runAll(plan.unload, true);
  rmSync(plan.path, { force: true });
  if (plan.platform === "systemd") await runAll([["systemctl", "--user", "daemon-reload"]], true);
  return plan;
}
