// Structural secret redaction (WALKIE-MISSION-1 fix rounds 5-6): instead of one regex per credential form, text is
// read the way a shell reads it, and the VALUE of any assignment or flag whose NAME says "secret" is redacted whole,
// however it is quoted, escaped or concatenated; then key/value forms (YAML incl. block scalars, TOML, .netrc,
// .pgpass, JSON, XML, code assignments to env maps); then any token that looks random. Provider token prefixes stay in
// safety.ts. Best-effort defence in depth for deliberately written text, not a guarantee (docs/SECURITY.md).
//
// Round 6: fewer false positives (a "weak" name such as pass / token / session / auth needs a value that is not
// plain; identifiers, versions, ref names and CamelCase names are not random; tools' short flags are subcommand
// aware), and linear time (the tokenizer keeps its state, edits are assembled once, every regex is free of nested or
// unbounded backtracking).

export const MARKER_RE = /\[REDACTED:[a-z_]+\]/;
const MARKER_ONLY = /^\[REDACTED:[a-z_]+\]$/;

// ---- secret names -------------------------------------------------------------------------------------------------

/** Parts that always name a secret. */
const STRONG_PARTS = new Set(["password", "passwd", "passphrase", "secret", "credential", "credentials", "storepass", "keypass", "apikey", "authorization"]);
/** Parts that name a secret only when the value doesn't look plain (pass=3, session: <uuid>, auth: fix …). */
const WEAK_PARTS = new Set(["pass", "pwd", "token", "auth", "cookie", "session", "private"]);
/** "key" names a secret only with one of these before it ("api_key", "client-key-data", "privateKey"). */
const KEY_QUALIFIERS = new Set(["api", "access", "private", "secret", "signing", "client", "master", "encryption", "account", "ssh", "service", "app", "auth", "shared", "sas", "storage", "license", "deploy", "webhook", "hmac", "jwt", "session"]);
/** Substrings that name a secret inside one word ("keystorepassword", "accesskey"). */
const STRONG_SUBSTRINGS = ["password", "passwd", "passphrase", "secret", "apikey", "credential", "storepass", "keypass", "accesskey", "privatekey"];
const NOT_SECRET_NAMES = new Set(["pwd", "oldpwd", "keyboard", "keychain", "passes", "passed", "tokens", "sessions", "secrets", "cookies", "keys"]);
const NOT_SECRET_SUFFIX = /(?:^|[-_.])(?:stdin|file|files|path|dir|env|prompt|id|ids|name|type|length|len|size|count|counts|url|uri|header|format|algorithm|store|ring|source|kind|mode|method|hint|label|expiry|expires|ttl|policy|budget|limit|limits|max|min|timeout|window|rate|usage|used|left|remaining|cost|price|enabled|required|refresh|reset|expired|valid|version|number|index|status|state|scope|scopes|chars|bytes|bits|digits)$/i;

export type SecretStrength = "strong" | "weak";

/** Whether a variable / flag / key name names a secret, and how surely. */
export function secretStrength(name: string): SecretStrength | null {
  const n = name.replace(/^-+/, "").replace(/^["']|["']$/g, "");
  if (!n || n.length > 80) return null;
  const lower = n.toLowerCase();
  if (NOT_SECRET_NAMES.has(lower) || NOT_SECRET_SUFFIX.test(n)) return null;
  const parts = n.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s\-_.:/]+/).map((p) => p.toLowerCase()).filter(Boolean);
  if (parts.some((p) => STRONG_PARTS.has(p))) return "strong";
  if (parts.some((p, k) => (p === "key" || p === "keys") && k > 0 && KEY_QUALIFIERS.has(parts[k - 1] as string))) return "strong";
  if (STRONG_SUBSTRINGS.some((s) => lower.includes(s))) return "strong";
  if (parts.some((p) => WEAK_PARTS.has(p))) return "weak";
  return null;
}

export function isSecretName(name: string): boolean {
  return secretStrength(name) !== null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A value that is plainly not a secret: a short number, a short word, a boolean, a UUID, a template reference. */
const PLAIN = /^(?:\d{1,6}|[a-z]{1,12}|true|false|yes|no|on|off|null|none|~|\$\{?[A-Za-z_][\w.]{0,60}\}?|\{\{[^}]{0,80}\}\})$/i;

