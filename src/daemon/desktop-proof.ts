// Proof that a loopback listener is this daemon, for the Windows desktop app (WALK-79).
//
// The Windows app reaches the dashboard on a port that WSL forwards to Windows 127.0.0.1, and another Windows process
// can take that port. Before the app sends such a listener a login nonce it asks the listener to prove it is this
// daemon, with a value the listener cannot copy from an earlier request:
//
//   1. The app makes a random challenge C and registers it over the owner-only unix socket (the trusted path, through
//      its wsl.exe bridge). The daemon answers R = HMAC-SHA256(per-boot secret, C) there.
//   2. The app asks the Windows listener to answer the same C. Only this daemon holds the secret, and it answers a
//      loopback request only for a challenge that was registered over the socket, has not expired and has not been
//      answered: the loopback route is no oracle for arbitrary challenges, and a saved answer is worth nothing.
//   3. The app opens the login URL only if the two answers are equal.
//
// The secret is made at boot and never leaves this object: it is not logged, stored or sent. An answer is bound to one
// challenge and, through the secret, to one daemon boot.
import { createHmac, randomBytes } from "node:crypto";

/** A challenge lives this long: the app asks the listener right after registering it. */
export const DESKTOP_CHALLENGE_TTL_MS = 10_000;
/** Live challenges kept at once; the oldest is dropped first (the nonce map's rule). */
const MAX_LIVE = 32;
const CHALLENGE = /^[0-9a-f]{64}$/;
/** Domain separation: the secret MACs nothing but this protocol's challenges. */
const DOMAIN = "walkie-desktop-listener-proof/v1\n";

/** A challenge is 32 random bytes in lowercase hex. */
export function isDesktopChallenge(v: unknown): v is string {
  return typeof v === "string" && CHALLENGE.test(v);
}

export interface DesktopProofOptions {
  /** The clock (tests). */
  now?: () => number;
}

interface Live { readonly expiresAt: number; readonly answered: boolean }

export class DesktopProof {
  private readonly secret = randomBytes(32);
  /** Registered challenges by value; an answered one stays until it expires, so it can be neither answered nor registered again. */
  private readonly live = new Map<string, Live>();
  private readonly now: () => number;

  constructor(opts: DesktopProofOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * The trusted path: registers a challenge and returns the daemon's answer. Null when the challenge is malformed or
   * is already registered and unexpired (answered or not): a challenge is single use.
   */
  register(challenge: string): { answer: string; expiresAt: number } | null {
    if (!isDesktopChallenge(challenge)) return null;
    const now = this.now();
    this.sweep(now);
    if (this.live.has(challenge)) return null;
    while (this.live.size >= MAX_LIVE) this.live.delete(this.live.keys().next().value as string);
    const expiresAt = now + DESKTOP_CHALLENGE_TTL_MS;
    this.live.set(challenge, { expiresAt, answered: false });
    return { answer: this.mac(challenge), expiresAt };
  }

  /**
   * The untrusted path (loopback): the answer, once, for a challenge that is registered, unexpired and unanswered.
   * Null for anything else, with nothing to tell the reasons apart.
   */
  answer(challenge: string): string | null {
    const now = this.now();
    this.sweep(now);
    const entry = this.live.get(challenge);
    if (!entry || entry.answered) return null;
    this.live.set(challenge, { ...entry, answered: true });
    return this.mac(challenge);
  }

  private sweep(now: number): void {
    for (const [c, e] of this.live) if (e.expiresAt <= now) this.live.delete(c);
  }

  private mac(challenge: string): string {
    return createHmac("sha256", this.secret).update(DOMAIN + challenge).digest("hex");
  }
}
