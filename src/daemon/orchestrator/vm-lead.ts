import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "../core.ts";
import type { LeadNode } from "./lead.ts";

export function isWsl(env: NodeJS.ProcessEnv = process.env, release?: string): boolean {
  if (env.WSL_DISTRO_NAME) return true;
  try { return /microsoft|wsl/i.test(release ?? readFileSync("/proc/sys/kernel/osrelease", "utf8")); }
  catch { return false; }
}

export function leadEligibleFile(core: Core): string { return join(core.paths.home, "talkie-lead-eligible"); }

export function vmMayLead(core: Core, nodes: readonly LeadNode[], vm = isWsl()): boolean {
  if (!vm) return true;
  let optedIn = false;
  try { optedIn = existsSync(leadEligibleFile(core)) && readFileSync(leadEligibleFile(core), "utf8") === "on\n"; }
  catch { return false; }
  if (!optedIn) return false;
  const owners = new Set([...core.roster.members.values()].filter((m) => m.role === "owner").map((m) => m.handle));
  // Peers without a VM marker are conservatively treated as physical machines.
  return !nodes.some((n) => n.node_id !== core.nodeId && owners.has(n.handle) && n.online);
}

export function setVmLeadEligible(core: Core, on: boolean): void {
  writeFileSync(leadEligibleFile(core), on ? "on\n" : "off\n", { mode: 0o600 });
}
