// WALK-125: scrubbing can re-form a private title, including across fields. Check the full text before cutting it.
// All names in these regression fixtures are fictional.
import { afterEach, expect, test } from "bun:test";
import "../../src/daemon/projects/routes.ts";
import "../../src/daemon/orchestrator/rec-routes.ts";
import { overrideCall } from "../../src/daemon/orchestrator/rec-act.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { RecommendInput, buildRec } from "../../src/daemon/orchestrator/rec-input.ts";
import { recsWorld } from "../helpers/talkie-recs.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { overrideCall(null); while (cleanups.length) (cleanups.pop() as () => void)(); });
const VAULT = "Rotate the vault keys";

async function ask(reason: string, note: string | undefined, evidence: string[] | undefined): Promise<string> {
  const t = recsWorld(cleanups);
  registerHost(t.core, { acceptsToken: () => true, scheduledTurnActive: () => true, currentTurnId: () => "turn-1" } as unknown as OrchestratorHost);
  t.person("maren", "owner");
  const vault = await t.project("Northwind Vault", "VLT", { off: true, private: true });
  t.core.emit("channel.upsert", { name: vault.channel, project: true, members: ["alex", "maren"] });
  t.card(vault, VAULT, { column: "doing" });
  const web = await t.project("Website", "WEB", { off: true });
  const open = t.card(web, "Refresh the landing copy");
  t.idx.flushAll();
  // Through the real input schema, as the route does.
  const input = RecommendInput.parse({ kind: "ask_orchestrator", to: "@maren", topic: "status", card: open.id, reason, ...(note ? { note } : {}), ...(evidence ? { evidence } : {}) });
  return buildRec(t.deps, input).rec.context ?? "";
}
const words = (n: number, seed: string): string => seed.repeat(Math.ceil(n / seed.length)).slice(0, n).replace(/ $/, "z");
const REASON = words(200, "the landing copy is stale and the pricing table is wrong ");
const nest = (depth: number) => "Rotate the ".repeat(depth) + "vault keys" + " vault keys".repeat(depth - 1);

for (const noteLen of [380, 378]) {
  test(`WALK125-NEST-STRADDLE note ${noteLen}: a title rebuilt by three removals, straddling the cut`, async () => {
    const note = words(noteLen, "context words go here ");
    const ctx = await ask(REASON, note, [nest(4)]);
    expect(ctx.toLowerCase()).not.toContain("rotate the vau");
  });
}

test("WALK125-FIELD-STRADDLE a title rebuilt across two evidence fields by one removal, straddling the cut", async () => {
  const note = words(378, "context words go here ");
  const ctx = await ask(REASON, note, ["Rotate the Rotate", "the vault keys vault keys"]);
  expect(ctx.toLowerCase()).not.toContain("rotate the vau");
});

test("WALK125-NEST-INSIDE control: the same rebuilt title wholly before the cut is withheld", async () => {
  const ctx = await ask(REASON, words(100, "context words go here "), [nest(4)]);
  expect(ctx.toLowerCase()).not.toContain("rotate the vau");
});

test("WALK125-TRIM what is returned is trimmed and is exactly what a further scrub leaves alone", async () => {
  const note = `${words(398, "context words go here ").slice(0, 397)}z x`;
  const ctx = await ask(REASON, note, undefined);
  expect(ctx).toBe(ctx.trim());
  expect(ctx).not.toBe("(no words)");
});
