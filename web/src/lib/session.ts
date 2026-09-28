// The dashboard session (SEC-COOKIE-2). `walkie dashboard` opens /auth?nonce=…, which redirects to /#s=<session>:
// a URL fragment never reaches any server. This module (imported first, before the hash router reads the address)
// moves the value into localStorage and strips it from the address bar. Storage belongs to this page's origin,
// http://127.0.0.1:<port>, so unlike a cookie no other port on this machine can read it. Every /v1 call sends it
// as X-Walkie-Session; no cookie authorizes anything. localStorage rather than sessionStorage: Chromium dropped a
// tab's sessionStorage after a typed navigation to another site and back, and a new tab had none, so the
// dashboard signed out on ordinary browsing. The daemon still bounds the session (12 h idle, 7 days,
// `walkie dashboard logout`, `walkie token rotate`; it survives a daemon restart), and sign-out here forgets it in every tab.
/** The localStorage key holding the session (a `storage` event on it means another tab signed in). */
export const SESSION_KEY = "walkie.session";
const KEY = SESSION_KEY;
const FRAGMENT = /^#s=([0-9a-f]{64})$/;

let memory: string | null = null; // this tab's login, for when storage is unavailable (blocked site data)

function capture(): void {
  if (typeof window === "undefined") return; // imported outside a browser (unit tests)
  const m = FRAGMENT.exec(window.location.hash);
  if (!m) return;
  memory = m[1] as string;
  try {
    window.localStorage.setItem(KEY, memory);
  } catch {
    /* storage unavailable: the in-memory copy serves this tab */
  }
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

capture();

/** The latest login's session (another tab's newer login included), else this tab's own copy. */
export function sessionValue(): string | null {
  try {
    return window.localStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function forgetSession(): void {
  memory = null;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Request headers carrying the session (none when this tab has no session: the daemon answers 401). */
export function sessionHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const s = sessionValue();
  return s ? { ...extra, "X-Walkie-Session": s } : { ...extra };
}
