import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const protocol = readFileSync(new URL("../../docs/PROTOCOL.md", import.meta.url), "utf8");
const rosterSection = protocol.split("Channel requests also carry signed")[0]!.split("A `team.member` request carries `seen_pos`")[1]!;
const publicTest = readFileSync(new URL("./compute-authority-change.test.ts", import.meta.url), "utf8");

test("roster request docs name the wire code and message for malformed positions", () => {
  expect(rosterSection).toContain('`400`, code `invalid`, message `request refused: bad_precondition`');
});

test("roster request docs describe both stale-check exemptions", () => {
  expect(rosterSection).toContain("A removal request is exempt from stale-role checks but still has its signed position validated.");
  expect(protocol.replace(/\s+/g, " ")).toContain("A topic-only channel request with no members list skips access-list staleness checks but still has its signed position validated.");
});

test("public authority-change test comments contain no internal review codes", () => {
  expect(publicTest).not.toContain("RVINT13C-SYNC-ABA");
  expect(publicTest).not.toContain("RVINT13C-TERM-LAST");
});
