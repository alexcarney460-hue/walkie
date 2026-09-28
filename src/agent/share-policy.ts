// What an agent's status may carry beyond its state (WALKIE-MISSION-1 fix rounds 1-2). The policy is read from
// config.json; it is ENFORCED where the daemon signs every agent.status (src/protocol/status-projection.ts via
// Core.emit). Hooks and discovery also follow it so they don't send what would be dropped anyway.
//
// Always shared (the product): state, runtime, model, machine, person, repo name and branch.
// - prompts:  titles made from a person's prompts (and their issue keys), Codex's last-reply line. Only when
//             config.json has "share_prompts": true; absent (every install before this change) = off.
//             WALKIE_SHARE_PROMPTS=0 turns it off whatever the config says.
// - activity: the text of tool calls and notifications. Only with "share_activity": true; else fixed phrases.
// - paths:    the working directory. Only with "share_paths": true.
// An unreadable or invalid config shares nothing.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { walkieHome } from "../client/index.ts";
import { PRIVATE_TITLE as TITLE } from "../protocol/status-projection.ts";

export interface SharePolicy {
  readonly prompts: boolean;
  readonly activity: boolean;
  readonly paths?: boolean;
}

export const SHARE_NOTHING: SharePolicy = { prompts: false, activity: false, paths: false };

/** The title a prompt gets when prompts are private. */
export const PRIVATE_TITLE = TITLE;

/** The policy for a parsed config.json object (or null: unreadable). */
export function sharePolicy(cfg: unknown, env: NodeJS.ProcessEnv = process.env): SharePolicy {
  const c = cfg && typeof cfg === "object" ? (cfg as { share_prompts?: unknown; share_activity?: unknown; share_paths?: unknown }) : {};
  return {
    prompts: c.share_prompts === true && env.WALKIE_SHARE_PROMPTS !== "0",
    activity: c.share_activity === true,
    paths: c.share_paths === true,
  };
}

/** Reads <walkie home>/config.json (hooks run outside the daemon and read it on every call). */
export function readSharePolicy(home = walkieHome(), env: NodeJS.ProcessEnv = process.env): SharePolicy {
  try {
    return sharePolicy(JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as unknown, env);
  } catch {
    return sharePolicy(null, env);
  }
}

/** The daemon's view of the policy: config.json re-read when it changes (so a change applies without a restart). */
export class SharePolicyFile {
  private key = "";
  private value: SharePolicy = SHARE_NOTHING;

  constructor(private readonly file: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  get(): SharePolicy {
    let key = "missing";
    try { const s = statSync(this.file); key = `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { /* no config: nothing shared */ }
    if (key !== this.key) {
      this.key = key;
      try {
        this.value = key === "missing" || !statSync(this.file).isFile() ? sharePolicy(null, this.env)
          : sharePolicy(JSON.parse(readFileSync(this.file, "utf8")) as unknown, this.env);
      } catch {
        this.value = sharePolicy(null, this.env);
      }
    }
    return this.value;
  }
}
