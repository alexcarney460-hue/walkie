// The scenario tests of the pool suggestions (fit, speed, grouping, placement, "this machine can start it") were written
// against the 13-model list the product shipped before LOCAL-MODELS-HF-1, where "best" meant "largest". They test the
// logic, not which model wins today, so they keep running on that list, frozen as a fixture
// (test/fixtures/pool-hf/legacy-models.json) and rated by size, which reproduces its old order exactly. The tests of
// the new ranking (pool-rank, pool-hf-*) use their own catalogs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Catalog, CatalogModel } from "../../src/pool/catalog.ts";
import { suggestCombined as combined } from "../../src/pool/combined.ts";
import type { GroupInput, PoolGroup } from "../../src/pool/group.ts";
import { suggestForGroup as forGroup, suggestTeam as team } from "../../src/pool/suggest.ts";
import { FIXTURES } from "./pool-machines.ts";

const raw = JSON.parse(readFileSync(join(FIXTURES, "pool-hf", "legacy-models.json"), "utf8")) as Catalog;
export const LEGACY: Catalog = {
  ...raw,
  models: raw.models.map((m): CatalogModel => ({ ...m, quality: { basis: "rated", score: m.params_b, scores: {} } })),
};

export const suggestTeam = (nodes: readonly GroupInput[], opts: Parameters<typeof team>[1] = {}) => team(nodes, { cat: LEGACY, ...opts });
export const suggestCombined = (nodes: readonly GroupInput[], opts: Parameters<typeof combined>[1] = {}) => combined(nodes, { cat: LEGACY, ...opts });
export const suggestForGroup = (g: PoolGroup, cat: Catalog = LEGACY, context?: number) => forGroup(g, cat, context);
