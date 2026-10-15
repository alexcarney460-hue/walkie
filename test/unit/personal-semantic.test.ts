import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { MemoryStore } from "../../src/daemon/memory/store.ts";
import { recallPersonal, sessionMemoryContext } from "../../src/daemon/memory/primer.ts";
import { SemanticStore } from "../../src/daemon/memory/semantic.ts";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { DEFAULT_LIMITS, RateLimiter } from "../../src/daemon/ratelimit.ts";
import { applyRosterEvent, EMPTY_ROSTER } from "../../src/daemon/roster.ts";
import { createTeam, memberEv, nodeEv, tnode } from "../helpers/events.ts";
import "../../src/daemon/memory/routes.ts";
import { recall } from "../../src/cli/commands/primer.ts";
import { callTool } from "../../src/mcp/tools.ts";
import type { Ctx } from "../../src/cli/context.ts";
import type { WalkieClient } from "../../src/client/index.ts";

function fixture(fn: (dir: string, store: MemoryStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "walkie-semantic-"));
  const store = MemoryStore.open(dir);
  try { fn(dir, store); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

for (const action of ["retract", "quarantine", "supersede"] as const) {
  test(`${action} between eligibility read and semantic apply retries without leaking or losing a marker`, () => fixture((dir, store) => {
    const graph = SemanticStore.create(dir);
    graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 });
    graph.close();
    const input = { owner: "alex", actor: "person", machine: "node", category: "general",
      rule: "Asterion original", evidence: "fixture", confidence: 1, requestId: "original" };
    const record = action === "retract" ? store.add({ text: "Asterion original", actor: "person", owner: "alex" })
      : store.learnings().add(input);
    recallPersonal(store, "Asterion", "alex", [], new Set());
    const original = store.eligibilitySnapshot.bind(store);
    let moved = false;
    store.eligibilitySnapshot = ((read: () => unknown) => {
      const snapshot = original(read);
      if (!moved) {
        moved = true;
        if (action === "retract") store.retract(record.id, "alex");
        if (action === "supersede") store.learnings().correct({ ...input, rule: "Replacement", requestId: "replacement", supersedes: record.id });
        if (action === "quarantine") {
          const source = new Database(join(dir, "memory.db"));
          source.query("UPDATE personal_learnings SET status = 'quarantined' WHERE id = ?").run(record.id);
          source.close();
        }
      }
      return snapshot;
    }) as typeof store.eligibilitySnapshot;
    const result = recallPersonal(store, "Asterion", "alex", [], new Set());
    expect(result.items.some((item) => item.id === record.id)).toBe(false);
    const source = new Database(join(dir, "memory.db"), { readonly: true });
    const overlay = new Database(join(dir, "semantic.db"), { readonly: true });
    expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(record.id)).toBeNull();
    expect(source.query("SELECT 1 FROM semantic_purge WHERE record_id = ?").get(record.id)).toBeNull();
    source.close(); overlay.close();
  }));
}

test("three successive eligibility changes withhold semantic and stale text", () => fixture((dir, store) => {
  const graph = SemanticStore.create(dir);
  graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 });
  graph.close();
  const notes = Array.from({ length: 3 }, (_, i) => store.add({ text: `Asterion ${i}`, actor: "person", owner: "alex" }));
  const original = store.eligibilitySnapshot.bind(store);
  let moves = 0;
  store.eligibilitySnapshot = ((read: () => unknown) => {
    const snapshot = original(read);
    if (moves < notes.length) store.retract(notes[moves++]!.id, "alex");
    return snapshot;
  }) as typeof store.eligibilitySnapshot;
  const result = recallPersonal(store, "Asterion", "alex", [], new Set());
  expect(moves).toBe(3);
  expect(result.semantic?.status).toBe("withheld");
  expect(result.semantic?.reason).toContain("eligibility changed");
  expect(result.items).toEqual([]);
}));

