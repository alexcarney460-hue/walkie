import { expect, test } from "bun:test";
import { desktopSeatOwner, nativeRuntime } from "../../src/cli/commands/seat-user.ts";
import { realpathSync } from "node:fs";

test("desktop root transaction keeps the consenting user's identity", () => {
  expect(desktopSeatOwner(0, { WALKIE_APP_AUTHORIZED: "1", WALKIE_APP_SEAT_OWNER: "alex", HOME: "/Users/alex" }))
    .toEqual({ username: "alex", homedir: "/Users/alex" });
  expect(desktopSeatOwner(501, { HOME: "/Users/alex" })).toBeNull();
});

test("an untrusted owner or home cannot be used for the privileged transaction", () => {
  for (const env of [
    { WALKIE_APP_AUTHORIZED: "1", WALKIE_APP_SEAT_OWNER: "root;touch x", HOME: "/Users/alex" },
    { WALKIE_APP_AUTHORIZED: "1", WALKIE_APP_SEAT_OWNER: "alex", HOME: "/" },
    { WALKIE_APP_AUTHORIZED: "1", WALKIE_APP_SEAT_OWNER: "alex", HOME: "/Users/../root" },
  ]) expect(() => desktopSeatOwner(0, env)).toThrow();
  expect(() => desktopSeatOwner(501, { WALKIE_APP_AUTHORIZED: "1", WALKIE_APP_SEAT_OWNER: "alex", HOME: "/Users/alex" })).toThrow();
});

test("the privileged step accepts only the runtime path resolved before elevation", () => {
  const bin = realpathSync(process.execPath);
  expect(nativeRuntime("claude", { WALKIE_APP_AUTHORIZED: "1", WALKIE_APP_CLAUDE: bin, PATH: "/evil" })).toBe(bin);
  expect(nativeRuntime("claude", { WALKIE_APP_AUTHORIZED: "1", PATH: "/evil" })).toBeNull();
  expect(nativeRuntime("claude", { WALKIE_APP_AUTHORIZED: "1", WALKIE_APP_CLAUDE: "relative/claude" })).toBeNull();
});
