// PROJECT-PAGES-1: `walkie projects fact` and `walkie projects screen`. A stand-in daemon on a unix socket records what the
// CLI sends: the facts (list, set, remove), the screens (list, add or replace by group and title, remove), the usage errors
// that never reach the daemon, what an agent's CLI sends as, and the line that says the page is off.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectsCmd } from "../../src/cli/commands/projects.ts";
import { UsageError } from "../../src/cli/args.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { parseArgs } from "../../src/cli/args.ts";
import type { ProjectView } from "../../src/protocol/projects/schema.ts";
import type { StatusPagePayload } from "../../src/protocol/projects/status-page.ts";
import { fakeDaemon, type FakeDaemon } from "../helpers/fake-daemon.ts";
import { png } from "../helpers/images.ts";

const CH = "p-5e7a7e01";
const meter = { mode: "count" as const, done: 1, counted: 4, by_role: { backlog: 0, todo: 2, active: 1, review: 0, done: 1, cancelled: 0 } };
const project = (): ProjectView => ({
  channel: CH, id: "a000000000000001:1", name: "Website", folder: "Acme", description: "", prefix: "WEB", paths: [], meter_mode: "count",
  automations: { pr_opened: true, pr_merged: false, agents_can_close: true }, state: "active", steward: "on", steward_node: "", status_report: "hourly",
  private: false, admins: ["alex"], creator: "alex", created_at: 0, boards: [], meter, cards: 0, last_activity: 0,
});
const page = (over: Partial<StatusPagePayload> = {}): StatusPagePayload => ({
  mode: "hourly", state: "active", generated_at: 1, updated_at: 1, story: null,
  facts: { computed: null, set: [{ label: "Live build", value: "ddee2f0bca", by: { handle: "alex" }, at: 1 }, { label: "Next release", value: "Friday", by: { handle: "kira", agent: "cc-2" }, at: 2 }] },
  screens: { total: 3, newest_at: 5, groups: [
    { id: "carrier", name: "Carrier", screens: [
      { title: "Dispatch board", group: "Carrier", status: "works", about: "The board.", id: "a:2", version: 2, size: 10, mime: "image/png", at: 5, by: { handle: "alex" }, available: true, w: 1280, h: 720 },
      { title: "Billing", group: "Carrier", status: "partial", about: "Nothing to bill.", id: "a:4", version: 1, size: 10, mime: "image/png", at: 4, by: { handle: "alex" }, available: true },
    ] },
    { id: "driver-app", name: "Driver app", screens: [{ title: "Today", group: "Driver app", status: "empty", about: "No loads.", id: "a:6", version: 1, size: 10, mime: "image/png", at: 3, by: { handle: "alex" }, available: false }] },
  ] },
  ...over,
});

let daemon: FakeDaemon;
let routes: Record<string, unknown>;
let savedSocket: string | undefined;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync("/tmp/walkie-pages-cli-");
  routes = {
    "GET /v1/projects": { projects: [project()], stubs: [] },
    [`GET /v1/projects/${CH}/page`]: page(),
    [`POST /v1/projects/${CH}/page/facts`]: { facts: [], unchanged: false },
    [`POST /v1/projects/${CH}/page/screens`]: { screen: { title: "Dispatch board", group: "Carrier", status: "works", about: "The board.", id: "a:2", version: 1, size: 10, mime: "image/png", at: 5, by: { handle: "alex" }, available: true, w: 1280, h: 720 }, created: true, version: 1, unchanged: false },
    [`POST /v1/projects/${CH}/page/screens/remove`]: { removed: 1 },
  };
  daemon = fakeDaemon(routes);
  savedSocket = process.env.WALKIE_SOCKET;
  process.env.WALKIE_SOCKET = daemon.socket;
});
afterEach(() => {
  daemon.stop();
  rmSync(dir, { recursive: true, force: true });
  if (savedSocket === undefined) delete process.env.WALKIE_SOCKET; else process.env.WALKIE_SOCKET = savedSocket;
});

