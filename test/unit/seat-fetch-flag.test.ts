import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { seat } from "../../src/cli/commands/seats.ts";
import type { Ctx } from "../../src/cli/context.ts";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

test("seat fetch --save downloads the result file", async () => {
  dir = mkdtempSync(join(tmpdir(), "walkie-seat-fetch-"));
  const output = join(dir, "result.json");
  const ctx = {
    args: parseArgs(["fetch", "seat-id", "--save", "-o", output], CLI_BOOLEANS),
    client: () => ({
      seats: async () => ({ seats: [{ result_file_blob: "blob-id", state: "done" }] }),
      fetchArtifact: async () => new TextEncoder().encode("{\"ok\":true}"),
    }),
    json: false,
    out: () => {},
    err: () => {},
    forAgent: false,
  } as unknown as Ctx;

  expect(await seat(ctx)).toBe(0);
  expect(readFileSync(output, "utf8")).toBe("{\"ok\":true}");
});

test("seat fetch --file=true remains a deprecated alias", async () => {
  dir = mkdtempSync(join(tmpdir(), "walkie-seat-fetch-"));
  const output = join(dir, "result.json");
  const ctx = {
    args: parseArgs(["fetch", "seat-id", "--file=true", "-o", output], CLI_BOOLEANS),
    client: () => ({
      seats: async () => ({ seats: [{ result_file_blob: "blob-id", state: "done" }] }),
      fetchArtifact: async () => new TextEncoder().encode("legacy"),
    }),
    json: false,
    out: () => {},
    err: () => {},
    forAgent: false,
  } as unknown as Ctx;

  expect(await seat(ctx)).toBe(0);
  expect(readFileSync(output, "utf8")).toBe("legacy");
});
