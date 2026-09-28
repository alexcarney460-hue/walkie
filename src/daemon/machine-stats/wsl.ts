// WALKIE-TEMP-WSL: temperature for a daemon running inside WSL2. WSL's /sys/class/thermal has cooling devices but no
// thermal zones, so the Windows host's ACPI thermal zones are read through Windows interop: one fixed PowerShell
// query (no user input, the minimal environment of read.ts `run`, a 5 s deadline) returning JSON. Starting a Windows
// process costs ~0.5-2 s, so it runs at most once per minute; after 3 failures in a row (no zones on a desktop, or
// interop off) once per 10 minutes; a route that timed out is skipped for 10 minutes (nothing turns the query off
// for good). One failed sample keeps the last good zones for up to 3 minutes. Nothing here throws.
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { MAX_TEMP_ZONES } from "../../protocol/machine-stats.ts";
import type { Sensor } from "./parse.ts";
import { devString, isCDrive, mountOf, parseMountinfo, typeMountedAt, type MountInfo } from "./wsl-mounts.ts";

/** Where Windows PowerShell 5.1 lives through WSL's default C: mount. */
export const POWERSHELL_PATH = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/**
 * What the query prints, instead of zones, when its PowerShell runs at high integrity or above (or its integrity level
 * can't be read): the result is refused.
 */
export const ELEVATED_MARK = "WALKIE-ELEVATED";

/**
 * The integrity level in `whoami /groups /fo csv /nh` output, anchored to the label row (`"Mandatory Label\…","Label",
 * "S-1-16-<level>",…`): the type field must be exactly "Label" and the SID field must follow it. CSV doubles any quote
 * inside a field, so no group name can contain `","Label","`; the first bare `S-1-16-` match could have been in a
 * name (Opus temp-wsl r4). Same syntax in .NET and JavaScript. On a Windows whose whoami localises the type word, it
 * doesn't match and the query refuses (fails closed: GPU fallback).
 */
export const INTEGRITY_LABEL_PATTERN = '","Label","S-1-16-(\\d+)"';

/**
 * The one query: every ACPI thermal zone's name and temperature as a JSON array. HighPrecisionTemperature is tenths of
 * a kelvin, Temperature whole kelvins; the performance-counter class works without admin. It uses no cmdlets (only
 * language features, .NET types from the GAC and System32's whoami.exe), so no module is auto-loaded from
 * PSModulePath. It first reads its own mandatory integrity level (`whoami /groups`: the S-1-16-<level> label SID,
 * which .NET's WindowsIdentity.Groups leaves out) and refuses to run the query at High (12288) or above, or when the
 * level can't be read (prints ELEVATED_MARK): a borrowed WSL session can belong to an elevated wsl.exe (an admin's
 * SSH login), and a PowerShell there must not do anything a user-writable path could influence. The integrity level,
 * not Administrators membership, is what elevation changes (Opus temp-wsl r2, r3). Measured on a WSL test machine: an SSH
 * session's PowerShell reports 12288, the non-elevated session's 8192.
 */
export const POWERSHELL_QUERY = [
  "$ErrorActionPreference='Stop'",
  "$w=& ([IO.Path]::Combine([Environment]::SystemDirectory,'whoami.exe')) /groups /fo csv /nh",
  `$m=[regex]::Match((@($w) -join "\`n"),'${INTEGRITY_LABEL_PATTERN}')`,
  `if ($LASTEXITCODE -ne 0 -or -not $m.Success -or [int64]$m.Groups[1].Value -ge 12288) { [Console]::Out.Write('${ELEVATED_MARK}'); exit 0 }`,
  "[void][Reflection.Assembly]::LoadWithPartialName('System.Management')",
  "$q=[System.Management.ManagementObjectSearcher]::new('root\\cimv2','SELECT Name,HighPrecisionTemperature,Temperature FROM " +
    "Win32_PerfFormattedData_Counters_ThermalZoneInformation')",
  "$o=foreach($z in $q.Get()){'{\"Name\":\"'+(([string]$z['Name']) -replace '[^\\x20-\\x7e]','' -replace '\\\\','\\\\' -replace '\"','\\\"')+" +
    "'\",\"HighPrecisionTemperature\":'+[int64]$z['HighPrecisionTemperature']+',\"Temperature\":'+[int64]$z['Temperature']+'}'}",
  "[Console]::Out.Write('['+(@($o) -join ',')+']')",
].join("; ");

