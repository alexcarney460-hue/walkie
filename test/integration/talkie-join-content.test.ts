import { afterAll, beforeAll, expect, test } from "bun:test";
import { WalkieClient, type WalkieError } from "../../src/client/index.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";

let cluster: Cluster;
let node: TestNode;
let agent: WalkieClient;
let project: string;
let card: string;
const code = `wk1${"Ab_-".repeat(40)}`;
const bytes = (s: string) => new TextEncoder().encode(s);
const refused = async (op: Promise<unknown>) => {
  const err = await op.then(() => null, (e: WalkieError) => e);
  expect(err?.code).toBe("join_credential_private_reply_only");
};

beforeAll(async () => {
  cluster = new Cluster();
  node = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  await node.client().init("acme", "alex");
  agent = node.client("helper");
  project = (await node.client().createProject({ name: "Content checks" })).project.channel;
  card = (await node.client().createTask({ project, title: "Safe card" })).task.key;
});
afterAll(async () => { await cluster.close(); });

test("agent post and thread reply refuse raw, URL-encoded and invisible-split codes", async () => {
  const root = (await node.client().post({ channel: "general", text: "safe" })).event.id;
  for (const text of [code, `%77k1${code.slice(3)}`, `${code.slice(0, 6)}\u200b${code.slice(6)}`]) {
    await refused(agent.post({ channel: "general", text, raw: true }));
    await refused(agent.post({ channel: "general", thread: root, text }));
  }
});

test("agent asks, answers, statuses and card text refuse credentials", async () => {
  const ask = (await node.client().ask({ to: "@alex", text: "safe question" })).event.id;
  await refused(agent.ask({ to: "@alex", text: code }));
  await refused(agent.answer({ ask, text: code }));
  await refused(agent.status({ agent: "helper", state: "working", title: code }));
  await refused(agent.createTask({ project, title: code }));
  await refused(agent.createTask({ project, title: "safe", body: code }));
  await refused(agent.createTask({ project, title: "safe", body: `${code.slice(0, 6)}\n${code.slice(6)}` }));
  await refused(agent.updateTask(card, { title: code }));
  await refused(agent.updateTask(card, { body: code }));
  await refused(agent.commentTask(card, code));
});

test("agent project settings refuse join credentials before the admin write drops agent identity", async () => {
  for (const description of [code, `${code.slice(0, 7)}\n${code.slice(7)}`]) {
    await refused(agent.updateProject(project, { description }));
  }
  expect((await node.client().project(project)).project.description ?? "").not.toContain("wk1");
  expect((await node.client().updateProject(project, { description: code })).project.description).toBe(code);
});

test("agent file shares and Data Room uploads refuse credential bytes", async () => {
  await refused(agent.share(bytes(`notes ${code}`), { name: "notes.txt", mime: "text/plain" }));
  await refused(agent.roomAdd(project, bytes(`notes ${code}`), { name: "notes.txt", mime: "text/plain" }));
  await refused(agent.roomAdd(project, bytes(`notes %77k1${code.slice(3)}`), { name: "notes.bin", mime: "application/octet-stream" }));
});