for (const epoch of ["9007199254740991", "9007199254740992"] as const) {
  test(`eligibility changes at epoch ${epoch} cannot return a retracted note`, () => fixture((dir, store) => {
    const note = store.add({ text: "Asterion filing", actor: "person", owner: "alex" });
    const graph = SemanticStore.create(dir);
    graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion",
      summary: "Provider", validAsOf: Date.now(), confidence: 1 });
    graph.close();
    recallPersonal(store, "Asterion", "alex", [], new Set());
    const source = new Database(join(dir, "memory.db"));
    source.query("UPDATE eligibility_epoch SET value = CAST(? AS INTEGER) WHERE id = 1").run(epoch);
    const original = store.eligibilitySnapshot.bind(store);
    let moved = false;
    store.eligibilitySnapshot = ((read: () => unknown) => {
      const snapshot = original(read);
      if (!moved) { moved = true; store.retract(note.id, "alex"); }
      return snapshot;
    }) as typeof store.eligibilitySnapshot;
    const result = recallPersonal(store, "Asterion", "alex", [], new Set());
    const overlay = new Database(join(dir, "semantic.db"), { readonly: true });
    expect(source.query<{ value: string }, []>("SELECT CAST(value AS TEXT) AS value FROM eligibility_epoch").get()?.value)
      .toBe((BigInt(epoch) + 1n).toString());
    expect(result.items.some((item) => item.id === note.id)).toBe(false);
    expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(note.id)).toBeNull();
    overlay.close(); source.close();
  }));
}

test("cards stay lexical and losing visibility never leaves semantic mentions or entity hits", () => fixture((dir, store) => {
  const graph = SemanticStore.create(dir);
  const id = graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion",
    summary: "Provider", validAsOf: Date.now(), confidence: 1 });
  graph.addAlias("alex", id, "Αστερίων");
  graph.close();
  const card = { id: "card-private-1", channel: "secret", key: "SEC-1", title: "Asterion filing",
    body: "private", updated_at: Date.now(), labels: [] };
  const visible = new Set(["secret"]);
  const lexical = recallPersonal(store, "Asterion", "alex", [card], visible);
  expect(lexical.items.find((item) => item.id === card.id)?.entityHits).toBeUndefined();
  expect(recallPersonal(store, "Αστερίων", "alex", [card], visible).items).toEqual([]);
  const overlay = new Database(join(dir, "semantic.db"), { readonly: true });
  expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(card.id)).toBeNull();
  visible.delete("secret");
  expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(card.id)).toBeNull();
  expect(recallPersonal(store, "Asterion", "alex", [card], visible).items).toEqual([]);
  visible.add("secret");
  const original = store.eligibilitySnapshot.bind(store);
  store.eligibilitySnapshot = ((read: () => unknown) => {
    const snapshot = original(read);
    visible.delete("secret");
    return snapshot;
  }) as typeof store.eligibilitySnapshot;
  expect(recallPersonal(store, "Asterion", "alex", [card], visible).items).toEqual([]);
  expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(card.id)).toBeNull();
  overlay.close();
}));

test("project-scoped notes stay lexical and cannot regain semantic hits after visibility loss", () => fixture((dir, store) => {
  const note = store.add({ text: "Asterion private filing", sources: ["project:secret"], actor: "person", owner: "alex" });
  const graph = SemanticStore.create(dir);
  const id = graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion",
    summary: "Provider", validAsOf: Date.now(), confidence: 1 });
  graph.addAlias("alex", id, "Αστερίων");
  graph.rebuild("alex", store);
  graph.close();
  const visible = new Set(["secret"]);
  const lexical = recallPersonal(store, "Asterion", "alex", [], visible);
  expect(lexical.items.find((item) => item.id === note.id)?.entityHits).toBeUndefined();
  expect(recallPersonal(store, "Αστερίων", "alex", [], visible).items).toEqual([]);
  const overlay = new Database(join(dir, "semantic.db"), { readonly: true });
  expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(note.id)).toBeNull();
  visible.delete("secret");
  expect(recallPersonal(store, "Asterion", "alex", [], visible).items).toEqual([]);
  visible.add("secret");
  const original = store.eligibilitySnapshot.bind(store);
  store.eligibilitySnapshot = ((read: () => unknown) => {
    const snapshot = original(read);
    visible.delete("secret");
    return snapshot;
  }) as typeof store.eligibilitySnapshot;
  expect(recallPersonal(store, "Asterion", "alex", [], visible).items).toEqual([]);
  expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(note.id)).toBeNull();
  overlay.close();
}));

