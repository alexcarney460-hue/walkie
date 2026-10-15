// WALK-151: browser contexts live on this daemon, shared across Talkie's MCP child processes.
import { z } from "zod";
import { join } from "node:path";
import { ORCHESTRATOR_AGENT } from "../../protocol/orchestrator.ts";
import { isSeatAgent, SEATS_AGENT } from "../../protocol/seats.ts";
import { getAskView } from "../asks.ts";
import { appendAudit } from "../admin/audit.ts";
import { personOnly } from "../admin/gate.ts";
import { loadConfig, saveConfigField } from "../config.ts";
import type { Core } from "../core.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import { hostFor } from "../orchestrator/host.ts";
import { BrowserManager, type BrowserResult } from "./service.ts";
import { BrowserQuota, seatMayBrowse } from "./policy.ts";
import { approvedBrowserAnswer } from "./approval.ts";
import { browserAuditLine } from "./audit.ts";
import { BrowserActionSchema, type BrowserAction } from "./schema.ts";

export const BROWSER_CONFIRM_PREFIX = "Talkie browser needs your confirmation:";

const managers = new WeakMap<Core, BrowserManager>();
const quotas = new WeakMap<Core, BrowserQuota>();
const locks = new WeakMap<Core, Map<string, Promise<void>>>();
async function inConversation<T>(core: Core, key: string, work: () => Promise<T>): Promise<T> {
  let map = locks.get(core);
  if (!map) { map = new Map(); locks.set(core, map); }
  const before = map.get(key);
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  map.set(key, done);
  await before;
  try { return await work(); }
  finally { release(); if (map.get(key) === done) map.delete(key); }
}
function manager(core: Core): BrowserManager {
  let found = managers.get(core);
  if (!found) {
    let quota = quotas.get(core);
    if (!quota) { quota = new BrowserQuota(join(core.paths.home, "browser", "quota.json")); quotas.set(core, quota); }
    found = new BrowserManager(core.paths.home, undefined, undefined, quota);
    managers.set(core, found);
  }
  return found;
}
export async function closeBrowser(core: Core): Promise<void> {
  const found = managers.get(core);
  managers.delete(core);
  await found?.close();
}

function machineConfig(core: Core) {
  try { return loadConfig(core.paths.config, false); }
  catch { throw new HttpError(403, "browser_off", "browser is off on this machine; a person repairs its configuration"); }
}
const config = (c: RouteCtx) => machineConfig(c.core);

function localPerson(c: RouteCtx, what: string): void {
  personOnly(c, what);
  if (c.via === "phone") throw new HttpError(403, "person_only", "browser settings and reviews are handled on this machine's dashboard or terminal");
}

function conversation(c: RouteCtx): string {
  if (c.via === "phone") throw new HttpError(403, "forbidden", "browser tools are local only");
  const settings = config(c);
  if (!settings.browser_enabled) throw new HttpError(403, "browser_off", "browser is off on this machine; a person runs walkie browser on");
  if (c.agent === ORCHESTRATOR_AGENT) {
    const thread = hostFor(c.core)?.browserThread(c.orchestratorToken);
    if (!thread) throw new HttpError(403, "forbidden", "browser use requires Talkie's active person conversation");
    return `talkie:${thread}`;
  }
  throw new HttpError(403, "forbidden", "browser tools on this socket are only for Talkie; seats use their own token-authenticated socket");
}

const Change = z.object({ enabled: z.boolean().optional(), allowed_agents: z.array(z.string().min(1).max(140)).max(64).optional(),
  denylist: z.array(z.string().regex(/^[a-z0-9.-]+$/).max(253)).max(100).optional() }).strict();

route("GET", "/v1/browser/config", (c) => {
  localPerson(c, "read browser settings");
  const v = config(c);
  return json({ enabled: v.browser_enabled, allowed_agents: v.browser_allowed_agents, denylist: v.browser_denylist });
});

route("POST", "/v1/browser/config", async (c) => {
  localPerson(c, "change browser settings");
  const b = parseWith(Change, await readJson(c.req, LOCAL_BODY_MAX));
  if (b.enabled !== undefined) saveConfigField(c.core.paths.config, "browser_enabled", b.enabled);
  if (b.allowed_agents) {
    if (b.allowed_agents.some((a) => a === SEATS_AGENT || !isSeatAgent(a))) throw new HttpError(400, "invalid", "only exact seat agent IDs may be allowed");
    saveConfigField(c.core.paths.config, "browser_allowed_agents", b.allowed_agents);
  }
  if (b.denylist) saveConfigField(c.core.paths.config, "browser_denylist", b.denylist);
  if (b.enabled === false || b.allowed_agents || b.denylist) await closeBrowser(c.core);
  const v = config(c);
  appendAudit(c.core, { actor: `@${c.core.myHandle()}/${c.core.hostname}`, action: "changed browser machine settings",
    machine: c.core.hostname, via: "local" });
  return json({ enabled: v.browser_enabled, allowed_agents: v.browser_allowed_agents, denylist: v.browser_denylist });
});