export function powershellArgv(bin: string): string[] {
  return [bin, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_QUERY];
}

/** A Windows zone (or GPU) reading outside this range is not a real temperature and is dropped. */
export const PLAUSIBLE_MIN_C = 5;
export const PLAUSIBLE_MAX_C = 120;

export function plausibleC(c: number): boolean {
  return Number.isFinite(c) && c >= PLAUSIBLE_MIN_C && c <= PLAUSIBLE_MAX_C;
}

/** "\_TZ.THRM" → "THRM": printable ASCII, at most 32 characters; null when nothing is left. */
function zoneName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/^\\_TZ\./i, "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 32).trim();
  return s || null;
}

/**
 * The PowerShell JSON: an array (or a single object) of {Name, HighPrecisionTemperature, Temperature}. Returns the
 * plausible zones in °C (one decimal), at most MAX_TEMP_ZONES; [] when there are none; null when the output is not
 * that JSON at all.
 */
export function parseWindowsZones(text: string | null): Sensor[] | null {
  if (text === null) return null;
  const t = text.replace(/^﻿/, "").trim();
  if (!t) return [];
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch {
    return null;
  }
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : null;
  if (!rows) return null;
  const out: Sensor[] = [];
  rows.forEach((row: unknown, i: number) => {
    if (!row || typeof row !== "object" || out.length >= MAX_TEMP_ZONES) return;
    const r = row as { Name?: unknown; HighPrecisionTemperature?: unknown; Temperature?: unknown };
    const hp = typeof r.HighPrecisionTemperature === "number" && r.HighPrecisionTemperature > 0 ? r.HighPrecisionTemperature / 10 : null;
    const k = hp ?? (typeof r.Temperature === "number" && r.Temperature > 0 ? r.Temperature : null);
    if (k === null) return;
    const c = Math.round((k - 273.15) * 10) / 10;
    if (plausibleC(c)) out.push({ name: zoneName(r.Name) ?? `zone${i}`, c });
  });
  return out;
}

export interface WslDetectDeps {
  env?: Record<string, string | undefined>;
  exists?: (path: string) => Promise<boolean>;
  readText?: (path: string) => Promise<string | null>;
}

/** Inside WSL: WSL_DISTRO_NAME set, else the WSLInterop binfmt entry, else a "microsoft" kernel in /proc/version. */
export async function isWsl(deps: WslDetectDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (env.WSL_DISTRO_NAME) return true;
  const exists = deps.exists ?? ((p: string) => Bun.file(p).exists());
  try {
    if (await exists("/proc/sys/fs/binfmt_misc/WSLInterop") || await exists("/proc/sys/fs/binfmt_misc/WSLInterop-late")) return true;
  } catch { /* fall through */ }
  const readText = deps.readText ?? (async (p: string) => { try { return await readFile(p, "utf8"); } catch { return null; } });
  return /microsoft/i.test((await readText("/proc/version")) ?? "");
}

/** Below the automount root: the Windows system drive's PowerShell 5.1. */
const POWERSHELL_UNDER_ROOT = "c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

export interface AutomountConfig {
  /** `[automount] enabled` (default true): false = Windows drives are not mounted, so there is no PowerShell to find. */
  enabled: boolean;
  /** `[automount] root` when set and a plain absolute path (letters, digits, `._-/`, no `..`), with a trailing slash. */
  root: string | null;
}

/** The `[automount]` section of `/etc/wsl.conf` (INI-like; `#`/`;` comments; quoted values; CRLF allowed). */
export function automountConfig(conf: string | null): AutomountConfig {
  const out: AutomountConfig = { enabled: true, root: null };
  if (!conf) return out;
  let section = "";
  let root: string | null = null;
  for (const raw of conf.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { section = (sec[1] as string).trim().toLowerCase(); continue; }
    const kv = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line);
    if (section !== "automount" || !kv) continue;
    const key = (kv[1] as string).toLowerCase();
    const val = (kv[2] as string).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (key === "root") root = val;
    else if (key === "enabled") out.enabled = !["false", "0", "no", "off"].includes(val.toLowerCase());
  }
  if (root && /^\/[A-Za-z0-9._/-]{0,200}$/.test(root) && !root.split("/").includes("..")) out.root = root.endsWith("/") ? root : `${root}/`;
  return out;
}