/** Code, not a value: a call, a dotted identifier, an item of a list ("z.string()", "res.body.token", "renewalToken,"). */
const CODE_VALUE = /\(|^[A-Za-z_$][\w$]{0,80}(?:\.[A-Za-z_$][\w$]{0,80}){1,12}[,;]?$|^[A-Za-z_$][\w$]{0,80}[,;]$/;

/** Whether `value` under a name of this strength is to be redacted. */
export function redactValue(strength: SecretStrength | null, value: string): boolean {
  const v = value.trim();
  if (!strength || !v || MARKER_ONLY.test(v)) return false;
  if (/^\$\{?[A-Za-z_][\w.]{0,60}\}?$/.test(v) || /^\{\{[^}]{0,80}\}\}$/.test(v)) return false; // a reference, not a value
  return strength === "strong" || !(PLAIN.test(v) || UUID_RE.test(v) || CODE_VALUE.test(v));
}

// ---- shell words --------------------------------------------------------------------------------------------------

export interface Token {
  kind: "word" | "op";
  /** Source span. */
  start: number; end: number;
  /** The word as the shell sees it (quotes removed, escapes applied); for an op, the operator. */
  value: string;
  /** The quote the word opened with, if any. */
  quote: "" | "'" | '"';
}

const OP_CHARS = new Set(["&", "|", ";", "(", ")", "\n", "<", ">"]);
function opAt(text: string, i: number): string | null {
  const c = text[i] as string;
  if (!OP_CHARS.has(c)) return null;
  const two = text.slice(i, i + 2);
  return two === "&&" || two === "||" || two === ";;" ? two : c;
}

/**
 * Splits command-like text into shell words and operators, in one pass (linear). Handles '…' (multi-line), "…"
 * (escapes), $'…' (ANSI-C), backslash-escaped characters (spaces included) and concatenation ('a'"b" is one word).
 * An apostrophe in the middle of a plain word ("don't") is a letter, so prose is not swallowed into one quote;
 * inside single quotes \' does not close (not the shell's rule, on purpose). Unterminated quotes run to the end.
 */
