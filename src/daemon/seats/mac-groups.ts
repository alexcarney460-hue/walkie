// macOS group membership the root helper (admin.ts, admin-sys.ts) accepts for a new seat user (SEATS-MACOS-FIX).
//
// On macOS `id -G` lists every group a user is in, including the ones it is in only because the group nests the
// built-in, system-calculated `everyone` (gid 12) or `localaccounts` (gid 61) groups: every local account is in those,
// so every local account is in them too (on a default Mac: _lpoperator 100 through localaccounts, and a File Sharing
// group com.apple.sharepoint.group.<n> through everyone). Those are not groups anyone gave the seat user.
//
// Any other membership is: a group that lists the user by name (GroupMembership) or by its GeneratedUID
// (GroupMembers), that is its primary group, or that nests (at any depth) a group that does. A group that can't be
// explained from the local directory (no local record, several records with its id, a nested group that isn't a
// local record) counts as a membership too: fail closed.
//
// Everything here is pure (parsed from dscl's own output) so it is tested with this machine's real dscl output.

/** The built-in, system-calculated groups every local account is in: their fixed GeneratedUID and gid. */
export const MAC_IMPLICIT_GROUPS: ReadonlyMap<string, { gid: number; name: string }> = new Map([
  ["ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C", { gid: 12, name: "everyone" }],
  ["ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000003D", { gid: 61, name: "localaccounts" }],
]);

/**
 * Administrative and shared groups a seat user is never excused from, whatever they nest (PRE5 RC LOW): an
 * administrator nesting everyone or localaccounts into one of these would otherwise make every local account a member
 * the helper accepts. By gid (wheel 0, staff 20, admin 80, _lpadmin 98) and by record name.
 */
export const NEVER_EXCUSED_GIDS: ReadonlySet<number> = new Set([0, 20, 80, 98]);
export const NEVER_EXCUSED_NAMES: ReadonlySet<string> = new Set(["wheel", "staff", "admin", "_lpadmin", "lpadmin", "root"]);

/** The attributes the helper reads of every local group (`dscl . -readall /Groups <these>`). */
export const DS_GROUP_ATTRS = ["RecordName", "PrimaryGroupID", "GeneratedUID", "GroupMembership", "GroupMembers", "NestedGroups"] as const;

export interface DsGroup { names: string[]; gid: number | null; guid: string | null; membership: string[]; members: string[]; nested: string[] }

/**
 * dscl's record output (`dscl . -read <path> [attrs]`, or `-readall`, whose records are separated by a line `-`):
 * `Key: v1 v2 …` (values split on spaces), or `Key:` followed by one value per line, each indented by one space
 * (dscl's form when a value holds a space). Keys may hold colons (`dsAttrTypeNative:IsHidden: 1`).
 */
export function parseDsRecords(text: string): Array<Map<string, string[]>> {
  const records: Array<Map<string, string[]>> = [];
  let rec = new Map<string, string[]>();
  let key: string | null = null;
  const flush = () => { if (rec.size) records.push(rec); rec = new Map(); key = null; };
  for (const line of text.split("\n")) {
    if (line === "-") { flush(); continue; }
    if (line.startsWith(" ")) {
      if (key !== null) rec.get(key)?.push(line.slice(1));
      continue;
    }
    const m = /^(\S+):(?: (.*))?$/.exec(line);
    if (!m) { key = null; continue; }
    key = m[1] as string;
    rec.set(key, m[2] === undefined ? [] : m[2].split(" ").filter(Boolean));
  }
  flush();
  return records;
}

const one = (r: Map<string, string[]>, k: string): string | null => {
  const v = r.get(k);
  return v && v.length === 1 ? (v[0] as string) : null;
};

export function parseDsGroups(text: string): DsGroup[] {
  return parseDsRecords(text).map((r) => {
    const gid = one(r, "PrimaryGroupID");
    return {
      names: r.get("RecordName") ?? [],
      gid: gid !== null && /^-?\d+$/.test(gid) ? Number(gid) : null,
      guid: one(r, "GeneratedUID")?.toUpperCase() ?? null,
      membership: r.get("GroupMembership") ?? [],
      members: (r.get("GroupMembers") ?? []).map((g) => g.toUpperCase()),
      nested: (r.get("NestedGroups") ?? []).map((g) => g.toUpperCase()),
    };
  });
}

/** A user's GeneratedUID and primary gid from `dscl . -read /Users/<name> GeneratedUID PrimaryGroupID`; throws when absent. */
export function parseDsUser(text: string): { guid: string; gid: number } {
  const r = parseDsRecords(text)[0];
  const guid = r ? one(r, "GeneratedUID") : null;
  const gid = r ? one(r, "PrimaryGroupID") : null;
  if (!guid || !/^[0-9A-Fa-f-]{36}$/.test(guid) || gid === null || !/^-?\d+$/.test(gid)) throw new Error("the user's GeneratedUID or PrimaryGroupID can't be read");
  return { guid: guid.toUpperCase(), gid: Number(gid) };
}

/**
 * The ids among `gids` (the user's `id -G`) that the user is in only through the built-in everyone/localaccounts
 * groups, as every local account is: those groups themselves, and groups whose every path to the user runs through
 * one of them. Every other id (a group that lists the user, is its primary group, nests one that does, or can't be
 * explained from `groups`) is left out: the caller treats it as a real membership.
 */
export function macImplicitGids(user: { name: string; guid: string; gid: number }, gids: readonly number[], groups: readonly DsGroup[]): number[] {
  const guid = user.guid.toUpperCase();
  const byGuid = new Map<string, DsGroup | null>();
  for (const g of groups) if (g.guid) byGuid.set(g.guid, byGuid.has(g.guid) ? null : g); // two records, one GUID: unknown
  const direct = (g: DsGroup) => g.membership.includes(user.name) || g.members.includes(guid) || g.gid === user.gid;
  const builtin = (g: DsGroup) => g.guid !== null && MAC_IMPLICIT_GROUPS.get(g.guid)?.gid === g.gid;
  /** Whether a group's nesting reaches the user only through the built-in groups (true), or otherwise / unknown (false). */
  const onlyThroughBuiltins = (g: DsGroup, seen: Set<string>): { ok: boolean; reached: boolean } => {
    let reached = false;
    for (const n of g.nested) {
      if (MAC_IMPLICIT_GROUPS.has(n)) { reached = true; continue; }
      if (seen.has(n)) continue;
      seen.add(n);
      const inner = byGuid.get(n);
      if (!inner || direct(inner)) return { ok: false, reached };
      const deeper = onlyThroughBuiltins(inner, seen);
      if (!deeper.ok) return { ok: false, reached };
      reached ||= deeper.reached;
    }
    return { ok: true, reached };
  };
  const implicit: number[] = [];
  for (const id of new Set(gids)) {
    const recs = groups.filter((g) => g.gid === id);
    if (recs.length !== 1) continue;
    const g = recs[0] as DsGroup;
    if (NEVER_EXCUSED_GIDS.has(id) || g.names.some((n) => NEVER_EXCUSED_NAMES.has(n))) continue;
    if (builtin(g)) { implicit.push(id); continue; }
    if (direct(g)) continue;
    const v = onlyThroughBuiltins(g, new Set(g.guid ? [g.guid] : []));
    if (v.ok && v.reached) implicit.push(id);
  }
  return implicit;
}
