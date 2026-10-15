// fcron upstream a9c1590d9bf8b3ab3b13bba1d2777c7eb3ea6130: allow.c and fcronconf.c.
// Deliberately bounded to stock paths. Do not silently operate on the wrong spool or deny file.
export const FCRON_FILES: [string, string] = ["/etc/fcron.allow", "/etc/fcron.deny"];
const defaults: Record<string, string> = {
  fcrontabs: "/var/spool/fcron", fcronallow: FCRON_FILES[0], fcrondeny: FCRON_FILES[1],
};
const otherKeys = new Set(["pidfile", "suspendfile", "fifofile", "shell", "sendmail", "editor", "maildisplayname"]);
const trim = (s: string) => s.replace(/^[ \t\r\v\f]+|[ \t\r\v\f]+$/g, "");

/** Prefix keys, custom paths and syntax we cannot interpret exactly are refused, including in diagnostics. */
export function fcronConfigProblem(text: string | null): string | null {
  for (const raw of (text ?? "").split("\n")) {
    if (Buffer.byteLength(raw) > 1023 || raw.includes("\0")) return "unsupported fcron configuration line in /etc/fcron.conf";
    const line = trim(raw);
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-z]+)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (!m) return "unsupported fcron configuration syntax in /etc/fcron.conf";
    const key = m[1]!;
    if (Object.hasOwn(defaults, key)) {
      if (m[2] !== defaults[key]) return `unsupported fcron ${key}: only ${defaults[key]} is supported`;
    } else if (!otherKeys.has(key)) return `unsupported fcron configuration key ${key}`;
  }
  return null;
}

/** in_file returns the FIRST exact user or 'all'; fcron does not use cron's allow-file precedence. */
export function fcronDenied(user: string, allow: string | null, deny: string | null): boolean {
  const match = (text: string | null): number => {
    if (text === null) return -1;
    for (const raw of text.split("\n")) {
      if (Buffer.byteLength(raw) > 1023 || raw.includes("\0")) throw new Error("unsupported fcron allow/deny line");
      const line = trim(raw);
      if (line === user) return 1;
      if (line === "all") return 2;
    }
    return 0;
  };
  const a = match(allow), d = match(deny);
  return !((a === -1 && d === -1) || (a === -1 && d === 0) || (a === 1 && d !== 1) || (a === 2 && d <= 0));
}