test("opening a legacy semantic database purges project-scoped note mentions", () => fixture((dir, store) => {
  const scoped = store.add({ text: "Asterion private filing", sources: ["project:secret"], actor: "person", owner: "alex" });
  const scopedFile = store.add({ text: "Asterion document", sources: ["file:brief", "project:secret"], actor: "person", owner: "alex" });
  const global = store.add({ text: "Asterion public filing", actor: "person", owner: "alex" });
  const graph = SemanticStore.create(dir);
  const id = graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion",
    summary: "Provider", validAsOf: Date.now(), confidence: 1 });
  graph.close();
  const overlay = new Database(join(dir, "semantic.db"));
  for (const note of [scoped, global]) overlay.query("INSERT INTO mention VALUES (?, ?, 'learning', ?, 1, ?)")
    .run("alex", id, note.id, "old-revision");
  overlay.query("INSERT INTO mention VALUES (?, ?, 'file-note', ?, 1, ?)").run("alex", id, scopedFile.id, "old-revision");
  overlay.close();
  const reopened = SemanticStore.open(dir)!;
  expect(reopened.status("alex").mentions).toBe(1);
  reopened.close();
  const check = new Database(join(dir, "semantic.db"), { readonly: true });
  expect(check.query("SELECT 1 FROM mention WHERE record_id = ?").get(scoped.id)).toBeNull();
  expect(check.query("SELECT 1 FROM mention WHERE record_id = ?").get(scopedFile.id)).toBeNull();
  expect(check.query("SELECT 1 FROM mention WHERE record_id = ?").get(global.id)).not.toBeNull();
  check.close();
}));

test("opening a legacy semantic database purges old card mentions", () => fixture((dir, store) => {
  const graph = SemanticStore.create(dir);
  const id = graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion",
    summary: "Provider", validAsOf: Date.now(), confidence: 1 });
  graph.close();
  const overlay = new Database(join(dir, "semantic.db"));
  overlay.query("INSERT INTO mention VALUES (?, ?, 'card', ?, 1, ?)").run("alex", id, "legacy-card", "old-revision");
  overlay.close();
  const reopened = SemanticStore.open(dir)!;
  expect(reopened.status("alex").mentions).toBe(0);
  reopened.close();
  const check = new Database(join(dir, "semantic.db"), { readonly: true });
  expect(check.query("SELECT 1 FROM mention WHERE store = 'card'").get()).toBeNull();
  check.close();
}));

test("a source writer commits during recall before the short semantic apply", () => fixture((dir, store) => {
  const graph = SemanticStore.create(dir);
  graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 });
  graph.close();
  const note = store.add({ text: "Asterion filing", actor: "person", owner: "alex" });
  const original = SemanticStore.prototype.prepare;
  let committedMs = Number.POSITIVE_INFINITY;
  let moved = false;
  SemanticStore.prototype.prepare = function (...args: Parameters<SemanticStore["prepare"]>) {
    const prepared = original.apply(this, args);
    if (!moved) {
      moved = true;
      const writer = new Database(join(dir, "memory.db"));
      writer.exec("PRAGMA busy_timeout=1000");
      const start = performance.now();
      writer.query("UPDATE memory SET retracted = 1, body = '' WHERE id = ?").run(note.id);
      committedMs = performance.now() - start;
      writer.close();
    }
    return prepared;
  };
  let result;
  try { result = recallPersonal(store, "Asterion", "alex", [], new Set()); }
  finally { SemanticStore.prototype.prepare = original; }
  expect(committedMs).toBeLessThan(1000);
  expect(result.items).toEqual([]);
  expect(result.semantic?.status).toBe("ready");
}));

test("an unavailable overlay does not hold up the canonical source writer", () => fixture((dir, store) => {
  SemanticStore.create(dir).close();
  const note = store.add({ text: "Asterion filing", actor: "person", owner: "alex" });
  const locked = new Database(join(dir, "semantic.db"));
  locked.exec("BEGIN EXCLUSIVE");
  const start = performance.now();
  store.retract(note.id, "alex");
  const elapsed = performance.now() - start;
  locked.exec("ROLLBACK"); locked.close();
  expect(elapsed).toBeLessThan(1000);
  const source = new Database(join(dir, "memory.db"), { readonly: true });
  expect(source.query("SELECT 1 FROM semantic_purge WHERE record_id = ?").get(note.id)).not.toBeNull();
  source.close();
}));

