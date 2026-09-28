// Credential routing for a credentialed Codex launch (ACCOUNTS-2, rounds 5 and 7 — the Codex twin of
// claude-settings.ts). Codex applies `-c key=value` overrides on top of every config file it loads, so each launch (and
// `codex login` in `walkie accounts add codex`) gets overrides pinning the provider and its endpoints to the official
// ChatGPT ones. Where they go matters (round 7, Opus r6): a subcommand's own `-c` list REPLACES the root one, so the
// pins are placed at the root AND right after every subcommand on the line (`exec`, `exec resume`, `resume`, `login`,
// …), before the caller's own flags. Every TOML file of the account home — config.toml and each `<name>.config.toml`
// profile — is a cleaned copy with the provider / base-URL keys removed (codex-home.ts); project-local configs cannot
// set these keys (Codex ignores them there). A caller's own `-c` that names one of these keys anywhere (its key or its
// value, e.g. an inline profile table) means no Walkie credentials for that run.
// Round 8 (Opus r7): the command line is read with a per-command option table generated from codex 0.156.1's own
// `--help` (codex-cli-table.ts), so a value-taking flag before a nested subcommand (`exec -o file resume …`) cannot
// hide it; a flag the table does not know (another Codex version, a typo) is ambiguous, and an ambiguous command line
// gets NO vault credentials. Role configs for sub-agents (`[agents.<role>].config_file`) are cleaned like profiles.
import { CODEX_CLI, CODEX_VERSION_TABLE, type OptKind } from "./codex-cli-table.ts";

/** The official endpoints Codex uses for a ChatGPT login (codex 0.156 defaults). */
export const OFFICIAL_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/";
export const OFFICIAL_OPENAI_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface CodexPins { chatgpt?: string; openai?: string }

/** The `-c` arguments a credentialed Codex launch starts with. */
export function codexPinArgs(o: CodexPins = {}): string[] {
  const q = (v: string) => JSON.stringify(v);
  return [
    "-c", `model_provider=${q("openai")}`,
    "-c", `chatgpt_base_url=${q(o.chatgpt ?? OFFICIAL_CHATGPT_BASE_URL)}`,
    "-c", `openai_base_url=${q(o.openai ?? OFFICIAL_OPENAI_BASE_URL)}`,
    // Round 7 (Codex r6 1): voice (realtime) has its own endpoints, settable from config layers Walkie does not own
    // (a trusted project's config): the transport is switched off for credentialed launches instead.
    "-c", "features.realtime_conversation=false",
  ];
}

const ROUTING_WORD_RE = /(model_provider|model_providers|chatgpt_base_url|openai_base_url|experimental_realtime_ws_base_url|experimental_realtime_webrtc_call_base_url|experimental_thread_store_endpoint|realtime_conversation)/;
/** A profile name Codex turns into `$CODEX_HOME/<name>.config.toml`: no path pieces (round 8, Opus r7). */
const PROFILE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

/** A caller `-c` value's key and value (`key=value`). */
function overrideParts(v: string): { key: string; value: string } {
  const i = v.indexOf("=");
  return i < 0 ? { key: v.trim(), value: "" } : { key: v.slice(0, i).trim(), value: v.slice(i + 1).trim() };
}

/** One word (or option with its values) of a Codex command line, as codex 0.156.1 reads it (round 10). */
export type CodexToken =
  | { t: "opt"; raw: string; name: string; inline: string | null; values: string[] }
  | { t: "cmd"; raw: string }
  | { t: "arg"; raw: string }
  | { t: "end"; rest: string[] };

/**
 * Why a caller's Codex command line must not get the vault credentials (null when nothing is wrong): a `-c` naming a
 * routing key anywhere (its key in any spelling, or inside its value), voice switched back on, a remote app server,
 * a profile name with path pieces, or a sub-agent role config file (round 8). Round 10 (Opus r8): the line is read
 * with the same reader as the pin placement (planCodexArgv), so an option's value is never mistaken for an option or
 * for `--` (`-m -- --enable x`), and every spelling of an option (`-p x`, `-px`, `-p=x`, `--profile=x`) is checked. A
 * line the reader cannot place falls back to a word-by-word scan (and gets no credentials anyway: the plan fails).
 */
