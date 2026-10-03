import { describe, expect, test } from "bun:test";
import { MockRecommendations } from "../mock/recommendations.ts";

const url = "http://127.0.0.1/v1/talkie/recs";
const fixtureResult = "Fixture only; no real action performed.";
const request = (action: string, body?: string, id = "0000000000000001%3A1") =>
  new Request(`${url}/${id}/${action}`, { method: "POST", body });

describe("recommendation mock note contract", () => {
  for (const action of ["approve", "dismiss"] as const) {
    for (const note of ["Reviewed the synthetic suggestion", "  Keep whitespace.\n✓  ", "n".repeat(200)]) {
      test(`${action} preserves a valid ${note.length}-character note in the answer and later reads`, async () => {
        const mock = new MockRecommendations();
        const response = (await mock.handle(request(action, JSON.stringify({ note })), true, 123))!;
        expect(response.status).toBe(200);
        const { rec } = await response.json();
        expect(rec.resolved).toEqual({ status: action === "approve" ? "approved" : "dismissed", by: "demo-person", at: 123, note });
        expect(rec.can_approve).toBe(false);
        expect(rec.can_dismiss).toBe(false);
        const all = await (await mock.handle(new Request(`${url}?status=all`), true))!.json();
        // The server lists every open recommendation before the answered ones, and so does the mock.
        expect(all.recs.find((r: { id: string }) => r.id === rec.id)).toEqual(rec);
        expect(all.recs.at(-1)).toEqual(rec);
        const open = await (await mock.handle(new Request(url), true))!.json();
        expect(open.recs).toHaveLength(4);
        expect((await mock.handle(request(action, "{}"), true))!.status).toBe(409);
      });
    }

    for (const body of [undefined, "{}", '{"note":""}']) {
      test(`${action} with ${body ?? "no body"} follows route fallback and empty-note omission`, async () => {
        const mock = new MockRecommendations();
        const response = (await mock.handle(request(action, body, "00000001"), true))!;
        expect(response.status).toBe(200);
        const { rec } = await response.json();
        // answerRec omits empty notes; only absent approval notes use the action result.
        if (action === "approve" && body !== '{"note":""}') expect(rec.resolved.note).toBe(fixtureResult);
        else expect(rec.resolved).not.toHaveProperty("note");
      });
    }

    for (const [body, message] of [
      ['{"note":', "body is not valid JSON"],
      ['{"note":42}', "note: Expected string, received number"],
      ['{"note":null}', "note: Expected string, received null"],
      [JSON.stringify({ note: "n".repeat(201) }), "note: String must contain at most 200 character(s)"],
      ['{"extra":true}', "body: Unrecognized key(s) in object: 'extra'"],
      ["[]", "body: Expected object, received array"],
      ["null", "body: Expected object, received null"],
    ]) {
      test(`${action} rejects ${body!.slice(0, 30)} without resolving the fixture`, async () => {
        const mock = new MockRecommendations();
        const response = (await mock.handle(request(action, body), true))!;
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: { code: "invalid", message } });
        const list = await (await mock.handle(new Request(url), true))!.json();
        expect(list.recs).toHaveLength(5);
        expect(list.recs[0].status).toBe("pending");
        expect((await mock.handle(request(action, '{"note":"Corrected"}'), true))!.status).toBe(200);
      });
    }
  }

  test("body validation precedes lookup, while the person gate precedes body validation", async () => {
    const mock = new MockRecommendations();
    const malformed = () => request("dismiss", "null", "000000ff");
    expect((await mock.handle(malformed(), false))!.status).toBe(403);
    expect((await mock.handle(malformed(), true))!.status).toBe(400);
    expect((await mock.handle(request("dismiss", "{}", "000000ff"), true))!.status).toBe(404);
  });

  test("concurrent ordinary answers resolve a fixture only once", async () => {
    const mock = new MockRecommendations();
    const answers = await Promise.all(["First", "Second"].map((note) =>
      mock.handle(request("dismiss", JSON.stringify({ note })), true)));
    expect(answers.map((answer) => answer!.status).sort()).toEqual([200, 409]);
    const accepted = await answers.find((answer) => answer!.status === 200)!.json();
    expect(["First", "Second"]).toContain(accepted.rec.resolved.note);
  });
});