test("failed validated apply rolls back mention removal and preserves its marker", () => fixture((dir, store) => {
  const graph = SemanticStore.create(dir);
  graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 });
  graph.close();
  const note = store.add({ text: "Asterion original", actor: "person", owner: "alex" });
  recallPersonal(store, "Asterion", "alex", [], new Set());
  const source = new Database(join(dir, "memory.db"));
  const overlay = new Database(join(dir, "semantic.db"), { readonly: true });
  source.query("UPDATE memory SET body = ? WHERE id = ?").run("Asterion revised", note.id);
  source.exec("CREATE TRIGGER stop_marker_delete BEFORE DELETE ON semantic_purge BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");
  const withheld = recallPersonal(store, "Asterion", "alex", [], new Set());
  expect(withheld.semantic?.status).toBe("withheld");
  expect(source.query("SELECT 1 FROM semantic_purge WHERE record_id = ?").get(note.id)).not.toBeNull();
  expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(note.id)).not.toBeNull();
  source.exec("DROP TRIGGER stop_marker_delete");
  const recovered = recallPersonal(store, "Asterion", "alex", [], new Set());
  expect(recovered.semantic?.status).toBe("ready");
  expect(source.query("SELECT 1 FROM semantic_purge WHERE record_id = ?").get(note.id)).toBeNull();
  expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(note.id)).not.toBeNull();
  source.close(); overlay.close();
}));

test("version five sources gain the eligibility epoch and transactional triggers on upgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-semantic-epoch-upgrade-"));
  let store = MemoryStore.open(dir);
  try {
    store.close();
    const old = new Database(join(dir, "memory.db"));
    old.exec(`DROP TRIGGER memory_epoch_insert; DROP TRIGGER memory_epoch_update;
      DROP TRIGGER memory_epoch_delete; DROP TRIGGER learning_epoch_insert;
      DROP TRIGGER learning_epoch_update; DROP TRIGGER learning_epoch_delete;
      DROP TRIGGER learning_semantic_purge_safety; DROP TABLE eligibility_epoch;
      DELETE FROM memory_migrations WHERE version = 6;`);
    old.close();
    store = MemoryStore.open(dir);
    expect(store.eligibilityEpoch()).toBe("0");
    const note = store.add({ text: "Asterion filing", actor: "person", owner: "alex" });
    const afterInsert = store.eligibilityEpoch();
    expect(BigInt(afterInsert)).toBeGreaterThan(0n);
    store.retract(note.id, "alex");
    expect(BigInt(store.eligibilityEpoch())).toBeGreaterThan(BigInt(afterInsert));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a learning safety-field edit invalidates eligibility and its derived mention", () => fixture((dir, store) => {
  const graph = SemanticStore.create(dir);
  graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 });
  graph.close();
  const learning = store.learnings().add({ owner: "alex", actor: "person", machine: "node", category: "general",
    rule: "Asterion filing", evidence: "fixture", confidence: 1, requestId: "one" });
  recallPersonal(store, "Asterion", "alex", [], new Set());
  const before = store.eligibilityEpoch();
  const source = new Database(join(dir, "memory.db"));
  source.query("UPDATE personal_learnings SET category = 'https://example.test' WHERE id = ?").run(learning.id);
  expect(BigInt(store.eligibilityEpoch())).toBeGreaterThan(BigInt(before));
  expect(source.query("SELECT 1 FROM semantic_purge WHERE record_id = ?").get(learning.id)).not.toBeNull();
  expect(recallPersonal(store, "Asterion", "alex", [], new Set()).items).toEqual([]);
  const overlay = new Database(join(dir, "semantic.db"), { readonly: true });
  expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(learning.id)).toBeNull();
  overlay.close(); source.close();
}));

test("an alias retrieves a record without shared query words, including non-Latin text, only for its person", () => fixture((dir, store) => {
  const note = store.add({ text: "Asterion handles the customs filing", actor: "person", owner: "alex" });
  const graph = SemanticStore.create(dir);
  const id = graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Customs provider", validAsOf: Date.now(), confidence: 1 });
  graph.addAlias("alex", id, "Αστερίων");
  graph.close();
  const hit = recallPersonal(store, "Αστερίων", "alex", [], new Set());
  expect(hit.items.map((x) => x.id)).toContain(note.id);
  expect(hit.items[0]?.entityHits?.[0]?.id).toBe(id);
  expect(recallPersonal(store, "Αστερίων", "sam", [], new Set()).items).toEqual([]);
  expect(statSync(join(dir, "semantic.db")).mode & 0o777).toBe(0o600);
}));

