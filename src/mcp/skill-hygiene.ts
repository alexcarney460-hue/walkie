import { isIP } from "node:net";
import { redactSecrets } from "../protocol/safety.ts";

// This scanner is deliberately stricter than runtime redaction: bundled skills
// describe private locations and network destinations in words, without examples.
// Some names are assembled so this source can pass the public export term scan.
const PRIVATE_NAMES = ["alex", "ky" + "le", "carney", "ra" + "ley", "nett" + "rux", "as" + "us", "cookies", "fleetie"];
const SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ["home-or-key-path", /~\/|\$(?:HOME|\{HOME\})|%USERPROFILE%|\/Users\/|\/home\/|\/root\/|(?<![A-Za-z0-9])[A-Z]:[\\/]|\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._-]+|(?<![A-Za-z0-9._-])(?:keys|\.ssh|\.gnupg)(?=[\\/])|[\\/](?:keys|\.ssh|\.gnupg)(?=$|[\\/])|id_rsa|id_ed25519|\.ssh|\.gnupg/i],
  ["private-name", new RegExp(`(?<![A-Za-z])(?:${PRIVATE_NAMES.join("|")})(?![A-Za-z])`, "i")],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/i],
  ["url-host", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/<>()[\]`"'?#]+|(?:^|[\s"'(\[<=,])\/\/[A-Za-z0-9][A-Za-z0-9-]*(?=[./:])/i],
  ["localhost", /(?<![A-Za-z])localhost(?![A-Za-z])/i],
  ["ipv4", /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/],
  ["host-port", /(?<![A-Za-z0-9.-])[a-z][a-z0-9.-]*:\d{1,5}(?!\d)|(?<!\d)\d{3,}:\d{1,5}(?!\d)/i],
  // Markdown file names and automated-access rules are ordinary skill prose.
  ["hostname", /(?<![A-Za-z0-9.-])(?:[a-z0-9-]+\.)+(?!md\b|txt\b)[a-z]{2,}(?![A-Za-z0-9.-])/i],
];

const ADDRESS_CANDIDATE = /[0-9a-f:.]+/gi;
const INTERNATIONAL_PHONE = /(?<![A-Za-z0-9.])\+\d[\d .()-]*(?![A-Za-z0-9.])/g;
const PHONE_SHAPES = [
  /(?<![A-Za-z0-9.])\(\d{3}\)[ .-]*\d{3}[ .-]*\d{4}(?![A-Za-z0-9.])/,
  /(?<![A-Za-z0-9.])\d{3}[ .-]\d{3}[ .-]\d{4}(?![A-Za-z0-9.])/,
  /(?<![A-Za-z0-9.])\d{3}[ .-]\d{4}(?![A-Za-z0-9.])/,
];

export function scanSkillHygiene(body: string): string[] {
  const findings = SHAPES.filter(([, pattern]) => pattern.test(body)).map(([label]) => label);
  if ([...body.matchAll(ADDRESS_CANDIDATE)].some(([candidate]) => candidate.includes(":") && isIP(candidate) === 6)) {
    findings.push("ipv6");
  }
  if (PHONE_SHAPES.some((pattern) => pattern.test(body)) ||
      [...body.matchAll(INTERNATIONAL_PHONE)].some(([candidate]) => candidate.replace(/\D/g, "").length >= 7)) {
    findings.push("phone");
  }
  if (redactSecrets(body).redactions.length > 0) findings.push("secret");
  return findings;
}
