import { connect } from "node:net";
import { spawn } from "node:child_process";
import { defaultHome } from "../../daemon/paths.ts";
import { ownerPublicKey, ownerPrivateKeyPath } from "../../daemon/ssh/owner-key.ts";
import { sshBridgePath } from "../../daemon/ssh/bridge.ts";
import { writeErr, writeOut } from "../stdio.ts";
import { agentAncestor, readProcessTable, runtimeLabel } from "../agent-detect.ts";
import { AgentName } from "../../protocol/schemas.ts";
import { finishOwnerSsh, realSshStepDeps, waitFor, type SshStepDeps } from "../ssh-enroll.ts";
import { sshFinalLines, sshReport, sshVerdict, type SshFinal, type SshReport } from "../ssh-ready.ts";
import { realRootBatch, runAdministratorStep, type RootBatchDeps } from "../root-batch.ts";
import { FOREIGN_SSH_WHY, foreignSshServer } from "../ssh-foreign.ts";
import type { SshStatus } from "./doctor.ts";

const MACHINE = /^[A-Za-z0-9._-]{1,128}$/;

function checkedMachine(raw: string | undefined): string {
  const name = raw?.replace(/\.walkie$/, "") ?? "";
  if (!MACHINE.test(name)) throw new Error("name one machine");
  return name;
}

