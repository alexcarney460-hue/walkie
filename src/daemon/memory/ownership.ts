// Legacy notes predate person ownership. The accepted current-team chain supplies a one-time decision.
import type { Event } from "../../protocol/schemas.ts";
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_FILE, type MemoryStore } from "./store.ts";
import { applyRosterEvent, EMPTY_ROSTER, nodeMember, type Roster } from "../roster.ts";

interface OwnershipCore {
  readonly nodeId: string;
  readonly teamId: string | null;
  readonly roster: Roster;
  myHandle(): string | null;
  rosterEntries(): readonly Event[];
}

export interface LegacyDecision { team: string; node: string; person: string; identity: string }
const DECISION_FILE = "memory-owner.json";
interface StartupDecision { database: string; device: number; inode: number; proof: LegacyDecision | null }

function fileIdentity(home: string): { device: number; inode: number } {
  const file = statSync(join(home, MEMORY_FILE));
  return { device: file.dev, inode: file.ino };
}

/** Called once at daemon start, before local routes can read memory. Never replaced for a swapped database. */
export function recordStartupDecision(home: string, store: MemoryStore, proof: LegacyDecision | null): void {
  const path = join(home, DECISION_FILE);
  if (existsSync(path)) return;
  const decision: StartupDecision = { database: store.databaseId(), ...fileIdentity(home), proof };
  try { writeFileSync(path, JSON.stringify(decision), { flag: "wx", mode: 0o600 }); }
  catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
  }
}

/** A missing, changed, or unreadable startup decision admits no historical row. */
export function startupAdmits(home: string, store: MemoryStore, proof: LegacyDecision | null): boolean {
  if (!proof) return false;
  try {
    const path = join(home, DECISION_FILE);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    const saved = JSON.parse(readFileSync(path, "utf8")) as StartupDecision;
    const file = fileIdentity(home);
    return saved.database === store.databaseId() && saved.device === file.device && saved.inode === file.inode
      && saved.proof?.team === proof.team
      && saved.proof.node === proof.node && saved.proof.person === proof.person
      && saved.proof.identity === proof.identity;
  } catch { return false; }
}

/** Login plus the last removal in this team identifies an admission, not its display handle. */
export function personKey(core: Pick<OwnershipCore, "teamId" | "nodeId" | "roster">): string | null {
  if (!core.teamId) return null;
  const member = nodeMember(core.roster, core.nodeId);
  return member
    ? JSON.stringify([core.teamId, member.login, member.removed_pos ?? -1]) : null;
}

/** A missing or ambiguous history leaves every ownerless note quarantined. */
export function legacyOwner(core: OwnershipCore): LegacyDecision | null {
  try {
    const entries = core.rosterEntries();
    if (entries[0]?.kind !== "team.create") return null;
    let roster: Roster = EMPTY_ROSTER;
    const holders = new Set<string>();
    for (const event of entries) {
      roster = applyRosterEvent(roster, event);
      const holder = nodeMember(roster, core.nodeId);
      if (holder) {
        holders.add(JSON.stringify([holder.login, holder.removed_pos ?? -1]));
      }
      if (holders.size > 1) return null;
    }
    const historical = nodeMember(roster, core.nodeId);
    const current = nodeMember(core.roster, core.nodeId);
    if (!historical || !current || holders.size !== 1 || !roster.team?.id || roster.team.id !== core.teamId) return null;
    if (historical.login !== current.login || historical.handle !== current.handle) return null;
    if (current.handle !== core.myHandle()) return null;
    const identity = personKey(core);
    return identity ? { team: roster.team.id, node: core.nodeId, person: current.handle, identity } : null;
  } catch {
    return null;
  }
}
