// FakeCloud: the complete in-memory CloudDriver for tests and the demo. It keeps every request it was sent (so tests
// assert exactly what a real driver would have been asked), enforces an optional capacity in vCPU-free "slots" per
// instance type, and can fail on demand. `onBoot` lets an end-to-end test play the machine: it receives the
// user-data a real box would run.
import { CapacityError, DriverError, type CloudDriver, type Instance, type InstanceState, type ProvisionReq } from "./driver.js";

export interface FakeCloudOptions {
  /** Max live instances per instance type (unset = unlimited). */
  readonly slots?: Readonly<Record<string, number>>;
  readonly onBoot?: (instanceId: string, req: ProvisionReq) => void;
}

interface FakeInstance { id: string; state: InstanceState; req: ProvisionReq }

export class FakeCloud implements CloudDriver {
  readonly name = "fake";
  readonly provisions: ProvisionReq[] = [];
  readonly terminations: string[] = [];
  private readonly instances = new Map<string, FakeInstance>();
  private readonly byKey = new Map<string, string>();
  private seq = 0;
  failNext: "capacity" | "error" | null = null;

  constructor(private readonly opts: FakeCloudOptions = {}) {}

  private live(type: string): number {
    return [...this.instances.values()].filter((i) => i.state !== "terminated" && i.req.instance_type === type).length;
  }

  async provision(req: ProvisionReq): Promise<{ instance_id: string }> {
    this.provisions.push(req);
    const existing = this.byKey.get(req.idempotency_key);
    if (existing) return { instance_id: existing };
    const fail = this.failNext;
    this.failNext = null;
    if (fail === "capacity") throw new CapacityError();
    if (fail === "error") throw new DriverError("fake provider error", true);
    const slots = this.opts.slots?.[req.instance_type];
    if (slots !== undefined && this.live(req.instance_type) >= slots) throw new CapacityError();
    const id = `fake-${(++this.seq).toString(16).padStart(8, "0")}`;
    this.instances.set(id, { id, state: "running", req });
    this.byKey.set(req.idempotency_key, id);
    this.opts.onBoot?.(id, req);
    return { instance_id: id };
  }

  async terminate(instanceId: string): Promise<void> {
    this.terminations.push(instanceId);
    const i = this.instances.get(instanceId);
    if (i) this.instances.set(instanceId, { ...i, state: "terminated" });
  }

  async setPaidUntil(instanceId: string, until: number): Promise<void> {
    const current = this.instances.get(instanceId);
    if (current) this.instances.set(instanceId, { ...current, req: { ...current.req,
      tags: { ...current.req.tags, 'walkie:paid_until': String(Math.floor(until / 1000)) } } });
  }

  async list(): Promise<Instance[]> {
    return [...this.instances.values()]
      .filter((i) => i.state !== "terminated")
      .map((i) => ({ instance_id: i.id, state: i.state, tags: i.req.tags }));
  }

  /** Tests: an instance the provider holds that no rental knows about (an orphan). */
  plantOrphan(tags: Record<string, string>): string {
    const id = `fake-${(++this.seq).toString(16).padStart(8, "0")}`;
    this.instances.set(id, { id, state: "running", req: { idempotency_key: id, instance_type: "orphan", region: null, image: null, user_data: "", name: id, tags } });
    return id;
  }

  state(instanceId: string): InstanceState | null {
    return this.instances.get(instanceId)?.state ?? null;
  }
}
