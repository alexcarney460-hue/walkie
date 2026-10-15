// Explicit child-only preload for CLI fixtures of a machine with no seat-user setup.
// A temporary HOME does not hide these two absolute host paths. Keep the real CLI,
// person/agent detection, owner checks and registration parser; only these reads see
// ENOENT. Never add this to bunfig: present/foreign-registration tests must stay real.
import { mock } from "bun:test";
import * as fs from "node:fs";

const real = { ...fs };
const registrationFiles = new Set([
  "/usr/local/libexec/walkie/seat-owner",
  "/usr/local/libexec/walkie/seat-instance",
]);

function absent(path: unknown): void {
  if (typeof path !== "string" || !registrationFiles.has(path)) return;
  throw Object.assign(new Error(`ENOENT: fixture has no seat registration, ${path}`), { code: "ENOENT", path });
}

const patched = {
  ...real,
  readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
    absent(args[0]);
    return Reflect.apply(real.readFileSync, real, args);
  }) as typeof fs.readFileSync,
  lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
    absent(args[0]);
    return Reflect.apply(real.lstatSync, real, args);
  }) as typeof fs.lstatSync,
};
mock.module("node:fs", () => ({ ...patched, default: patched }));