export function shellTokens(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    const op = opAt(text, i);
    if (op) { out.push({ kind: "op", start: i, end: i + op.length, value: op, quote: "" }); i += op.length; continue; }
    const start = i;
    const parts: string[] = [];
    let len = 0;
    let quote: Token["quote"] = "";
    let lastWasQuote = false;
    // Word shape so far, kept incrementally: is it a flag (-x / --name), and its last character.
    let flag = true;
    let dashes = 0;
    let last = "";
    const push = (s: string) => {
      for (const ch of s) {
        if (len === 0) flag = ch === "-";
        else if (flag) flag = (ch === "-" && dashes === len && dashes < 2) || /[\w.-]/.test(ch);
        if (ch === "-" && dashes === len) dashes++;
        last = ch;
        len++;
      }
      parts.push(s);
    };
    while (i < n) {
      const ch = text[i] as string;
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") break;
      const o = opAt(text, i);
      if (o) break;
      const quoteOk = len === 0 || lastWasQuote || (flag && dashes > 0) || last === "=" || last === ":" || last === "%" || last === "＝";
      if (ch === "\\" && i + 1 < n) { push(text[i + 1] as string); i += 2; lastWasQuote = false; continue; }
      if (ch === "$" && text[i + 1] === "'" && quoteOk) {
        if (len === 0) quote = "'";
        i += 2;
        let buf = "";
        while (i < n && text[i] !== "'") {
          if (text[i] === "\\" && i + 1 < n) { buf += ansiC(text[i + 1] as string); i += 2; } else { buf += text[i]; i++; }
        }
        push(buf); i++; lastWasQuote = true; continue;
      }
      if (ch === "'" && quoteOk) {
        if (len === 0 && !lastWasQuote) quote = "'";
        let stop = i + 1;
        while (stop < n && !(text[stop] === "'" && text[stop - 1] !== "\\")) stop++;
        push(text.slice(i + 1, stop).replace(/\\'/g, "'"));
        i = stop + 1; lastWasQuote = true; continue;
      }
      if (ch === '"' && quoteOk) {
        if (len === 0 && !lastWasQuote) quote = '"';
        i++;
        let buf = "";
        while (i < n && text[i] !== '"') {
          if (text[i] === "\\" && i + 1 < n && /["\\$`\n]/.test(text[i + 1] as string)) { buf += text[i + 1]; i += 2; } else { buf += text[i]; i++; }
        }
        push(buf); i++; lastWasQuote = true; continue;
      }
      // a run of plain characters at once
      let j = i + 1;
      while (j < n && !" \t\r\n\\$'\"&|;()<>".includes(text[j] as string)) j++;
      push(text.slice(i, j));
      i = j; lastWasQuote = false;
    }
    out.push({ kind: "word", start, end: Math.min(i, n), value: parts.join(""), quote });
  }
  return out;
}

function ansiC(c: string): string {
  return c === "n" ? "\n" : c === "t" ? "\t" : c;
}

// ---- command-aware redaction ----------------------------------------------------------------------------------------

/** `sub`: the flags count only after this subcommand (`docker login -p` is a password, `docker run -p` a port). */
type Rule = { next?: readonly string[]; glued?: readonly string[]; sub?: string };
/** Short flags whose value is a password, per tool (the long ones are found by name). */
const TOOL_FLAGS: Readonly<Record<string, Rule>> = {
  mysql: { glued: ["-p"] }, mysqldump: { glued: ["-p"] }, mysqladmin: { glued: ["-p"] }, mariadb: { glued: ["-p"] },
  mongo: { next: ["-p"] }, mongosh: { next: ["-p"] }, mongodump: { next: ["-p"] }, mongorestore: { next: ["-p"] },
  mongoexport: { next: ["-p"] }, mongoimport: { next: ["-p"] },
  sshpass: { next: ["-p"], glued: ["-p"] },
  docker: { next: ["-p"], sub: "login" }, podman: { next: ["-p"], sub: "login" }, nerdctl: { next: ["-p"], sub: "login" },
  helm: { next: ["-p"], sub: "login" }, oras: { next: ["-p"], sub: "login" }, skopeo: { next: ["-p"], sub: "login" },
  "redis-cli": { next: ["-a"] }, sqlcmd: { next: ["-P"] }, bcp: { next: ["-P"] },
  ldapsearch: { next: ["-w"] }, ldapadd: { next: ["-w"] }, ldapmodify: { next: ["-w"] }, ldapdelete: { next: ["-w"] },
  ldapwhoami: { next: ["-w"] }, ldappasswd: { next: ["-w", "-s"] },
  openssl: { next: ["-k", "-pass", "-passin", "-passout", "-password"] }, zip: { next: ["-P"] }, unzip: { next: ["-P"] },
  "7z": { glued: ["-p"] }, "7za": { glued: ["-p"] }, "ssh-keygen": { next: ["-N", "-P"] },
  security: { next: ["-w", "-p"] }, curl: { next: ["-u", "-U", "--user", "--proxy-user"] },
  smbclient: { next: ["-U"] }, keytool: { next: ["-storepass", "-keypass", "-srcstorepass", "-deststorepass", "-srckeypass", "-destkeypass"] },
  jarsigner: { next: ["-storepass", "-keypass"] }, twine: { next: ["-p"] }, doctl: { next: ["-t"] },
};
/** Commands that take a password on stdin: `echo X | <this>` hides X. */
const STDIN_SECRET = /^(?:sudo(?: \S+){0,8} -S\b|(?:docker|podman|nerdctl|helm|oras|skopeo) (?:\S+ ){0,8}--password-stdin|gh auth login\b|chpasswd\b|passwd\b)/;
const WRAPPERS = new Set(["sudo", "env", "time", "nice", "exec", "command", "nohup", "doas", "stdbuf", "timeout"]);
/** Wrapper flags that take an argument (`sudo -u root …`, `nice -n 5 …`, `timeout 30 …` is handled as a number). */
const WRAPPER_ARG_FLAGS = new Set(["-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t", "-n", "-i", "-o", "-e", "--user", "--group", "-S"]);
const ASSIGN_RE = /^(-D)?([A-Za-z_][\w.-]{0,80})(:=|=|＝)([\s\S]*)$/;

interface Edit { start: number; end: number; text: string }

function basename(cmd: string): string {
  const k = cmd.lastIndexOf("/");
  return k >= 0 ? cmd.slice(k + 1) : cmd;
}

/** Index of the command word, after assignments and wrappers with their flags. */
function commandIndex(words: readonly Token[]): number {
  let c = 0;
  let wrapped = false;
  while (c < words.length) {
    const v = (words[c] as Token).value;
    if (ASSIGN_RE.test(v)) { c++; continue; }
    if (WRAPPERS.has(basename(v))) { wrapped = true; c++; continue; }
    if (wrapped && v.startsWith("-")) { c += WRAPPER_ARG_FLAGS.has(v) && v !== "-S" ? 2 : 1; continue; }
    if (wrapped && /^\d+[smhd]?$/.test(v)) { c++; continue; } // timeout 30 …
    break;
  }
  return c;
}

/** Redaction edits for one command (the tokens between operators). */
function commandEdits(words: Token[], nextCommand: string): Edit[] {
  const edits: Edit[] = [];
  const c = commandIndex(words);
  const cmd = basename(words[c]?.value ?? "");
  const tool = TOOL_FLAGS[cmd];
  const rule: Rule = tool && (!tool.sub || words.some((w, k) => k > c && w.value === tool.sub)) ? tool : {};
  const ghSecret = cmd === "gh" && words[c + 1]?.value === "secret";
  const configCmd = words.slice(c, c + 3).some((w) => /^(?:config|configure|config:set)$/.test(w.value));
  const mark = (w: Token, label: string) => ({ start: w.start, end: w.end, text: `${label}[REDACTED:secret]` });
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as Token;
    const v = w.value;
    if (MARKER_ONLY.test(v)) continue;
    const next = words[i + 1];
    // NAME=value (and -Dname=value, NAME:=value, full-width ＝)
    const a = ASSIGN_RE.exec(v);
    if (a && redactValue(secretStrength(a[2] as string), a[4] as string)) {
      edits.push(mark(w, `${a[1] ?? ""}${a[2]}${a[3] === "＝" ? "=" : a[3]}`));
      continue;
    }
    // NAME := value / NAME = value (make, .env with spaces): only as the first word (not `const TOKEN = …` in code)
    if (i === 0 && /^[A-Za-z_][\w.-]{0,80}$/.test(v) && next && /^(?::=|=|＝)$/.test(next.value) && words[i + 2] && redactValue(secretStrength(v), (words[i + 2] as Token).value)) {
      edits.push(mark(words[i + 2] as Token, ""));
      i += 2;
      continue;
    }
    // `aws configure set aws_secret_access_key VALUE`, `git config user.password VALUE`, `npm config set _auth VALUE`
    const prevWord = words[i - 1]?.value ?? "";
    if (configCmd && /^(?:set|config|add|put|set-credentials)$/.test(prevWord) && !v.startsWith("-") && next && next.kind === "word" && redactValue(secretStrength(v), next.value)) {
      edits.push(mark(next, ""));
      i++;
      continue;
    }
    // `gh secret set NAME --body VALUE` / `-b VALUE`
    if (ghSecret && (v === "--body" || v === "-b") && next && !MARKER_ONLY.test(next.value)) {
      edits.push(mark(next, ""));
      i++;
      continue;
    }
    // --name=value / --name value
    const f = /^(--?[A-Za-z][\w.-]{0,80})=([\s\S]+)$/.exec(v);
    if (f && redactValue(secretStrength(f[1] as string), f[2] as string)) { edits.push(mark(w, `${f[1]}=`)); continue; }
    // --from-literal=db-pass=VALUE (an assignment inside a flag's value)
    const fa = f ? ASSIGN_RE.exec(f[2] as string) : null;
    if (fa && redactValue(secretStrength(fa[2] as string), fa[4] as string)) { edits.push(mark(w, `${f?.[1]}=${fa[2]}=`)); continue; }
    if (/^--[A-Za-z][\w.-]{0,80}$/.test(v) && next && next.kind === "word" && !next.value.startsWith("-") && redactValue(secretStrength(v), next.value)) {
      edits.push(mark(next, ""));
      i++;
      continue;
    }
    // tool-specific short flags
    if (rule.next?.includes(v) && next && next.kind === "word" && !MARKER_ONLY.test(next.value)) {
      edits.push(mark(next, cmd === "smbclient" && next.value.includes("%") ? `${next.value.split("%")[0]}%` : ""));
      i++;
      continue;
    }
    const glued = rule.glued?.find((g) => v.startsWith(g) && v.length > g.length);
    if (glued && !MARKER_ONLY.test(v.slice(glued.length))) { edits.push(mark(w, glued)); continue; }
    // htpasswd -b file user PASSWORD
    if (cmd === "htpasswd" && v === "-b") {
      const rest = words.slice(i + 1).filter((x) => !x.value.startsWith("-"));
      const pw = rest[2];
      if (pw && !MARKER_ONLY.test(pw.value)) edits.push(mark(pw, ""));
    }
    // a word with several name=value pairs inside ("host=db user=app password=…", a libpq / ODBC string)
    if (v.length <= 4_096 && /\s/.test(v) && v.includes("=")) {
      let hit = false;
      const inner = v.replace(/(^|[\s;])([A-Za-z_][\w.-]{0,80})=((?:[^\s;'"]|'[^'\n]{0,512}'|"[^"\n]{0,512}"){1,512})/g, (whole, pre: string, key: string, value: string) => {
        if (!redactValue(secretStrength(key), value)) return whole;
        hit = true;
        return `${pre}${key}=[REDACTED:secret]`;
      });
      if (hit) { edits.push({ start: w.start, end: w.end, text: `${w.quote}${inner}${w.quote}` }); continue; }
    }
    // a header-like word: 'Cookie: …', 'Authorization: Bearer …', 'x-api-key: …'
    const h = /^([A-Za-z][\w-]{0,80})\s*:\s*([\s\S]+)$/.exec(v);
    if (h && w.quote && redactValue(secretStrength(h[1] as string) === "weak" && /\s/.test((h[2] as string).trim()) ? "strong" : secretStrength(h[1] as string), h[2] as string)) {
      edits.push({ start: w.start, end: w.end, text: `${w.quote}${h[1]}: [REDACTED:secret]${w.quote}` });
    }
  }
  // echo SECRET | sudo -S … / docker login --password-stdin / gh auth login --with-token
  if ((cmd === "echo" || cmd === "printf") && STDIN_SECRET.test(nextCommand)) {
    for (const w of words.slice(c + 1)) if (!w.value.startsWith("-") && !MARKER_ONLY.test(w.value)) edits.push(mark(w, ""));
  }
  return edits;
}

/** Applies non-overlapping edits (the earliest-starting wins), building the output once. */
function applyEdits(text: string, edits: Edit[]): string {
  if (!edits.length) return text;
  const sorted = [...edits].sort((x, y) => x.start - y.start || y.end - x.end);
  const out: string[] = [];
  let at = 0;
  for (const e of sorted) {
    if (e.start < at) continue;
    out.push(text.slice(at, e.start), e.text);
    at = e.end;
  }
  out.push(text.slice(at));
  return out.join("");
}

/** Redacts credential values in command-like text, word by word (see shellTokens). */
export function redactCommands(text: string): string {
  const tokens = shellTokens(text);
  const commands: Token[][] = [[]];
  const pipes: boolean[] = [false];
  for (const t of tokens) {
    if (t.kind === "op") { commands.push([]); pipes.push(t.value === "|"); } else (commands[commands.length - 1] as Token[]).push(t);
  }
  const edits: Edit[] = [];
  commands.forEach((words, k) => {
    const next = pipes[k + 1] ? (commands[k + 1] ?? []).slice(0, 12).map((w) => w.value.slice(0, 64)).join(" ") : "";
    edits.push(...commandEdits(words, next));
  });
  return applyEdits(text, edits);
}

// ---- key/value forms ------------------------------------------------------------------------------------------------

/** One replace pass whose callback decides; linear regexes only. */
function sub(text: string, re: RegExp, fn: (m: string[]) => string | null): string {
  return text.replace(re, (...m: unknown[]) => fn(m.slice(0, -2).map((x) => (typeof x === "string" ? x : ""))) ?? String(m[0]));
}

/** `key: value` / `key = value` lines, YAML block scalars, JSON / XML / code / .netrc / .pgpass forms. */
export function redactKeyValues(text: string): string {
  let out = text;
  // YAML / TOML / INI / .env lines (KEY=value without spaces is a shell assignment: redactCommands took it)
  out = sub(out, /^([ \t]{0,40}(?:export[ \t]+)?)(["']?)([A-Za-z_][\w.-]{0,80})\2([ \t]*:=[ \t]*|[ \t]*:[ \t]+|[ \t]*:(?=\S)|[ \t]+=[ \t]*|[ \t]*=[ \t]+|[ \t]*＝[ \t]*)(\S[^\n]{0,4000})$/gm,
    ([, pre, q, key, sep, value]) => {
      const strength = secretStrength(key as string) ?? ((key as string).toLowerCase() === "pwd" && (sep as string).includes(":") ? "weak" : null);
      const v = (value as string).trim();
      if (/^[|>][-+]?$/.test(v) || v.startsWith("//")) return null; // a block scalar (below), a URL
      // A weak name ("auth:", "session:") with a sentence after it is prose, not a key/value line.
      if (strength === "weak" && /\s/.test(v) && !/^(["']).*\1$/.test(v)) return null;
      return redactValue(strength, v.replace(/^(["'])(.*)\1$/, "$2")) ? `${pre}${q}${key}${q}${(sep as string).replace("＝", "=")}[REDACTED:secret]` : null;
    });
  // YAML block scalar: password: |\n  value lines
  out = sub(out, /^([ \t]{0,40})([A-Za-z_][\w.-]{0,80}):[ \t]*[|>][-+]?[ \t]*\n((?:\1[ \t]+[^\n]*(?:\n|$)){1,200})/gm,
    ([whole, indent, key, block]) => (secretStrength(key as string) ? (whole as string).slice(0, (whole as string).length - (block as string).length) + `${indent}  [REDACTED:secret]\n` : null));
  // JSON (and JSON inside a quoted string, escaped quotes): "password": "…" / "password": 123456
  out = sub(out, /("([^"\\\n]{1,64})"[ \t]*:[ \t]*)("(?:[^"\\\n]|\\.){0,4096}"|-?\d{1,40}\b)/g, ([, label, key, value]) =>
    redactValue(secretStrength(key as string), (value as string).replace(/^"|"$/g, "")) ? `${label}"[REDACTED:secret]"` : null);
  out = sub(out, /(\\"([^"\\\n]{1,64})\\"[ \t]*:[ \t]*)\\"((?:[^"\\\n]|\\[^"]){0,4096})\\"/g, ([, label, key, value]) =>
    redactValue(secretStrength(key as string), value as string) ? `${label}\\"[REDACTED:secret]\\"` : null);
  // Ruby hashes: :password => "…" / "passwd" => "…"
  out = sub(out, /((?::|["'])([A-Za-z_][\w.-]{0,64})["']?[ \t]*=>[ \t]*)("(?:[^"\\\n]|\\.){0,4096}"|'(?:[^'\\\n]|\\.){0,4096}'|[^\s,}]{1,4096})/g, ([, label, key, value]) =>
    redactValue(secretStrength(key as string), (value as string).replace(/^["']|["']$/g, "")) ? `${label}"[REDACTED:secret]"` : null);
  // env maps in code: os.environ["X"] = "…", process.env.X = '…', ENV['X']="…", $env:X = "…"
  out = sub(out, /((?:os\.environ|process\.env|ENV|\$env:)(?:\[[ \t]*["']([\w.-]{1,80})["'][ \t]*\]|\.?([\w]{1,80}))[ \t]*=[ \t]*)("(?:[^"\\\n]|\\.){0,4096}"|'(?:[^'\\\n]|\\.){0,4096}'|[^\s;]{1,4096})/g, ([, label, k1, k2, value]) =>
    redactValue(secretStrength((k1 || k2) as string), (value as string).replace(/^["']|["']$/g, "")) ? `${label}"[REDACTED:secret]"` : null);
  // code assignments of a quoted literal: config.password = "…", self.api_key = '…', let token = "…";
  out = sub(out, /(\b([A-Za-z_][\w]{0,80})[ \t]*[:]?=[ \t]*)("(?:[^"\\\n]|\\.){1,4096}"|'(?:[^'\\\n]|\\.){1,4096}')/g, ([, label, key, value]) =>
    redactValue(secretStrength(key as string), (value as string).slice(1, -1)) ? `${label}"[REDACTED:secret]"` : null);
  // XML: <password>…</password>, <add key="ApiKey" value="…"/>
  out = sub(out, /(<([A-Za-z][\w.-]{0,64})>)([^<\n]{1,4096})(<\/\2>)/g, ([, open, tag, value, close]) =>
    redactValue(secretStrength(tag as string), value as string) ? `${open}[REDACTED:secret]${close}` : null);
  out = sub(out, /(key="([^"\n]{1,64})"[ \t]+value=")([^"\n]{1,4096})(")/gi, ([, label, key, value, end]) =>
    redactValue(secretStrength(key as string), value as string) ? `${label}[REDACTED:secret]${end}` : null);
  // .netrc: a password token in text that has a machine / default entry (one line or several)
  if (/(?:^|\s)machine\s/.test(out)) {
    out = sub(out, /((?:^|[ \t\n])password[ \t\n]+)(\S{1,4096})/g, ([, label, value]) => (MARKER_ONLY.test(value as string) ? null : `${label}[REDACTED:secret]`));
  }
  // a .netrc entry on one line without "machine": login u password P
  out = sub(out, /(\blogin[ \t]+\S{1,256}[ \t]+password[ \t]+)(\S{1,4096})/g, ([, label, value]) => (MARKER_ONLY.test(value as string) ? null : `${label}[REDACTED:secret]`));
  // .pgpass: host:port:db:user:password (the host has a letter, a dot or is *; a MAC address has no such field)
  out = sub(out, /((?:^|[\s'"])(?=[\w.*-]{0,253}[A-Za-z.*])[\w.*-]{1,253}:(?:\d{1,5}|\*):[\w.*-]{1,128}:[\w.*-]{1,128}:)([^\s'":]{1,4096})/gm, ([, label, value]) =>
    (MARKER_ONLY.test(value as string) ? null : `${label}[REDACTED:secret]`));
  // prose: "the db password is X" (a plain word after "is" is not a secret: "the password is required")
  out = sub(out, /(\b(?:password|passphrase|passwd|secret|api key|token)[ \t]+(?:is|was|=)[ \t]+)([^\s,;.]{1,4096})/gi, ([, label, value]) =>
    (redactValue("weak", value as string) && !/^(?:the|a|an|not|now|still|set|stored|in|on|at)$/i.test(value as string) ? `${label}[REDACTED:secret]` : null));
  return out;
}

// ---- random-looking tokens --------------------------------------------------------------------------------------------

/**
 * A random-looking token (an API key without a known prefix, a base64 secret): long, three character classes, and
 * few word-like runs. Not: UUIDs, git / sha256 hashes, paths, ref names and versions (split on / . _ - :), CamelCase or
 * dotted identifiers (SecretManagerV2AdapterV3Tests, this.local.enablePending), issue keys, numbers.
 */
export function looksRandom(tok: string): boolean {
  if (tok.length < 20 || MARKER_RE.test(tok) || UUID_RE.test(tok)) return false;
  if (/^[0-9a-f]+$/i.test(tok)) return hexSecret(tok);
  // One segment at a time (a ref name, a version, a dotted identifier is made of ordinary segments).
  const segments = tok.split(/[/._:\-]+/).filter(Boolean);
  return segments.some(randomSegment);
}

/** Hex of 32+ digits and letters, not a git (40) or sha256 (64) hash, not one repeated character. */
function hexSecret(h: string): boolean {
  return h.length >= 32 && h.length !== 40 && h.length !== 64 && /[a-f]/i.test(h) && /[0-9]/.test(h) && new Set(h.toLowerCase()).size >= 8;
}

function randomSegment(seg: string): boolean {
  if (seg.length < 20) return false;
  if (/^[0-9a-f]+$/i.test(seg)) return hexSecret(seg);
  const hasLower = /[a-z]/.test(seg), hasUpper = /[A-Z]/.test(seg), hasDigit = /[0-9]/.test(seg), hasOther = /[+=]/.test(seg);
  if ([hasLower, hasUpper, hasDigit, hasOther].filter(Boolean).length < 3) return false;
  // Word-likeness: the share of characters in runs that read like a word (Capitalised or lowercase, 3+ letters).
  const words = seg.match(/[A-Z]?[a-z]{3,}|[A-Z]{2,}(?![a-z])/g) ?? [];
  const wordish = words.reduce((n, w) => n + w.length, 0) / seg.length;
  return wordish < 0.45;
}

/** Replaces random-looking tokens by a marker. Linear: one pass over maximal runs of token characters. */
export function redactRandomTokens(text: string): string {
  return text.replace(/[A-Za-z0-9+/=_\-.:]{20,}/g, (tok) => {
    if (/^[a-z][a-z0-9+.-]{0,20}:\/\//i.test(tok)) return tok; // a URL (its userinfo is handled by URL patterns)
    const core = tok.replace(/^[._:\-]+|[._:\-]+$/g, "");
    return looksRandom(core) ? tok.replace(core, "[REDACTED:high_entropy]") : tok;
  });
}
