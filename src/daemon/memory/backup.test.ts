import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, lstatSync, symlinkSync, existsSync, mkdirSync, copyFileSync, renameSync, realpathSync, readdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { SemanticStore } from "./semantic.ts";
import { gbrainPaths } from "./gbrain.ts";
import { backupInit, backupKeyId, backupExport, backupRestore, recoverBackupRestore, recoveryKey, BACKUP_TABLE_CLASSIFICATION, setBackupStepForTests, setRestoreStepForTests, type BackupCredentialStore } from "./backup.ts";
import { memory as memoryCommand } from "../../cli/commands/memory.ts";
import type { Ctx } from "../../cli/context.ts";
import { setTtyForTests } from "../../cli/tty.ts";
import { setBackupKeyStoreForTests } from "../../cli/commands/memory.ts";
import { dispatch, type RouteCtx } from "../local-routes.ts";
import { finishBackupRestore } from "./routes.ts";
import { DEFAULT_LIMITS, RateLimiter } from "../ratelimit.ts";
import { applyRosterEvent, EMPTY_ROSTER } from "../roster.ts";
import { createTeam, tnode } from "../../../test/helpers/events.ts";
import "./routes.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "walkie-backup-test-"));
  const source = join(root, "source");
  const fresh = join(root, "fresh");
  const file = join(root, "memory.wmb");
  const keyMap = new Map<string, Buffer>();
  const keys: BackupCredentialStore = {
    kind: "keychain",
    async get(id) { return keyMap.get(id) ?? null; },
    async put(id, key) { if (keyMap.has(id)) return "exists"; keyMap.set(id, Buffer.from(key)); return "created"; },
  };
  const memory = MemoryStore.open(source);
  memory.add({ text: "private note: arctic otter", actor: "person", owner: "person-a" });
  const first = memory.learnings().add({ owner: "person-a", actor: "person", machine: "test-machine", category: "fact", rule: "Otters swim", evidence: "observation", confidence: 1, requestId: "first" });
  memory.learnings().correct({ owner: "person-a", actor: "person", machine: "test-machine", category: "fact", rule: "Otters float", evidence: "new observation", confidence: 1, requestId: "second", supersedes: first.id });
  memory.setClaudeMemSettings("person-a", { enabled: false, path: join(root, "plugin.db"), freshnessDays: 30, allowedProjects: ["sample"] });
  const graph = SemanticStore.create(source);
  const id = graph.addEntity("person-a", { slug: "otter", name: "Otter", kind: "animal", summary: "A written entity", validAsOf: 1000, confidence: 1 });
  graph.addAlias("person-a", id, "sea otter");
  graph.close();
  memory.close();
  const gbrain = gbrainPaths(source, "person-a");
  mkdirSync(gbrain.directory, { recursive: true, mode: 0o700 });
  writeFileSync(gbrain.settings, JSON.stringify({ enabled: false, binary: "gbrain" }), { mode: 0o600 });
  return { source, fresh, file, keys, keyMap };
}