/** The automount root from `/etc/wsl.conf`, or null (the default /mnt/ is POWERSHELL_PATH already). */
export function automountRoot(conf: string | null): string | null {
  return automountConfig(conf).root;
}

export interface FindPowershellDeps {
  exists?: (p: string) => Promise<boolean>;
  readText?: (p: string) => Promise<string | null>;
  /** The path with every symlink resolved, or null when it can't be (default fs realpath). */
  realpath?: (p: string) => Promise<string | null>;
  /** The st_dev of a path as "major:minor" (following symlinks), or null when it can't be read (default fs stat). */
  dev?: (p: string) => Promise<string | null>;
}

/**
 * Whether `dir` is WSL's C: drive mount point as the kernel resolves it now: walking /proc/self/mountinfo from `/`,
 * `dir` lands on a mount whose point is `dir` and that is the whole C: drive. One hidden by a later mount at `dir` or
 * over any parent doesn't count.
 */
export function isWindowsDriveMount(mountinfo: string | null, dir: string): boolean {
  if (!mountinfo) return false;
  const m = mountOf(parseMountinfo(mountinfo), dir);
  return !!m && m.mountPoint === dir && isCDrive(m);
}

/**
 * Whether `file` resolves onto the C: drive mounted at `dir`: the mount the kernel reaches for `file` (so no overmount
 * of `dir`, of any directory between `dir` and the file, or of any parent of `dir`) is the C: drive at `dir`.
 */
export function onWindowsDrive(mountinfo: string | null, dir: string, file: string): boolean {
  if (!mountinfo) return false;
  const m = mountOf(parseMountinfo(mountinfo), file);
  return !!m && m.mountPoint === dir && isCDrive(m);
}

/** The lookup's answer, with why there is none when the reason is worth a log line. */
export interface PowershellLookup { bin: string | null; why?: string }

/**
 * The PowerShell to run, from fixed absolute Windows paths only: POWERSHELL_PATH, then the same file under the
 * automount root set in /etc/wsl.conf. A candidate counts only when all of these hold (Codex temp-wsl r3, r4):
 * - walking /proc/self/mountinfo the way the kernel does, the file lands on the whole C: drive mounted at its `c`
 *   directory (onWindowsDrive: not a directory someone created under an unmounted root, not under an overmount of
 *   `c`, of a directory below it, or of any parent of it);
 * - its st_dev, and that of `c`, equal that mount's device (the file really is on that mount, whatever the table says);
 * - no component of its path is a symlink (its realpath is itself).
 * WindowsThermal repeats this lookup right before every launch, so a drive unmounted or covered later is noticed.
 * `[automount] enabled = false`, an unreadable mountinfo, or a failed stat: no lookup (fail closed). Never PATH.
 */
export async function findPowershell(deps: FindPowershellDeps = {}): Promise<string | null> {
  return (await findPowershellDetail(deps)).bin;
}

async function statDev(p: string): Promise<string | null> {
  try {
    return devString((await stat(p)).dev);
  } catch {
    return null;
  }
}