test("a common hub cannot swamp rare evidence and excluded records leave no mention", () => fixture((dir, store) => {
  const graph = SemanticStore.create(dir);
  const common = graph.addEntity("alex", { slug: "common", kind: "company", name: "Common", summary: "Common", validAsOf: Date.now(), confidence: 1 });
  const rare = graph.addEntity("alex", { slug: "rare", kind: "company", name: "Rare", summary: "Rare", validAsOf: Date.now(), confidence: 1 });
  graph.addAlias("alex", common, "Common"); graph.addAlias("alex", rare, "Rare");
  graph.link("alex", common, rare, "related_to");
  graph.close();
  for (let i = 0; i < 30; i++) store.add({ text: `${i < 9 ? "Common " : ""}${i === 29 ? "Rare " : ""}fixture ${i}`, actor: "person", owner: "alex" });
  const hit = recallPersonal(store, "Rare Common", "alex", [], new Set());
  expect(hit.items[0]?.text).toContain("Rare");
  expect(recallPersonal(store, "Rare", "alex", [], new Set()).items.every((item) => item.text.includes("Rare"))).toBe(true);
  const learning = store.learnings().add({ owner: "alex", actor: "person", machine: "node", category: "general", rule: "Common obsolete", evidence: "fixture", confidence: 1, requestId: "one" });
  recallPersonal(store, "Common", "alex", [], new Set());
  store.learnings().retract(learning.id, "alex", "two");
  const db = new Database(join(dir, "semantic.db"), { readonly: true });
  expect(db.query("SELECT * FROM mention WHERE record_id = ?").all(learning.id)).toEqual([]);
  db.close();
}));

test("rebuild is deterministic; a missing or corrupt graph withholds semantics and retains lexical recall", () => fixture((dir, store) => {
  store.add({ text: "Asterion filing", actor: "person", owner: "alex" });
  const graph = SemanticStore.create(dir);
  graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 });
  graph.close();
  recallPersonal(store, "Asterion", "alex", [], new Set());
  const first = new Database(join(dir, "semantic.db"), { readonly: true }).query("SELECT entity_id, store, record_id, weight, revision FROM mention ORDER BY record_id").all();
  const again = SemanticStore.open(dir)!;
  again.rebuild("alex", store); again.close();
  const second = new Database(join(dir, "semantic.db"), { readonly: true }).query("SELECT entity_id, store, record_id, weight, revision FROM mention ORDER BY record_id").all();
  expect(second).toEqual(first);
  unlinkSync(join(dir, "semantic.db"));
  const missing = recallPersonal(store, "Asterion", "alex", [], new Set());
  expect(missing.items).toHaveLength(1);
  expect(missing.semantic?.status).toBe("withheld");
  writeFileSync(join(dir, "semantic.db"), "corrupt");
  expect(recallPersonal(store, "Asterion", "alex", [], new Set()).semantic?.status).toBe("withheld");
}));

test("quarantined, superseded, retracted and foreign rows never enter mentions; stale revisions are replaced", () => fixture((dir, store) => {
  const graph = SemanticStore.create(dir);
  graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 });
  graph.close();
  const writer = store.learnings();
  const base = { owner: "alex", actor: "person", machine: "node", category: "general", evidence: "fixture", confidence: 1 };
  const first = writer.add({ ...base, rule: "Asterion first", requestId: "first" });
  const poison = writer.add({ ...base, rule: "Asterion sk-ant-abcdefghijklmnopqrstuvwxyz123456", requestId: "poison" });
  const other = store.add({ text: "Asterion foreign", actor: "person", owner: "sam" });
  const note = store.add({ text: "Asterion current", actor: "person", owner: "alex" });
  recallPersonal(store, "Asterion", "alex", [], new Set());
  const db = new Database(join(dir, "semantic.db"), { readonly: true });
  const mentions = () => db.query<{ record_id: string }, []>("SELECT record_id FROM mention ORDER BY record_id").all().map((x) => x.record_id);
  expect(mentions()).toContain(first.id);
  expect(mentions()).not.toContain(poison.id);
  expect(mentions()).not.toContain(other.id);
  const before = db.query<{ revision: string }, [string]>("SELECT revision FROM mention WHERE record_id = ?").get(note.id)!.revision;
  const source = new Database(join(dir, "memory.db"));
  source.query("UPDATE memory SET body = ? WHERE id = ?").run("Asterion revised", note.id);
  source.close();
  recallPersonal(store, "Asterion", "alex", [], new Set());
  expect(db.query<{ revision: string }, [string]>("SELECT revision FROM mention WHERE record_id = ?").get(note.id)!.revision).not.toBe(before);
  const corrected = writer.correct({ ...base, rule: "Asterion corrected", requestId: "corrected", supersedes: first.id });
  expect(mentions()).not.toContain(first.id);
  store.retract(note.id, "alex");
  expect(mentions()).not.toContain(note.id);
  writer.retract(corrected.id, "alex", "retract");
  expect(recallPersonal(store, "Asterion", "alex", [], new Set()).items).toEqual([]);
  db.close();
}));