describe("personal backup", () => {
  test("every migrated memory and semantic table has an explicit backup classification", () => {
    const f = fixture();
    for (const [file, classification] of [["memory.db", BACKUP_TABLE_CLASSIFICATION.memory],
      ["semantic.db", BACKUP_TABLE_CLASSIFICATION.semantic]] as const) {
      const db = new Database(join(f.source, file), { readonly: true });
      try {
        const actual = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all().map(({ name }) => name);
        expect(actual).toEqual(Object.keys(classification).sort());
        expect(Object.values(classification).every((item) => item.scope === "person" || (item.scope === "excluded" && item.reason.length > 0))).toBe(true);
      } finally { db.close(); }
    }
  });

  test("a backup of A contains no B rows or B's machine legacy decision", async () => {
    const f = fixture();
    const source = MemoryStore.open(f.source);
    source.add({ text: "foreign note violet ibex 187921", actor: "person", owner: "person-b" });
    source.learnings().add({ owner: "person-b", actor: "person", machine: "test-machine", category: "fact",
      rule: "Foreign ibex rule", evidence: "foreign observation", confidence: 1, requestId: "foreign" });
    source.setPrimer("person-b", "foreign-project", { inProgress: "foreign primer", nextStep: "foreign next step", blockers: [] });
    source.setClaudeMemSettings("person-b", { enabled: false, path: join(f.source, "foreign.db"), freshnessDays: 30, allowedProjects: [] });
    source.close();
    const graph = SemanticStore.open(f.source)!;
    graph.addEntity("person-b", { slug: "ibex", name: "Ibex", kind: "animal", summary: "Foreign entity",
      validAsOf: 1000, confidence: 1 });
    graph.close();
    const db = new Database(join(f.source, "memory.db"));
    db.query("INSERT INTO memory_legacy_decision(id,team,node,person) VALUES (1,?,?,?)").run("foreign-team", "foreign-node", "person-b");
    db.close();
    const code = await backupInit(f.source, "person-a", f.keys);
    const exported = await backupExport(f.source, "person-a", f.file, f.keys);
    const bytes = readFileSync(f.file);
    const start = 9 + 4;
    const n = bytes.readUInt32BE(9);
    const decipher = createDecipheriv("aes-256-gcm", recoveryKey(code), bytes.subarray(start + n, start + n + 12));
    decipher.setAAD(bytes.subarray(start, start + n));
    decipher.setAuthTag(bytes.subarray(start + n + 12, start + n + 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(start + n + 28)), decipher.final()]).toString("utf8")) as { database: string; entities: string };
    const image = Buffer.from(payload.database, "base64");
    expect(image.includes(Buffer.from("foreign note violet ibex 187921"))).toBe(false);
    expect(image.includes(Buffer.from("person-b"))).toBe(false);
    expect(payload.entities).not.toContain("person-b");
    const restored = await backupRestore(f.fresh, "person-a", f.file, code, false, f.keys);
    expect(restored.digest).toBe(exported.digest);
    const freshDb = new Database(join(f.fresh, "memory.db"), { readonly: true });
    try {
      expect(freshDb.query("SELECT person FROM memory_legacy_decision WHERE id = 1").get()).toBeNull();
      expect(freshDb.query("SELECT 1 FROM memory WHERE owner = 'person-b'").get()).toBeNull();
      expect(freshDb.query("SELECT 1 FROM personal_learnings WHERE owner = 'person-b'").get()).toBeNull();
      expect(freshDb.query("SELECT 1 FROM personal_primers WHERE person = 'person-b'").get()).toBeNull();
      expect(freshDb.query("SELECT 1 FROM personal_claude_mem WHERE owner = 'person-b'").get()).toBeNull();
    } finally { freshDb.close(); }
  });

  test("an unclassified table refuses export before any backup is published", async () => {
    const f = fixture();
    await backupInit(f.source, "person-a", f.keys);
    const db = new Database(join(f.source, "memory.db"));
    db.exec("CREATE TABLE future_private_data(secret TEXT); INSERT INTO future_private_data VALUES ('other person')");
    db.close();
    await expect(backupExport(f.source, "person-a", f.file, f.keys)).rejects.toThrow("unclassified memory backup table");
    expect(existsSync(f.file)).toBe(false);
  });
  test("prototype-named tables in either database cannot enter another person's backup", async () => {
    for (const file of ["memory.db", "semantic.db"] as const) {
      for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        const f = fixture();
        const db = new Database(join(f.source, file));
        db.exec(`CREATE TABLE "${name}" (owner TEXT, secret TEXT)`);
        db.query(`INSERT INTO "${name}" VALUES (?, ?)`).run("person-b", "FOREIGN_TABLE_SECRET_771");
        db.close();
        await backupInit(f.source, "person-a", f.keys);
        await expect(backupExport(f.source, "person-a", f.file, f.keys))
          .rejects.toThrow(`unclassified ${file === "memory.db" ? "memory" : "semantic"} backup table: ${name}`);
        expect(existsSync(f.file)).toBe(false);
      }
    }
  });
  test("restore applies only named personal tables from an authenticated image", async () => {
    const f = fixture();
    const code = await backupInit(f.source, "person-a", f.keys);
    await backupExport(f.source, "person-a", f.file, f.keys);
    const bytes = readFileSync(f.file);
    const headerStart = 13;
    const headerLength = bytes.readUInt32BE(9);
    const aad = bytes.subarray(headerStart, headerStart + headerLength);
    const iv = bytes.subarray(headerStart + headerLength, headerStart + headerLength + 12);
    const tag = bytes.subarray(headerStart + headerLength + 12, headerStart + headerLength + 28);
    const key = recoveryKey(code);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad); decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(headerStart + headerLength + 28)), decipher.final()]).toString("utf8")) as { database: string };
    const image = join(f.source, "forged.db");
    writeFileSync(image, Buffer.from(payload.database, "base64"));
    const db = new Database(image);
    db.exec('CREATE TABLE "toString" (owner TEXT, secret TEXT)');
    db.query('INSERT INTO "toString" VALUES (?, ?)').run("person-b", "FOREIGN_TABLE_SECRET_771");
    db.close();
    const sealImage = () => {
      const nextIv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nextIv);
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify({ ...payload, database: readFileSync(image).toString("base64") })), cipher.final()]);
      writeFileSync(f.file, Buffer.concat([bytes.subarray(0, headerStart), aad, nextIv, cipher.getAuthTag(), encrypted]));
    };
    sealImage();
    await expect(backupRestore(f.fresh, "person-a", f.file, code)).rejects.toThrow("unclassified memory backup table: toString");
    expect(existsSync(join(f.fresh, "memory.db"))).toBe(false);
    const changed = new Database(image);
    changed.exec('DROP TABLE "toString"');
    changed.query("INSERT INTO memory_legacy_decision(id,team,node,person) VALUES (1,?,?,?)")
      .run("foreign-team", "foreign-node", "person-b");
    changed.close();
    sealImage();
    await backupRestore(f.fresh, "person-a", f.file, code);
    const installed = new Database(join(f.fresh, "memory.db"), { readonly: true });
    try { expect(installed.query("SELECT 1 FROM memory_legacy_decision").get()).toBeNull(); }
    finally { installed.close(); }
  });
  test("the daemon has an identity response but no code-generating route", async () => {
    const f = fixture();
    const alex = tnode("alex");
    const { create } = createTeam(alex);
    const roster = [create].reduce(applyRosterEvent, EMPTY_ROSTER);
    const request = async (method: string, path: string, body?: unknown) => {
      const req = new Request(`http://walkie${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      try {
        const response = await dispatch({ req, url: new URL(req.url), via: "cli", listener: "unix", noTimeout: () => {},
          core: { paths: { home: f.source }, teamId: create.team, nodeId: alex.keys.nodeId, roster,
            myHandle: () => "alex", limits: DEFAULT_LIMITS, limiter: new RateLimiter() },
        } as unknown as RouteCtx);
        return { status: response.status, text: await response.text() };
      } catch (error) { return { status: (error as { status: number }).status, text: String(error) }; }
    };
    const identity = await request("GET", "/v1/memory/backup/identity");
    expect(identity.status).toBe(200);
    expect(identity.text).toContain("keyId");
    expect(identity.text).not.toContain("recoveryCode");
    const rejected = await request("POST", "/v1/memory/backup", { action: "init" });
    expect(rejected.status).not.toBe(200);
    expect(rejected.text).not.toContain("recoveryCode");
  });

  test("init shows the code only on the controlling terminal, never in output or a response", async () => {
    const f = fixture();
    const shown: string[] = [];
    const output: string[] = [];
    let requests = 0;
    setTtyForTests({ ask: async () => "", secret: async () => "", show: (s) => shown.push(s), close: () => {} });
    setBackupKeyStoreForTests(f.keys);
    try {
      const ctx = {
        args: { pos: ["backup", "init"], flags: new Map() }, json: false,
        agentMarker: () => null, agentSignals: () => ({ marker: null, inspection: "ok" }),
        person: { interactive: () => true, ask: async () => "yes", note: () => {} },
        client: () => ({ request: async () => { requests++; return { keyId: backupKeyId("person-a"), home: f.source }; } }),
        out: (s: string) => output.push(s), err: (s: string) => output.push(s),
      } as unknown as Ctx;
      await memoryCommand(ctx);
      expect(shown.join(" ")).toMatch(/[0-9A-F]{8}(?:-[0-9A-F]{8}){8}/);
      expect(output.join(" ")).not.toMatch(/[0-9A-F]{8}(?:-[0-9A-F]{8}){8}/);
      expect(requests).toBe(1);
    } finally { setTtyForTests(undefined); setBackupKeyStoreForTests(undefined); }
  });

  test("init without a controlling terminal refuses before requesting or storing a key", async () => {
    let requests = 0;
    setTtyForTests(null);
    try {
      const ctx = {
        args: { pos: ["backup", "init"], flags: new Map() }, json: false,
        agentMarker: () => null, agentSignals: () => ({ marker: null, inspection: "ok" }),
        person: { interactive: () => true, ask: async () => "yes", note: () => {} },
        client: () => ({ request: async () => { requests++; return {}; } }), out: () => {}, err: () => {},
      } as unknown as Ctx;
      await expect(memoryCommand(ctx)).rejects.toThrow("controlling terminal");
      expect(requests).toBe(0);
    } finally { setTtyForTests(undefined); }
  });

  test("restore sends only a derived key to the daemon", async () => {
    const f = fixture();
    const code = await backupInit(f.source, "person-a", f.keys);
    const bodies: unknown[] = [];
    setTtyForTests({ ask: async () => "", secret: async () => code, close: () => {} });
    try {
      const ctx = {
        args: { pos: ["backup", "restore", f.file], flags: new Map() }, json: false,
        agentMarker: () => null, agentSignals: () => ({ marker: null, inspection: "ok" }),
        person: { interactive: () => true, ask: async () => "yes", note: () => {} },
        client: () => ({ request: async (_method: string, _path: string, body: unknown) => { bodies.push(body); return { digest: "digest", path: f.file }; } }),
        out: () => {}, err: () => {},
      } as unknown as Ctx;
      await memoryCommand(ctx);
      expect(JSON.stringify(bodies)).not.toContain(code);
      expect(JSON.stringify(bodies)).not.toContain("code");
      expect(JSON.stringify(bodies)).toContain('"key"');
    } finally { setTtyForTests(undefined); }
  });

  test("the CLI prints an installed restore and its credential warning", async () => {
    const f = fixture();
    const code = await backupInit(f.source, "person-a", f.keys);
    const output: string[] = [];
    setTtyForTests({ ask: async () => "", secret: async () => code, close: () => {} });
    try {
      const ctx = {
        args: { pos: ["backup", "restore", f.file], flags: new Map() }, json: false,
        agentMarker: () => null, agentSignals: () => ({ marker: null, inspection: "ok" }),
        person: { interactive: () => true, ask: async () => "yes", note: () => {} },
        client: () => ({ request: async () => ({ digest: "digest", path: f.file, warning: "Run walkie memory backup init before the next export." }) }),
        out: (s: string) => output.push(s), err: (s: string) => output.push(s),
      } as unknown as Ctx;
      await memoryCommand(ctx);
      expect(output.join(" ")).toContain("restored:");
      expect(output.join(" ")).toContain("warning: Run walkie memory backup init");
      expect(output.join(" ")).not.toContain(code);
    } finally { setTtyForTests(undefined); }
  });

  test("a failed gbrain sync reports an installed restore with a rebuild command", async () => {
    const f = fixture();
    const code = await backupInit(f.source, "person-a", f.keys);
    const exported = await backupExport(f.source, "person-a", f.file, f.keys);
    const restored = await backupRestore(f.fresh, "person-a", f.file, code, false, f.keys);
    const result = await finishBackupRestore(restored, f.fresh, "person-a",
      async () => ({ state: "ready" }),
      async () => ({ state: "unavailable", reason: "test sync failure" }));
    expect(result.digest).toBe(exported.digest);
    expect(result.warning).toBe("gbrain could not be rebuilt: test sync failure; run walkie memory gbrain sync");
    expect(existsSync(join(f.fresh, "memory.db"))).toBe(true);
    const thrown = await finishBackupRestore(restored, f.fresh, "person-a",
      async () => ({ state: "ready" }),
      async () => { throw new Error("test sync exception"); });
    expect(thrown.digest).toBe(exported.digest);
    expect(thrown.warning).toBe("gbrain could not be rebuilt: test sync exception; run walkie memory gbrain sync");
  });

  test("round trip preserves canonical digest, excludes plaintext and rebuilds derived indexes", async () => {
    const f = fixture();
    const code = await backupInit(f.source, "person-a", f.keys);
    const exported = await backupExport(f.source, "person-a", f.file, f.keys);
    const bytes = readFileSync(f.file);
    expect(lstatSync(f.file).mode & 0o777).toBe(0o600);
    expect(bytes.includes(Buffer.from(code))).toBe(false);
    expect(bytes.includes(Buffer.from("arctic otter"))).toBe(false);
    const secondKeys = { ...f.keys,
      get: async (id: string) => secondMap.get(id) ?? null,
      put: async (id: string, key: Buffer) => { if (secondMap.has(id)) return "exists" as const; secondMap.set(id, Buffer.from(key)); return "created" as const; },
    };
    const secondMap = new Map<string, Buffer>();
    const restored = await backupRestore(f.fresh, "person-a", f.file, code, false, secondKeys);
    expect(restored.digest).toBe(exported.digest);
    const semantic = SemanticStore.open(f.fresh)!;
    expect(semantic.list("person-a").entities).toHaveLength(1);
    expect(semantic.status("person-a").mentions).toBeGreaterThan(0);
    semantic.close();
    const memory = MemoryStore.open(f.fresh);
    expect(memory.search("arctic", 10, "person-a")).toHaveLength(1);
    expect(memory.learnings().list("person-a", true, 10)).toHaveLength(2);
    expect(memory.claudeMemSettings("person-a").allowedProjects).toEqual(["sample"]);
    memory.close();
    expect(readFileSync(gbrainPaths(f.fresh, "person-a").settings, "utf8")).toContain('"enabled":false');
    expect(secondMap.size).toBe(1);
    const nextFile = join(f.fresh, "next.wmb");
    expect((await backupExport(f.fresh, "person-a", nextFile, secondKeys)).digest).toBe(exported.digest);
  });

  test("wrong code, other person, changed byte and truncated file are refused", async () => {
    const f = fixture();
    const code = await backupInit(f.source, "person-a", f.keys);
    await backupExport(f.source, "person-a", f.file, f.keys);
    const other = fixture();
    const otherCode = await backupInit(other.source, "person-a", other.keys);
    await expect(backupRestore(f.fresh, "person-a", f.file, otherCode)).rejects.toThrow();
    await expect(backupRestore(f.fresh, "person-b", f.file, code)).rejects.toThrow();
    const original = readFileSync(f.file);
    const tampered = Buffer.from(original); tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    writeFileSync(f.file, tampered);
    await expect(backupRestore(f.fresh, "person-a", f.file, code)).rejects.toThrow();
    writeFileSync(f.file, original.subarray(0, original.length - 10));
    await expect(backupRestore(f.fresh, "person-a", f.file, code)).rejects.toThrow();
  });

  test("requires an OS credential store", async () => {
    const f = fixture();
    await expect(backupInit(f.source, "person-a", { ...f.keys, kind: "file" })).rejects.toThrow("credential store");
    const code = await backupInit(f.source, "person-a", f.keys);
    await backupExport(f.source, "person-a", f.file, f.keys);
    await expect(backupRestore(f.fresh, "person-a", f.file, code, false, { ...f.keys, kind: "file" })).rejects.toThrow("credential store");
  });

  test("changing only gbrain settings changes the full restored digest", async () => {
    const f = fixture();
    await backupInit(f.source, "person-a", f.keys);
    const first = await backupExport(f.source, "person-a", f.file, f.keys);
    writeFileSync(gbrainPaths(f.source, "person-a").settings, JSON.stringify({ enabled: false, binary: "changed" }), { mode: 0o600 });
    const second = await backupExport(f.source, "person-a", join(f.source, "second.wmb"), f.keys);
    expect(second.digest).not.toBe(first.digest);
  });

  test("failed replacement and each interrupted swap retain the old memory on recovery", async () => {
    for (const step of ["journal", "move-memory", "install-memory", "move-semantic", "install-semantic", "install-settings"]) {
      const f = fixture();
      const old = MemoryStore.open(f.fresh);
      old.add({ text: "destination note", actor: "person", owner: "person-a" });
      old.close();
      const code = await backupInit(f.source, "person-a", f.keys);
      await backupExport(f.source, "person-a", f.file, f.keys);
      setRestoreStepForTests((at) => { if (at === step) throw new Error(`interrupted ${step}`); });
      try { await expect(backupRestore(f.fresh, "person-a", f.file, code, true, f.keys)).rejects.toThrow("interrupted"); }
      finally { setRestoreStepForTests(undefined); }
      recoverBackupRestore(f.fresh);
      const after = MemoryStore.open(f.fresh);
      expect(after.search("destination", 10, "person-a")).toHaveLength(1);
      expect(after.search("arctic", 10, "person-a")).toHaveLength(0);
      after.close();
    }
  });

  test("startup journal recovery rolls back every interrupted rename", () => {
    for (let completed = 0; completed <= 6; completed++) {
      const f = fixture();
      const old = MemoryStore.open(f.fresh);
      old.add({ text: "destination note", actor: "person", owner: "person-a" });
      old.close();
      const stage = join(f.fresh, ".memory-restore-test");
      mkdirSync(stage, { mode: 0o700 });
      copyFileSync(join(f.source, "memory.db"), join(stage, "memory.db"));
      writeFileSync(join(stage, "semantic.db"), "new semantic", { mode: 0o600 });
      writeFileSync(join(stage, "gbrain-settings.json"), "new settings", { mode: 0o600 });
      const settings = gbrainPaths(f.fresh, "person-a");
      mkdirSync(settings.directory, { recursive: true, mode: 0o700 });
      writeFileSync(settings.settings, "old settings", { mode: 0o600 });
      const entries = [
        { name: "memory", dest: join(f.fresh, "memory.db"), staged: join(stage, "memory.db"), safety: join(f.fresh, "memory.db.safety-test"), existed: true },
        { name: "semantic", dest: join(f.fresh, "semantic.db"), staged: join(stage, "semantic.db"), safety: join(f.fresh, "semantic.db.safety-test"), existed: false },
        { name: "settings", dest: settings.settings, staged: join(stage, "gbrain-settings.json"), safety: `${settings.settings}.safety-test`, existed: true },
      ];
      writeFileSync(join(f.fresh, "memory-restore-journal.json"), JSON.stringify({ version: 1, stage, entries }), { mode: 0o600 });
      let n = 0;
      for (const entry of entries) {
        if (++n > completed) break;
        if (entry.existed) renameSync(entry.dest, entry.safety);
        if (++n > completed) break;
        renameSync(entry.staged, entry.dest);
      }
      recoverBackupRestore(f.fresh);
      const after = MemoryStore.open(f.fresh);
      expect(after.search("destination", 10, "person-a")).toHaveLength(1);
      after.close();
      expect(readFileSync(settings.settings, "utf8")).toBe("old settings");
      expect(existsSync(join(f.fresh, "semantic.db"))).toBe(false);
    }
  });

  test("a refused restore does not store a recovered key", async () => {
    const f = fixture();
    const code = await backupInit(f.source, "person-a", f.keys);
    await backupExport(f.source, "person-a", f.file, f.keys);
    const old = MemoryStore.open(f.fresh);
    old.add({ text: "destination note", actor: "person", owner: "person-a" });
    old.close();
    const recovered = new Map<string, Buffer>();
    const targetKeys: BackupCredentialStore = { kind: "keychain",
      get: async (id) => recovered.get(id) ?? null,
      put: async (id, key) => { recovered.set(id, Buffer.from(key)); return "created"; } };
    await expect(backupRestore(f.fresh, "person-a", f.file, code, false, targetKeys)).rejects.toThrow("non-empty");
    expect(recovered.size).toBe(0);
    const after = MemoryStore.open(f.fresh);
    expect(after.search("destination", 10, "person-a")).toHaveLength(1);
    after.close();
  });

  test("a credential-store write failure reports an installed restore with a warning", async () => {
    const f = fixture();
    const code = await backupInit(f.source, "person-a", f.keys);
    await backupExport(f.source, "person-a", f.file, f.keys);
    const old = MemoryStore.open(f.fresh);
    old.add({ text: "destination note", actor: "person", owner: "person-a" });
    old.close();
    const broken: BackupCredentialStore = { kind: "keychain", get: async () => null,
      put: async () => { throw new Error("keychain unavailable"); } };
    const result = await backupRestore(f.fresh, "person-a", f.file, code, true, broken);
    expect(result.warning).toContain("walkie memory backup init");
    const after = MemoryStore.open(f.fresh);
    expect(after.search("destination", 10, "person-a")).toHaveLength(0);
    expect(after.search("arctic", 10, "person-a")).toHaveLength(1);
    after.close();
  });

  test("a credential-store read failure after swap reports success and the required next action", async () => {
    const f = fixture();
    const code = await backupInit(f.source, "person-a", f.keys);
    await backupExport(f.source, "person-a", f.file, f.keys);
    const old = MemoryStore.open(f.fresh);
    old.add({ text: "destination note", actor: "person", owner: "person-a" });
    old.close();
    let reads = 0;
    const broken: BackupCredentialStore = { kind: "keychain",
      get: async () => { if (++reads === 1) return null; throw new Error("keychain read failed after swap"); },
      put: async () => "created" };
    const result = await backupRestore(f.fresh, "person-a", f.file, code, true, broken);
    expect(result.warning).toContain("walkie memory backup init");
    expect(reads).toBeGreaterThanOrEqual(2);
    const after = MemoryStore.open(f.fresh);
    expect(after.search("destination", 10, "person-a")).toHaveLength(0);
    expect(after.search("arctic", 10, "person-a")).toHaveLength(1);
    after.close();
  });

  test("a legacy decision makes the destination non-empty without --replace", async () => {
    const f = fixture();
    const code = await backupInit(f.source, "person-a", f.keys);
    await backupExport(f.source, "person-a", f.file, f.keys);
    MemoryStore.open(f.fresh).close();
    const db = new Database(join(f.fresh, "memory.db"));
    db.query("INSERT INTO memory_legacy_decision(id,team,node,person) VALUES (1,?,?,?)").run("old-team", "old-node", "old-person");
    db.close();
    await expect(backupRestore(f.fresh, "person-a", f.file, code, false, f.keys)).rejects.toThrow("non-empty");
    const after = new Database(join(f.fresh, "memory.db"), { readonly: true });
    try {
      expect(after.query("SELECT team FROM memory_legacy_decision WHERE id = 1").get()).toEqual({ team: "old-team" });
      expect(after.query("SELECT 1 FROM memory LIMIT 1").get()).toBeNull();
    } finally { after.close(); }
  });

  test("a second identity row also makes the destination non-empty", async () => {
    const f = fixture();
    const code = await backupInit(f.source, "person-a", f.keys);
    await backupExport(f.source, "person-a", f.file, f.keys);
    MemoryStore.open(f.fresh).close();
    const db = new Database(join(f.fresh, "memory.db"));
    db.query("INSERT INTO memory_identity(id) VALUES (?)").run("extra-identity");
    db.close();
    await expect(backupRestore(f.fresh, "person-a", f.file, code, false, f.keys)).rejects.toThrow("non-empty");
    const after = new Database(join(f.fresh, "memory.db"), { readonly: true });
    try { expect(after.query("SELECT COUNT(*) AS count FROM memory_identity").get()).toEqual({ count: 2 }); }
    finally { after.close(); }
  });

  test("plaintext snapshot starts in a private folder with a 0600 file and is removed", async () => {
    const f = fixture();
    await backupInit(f.source, "person-a", f.keys);
    let observed = false;
    setBackupStepForTests((step, path) => {
      if (step !== "snapshot-ready") return;
      observed = true;
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(path, "..")).mode & 0o777).toBe(0o700);
    });
    try { await backupExport(f.source, "person-a", f.file, f.keys); }
    finally { setBackupStepForTests(undefined); }
    expect(observed).toBe(true);
    expect(readdirSync(f.source).filter((name) => name.startsWith(".memory-snapshot-"))).toHaveLength(0);
  });

  test("a snapshot error removes its plaintext file and private folder", async () => {
    const f = fixture();
    await backupInit(f.source, "person-a", f.keys);
    setBackupStepForTests((step) => { if (step === "snapshot-ready") throw new Error("snapshot interrupted"); });
    try { await expect(backupExport(f.source, "person-a", f.file, f.keys)).rejects.toThrow("snapshot interrupted"); }
    finally { setBackupStepForTests(undefined); }
    expect(readdirSync(f.source).filter((name) => name.startsWith(".memory-snapshot-"))).toHaveLength(0);
    expect(existsSync(f.file)).toBe(false);
  });

  test("a failed publish leaves no visible partial export and preserves a replaced file", async () => {
    for (const replace of [false, true]) {
      const f = fixture();
      await backupInit(f.source, "person-a", f.keys);
      if (replace) writeFileSync(f.file, "previous complete backup", { mode: 0o600 });
      setBackupStepForTests((step, path) => {
        if (step !== "publish-ready") return;
        expect(lstatSync(path).mode & 0o777).toBe(0o600);
        throw new Error("interrupted before publication");
      });
      try { await expect(backupExport(f.source, "person-a", f.file, f.keys, replace)).rejects.toThrow("interrupted before publication"); }
      finally { setBackupStepForTests(undefined); }
      expect(existsSync(f.file)).toBe(replace);
      if (replace) expect(readFileSync(f.file, "utf8")).toBe("previous complete backup");
      expect(readdirSync(join(f.file, "..")).filter((name) => name.startsWith(".memory-backup-"))).toHaveLength(0);
    }
  });

  test("agent CLI cannot init, export, or restore before contacting the daemon", async () => {
    let requests = 0;
    for (const pos of [["backup", "init"], ["backup", "export"], ["backup", "restore", "/tmp/memory.wmb"]]) {
      const ctx = {
        args: { pos, flags: new Map([["to", "/tmp/memory.wmb"]]) }, json: false,
        agentMarker: () => "codex", agentSignals: () => ({ marker: "codex", inspection: "ok" }),
        person: { interactive: () => true, ask: async () => "yes", note: () => {} },
        client: () => ({ request: async () => { requests++; return {}; } }),
        out: () => {}, err: () => {},
      } as unknown as Ctx;
      await expect(memoryCommand(ctx)).rejects.toThrow("agents can't");
    }
    expect(requests).toBe(0);
  });

  test("refuses existing or symlinked targets and keeps a safety copy on replace", async () => {
    const f = fixture();
    const code = await backupInit(f.source, "person-a", f.keys);
    await backupExport(f.source, "person-a", f.file, f.keys);
    await expect(backupExport(f.source, "person-a", f.file, f.keys)).rejects.toThrow("exists");
    const link = join(f.source, "linked.wmb");
    symlinkSync(f.file, link);
    await expect(backupExport(f.source, "person-a", link, f.keys, true)).rejects.toThrow();
    await expect(backupRestore(f.source, "person-a", f.file, code)).rejects.toThrow("non-empty");
    await backupRestore(f.source, "person-a", f.file, code, true);
    expect(existsSync(join(f.source, "memory.db"))).toBe(true);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(f.source).some((name) => name.startsWith("memory.db.safety-"))).toBe(true);
    expect(readdirSync(gbrainPaths(f.source, "person-a").directory).some((name) => name.startsWith("gbrain-settings.json.safety-"))).toBe(true);
  });

  test("export accepts a linked ancestor but refuses a linked final component", async () => {
    const f = fixture();
    await backupInit(f.source, "person-a", f.keys);
    const linked = join(f.source, "linked-directory");
    mkdirSync(f.fresh);
    symlinkSync(f.fresh, linked);
    const result = await backupExport(f.source, "person-a", join(linked, "copy.wmb"), f.keys);
    expect(result.path).toBe(join(realpathSync(f.fresh), "copy.wmb"));
    expect(lstatSync(result.path).mode & 0o777).toBe(0o600);
    symlinkSync(result.path, join(f.fresh, "linked-file.wmb"));
    await expect(backupExport(f.source, "person-a", join(linked, "linked-file.wmb"), f.keys, true)).rejects.toThrow();
  });
});
