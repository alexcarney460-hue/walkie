// The sign-up-link requirements, unit level (ADD-MACHINE-1 findings): seats work on Free, a machine's seats channel
// being the seats protocol's own (finding 2); one consent flag with its alias (finding 4); a Claude token handed over
// in the same step, whatever `claude setup-token` printed around it (finding 5).
import { afterEach, describe, expect, test } from "bun:test";
import { allowTeamAgents, extractClaudeToken, noTeamAgents } from "../../src/cli/commands/seats-enable.ts";
import { planLimitFor } from "../../src/license/enforce.ts";
import { seatsChannel } from "../../src/protocol/seats.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, memberEv, nodeEv, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const DAY = 86_400_000;

describe("seats on Free (finding 2)", () => {
  test("after the trial, a machine's seats channel is allowed; any other new restricted channel still needs the Team plan", () => {
    const alex = tnode("alex");
    const arvid = tnode("arvid");
    const { team: id, create } = createTeam(alex);
    const core = makeCore(arvid, id, cleanups); // arvid's replica of the chain
    feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid)]);
    const afterTrial = (core.roster.team?.created_ts ?? 0) + 61 * DAY;
    const seats = seatsChannel(arvid.keys.nodeId);
    expect(planLimitFor(core.roster, "channel.upsert", { name: seats, members: ["arvid", "alex"], seats: true }, afterTrial)).toBeNull();
    // Unmarked (PRE4 delta): an ordinary restricted channel, whatever its name.
    expect(planLimitFor(core.roster, "channel.upsert", { name: seats, members: ["arvid", "alex"] }, afterTrial)?.resource).toBe("restricted_channels");
    expect(planLimitFor(core.roster, "channel.upsert", { name: "secret", members: ["arvid", "alex"] }, afterTrial)?.resource).toBe("restricted_channels");
    // Only for a machine on the team, and never as a public channel.
    expect(planLimitFor(core.roster, "channel.upsert", { name: seatsChannel("0123456789abcdef"), members: ["alex"], seats: true }, afterTrial)?.resource).toBe("restricted_channels");
  });
});

describe("one consent flag (finding 4)", () => {
  const args = (...f: string[]) => ({ args: { pos: [], flags: new Map(f.map((x) => [x, true])) } }) as never;
  test("--allow-team-agents / --no-team-agents, with --allow-seats / --no-seats as aliases", () => {
    expect(allowTeamAgents(args("allow-team-agents"))).toBe(true);
    expect(allowTeamAgents(args("allow-seats"))).toBe(true);
    expect(allowTeamAgents(args())).toBe(false);
    expect(noTeamAgents(args("no-team-agents"))).toBe(true);
    expect(noTeamAgents(args("no-seats"))).toBe(true);
  });
});

describe("a Claude token in the same step (finding 5)", () => {
  test("the token is taken out of whatever `claude setup-token` printed; anything else isn't a token", () => {
    const tok = `sk${""}-ant-oat01-${"a".repeat(60)}`;
    expect(extractClaudeToken(`Your OAuth token (valid for 1 year):\n\n${tok}\n\nStore it securely.`)).toBe(tok);
    expect(extractClaudeToken(`  ${tok}  \n`)).toBe(tok);
    expect(extractClaudeToken("nope")).toBeNull();
    expect(extractClaudeToken("")).toBeNull();
  });
});
