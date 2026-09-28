// Local API for limit resets (WALKIE-ACCOUNTS-RESET-1/2). Person-only: a request carrying X-Walkie-Agent or
// X-Walkie-Under-Agent (any value, valid or not) is refused, and the routes are served to a dashboard session only (the
// durable token the CLI and the MCP server use cannot reach them). That stops agents that identify themselves; an
// agent running as the daemon's OS user can still reach the socket unmarked and mint a dashboard session (SECURITY
// "Limit resets": the known limit; ADD-MACHINE-2 refuses nonces to agent-marked callers). The routes act on
// accounts whose login is on THIS machine; there is no path to ask another machine's daemon.
import { z } from "zod";
import { AccountId } from "../protocol/accounts.ts";
import { HttpError, json, parseWith, readJson } from "../daemon/http.ts";
import { limitWrite, requireTeam, route, type RouteCtx } from "../daemon/local-routes.ts";
import { AccountActionError, type AccountsService } from "./service.ts";

const RESET_BODY_MAX = 4 * 1024;
/** One attempt's id, minted by the dashboard's confirmation sheet (a UUID). */
export const RequestId = z.string().regex(/^[A-Za-z0-9-]{16,64}$/);
const ResetReq = z.object({ account: AccountId, request_id: RequestId }).strict();
const PrepareReq = z.object({ account: AccountId }).strict();
const RefreshReq = z.object({ account: AccountId }).strict();

function personOnly(c: RouteCtx): void {
  // Raw header presence, not c.agent: an invalid agent name is dropped by the header validator but is still an agent.
  if (c.agent || c.req.headers.has("x-walkie-agent") || c.req.headers.has("x-walkie-under-agent")) {
    throw new HttpError(403, "person_only", "limit resets are used by a person, not an agent");
  }
  if (!c.dashboard) throw new HttpError(403, "forbidden", "limit resets are used from the dashboard");
}

function service(c: RouteCtx): AccountsService {
  const s = c.accounts?.();
  if (!s) throw new HttpError(404, "not_found", "accounts are off on this daemon");
  return s;
}

function refused(err: unknown): never {
  if (!(err instanceof AccountActionError)) throw err;
  if (err.code === "not_found") throw new HttpError(404, "not_found", "that account's login is not on this machine; use a reset from the dashboard of the machine that holds it");
  if (err.code === "not_supported") throw new HttpError(409, "not_supported", "this provider's resets are used on its own page, not through Walkie");
  if (err.code === "not_signed_in") throw new HttpError(409, "not_signed_in", "Codex isn't signed in to a ChatGPT account on this machine: run codex login");
  if (err.code === "login_changed") throw new HttpError(409, "login_changed", "the login on this machine is now a different account (or signed out); nothing was sent");
  if (err.code === "ledger_unreadable") throw new HttpError(409, "ledger_unreadable", `Walkie couldn't read its reset records (kept as ${err.detail ?? "accounts.json.corrupt-*"}), so an earlier attempt may be missing: check the usage of every Codex account on this machine, then confirm you checked (that lets resets through again for all of them)`);
  if (err.code === "ledger_unwritable") throw new HttpError(503, "ledger_unwritable", "Walkie couldn't write its reset records (is the disk full?); nothing was sent");
  if (err.code === "unknown_attempt") throw new HttpError(409, "unknown_attempt", "no such reset attempt here (it expired, or it was not prepared on this machine); open the sheet again");
  throw new HttpError(409, "request_reused", "that request id belongs to another account");
}

// The confirmation sheet opens: the daemon mints (or hands back) the attempt it will confirm, bound to the account.
route("POST", "/v1/accounts/reset/prepare", async (c) => {
  requireTeam(c);
  personOnly(c);
  limitWrite(c);
  const body = parseWith(PrepareReq, await readJson(c.req, RESET_BODY_MAX));
  try {
    return json({ attempt: service(c).prepareReset(body.account) });
  } catch (err) {
    refused(err);
  }
});

route("POST", "/v1/accounts/reset", async (c) => {
  requireTeam(c);
  personOnly(c);
  limitWrite(c);
  const body = parseWith(ResetReq, await readJson(c.req, RESET_BODY_MAX));
  const s = service(c);
  try {
    return json({ result: await s.useReset(body.account, body.request_id) });
  } catch (err) {
    refused(err);
  }
});

// A person checked usage and says so: releases the account's unconfirmed attempt ("dismissed", never retried) and a
// reset ledger that could not be read. Nothing expires on a clock (RESET-4); this and Codex's own answer to a retry
// are the only ways out.
route("POST", "/v1/accounts/reset/resolve", async (c) => {
  requireTeam(c);
  personOnly(c);
  limitWrite(c);
  const body = parseWith(PrepareReq, await readJson(c.req, RESET_BODY_MAX));
  try {
    return json(service(c).resolveReset(body.account));
  } catch (err) {
    refused(err);
  }
});

route("POST", "/v1/accounts/refresh", async (c) => {
  requireTeam(c);
  personOnly(c);
  limitWrite(c);
  const body = parseWith(RefreshReq, await readJson(c.req, RESET_BODY_MAX));
  try {
    const r = service(c).refresh(body.account);
    return json({ scheduled: r === "scheduled", held: r === "held" });
  } catch (err) {
    refused(err);
  }
});
