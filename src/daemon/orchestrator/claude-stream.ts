// Claude Code's stream-json protocol (`claude -p --input-format stream-json --output-format stream-json --verbose
// --include-partial-messages`), reduced to what the orchestrator needs. Every line from the child is untrusted
// input: anything unexpected is ignored, never thrown.

/** What one stdout line means for the orchestrator. */
export type ClaudeSignal =
  | { kind: "init"; session: string; model?: string }
  /** Streamed text of the top-level assistant (subagents' text is not part of the reply). */
  | { kind: "delta"; text: string }
  /** A complete assistant message of the top-level conversation: its text blocks and tool calls. */
  | { kind: "assistant"; text: string; tools: Array<{ name: string; input: Record<string, unknown> }> }
  /** The turn ended. ok=false: an error or an interrupt (`subtype` says which). */
  | { kind: "result"; ok: boolean; subtype: string; text: string; session?: string }
  | { kind: "control"; requestId: string; ok: boolean };

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Translates one stdout line; null for lines the orchestrator ignores (hooks, status, rate limits, bad JSON). */
export function parseClaudeLine(line: string): ClaudeSignal | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  let m: Record<string, unknown> | null;
  try { m = obj(JSON.parse(trimmed)); } catch { return null; }
  if (!m) return null;
  const topLevel = m.parent_tool_use_id === null || m.parent_tool_use_id === undefined;
  switch (m.type) {
    case "system": {
      if (m.subtype !== "init") return null;
      const session = str(m.session_id);
      return session ? { kind: "init", session, ...(str(m.model) ? { model: str(m.model) } : {}) } : null;
    }
    case "stream_event": {
      if (!topLevel) return null;
      const ev = obj(m.event);
      const delta = obj(ev?.delta);
      if (ev?.type !== "content_block_delta" || delta?.type !== "text_delta") return null;
      const text = str(delta.text);
      return text ? { kind: "delta", text } : null;
    }
    case "assistant": {
      if (!topLevel) return null;
      const content = obj(m.message)?.content;
      if (!Array.isArray(content)) return null;
      const texts: string[] = [];
      const tools: Array<{ name: string; input: Record<string, unknown> }> = [];
      for (const block of content) {
        const b = obj(block);
        if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
        if (b?.type === "tool_use" && typeof b.name === "string") tools.push({ name: b.name, input: obj(b.input) ?? {} });
      }
      return { kind: "assistant", text: texts.join(""), tools };
    }
    case "result": {
      const subtype = str(m.subtype) ?? "unknown";
      const ok = subtype === "success" && m.is_error !== true;
      return { kind: "result", ok, subtype, text: str(m.result) ?? "", ...(str(m.session_id) ? { session: str(m.session_id) } : {}) };
    }
    case "control_response": {
      const r = obj(m.response);
      const requestId = str(r?.request_id);
      return requestId ? { kind: "control", requestId, ok: r?.subtype === "success" } : null;
    }
    default:
      return null;
  }
}

/** A user turn for the child's stdin. */
export function userMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/** Interrupts the turn in progress (the child answers with a control_response, then a non-success result). */
export function interruptRequest(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } }) + "\n";
}
