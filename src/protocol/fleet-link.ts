// Fleet links (FLEET-LINK-1): the shapes the daemon, the CLI, the dashboard and the site's /join page share, and the
// one place the shareable link and the install commands are built, so every surface says exactly the same thing.
// The token rides only in the URL FRAGMENT of the link (`/join#wl1…`), which browsers never send to a server.
import { INSTALL_URL, JOIN_URL } from "./add-machine.ts";

export const FLEET_LINK_PREFIX = "wl1";
/** Tokens are at most this long (the longest handle and relay hint included). */
export const FLEET_LINK_MAX_CHARS = 300;
/** The most machines one link may admit (0 = unlimited, bounded by the node limits). */
export const FLEET_LINK_MAX_USES = 1_000;
/** A new link admits this many machines unless told otherwise. */
export const FLEET_LINK_DEFAULT_USES = 25;
export const FLEET_LINK_DEFAULT_DAYS = 7;

/** The one-line install for a machine (macOS, Linux, WSL): pinned to the running release when there is one. */
export function fleetLinkCommand(token: string, tag: string | null): string {
  return `curl -fsSL ${INSTALL_URL} | ${tag ? `WALKIE_VERSION=${tag} ` : ""}sh -s -- --join-link ${token}`;
}

/** The same install from Windows PowerShell, run inside the default WSL2 distribution. */
export function fleetLinkWindowsCommand(token: string, tag: string | null): string {
  return `wsl -- sh -c "${fleetLinkCommand(token, tag)}"`;
}

/** The shareable link: the token and the release only in the fragment. */
export function fleetLinkUrl(token: string, tag: string | null): string {
  return `${JOIN_URL}#${token}${tag ? `&v=${tag}` : ""}`;
}

const TOKEN_SHAPE = /^wl1[A-Za-z0-9_-]{38,297}$/;

/**
 * The token in what a person pasted: the token itself, the /join link (the token is the fragment's first part), or the
 * whole install command, possibly wrapped over lines by a mail client. `valid` (the daemon's decoder) picks between the
 * token joined across line breaks and the first unbroken word; without it, the shape decides. Null when there is none.
 */
export function tokenFromInput(input: string, valid: (token: string) => boolean = () => true): string | null {
  const m = /(?:^|[\s#=])wl1[A-Za-z0-9_-]/.exec(input);
  if (!m) return null;
  const start = m.index + m[0].length - 4;
  const rest = input.slice(start);
  const joined = (/^[A-Za-z0-9_\-\s]+/.exec(rest)?.[0] ?? "").replace(/\s+/g, "");
  const first = /^[A-Za-z0-9_-]+/.exec(rest)?.[0] ?? "";
  return [joined, first].find((t) => TOKEN_SHAPE.test(t) && valid(t)) ?? null;
}

export type FleetLinkState = "active" | "used_up" | "expired" | "revoked" | "dead";

/** One link as owners see it (never the token: the authority doesn't have it). */
export interface FleetLinkView {
  id: string;
  /** The first 8 characters of `id`: enough for `walkie team link revoke <id>`. */
  short: string;
  handle: string;
  role: "owner" | "member" | "observer";
  /** 0 = unlimited. */
  uses: number;
  /** Machines admitted with it. */
  used: number;
  /** Machines waiting for an owner's approval (each holds a use). */
  pending: number;
  expires_at: number;
  approve: boolean;
  created_at: number;
  created_by: string;
  revoked_at: number | null;
  state: FleetLinkState;
  /** Why a link that is not active can't be used (dead: the member was removed or changed role, the minter isn't an owner). */
  reason?: string;
}

/** Every machine that presented a link the authority knows. */
export interface FleetLinkUse {
  link: string;
  node_id: string;
  hostname: string;
  state: "admitted" | "pending" | "declined" | "refused";
  reason?: string;
  at: number;
  /** Binding for a currently pending approval. Missing on old daemons: upgrade and retry the join. */
  generation?: string;
}

/** GET /v1/team/links (owners): the links, recent uses, and the roster authority that holds them. */
export interface FleetLinksView {
  links: FleetLinkView[];
  uses: FleetLinkUse[];
  authority: string;
}

/** POST /v1/team/links: the new link, with the token, the shareable link and the commands (shown once). */
export interface FleetLinkMinted extends FleetLinkView {
  token: string;
  link: string;
  command: string;
  windows_command: string;
  /** The daemon's version (the release the commands pin, when it is one). */
  version: string;
}
