// E21b (WALK-200): the upgrade lines tell the truth. Extra boards are not on sale (the site has no add-on checkout), so
// no board limit names a price or carries a checkout link, and no limit promises unlimited machines or projects (the
// node limits cap machines per login, MAX_PROJECTS caps projects per team).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { WalkieError } from "../../src/client/index.ts";
import { USAGE } from "../../src/cli/main.ts";
import { planLimitText } from "../../src/cli/commands/license.ts";
import { EMPTY_ROSTER } from "../../src/daemon/roster.ts";
import { planLimitFromPeer, planLimitMessage } from "../../src/license/enforce.ts";
import { boardAddonUrl } from "../../src/license/site.ts";
import { handleToolCall } from "../../src/mcp/server.ts";
import { TOOLS } from "../../src/mcp/tools.ts";
import { listText, mintedText } from "../../src/cli/commands/team-link.ts";
import type { WalkieClient } from "../../src/client/index.ts";
import type { FleetLinkMinted, FleetLinksView } from "../../src/protocol/fleet-link.ts";

const ROOT = resolve(import.meta.dir, "../..");
const T0 = 1_800_000_000_000;
const OLD_ADDON_URL = boardAddonUrl(1, "lic_1");
const SALES = /\$\d|add-on|addon|upgrade|portal|checkout|https?:/i;

describe("board limits name no price and no checkout", () => {
  test("the daemon's 402 text", () => {
    const text = planLimitMessage({ resource: "boards", limit: 3, used: 3, plan: "team", subscribed: true, upgrade_url: "" });
    expect(text).toBe("each project includes 3 boards (this one has 3); extra boards aren't on sale, and nothing was removed");
    expect(planLimitMessage({ resource: "boards", limit: 3, used: 3, plan: "free", upgrade_url: OLD_ADDON_URL })).not.toMatch(SALES);
  });

  test("a peer's board limit carries no link", () => {
    const d = planLimitFromPeer({ resource: "boards", limit: 3, used: 3, plan: "free" }, EMPTY_ROSTER, T0);
    expect(d).toMatchObject({ resource: "boards", limit: 3, used: 3, upgrade_url: "" });
    expect(planLimitFromPeer({ resource: "people", limit: 2, used: 2, plan: "free" }, EMPTY_ROSTER, T0)?.upgrade_url).toContain("/api/checkout?plan=team");
  });

  test("the CLI text, even when an older daemon still sends the add-on link", () => {
    for (const subscribed of [false, true]) {
      for (const upgrade_url of ["", OLD_ADDON_URL]) {
        const err = new WalkieError("plan_limit", "x", 402, { resource: "boards", limit: 3, used: 3, plan: "team", subscribed, upgrade_url });
        const text = planLimitText(err) ?? "";
        expect(text).toBe("Each project includes 3 boards (this one has 3); extra boards aren't on sale. Nothing was removed.");
      }
    }
  });

  test("the CLI help and the MCP tool", () => {
    const line = USAGE.split("\n").find((l) => l.includes("projects board <project> add")) ?? "";
    expect(line).toContain("3 per project included; extra boards aren't on sale");
    expect(line).not.toMatch(SALES);
    const tool = TOOLS.find((t) => t.name === "walkie_board_add");
    expect(tool?.description).toContain("Each project includes three boards; extra boards aren't on sale.");
    expect(tool?.description).not.toMatch(SALES);
  });
});

// E21b r2 (VERDICT fbdab491 MEDIUM 1): a new MCP server can talk to a daemon that was not restarted after the update.
// That pre-E21b daemon's board 402 still names the price and the add-on checkout; the MCP server rewrites it from the
// details before the model sees it, as the CLI's planLimitText does.
const PRE20_BOARD_402 = `each project includes 3 boards (this one has 3); every extra board is a $15/month add-on: ${OLD_ADDON_URL}`;

async function mcpBoardAdd(err: Error): Promise<string> {
  const stub = { agent: undefined, createBoard: async () => { throw err; } } as unknown as WalkieClient;
  const out = await handleToolCall(stub, "walkie_board_add", { project: "p-0000abcd", name: "fourth" });
  expect(out.isError).toBe(true);
  return out.content[0]?.text ?? "";
}

