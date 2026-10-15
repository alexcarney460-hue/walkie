import { z } from "zod";
import { createHash } from "node:crypto";
import { personOnly } from "../admin/gate.ts";
import { recordAdmin } from "../admin/audit.ts";
import { loadConfig, saveChannelConfig, saveConfigField } from "../config.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, route, type RouteCtx } from "../local-routes.ts";
import { channelsFor } from "./manager.ts";
import type { ChannelId } from "./types.ts";
import { TALKIE_SHELL_HEADER } from "../orchestrator/os-user.ts";

export const CHANNEL_WARNING = "WhatsApp and Google limit automation and may block the number. Use a dedicated number for Talkie. You are responsible for linking it yourself.";
const WARNING_SHA256 = createHash("sha256").update(CHANNEL_WARNING).digest("hex");

function localPerson(c: RouteCtx): void {
  personOnly(c, "manage messaging channels");
  if (c.via === "phone") throw new HttpError(403, "person_only", "manage channels at this machine's dashboard or terminal");
  if (c.req.headers.get(TALKIE_SHELL_HEADER) === "1") throw new HttpError(403, "person_only", "Talkie shell cannot manage messaging channels");
  if (c.req.headers.has("x-walkie-admin-token")) throw new HttpError(403, "person_only", "remote admin cannot manage messaging channels");
}

function recordChange(c: RouteCtx, detail: string): void {
  recordAdmin(c.core, { actor: `@${c.core.myHandle()}/${c.core.hostname}`, action: `changed messaging channel settings: ${detail}`,
    machine: c.core.hostname, via: "local" }, { post: true, notify: c.core.myHandle() ?? undefined });
}

route("GET", "/v1/channels/status", async (c) => {
  localPerson(c);
  return json(await channelsFor(c.core).status());
});

route("GET", "/v1/channels/health", (c) => {
  localPerson(c);
  return json(channelsFor(c.core).health());
});

route("GET", "/v1/channels/config", (c) => {
  localPerson(c);
  const current = loadConfig(c.core.paths.config, false);
  return json({ enabled: current.channels_enabled, owner_number: current.channels_owner_number,
    warning: CHANNEL_WARNING, warning_sha256: WARNING_SHA256 });
});

const Config = z.object({ enabled: z.boolean().optional(), owner_number: z.string().regex(/^\+[1-9]\d{6,14}$/).nullable().optional(), acknowledge_risk: z.string().optional() }).strict();
route("POST", "/v1/channels/config", async (c) => {
  localPerson(c);
  const patch = parseWith(Config, await readJson(c.req, LOCAL_BODY_MAX));
  if ((patch.owner_number === undefined) === (patch.enabled === undefined))
    throw new HttpError(400, "invalid", "register a number or change enabled state in a separate request");
  if (patch.owner_number !== undefined) {
    if (patch.acknowledge_risk !== undefined) throw new HttpError(400, "invalid", "registration and enabling are separate requests");
    saveConfigField(c.core.paths.config, "channels_enabled", false);
    saveConfigField(c.core.paths.config, "channels_owner_number", patch.owner_number);
    recordChange(c, patch.owner_number ? "registered number; channels off" : "removed number; channels off");
  } else {
    if (patch.enabled && patch.acknowledge_risk !== WARNING_SHA256)
      throw new HttpError(400, "risk_not_acknowledged", "read GET /v1/channels/config and echo the sha256 of its exact warning text");
    if (!patch.enabled && patch.acknowledge_risk !== undefined) throw new HttpError(400, "invalid", "risk acknowledgement only applies to enabling");
    const current = loadConfig(c.core.paths.config, false);
    if (patch.enabled && !current.channels_owner_number) throw new HttpError(409, "missing_number", "register your number first");
    if (patch.enabled) {
      const manager = channelsFor(c.core);
      manager.gate.initializeQuota();
      saveChannelConfig(c.core.paths.config, true, current.channels_quota_initialized ?? new Date().toISOString());
    } else {
      saveChannelConfig(c.core.paths.config, false, current.channels_quota_initialized);
    }
    recordChange(c, patch.enabled ? "enabled" : "disabled");
  }
  return json(channelsFor(c.core).health());
});

const Link = z.object({ channel: z.enum(["whatsapp-web", "sms-gvoice"]) }).strict();
route("POST", "/v1/channels/link", async (c) => {
  localPerson(c);
  const { channel } = parseWith(Link, await readJson(c.req, LOCAL_BODY_MAX));
  await channelsFor(c.core).link(channel as ChannelId);
  recordChange(c, `linked ${channel}`);
  return json(channelsFor(c.core).health());
});

route("POST", "/v1/channels/reset-quota", (c) => {
  localPerson(c);
  const manager = channelsFor(c.core);
  if (!manager.gate.quotaDamaged) throw new HttpError(409, "quota_healthy", "quota record is not damaged");
  const backup = manager.resetQuota();
  const current = loadConfig(c.core.paths.config, false);
  if (!current.channels_quota_initialized)
    saveChannelConfig(c.core.paths.config, current.channels_enabled, new Date().toISOString());
  recordChange(c, backup ? "reset damaged channel quota; preserved old record" : "reset missing channel quota record");
  return json({ ...manager.health(), backup });
});
