import { UsageError } from "../args.ts";
import { EXIT, requirePerson, type Ctx } from "../context.ts";
import { underAgent } from "../agent-detect.ts";
import { WalkieError } from "../../client/index.ts";
import { createHash } from "node:crypto";

type Status = { enabled: boolean; ignored_unknown: number; whatsapp: string; gvoice: string; quota_damaged: boolean; notice: string | null };
type Config = { warning: string };
const WARNING = "WhatsApp and Google limit automation and may block the number. Use a dedicated number for Talkie. You are responsible for linking it yourself.";

function setupPerson(ctx: Ctx): void {
  if (underAgent() || (ctx.agentSignals?.().marker ?? ctx.agentMarker()))
    throw new WalkieError("person_only", "agents can't manage messaging channels", 403);
}

export async function channelsCmd(ctx: Ctx): Promise<number> {
  const [action = "status", value] = ctx.args.pos;
  const client = ctx.client();
  if (action === "status" && ctx.args.pos.length <= 1) {
    const result = await client.request<Status>("GET", "/v1/channels/status");
    ctx.out(ctx.json ? JSON.stringify(result) : `${result.notice ? `${result.notice}\n` : ""}channels ${result.enabled ? "on" : "off"}; WhatsApp ${result.whatsapp}; Google Voice ${result.gvoice}; ignored unknown numbers ${result.ignored_unknown}`);
    return EXIT.ok;
  }
  if (action === "reset-quota" && ctx.args.pos.length === 1) {
    setupPerson(ctx);
    const status = await client.request<Status>("GET", "/v1/channels/status");
    if (!status.quota_damaged) throw new UsageError("channel quota record is not damaged");
    await requirePerson(ctx, "reset the damaged channel quota and start fresh counters", "yes");
    const result = await client.request<{ backup: string | null }>("POST", "/v1/channels/reset-quota");
    ctx.out(result.backup ? `Channel quota reset. Damaged record kept at ${result.backup}` : "Channel quota reset. No damaged record remained to preserve.");
    return EXIT.ok;
  }
  if (action === "link" && (value === "whatsapp" || value === "gvoice") && ctx.args.pos.length === 2) {
    setupPerson(ctx);
    await requirePerson(ctx, `open ${value} so you can link it yourself`, "yes");
    await client.request("POST", "/v1/channels/link", { channel: value === "whatsapp" ? "whatsapp-web" : "sms-gvoice" }, 40_000);
    ctx.out(`Opened ${value} in a local Chromium window. Complete the QR scan or sign-in yourself, then run walkie channels status.`);
    return EXIT.ok;
  }
  if (action === "register" && value && ctx.args.pos.length === 2) {
    setupPerson(ctx);
    if (!/^\+[1-9]\d{6,14}$/.test(value)) throw new UsageError("register needs your phone number in +E.164 format");
    await requirePerson(ctx, `register ${value} as this machine owner's Talkie number`, "yes");
    await client.request("POST", "/v1/channels/config", { owner_number: value });
    ctx.out("Number registered locally; channels remain off until you enable them.");
    return EXIT.ok;
  }
  if ((action === "on" || action === "off") && ctx.args.pos.length === 1) {
    setupPerson(ctx);
    const config = action === "on" ? await client.request<Config>("GET", "/v1/channels/config") : null;
    if (config) ctx.err(config.warning);
    await requirePerson(ctx, action === "on" ? "enable automated web messaging after reading the warning" : "turn off automated web messaging", "yes");
    await client.request("POST", "/v1/channels/config", { enabled: action === "on", ...(config ? { acknowledge_risk: createHash("sha256").update(config.warning).digest("hex") } : {}) });
    ctx.out(`channels ${action}`);
    return EXIT.ok;
  }
  throw new UsageError("channels status|link whatsapp|gvoice|register <your +number>|on|off|reset-quota. " + WARNING);
}
