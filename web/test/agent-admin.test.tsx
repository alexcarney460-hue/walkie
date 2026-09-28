import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentAdminSwitches } from "../src/views/seats/AgentAdminCard.tsx";

const view = (agent_admin: boolean, remote_admin: boolean) => ({
  agent_admin, remote_admin, machine: "kiras-mbp",
  audit: [{ ts: Date.now() - 60_000, actor: "@alex/alex-mbp/cc-3f9a21", action: "ran `walkie seats doctor` (exit 0)", machine: "kiras-mbp", via: "remote" }],
});

test("AGENT-ADMIN-1: the dashboard toggle shows both switches, on, with the audit line", () => {
  const html = renderToStaticMarkup(<AgentAdminSwitches view={view(true, true)} busy={false} error={null} onToggle={() => undefined} />);
  expect(html).toContain("Agents set up Walkie here");
  expect(html).toContain("Owners set up Walkie here remotely");
  expect((html.match(/role="switch"/g) ?? []).length).toBe(2);
  expect((html.match(/aria-checked="true"/g) ?? []).length).toBe(2);
  expect(html).toContain("@alex/alex-mbp/cc-3f9a21");
  expect(html).toContain("kiras-mbp");
});

test("off reads as off, and says only the person turns it back on", () => {
  const html = renderToStaticMarkup(<AgentAdminSwitches view={view(false, false)} busy={false} error="nope" onToggle={() => undefined} />);
  expect((html.match(/aria-checked="false"/g) ?? []).length).toBe(2);
  expect(html).toContain("Only you can turn this back on");
  expect(html).toContain('role="alert"');
});