/** findPowershell with the reason there is none: automount off, or the drive mounted in a mode it can't use. */
export async function findPowershellDetail(deps: FindPowershellDeps = {}): Promise<PowershellLookup> {
  const exists = deps.exists ?? ((p: string) => Bun.file(p).exists());
  const readText = deps.readText ?? (async (p: string) => { try { return await readFile(p, "utf8"); } catch { return null; } });
  const real = deps.realpath ?? (async (p: string) => { try { return await realpath(p); } catch { return null; } });
  const devOf = deps.dev ?? statDev;
  const automount = automountConfig(await readText("/etc/wsl.conf"));
  if (!automount.enabled) return { bin: null, why: "temperature: Windows drives are not mounted here ([automount] enabled = false)" };
  const text = await readText("/proc/self/mountinfo");
  if (!text) return { bin: null };
  const records = parseMountinfo(text);
  const reasons: string[] = []; // why each candidate was passed over, for the log line (Opus r5: say what happened)
  for (const root of ["/mnt/", ...(automount.root && automount.root !== "/mnt/" ? [automount.root] : [])]) {
    const dir = `${root}c`;
    const candidate = `${root}${POWERSHELL_UNDER_ROOT}`;
    const drive = mountOf(records, candidate);
    if (!drive || drive.mountPoint !== dir || !isCDrive(drive)) {
      reasons.push(driveProblem(records, dir, drive));
      continue;
    }
    try {
      if (!(await exists(candidate))) { reasons.push(`powershell.exe not found at ${candidate}`); continue; }
      if ((await real(candidate)) !== candidate) { reasons.push(`${candidate} goes through a symlink`); continue; }
      const [dirDev, fileDev] = [await devOf(dir), await devOf(candidate)];
      if (dirDev !== drive.dev || fileDev !== drive.dev) {
        reasons.push(`${candidate} is not on the C: drive mount at ${dir} (device ${fileDev ?? "unreadable"}, mount ${drive.dev})`);
        continue;
      }
      return { bin: candidate };
    } catch {
      reasons.push(`could not check ${candidate}`);
    }
  }
  return { bin: null, why: `temperature: ${reasons.join("; ")}` };
}

/** Why the path under `dir` is not on the whole C: drive mounted at `dir`, in words for the log. */
function driveProblem(records: readonly MountInfo[], dir: string, drive: MountInfo | null): string {
  const atDir = typeMountedAt(records, dir);
  if (!atDir) return `C: drive mount not found at ${dir}${drive ? ` (found ${drive.type} at ${drive.mountPoint})` : ""}`;
  const mount = mountOf(records, dir) as MountInfo;
  if (!isCDrive(mount)) {
    // e.g. WSL's virtiofs drive mode: C: is mounted, but not as a 9p/drvfs drive this lookup can trust.
    if (!["9p", "v9fs", "drvfs"].includes(atDir)) return `Windows drive not reachable in this WSL drive mode (${atDir})`;
    return `the ${atDir} mount at ${dir} is not the whole C: drive`;
  }
  return `the C: drive at ${dir} is covered by a ${drive?.type ?? "different"} mount at ${drive?.mountPoint ?? "a directory below it"}`;
}

/** Sample the Windows zones at most this often. */
export const WIN_SAMPLE_MS = 60_000;
/** After this many failures in a row, sample only every WIN_BACKOFF_MS. */
export const WIN_MAX_FAILS = 3;
export const WIN_BACKOFF_MS = 10 * 60_000;
/** After a failed sample the last good zones stand for this long (no flicker to the GPU fallback on one miss). */
export const WIN_KEEP_MS = 3 * 60_000;

/**
 * How a sample reached Windows: "own" = this process's WSL_INTEROP, "plain" = none set (init finds the session through
 * the parent processes), "session" = another WSL session's interop socket, borrowed (a systemd service has no session).
 */
export type RouteKind = "own" | "plain" | "session";
/** `id`: the socket's inode and mtime when it was verified, so a socket replaced at the same path is a different route. */
export interface Route { kind: RouteKind; path?: string; id?: string }

/**
 * Runs the fixed argv (read.ts `run`) with WSL_INTEROP set to `interop` when given (else not set at all); calls
 * `onTimeout` when the deadline ended it.
 */
export type WinRunner = (cmd: string[], opts: { onTimeout: () => void; interop?: string }) => Promise<string | null>;

/** At most this many interop routes are tried in one sample (a wrong one fails in ~0.1 s with "Invalid argument"). */
export const MAX_INTEROP_TRIES = 4;
/**
 * An elevated session answers in ~0.2 s and is refused for good, so it doesn't use up a try; but no sample starts more
 * than this many PowerShells in all (an admin's SSH logins each make an elevated session).
 */
export const MAX_INTEROP_LAUNCHES = 8;
/**
 * A route that timed out, whichever kind, is skipped for this long: interop calls hang now and then, and killing the
 * WSL side of a hung call may leave its Windows powershell.exe running, so a hanging route must not be asked every
 * minute. No route can switch the query off for good (Codex temp-wsl r3: an unchecked plain route could).
 */
export const WIN_SESSION_TIMEOUT_SKIP_MS = 10 * 60_000;

