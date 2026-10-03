// The local secret for an owners-only create's dedup key (protocol/talkie-recs.ts sealedCreateKey). It lives in the
// daemon's home, mode 0600, like node.key. The file is published by linking a finished temp file over the name, so a
// crash cannot leave an empty key where the daemon would read it.
//
// A missing or unreadable file is not replaced. Replacing it would give every open private create a new key, and a
// dismissal of the old key would not hold the new one back. The first run (no key and no stamp) creates one. After
// that, `rec-seal.stamp` records that a key existed. `walkie doctor` reports a later loss, and it reports a key other
// people can read as its own failure: chmod 600, never deletion. The daemon sets the mode to 0600 when it reads the
// key. There is no `walkie doctor --fix`. To mint a new secret on purpose, stop Walkie and delete both rec-seal.key
// and rec-seal.stamp.
//
// The secret is per daemon. When WalkieTalkie leadership moves to another owner's machine, that machine has its own
// secret, so the same private create can be open once more under a different key, and dismissing one does not hold
// the other back.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const FILE = "rec-seal.key";
const STAMP = "rec-seal.stamp";
const HEX = /^[0-9a-f]{64}$/i;

export const REC_SEAL_REFUSE = "rec-seal.key is missing or unreadable. Walkie will not write a new one. To mint a new secret, stop Walkie and delete both rec-seal.key and rec-seal.stamp, then start Walkie again. Open private creates then get new keys, and dismissing one does not hold the other back. The same happens when WalkieTalkie leadership moves to another owner's machine, which has its own secret. There is no walkie doctor --fix.";

export class RecSealError extends Error {
  constructor(message = REC_SEAL_REFUSE) {
    super(message);
    this.name = "RecSealError";
  }
}

const cache = new Map<string, Buffer>();

export function recSealPath(home: string): string {
  return join(home, FILE);
}

function stampPath(home: string): string {
  return join(home, STAMP);
}

/** A finished file at `dest`, or false when `dest` already existed. The temp file is not left behind. */
function writeExclusive(dir: string, dest: string, body: string): boolean {
  const tmp = join(dir, `.rec-seal.key.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    const buf = Buffer.from(body);
    let off = 0;
    while (off < buf.length) {
      const n = writeSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) throw new RecSealError();
      off += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try { chmodSync(tmp, 0o600); } catch { /* opened at 0600 already */ }
  try {
    linkSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* the temp name is already gone */ }
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try { unlinkSync(tmp); } catch { /* dest holds the bytes */ }
  return true;
}

function isFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function ensureStamp(home: string): void {
  const stamp = stampPath(home);
  if (isFile(stamp)) return;
  try {
    if (lstatSync(stamp)) throw new RecSealError();
  } catch (err) {
    if (err instanceof RecSealError) throw err;
  }
  writeExclusive(home, stamp, "rec-seal\n");
}

function readWinner(path: string, home: string): Buffer {
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(path); } catch { throw new RecSealError(); }
  if (!st.isFile()) throw new RecSealError();
  if (st.mode & 0o077) {
    try { chmodSync(path, 0o600); }
    catch { throw new RecSealError(chmodAdvice(path, st.mode)); }
  }
  let text: string;
  try { text = readFileSync(path, "utf8").trim(); } catch { throw new RecSealError(); }
  if (!HEX.test(text)) throw new RecSealError();
  ensureStamp(home);
  return Buffer.from(text, "hex");
}

function secretMatches(path: string, secret: Buffer): boolean {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return false;
    return readFileSync(path, "utf8").trim() === secret.toString("hex");
  } catch {
    return false;
  }
}

/**
 * 32 bytes from `home`/rec-seal.key. The first run creates the file. A later process that finds the file gone or
 * unreadable throws RecSealError and does not write a new secret. A cached secret is used only while the file still
 * holds those bytes.
 */
export function loadOrCreateRecSeal(home: string): Buffer {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try { chmodSync(home, 0o700); } catch { /* a home this process cannot chmod is still the directory the key is written in */ }
  const path = recSealPath(home);
  const hit = cache.get(home);
  if (hit) {
    let st: ReturnType<typeof lstatSync> | null = null;
    try { st = lstatSync(path); } catch { st = null; }
    if (!st || !st.isFile()) {
      cache.delete(home);
      throw new RecSealError();
    }
    // The cached bytes are used only after the file is private again. A failed chmod refuses the create.
    if (st.mode & 0o077) {
      try { chmodSync(path, 0o600); }
      catch {
        cache.delete(home);
        throw new RecSealError(chmodAdvice(path, st.mode));
      }
    }
    if (secretMatches(path, hit)) return hit;
    cache.delete(home);
    throw new RecSealError();
  }
  let st: ReturnType<typeof lstatSync> | null = null;
  try { st = lstatSync(path); } catch { st = null; }
  if (!st) {
    if (isFile(stampPath(home))) throw new RecSealError();
    const bytes = randomBytes(32);
    if (!writeExclusive(home, path, `${bytes.toString("hex")}\n`)) return remember(home, readWinner(path, home));
    ensureStamp(home);
    return remember(home, bytes);
  }
  return remember(home, readWinner(path, home));
}

function remember(home: string, secret: Buffer): Buffer {
  cache.set(home, secret);
  return secret;
}

export interface RecSealCheck { level: "ok" | "warn" | "fail"; name: string; detail: string }

/** A key others can read. Says to chmod it. Never says to delete it: deleting would mint a new secret. */
function chmodAdvice(path: string, mode: number): string {
  return `rec-seal.key is mode ${(mode & 0o777).toString(8)}, not 0600. Run chmod 600 ${path}. Walkie will not write a new secret. The daemon sets the file to mode 0600 when it reads the key.`;
}

/**
 * What `walkie doctor` should say about the seal file. Read only: it never creates the key and it never changes the
 * mode. Null when this home has never had one, or the one it has is a private 32-byte hex file. A missing key names
 * the manual delete of both files. A key others can read names `chmod 600` and does not say to delete it.
 */
export function recSealCheck(home: string): RecSealCheck | null {
  const path = recSealPath(home);
  let key: ReturnType<typeof lstatSync> | null = null;
  try { key = lstatSync(path); } catch { key = null; }
  const stamped = isFile(stampPath(home));
  if (!key && !stamped) return null;
  const fail = (): RecSealCheck => ({ level: "fail", name: "rec seal", detail: REC_SEAL_REFUSE });
  if (!key || !key.isFile()) return fail();
  if (key.mode & 0o077) return { level: "fail", name: "rec seal", detail: chmodAdvice(path, key.mode) };
  let text = "";
  try { text = readFileSync(path, "utf8").trim(); } catch { return fail(); }
  if (!HEX.test(text)) return fail();
  return null;
}
