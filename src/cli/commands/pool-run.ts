// walkie pool share | run | stop | status | install (WALKIE-POOL-2): split a model across the team's machines.
// People only: under an agent runtime these refuse (the daemon also refuses an X-Walkie-Agent header).
import { homedir } from "node:os";
import { join } from "node:path";
import { adminCtx, auditLocal } from "../admin-gate.ts";
import { UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c, safeTerm } from "../format.ts";
import type { RunView } from "../../pool/run/runner.ts";
import type { PoolLocalView } from "../../pool/run/service.ts";
import { SHARE_WARNING } from "../../pool/format.ts";
import { TURN_SEATS_OFF } from "../../protocol/seats.ts";
import { installRuntime, LLAMA_BUILD, manualInstall, targetFor } from "../../pool/run/runtime.ts";
import { walkieHome } from "../../client/index.ts";

const GiB = 1024 ** 3;
const gbText = (b: number): string => `${Math.round((b / GiB) * 10) / 10} GB`;

// AGENT-ADMIN-1: sharing, runs and the runtime are admin: the person, or an agent of theirs (admin-gate.ts adminCtx).

export function runLines(r: RunView): string[] {
  const out = [`${c.bold(`Split run: ${r.model.name}${r.model.quant ? ` · ${r.model.quant === "q8" ? "8-bit" : "4-bit"}` : ""}`)} · ${stateText(r)}`];
  if (r.download && r.state === "downloading") out.push(`  downloading ${gbText(r.download.done)} of ${gbText(r.download.total)}`);
  for (const s of r.stages) out.push(`  ${c.gray("·")} ${safeTerm(s.hostname)}${s.self ? " (this machine, llama-server)" : ""} · ${gbText(s.bytes)} · ${s.state}`);
  if (r.error) out.push(`  ${c.red(safeTerm(r.error))}`);
  if (r.endpoint) {
    out.push(`  OpenAI-compatible endpoint on this machine only: ${r.endpoint} (API key in ${r.api_key_file})`);
    if (r.example) out.push(`  ${c.dim(r.example)}`);
  }
  if (r.tokens_per_s !== null) out.push(`  measured: ${r.tokens_per_s} tokens/s`);
  return out;
}

function stateText(r: RunView): string {
  const col = r.state === "serving" ? c.green : r.state === "failed" ? c.red : r.state === "stopped" ? c.dim : c.yellow;
  return col(r.state);
}

function shareLines(v: PoolLocalView): string[] {
  const out = [
    `Sharing this machine for split runs: ${v.share.on ? c.green("on") : "off"}${v.share.on ? ` · up to ${v.share.max_bytes === null ? "whatever is free when a run starts" : gbText(v.share.max_bytes)}` : ""}`,
    `llama.cpp runtime: ${v.runtime.installed ? `installed (${v.runtime.build ?? "unknown build"}) in ${v.runtime.dir}` : c.yellow("not installed (walkie pool install)")}`,
  ];
  if (v.stage) out.push(`Serving a stage of @${safeTerm(v.stage.head_hostname)}'s run: ${safeTerm(v.stage.model)} · ${gbText(v.stage.bytes)} · ${v.stage.tunnels} connection(s)`);
  return out;
}

async function share(ctx: Ctx): Promise<number> {
  ctx = adminCtx(ctx, "share this machine for split runs");
  const which = ctx.args.pos[1];
  if (which !== "on" && which !== "off") throw new UsageError("usage: walkie pool share on|off [--max-gb N]");
  const raw = ctx.args.flags.get("max-gb");
  const maxGb = raw === undefined ? undefined : raw === "none" ? null : Number(raw);
  if (typeof maxGb === "number" && !(maxGb > 0)) throw new UsageError("--max-gb takes a number of GB (or none)");
  if (which === "on") {
    // Seats and compute sharing are never on together (the daemon refuses it too): say which to turn off first.
    const seats = await ctx.client().seats().then((r) => r.local, () => null);
    if (seats?.allow) { ctx.err(c.red(TURN_SEATS_OFF)); return EXIT.error; }
  }
  const v = await ctx.client().poolShare(which === "on", maxGb);
  if (ctx.json) ctx.out(JSON.stringify(v));
  else ctx.out([...shareLines(v), ...(which === "on" ? ["", c.yellow(SHARE_WARNING)] : [])].join("\n"));
  return EXIT.ok;
}

