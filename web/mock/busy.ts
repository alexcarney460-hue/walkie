// WALKIE_MOCK_FLEET=busy (LIVE-2 screenshots): a fleet the size of a real team's. Dozens of working agents, several
// in long commands, one machine where one-shot runs come and go every ~15 s (what hestia-wsl looked like before the
// daemon fix), and one agent that flaps working ↔ idle.
import type { StatusBody, World } from "./world.ts";

const MIN = 60_000;
const LONG = ["Running a command", "Waiting on a command's output", "Bash bun test --coverage", "Bash cargo build --release", "Bash pnpm build:platform"];
const STEPS = ["Edit web/src/views/mission/MissionControl.tsx", "Read src/daemon/sse.ts", "Bash bun test web/test", "Edit src/billing/totals.ts", "Grep \"agentsChanged\" src", "Running tests"];
const HOSTS = ["maren-mbp", "atlas", "tobias-mbp", "ines-studio", "sol-x1"];

export function seedBusy(world: World): void {
  const now = Date.now();
  let n = 0;
  for (const host of HOSTS) {
    const handle = world.node(host).handle;
    const count = host === "atlas" ? 12 : 6;
    for (let i = 0; i < count; i++) {
      n++;
      const agent = `lane-${String(n).padStart(2, "0")}`;
      const long = i % 3 === 0;
      const ago = long ? 3 + ((n * 7) % 40) : ((n * 13) % 50) / 60;
      const body: StatusBody = {
        agent, state: "working", runtime: i % 2 ? "codex" : "claude-code", title: `Lane ${n}: ${long ? "full build + test run" : "fixing review comments"}`,
        repo: "harbor-api", branch: `lane/${n}`, activity: long ? LONG[n % LONG.length]! : STEPS[n % STEPS.length]!, started_at: now - (ago + 20) * MIN,
      };
      world.emit({ handle, hostname: host, agent, kind: "agent.status", ts: now - ago * MIN, silent: true, body });
    }
  }
}

export class BusySim {
  private tick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private churnSeq = 0;
  constructor(private readonly world: World) {}

  start(): void { this.timer = setInterval(() => this.step(), 2_500); }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private emit(host: string, agent: string, body: Partial<StatusBody>): void {
    const node = this.world.node(host);
    if (!node.online) return;
    const cur = this.world.agents.get(this.world.agentKey(host, agent))?.status;
    this.world.emit({ handle: node.handle, hostname: host, agent, kind: "agent.status", body: { agent, runtime: "claude-code", ...cur, ...body } as StatusBody });
  }

  private step(): void {
    this.tick += 1;
    // One-shot runs on atlas: appear (idle, "Connected to Walkie"), gone a scan later.
    if (this.tick % 6 === 1) {
      this.churnSeq += 1;
      this.emit("atlas", `agent-2${(1000 + this.churnSeq).toString(36)}`, { state: "idle", runtime: "other", activity: "Connected to Walkie", started_at: Date.now() });
    }
    if (this.tick % 6 === 4) this.emit("atlas", `agent-2${(1000 + this.churnSeq).toString(36)}`, { state: "offline", activity: "Process exited" });
    // A flapping session: idle for a few seconds between turns.
    if (this.tick % 12 === 3) this.emit("sol-x1", "lane-31", { state: "idle", activity: "Finished turn" });
    if (this.tick % 12 === 5) this.emit("sol-x1", "lane-31", { state: "working", activity: "Thinking" });
    // Shared tool steps on a couple of seats.
    if (this.tick % 2 === 0) this.emit("maren-mbp", "lane-02", { state: "working", activity: STEPS[this.tick % STEPS.length]! });
  }
}
