import { Fragment, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { inline, type RenderOpts } from "./markdown.tsx";

// Full Markdown for orchestrator replies: headings, lists (nested), block quotes, tables, rules, fenced code with
// a copy button, **bold**, *italic*, `code`, [links](https://…). Same safety as markdown.tsx: output is React
// elements only, text is never parsed as HTML, and only http(s) URLs become links. An unclosed fence (a reply
// still streaming) renders as code to the end.

const LINK_OK = /^https?:\/\//i;
// Link text excludes `[`: otherwise every `[` of a run of them rescans up to 300 characters (a 30 000-character
// line of `[` took ~200 ms per render).
const RICH_INLINE = /(`[^`\n]+`)|\[([^[\]\n]{1,300})\]\(([^()\s]{1,2000})\)|(\*\*[^*\n]+\*\*)|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)_(?![\w_])/g;

function richInline(text: string, key: string, opts: RenderOpts): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(RICH_INLINE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(...inline(text.slice(last, start), `${key}-t${i}`, opts));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k} className="md-code">{m[1].slice(1, -1)}</code>);
    else if (m[2] !== undefined && m[3] !== undefined) {
      out.push(LINK_OK.test(m[3])
        ? <a key={k} className="md-link" href={m[3]} target="_blank" rel="noopener noreferrer">{m[2]}</a>
        : <Fragment key={k}>{m[2]}</Fragment>);
    } else if (m[4]) out.push(<strong key={k}>{inline(m[4].slice(2, -2), k, opts)}</strong>);
    else if (m[5] !== undefined) out.push(<em key={k}>{m[5]}</em>);
    else if (m[6] !== undefined) out.push(<em key={k}>{m[6]}</em>);
    last = start + m[0].length;
  }
  if (last < text.length) out.push(...inline(text.slice(last), `${key}-t${i}`, opts));
  return out;
}

function Lines({ lines, k, opts }: { lines: string[]; k: string; opts: RenderOpts }) {
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {richInline(line, `${k}-${i}`, opts)}
        </Fragment>
      ))}
    </>
  );
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    } catch {
      /* clipboard blocked: the code is still selectable */
    }
  };
  return (
    <div className="mdr-code">
      <div className="mdr-code-bar">
        <span className="mdr-code-lang">{lang || "code"}</span>
        <button type="button" className="mdr-copy" onClick={copy} aria-label={copied ? "Copied" : "Copy code"}>
          {copied ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="mdr-pre"><code>{code}</code></pre>
    </div>
  );
}

// Every block pattern runs on each line of model output as it streams, so none may backtrack super-linearly (Opus
// MEDIUM 4: the old HEADING `\s+(.*?)\s*#*\s*$` was cubic on "# a" + spaces + "b"). The rule: no two adjacent
// quantifiers that can match the same character; trailing whitespace and closing sequences are trimmed in code.
// ORCH-FIX-2 (Codex MEDIUM 3 / Opus MEDIUM 2): a pattern never ends in `(.*)$` either. `.` stops at U+2028/U+2029,
// so "#" + 30 000 spaces + U+2028 made `[ \t]+(.*)$` retry every split (~2 s): the rest of the line is taken with
// slice(), and lines are split on every JavaScript line terminator (LINE_BREAK) as well.
const LINE_BREAK = /\r\n|\r|\n|\u2028|\u2029/;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_INFO = /^[\w+#.-]*$/;
const HEADING_OPEN = /^\s{0,3}(#{1,6})[ \t]/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+/;
/** Block quotes nest at most this deep; deeper `>` markers are text (">".repeat(3000) overflowed the stack). */
const MAX_QUOTE_DEPTH = 8;

/** An ITEM match with the item's text (the rest of the line after its marker). */
function itemOf(line: string): { indent: string; marker: string; text: string } | null {
  const m = ITEM.exec(line);
  return m ? { indent: m[1] ?? "", marker: m[2] ?? "", text: line.slice(m[0].length) } : null;
}

/** The text of a block quote line after its `>` marker, or null. */
function quoteOf(line: string): string | null {
  const m = QUOTE.exec(line);
  return m ? line.slice(m[0].length) : null;
}
const TABLE_SEP = /^[ \t]*(?:\|[ \t]*)?:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*(?:\|[ \t]*)?$/;

/** An opening (or closing) code fence: its marker and info string (a language name, or nothing). */
function fenceOf(line: string): { marker: string; lang: string } | null {
  const m = FENCE_OPEN.exec(line);
  if (!m) return null;
  const lang = line.slice(m[0].length).trim();
  return FENCE_INFO.test(lang) ? { marker: m[1] as string, lang } : null;
}

/** An ATX heading: level and text, without the optional closing `#` sequence (which must follow a space). */
function headingOf(line: string): { level: number; text: string } | null {
  const m = HEADING_OPEN.exec(line);
  if (!m) return null;
  let text = line.slice(m[0].length).replace(/^[ \t]+/, "").trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  if (end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t")) text = text.slice(0, end).trimEnd();
  return { level: (m[1] as string).length, text };
}

function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isBlockStart(line: string, next: string | undefined, quotes: boolean): boolean {
  return !!fenceOf(line) || !!headingOf(line) || RULE.test(line) || (quotes && QUOTE.test(line)) || ITEM.test(line)
    || (line.includes("|") && next !== undefined && TABLE_SEP.test(next));
}

interface ListNode { text: string[]; lists: SubList[] }
interface SubList { items: ListNode[]; ordered: boolean }

/** Parses list lines starting at `i` (items at indent `base`); returns the items and the next line index. */
function parseList(lines: string[], start: number, base: number): { items: ListNode[]; ordered: boolean; startNum: number; next: number } {
  const items: ListNode[] = [];
  const first = itemOf(lines[start] ?? "");
  const ordered = !!first && /\d/.test(first.marker);
  const startNum = ordered ? parseInt(first?.marker ?? "1", 10) : 1;
  // An item of the other kind (bullet vs number) at this indent starts a new list.
  const sameKind = (m: { marker: string }) => /\d/.test(m.marker) === ordered;
  let i = start;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const nextLine = lines[i + 1];
      const nm = nextLine !== undefined ? itemOf(nextLine) : null;
      const nIndent = nm ? nm.indent.length : -1;
      if (nm && (nIndent > base || (nIndent === base && sameKind(nm)))) { i++; continue; }
      break;
    }
    const m = itemOf(line);
    const indent = m ? m.indent.length : line.length - line.trimStart().length;
    if (m && indent === base && !sameKind(m)) break;
    if (m && indent === base) {
      items.push({ text: [m.text], lists: [] });
      i++;
    } else if (m && indent > base && items.length) {
      const sub = parseList(lines, i, indent);
      (items[items.length - 1] as ListNode).lists.push({ items: sub.items, ordered: sub.ordered });
      i = sub.next;
    } else if (!m && indent > base && items.length) {
      (items[items.length - 1] as ListNode).text.push(line.trim());
      i++;
    } else {
      break;
    }
  }
  return { items, ordered, startNum, next: i };
}

function ListView({ items, ordered, startNum, k, opts }: { items: ListNode[]; ordered: boolean; startNum?: number; k: string; opts: RenderOpts }) {
  const body = items.map((it, i) => (
    <li key={i}>
      {it.text.length > 0 && <Lines lines={it.text} k={`${k}-${i}`} opts={opts} />}
      {it.lists.map((sub, j) => <ListView key={j} items={sub.items} ordered={sub.ordered} k={`${k}-${i}-${j}`} opts={opts} />)}
    </li>
  ));
  return ordered
    ? <ol className="mdr-list" start={startNum && startNum !== 1 ? startNum : undefined}>{body}</ol>
    : <ul className="mdr-list">{body}</ul>;
}

/** `depth` = block quotes around this text; at MAX_QUOTE_DEPTH a `>` line is plain text (no deeper recursion). */
function blocks(text: string, opts: RenderOpts, keyBase: string, depth = 0): ReactNode[] {
  const lines = text.split(LINE_BREAK);
  const quotes = depth < MAX_QUOTE_DEPTH;
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `${keyBase}${n++}`;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.trim()) { i++; continue; }
    const fence = fenceOf(line);
    if (fence) {
      const marker = fence.marker;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(marker)) body.push(lines[i++] as string);
      i++; // the closing fence (or past the end while streaming)
      out.push(<CodeBlock key={key()} code={body.join("\n")} lang={fence.lang || undefined} />);
      continue;
    }
    const h = headingOf(line);
    if (h) {
      const level = Math.min(6, h.level);
      const Tag = `h${Math.min(6, level + 1)}` as "h2";
      out.push(<Tag key={key()} className={`mdr-h mdr-h${level}`}>{richInline(h.text, `h${n}`, opts)}</Tag>);
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push(<hr key={key()} className="mdr-hr" />); i++; continue; }
    if (quotes && QUOTE.test(line)) {
      const inner: string[] = [];
      for (let q = quoteOf(lines[i] as string); q !== null && i < lines.length; q = quoteOf(lines[++i] ?? "")) inner.push(q);
      const k = key();
      out.push(<blockquote key={k} className="mdr-quote">{blocks(inner.join("\n"), opts, `${k}q`, depth + 1)}</blockquote>);
      continue;
    }
    if (line.includes("|") && lines[i + 1] !== undefined && TABLE_SEP.test(lines[i + 1] as string)) {
      const head = cells(line);
      const align = cells(lines[i + 1] as string).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : undefined));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] as string).includes("|") && (lines[i] as string).trim()) rows.push(cells(lines[i++] as string));
      const k = key();
      out.push(
        <div key={k} className="mdr-table-wrap" tabIndex={0} role="region" aria-label="Table">
          <table className="mdr-table">
            <thead><tr>{head.map((c, j) => <th key={j} style={align[j] ? { textAlign: align[j] } : undefined}>{richInline(c, `${k}h${j}`, opts)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{head.map((_, j) => <td key={j} style={align[j] ? { textAlign: align[j] } : undefined}>{richInline(r[j] ?? "", `${k}r${ri}c${j}`, opts)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const item = itemOf(line);
    if (item) {
      const list = parseList(lines, i, item.indent.length);
      out.push(<ListView key={key()} items={list.items} ordered={list.ordered} startNum={list.startNum} k={`l${n}`} opts={opts} />);
      i = list.next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() && !(para.length && isBlockStart(lines[i] as string, lines[i + 1], quotes))) para.push(lines[i++] as string);
    const k = key();
    out.push(<p key={k} className="mdr-p"><Lines lines={para} k={k} opts={opts} /></p>);
  }
  return out;
}

export function RichMarkdown({ text, opts = {} }: { text: string; opts?: RenderOpts }): ReactNode {
  return <div className="mdr">{blocks(text, opts, "b")}</div>;
}