/** A plan confirmation creates one direct ask; retrying confirms the whole plan only after the person's exact answer. */
async function confirmation(core: Core, agent: string, key: string, result: BrowserResult): Promise<BrowserResult> {
  if (!result.needs_confirmation || !result.confirmation_id) return result;
  const id = result.confirmation_id;
  const pending = await manager(core).pending(key, id);
  if (!pending) throw new HttpError(409, "browser_stale", "browser confirmation expired; read the page again");
  if (pending.askId) {
    const view = getAskView(core, pending.askId);
    if (view.state === "answered") {
      if (approvedBrowserAnswer(view, id, core.nodeId, core.myHandle()))
        return manager(core).confirm(key, id, { enabled: true, denylist: machineConfig(core).browser_denylist });
      await manager(core).cancelPending(key, id);
      throw new HttpError(403, "browser_declined", "browser action was not confirmed by this machine's person");
    }
    if (view.state !== "open") {
      await manager(core).cancelPending(key, id);
      throw new HttpError(403, "browser_declined", "browser confirmation expired or was declined");
    }
    return { ...result, text: `${result.text}. Waiting for the person's answer to ask ${pending.askId}; retry the same action after they answer.` };
  }
  const to = `@${core.myHandle()}/${core.hostname}`;
  const ask = core.emit("ask", {
    to, text: `${BROWSER_CONFIRM_PREFIX} ${pending.summary}. Inspect the screenshot on this machine with walkie browser review ${id}. Answer exactly YES ${id.slice(0, 8)} to proceed, or decline.`,
    expires_at: Date.now() + 10 * 60_000,
  }, { agent });
  await manager(core).bindAsk(key, id, ask.id);
  return { ...result, text: `${result.text}. Ask ${ask.id} sent to your person; screenshot: walkie browser review ${id}. Retry this action after the person confirms.` };
}

async function runAction(core: Core, agent: string, key: string, b: BrowserAction): Promise<BrowserResult> {
  return inConversation(core, key, async () => {
    const browser = manager(core);
    const settings = { enabled: true, denylist: machineConfig(core).browser_denylist };
    let result: BrowserResult | undefined;
    let refused: string | undefined;
    try {
      const info = b.op === "open" ? undefined : await browser.auditInfo(key, b.ref);
      if (info) result = { text: "", ...info };
      if (b.op === "confirm_plan") {
        result = await browser.confirmPlan(key, settings);
        result = await confirmation(core, agent, key, result);
      } else if (b.op === "open") {
        if (!b.url) throw new HttpError(400, "invalid", "browser_open needs url");
        result = await browser.open(key, b.url, settings);
      } else if (b.op === "read") result = await browser.read(key, settings);
      else if (b.op === "screenshot") result = await browser.screenshot(key, settings);
      else {
        if (!b.ref) throw new HttpError(400, "invalid", `browser_${b.op} needs a ref from browser_read`);
        if (b.op === "type" && b.text === undefined) throw new HttpError(400, "invalid", "browser_type needs text");
        if (b.op === "select" && b.value === undefined) throw new HttpError(400, "invalid", "browser_select needs value");
        result = await browser.action(key, b.op, b.ref, b.op === "type" ? b.text : b.value, settings);
      }
      return result;
    } catch (err) { refused = b.op === "type" || b.op === "select" ? "action_failed"
      : err instanceof Error ? err.message.slice(0, 120) : "browser error"; throw err; }
    finally {
      appendAudit(core, { actor: `@${core.myHandle()}/${core.hostname}/${agent}`, action: browserAuditLine(b.op, result, b.url, await browser.auditTypedValues(key)),
        machine: core.hostname, via: "local", ...(refused ? { refused } : {}) });
    }
  });
}

/** The seat socket supplies the live seat identity from its token, never from an agent header. */
export function browserActionForSeat(core: Core, seat: string, b: BrowserAction): Promise<BrowserResult> {
  const v = machineConfig(core);
  if (!seatMayBrowse(v.browser_enabled, v.browser_allowed_agents, seat))
    throw new HttpError(403, "forbidden", "this machine's person has not allowed this seat to use the browser");
  return runAction(core, seat, `seat:${seat}`, b);
}

route("POST", "/v1/browser/action", async (c) => {
  requireTeam(c);
  const key = conversation(c);
  const b = parseWith(BrowserActionSchema, await readJson(c.req, LOCAL_BODY_MAX));
  return json(await runAction(c.core, c.agent as string, key, b));
});

route("GET", /^\/v1\/browser\/review\/([0-9a-f-]{36})$/, async (c, [id]) => {
  localPerson(c, "review a browser screenshot");
  const pending = await manager(c.core).review(id as string);
  if (!pending) throw new HttpError(404, "not_found", "browser review expired");
  return json(pending);
});
