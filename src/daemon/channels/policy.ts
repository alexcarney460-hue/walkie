import type { ChannelId } from "./types.ts";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { randomBytes } from "node:crypto";

type Decision = "accepted" | "unknown" | "off" | "limited";
const HOUR = 3_600_000;
const PER_NUMBER = 10;
const PER_MACHINE = 60;

/** Admission is fail-closed: only this machine owner's verified number may enter its Talkie host. */
export class ChannelGate {
  private readonly inbound = new Map<string, number>();
  private readonly numbers = new Map<string, number[]>();
  private machine: number[] = [];
  ignored = 0;
  private blocked = false;
  private seenFile = false;
  constructor(private readonly now: () => number = Date.now, private readonly file?: string,
    private readonly initialized: () => boolean = () => false,
    private readonly enabledInSettings: () => boolean = () => false) {
    this.load();
  }

  get quotaDamaged(): boolean {
    this.load();
    return this.blocked;
  }

  private load(): void {
    if (!this.file || this.blocked) return;
    const file = this.file;
    try {
      try { if (!lstatSync(file).isFile()) throw new Error("invalid quota file"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const dir = dirname(file);
        if (this.initialized() || this.enabledInSettings() || this.seenFile || (existsSync(dir) && readdirSync(dir).some((name) => name.startsWith(`${basename(file)}.damaged-`))))
          throw new Error("missing quota after prior record");
        return;
      }
      if (!this.initialized()) throw new Error("quota file without initialization marker");
      const data = JSON.parse(readFileSync(file, "utf8")) as { numbers: Record<string, number[]>; machine?: number[]; channels?: Record<ChannelId, number[]>; ignored: number };
      if (!data || typeof data !== "object" || Array.isArray(data) || !Number.isSafeInteger(data.ignored) || data.ignored < 0 || !data.numbers || typeof data.numbers !== "object" || Array.isArray(data.numbers))
        throw new Error("invalid quota");
      if (data.machine === undefined && data.channels === undefined) throw new Error("invalid quota");
      if (data.channels !== undefined && (!data.channels || typeof data.channels !== "object" || Array.isArray(data.channels))) throw new Error("invalid quota");
      for (const values of Object.values(data.channels ?? {}))
        if (!Array.isArray(values) || !values.every((at) => Number.isSafeInteger(at) && at >= 0)) throw new Error("invalid quota");
      const numbers = new Map<string, number[]>();
      for (const [key, values] of Object.entries(data.numbers)) {
        if (!Array.isArray(values) || !values.every((at) => Number.isSafeInteger(at) && at >= 0)) throw new Error("invalid quota");
        if (key.includes(":") && !/^(whatsapp-web|sms-gvoice):/.test(key)) throw new Error("invalid quota");
        const number = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
        if (!/^\+[1-9]\d{6,14}$/.test(number)) throw new Error("invalid quota");
        numbers.set(number, [...(numbers.get(number) ?? []), ...values]);
      }
      const machine = data.machine ?? Object.values(data.channels ?? {}).flat();
      if (!Array.isArray(machine) || !machine.every((at) => Number.isSafeInteger(at) && at >= 0)) throw new Error("invalid quota");
      this.numbers.clear();
      for (const [number, values] of numbers) this.numbers.set(number, values);
      this.machine = machine;
      this.ignored = data.ignored;
      this.seenFile = true;
    } catch { this.blocked = true; }
  }

  /** Called only by the person-only enable route, before committing the settings marker. */
  initializeQuota(): void {
    if (!this.file) throw new Error("quota path is required");
    this.load();
    if (this.blocked) throw new Error("quota record is damaged; run walkie channels reset-quota");
    if (this.initialized()) return;
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    if (this.blocked) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ ignored: this.ignored, numbers: Object.fromEntries(this.numbers), machine: this.machine }));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(tmp, this.file);
      this.seenFile = true;
      const dir = openSync(dirname(this.file), "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch (error) {
      this.blocked = true;
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* keep the original write failure */ }
      throw error;
    }
  }

  resetQuota(): string | null {
    if (!this.file || !this.quotaDamaged) throw new Error("quota record is not damaged");
    const file = this.file;
    const prior = existsSync(dirname(file))
      ? readdirSync(dirname(file)).filter((name) => name.startsWith(`${basename(file)}.damaged-`)).sort().at(-1)
      : undefined;
    const backup = existsSync(this.file)
      ? `${this.file}.damaged-${new Date().toISOString().replace(/:/g, "-")}-${randomBytes(4).toString("hex")}`
      : prior ? `${dirname(this.file)}/${prior}` : null;
    if (existsSync(this.file) && backup) renameSync(this.file, backup);
    this.numbers.clear();
    this.machine = [];
    this.inbound.clear();
    this.ignored = 0;
    this.blocked = false;
    this.save();
    return backup;
  }

  receive(channel: ChannelId, number: string, ownerNumber: string | null, enabled: boolean): Decision {
    this.load();
    if (!ownerNumber || number !== ownerNumber) { this.ignored++; if (!this.blocked && (!this.file || this.initialized())) { try { this.save(); } catch { /* admission remains closed */ } } return "unknown"; }
    if (!enabled) return "off";
    if (this.blocked) return "limited";
    if (this.file && !this.initialized()) return "limited";
    const now = this.now();
    const recentNumber = (this.numbers.get(number) ?? []).filter((at) => now - at < HOUR);
    const recentMachine = this.machine.filter((at) => now - at < HOUR);
    if (recentNumber.length >= PER_NUMBER || recentMachine.length >= PER_MACHINE) return "limited";
    this.numbers.set(number, [...recentNumber, now]);
    this.machine = [...recentMachine, now];
    this.inbound.set(`${channel}:${number}`, now);
    try { this.save(); } catch { this.inbound.delete(`${channel}:${number}`); return "limited"; }
    return "accepted";
  }

  canReply(channel: ChannelId, number: string): boolean {
    this.load();
    if (this.blocked) return false;
    const at = this.inbound.get(`${channel}:${number}`);
    return at !== undefined && this.now() - at < HOUR;
  }

  claimReply(channel: ChannelId, number: string): boolean {
    if (!this.canReply(channel, number)) return false;
    this.inbound.delete(`${channel}:${number}`);
    return true;
  }
}