export function routingOverride(args: readonly string[]): string | null {
  const read = readCodexLine(args);
  if (!read.ok) return scanOverride(args);
  for (const tok of read.toks) {
    if (tok.t !== "opt") continue;
    const why = optionProblem(tok.name, tok.inline ?? tok.values[0] ?? null);
    if (why) return why;
  }
  return null;
}

/** The word-by-word fallback for a line the reader cannot place (every spelling of the options below). */
function scanOverride(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") break;
    let name = a;
    let value: string | null = null;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) { name = a.slice(0, eq); value = a.slice(eq + 1); }
    } else if (a.startsWith("-") && a.length > 2) {
      name = a.slice(0, 2);
      value = a.slice(2).replace(/^=/, "");
    }
    if (value === null && TAKES_VALUE.has(name) && i + 1 < args.length) value = args[++i] as string;
    const why = optionProblem(name, value);
    if (why) return why;
  }
  return null;
}

/** The options routingOverride looks at, all of which take a value. */
const TAKES_VALUE = new Set(["--enable", "--remote", "--remote-auth-token-env", "-p", "--profile", "-c", "--config"]);

function optionProblem(name: string, value: string | null): string | null {
  // `--enable <voice feature>` outranks the pin that switches voice off (checked on codex 0.156.1).
  if (name === "--enable" && value !== null && /realtime|voice/i.test(value)) return "--enable realtime_conversation";
  // A remote app server runs the session elsewhere, with the credentials it is handed.
  if (name === "--remote" || name === "--remote-auth-token-env") return name;
  if ((name === "-p" || name === "--profile") && !PROFILE_NAME_RE.test(value ?? "")) return `${name} ${(value ?? "").slice(0, 40)}`;
  if ((name === "-c" || name === "--config") && value !== null) return configProblem(value);
  return null;
}

