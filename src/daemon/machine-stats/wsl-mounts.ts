// WALKIE-TEMP-WSL: which mount a path is really on, from /proc/self/mountinfo, the way the kernel resolves it: start at
// the root mount and, for each directory on the path, step onto the mount attached there (and onto any mount stacked
// on that one). A mount hidden by a later mount over it or over any of its parents is never reached this way, which
// the earlier "longest mount-point string wins" rule got wrong (Codex temp-wsl r4 HIGH, Opus r4). File order and mount
// ids are not used: on WSL `/` is listed after some of its children, and ids are reused. Pure functions; nothing here
// throws or touches the filesystem.

/** One /proc/self/mountinfo line (see proc_pid_mountinfo(5)). */
export interface MountInfo {
  id: string;
  parent: string;
  /** "major:minor", the st_dev of every file on this mount. */
  dev: string;
  /** The directory of the filesystem mounted here: "/" unless this is a bind mount of a subdirectory. */
  root: string;
  mountPoint: string;
  type: string;
  source: string;
  superOptions: string;
}

/** mountinfo fields escape space, tab, newline and backslash as `\ooo`. */
function unescape(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(Number.parseInt(o, 8)));
}

/** Parses /proc/self/mountinfo; malformed lines are skipped. */
export function parseMountinfo(text: string): MountInfo[] {
  const out: MountInfo[] = [];
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    const sep = f.indexOf("-", 6);
    if (f.length < 7 || sep < 0 || f.length < sep + 3) continue;
    const [id, parent, dev, root, mountPoint] = f as [string, string, string, string, string];
    if (!/^\d+$/.test(id) || !/^\d+$/.test(parent) || !/^\d+:\d+$/.test(dev)) continue;
    out.push({
      id, parent, dev, root: unescape(root), mountPoint: unescape(mountPoint),
      type: f[sep + 1] as string, source: unescape(f[sep + 2] as string), superOptions: unescape(f[sep + 3] ?? ""),
    });
  }
  return out;
}

/** The mounts attached at `point` on top of mount `on` (a mount stacked at the same point has the lower one as parent). */
function topAt(records: readonly MountInfo[], on: MountInfo, point: string): MountInfo {
  let cur = on;
  for (let guard = 0; guard < records.length; guard++) {
    const next = records.filter((m) => m.parent === cur.id && m.mountPoint === point && m.id !== cur.id);
    if (next.length === 0) return cur;
    cur = next[next.length - 1] as MountInfo;
  }
  return cur;
}

/** The root mount: at "/", with a parent that isn't in the table (it lives outside this namespace's view). */
function rootMount(records: readonly MountInfo[]): MountInfo | null {
  const ids = new Set(records.map((m) => m.id));
  return records.find((m) => m.mountPoint === "/" && !ids.has(m.parent)) ?? null;
}

/**
 * The mount an absolute path resolves onto, walking its directories from `/` the way the kernel does (symlinks are
 * the caller's concern: pass a path whose realpath is itself). Null when there is no root mount.
 */
export function mountOf(records: readonly MountInfo[], path: string): MountInfo | null {
  const root = rootMount(records);
  if (!root) return null;
  let cur = topAt(records, root, "/");
  let prefix = "";
  for (const part of path.split("/").filter(Boolean)) {
    prefix = `${prefix}/${part}`;
    cur = topAt(records, cur, prefix);
  }
  return cur;
}

/**
 * WSL's C: drive: the whole drive (`root` "/", not a bind mount of a folder on it), as 9p/v9fs with
 * `aname=drvfs;path=C:\` (WSL2) or drvfs from `C:\` (WSL1).
 */
export function isCDrive(m: MountInfo): boolean {
  if (m.root !== "/") return false;
  if (m.type === "9p" || m.type === "v9fs") {
    return /(^|[,;])aname=drvfs([,;]|$)/.test(m.superOptions) && /(^|[,;])path=C:\\?([,;]|$)/i.test(m.superOptions);
  }
  return m.type === "drvfs" && /^C:\\?$/i.test(m.source);
}

/** The filesystem type `dir` resolves onto when that mount's point is `dir` itself, else null. */
export function typeMountedAt(records: readonly MountInfo[], dir: string): string | null {
  const m = mountOf(records, dir);
  return m && m.mountPoint === dir ? m.type : null;
}

/** Linux dev_t → "major:minor" (glibc's encoding; what st_dev holds and mountinfo prints). */
export function devString(dev: number | bigint): string {
  const d = BigInt(dev);
  const major = ((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn);
  const minor = (d & 0xffn) | ((d >> 12n) & ~0xffn);
  return `${major}:${minor}`;
}
