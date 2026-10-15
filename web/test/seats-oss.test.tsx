import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OssReadiness } from "../src/views/seats/OssReadiness.tsx";
import { ossSnapshot } from "../../src/daemon/seats/oss.ts";
import type { SeatsLocalView } from "../src/api/types.ts";

test("rendered local readiness stays held and does not equate login/capability with inference", () => {
  const local = { allow: true, ephemeral: false, same_user: true, launchers: [], runtimes: ["codex"], running: 0,
    dir: "synthetic", channel_ok: true, claude_login: "unavailable", codex_login: "machine",
    codex_oss: ossSnapshot({ allow: true, same_user: true, codex_oss_ollama: true }) } as SeatsLocalView;
  const html = renderToStaticMarkup(<OssReadiness snapshot={local.codex_oss!} />);
  for (const text of ["Local Codex / Ollama", "consented", "UNVERIFIED", "held", "Runtime unknown", "configuration unknown", "service unknown", "model unknown", "resources unknown"])
    expect(html).toContain(text);
  expect(html).not.toContain("Local Codex ready");
});