/** At most this many `<pid>_interop` names are examined per listing (each costs an lstat and two /proc reads). */
export const MAX_SOCKET_NAMES = 1024;

export interface PathInfo { socket: boolean; symlink: boolean; uid: number; mtimeMs: number; ino?: number }

export interface InteropDeps {
  env?: Record<string, string | undefined>;
  /** This process's uid (default process.getuid()). */
  uid?: number;
  list?: () => Promise<string[]>;
  /** lstat: never follows a symlink. */
  lstat?: (path: string) => Promise<PathInfo | null>;
  /** The owner uid of /proc/<pid>, null when the process is gone. */
  procUid?: (pid: string) => Promise<number | null>;
  /** /proc/<pid>/comm. */
  comm?: (pid: string) => Promise<string | null>;
}

async function lstatInfo(path: string): Promise<PathInfo | null> {
  try {
    const st = await lstat(path);
    return { socket: st.isSocket(), symlink: st.isSymbolicLink(), uid: st.uid, mtimeMs: st.mtimeMs, ino: st.ino };
  } catch {
    return null;
  }
}

/** A socket WSL's init made: a real socket (not a symlink) owned by root. /run/WSL can be writable by anyone. */
function initSocket(info: PathInfo | null): info is PathInfo {
  return !!info && info.socket && !info.symlink && info.uid === 0;
}

/**
 * How to reach Windows from here, in order: this process's WSL_INTEROP when set, no WSL_INTEROP at all ("plain": WSL's
 * own lookup, which walks the parent processes' /run/WSL/<pid>_interop sockets and gets none of the checks below; it
 * is what any Windows program started from this process would use, so it is kept, but it can be answered by whoever
 * owns such a socket, so it is not trusted more than a borrowed one), then borrowed sessions newest first. A systemd service
 * (walkie.service on the WSL machines we tested) has neither: plain interop fails there with "Invalid argument" and only a live
 * session's socket works. A socket is borrowed only when all of these hold (Opus temp-wsl r2):
 * - `/run/WSL/<pid>_interop` is a socket, not a symlink, owned by uid 0;
 * - `<pid>` is a root process named `Relay(<child>)`: the relay WSL's init runs for each wsl.exe session;
 * - `<child>`, the session's own process, runs as this daemon's uid (not another user's, not a root session).
 * These checks are hygiene, not a trust boundary: depending on the WSL version /run/WSL is created 0777 without a
 * sticky bit (WSL_TEMP_FOLDER_MODE in WSL's source) or 0755 root (on the WSL machines we tested), and WSL chmods every
 * interop socket 0777, so a local user can swap a socket between this check and the connect, or answer on it. The
 * residual is denial of service or a fake reading (the interop client only relays output). Whether the session is
 * elevated on the Windows side can't be seen from here: the query refuses to run at High integrity (POWERSHELL_QUERY).
 * Names come from the directory listing, matched strictly.
 */
export async function interopRoutes(deps: InteropDeps = {}): Promise<Route[]> {
  const env = deps.env ?? process.env;
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  const list = deps.list ?? (async () => { try { return await readdir("/run/WSL"); } catch { return []; } });
  const info = deps.lstat ?? lstatInfo;
  const procUid = deps.procUid ?? (async (pid: string) => { try { return (await stat(`/proc/${pid}`)).uid; } catch { return null; } });
  const comm = deps.comm ?? (async (pid: string) => { try { return (await readFile(`/proc/${pid}/comm`, "utf8")).trim(); } catch { return null; } });
  const ownPath = env.WSL_INTEROP && /^\/run\/WSL\/\d{1,10}_interop$/.test(env.WSL_INTEROP) ? env.WSL_INTEROP : undefined;
  const own = ownPath && initSocket(await info(ownPath)) ? ownPath : undefined;
  const sessions: { path: string; at: number; id: string }[] = [];
  // Only matching names count toward the cap, so junk files can't push sessions out; past MAX_SOCKET_NAMES (a
  // /run/WSL flooded by a local user, possible where WSL makes it 0777) some sessions may not be listed: a denial of
  // service, the residual already accepted for this directory. Their refusals are kept regardless (see prune).
  const names = (await list()).filter((n) => /^\d{1,10}_interop$/.test(n)).slice(0, MAX_SOCKET_NAMES);
  for (const name of names) {
    const m = /^(\d{1,10})_interop$/.exec(name);
    if (!m) continue;
    const path = `/run/WSL/${name}`;
    if (path === ownPath) continue;
    const sock = await info(path);
    if (!initSocket(sock)) continue;
    const pid = m[1] as string;
    if ((await procUid(pid)) !== 0) continue;
    const relay = /^Relay\((\d{1,10})\)$/.exec((await comm(pid)) ?? "");
    if (!relay || (await procUid(relay[1] as string)) !== uid) continue;
    sessions.push({ path, at: sock.mtimeMs, id: `${sock.ino ?? 0}:${sock.mtimeMs}` });
  }
  sessions.sort((a, b) => b.at - a.at);
  return [
    ...(own ? [{ kind: "own" as const, path: own }] : []), { kind: "plain" as const },
    ...sessions.map((x) => ({ kind: "session" as const, path: x.path, id: x.id })),
  ];
}

