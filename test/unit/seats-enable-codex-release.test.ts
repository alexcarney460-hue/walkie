// SUDO-RS-1 (WALK-93) item 4: when codex can't be copied for the seat users (an npm script, not a single binary) the warning
// names `walkie seats setup-user --apply --codex-release`: the one command that works whether or not seat users exist.
// `walkie seats enable --seat-users --codex-release` reaches stageCodexRuntime too, but only for a first setup: once seat users
// exist enableSeats skips the setup (and the flag with it), which is why the warning does not name it. All of it is driven here
// the way the CLI does (parsed args, the seats dispatcher, enable, enableSeats, seatUserSetup) with a fake GitHub in place of the
// network, and the staged release is what we look for.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { seats } from "../../src/cli/commands/seats.ts";
import { enableSeats } from "../../src/cli/commands/seats-enable.ts";
import type { Ctx } from "../../src/cli/context.ts";
import type { WalkieClient } from "../../src/client/index.ts";

const LATEST = "https://api.github.com/repos/openai/codex/releases/latest";
const ASSET = `codex-${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
const BINARY = "#!/bin/sh\necho 'codex-cli 0.99.0'\n";
const HEX = createHash("sha256").update(BINARY).digest("hex");

const realFetch = globalThis.fetch;
const realFlag = process.env.WALKIE_CODEX_RELEASE;
let requested: string[] = [];

beforeEach(() => {
  requested = [];
  delete process.env.WALKIE_CODEX_RELEASE;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    if (url === LATEST) {
      return Response.json({ tag_name: "rust-v0.99.0", assets: [
        { name: ASSET, browser_download_url: `https://fake.example/${ASSET}` },
        { name: `${ASSET}.sha256`, browser_download_url: `https://fake.example/${ASSET}.sha256` },
      ] });
    }
    if (url === `https://fake.example/${ASSET}`) return new Response(BINARY);
    if (url === `https://fake.example/${ASSET}.sha256`) return new Response(HEX);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realFlag === undefined) delete process.env.WALKIE_CODEX_RELEASE; else process.env.WALKIE_CODEX_RELEASE = realFlag;
});

function world(argv: string[], local: Record<string, unknown> = { allow: false }) {
  const out: string[] = []; const err: string[] = [];
  const client = { seats: async () => ({ local }), seatsConfig: async () => ({ local }) };
  const ctx = {
    args: parseArgs(argv, CLI_BOOLEANS), json: false, forAgent: false, agentMarker: () => null,
    person: { interactive: () => true, ask: async () => "yes", note: () => undefined },
    client: () => client, out: (s: string) => { out.push(s); }, err: (s: string) => { err.push(s); },
  } as unknown as Ctx;
  return { ctx, client: client as unknown as WalkieClient, text: () => [...out, ...err].join("\n") };
}

test("a first setup: walkie seats enable --seat-users --codex-release asks GitHub for the official Codex, checks it and stages it", async () => {
  const w = world(["enable", "--seat-users", "--codex-release", "--yes"]);
  await seats(w.ctx); // a source build can't install the root helper, so this ends there: the staging comes first
  expect(requested).toContain(LATEST);
  expect(requested).toContain(`https://fake.example/${ASSET}`);
  expect(requested).toContain(`https://fake.example/${ASSET}.sha256`);
  expect(w.text()).toContain("codex from the official release: codex-cli 0.99.0 (rust-v0.99.0");
  expect(w.text()).toContain("checksum-verified");
});

test("without the flag (or WALKIE_CODEX_RELEASE=1) nothing is fetched: the codex found on PATH decides", async () => {
  const w = world(["enable", "--seat-users", "--yes"]);
  await seats(w.ctx);
  expect(requested).toEqual([]);
  expect(w.text()).not.toContain("official release");
});

test("walkie seats setup-user --apply --codex-release, the command the warning names, reaches it too", async () => {
  const w = world(["setup-user", "--apply", "--codex-release"]);
  await seats(w.ctx); // a source build can't apply (it installs the release binary), so this ends after the staging
  expect(requested).toContain(LATEST);
  expect(w.text()).toContain("codex from the official release");
  const plain = world(["setup-user", "--codex-release"]);
  await seats(plain.ctx);
  expect(plain.text()).toContain("codex from the official release");
});

test("once seat users are set up, walkie seats enable --seat-users --codex-release sets nothing up: no fetch (so the warning does not name it)", async () => {
  const w = world(["enable", "--seat-users", "--codex-release", "--yes"], { allow: true, ephemeral: true, max: 3 });
  const local = await enableSeats(w.ctx, { seatUsers: true, client: w.client });
  expect(local).not.toBeNull();
  expect(w.text()).toContain("seat users were already set up");
  expect(requested).toEqual([]);
});