/** Why one `-c` value is refused (null when it is fine). */
function configProblem(v: string): string | null {
  // Round 9 (Codex r7 1): the override DECODED as TOML (escapes in quoted keys, dotted and quoted keys, inline
  // tables), every key and value checked; round 10: one that does not decode is refused unless it is a plain word.
  const decoded = decodedOverrideProblem(v);
  if (decoded) return decoded;
  // Round 10: Bun's TOML reader also MIS-reads some values Codex accepts (`t=1979-05-27` decodes as `{t=1979,"05"=27}`),
  // so a successful decode is not proof either. A routing key can only be kept out of the raw text below through an
  // escape in a quoted key (`"\u0063onfig_file"`), so an override with any backslash is refused outright.
  if (v.includes("\\")) return `${overrideParts(v).key} (escaped characters are not accepted)`;
  // Anywhere in the override (round 7): the key in any spelling (spaces around dots, quotes) or inside the value
  // (`profiles.p={chatgpt_base_url=…}`, `profiles={p={…}}`).
  const compact = v.replace(/["'\s]/g, "");
  const m = ROUTING_WORD_RE.exec(compact);
  if (m) return (v.split("=")[0]?.trim() || m[1]) as string;
  const { key, value } = overrideParts(v);
  const k = key.replace(/["'\s]/g, "");
  // Round 8: a sub-agent role config file, however it is spelled (`agents.x.config_file`, `agents={x={config_file=…}}`).
  if (/config_file/.test(compact)) return key;
  // A profile chosen by -c must be a plain name as well.
  if (k === "profile" && !PROFILE_NAME_RE.test(value.replace(/^["']|["']$/g, ""))) return key;
  return null;
}

const CODEX_VERSION = `codex ${CODEX_VERSION_TABLE}`;

/** Keys a caller's `-c` may never set, wherever they sit in the decoded override. */
const REFUSED_KEYS = new Set([
  "model_provider", "model_providers", "chatgpt_base_url", "openai_base_url", "experimental_realtime_ws_base_url",
  "experimental_realtime_webrtc_call_base_url", "experimental_thread_store_endpoint", "realtime_conversation", "config_file",
]);

/** Why a `-c key=value` override is refused once decoded as TOML (null when it is fine). */
export function decodedOverrideProblem(v: string): string | null {
  const eq = v.indexOf("=");
  if (eq <= 0) return null; // no value: Codex rejects it itself
  const key = v.slice(0, eq).trim();
  const value = v.slice(eq + 1).trim();
  let doc: unknown = null;
  // Codex parses the value as TOML and falls back to a plain string; the key is parsed as a TOML key here, which
  // decodes more spellings than Codex's own split on "." (so this refuses at least what Codex would apply).
  try { doc = Bun.TOML.parse(`${key} = ${value}`); } catch { /* not TOML to Bun */ }
  // Round 10 (Opus r8): Codex's TOML reader accepts forms Bun's (1.3.14) does not (a TOML 1.1 datetime without
  // seconds, `1979-05-27T07:32`, inside a table), so a value Bun cannot decode may still be a table to Codex — one that
  // could name a routing key Bun never sees. Only a plain word (no table, array, key, or quote syntax) is read as the
  // literal string Codex would fall back to; anything else that does not decode is refused.
  if (doc === null && !/[{}[\]="']/.test(value)) {
    try { doc = Bun.TOML.parse(`${key} = ${JSON.stringify(value)}`); } catch { /* the key itself does not decode */ }
  }
  if (doc === null) return `${key} (not readable as TOML)`;
  const bad = (k: string, path: string[]): boolean =>
    REFUSED_KEYS.has(k) || /realtime|voice/i.test(k) || (k === "profile" && path.length === 0);
  let problem: string | null = null;
  const walk = (x: unknown, path: string[]): void => {
    if (problem || !x || typeof x !== "object") return;
    for (const [k, y] of Object.entries(x as Record<string, unknown>)) {
      if (bad(k, path)) {
        if (k === "profile" && typeof y === "string" && PROFILE_NAME_RE.test(y)) continue;
        problem = key;
        return;
      }
      walk(y, [...path, k]);
    }
  };
  walk(doc, []);
  return problem;
}

export type CodexPlan = { ok: true; argv: string[] } | { ok: false; why: string };

/**
 * A Codex command line with the routing pins in every place Codex reads `-c` from (rounds 7 and 8): at the root, and
 * right after each subcommand token (including a nested `exec resume` / `exec fork` / `exec review`), before the
 * caller's own options there. A subcommand's `-c` list replaces the ones before it (checked on codex 0.156.1), so the
 * caller's own earlier `-c` overrides are carried along after the pins. The line is read with codex 0.156.1's option
 * table; anything it cannot place with certainty (an unknown flag, a flag given a value it does not take, joined short
 * flags, a subcommand-looking word after a positional) is ambiguous: `ok: false`, and the caller gives no credentials.
 */
export function planCodexArgv(args: readonly string[], o: CodexPins = {}): CodexPlan {
  const read = readCodexLine(args);
  if (!read.ok) return read;
  const pins = codexPinArgs(o);
  const out: string[] = [...pins];
  const carried: string[] = [];
  for (const tok of read.toks) {
    if (tok.t === "opt") {
      out.push(tok.raw, ...tok.values);
      if (tok.name === "-c" || tok.name === "--config") carried.push(tok.raw, ...tok.values);
    } else if (tok.t === "cmd") {
      out.push(tok.raw, ...pins, ...carried);
    } else if (tok.t === "arg") {
      out.push(tok.raw);
    } else {
      // Round 9 (Codex r7 1): the pins also close the last level's options, so no caller `-c` can come after them.
      out.push(...pins, ...tok.rest);
      return { ok: true, argv: out };
    }
  }
  out.push(...pins);
  return { ok: true, argv: out };
}

/** The hidden alias codex 0.156.1 accepts wherever the flag it stands for is listed (checked on every table path). */
const HIDDEN_ALIASES: Readonly<Record<string, string>> = { "--yolo": "--dangerously-bypass-approvals-and-sandbox" };

/**
 * A Codex command line split the way codex 0.156.1 reads it (round 10: shared by the pin placement and
 * routingOverride), or why it cannot be read with certainty (an unknown flag, a flag given a value it does not take,
 * a subcommand-looking word after a positional or after an image list).
 */
export function readCodexLine(args: readonly string[]): { ok: true; toks: CodexToken[] } | { ok: false; why: string } {
  const toks: CodexToken[] = [];
  let path = "";
  let known = true; // the current command path is in the table
  let positional = false; // a positional was seen at this level
  const fail = (why: string) => ({ ok: false as const, why });
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") { toks.push({ t: "end", rest: args.slice(i) }); return { ok: true, toks }; }
    const cmd = CODEX_CLI[path];
    if (a.startsWith("-") && a.length > 1) {
      if (!known || !cmd) return fail(`options after an unknown command (${path || "codex"})`);
      let name = a;
      let inline: string | null = null;
      if (a.startsWith("--")) {
        const eq = a.indexOf("=");
        if (eq > 0) { name = a.slice(0, eq); inline = a.slice(eq + 1); }
      } else if (a.length > 2) {
        name = a.slice(0, 2);
        inline = a.slice(2).replace(/^=/, "");
      }
      const alias = HIDDEN_ALIASES[name];
      const kind: OptKind | undefined = cmd.opts[name] ?? (alias !== undefined ? cmd.opts[alias] : undefined);
      if (!kind) return fail(`${name} is not an option of \`codex${path ? ` ${path}` : ""}\` in ${CODEX_VERSION}`);
      const values: string[] = [];
      if (kind === "flag") {
        if (inline !== null) return fail(`${name} takes no value`);
      } else if (kind === "value") {
        if (inline === null) {
          // Round 10: codex 0.156.1 does not take a separate word starting with "-" as a value (`-m -- x`, `-m --remote`:
          // "a value is required"; `-m -x`: "unexpected argument"), only a lone "-"; neither does this reader.
          const next = args[i + 1];
          if (next === undefined || (next.startsWith("-") && next !== "-")) return fail(`${name} needs a value`);
          values.push(args[++i] as string);
        }
      } else if (kind === "optional") {
        if (inline === null && i + 1 < args.length && !(args[i + 1] as string).startsWith("-")) values.push(args[++i] as string);
      } else {
        if (inline === null) {
          if (i + 1 >= args.length) return fail(`${name} needs a value`);
          // clap takes every following word up to the next option (a subcommand name included, checked on 0.156.1).
          while (i + 1 < args.length && !(args[i + 1] as string).startsWith("-")) values.push(args[++i] as string);
          // Round 9 (Codex r7 2): whether a subcommand name after an image list is another value (as codex 0.156.1
          // parses it) or the subcommand cannot be settled from outside: ambiguous.
          if (values.slice(1).some((w) => cmd.cmds.includes(w))) return fail(`${name} is followed by the subcommand name "${values.find((w, j) => j > 0 && cmd.cmds.includes(w))}"`);
        }
      }
      toks.push({ t: "opt", raw: a, name, inline, values });
      continue;
    }
    // A positional word: a subcommand of this command (before any positional here), or an argument.
    if (known && cmd && cmd.cmds.includes(a)) {
      if (positional) return fail(`"${a}" after an argument (a subcommand or not?)`);
      const canonical = a === "e" ? "exec" : a === "a" ? "apply" : a;
      path = path ? `${path} ${canonical}` : canonical;
      known = !!CODEX_CLI[path];
      toks.push({ t: "cmd", raw: a });
      positional = false;
      continue;
    }
    toks.push({ t: "arg", raw: a });
    positional = true;
  }
  return { ok: true, toks };
}

/** planCodexArgv for callers that have already checked the plan: throws when the line is ambiguous. */
export function pinnedCodexArgv(args: readonly string[], o: CodexPins = {}): string[] {
  const plan = planCodexArgv(args, o);
  if (!plan.ok) throw new Error(`the codex command line could not be read with certainty (${plan.why})`);
  return plan.argv;
}
