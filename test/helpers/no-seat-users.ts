import type { SeatsOptions } from "../../src/daemon/seats/host.ts";

// A fixture with no registration and no held seat users. An absent registration
// alone still probes an installed host helper at daemon startup. Supply its empty
// ledger too; unexpected mutations fail closed rather than reaching sudo.
export const noSeatUsers: Pick<SeatsOptions, "seatRegistration" | "admin"> = {
  seatRegistration: () => ({ state: "absent" }),
  admin: async (verb) => verb === "pending"
    ? { ok: true, ids: [] }
    : { ok: false, code: "refused", why: `no seat users in this fixture: ${verb} refused` },
};