export async function sshCommand(args: readonly string[]): Promise<number> {
  const home = defaultHome();
  if (args[0] === "key") {
    const key = ownerPublicKey(home, true);
    writeOut(`${key}\n`);
    return 0;
  }
  if (args[0] === "config") {
    const machine = checkedMachine(args[1]);
    const { WalkieClient } = await import("../../client/index.ts");
    const info = await new WalkieClient().request<{ user: string }>("GET", `/v1/ssh/target?machine=${machine}`);
    writeOut(`Host ${machine}.walkie\n  HostName ${machine}.walkie\n  User ${info.user}\n  IdentityFile ${ownerPrivateKeyPath(home)}\n  IdentitiesOnly yes\n  ProxyCommand walkie tunnel ssh ${machine}\n`);
    return 0;
  }
  if (args[0] === "revoke") {
    const { WalkieClient } = await import("../../client/index.ts");
    await new WalkieClient().request("POST", "/v1/ssh/revoke", {});
    writeOut("owner SSH key revoked on this machine\n");
    return 0;
  }
  if (args[0] === "enable") return sshEnableCommand(args.slice(1));
  if (args[0] === "status") return sshStatusCommand(args.slice(1));
  const machine = checkedMachine(args[0]);
  const extra = args[1] === "--" ? args.slice(2) : args.slice(1);
  if (extra.some((s) => s.includes("\n") || s.includes("\0"))) throw new Error("invalid SSH argument");
  if (!ownerPublicKey(home)) throw new Error("owner SSH key absent; run walkie ssh key");
  const { WalkieClient } = await import("../../client/index.ts");
  const info = await new WalkieClient().request<{ user: string }>("GET", `/v1/ssh/target?machine=${machine}`);
  const child = spawn("ssh", ["-i", ownerPrivateKeyPath(home), "-o", "IdentitiesOnly=yes",
    "-o", `ProxyCommand=walkie tunnel ssh ${machine}`, "-l", info.user, ...extra, `${machine}.walkie`], { stdio: "inherit" });
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

export async function sshTunnelCommand(args: readonly string[]): Promise<number> {
  if (args[0] !== "ssh") throw new Error("usage: walkie tunnel ssh <machine>");
  const machine = checkedMachine(args[1]);
  const agent = process.env.WALKIE_AGENT || runtimeLabel() || agentAncestor(readProcessTable(), process.ppid)?.name;
  if (agent && !AgentName.safeParse(agent).success) throw new Error("invalid SSH caller agent");
  const socket = connect(sshBridgePath(defaultHome()));
  return await new Promise<number>((resolve, reject) => {
    let ready = false;
    let header = Buffer.alloc(0);
    socket.once("connect", () => socket.write(`${JSON.stringify({ machine, ...(agent ? { agent } : {}) })}\n`));
    const onData = (part: Buffer): void => {
      header = Buffer.concat([header, part]);
      const cut = header.indexOf(10);
      if ((cut < 0 ? header.length : cut) > 512) { socket.destroy(new Error("invalid tunnel response")); return; }
      if (cut < 0) return;
      socket.pause(); socket.off("data", onData);
      const answer = header.subarray(0, cut).toString("utf8");
      if (answer !== "OK") { socket.destroy(); writeErr(`walkie tunnel ssh: ${answer.slice(0, 160)}\n`); resolve(1); return; }
      if (cut + 1 < header.length) socket.unshift(header.subarray(cut + 1));
      ready = true;
      process.stdin.pipe(socket); socket.pipe(process.stdout); socket.resume();
    };
    socket.on("data", onData);
    socket.once("error", (err) => { writeErr(`walkie tunnel ssh: ${err.message}\n`); reject(err); });
    socket.once("close", () => { if (!ready) resolve(1); else resolve(0); });
  });
}

/**
 * `walkie ssh status [--wait] [--json]`: whether owner SSH is READY on this machine, judged only from the daemon's
 * `GET /v1/ssh/status` (server on, owner key installed, tunnel open). `--wait` gives a state that can still resolve by
 * itself up to a minute. Human output exits 0 only when ready; with `--json` the exit status is 0 whenever the daemon
 * answered, so a caller (the desktop app, the Windows bootstrap) reads `state` instead.
 */
export async function sshStatusCommand(rest: readonly string[], deps?: SshStepDeps, out: (line: string) => void = (line) => writeOut(`${line}\n`)): Promise<number> {
  const unknown = rest.filter((a) => a !== "--wait" && a !== "--json");
  if (unknown.length) throw new Error("usage: walkie ssh status [--wait] [--json]");
  const json = rest.includes("--json");
  const step = deps ?? realSshStepDeps(new (await import("../../client/index.ts")).WalkieClient());
  let report: SshReport | SshFinal;
  if (rest.includes("--wait")) report = await waitFor(step, json ? undefined : (w) => out(`waiting: ${w.why}`));
  else report = sshReport(sshVerdict(await step.read(), step.platform, { walkieUnit: step.walkieUnit?.() === true }));
  if (json) out(JSON.stringify(report));
  else for (const line of sshFinalLines(report)) out(line);
  return json || report.state === "ready" ? 0 : 1;
}

/** What `walkie ssh enable` needs: the person's confirmation, the daemon's status, the one root batch, the watch, and where lines go. */
export interface SshEnableDeps {
  platform: NodeJS.Platform;
  /** The person's typed yes at their own terminal (an agent or a pipe is refused: it throws). */
  confirm(): Promise<void>;
  status(): Promise<SshStatus>;
  root: RootBatchDeps;
  step: SshStepDeps;
  out(line: string): void;
}

async function realEnableDeps(): Promise<SshEnableDeps> {
  const { WalkieClient } = await import("../../client/index.ts");
  const { makeCtx, requirePerson } = await import("../context.ts");
  const { parseArgs } = await import("../args.ts");
  const { CLI_BOOLEANS } = await import("../booleans.ts");
  const client = new WalkieClient();
  const ctx = makeCtx(parseArgs([], CLI_BOOLEANS));
  return {
    platform: process.platform, out: (line) => writeOut(`${line}\n`), root: realRootBatch(defaultHome()), step: realSshStepDeps(client),
    confirm: () => requirePerson(ctx, "install Walkie's SSH service on this machine (one administrator step)", "yes"),
    status: () => client.request<SshStatus>("GET", "/v1/ssh/status"),
  };
}

/**
 * `walkie ssh enable`: installs (or repairs) Walkie's own SSH service on a machine that already has an owner SSH
 * authorization: macOS's launchd service on 127.0.0.1:22022, or Linux and WSL's loopback sshd, from the same one
 * administrator step the enrollment runs. It never opens Remote Login. Nothing is asked or run when the service already
 * answers or when there is no authorization to serve; ready is only what the daemon's status says afterwards. On Linux and
 * WSL an SSH server that is not Walkie's, already answering on 22, is not used: it says so and owner SSH stays off.
 */
export async function sshEnableCommand(rest: readonly string[], deps?: SshEnableDeps): Promise<number> {
  if (rest.length) throw new Error("usage: walkie ssh enable");
  const d = deps ?? await realEnableDeps();
  if (d.platform !== "darwin" && d.platform !== "linux") throw new Error("walkie ssh enable installs Walkie's SSH service on macOS, Linux and WSL");
  const now = await d.status();
  if (now.reason === "grant_absent") {
    d.out("This machine has no owner SSH authorization, so there is no SSH service to turn on. The owner's add-machine link carries one: run its command (walkie setup --invite … --company-machine --owner-ssh …) here.");
    return 1;
  }
  // Linux and WSL: an SSH server that is not Walkie's already answers on 22. Walkie does not use it and does not call SSH ready
  // through it: owner SSH stays off on this machine in this release (src/cli/ssh-foreign.ts).
  if (await foreignSshServer({ platform: d.platform, read: async () => now, ...(d.step.walkieUnit ? { walkieUnit: d.step.walkieUnit } : {}), ...(d.step.walkieActive ? { walkieActive: d.step.walkieActive } : {}) })) {
    d.out(FOREIGN_SSH_WHY);
    return 1;
  }
  if (now.server.enabled) {
    d.out("Walkie's SSH service already answers on this machine.");
  } else {
    await d.confirm();
    const stepped = await runAdministratorStep((line) => d.out(line), d.root, { carriesSsh: true, platform: d.platform, serverAnswers: async () => false, again: "run walkie ssh enable again" });
    if (!stepped.ok) { d.out(stepped.why); return 1; }
  }
  const final = await finishOwnerSsh((line) => d.out(line.trimStart()), d.step);
  return final.state === "ready" ? 0 : 1;
}
