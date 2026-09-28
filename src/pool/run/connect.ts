// Connections to models other machines serve (POOL-REAL-1): the client side of "serve on the best machine".
//
// `connect` asks the serving machine for a bearer key (`POST /peer/v1/pool/serve` connect), writes it to a key file
// (0600, <home>/pool/connect/<node>.key) and opens a listener on 127.0.0.1 here; every TCP connection an app makes
// to it is tunnelled over Walkie (`/peer/v1/pool/serve-tunnel/<id>`: a Walkie Direct stream or a Tailscale WebSocket)
// into the serving machine's allow-list proxy. So any OpenAI-compatible client on this machine uses
// `http://127.0.0.1:<port>/v1` with `Authorization: Bearer $(cat <key file>)`. The lease is renewed every RENEW_MS;
// two failed renews in a row mean the model is gone (stopped, sharing off, the machine unreachable): the listener
// closes and the connection shows as lost. Disconnect tells the serving machine and deletes the key file.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { join } from "node:path";
import { HttpError } from "../../daemon/http.ts";
import type { Logger } from "../../daemon/logger.ts";
import type { ConnectionView, ServeReq, ServeRes } from "../../protocol/pool.ts";
import { splice, tcpEnd, type End } from "./tunnel.ts";

export const RENEW_MS = 10_000;
/** Connections apps may hold open at once to one served model (the serving machine allows 8 tunnels per client). */
const MAX_LOCAL_CONNS = 8;

export interface ConnectDeps {
  home: string;
  log: Logger;
  changed: () => void;
  hostnameOf: (nodeId: string) => string;
  /** The serving machine's `POST /peer/v1/pool/serve`. */
  serve: (nodeId: string, body: ServeReq) => Promise<ServeRes>;
  /** Opens one tunnel connection to a serving machine's proxy. */
  tunnel: (nodeId: string, path: string) => Promise<End>;
}

interface Link {
  view: ConnectionView;
  listener: NetServer | null;
  socks: Set<Socket>; ends: Set<End>;
  timer: ReturnType<typeof setInterval> | null;
  renewFails: number;
}

export class PoolConnections {
  private readonly links = new Map<string, Link>();
  constructor(private readonly d: ConnectDeps) {}

  private keyFile(node: string): string { return join(this.d.home, "pool", "connect", `${node.replace(/[^0-9A-Za-z_-]/g, "_")}.key`); }

  view(): ConnectionView[] { return [...this.links.values()].map((l) => ({ ...l.view })); }

  /** Connected (or lost) links' node ids. */
  nodes(): string[] { return [...this.links.keys()]; }

  async connect(node: string): Promise<ConnectionView> {
    const res = await this.d.serve(node, { action: "connect" });
    const old = this.links.get(node);
    // Connecting again to the same model keeps the endpoint (the serving side hands back the same key).
    if (old && old.view.state === "connected" && old.view.id === res.id) return { ...old.view };
    if (old) await this.close(old, "replaced");
    if (!res.id || !res.key || !res.model) throw new HttpError(502, "bad_answer", "the serving machine answered without a key");
    const keyFile = this.keyFile(node);
    mkdirSync(join(this.d.home, "pool", "connect"), { recursive: true, mode: 0o700 });
    writeFileSync(keyFile, `${res.key}\n`, { mode: 0o600 });
    const link: Link = {
      view: {
        node_id: node, hostname: this.d.hostnameOf(node), id: res.id, model: res.model, state: "connected", error: null,
        endpoint: "", api_key_file: keyFile, example: "", since: Date.now(), requests: 0,
      },
      listener: null, socks: new Set(), ends: new Set(), timer: null, renewFails: 0,
    };
    this.links.set(node, link);
    let srv: NetServer | null = null;
    try {
      const got = await this.listen(link);
      srv = got.srv;
      const port = got.port;
      const endpoint = `http://127.0.0.1:${port}/v1`;
      link.view = {
        ...link.view, endpoint,
        example: `curl ${endpoint}/chat/completions -H "Authorization: Bearer $(cat ${keyFile})" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Hello"}]}'`,
      };
    } catch (err) {
      await this.close(link, "listen_failed");
      throw err;
    }
    // Closed (disconnected, replaced) while the listener was being created: nothing more to set up.
    if (this.links.get(node) !== link || link.view.state !== "connected") {
      srv?.close(); // close() may have run before the socket listened: this one is surely listening now
      link.listener = null;
      throw new HttpError(409, "cancelled", "the connection was closed while it was being set up");
    }
    link.timer = setInterval(() => void this.renew(link), RENEW_MS);
    (link.timer as { unref?: () => void }).unref?.();
    this.d.log.info("pool_connect", { node, id: res.id, model: res.model.id ?? res.model.name, endpoint: link.view.endpoint });
    this.d.changed();
    return { ...link.view };
  }