async function run(ctx: Ctx): Promise<number> {
  ctx = adminCtx(ctx, "start a split run");
  const model = ctx.args.pos[1];
  const file = ctx.args.flags.get("file");
  const quant = ctx.args.flags.get("quant");
  const machines = ctx.args.flags.get("machines");
  if (!model === (typeof file !== "string")) throw new UsageError("usage: walkie pool run <model-id> [--quant q4|q8] [--machines a,b] | walkie pool run --file <model.gguf> [--machines a,b]");
  if (quant !== undefined && quant !== "q4" && quant !== "q8") throw new UsageError("--quant is q4 or q8");
  const body = {
    ...(model ? { model } : {}), ...(typeof file === "string" ? { file: file.startsWith("/") ? file : join(process.cwd(), file) } : {}),
    ...(quant ? { quant: quant as "q4" | "q8" } : {}),
    ...(typeof machines === "string" ? { machines: machines.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
  };
  const client = ctx.client();
  let r = (await client.poolRun(body)).run;
  if (ctx.json) { ctx.out(JSON.stringify({ run: r })); return EXIT.ok; }
  let last = "";
  // Follows it until it serves or ends (Ctrl-C leaves it running; walkie pool status shows it, walkie pool stop ends it).
  for (;;) {
    const text = runLines(r).join("\n");
    const key = `${r.state}|${r.error}|${r.stages.map((s) => s.state).join(",")}|${r.download ? Math.floor(r.download.done / (256 * 1024 * 1024)) : ""}`;
    if (key !== last) { ctx.out(text); last = key; }
    if (r.state === "serving" || r.state === "failed" || r.state === "stopped") break;
    await Bun.sleep(1_000);
    r = (await client.pool()).run ?? r;
  }
  return r.state === "serving" ? EXIT.ok : EXIT.error;
}

async function stop(ctx: Ctx): Promise<number> {
  ctx = adminCtx(ctx, "stop a split run");
  const r = (await ctx.client().poolStop()).run;
  if (ctx.json) ctx.out(JSON.stringify({ run: r })); else ctx.out(r ? runLines(r).join("\n") : "No split run on this machine.");
  return EXIT.ok;
}

async function status(ctx: Ctx): Promise<number> {
  const v = await ctx.client().pool();
  if (ctx.json) { ctx.out(JSON.stringify(v)); return EXIT.ok; }
  ctx.out([...shareLines(v), ...(v.run ? ["", ...runLines(v.run)] : [])].join("\n"));
  return EXIT.ok;
}

async function install(ctx: Ctx): Promise<number> {
  ctx = adminCtx(ctx, "install the llama.cpp runtime");
  const nvidia = Bun.spawnSync(["sh", "-c", "command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L"], { stdout: "pipe", stderr: "ignore" }).exitCode === 0;
  const t = targetFor({ nvidia });
  if (!t) { ctx.err(`No pinned llama.cpp ${LLAMA_BUILD} build for ${process.platform}/${process.arch}.`); return EXIT.error; }
  const dir = typeof ctx.args.flags.get("dir") === "string" ? String(ctx.args.flags.get("dir")) : join(process.env.WALKIE_HOME ? walkieHome() : join(homedir(), ".walkie"), "pool", "llama");
  if (ctx.args.flags.get("dry-run") === true) {
    ctx.out(`Would install llama.cpp ${LLAMA_BUILD} for ${t.label} into ${dir} (sha256-checked):\n  ${manualInstall(t, dir)}`);
    return EXIT.ok;
  }
  await auditLocal(ctx, `installed llama.cpp ${LLAMA_BUILD} (${t.label}) into ${dir}`);
  ctx.out(`Installing llama.cpp ${LLAMA_BUILD} for ${t.label} into ${dir} (sha256-checked)…`);
  let shown = 0;
  const rt = await installRuntime(t, dir, (file, done, total) => {
    const pct = Math.floor((done / total) * 10);
    if (pct > shown) { shown = pct; ctx.err(`  ${file}: ${pct * 10}%`); }
  });
  ctx.out(`Installed: ${rt.server} and ${rt.rpc}. Nothing listens until a split run starts.`);
  return EXIT.ok;
}

/** `walkie pool <sub>`: share | run | stop | status | install; null = no subcommand (the suggestions). */
export function poolSub(ctx: Ctx): Promise<number> | null {
  switch (ctx.args.pos[0]) {
    case undefined: return null;
    case "share": return share(ctx);
    case "run": return run(ctx);
    case "stop": return stop(ctx);
    case "status": return status(ctx);
    case "install": return install(ctx);
    default: throw new UsageError("usage: walkie pool [share on|off | run <model> | stop | status | install]");
  }
}
