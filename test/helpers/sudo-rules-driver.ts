// Runs INSIDE a throwaway container (test/helpers/sudo-rules-inner.sh, started by test/sudo-rules-containers.sh), as the
// person whose sudo it is: the real seatUserSetup of a source tree against the container's own sudo and file system, with
// a stub standing in for the walkie release binary. It is not a unit test and must never run on a real machine.
//   bun sudo-rules-driver.ts <tree root> plan|apply|enable [unknown|sudo-rs|classic]   setup-user | setup-user --apply | the plan-less run `seats enable` makes
//   bun sudo-rules-driver.ts <tree root> rules [sudo-rs|classic]                       the sudoers text setup would write
// The tree root is the checkout to run (the container script passes the one under test, and for the rerun check the code from
// before the fix); the optional last word overrides which sudo setup believes it found (default: it asks the real one).
import { existsSync } from "node:fs";

if (!existsSync("/.dockerenv")) {
  console.error("run this helper only inside its throwaway Docker container");
  process.exit(2);
}

const [root, mode, forced] = process.argv.slice(2);
const modes = ["plan", "apply", "enable", "rules"];
if (!root || !mode || !modes.includes(mode)) {
  console.error(`usage: bun sudo-rules-driver.ts <tree root> ${modes.join("|")} [unknown|sudo-rs|classic]`);
  process.exit(2);
}
if (mode !== "rules" && process.getuid?.() === 0) {
  console.error("run it as the person whose sudo it is, never as root");
  process.exit(2);
}

// --apply wants a release build, and installs the running binary as the runner and the helper: a stub for both.
(globalThis as { WALKIE_EMBEDDED?: boolean }).WALKIE_EMBEDDED = true;
Object.defineProperty(process, "execPath", { value: process.env.WALKIE_STUB ?? "/opt/walkie-stub/walkie", configurable: true });

const sudo = forced === undefined ? undefined : { flavor: forced, version: null };

if (mode === "rules") {
  const { seatUserPlan } = await import(`${root}/src/daemon/seats/seat-user.ts`);
  const plan = seatUserPlan({
    platform: "linux", daemonUser: "daemonuser", source: "/opt/walkie-stub/walkie", groupId: 0, walkieHome: "/home/daemonuser/.walkie",
    sudoersTmp: "/tmp/walkie-seats", home: "/home/daemonuser", homeProblem: null, runtimes: {}, sudo: forced === "sudo-rs" ? { flavor: "sudo-rs", version: "0.2.13" } : sudo,
  });
  process.stdout.write(plan.sudoers);
  process.exit(0);
}

const { seatUserSetup } = await import(`${root}/src/cli/commands/seat-user.ts`);
const { parseArgs } = await import(`${root}/src/cli/args.ts`);
const { CLI_BOOLEANS } = await import(`${root}/src/cli/booleans.ts`);

const client = {
  seats: async () => ({ local: { allow: false } }),
  seatsConfig: async (config: unknown) => { console.log(`seats pointed at the helper: ${JSON.stringify(config)}`); return { local: { allow: false } }; },
};
const ctx = {
  args: parseArgs(["setup-user", ...(mode === "plan" ? [] : ["--apply"])], CLI_BOOLEANS), json: false, forAgent: false, agentMarker: () => null,
  client: () => client, out: (s: string) => console.log(s), err: (s: string) => console.error(s),
};
const result = await seatUserSetup(ctx, { apply: mode !== "plan", accept: false, plan: mode !== "enable", ...(sudo ? { sudo } : {}) });
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(result.ok ? 0 : 1);
