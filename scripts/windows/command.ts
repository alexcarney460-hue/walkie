import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One paste, fixed for every invite. The locally copied stage verifies a signed manifest before executing downloads. */
export function windowsCommand(source: string): string {
  if (!source.includes("Verify-ReleaseSignature") || !source.includes("Set-StrictMode -Version Latest")) throw new Error("invalid stage zero");
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(source, "utf16le").toString("base64")}`;
}

if (import.meta.main) {
  const source = readFileSync(join(import.meta.dir, "stage0.ps1"), "utf8");
  process.stdout.write(`${windowsCommand(source)}\n`);
}