function run(argv: string[], opts: { json?: boolean; forAgent?: boolean } = {}) {
  const lines: string[] = [];
  // As main.ts parses it: `status` is a value in `projects screen`.
  const { pos, flags } = parseArgs(argv, argv[0] === "screen" ? new Set([...CLI_BOOLEANS].filter((x) => x !== "status")) : CLI_BOOLEANS);
  const ctx = {
    args: { pos, flags }, json: opts.json === true, forAgent: opts.forAgent === true, agentMarker: () => null,
    client: () => { throw new Error("projects uses its own client"); }, out: (s: string) => lines.push(s), err: (s: string) => lines.push(s),
  } as unknown as Ctx;
  return { lines, done: projectsCmd(ctx), text: () => lines.join("\n") };
}
const posts = () => daemon.requests.filter((r) => r.method === "POST");
const image = (name: string, w = 1280, h = 720, salt = 0): string => { const p = join(dir, name); writeFileSync(p, png(w, h, salt)); return p; };
const shot = ["--title", "Dispatch board", "--group", "Carrier", "--status", "works", "--about", "The board of booked loads."];

describe("walkie projects fact", () => {
  test("with no label it lists the facts and who set them", async () => {
    const r = run(["fact", "WEB"]);
    expect(await r.done).toBe(0);
    expect(posts()).toEqual([]);
    expect(r.text()).toContain("Live build");
    expect(r.text()).toContain("ddee2f0bca");
    expect(r.text()).toContain("@kira/cc-2");
  });

  test("an empty list says how to add one", async () => {
    routes[`GET /v1/projects/${CH}/page`] = page({ facts: { computed: null, set: [] } });
    const r = run(["fact", "WEB"]);
    await r.done;
    expect(r.text()).toContain('walkie projects fact WEB "Live build" "ddee2f0bca"');
  });

  test("a label and a value set it; a value of several words need not be quoted", async () => {
    routes[`POST /v1/projects/${CH}/page/facts`] = { facts: [{ label: "Next release", value: "Friday 3 Oct", by: { handle: "alex" }, at: 3 }], unchanged: false };
    const r = run(["fact", "WEB", "Next release", "Friday", "3", "Oct"]);
    expect(await r.done).toBe(0);
    expect(posts()[0]).toMatchObject({ path: `/v1/projects/${CH}/page/facts`, body: { label: "Next release", value: "Friday 3 Oct" } });
    expect(r.text()).toContain("set Next release");
    const quoted = run(["fact", "WEB", "Live build", "ddee2f0bca"]);
    await quoted.done;
    expect(posts()[1]?.body).toEqual({ label: "Live build", value: "ddee2f0bca" });
  });

  test("--remove takes a label off; it says so when there was none or nothing changed", async () => {
    const r = run(["fact", "WEB", "Live build", "--remove"]);
    expect(await r.done).toBe(0);
    expect(posts()[0]?.body).toEqual({ label: "Live build", remove: true });
    expect(r.text()).toContain("removed Live build");
    routes[`POST /v1/projects/${CH}/page/facts`] = { facts: [], unchanged: true };
    const again = run(["fact", "WEB", "Live build", "--remove"]);
    await again.done;
    expect(again.text()).toContain("no fact called Live build");
    const same = run(["fact", "WEB", "Live build", "x"]);
    await same.done;
    expect(same.text()).toContain("unchanged");
  });

  test("a value together with --remove, a label without a value, and a missing project are usage errors that send nothing", async () => {
    await expect(run(["fact", "WEB", "Live build", "x", "--remove"]).done).rejects.toBeInstanceOf(UsageError);
    await expect(run(["fact", "WEB", "Live build"]).done).rejects.toBeInstanceOf(UsageError);
    await expect(run(["fact"]).done).rejects.toBeInstanceOf(UsageError);
    await expect(run(["fact", "NOPE", "a", "b"]).done).rejects.toThrow("no project NOPE");
    expect(posts()).toEqual([]);
  });

  test("the daemon's plain refusal is shown as it is", async () => {
    routes[`POST /v1/projects/${CH}/page/facts`] = undefined;
    const r = run(["fact", "WEB", "Live build", "x"]);
    await expect(r.done).rejects.toMatchObject({ status: 404 });
  });

  test("--json prints the facts", async () => {
    const r = run(["fact", "WEB"], { json: true });
    await r.done;
    expect(JSON.parse(r.lines[0] ?? "{}").facts).toHaveLength(2);
  });

  test("a project whose page is off still takes a fact, and the CLI says the page is off and who can turn it on", async () => {
    routes[`GET /v1/projects/${CH}/page`] = page({ mode: "off" });
    const r = run(["fact", "WEB", "Live build", "ddee2f0bca"]);
    await r.done;
    expect(r.text()).toContain("status page is off");
    expect(r.text()).toContain("walkie projects report WEB on");
  });

  test("under an agent: it writes as a named agent, an unnamed one is marked as one, and what teammates wrote is wrapped for the model", async () => {
    const named = run(["fact", "WEB", "Live build", "x", "--agent", "cc-7"], { forAgent: true });
    await named.done;
    expect(posts()[0]?.headers["x-walkie-agent"]).toBe("cc-7");
    const unnamed = run(["fact", "WEB", "Live build", "y"], { forAgent: true });
    await unnamed.done;
    expect(posts()[1]?.headers["x-walkie-under-agent"]).toBe("1");
    const list = run(["fact", "WEB"], { forAgent: true });
    await list.done;
    expect(list.text()).toContain("Live build");
    const j = run(["fact", "WEB"], { forAgent: true, json: true });
    await j.done;
    expect(JSON.parse(j.lines[0] ?? "{}")).toMatchObject({ trust: "team-member", facts: [{ label: "Live build" }, { label: "Next release" }] });
  });
});

