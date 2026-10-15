// Lane C round 14 (REVIEW-r13-opus P3 4): a retryable refusal from the Sqwakie site's licence checks reaches the CLI as
// "the Sqwakie site refused: <code>". The CLI says what it means: temporary, and run the command again. The daemon's
// own wording (src/daemon/compute/*) is not changed here.
import { expect, test } from "bun:test";
import { compute } from "../../src/cli/commands/compute.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { WalkieError } from "../../src/client/index.ts";

function ctxFailing(err: Error): Ctx {
  const fail = async () => { throw err; };
  return {
    args: { pos: ["list"], flags: new Map() }, json: false, forAgent: false, agentMarker: () => null,
    person: { interactive: () => true, ask: async () => "yes", note: () => undefined },
    client: () => ({ computeState: fail }), out: () => undefined, err: () => undefined,
  } as unknown as Ctx;
}
async function refusal(code: string): Promise<WalkieError> {
  try { await compute(ctxFailing(new WalkieError(code, `the Sqwakie site refused: ${code}`, 502))); }
  catch (err) { return err as WalkieError; }
  throw Error("compute did not fail");
}

test("licence_record_pruning says it is temporary and to run the command again", async () => {
  const err = await refusal("licence_record_pruning");
  expect(err).toBeInstanceOf(WalkieError);
  expect([err.code, err.status]).toEqual(["licence_record_pruning", 502]);
  expect(err.message).toContain("temporary");
  expect(err.message).toContain("run the command again");
  expect(err.message).not.toContain("refused: licence_record_pruning");
});

test("the other retryable licence and state codes say the same", async () => {
  for (const code of ["licence_backfill_pending", "license_verification_unavailable", "compute_state_unavailable"]) {
    const err = await refusal(code);
    expect({ code: err.code, temporary: err.message.includes("temporary"), again: /again/.test(err.message) })
      .toEqual({ code, temporary: true, again: true });
  }
});

test("other refusals and errors are passed through unchanged", async () => {
  const overflow = await refusal("licence_bindings_overflow");
  expect(overflow.message).toBe("the Sqwakie site refused: licence_bindings_overflow");
  const plain = new Error("boom");
  await expect(compute(ctxFailing(plain))).rejects.toBe(plain);
});
