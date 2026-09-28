// AGENT-ADMIN-1: this machine's two admin switches, read from config.json on every check (the CLI and the daemon
// see the same answer; turning one off takes effect at once, without a restart). Absent = on (older configs).
import { existsSync, readFileSync } from "node:fs";
import { saveConfigField } from "../config.ts";

export interface AdminSwitches {
  /** Agents running here as this OS user may do this machine's setup (audited). */
  readonly agent_admin: boolean;
  /** Owners, and this person's other machines, may run allow-listed admin commands here over Walkie. */
  readonly remote_admin: boolean;
}

/**
 * The switches as config.json has them: anything but an explicit `false` is on (an older config without the keys stays
 * on, the upgrade migration). A config.json that exists but can't be read reads as OFF, so a damaged file never
 * re-enables a switch the person turned off.
 */
export function readSwitches(configPath: string): AdminSwitches {
  if (!existsSync(configPath)) return { agent_admin: true, remote_admin: true };
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { agent_admin: false, remote_admin: false };
    raw = parsed as Record<string, unknown>;
  } catch {
    return { agent_admin: false, remote_admin: false };
  }
  return { agent_admin: raw.agent_admin !== false, remote_admin: raw.remote_admin !== false };
}

export function writeSwitch(configPath: string, key: keyof AdminSwitches, on: boolean): AdminSwitches {
  saveConfigField(configPath, key, on);
  return readSwitches(configPath);
}
