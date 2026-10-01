// Tiny argv parser: positionals + --flag value / --flag=value / boolean flags.

export interface Args {
  readonly pos: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

export class UsageError extends Error {}

const SHORT: Record<string, string> = { o: "output", n: "limit", h: "help", j: "json", t: "timeout" };

function booleanValue(v: string): boolean | null {
  const t = v.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(t)) return true;
  if (["false", "0", "no", "off"].includes(t)) return false;
  return null;
}

export function parseArgs(argv: readonly string[], booleans: ReadonlySet<string>): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) {
        const value = a.slice(eq + 1);
        // A boolean given a value (`--for-agent=true`) is still a boolean (ADD-MACHINE-3: "true" as a string used to
        // read as off where the check was `=== true`): yes/no words only, anything else is refused.
        if (booleans.has(name)) {
          const b = booleanValue(value);
          if (b === null) throw new UsageError(`--${name} is a switch: give it alone, or =true / =false`);
          if (b) flags.set(name, true);
          else if (name === "inherit-person-config") flags.set(name, "false"); // this opt-in can be explicitly withdrawn
          else flags.delete(name); // a later =false overrides an earlier switch (wrappers append overrides)
          continue;
        }
        flags.set(name, value);
        continue;
      }
      if (booleans.has(name)) { flags.set(name, true); continue; }
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`--${name} needs a value`);
      flags.set(name, next);
      i++;
      continue;
    }
    if (/^-[a-z]$/.test(a)) {
      const name = SHORT[a.slice(1)] ?? a.slice(1);
      if (booleans.has(name)) { flags.set(name, true); continue; }
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`${a} needs a value`);
      flags.set(name, next);
      i++;
      continue;
    }
    pos.push(a);
  }
  return { pos, flags };
}

export function str(a: Args, name: string): string | undefined {
  const v = a.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

/** A switch (declared in the command's booleans, so parseArgs already normalised `--x=true|false`). */
export function bool(a: Args, name: string): boolean {
  return a.flags.get(name) === true;
}

export function int(a: Args, name: string, def?: number): number | undefined {
  const v = str(a, name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer`);
  return n;
}

export function need(a: Args, i: number, what: string): string {
  const v = a.pos[i];
  if (v === undefined || v === "") throw new UsageError(`missing ${what}`);
  return v;
}

/** "#build" / "build" -> "build". */
export function channelArg(s: string): string {
  return s.replace(/^#/, "");
}
