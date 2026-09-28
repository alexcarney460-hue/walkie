// A stand-in llama-server for served-model tests (POOL-REAL-1): the OpenAI-compatible endpoints the proxy forwards,
// plus endpoints it must NOT reach (/slots with a "secret" prompt, /props). Requires llama-server's own API key
// (--api-key-file) on everything but /health, like llama-server. Writes its argv to $HOME/fake-llama-args.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--list-devices")) { console.log("Available devices:\n  CUDA0: Fake GPU (12227 MiB, 11656 MiB free)"); process.exit(0); }
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
writeFileSync(join(process.env.HOME ?? "/tmp", "fake-llama-args.json"), JSON.stringify(argv));
const key = readFileSync(arg("--api-key-file")!, "utf8").trim();
const alias = arg("--alias") ?? "fake";
let generated = 0;

const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Bun.serve({
  hostname: arg("--host") ?? "127.0.0.1",
  port: Number(arg("--port")),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ status: "ok" });
    if (req.headers.get("authorization") !== `Bearer ${key}`) return json({ error: { message: "Invalid API Key" } }, 401);
    if (url.pathname === "/slots") return json([{ id: 0, prompt: "SECRET PROMPT OF ANOTHER CLIENT" }]);
    if (url.pathname === "/props") return json({ secret: true });
    if (url.pathname === "/metrics") return new Response(`llamacpp:predicted_tokens_seconds ${generated ? 42.5 : 0}\n`);
    if (url.pathname === "/v1/models") return json({ object: "list", data: [{ id: alias, object: "model" }] });
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = await req.json() as { messages: { content: string }[]; stream?: boolean; max_tokens?: number };
      const words = ["Hello", " from", " the", " served", " model", "."];
      generated += words.length;
      const echo = body.messages.at(-1)?.content ?? "";
      if (!body.stream) {
        return json({ object: "chat.completion", model: alias, choices: [{ index: 0, message: { role: "assistant", content: `${words.join("")} You said: ${echo}` }, finish_reason: "stop" }], timings: { predicted_n: words.length, predicted_per_second: 42.5 } });
      }
      const enc = new TextEncoder();
      return new Response(new ReadableStream({
        async start(ctl) {
          for (const w of words) {
            ctl.enqueue(enc.encode(`data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: w } }] })}\n\n`));
            await Bun.sleep(20);
          }
          ctl.enqueue(enc.encode("data: [DONE]\n\n"));
          ctl.close();
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    return json({ error: { message: "not found" } }, 404);
  },
});