export interface WindowsThermalDeps {
  run: WinRunner; clock?: () => number;
  /** The PowerShell path (default findPowershellDetail); a lookup with a reason turns it into the backoff note. */
  powershell?: () => Promise<string | null | PowershellLookup>;
  interop?: () => Promise<Route[]>;
  /**
   * The identity (`inode:mtime`, as Route.id) of the socket at a path now; null only when there is definitely none
   * (ENOENT); throws when it can't tell (default socketIdentity). A refusal is kept until this definitely changes,
   * not merely until the route drops out of a listing or an lstat fails.
   */
  socketId?: (path: string) => Promise<string | null>;
}

/** `inode:mtime` of the socket at `path` (no symlink followed), or null when there is none. */
export async function socketIdentity(path: string): Promise<string | null> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null; // definitely absent
    throw err; // EACCES, EIO, …: unknown, and the caller keeps what it knew
  }
  // Something is there but not a real socket: the socket that was refused is definitely gone.
  return st.isSocket() && !st.isSymbolicLink() ? `${st.ino}:${st.mtimeMs}` : `not-a-socket:${st.ino}`;
}

export interface WindowsZones { zones: Sensor[] | null; route?: RouteKind; note?: string }

const sameRoute = (a: Route, b: Route): boolean => a.kind === b.kind && a.path === b.path && a.id === b.id;
const routeKey = (r: Route): string => `${r.kind}:${r.path ?? ""}#${r.id ?? ""}`;
/** The socket mtime from a route id `inode:mtime`, or null (plain, own without an id, or a test id). */
const idMtime = (id: string | undefined): number | null => {
  const m = id ? /^\d+:(\d+(?:\.\d+)?)$/.exec(id) : null;
  return m ? Number(m[1]) : null;
};

/**
 * At most this many refusals are held. Refusals for sockets that are gone and skips that ran out are pruned every
 * sample; when the rest still fill it, sessions with no record are not tried at all until room frees (fail closed:
 * a refusal is never dropped to make room, so an elevated session is never launched twice).
 */
const MAX_REFUSED = 256;
const FOREVER = Number.POSITIVE_INFINITY;

/** The Windows thermal zones, sampled on the cadence above; between samples the last result is returned. */
export class WindowsThermal {
  private last: Sensor[] | null = null;
  private lastRoute: RouteKind | undefined;
  private lastGoodAt = Number.NEGATIVE_INFINITY;
  private lastAt = Number.NEGATIVE_INFINITY;
  private fails = 0;
  private elevated = false;
  private inflight: Promise<WindowsZones> | null = null;
  private readonly run: WinRunner;
  private readonly clock: () => number;
  private readonly powershell: () => Promise<string | null | PowershellLookup>;
  /** Why the last lookup found no PowerShell, when it says. */
  private lookupWhy: string | undefined;
  private readonly interop: () => Promise<Route[]>;
  /** The route that last worked, tried first; forgotten after one failure or unparseable output. */
  private route: Route | null = null;
  /**
   * The last route a failed sample tried (its key); the next sample starts right after it in the full listing, refused
   * routes included, so progress survives a skip running out and a timeout advances it too (Codex r2, r4).
   */
  private cursor: { key: string; index: number; mtime: number | null } | null = null;
  /**
   * Routes refused until a time, keyed by kind + path + inode + mtime: elevated (for as long as that socket exists) or
   * timed out (WIN_SESSION_TIMEOUT_SKIP_MS). Applies to every kind, own and plain included. Every sample drops skips
   * that ran out and refusals whose socket is gone or changed (socketId): a socket merely missing from one listing
   * (hidden by a failed check, or past the listing cap) keeps its refusal (Opus temp-wsl r4).
   */
  private readonly refused = new Map<string, { until: number; route: Route }>();
  private readonly socketId: (path: string) => Promise<string | null>;

