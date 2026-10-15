import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { defaultKeyStore, type KeyStore } from "../../accounts/vault/keystore.ts";
import { openAtRest, sealAtRest } from "../../accounts/vault/seal.ts";
import type { ChannelId } from "./types.ts";

const accountPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A Playwright storageState, including IndexedDB, sealed before it touches disk. */
export class ProfileStore {
  constructor(private readonly home: string, private readonly provided?: KeyStore) {}

  private path(channel: ChannelId, account: string): string {
    if (!accountPattern.test(account)) throw new Error("invalid channel account ID");
    return join(this.home, "channels", channel, `${account}.profile`);
  }

  private async key(channel: ChannelId, account: string, create: boolean): Promise<Buffer | null> {
    const keys = this.provided ?? await defaultKeyStore(this.home, homedir());
    const homeId = createHash("sha256").update(this.home).digest("hex").slice(0, 16);
    const id = `walkie-channel-${homeId}-${channel}-${account}`;
    const existing = await keys.get(id);
    if (existing || !create) return existing;
    await keys.put(id, randomBytes(32));
    return keys.get(id);
  }

  async load(channel: ChannelId, account: string): Promise<unknown | null> {
    const path = this.path(channel, account);
    if (!existsSync(path)) return null;
    const key = await this.key(channel, account, false);
    if (!key) throw new Error("channel profile key missing; re-link this account with the original key store");
    return JSON.parse(openAtRest(key, readFileSync(path), `walkie-channel|${channel}|${account}`)) as unknown;
  }

  async save(channel: ChannelId, account: string, state: unknown): Promise<void> {
    const path = this.path(channel, account);
    const key = await this.key(channel, account, true);
    if (!key) throw new Error("channel key store unavailable");
    mkdirSync(join(this.home, "channels", channel), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, sealAtRest(key, JSON.stringify(state), `walkie-channel|${channel}|${account}`), { mode: 0o600, flag: "wx" });
      renameSync(tmp, path);
      chmodSync(path, 0o600);
    } finally { if (existsSync(tmp)) rmSync(tmp); }
  }
}
