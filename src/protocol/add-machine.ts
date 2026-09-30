// "Add a machine" (WALKIE-ADD-MACHINE-1): what an owner hands to an existing member so another of their machines
// joins. One place builds the shareable link and the install command, so the daemon (and through it the CLI and
// the dashboard) and the site's /join page say exactly the same thing.
//
// The link carries the invite code in the URL FRAGMENT (`/join#wk1…`): browsers never send a fragment to the
// server, so the code stays out of request logs, and the page strips it from the address bar once read. The
// running release rides along (`&v=v0.2.0-pre.2`) so the page's command installs the same version the team runs, and
// `&a=1` when that build's setup asks the consent question (the page only then describes it).

export const SITE_URL = "https://getwalkie.vercel.app";
export const INSTALL_URL = `${SITE_URL}/install.sh`;
export const JOIN_URL = `${SITE_URL}/join`;

/** A release tag scripts/install.sh accepts for WALKIE_VERSION (it refuses anything else). */
export const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/;

/** "0.2.0-pre.2" → "v0.2.0-pre.2"; null when the running version isn't a release (a dev build). */
export function releaseTag(version: string): string | null {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return RELEASE_TAG_RE.test(tag) ? tag : null;
}

/** The one-line install for another machine: the running release is a minimum. */
export function addMachineCommand(code: string, tag: string | null): string {
  return `curl -fsSL ${INSTALL_URL} | ${tag ? `WALKIE_MIN_VERSION=${tag} ` : ""}sh -s -- --invite ${code}`;
}

/**
 * The shareable link: the code, the release and `a=1` (this build's setup asks "may your team start agents here?")
 * only in the fragment.
 */
export function addMachineLink(code: string, tag: string | null, teamAgents = false): string {
  return `${JOIN_URL}#${code}${tag ? `&v=${tag}` : ""}${teamAgents ? "&a=1" : ""}`;
}

/** POST /v1/team/add-machine → another machine for a current member. The code is a one-time bearer credential. */
export interface AddMachine {
  code: string;
  handle: string;
  role: "owner" | "member" | "observer";
  expires_at: number;
  existing_member: true;
  /** The daemon's version (the release the command requires at minimum, when it is one). */
  version: string;
  /** This build hosts seats, so its setup asks the new machine's person "may your team start agents here?". */
  team_agents: boolean;
  link: string;
  command: string;
}
