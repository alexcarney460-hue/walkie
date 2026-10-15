import { afterEach, expect, test } from "bun:test";
import "../../src/daemon/projects/routes.ts";
import "../../src/daemon/orchestrator/rec-routes.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { overrideCall, overrideFleet, overrideSeats } from "../../src/daemon/orchestrator/rec-act.ts";
import { outcome, recsWorld, requester, type RecsWorld } from "../helpers/talkie-recs.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  overrideCall(null); overrideSeats(null); overrideFleet(null);
  while (cleanups.length) cleanups.pop()!();
});

async function world(privateName = "Northwind", privateTitle = "Rotate the vault keys") {
  const t = recsWorld(cleanups);
  registerHost(t.core, { acceptsToken: () => true, scheduledTurnActive: () => true, currentTurnId: () => "turn-1" } as unknown as OrchestratorHost);
  t.person("maren", "owner");
  const priv = await t.project(privateName, "NWD", { off: true, private: true });
  t.core.emit("channel.upsert", { name: priv.channel, project: true, members: ["alex", "maren"] });
  const secret = t.card(priv, privateTitle, { column: "doing" });
  const web = await t.project("Website", "WEB", { off: true });
  const open = t.card(web, "Refresh the landing copy");
  t.idx.flushAll();
  const post = (body: unknown) => outcome(requester(t, { orchestratorToken: "valid" })("POST", "/v1/talkie/recs", body));
  return { t, secret, web, open, post };
}

async function teamRead(t: RecsWorld): Promise<string> {
  const bea = t.person("bea", "member");
  bea.mirror();
  const result = await outcome(requester(bea)("GET", "/v1/talkie/recs?status=all"));
  return JSON.stringify(result.body);
}

function publicEvents(t: RecsWorld, channel: string): string {
  const rows = t.core.store.db.query<{ body: string | null; json: string }, [string]>("SELECT body, json FROM events WHERE channel = ?").all(channel);
  return rows.map((r) => `${r.body ?? ""}\n${r.json}`).join("\n");
}

test("R1: a private Latin project name in Japanese context is hidden from the team", async () => {
  const { t, web, open, post } = await world();
  const result = await post({ kind: "ask_orchestrator", to: "@maren", topic: "status", card: open.id, reason: "Northwindの件で遅れています" });
  expect(result.status).toBe(201);
  expect(publicEvents(t, web.channel)).not.toContain("Northwind");
  expect(await teamRead(t)).not.toContain("Northwind");
});

test("R2: private Latin project names in Chinese, Korean and Thai context are hidden", async () => {
  for (const reason of ["我们需要先完成Northwind的工作", "Northwind를 먼저 끝내야 합니다", "เราต้องทำNorthwindก่อน"]) {
    const { t, web, open, post } = await world();
    const result = await post({ kind: "ask_orchestrator", to: "@maren", topic: "status", card: open.id, reason });
    expect(result.status).toBe(201);
    expect(publicEvents(t, web.channel)).not.toContain("Northwind");
    expect(await teamRead(t)).not.toContain("Northwind");
    while (cleanups.length) cleanups.pop()!();
  }
});

test("R3: a private key and Latin card title in CJK context are hidden", async () => {
  const { t, web, open, secret, post } = await world();
  const result = await post({ kind: "ask_orchestrator", to: "@maren", topic: "status", card: open.id,
    reason: `先完成${secret.key}再说`, evidence: ["Rotate the vault keysが終わってから"] });
  expect(result.status).toBe(201);
  for (const phrase of [secret.key, "Rotate the vault keys"]) {
    expect(publicEvents(t, web.channel)).not.toContain(phrase);
    expect(await teamRead(t)).not.toContain(phrase);
  }
});

test("R4: a team create title with a private Latin name in Japanese is refused", async () => {
  const { t, web, post } = await world();
  const result = await post({ kind: "create_card", project: web.channel, title: "Northwindの移行を手伝う", reason: "work" });
  expect(result.status).toBe(400);
  expect(result.message).toBe("this title matches a private card or project name");
  expect(publicEvents(t, web.channel)).not.toContain("Northwind");
  expect(await teamRead(t)).not.toContain("Northwind");
});

test("ASCII punctuation private titles do not reject team creates", async () => {
  for (const title of ["-", "?", "..."]) {
    const { web, post } = await world("Northwind", title);
    const result = await post({ kind: "create_card", project: web.channel, title: `Keep ${title} here`, reason: "work" });
    expect(result.status).toBe(201);
    while (cleanups.length) cleanups.pop()!();
  }
});