  private listen(link: Link): Promise<{ port: number; srv: NetServer }> {
    return new Promise((resolve, reject) => {
      const srv = createServer((sock) => {
        if (link.view.state !== "connected" || link.socks.size >= MAX_LOCAL_CONNS) { sock.destroy(); return; }
        link.socks.add(sock);
        void this.bridge(link, sock, tcpEnd(sock)).finally(() => link.socks.delete(sock));
      });
      // Owned by the link from the start (POOL-REAL-1 p8-8): a disconnect while it is still being created closes it.
      link.listener = srv;
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const a = srv.address();
        resolve({ port: typeof a === "object" && a ? a.port : 0, srv });
      });
    });
  }

  private async bridge(link: Link, sock: Socket, local: End): Promise<void> {
    let remote: End;
    try {
      remote = await this.d.tunnel(link.view.node_id, `/peer/v1/pool/serve-tunnel/${link.view.id}`);
    } catch (err) {
      this.d.log.warn("pool_connect_tunnel_failed", { node: link.view.node_id, err: (err as Error).message.slice(0, 200) });
      // Tell the app why, as an HTTP answer, instead of a bare reset.
      const msg = JSON.stringify({ error: { code: "tunnel_failed", message: `Walkie couldn't reach the model on ${link.view.hostname}: ${(err as Error).message.slice(0, 200)}` } });
      sock.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(msg)}\r\nConnection: close\r\n\r\n${msg}`);
      return;
    }
    link.ends.add(remote);
    link.view = { ...link.view, requests: link.view.requests + 1 };
    await splice(local, remote);
    link.ends.delete(remote);
  }

  private async renew(link: Link): Promise<void> {
    if (this.links.get(link.view.node_id) !== link || link.view.state !== "connected") return;
    try {
      await this.d.serve(link.view.node_id, { action: "renew", id: link.view.id });
      link.renewFails = 0;
    } catch (err) {
      link.renewFails++;
      const status = (err as { status?: number }).status;
      // A definite no (the model stopped, or this machine lost its connection there) ends it at once.
      if (status === 404 || status === 403 || link.renewFails >= 2) await this.lose(link, (err as Error).message);
    }
  }

  private async lose(link: Link, why: string): Promise<void> {
    if (link.view.state !== "connected") return;
    this.d.log.warn("pool_connect_lost", { node: link.view.node_id, err: why.slice(0, 200) });
    await this.close(link, "lost", `lost the model on ${link.view.hostname}: ${why.slice(0, 200)}`);
  }

  private async close(link: Link, why: string, error?: string): Promise<void> {
    if (link.timer) clearInterval(link.timer);
    link.timer = null;
    link.listener?.close();
    link.listener = null;
    for (const s of link.socks) s.destroy();
    for (const e of link.ends) e.close();
    rmSync(link.view.api_key_file, { force: true });
    link.view = { ...link.view, state: why === "lost" ? "lost" : "closed", ...(error ? { error } : {}) };
    if (why !== "lost" && this.links.get(link.view.node_id) === link) this.links.delete(link.view.node_id);
    this.d.changed();
  }

  /** Ends the connection to `node`'s model (tells it, best effort). */
  async disconnect(node: string): Promise<ConnectionView | null> {
    const link = this.links.get(node);
    if (!link) return null;
    const id = link.view.id;
    await this.close(link, "closed");
    this.links.delete(node);
    await this.d.serve(node, { action: "disconnect", id }).catch(() => undefined);
    return { ...link.view };
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.links.keys()].map((n) => this.disconnect(n)));
  }
}
