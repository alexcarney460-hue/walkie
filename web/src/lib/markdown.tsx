import { Fragment, type ReactNode } from "react";

// Markdown-lite: fenced code, inline code, **bold**, http(s) links, @addresses
// and #channels. Output is React elements only; text is never parsed as HTML.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(@[a-z][a-z0-9-]{0,23}(?:\/[a-z0-9][a-z0-9.-]{0,62}(?:\/[a-z0-9][a-z0-9._-]{0,47})?)?)|((?:^|(?<=\s))#[a-z0-9][a-z0-9_-]{0,39})/g;

export interface RenderOpts {
  me?: string | null;
  onChannel?: (name: string) => void;
  /** Known channel names; "#318" only becomes a channel link when the channel exists. */
  channels?: ReadonlySet<string>;
}

export function inline(text: string, keyBase: string, opts: RenderOpts): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const [token] = m;
    const key = `${keyBase}-${i++}`;
    if (m[1]) {
      out.push(<code key={key} className="md-code">{token.slice(1, -1)}</code>);
    } else if (m[2]) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (m[3]) {
      out.push(<a key={key} className="md-link" href={token} target="_blank" rel="noopener noreferrer">{token.replace(/^https?:\/\//, "")}</a>);
    } else if (m[4]) {
      const mine = !!opts.me && (token === `@${opts.me}` || token.startsWith(`@${opts.me}/`));
      out.push(<span key={key} className={mine ? "md-mention md-mention-me" : "md-mention"}>{token}</span>);
    } else if (m[5]) {
      const name = token.slice(1);
      if (!opts.channels?.has(name)) {
        out.push(token);
        last = start + token.length;
        continue;
      }
      out.push(
        opts.onChannel
          ? <button key={key} type="button" className="md-channel" onClick={() => opts.onChannel?.(name)}>{token}</button>
          : <span key={key} className="md-channel">{token}</span>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, opts = {} }: { text: string; opts?: RenderOpts }): ReactNode {
  const blocks: ReactNode[] = [];
  const fence = /```([a-z0-9+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let n = 0;
  const pushProse = (chunk: string) => {
    const trimmed = chunk.replace(/^\n+|\n+$/g, "");
    if (!trimmed) return;
    trimmed.split(/\n{2,}/).forEach((para) => {
      const key = `p${n++}`;
      const lines = para.split("\n");
      blocks.push(
        <p key={key} className="md-p">
          {lines.map((line, li) => (
            <Fragment key={li}>
              {li > 0 && <br />}
              {inline(line, `${key}-${li}`, opts)}
            </Fragment>
          ))}
        </p>,
      );
    });
  };
  for (const m of text.matchAll(fence)) {
    const start = m.index ?? 0;
    pushProse(text.slice(last, start));
    const code = (m[2] ?? "").replace(/\n$/, "");
    blocks.push(
      <pre key={`c${n++}`} className="md-pre" data-lang={m[1] || undefined}>
        <code>{code}</code>
      </pre>,
    );
    last = start + m[0].length;
  }
  pushProse(text.slice(last));
  return <div className="md">{blocks}</div>;
}

/** Plain one-line preview for tickers and palette rows. */
export function plainPreview(text: string, max = 140): string {
  const flat = text.replace(/```[\s\S]*?```/g, "[code]").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
