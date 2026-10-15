// Real-binary smoke, run only by the lane lead. The shell wrapper owns a disposable home.
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { gbrainEnable, gbrainGet, gbrainSearch, gbrainStatus, gbrainSync } from "../src/daemon/memory/gbrain.ts";
import { MemoryStore } from "../src/daemon/memory/store.ts";

const home = process.env.GBRAIN_SMOKE_HOME;
assert(home, "the smoke wrapper must provide a disposable home");
const person = "synthetic-smoke-person";
const store = MemoryStore.open(join(home, "store"));
try {
  const first = store.add({ owner: person, actor: "person", kind: "procedure", text: "harbor crane six-shard gate", sources: ["file:synthetic-one"] });
  const second = store.add({ owner: person, actor: "person", kind: "procedure", text: "harbor manifest retention", sources: ["file:synthetic-two"] });
  const enabled = await gbrainEnable(join(home, "store"), person);
  assert.equal(enabled.state, "ready", JSON.stringify(enabled));
  const synced = await gbrainSync(join(home, "store"), person);
  assert.equal(synced.state, "ready", JSON.stringify(synced));
  assert.equal(synced.pageCount, 2);
  const found = await gbrainSearch(join(home, "store"), person, "harbor crane", store.recallEntries(person));
  assert.equal(found.status.state, "ready", JSON.stringify(found.status));
  assert(found.items.some((item) => item.id === first.id && /^sq-[0-9a-f]{64}$/.test(item.slug)), "first record citation missing");
  const slug = found.items.find((item) => item.id === first.id)!.slug;
  const stored = await gbrainGet(join(home, "store"), person, slug);
  assert.equal(stored.replace(/^---\n[\s\S]*?\n---\n\n/, "").trim(), first.text, "stored page text differs from record");
  store.retract(first.id, person);
  const deleted = await gbrainSync(join(home, "store"), person);
  assert.equal(deleted.state, "ready", JSON.stringify(deleted));
  assert.equal((await gbrainStatus(join(home, "store"), person)).pageCount, 1);
  const after = await gbrainSearch(join(home, "store"), person, "harbor crane", store.recallEntries(person));
  assert(!after.items.some((item) => item.id === first.id), "deleted record still cited");
  await assert.rejects(gbrainGet(join(home, "store"), person, slug, true), "purged page is still recoverable");
  const survivorSearch = await gbrainSearch(join(home, "store"), person, "harbor manifest", store.recallEntries(person));
  const surviving = survivorSearch.items.find((item) => item.id === second.id);
  assert(surviving, "surviving page is unavailable after purge");
  assert((await gbrainGet(join(home, "store"), person, surviving.slug, true)).includes(second.text));
  assert(second.id !== first.id);
  console.log("gbrain smoke: two pages synced, first cited, first deleted, one page remains");
} finally { store.close(); }
