// WALK-103: the Seats view says when this machine's seat users belong to another Walkie, when the helper's list can't be
// read, which seat users this Walkie leaves alone, and which leftovers still run (with the way out).
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SeatsLocalView } from "../src/api/types.ts";
import { SeatOwnership } from "../src/views/seats/SeatOwnership.tsx";

const base = { allow: true, ephemeral: true, channel_ok: true, claude_login: "machine" } as SeatsLocalView;

test("nothing is shown while this Walkie owns its seat users and none is left", () => {
  expect(renderToStaticMarkup(<SeatOwnership local={base} />)).toBe("");
});

test("another Walkie's record, the unreadable list, users left alone and running leftovers are all said", () => {
  const html = renderToStaticMarkup(<SeatOwnership local={{ ...base,
    seat_scope: { state: "other", why: "seat users on this machine are managed by another Walkie (arvid's, home /home/arvid/.walkie)" },
    reconcile_error: "seat users on this machine are managed by another Walkie",
    foreign_users: ["walkie-s6", "walkie-s7"], leftovers_running: ["walkie-s3"] }} />);
  expect(html).toContain("Seat users on this machine are managed by another Walkie (arvid&#x27;s, home /home/arvid/.walkie).");
  expect(html).toContain("New seat users wait");
  expect(html).toContain("2 seat users here aren&#x27;t this Walkie&#x27;s to remove");
  expect(html).toContain("walkie-s6, walkie-s7");
  expect(html).toContain("sudo pkill -KILL -u walkie-s3");
  expect(html).not.toContain("setup-user --apply</span> and a restart");
});

test("without a record (an earlier setup), the way out is setup-user and a restart", () => {
  const html = renderToStaticMarkup(<SeatOwnership local={{ ...base, seat_scope: { state: "legacy", why: "this machine's seat users were set up by an earlier Walkie" }, foreign_users: ["walkie-s6"] }} />);
  expect(html).toContain("field-hint");
  expect(html).toContain("1 seat user here isn&#x27;t this Walkie&#x27;s to remove");
  expect(html).toContain("walkie seats setup-user --apply</span> and a restart of Walkie");
});
