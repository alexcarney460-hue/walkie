import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { seatAgentName } from "../../src/protocol/seats.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { Cluster, waitFor } from "../helpers/cluster.ts";

test("stopping a daemon with a running seat retires refreshes and late signals before closing its store", async () => {
  const cluster = new Cluster();
  try {
    const fixture = join(import.meta.dir, "../fixtures/fake-codex");
    const alex = await cluster.add({ name: "alex", login: "alex@example.com" });
    const arvid = await cluster.add({ name: "arvid", login: "arvid@example.com", seats: {
      flushMs: 20, env: { PATH: `${fixture}:${dirname(process.execPath)}:/usr/bin:/bin` },
    } });
    await alex.client().init("team", "alex");
    await alex.client().invite("arvid@example.com", "arvid", "member");
    expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
    await arvid.client("").seatsConfig({ allow: true, same_user: true });
    await waitFor(async () => (await alex.client().seats()).hosts.find((h) => h.node === arvid.d.nodeId && h.allows), { what: "seat host" });
    const id = (await alex.client("").seatRun({ machine: arvid.hostname, runtime: "codex", prompt: "ticker 600" })).seat;
    const daemon = arvid.d;
    const finalStatuses: string[] = [];
    const submitFinal = daemon.core.statuses.submitFinal.bind(daemon.core.statuses);
    daemon.core.statuses.submitFinal = ((agent, body, provenance) => {
      if (agent === seatAgentName(id) && body.state === "offline") finalStatuses.push(body.state);
      return submitFinal(agent, body, provenance);
    }) as typeof daemon.core.statuses.submitFinal;
    const host = seatsFor(daemon.core) as unknown as {
      seats: Map<string, unknown>;
      seatStatus: (seat: unknown) => void;
      onSignal: (seat: unknown, signal: { kind: "tool"; text: string }) => void;
      seatStatuses: { flush: () => void; submit: (agent: string, body: object) => unknown };
    };
    const seat = await waitFor(() => host.seats.get(id), { what: "running seat" });
    host.onSignal(seat, { kind: "tool", text: "queued status update" });
    await arvid.stop();
    expect(finalStatuses).toEqual(["offline"]);
    expect(() => host.seatStatus(seat)).not.toThrow();
    expect(() => host.seatStatuses.flush()).not.toThrow();
    expect(() => host.onSignal(seat, { kind: "tool", text: "late signal" })).not.toThrow();
    expect(host.seatStatuses.submit(seatAgentName(id), { agent: seatAgentName(id), state: "working" })).toBeNull();
  } finally {
    await cluster.close();
  }
}, 60_000);