  constructor(deps: WindowsThermalDeps) {
    this.run = deps.run;
    this.interop = deps.interop ?? (() => interopRoutes());
    this.clock = deps.clock ?? Date.now;
    this.powershell = deps.powershell ?? (() => findPowershellDetail());
    this.socketId = deps.socketId ?? socketIdentity;
  }

  /** Failures in a row (tests). */
  get failures(): number { return this.fails; }

  read(): Promise<WindowsZones> {
    if (this.inflight) return this.inflight;
    const wait = this.fails >= WIN_MAX_FAILS ? WIN_BACKOFF_MS : WIN_SAMPLE_MS;
    if (this.clock() - this.lastAt < wait) return Promise.resolve(this.result());
    this.lastAt = this.clock();
    this.inflight = this.sample().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private result(): WindowsZones {
    if (this.fails >= WIN_MAX_FAILS) {
      return {
        zones: null,
        note: this.lookupWhy ? `${this.lookupWhy} (retrying every 10 min)`
          : this.elevated
            ? "temperature: WSL interop runs PowerShell elevated here; the Windows thermal query refuses to (retrying every 10 min)"
            : "temperature: no Windows thermal zones readable through WSL interop (retrying every 10 min)",
      };
    }
    // Between samples the last good zones stand for WIN_KEEP_MS from when they were read, whatever the cadence.
    if (!this.last || this.clock() - this.lastGoodAt > WIN_KEEP_MS) return { zones: null };
    return { zones: this.last, ...(this.lastRoute ? { route: this.lastRoute } : {}) };
  }

  /** Records a refusal; false when there is no room (the caller then stops trying unrecorded sessions). */
  private refuse(route: Route, until: number): boolean {
    const key = routeKey(route);
    if (!this.refused.has(key) && this.refused.size >= MAX_REFUSED) return false;
    this.refused.set(key, { until: Math.max(until, this.refused.get(key)?.until ?? 0), route });
    return true;
  }

  private isRefused(route: Route): boolean {
    const until = this.refused.get(routeKey(route))?.until;
    return until !== undefined && this.clock() < until;
  }

  /** Whether a refusal for this route could be recorded if it needed one. */
  private canRecord(route: Route): boolean {
    return this.refused.has(routeKey(route)) || this.refused.size < MAX_REFUSED;
  }

  /**
   * Drops skips that ran out and refusals whose socket is gone or was replaced (its inode:mtime changed). Plain has
   * no socket and stays refused while refused. A route with no recorded identity is dropped only when its socket is gone.
   */
  private async prune(): Promise<void> {
    const now = this.clock();
    for (const [key, { until, route }] of [...this.refused]) {
      if (now >= until) { this.refused.delete(key); continue; }
      if (!route.path) continue;
      // null = definitely absent; a thrown error (EACCES, EIO, …) = unknown: keep the refusal (Opus r5).
      const current = await this.socketId(route.path).then((v): string | null | undefined => v, () => undefined);
      if (current === undefined) continue;
      if (current === null || (route.id !== undefined && current !== route.id)) this.refused.delete(key);
    }
  }

  /**
   * Where the cursor's route sits in this listing, so the next sample starts right after it. When that route has left
   * the listing (a short-lived session that hung and ended), continue after where it was, not from the top (Opus r5):
   * sessions are listed newest first, so that is the first session older than it; failing an mtime, its old index.
   * Short-lived sessions that keep appearing ahead can then never hold an older healthy one back. -1: from the top.
   */
  private cursorIndex(listed: readonly Route[]): number {
    const c = this.cursor;
    if (!c) return -1;
    const found = listed.findIndex((r) => routeKey(r) === c.key);
    if (found >= 0) return found;
    if (c.mtime !== null) {
      const older = listed.findIndex((r) => r.kind === "session" && (idMtime(r.id) ?? Number.POSITIVE_INFINITY) < (c.mtime as number));
      return older >= 0 ? older - 1 : listed.length - 1; // none older: its place was the end, so wrap to the top
    }
    return Math.min(c.index, listed.length - 1); // whatever took its slot is new: start after that slot
  }

  /** Refusals held (tests). */
  get refusedCount(): number { return this.refused.size; }

  /** The PowerShell to launch, looked up (mounts, realpath) right now; null when there is none. */
  private async currentBin(): Promise<string | null> {
    const found = await this.powershell();
    const lookup: PowershellLookup = typeof found === "string" || found === null ? { bin: found } : found;
    this.lookupWhy = lookup.bin ? undefined : lookup.why;
    return lookup.bin;
  }

  /**
   * Tries the routes in order until one answers; the zones (possibly []) and the route, or null. The PowerShell is
   * looked up again right before every launch (Codex temp-wsl r3: a path validated once and cached ran whatever was
   * at that path after the drive was unmounted).
   */
  private async tryRoutes(): Promise<{ zones: Sensor[]; route: Route } | null> {
    const listed = await this.interop();
    await this.prune();
    const routes = listed.filter((r) => !this.isRefused(r));
    // The remembered route is used only while it is still in the freshly verified list (Opus r3): a socket that was
    // replaced, or whose session changed owner, is not trusted on memory.
    const kept = this.route;
    const remembered = kept && routes.some((r) => sameRoute(r, kept)) ? kept : null;
    if (!remembered) this.route = null;
    // Rotate the FULL listing to start after the cursor, then drop refused and remembered ones: positions don't shift
    // when a refused route's skip runs out, so three hanging routes can't keep a fourth, healthy one from its turn.
    const at = this.cursorIndex(listed);
    const rotated = [...listed.slice(at + 1), ...listed.slice(0, at + 1)];
    const rest = rotated.filter((r) => !this.isRefused(r) && !(remembered && sameRoute(r, remembered)));
    const ordered = remembered ? [remembered, ...rest] : rest;
    let tries = 0;
    let launches = 0;
    for (const route of ordered) {
      if (tries >= MAX_INTEROP_TRIES || launches >= MAX_INTEROP_LAUNCHES) break;
      if (!this.canRecord(route)) continue; // refusal store full: fail closed for routes it couldn't refuse
      const bin = await this.currentBin();
      if (!bin) return null;
      launches += 1;
      if (!(remembered && sameRoute(route, remembered))) {
        this.cursor = { key: routeKey(route), index: listed.indexOf(route), mtime: idMtime(route.id) };
      }
      let timedOut = false;
      const out = await this.run(powershellArgv(bin), { onTimeout: () => { timedOut = true; }, ...(route.path ? { interop: route.path } : {}) });
      if (remembered && sameRoute(route, remembered)) this.route = null; // re-set below only if it still works
      if (timedOut) {
        this.refuse(route, this.clock() + WIN_SESSION_TIMEOUT_SKIP_MS);
        return null; // a hung Windows side: no further tries this sample
      }
      if (out !== null && out.trim() === ELEVATED_MARK) {
        this.elevated = true;
        this.refuse(route, FOREVER);
        continue;
      }
      tries += 1;
      const zones = parseWindowsZones(out);
      if (zones === null) continue; // can't reach Windows here, or PowerShell failed: the next route
      this.route = route;
      this.cursor = null;
      this.elevated = false; // the note says "elevated" only while no route has answered since
      return { zones, route };
    }
    return null; // the cursor already points past the routes tried now
  }

  private async sample(): Promise<WindowsZones> {
    let got: { zones: Sensor[]; route: Route } | null = null;
    try {
      got = await this.tryRoutes();
    } catch {
      got = null;
    }
    if (got && got.zones.length > 0) {
      this.fails = 0;
      this.last = got.zones;
      this.lastRoute = got.route.kind;
      this.lastGoodAt = this.clock();
    } else {
      this.fails += 1;
      if (this.clock() - this.lastGoodAt > WIN_KEEP_MS) {
        this.last = null;
        this.lastRoute = undefined;
      }
    }
    return this.result();
  }
}
