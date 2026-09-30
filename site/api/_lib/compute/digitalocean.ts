// DigitalOcean driver (docs/plans/RENT-1.md §3A: its TOS §4.4 allows resale). Droplets API v2 over HTTPS with a
// bearer token held only by the control plane (env DIGITALOCEAN_TOKEN; least privilege: droplet create/read/delete and
// tag create/read — see SECURITY.md). Nothing here runs unless that token is set.
//
// Provider-specific choices, all behind the neutral CloudDriver interface:
// - Tags: DigitalOcean tags are plain strings (letters, digits, ':', '-', '_'), so "walkie:rental" = r_x becomes the tag
//   "walkie-rental:r_x" and "walkie:managed" becomes "walkie-managed" (the Cloud Firewall targets that tag).
// - Idempotency: the API has no client token, so every create carries "walkie-launch:<key>" and a create first looks
//   the key up (a retry after a lost answer finds the droplet instead of making a second one).
// - No SSH keys and no droplet agent: nobody, including us, can log in or open a web console on a rented machine.
import { CapacityError, DriverError, TAG_MANAGED, TAG_PAID_UNTIL, type CloudDriver, type Instance, type InstanceState, type ProvisionReq } from "./driver.js";

export const DO_API = "https://api.digitalocean.com/v2";
const MANAGED_TAG = "walkie-managed";
const LAUNCH_TAG = "walkie-launch";
const TAG_OK = /^[A-Za-z0-9:_-]{1,255}$/;
const MAX_PAGES = 50;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Neutral tag map → DigitalOcean tag strings. */
export function doTags(tags: Readonly<Record<string, string>>): string[] {
  const out = Object.entries(tags).map(([k, v]) => (k === TAG_MANAGED ? MANAGED_TAG :
    k === TAG_PAID_UNTIL ? `wk-paid-until-${v}` : `${k.replace(":", "-")}:${v}`));
  if (!out.every((t) => TAG_OK.test(t))) throw new DriverError("tag not representable", false);
  return out;
}

/** DigitalOcean tag strings → neutral tag map (only ours). */
export function fromDoTags(tags: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags) {
    if (t === MANAGED_TAG) out[TAG_MANAGED] = "1";
    else if (t.startsWith('wk-paid-until-')) out[TAG_PAID_UNTIL] = t.slice('wk-paid-until-'.length);
    else if (t.startsWith("walkie-") && t.includes(":")) {
      const i = t.indexOf(":");
      out[t.slice(0, i).replace("-", ":")] = t.slice(i + 1);
    }
  }
  return out;
}

function stateOf(status: unknown): InstanceState {
  return status === "active" ? "running" : status === "new" ? "pending" : status === "off" ? "stopping" : "terminated";
}

interface DoDroplet { id: number; status?: string; tags?: string[] }

export class DigitalOceanDriver implements CloudDriver {
  readonly name = "digitalocean";

  constructor(private readonly token: string, private readonly fetchFn: Fetch = fetch, private readonly timeoutMs = 8_000) {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new DriverError("bad DigitalOcean token format", false);
  }

