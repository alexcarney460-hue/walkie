// Bounded local launch policy. This is same-UID organization, NOT containment.
import { isAbsolute, join } from "node:path";
import type { SeatsConfig } from "../config.ts";
import { isLocalOss, localRequestValid, type AnySeatRun, type OssReadiness, type SeatMode } from "../../protocol/seats.ts";
import { codexSeatArgs } from "./runtime.ts";
import { seatToolPolicyRefusal } from "./tool-policy.ts";
import type { Isolation } from "./isolation.ts";
import type { WorkerRoot } from "./worker-root.ts";

export const OSS_NATIVE_HELD = "Codex OSS native validation UNVERIFIED: runtime/config/endpoint/no-download/no-paid-fallback/resource proof is not admitted";

export function ossPolicy(run: AnySeatRun, cfg: SeatsConfig, iso: Isolation): string | null {
  if (!isLocalOss(run)) return null;
  if (!localRequestValid(run)) return "invalid local OSS request";
  if (!cfg.codex_oss_ollama) return "local Ollama consent is off";
  if (!cfg.allow) return "seats are off";
  if (cfg.same_user !== true || cfg.ephemeral || cfg.mode === "seat_users" || iso.mode !== "same_user" || iso.problem)
    return "local OSS requires explicitly consented same-user seats";
  if (cfg.inherit_person_config) return "local OSS conflicts with provider config inheritance";
  return seatToolPolicyRefusal("codex", cfg.tools, run.permission_mode ?? "acceptEdits");
}

export function ossSnapshot(cfg: SeatsConfig): OssReadiness {
  return { protocol: "supported", consent: cfg.codex_oss_ollama ? "consented" : "off", policy: "held",
    runtime: "unknown", config: "unknown", service: "unknown", model: "unknown", resources: "unknown",
    native: "UNVERIFIED", ready: false, reason: OSS_NATIVE_HELD };
}

/** Fixed locale and host-selected absolute PATH; never enumerate/copy the daemon environment. */
export function ossEnvironment(root: WorkerRoot, path: string): Record<string, string> {
  if (!path || path.split(":").some((p) => !isAbsolute(p) || /[\x00-\x20\x7f]/.test(p))) throw new Error("unsafe OSS tool PATH");
  return { PATH: path, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb", HOME: join(root.root, "home"),
    CODEX_HOME: root.codex, TMPDIR: root.temp, XDG_CONFIG_HOME: join(root.root, "config"),
    XDG_CACHE_HOME: join(root.root, "cache"), XDG_DATA_HOME: join(root.root, "data"), XDG_STATE_HOME: join(root.root, "state") };
}

export function ossArgs(cwd: string, mode: SeatMode, model: string): string[] {
  if (!localRequestValid({ runtime: "codex", local_provider: "ollama", model })) throw new Error("invalid local model");
  const base = codexSeatArgs({ cwd, mode, model });
  return [...base.slice(0, -1), "--oss", "--local-provider", "ollama", "--ignore-user-config", "-c", 'cli_auth_credentials_store="file"', "-"];
}