for (const action of ["retract", "quarantine", "supersede"] as const) {
  test(`${action} commits under an overlay lock and drains its durable purge before semantic recall`, () => fixture((dir, store) => {
    const graph = SemanticStore.create(dir);
    graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 });
    graph.close();
    const base = { owner: "alex", actor: "person", machine: "node", category: "general",
      rule: "Asterion original", evidence: "fixture", confidence: 1, requestId: "original" };
    const record = action === "retract"
      ? store.add({ text: "Asterion original", actor: "person", owner: "alex" })
      : store.learnings().add(base);
    const linked = SemanticStore.open(dir)!;
    const related = linked.addEntity("alex", { slug: "related", kind: "company", name: "Related", summary: "Related", validAsOf: Date.now(), confidence: 1 });
    linked.link("alex", "p:alex:asterion", related, "related_to", record.id);
    linked.close();
    expect(recallPersonal(store, "Asterion", "alex", [], new Set()).semantic?.status).toBe("ready");
    const locked = new Database(join(dir, "semantic.db"));
    locked.exec("BEGIN EXCLUSIVE");
    expect(locked.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM mention WHERE record_id = ?")
      .get(record.id)?.n).toBe(1);
    if (action === "retract") store.retract(record.id, "alex");
    if (action === "supersede") store.learnings().correct({ ...base, rule: "Replacement", requestId: "replacement", supersedes: record.id });
    if (action === "quarantine") {
      const source = new Database(join(dir, "memory.db"));
      source.query("UPDATE personal_learnings SET status = 'quarantined' WHERE id = ?").run(record.id);
      source.close();
    }
    const source = new Database(join(dir, "memory.db"), { readonly: true });
    const marker = source.query<{ store: string; record_id: string; reason: string; at: number }, [string]>(
      "SELECT * FROM semantic_purge WHERE record_id = ?",
    ).get(record.id);
    expect(Object.keys(marker ?? {}).sort()).toEqual(["at", "reason", "record_id", "store"]);
    expect(marker?.store).toBe(action === "retract" ? "memory" : "learning");
    expect(marker?.record_id).toBe(record.id);
    expect(marker?.reason).toBe(action);
    expect(marker?.at).toBeGreaterThan(0);
    source.close();
    const withheld = recallPersonal(store, "Asterion", "alex", [], new Set());
    expect(withheld.semantic?.status).toBe("withheld");
    expect(withheld.items.some((item) => item.id === record.id)).toBe(false);
    locked.exec("ROLLBACK"); locked.close();
    const recovered = recallPersonal(store, "Asterion", "alex", [], new Set());
    expect(recovered.semantic?.status).toBe("ready");
    const overlay = new Database(join(dir, "semantic.db"), { readonly: true });
    expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(record.id)).toBeNull();
    expect(overlay.query("SELECT 1 FROM edge WHERE evidence_record_id = ?").get(record.id)).toBeNull();
    overlay.close();
    const cleared = new Database(join(dir, "memory.db"), { readonly: true });
    expect(cleared.query("SELECT 1 FROM semantic_purge WHERE record_id = ?").get(record.id)).toBeNull();
    cleared.close();
  }));
}

