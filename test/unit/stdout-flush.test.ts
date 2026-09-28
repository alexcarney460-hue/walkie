// WALKIE-MISSION-1: `walkie who --json | …` lost everything after 64 KB, because the CLI exits (process.exit) before
// Bun's asynchronous pipe write finished. The CLI now writes through a blocking writer; this pipes more than 1 MB of
// JSON from a child that writes it the way every CLI command does (ctx.out, then process.exit) into a second child
// that parses it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = mkdtempSync("/tmp/walkie-stdout-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CONTEXT = join(import.meta.dir, "../../src/cli/context.ts");
const STDIO = join(import.meta.dir, "../../src/cli/stdio.ts");

describe("CLI stdout is complete when piped", () => {
  test("a >1 MB --json output survives process.exit and parses in the reading process", async () => {
    const writer = join(dir, "writer.ts");
    writeFileSync(writer, `
      import { makeCtx } from ${JSON.stringify(CONTEXT)};
      const agents = Array.from({ length: 6000 }, (_, i) => ({ id: "alex/host/agent-" + i, title: "x".repeat(180), n: i }));
      const ctx = makeCtx({ pos: [], flags: new Map([["json", true]]) } as never);
      ctx.out(JSON.stringify({ agents }));
      process.exit(0);
    `);
    const reader = join(dir, "reader.ts");
    // A slow reader: the pipe fills while the writer is already trying to exit.
    writeFileSync(reader, `
      await Bun.sleep(300);
      const text = await new Response(Bun.stdin.stream()).text();
      const parsed = JSON.parse(text);
      process.stdout.write(JSON.stringify({ bytes: Buffer.byteLength(text), count: parsed.agents.length, last: parsed.agents.at(-1).n }));
    `);
    const w = Bun.spawn([process.execPath, writer], { stdout: "pipe", stderr: "pipe" });
    const r = Bun.spawn([process.execPath, reader], { stdin: w.stdout, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited]);
    expect(await w.exited).toBe(0);
    expect(err).toBe("");
    expect(code).toBe(0);
    const res = JSON.parse(out) as { bytes: number; count: number; last: number };
    expect(res.bytes).toBeGreaterThan(1024 * 1024);
    expect(res.count).toBe(6000);
    expect(res.last).toBe(5999);
  });

  test("a reader that closes early ends the writer quietly (EPIPE), not with a crash", async () => {
    const writer = join(dir, "epipe.ts");
    writeFileSync(writer, `
      import { writeOut } from ${JSON.stringify(STDIO)};
      for (let i = 0; i < 50; i++) writeOut("y".repeat(100_000) + "\\n");
      process.exit(0);
    `);
    const p = Bun.spawn(["sh", "-c", `"${process.execPath}" "${writer}" | head -c 10 >/dev/null`], { stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    expect(code).toBe(0);
    expect(err).toBe("");
  });
});
