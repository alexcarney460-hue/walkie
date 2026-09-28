import { describe, expect, test } from "bun:test";
import { ALL_TARGETS, buildTargets } from "../../scripts/build-targets.ts";

describe("scripts/build.ts target selection", () => {
  test("no flag: this machine's target only", () => {
    expect(buildTargets([], "darwin", "arm64")).toEqual(["bun-darwin-arm64"]);
    expect(buildTargets(["build.ts"], "linux", "x64")).toEqual(["bun-linux-x64"]);
  });

  test("--all: every release target, darwin-x64 included", () => {
    expect(buildTargets(["--all"], "darwin", "arm64")).toEqual(ALL_TARGETS.map((t) => `bun-${t}`));
    expect(ALL_TARGETS).toContain("darwin-x64");
  });

  test("--targets a,b,c and --targets=a,b,c: that list, in order, darwin-x64 left out", () => {
    const want = ["bun-darwin-arm64", "bun-linux-x64", "bun-linux-arm64"];
    expect(buildTargets(["--targets", "darwin-arm64,linux-x64,linux-arm64"], "darwin", "arm64")).toEqual(want);
    expect(buildTargets(["--targets=darwin-arm64,linux-x64,linux-arm64"], "darwin", "arm64")).toEqual(want);
    expect(buildTargets(["--targets", " linux-arm64 , linux-arm64 "], "darwin", "arm64")).toEqual(["bun-linux-arm64"]);
  });

  test("unknown, empty or missing targets are refused", () => {
    expect(() => buildTargets(["--targets", "windows-x64"], "darwin", "arm64")).toThrow(/unknown target/);
    expect(() => buildTargets(["--targets", ""], "darwin", "arm64")).toThrow(/no targets/);
    expect(() => buildTargets(["--targets"], "darwin", "arm64")).toThrow(/no targets/);
    expect(() => buildTargets(["--all", "--targets", "linux-x64"], "darwin", "arm64")).toThrow(/not both/);
  });
});