test("a damaged overlay keeps purge markers until a rebuilt overlay can drain them after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-semantic-restart-"));
  let store = MemoryStore.open(dir);
  try {
    const graph = SemanticStore.create(dir);
    graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 });
    graph.close();
    const note = store.add({ text: "Asterion filing", actor: "person", owner: "alex" });
    recallPersonal(store, "Asterion", "alex", [], new Set());
    const lock = new Database(join(dir, "semantic.db")); lock.exec("BEGIN EXCLUSIVE");
    store.retract(note.id, "alex");
    lock.exec("ROLLBACK"); lock.close();
    store.close();
    unlinkSync(join(dir, "semantic.db"));
    store = MemoryStore.open(dir);
    expect(recallPersonal(store, "Asterion", "alex", [], new Set()).semantic?.status).toBe("withheld");
    const missingNote = store.add({ text: "Asterion missing", actor: "person", owner: "alex" });
    store.retract(missingNote.id, "alex");
    store.close();
    writeFileSync(join(dir, "semantic.db"), "damaged");
    store = MemoryStore.open(dir);
    expect(recallPersonal(store, "Asterion", "alex", [], new Set()).semantic?.status).toBe("withheld");
    const damagedNote = store.add({ text: "Asterion second", actor: "person", owner: "alex" });
    store.retract(damagedNote.id, "alex");
    const source = new Database(join(dir, "memory.db"), { readonly: true });
    expect(source.query("SELECT 1 FROM semantic_purge WHERE record_id = ?").get(note.id)).not.toBeNull();
    expect(source.query("SELECT 1 FROM semantic_purge WHERE record_id = ?").get(missingNote.id)).not.toBeNull();
    expect(source.query("SELECT 1 FROM semantic_purge WHERE record_id = ?").get(damagedNote.id)).not.toBeNull();
    source.close();
    unlinkSync(join(dir, "semantic.db"));
    SemanticStore.create(dir).close();
    const afterCreate = new Database(join(dir, "memory.db"), { readonly: true });
    expect(afterCreate.query("SELECT 1 FROM semantic_purge LIMIT 1").get()).not.toBeNull();
    afterCreate.close();
    expect(recallPersonal(store, "Asterion", "alex", [], new Set()).semantic?.status).toBe("ready");
    const cleared = new Database(join(dir, "memory.db"), { readonly: true });
    expect(cleared.query("SELECT 1 FROM semantic_purge WHERE record_id = ?").get(note.id)).toBeNull();
    expect(cleared.query("SELECT 1 FROM semantic_purge WHERE record_id = ?").get(missingNote.id)).toBeNull();
    expect(cleared.query("SELECT 1 FROM semantic_purge WHERE record_id = ?").get(damagedNote.id)).toBeNull();
    cleared.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("reassignment leaves a durable marker when the overlay is locked", () => fixture((dir, store) => {
  const graph = SemanticStore.create(dir);
  graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 });
  graph.close();
  const note = store.add({ text: "Asterion filing", actor: "person", owner: "alex" });
  recallPersonal(store, "Asterion", "alex", [], new Set());
  const lock = new Database(join(dir, "semantic.db")); lock.exec("BEGIN EXCLUSIVE");
  const source = new Database(join(dir, "memory.db"));
  source.query("UPDATE memory SET owner = 'sam' WHERE id = ?").run(note.id);
  expect(source.query<{ reason: string }, [string]>("SELECT reason FROM semantic_purge WHERE record_id = ?")
    .get(note.id)?.reason).toBe("reassign");
  source.close();
  expect(recallPersonal(store, "Asterion", "alex", [], new Set()).semantic?.status).toBe("withheld");
  lock.exec("ROLLBACK"); lock.close();
  expect(recallPersonal(store, "Asterion", "alex", [], new Set()).semantic?.status).toBe("ready");
  const overlay = new Database(join(dir, "semantic.db"), { readonly: true });
  expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(note.id)).toBeNull();
  overlay.close();
}));

