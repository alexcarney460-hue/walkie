import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentView, OrchMessage } from "../src/api/types.ts";
import { RichMarkdown } from "../src/lib/markdown-rich.tsx";
import { initialState, reducer } from "../src/state/reducer.ts";
import { awaitingReply, conversations, localOrchestrator, modelLabel, threadMessages } from "../src/views/orchestrator/model.ts";

let seq = 0;
/** One message of the local conversation (ORCH-FIX-11: the tab's only source, this machine's own store). */
function msg(text: string, opts: Partial<OrchMessage> = {}): OrchMessage {
  seq += 1;
  const id = `om_${seq}`;
  return { id, thread: opts.thread ?? id, role: opts.role ?? "person", text, ts: opts.ts ?? 1_000 + seq, ...opts };
}

const html = (text: string) => renderToStaticMarkup(<RichMarkdown text={text} opts={{ me: "alex", channels: new Set() }} />);

describe("rich markdown is XSS-safe", () => {
  test("model output never becomes markup", () => {
    const out = html(`# Hi <img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n| a | <b>x</b> |\n|---|---|\n| <iframe> | y |\n\n\`\`\`html\n<script>alert(3)</script>\n\`\`\``);
    expect(out).not.toMatch(/<(img|script|iframe|b)[\s>]/);
    expect(out).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(out).toContain("&lt;script&gt;alert(3)&lt;/script&gt;");
  });

  test("only http(s) links; javascript:, data: and relative targets stay text", () => {
    for (const bad of ["[x](javascript:alert(1))", "[x](javascript:alert`1`)", "[x](data:text/html,hi)", "[x](/v1/team)", "[x](//evil.example)"]) {
      expect(html(bad)).not.toContain("<a ");
    }
    const ok = html('[docs](https://example.com/a"onmouseover="x)');
    expect(ok).toContain('rel="noopener noreferrer"');
    expect(ok).not.toContain('" onmouseover');
  });

  test("headings, lists, tables and fenced code render; an unclosed fence (still streaming) is code to the end", () => {
    const out = html("## Plan\n\n- one\n- **two**\n  - nested\n\n1. a\n2. b\n\n| k | v |\n|---|--:|\n| x | 1 |\n\n```ts\nconst a = 1;");
    expect(out).toContain('<h3 class="mdr-h mdr-h2">Plan</h3>');
    expect(out).toContain("<ul class=\"mdr-list\"><li>one</li><li><strong>two</strong><ul");
    expect(out).toContain("<ol class=\"mdr-list\">");
    expect(out).toContain('<td style="text-align:right">1</td>');
    expect(out).toContain('<span class="mdr-code-lang">ts</span>');
    expect(out).toContain("<code>const a = 1;</code>");
  });
});

describe("conversation model (the local conversation only)", () => {
  test("threads, roles, tools; an unsent message says why; the title is the person's first line", () => {
    const root = msg("Plan the release\nwith details", { state: "sent" });
    const reply = msg("Here is the plan", { role: "orchestrator", thread: root.id, tools: ["Bash bun test"] });
    const refused = msg("and then?", { thread: root.id, state: "refused" });
    const other = msg("another conversation");
    const all = [reply, other, root, refused];
    const msgs = threadMessages(all, root.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1]?.tools).toEqual(["Bash bun test"]);
    expect(msgs[2]?.note).toContain("Not sent");
    const convs = conversations(all);
    expect(convs).toHaveLength(2);
    expect(convs.find((c) => c.id === root.id)?.title).toBe("Plan the release");
  });

  test("a message waits for a reply only while it is the last one, fresh and not unsent", () => {
    const root = msg("hi", { ts: 10_000, state: "queued" });
    expect(awaitingReply(threadMessages([root], root.id), 11_000)?.id).toBe(root.id);
    expect(awaitingReply(threadMessages([root], root.id), 10_000 + 11 * 60_000)).toBeNull();
    const reply = msg("hello", { role: "orchestrator", thread: root.id, ts: 10_500 });
    expect(awaitingReply(threadMessages([root, reply], root.id), 11_000)).toBeNull();
    const dropped = msg("x", { ts: 12_000, state: "dropped" });
    expect(awaitingReply(threadMessages([dropped], dropped.id), 12_500)).toBeNull();
  });

  test("the local orchestrator: this machine's own status only, not another machine's or a stopped one", () => {
    const agent = (node: string, eff: string): AgentView => ({
      id: "x", handle: "alex", node, hostname: "mbp", agent: "orchestrator",
      status: { agent: "orchestrator", state: eff, started_at: 1 } as AgentView["status"],
      updated_at: 1, machine_online: eff !== "offline", effective_state: eff as AgentView["effective_state"],
    });
    expect(localOrchestrator([agent("me", "working")], "me")?.node).toBe("me");
    expect(localOrchestrator([agent("other", "working")], "me")).toBeNull();
    expect(localOrchestrator([agent("me", "offline")], "me")).toBeNull();
  });

  test("model label", () => {
    expect(modelLabel("claude-opus-5-5[1m]")).toBe("Claude · Opus 5.5");
    expect(modelLabel("claude-sonnet-4")).toBe("Claude · Sonnet 4");
    expect(modelLabel(undefined)).toBe("Claude");
  });
});

describe("reconnect (ORCH-FIX-13, Codex r13 MEDIUM 5)", () => {
  test("a resync replaces messages by id (a state change lands) and clears replies that were in progress", () => {
    let s = reducer(initialState, { type: "orch/live", live: { thread: "om_1", turn: "om_1", phase: "start" } });
    s = reducer(s, { type: "orch/messages", messages: [{ id: "om_1", thread: "om_1", role: "person", text: "hi", ts: 1, state: "queued" }] });
    expect(Object.keys(s.live)).toEqual(["om_1"]);
    s = reducer(s, { type: "orch/live-reset" });
    s = reducer(s, { type: "orch/messages", messages: [
      { id: "om_1", thread: "om_1", role: "person", text: "hi", ts: 1, state: "sent" },
      { id: "om_2", thread: "om_1", role: "orchestrator", text: "pong", ts: 2, reply_to: "om_1" },
    ] });
    expect(s.live).toEqual({});
    expect(s.orch.map((m) => [m.id, m.state])).toEqual([["om_1", "sent"], ["om_2", undefined]]);
  });
});