describe("walkie projects screen", () => {
  test("adds a screen: the image's own bytes, and its details in a header the daemon reads", async () => {
    const file = image("shot.png", 1280, 720, 3);
    const r = run(["screen", "WEB", file, ...shot, "--route", "/carrier/dispatch", "--note", "Demo data."]);
    expect(await r.done).toBe(0);
    const sent = posts()[0];
    expect(sent).toMatchObject({ path: `/v1/projects/${CH}/page/screens` });
    expect(sent?.bytes).toEqual(png(1280, 720, 3));
    expect(JSON.parse(decodeURIComponent(sent?.headers["x-walkie-screen"] ?? "{}"))).toEqual({
      title: "Dispatch board", group: "Carrier", status: "works", about: "The board of booked loads.", route: "/carrier/dispatch", note: "Demo data.",
    });
    expect(r.text()).toContain("added Carrier / Dispatch board");
  });

  test("says replaced for a new version and unchanged for the same screen again", async () => {
    routes[`POST /v1/projects/${CH}/page/screens`] = { screen: { title: "Dispatch board", group: "Carrier", status: "works", about: "x", id: "a:2", version: 2, size: 10, mime: "image/png", at: 5, by: { handle: "alex" }, available: true }, created: false, version: 2, unchanged: false };
    const r = run(["screen", "WEB", image("a.png"), ...shot]);
    await r.done;
    expect(r.text()).toContain("replaced Carrier / Dispatch board");
    expect(r.text()).toContain("v2");
    routes[`POST /v1/projects/${CH}/page/screens`] = { screen: { title: "Dispatch board", group: "Carrier", status: "works", about: "x", id: "a:2", version: 2, size: 10, mime: "image/png", at: 5, by: { handle: "alex" }, available: true }, created: false, version: 2, unchanged: true };
    const same = run(["screen", "WEB", image("a.png"), ...shot]);
    await same.done;
    expect(same.text()).toContain("unchanged Carrier / Dispatch board");
  });

  test("without an image it lists the screens by group, with their status and a count per group", async () => {
    const r = run(["screen", "WEB"]);
    expect(await r.done).toBe(0);
    expect(posts()).toEqual([]);
    expect(r.text()).toContain("Carrier (2)");
    expect(r.text()).toContain("Dispatch board");
    expect(r.text()).toContain("works");
    expect(r.text()).toContain("Driver app (1)");
    expect(r.text()).toContain("Not on any online machine");
    routes[`GET /v1/projects/${CH}/page`] = page({ screens: { total: 0, newest_at: null, groups: [] } });
    const none = run(["screen", "WEB"]);
    await none.done;
    expect(none.text()).toContain("walkie projects screen WEB ./shot.png");
  });

  test("--remove takes one off by group and title; it says so when there was none", async () => {
    const r = run(["screen", "WEB", "--remove", "--group", "Carrier", "--title", "Dispatch board"]);
    expect(await r.done).toBe(0);
    expect(posts()[0]).toMatchObject({ path: `/v1/projects/${CH}/page/screens/remove`, body: { group: "Carrier", title: "Dispatch board" } });
    expect(r.text()).toContain("removed Carrier / Dispatch board");
    routes[`POST /v1/projects/${CH}/page/screens/remove`] = { removed: 0 };
    const none = run(["screen", "WEB", "--remove", "--group", "Carrier", "--title", "Nope"]);
    await none.done;
    expect(none.text()).toContain("no screen Carrier / Nope");
  });

  test("usage errors never reach the daemon: details missing, a status that is not one, no such file, a directory, a file over 8 MB, --remove with an image or without its group", async () => {
    const ok = image("ok.png");
    for (const argv of [
      ["screen", "WEB", ok, "--title", "T", "--group", "G", "--status", "works"],
      ["screen", "WEB", ok, "--title", "T", "--group", "G", "--about", "A"],
      ["screen", "WEB", ok, "--group", "G", "--status", "works", "--about", "A"],
      ["screen", "WEB", ok, "--title", "T", "--group", "G", "--status", "broken", "--about", "A"],
      ["screen", "WEB", join(dir, "missing.png"), ...shot],
      ["screen", "WEB", dir, ...shot],
      ["screen", "WEB", "--remove", "--title", "T"],
      ["screen", "WEB", ok, "--remove", "--group", "G", "--title", "T"],
    ]) await expect(run(argv).done).rejects.toBeInstanceOf(UsageError);
    mkdirSync(join(dir, "sub"));
    const big = join(dir, "big.png");
    writeFileSync(big, new Uint8Array(8 * 1024 * 1024 + 1));
    await expect(run(["screen", "WEB", big, ...shot]).done).rejects.toThrow("8 MB");
    expect(posts()).toEqual([]);
  });

  test("a page that is off says so after a screen is added", async () => {
    routes[`GET /v1/projects/${CH}/page`] = page({ mode: "off" });
    const r = run(["screen", "WEB", image("a.png"), ...shot]);
    await r.done;
    expect(r.text()).toContain("status page is off");
  });

  test("under an agent: written as a named agent, or marked as one; the listing is wrapped for the model", async () => {
    const named = run(["screen", "WEB", image("a.png"), ...shot, "--agent", "cc-4"], { forAgent: true });
    await named.done;
    expect(posts()[0]?.headers["x-walkie-agent"]).toBe("cc-4");
    const unnamed = run(["screen", "WEB", image("b.png", 10, 10, 1), ...shot], { forAgent: true });
    await unnamed.done;
    expect(posts()[1]?.headers["x-walkie-under-agent"]).toBe("1");
    const j = run(["screen", "WEB"], { forAgent: true, json: true });
    await j.done;
    expect(JSON.parse(j.lines[0] ?? "{}")).toMatchObject({ trust: "team-member", groups: [{ name: "Carrier" }, { name: "Driver app" }] });
  });
});

test("--remove is a switch, so it never swallows the next word", () => {
  expect(parseArgs(["screen", "WEB", "--remove", "--group", "G"], CLI_BOOLEANS)).toMatchObject({ pos: ["screen", "WEB"] });
  expect(parseArgs(["fact", "WEB", "Live build", "--remove"], CLI_BOOLEANS).pos).toEqual(["fact", "WEB", "Live build"]);
});