test("schema upgrade marks already excluded source rows before semantic access", () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-semantic-upgrade-"));
  let store = MemoryStore.open(dir);
  try {
    const graph = SemanticStore.create(dir);
    graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 });
    graph.close();
    const note = store.add({ text: "Asterion filing", actor: "person", owner: "alex" });
    recallPersonal(store, "Asterion", "alex", [], new Set());
    store.close();
    const old = new Database(join(dir, "memory.db"));
    old.exec(`DROP TRIGGER memory_semantic_purge_update;
      DROP TRIGGER memory_semantic_purge_delete;
      DROP TRIGGER learning_semantic_purge_update;
      DROP TRIGGER learning_semantic_purge_delete;
      DROP TABLE semantic_purge;
      DELETE FROM memory_migrations WHERE version = 5;`);
    old.query("UPDATE memory SET retracted = 1, body = '', sources = '[]' WHERE id = ?").run(note.id);
    old.close();
    store = MemoryStore.open(dir);
    const source = new Database(join(dir, "memory.db"), { readonly: true });
    expect(source.query<{ reason: string }, [string]>("SELECT reason FROM semantic_purge WHERE record_id = ?")
      .get(note.id)?.reason).toBe("migration");
    source.close();
    expect(recallPersonal(store, "Asterion", "alex", [], new Set()).semantic?.status).toBe("ready");
    const overlay = new Database(join(dir, "semantic.db"), { readonly: true });
    expect(overlay.query("SELECT 1 FROM mention WHERE record_id = ?").get(note.id)).toBeNull();
    overlay.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("entity routes are person-only and exports cannot cross identities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-semantic-route-"));
  const alex = tnode("alex"), sam = tnode("sam");
  const { create } = createTeam(alex);
  const roster = [create, memberEv(create.team, alex, sam, "member"), nodeEv(create.team, alex, sam)]
    .reduce(applyRosterEvent, EMPTY_ROSTER);
  const request = async (node: typeof alex, method: string, path: string, body?: unknown, agent?: string) => {
    const req = new Request(`http://walkie${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await dispatch({ req, url: new URL(req.url), via: "cli", listener: "unix", agent, noTimeout: () => {},
      core: { paths: { home: dir }, teamId: create.team, nodeId: node.keys.nodeId, roster,
        myHandle: () => node === alex ? "alex" : "sam", limits: DEFAULT_LIMITS, limiter: new RateLimiter() },
    } as unknown as RouteCtx);
    return response.json();
  };
  try {
    MemoryStore.open(dir).close();
    for (const backup of [
      { action: "init" },
      { action: "export", to: join(dir, "agent-backup.wmb") },
      { action: "restore", file: join(dir, "agent-backup.wmb"), code: "invalid" },
    ]) {
      await expect(request(alex, "POST", "/v1/memory/backup", backup, "assistant"))
        .rejects.toMatchObject({ status: 403, code: "person_only" });
    }
    const body = { action: "add", slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 };
    await expect(request(alex, "POST", "/v1/memory/entity", body, "assistant")).rejects.toMatchObject({ status: 403 });
    const added = await request(alex, "POST", "/v1/memory/entity", body);
    expect(added.result).toContain("asterion");
    expect((await request(sam, "GET", "/v1/memory/entity")).entities).toEqual([]);
    const exported = (await request(alex, "GET", "/v1/memory/entity/export")).export;
    await expect(request(sam, "POST", "/v1/memory/entity", { action: "import", export: exported })).rejects.toMatchObject({ status: 400 });
    expect((await request(alex, "GET", "/v1/memory/semantic/status")).entities).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("person export imports into a fresh overlay without derived mentions", () => fixture((dir, store) => {
  const graph = SemanticStore.create(dir);
  const id = graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider",
    validAsOf: Date.now() - 46 * 86_400_000, confidence: 0.9 });
  graph.addAlias("alex", id, "Αστερίων");
  const exported = graph.export("alex");
  graph.close();
  const secondDir = mkdtempSync(join(tmpdir(), "walkie-semantic-import-"));
  try {
    const second = SemanticStore.create(secondDir);
    second.import("alex", exported);
    expect(second.list("alex").aliases.map((a) => a.text)).toContain("αστερίων");
    expect(second.status("alex").mentions).toBe(0);
    second.close();
  } finally { rmSync(secondDir, { recursive: true, force: true }); }
  store.add({ text: "Asterion filing", actor: "person", owner: "alex" });
  expect(recallPersonal(store, "Αστερίων", "alex", [], new Set()).items[0]?.entityHits?.[0]?.stale).toBe(true);
}));

test("CLI, MCP and Claude context expose the same cited, wrapped entity hit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-semantic-surfaces-"));
  try {
    const store = MemoryStore.open(dir);
    const note = store.add({ text: "Asterion filing", actor: "person", owner: "alex" });
    const graph = SemanticStore.create(dir);
    graph.addEntity("alex", { slug: "asterion", kind: "company", name: "Asterion", summary: "Provider", validAsOf: Date.now(), confidence: 1 });
    graph.addAlias("alex", "p:alex:asterion", "Αστερίων");
    graph.close();
    const answer = recallPersonal(store, "Αστερίων", "alex", [], new Set());
    store.close();
    const client = { request: async () => answer } as unknown as WalkieClient;
    const lines: string[] = [];
    await recall({ args: { pos: ["Αστερίων"], flags: new Map() }, json: true, forAgent: true,
      client: () => client, out: (s: string) => lines.push(s) } as unknown as Ctx);
    const tool = await callTool(client, "walkie_recall", { query: "Αστερίων" });
    expect(JSON.parse(lines[0]!)).toEqual(JSON.parse(tool.content[0]!.text));
    expect(tool.content[0]!.text).toContain(note.id);
    expect(tool.content[0]!.text).toContain("memory.entity");
    const session = sessionMemoryContext(null, answer);
    expect(session).toContain(note.id);
    expect(session).toContain("memory.entity");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