  private async call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; json: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${DO_API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DriverError(`DigitalOcean unreachable (${err instanceof Error ? err.name : "error"})`, true);
    }
    const text = res.status === 204 ? "" : await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { json = {}; }
    return { status: res.status, json };
  }

  private fail(status: number, json: Record<string, unknown>): never {
    const id = typeof json.id === "string" ? json.id : "error";
    const message = typeof json.message === "string" ? json.message.slice(0, 200) : "";
    // Droplet/GPU limits and sold-out sizes or regions: queue and retry, never fail the rental.
    if (status === 422 && /limit|not available|unavailable|capacity|insufficient/i.test(message)) throw new CapacityError(`DigitalOcean: ${message}`);
    throw new DriverError(`DigitalOcean ${status} ${id}`, status === 429 || status >= 500);
  }

  private async byTag(tag: string, signal?: AbortSignal): Promise<DoDroplet[]> {
    const out: DoDroplet[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await this.call("GET", `/droplets?tag_name=${encodeURIComponent(tag)}&per_page=200&page=${page}`, undefined, signal);
      if (r.status !== 200) this.fail(r.status, r.json);
      const droplets = Array.isArray(r.json.droplets) ? (r.json.droplets as DoDroplet[]) : [];
      out.push(...droplets);
      const next = (r.json.links as { pages?: { next?: unknown } } | undefined)?.pages?.next;
      if (!next || droplets.length === 0) return out;
    }
    return out;
  }

  async provision(req: ProvisionReq, signal?: AbortSignal): Promise<{ instance_id: string }> {
    if (!req.region || !req.image) throw new DriverError("DigitalOcean needs region and image in the private config", false);
    const launchTag = `${LAUNCH_TAG}:${req.idempotency_key}`;
    if (!TAG_OK.test(launchTag)) throw new DriverError("idempotency key not representable as a tag", false);
    const existing = await this.byTag(launchTag, signal);
    if (existing[0]) return { instance_id: String(existing[0].id) };
    const r = await this.call("POST", "/droplets", {
      name: req.name, region: req.region, size: req.instance_type, image: req.image,
      user_data: req.user_data, tags: [...doTags(req.tags), launchTag],
      ssh_keys: [], backups: false, ipv6: true, monitoring: false, with_droplet_agent: false,
    }, signal);
    if (r.status !== 202 && r.status !== 201) this.fail(r.status, r.json);
    const id = (r.json.droplet as { id?: unknown } | undefined)?.id;
    if (typeof id !== "number") throw new DriverError("DigitalOcean answered without a droplet id", true);
    return { instance_id: String(id) };
  }

  async terminate(instanceId: string, signal?: AbortSignal): Promise<void> {
    if (!/^[0-9]{1,20}$/.test(instanceId)) throw new DriverError("bad droplet id", false);
    const r = await this.call("DELETE", `/droplets/${instanceId}`, undefined, signal);
    if (r.status === 404) return;
    if (r.status === 204) {
      const confirmed = await this.call('GET', `/droplets/${instanceId}`, undefined, signal);
      if (confirmed.status === 404) return;
      throw new DriverError('DigitalOcean deletion not confirmed', true);
    }
    this.fail(r.status, r.json);
  }

  async setPaidUntil(instanceId: string, until: number, signal?: AbortSignal): Promise<void> {
    if (!/^[0-9]{1,20}$/.test(instanceId) || !Number.isSafeInteger(until) || until <= 0) throw new DriverError('bad paid deadline', false);
    const tag = `wk-paid-until-${Math.floor(until / 1000)}`;
    const before = await this.call('GET', `/droplets/${instanceId}`, undefined, signal);
    if (before.status !== 200) this.fail(before.status, before.json);
    const prior = (before.json.droplet as { tags?: unknown } | undefined)?.tags;
    const paid = Array.isArray(prior) ? prior.filter((x): x is string => typeof x === 'string' && /^wk-paid-until-[0-9]+$/.test(x)) : [];
    if (paid.some(x => Number(x.slice('wk-paid-until-'.length)) > Math.floor(until / 1000))) return;
    const old = paid.filter(x => x !== tag);
    const created = await this.call('POST', '/tags', { name: tag }, signal);
    if (created.status !== 201 && created.status !== 422) this.fail(created.status, created.json);
    const attach = await this.call('POST', `/tags/${tag}/resources`, { resources: [{ resource_id: instanceId, resource_type: 'droplet' }] }, signal);
    if (attach.status !== 204 && attach.status !== 201) this.fail(attach.status, attach.json);
    for (const previous of old) {
      const removed = await this.call('DELETE', `/tags/${previous}/resources`, { resources: [{ resource_id: instanceId, resource_type: 'droplet' }] }, signal);
      if (removed.status !== 204 && removed.status !== 404) this.fail(removed.status, removed.json);
    }
  }

  async list(signal?: AbortSignal): Promise<Instance[]> {
    return (await this.byTag(MANAGED_TAG, signal))
      .map((d) => ({ instance_id: String(d.id), state: stateOf(d.status), tags: fromDoTags(d.tags ?? []) }))
      .filter((i) => i.state !== "terminated");
  }
}
