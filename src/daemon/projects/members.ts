// Restricted-channel membership follows the roster (WALKIE-PROJECTS-1), on the roster authority only:
//   - a private project is its team's OWNERS (Alex 2026-09-26): promoting or demoting an owner updates every private
//     project's channel;
//   - removing a member drops them from every restricted channel (design F10), so a later re-invite doesn't silently
//     give back access to channels they were in before.
// Each change is an ordinary channel.upsert the authority signs (never plan-limited: the channels already exist).
import type { Core } from "../core.ts";
import type { Logger } from "../logger.ts";

const MAX_MEMBERS = 50;

function same(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/**
 * The channel.upsert bodies that would bring restricted channels in line with the roster (pure). Archived channels
 * and channels whose members would be none are included: a removed member must leave for good, or a re-invite would
 * hand the channel back (round-1 audit, Codex HIGH 3).
 */
export function restrictedFixes(roster: Core["roster"], isProject: (name: string) => boolean): Array<{ name: string; members: string[] }> {
  const owners = [...roster.members.values()].filter((m) => m.role === "owner").map((m) => m.handle).sort().slice(0, MAX_MEMBERS);
  const removed = new Set([...roster.members.values()].filter((m) => m.role === "removed").map((m) => m.handle));
  const out: Array<{ name: string; members: string[] }> = [];
  for (const [name, ch] of roster.channels) {
    if (!ch.members) continue;
    const want = isProject(name) ? owners : ch.members.filter((h) => !removed.has(h));
    if (same(ch.members, want)) continue;
    out.push({ name, members: [...want] });
  }
  return out;
}

export class RestrictedMembership {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly core: Core, private readonly log: Logger) {}

  /** After a roster change (off the ingest path: emitting here re-enters the chain). */
  rosterChanged(): void {
    if (this.timer || !this.core.isAuthority()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reconcile();
    }, 50);
    (this.timer as { unref?: () => void }).unref?.();
  }

  reconcile(): number {
    if (!this.core.isAuthority()) return 0;
    let n = 0;
    for (const fix of restrictedFixes(this.core.roster, (n) => this.core.isProjectChannel(n))) {
      try {
        this.core.emit("channel.upsert", fix);
        this.log.info("restricted_members_synced", { channel: fix.name, members: fix.members.length });
        n++;
      } catch (err) {
        this.log.warn("restricted_members_failed", { channel: fix.name, err: err instanceof Error ? err.message : String(err) });
      }
    }
    return n;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