describe("the MCP server against an older daemon", () => {
  test("a board limit with the old add-on text and link reaches the model with neither", async () => {
    for (const subscribed of [false, true]) {
      const err = new WalkieError("plan_limit", PRE20_BOARD_402, 402, { resource: "boards", limit: 3, used: 3, plan: "team", subscribed, upgrade_url: OLD_ADDON_URL });
      const text = await mcpBoardAdd(err);
      expect(text).toBe("walkie error — plan_limit: each project includes 3 boards (this one has 3); extra boards aren't on sale, and nothing was removed");
      expect(text).not.toMatch(SALES);
    }
  });

  test("without numbers in the details it still names no price or link", async () => {
    const text = await mcpBoardAdd(new WalkieError("plan_limit", PRE20_BOARD_402, 402, { resource: "boards" }));
    expect(text).toBe("walkie error — plan_limit: extra boards aren't on sale, and nothing was removed");
  });

  test("other errors pass through as before", async () => {
    const people = "the Free plan includes 2 people (2 in use); nothing was removed. Upgrade: https://sqwakie.si/api/checkout?plan=team";
    expect(await mcpBoardAdd(new WalkieError("plan_limit", people, 402, { resource: "people", limit: 2, used: 2, plan: "free", upgrade_url: "https://sqwakie.si/api/checkout?plan=team" })))
      .toBe(`walkie error — plan_limit: ${people}`);
    expect(await mcpBoardAdd(new WalkieError("conflict", "a board named fourth exists", 409))).toBe("walkie error — conflict: a board named fourth exists");
  });
});

// E21b r2 (VERDICT fbdab491 MEDIUM 2): a link with no use limit still admits machines only within the plan's machine
// limit (Free: 4) and the node limits (256 per member through links, 1024 per team), so no fleet-link line promises
// any number of machines.
const LINK_BASE = {
  id: "0123456789abcdef0123456789abcdef", short: "01234567", handle: "maren", role: "member", used: 2, pending: 0,
  expires_at: T0 + 7 * 86_400_000, approve: false, created_at: T0, created_by: "maren", revoked_at: null, state: "active",
} as const;

describe("fleet links with no use limit (CLI)", () => {
  test("the minted text says the plan and machine limits still apply", () => {
    const res = { ...LINK_BASE, uses: 0, token: "wl1x", link: "https://sqwakie.si/join#wl1x", command: "c", windows_command: "w", version: "0.2.0" } as FleetLinkMinted;
    const text = mintedText(res);
    expect(text).toContain("no link limit (plan and machine limits still apply)");
    expect(text).not.toMatch(/any number of|unlimited/i);
    expect(mintedText({ ...res, uses: 5 })).toContain("up to 5 machines join as @maren's");
  });

  test("the list says no link limit, not unlimited", () => {
    const view = { links: [{ ...LINK_BASE, uses: 0 }], uses: [], authority: "n1" } as unknown as FleetLinksView;
    const text = listText(view, T0);
    expect(text).toContain("2 joined · no link limit");
    expect(text).not.toMatch(/any number of|unlimited/i);
  });
});

/** Shipped sources: src/ and web/src/ (not tests), plus the public docs that describe plans. */
function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p, ext) : ext.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const SOURCES = [...files(join(ROOT, "src"), /\.ts$/), ...files(join(ROOT, "web/src"), /\.tsx?$/)];
const DOCS = ["README.md", "docs/INSTALL.md", "docs/PROTOCOL.md", "docs/SECURITY.md", "docs/openapi.json"].map((p) => join(ROOT, p));
/** Where a person reads what a fleet link admits: the CLI, the dashboard and the install guide. */
const FLEET_TEXT = ["src/cli/commands/team-link.ts", "web/src/views/FleetLinks.tsx", "docs/INSTALL.md"].map((p) => join(ROOT, p));

function hits(paths: string[], re: RegExp, allow: (rel: string) => boolean = () => false): string[] {
  return paths.flatMap((p) => {
    const rel = relative(ROOT, p);
    if (allow(rel)) return [];
    return readFileSync(p, "utf8").split("\n").flatMap((l, i) => (re.test(l) ? [`${rel}:${i + 1}`] : []));
  });
}

describe("no shipped line sells the add-on or promises unlimited machines or projects", () => {
  test("nothing calls the add-on checkout stub", () => {
    expect(hits(SOURCES, /boardAddonUrl/, (rel) => rel === "src/license/site.ts")).toEqual([]);
  });
  test("no price or add-on wording for boards", () => {
    expect(hits([...SOURCES, ...DOCS], /15\/month|add-on|addon=board/i, (rel) => rel === "src/license/site.ts")).toEqual([]);
  });
  test("no unlimited machines or projects", () => {
    expect(hits([...SOURCES, ...DOCS], /unlimited (machines|projects)/i)).toEqual([]);
  });
  test("no fleet-link line promises any number of machines or no limit", () => {
    expect(hits(FLEET_TEXT, /any number of|\bno limit\b|· unlimited/i)).toEqual([]);
  });
});
