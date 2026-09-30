import { Component, memo, useState, type ReactNode } from "react";
import { Check, Copy, Wrench } from "lucide-react";
import { RichMarkdown } from "../../lib/markdown-rich.tsx";
import type { RenderOpts } from "../../lib/markdown.tsx";
import type { ChatMessage } from "./model.ts";

function ToolLine({ tools }: { tools: readonly string[] }) {
  if (!tools.length) return null;
  const shown = tools.slice(-8);
  const more = tools.length - shown.length;
  return (
    <div className="orch-tools">
      <Wrench size={12} strokeWidth={1.75} aria-hidden="true" />
      <span className="orch-tools-label">Used</span>
      <span className="orch-tools-list mono">
        {shown.map((t, i) => (
          <span key={i} className="orch-tool">{t}</span>
        ))}
        {more > 0 && <span className="orch-tool orch-tool-more">+{more} more</span>}
      </span>
    </div>
  );
}

function CopyReply({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <button type="button" className="orch-action" onClick={copy} aria-label={copied ? "Copied" : "Copy reply"} title={copied ? "Copied" : "Copy"}>
      {copied ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
    </button>
  );
}

export const Message = memo(function Message({ msg, opts }: { msg: ChatMessage; opts: RenderOpts }) {
  if (msg.role === "user") {
    return (
      <div className={`orch-msg orch-user${msg.note ? " is-unsent" : ""}`}>
        <h3 className="sr-only">{msg.scheduled ? "Scheduled instruction:" : "You said:"}</h3>
        <div className="orch-bubble">{msg.text}</div>
        {msg.note && <p className="orch-note" role="note">{msg.note}</p>}
      </div>
    );
  }
  if (msg.role === "system") {
    return <div className="orch-msg orch-system" role="note">{msg.text}</div>;
  }
  return (
    <div className="orch-msg orch-assistant">
      <h3 className="sr-only">WalkieTalkie said:</h3>
      <ToolLine tools={msg.tools} />
      {msg.text && <RichMarkdown text={msg.text} opts={opts} />}
      <div className="orch-actions"><CopyReply text={msg.text} /></div>
    </div>
  );
});

/** A reply in progress: streamed text with a cursor on the host, else a "thinking" shimmer with the latest activity. */
export function Pending({ text, tools, activity, opts }: { text: string; tools: readonly string[]; activity: string; opts: RenderOpts }) {
  return (
    <div className="orch-msg orch-assistant is-pending" aria-busy="true">
      <ToolLine tools={tools} />
      {text ? (
        <div className="orch-stream">
          <RichMarkdown text={text} opts={opts} />
          <span className="orch-cursor" aria-hidden="true" />
        </div>
      ) : (
        <p className="orch-thinking" role="status">
          <span className="orch-shimmer">{activity}</span>
        </p>
      )}
    </div>
  );
}

interface BoundaryProps { text: string; children: ReactNode }
interface BoundaryState { failed: boolean; text: string }

/**
 * One message that fails to render shows its text plainly instead of taking the whole tab down (ORCH-FIX-2, Opus
 * MEDIUM 3: a reply the renderer chokes on crashed the conversation on every load). A new text (the next streamed
 * chunk) gets a fresh try.
 */
export class MessageBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false, text: this.props.text };

  static getDerivedStateFromError(): Partial<BoundaryState> { return { failed: true }; }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.text !== state.text ? { failed: false, text: props.text } : null;
  }

  override componentDidCatch(err: Error): void {
    console.warn("walkie: a message could not be rendered; showing it as plain text", err.message);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <div className="orch-msg orch-assistant orch-plain" role="note">{this.props.text}</div>;
  }
}
