import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Armchair, Download, Play, ShieldAlert, Square } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import type { SeatHostView, SeatMode, SeatRuntime, SeatView, SeatsLocalView, SeatsView } from "../../api/types.ts";
import { PageHeader } from "../../components/Shell.tsx";
import { CopyCommand, EmptyState, ErrorState, RelTime, Section, SkeletonRows } from "../../components/primitives.tsx";
import { RichMarkdown } from "../../lib/markdown-rich.tsx";
import { useMdOpts } from "../../state/useMdOpts.ts";
import { useStore } from "../../state/store.tsx";
import { MessageBoundary } from "../orchestrator/Messages.tsx";
import { BusyCard, busyCounts, clockTime } from "./BusyCard.tsx";
import { AgentAdminCard } from "./AgentAdminCard.tsx";

const STATE_LABEL: Record<SeatView["state"], string> = {
  requested: "Requested", queued: "Queued", running: "Running", paused: "Paused", done: "Done", failed: "Failed", stopped: "Stopped", timeout: "Timed out",
  refused: "Refused",
};
const MODE_LABEL: Record<SeatMode, string> = { default: "Read-only / ask", acceptEdits: "Edit files", bypassPermissions: "Anything (no sandbox)" };
const LIVE = new Set(["requested", "queued", "running", "paused"]);
/** src/protocol/seats.ts SEATS_PREFIX (not imported: that module carries zod, which the dashboard doesn't bundle). */
const SEATS_PREFIX = "seats-";

/**
 * Reloads when a post lands in any seats channel (the live event stream), and every 2 s while a seat is live, else
 * every 10 s as a fallback.
 */
function useSeats(): { data: SeatsView | null; error: string | null; reload: () => void } {
  const { events } = useStore();
  const newest = events.find((e) => e.channel?.startsWith(SEATS_PREFIX))?.id ?? "";
  const [data, setData] = useState<SeatsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.seats().then((v) => { setData(v); setError(null); }).catch((err) => setError(friendlyError(err)));
  }, []);
  const live = !!data?.seats.some((s) => LIVE.has(s.state));
  useEffect(() => {
    reload();
    const t = setInterval(reload, live ? 2_000 : 10_000);
    return () => clearInterval(t);
  }, [reload, live]);
  useEffect(() => { if (newest) reload(); }, [newest, reload]);
  return { data, error, reload };
}

function ThisMachine({ local, hostname, onChange }: { local: SeatsLocalView; hostname: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const backlog = [...(local.quarantined ?? [])].sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  const reasons = new Map<string, number>();
  for (const name of backlog) {
    const why = local.quarantine_why?.[name] ?? "cleanup has not answered yet";
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }
  const act = async (allow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      // Allowing from here without a seat user is the person's explicit, warned choice (see the confirmation).
      await api.seatsConfig(allow && !local.ephemeral ? { allow, same_user: true } : { allow });
      setConfirm(false);
      onChange();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`seat-host-card${local.allow ? " is-on" : ""}`} aria-labelledby="seats-local-title">
      <header className="seat-host-head">
        <span className="source-avatar" aria-hidden="true"><Armchair size={16} strokeWidth={1.75} /></span>
        <h2 className="int-title" id="seats-local-title">This machine <span className="mono muted">{hostname}</span></h2>
        <span className={`int-status ${local.allow ? "is-on" : "is-off"}`}>{local.allow ? "Allowed" : "Off"}</span>
      </header>
      {backlog.length ? (
        // Shown whether seats are on or off (Codex r6 MEDIUM 8): turning seats off is exactly when this matters.
        <div className="int-error" role="alert">
          <p>{backlog.length} seat user{backlog.length === 1 ? "" : "s"} awaiting cleanup. Walkie retries with backoff; live seat cleanup takes priority. <span className="mono">{backlog.slice(0, 5).join(", ")}{backlog.length > 5 ? " …" : ""}</span></p>
          {[...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([why, count]) => (
            <p key={why} className="mono">{count} × {why}</p>
          ))}
          <p>If one stays, see <a href="https://github.com/alexcarney460-hue/walkie/blob/main/docs/INSTALL.md#8-remote-seats-optional" target="_blank" rel="noopener noreferrer">seat troubleshooting</a>.</p>
        </div>
      ) : null}
      {local.allow ? (
        <>
          <dl className="int-facts">
            <div><dt>Launchers</dt><dd>{local.launcher_policy_empty ? "Nobody" : local.launchers.length ? <span className="mono">{local.launchers.join(", ")}</span> : local.launchers_default === false ? "Nobody" : "The team's owners and their agents"}</dd></div>
            <div><dt>Runtimes</dt><dd>{local.runtimes.join(", ")}</dd></div>
            <div><dt>Running</dt><dd className="tnum">{local.running}{local.max ? ` of ${local.max}` : ""}</dd></div>
            <div><dt>Directory</dt><dd className="mono truncate">{local.ephemeral ? "~<its seat user>/walkie-seats" : local.dir}</dd></div>
            <div><dt>Runs as</dt><dd>{local.ephemeral ? "A fresh user per seat" : <span className="seat-as-me">Your own user</span>}</dd></div>
          </dl>
          <p className="field-hint">A person entry covers their agents on the listed machines. An exact agent entry covers only that agent.</p>
          {local.ambiguous_launchers?.map((entry) => (
            <p className="int-error" role="alert" key={entry}>{entry} matches multiple admitted machines and allows none of them. Rename one machine or use @{entry.slice(1).split("/")[0]}.</p>
          ))}
          {local.disabled_reason && (
            <p className="int-error" role="alert">Allowed, but no seat runs: {local.disabled_reason}</p>
          )}
          {!local.disabled_reason && local.ephemeral && (
            <p className="field-hint">
              Each seat runs as a fresh OS user, made for it and removed after it: it can't reach your Walkie{local.readable_home ? "" : ", your home"}, another seat or a later one, and stop, deny and busy act on every process of its user.
              It can reach the network, its own home and what seats are handed (your Claude/Codex sign-in).
            </p>
          )}
          {local.helper_version?.problem && (
            <p className={local.helper_version.state === "stale" ? "int-error" : "field-hint"} role={local.helper_version.state === "stale" ? "alert" : undefined}>
              {local.helper_version.problem.charAt(0).toUpperCase() + local.helper_version.problem.slice(1)}: <span className="mono">walkie seats setup-user --apply</span> reinstalls it.
            </p>
          )}
          {!local.disabled_reason && local.readable_home && (
            <p className="int-error" role="alert">Your home is open to other users and you accepted that: seat users can read what it shows them. <span className="mono">chmod 700 ~</span> closes it.</p>
          )}
          <p className="field-hint">
            {local.claude_login === "dedicated"
              ? "Claude seats use the token set for seats only; a running seat can read it."
              : local.claude_login === "unavailable"
              ? <>This machine has no usable Claude access token or it is near expiry. Use Claude Code here to refresh its login; <span className="mono">walkie seats token set</span> is an optional override.</>
              : local.ephemeral
                ? <>Claude seats use this machine's Claude subscription; a running seat can read this machine's short-lived Claude access token, never the refresh token. <span className="mono">walkie seats token set</span> is an optional override.</>
                : "Claude seats run as your user and can read everything you can, including your full Claude login."}
            {local.codex_login === "unavailable"
              ? <> Codex seats need this machine signed in to Codex where seat users can use it: <span className="mono">codex login</span>.</>
              : local.codex_login === "machine" ? " Codex seats run on this machine's own Codex sign-in." : null}
            {" "}<span className="mono">walkie seats doctor</span> checks all of it.
          </p>
          {!local.disabled_reason && !local.ephemeral && (
            <p className="field-hint">Seats run as your OS user, so a seat can reach your Walkie and your files. Give them users of their own: <span className="mono">walkie seats setup-user --apply</span></p>
          )}
          {!local.channel_ok && <p className="int-error" role="alert">The seats channel isn't ready: {local.channel_error ?? "waiting for the roster authority"}. Nothing runs until it is.</p>}
          <div className="form-actions">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void act(false)}>
              {busy ? "Turning off…" : local.running ? `Turn off and stop ${local.running} seat${local.running === 1 ? "" : "s"}` : "Turn off"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="int-blurb">
            Let the team's owners and their agents start Claude Code or Codex agents on this machine.{" "}
            {local.ephemeral
              ? "Each seat runs as a fresh OS user of its own, made for it and removed after it, on this machine's sign-in (or a token set for seats), and streams its work back to them."
              : "Seats would run as your own OS user, on your own sign-in, in a fresh directory, and stream their work back to them (give them users of their own first: walkie seats setup-user --apply)."}
          </p>
          {confirm ? (
            <div className="seat-warn" role="alert">
              <ShieldAlert size={16} strokeWidth={1.75} aria-hidden="true" />
              <div>
                {local.ephemeral ? (
                  <p><strong>This is remote code execution, on purpose.</strong> Each seat runs as a fresh OS user, made for it and removed after it, apart from your Walkie, your home and the other seats. Turn them off any time; that stops every running seat.</p>
                ) : (
                  <p><strong>This is remote code execution, on purpose, as your own user.</strong> A seat can read and change anything your user can on this machine, including acting as you in Walkie. Only allow trusted launchers: Grok credential path denies and output checks cannot remove this access. Give seats users of their own first (<span className="mono">walkie seats setup-user --apply</span>). Turn them off any time; that stops every running seat.</p>
                )}
                {local.claude_login === "dedicated" ? (
                  <p>Claude seats use the token set for seats only; a running seat can read it.</p>
                ) : local.claude_login === "unavailable" ? (
                  <p>This machine has no usable Claude access token or it is near expiry. Use Claude Code here to refresh its login; <span className="mono">walkie seats token set</span> is an optional override.</p>
                ) : local.ephemeral ? (
                  <p>Claude seats use this machine's Claude subscription; a running seat can read this machine's short-lived Claude access token, never the refresh token. <span className="mono">walkie seats token set</span> is an optional override.</p>
                ) : (
                  <p>Claude seats run as your user and can read everything you can, including your full Claude login.</p>
                )}
                <div className="form-actions">
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(true)}>{busy ? "Allowing…" : local.ephemeral ? "Allow seats" : "Allow as my user"}</button>
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
                </div>
              </div>
            </div>
          ) : local.pool_conflict ? (
            // Seats and compute sharing never on together (Opus seats r9 HIGH): the daemon refuses; say what to turn off.
            <p className="int-error" role="alert">{local.pool_conflict}</p>
          ) : (
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => setConfirm(true)}>Allow seats on this machine…</button>
            </div>
          )}
          <p className="field-hint">To name who may launch, use the CLI: <span className="mono">walkie seats allow --launchers @alex</span>. A person entry covers their agents; an exact agent entry covers only that agent.</p>
        </>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
    </article>
  );
}

function LaunchForm({ hosts, onLaunched }: { hosts: SeatHostView[]; onLaunched: () => void }) {
  const [machine, setMachine] = useState(hosts[0]?.node ?? "");
  const [runtime, setRuntime] = useState<SeatRuntime>("claude");
  const [mode, setMode] = useState<SeatMode>("acceptEdits");
  const [model, setModel] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [count, setCount] = useState(1);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!hosts.some((h) => h.node === machine)) setMachine(hosts[0]?.node ?? ""); }, [hosts, machine]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || !machine) { setError("Write what the seat should do."); return; }
    setBusy(true);
    setError(null);
    let started = 0;
    try {
      // "Start N agents there" (as walkie seats start --count N): one request each, stopping at the first refusal.
      for (let i = 0; i < Math.min(10, Math.max(1, count)); i++) {
        await api.seatRun({ machine, runtime, permission_mode: mode, prompt: prompt.trim(), timeout_s: Math.max(1, minutes) * 60,
          ...(runtime === "grok" ? { v: 2 as const } : {}), ...(model.trim() ? { model: model.trim() } : {}) });
        started++;
      }
      setPrompt("");
      onLaunched();
    } catch (err) {
      setError(`${started ? `${started} started, then: ` : ""}${friendlyError(err)}`);
      if (started) onLaunched();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form seat-launch" onSubmit={submit} noValidate>
      <div className="seat-launch-row">
        <div className="field">
          <label htmlFor="seat-machine">Machine</label>
          <select id="seat-machine" className="select" value={machine} onChange={(e) => setMachine(e.target.value)}>
            {hosts.map((h) => (
              <option key={h.node} value={h.node}>
                {h.hostname} (@{h.handle}){h.online ? "" : " · offline"}{h.availability?.state === "busy" ? ` · busy${h.availability.until ? ` until ${clockTime(h.availability.until)}` : ""} (launches queue)` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="field-label" id="seat-runtime-label">Runtime</span>
          <div className="seg" role="radiogroup" aria-labelledby="seat-runtime-label">
            {(["claude", "codex", "grok"] as const).map((r) => (
              <button key={r} type="button" role="radio" aria-checked={runtime === r} className={runtime === r ? `seg-btn rt-seg rt-${r} is-on` : `seg-btn rt-seg rt-${r}`} onClick={() => setRuntime(r)}>
                {r === "claude" ? "Claude Code" : r === "codex" ? "Codex" : "Grok"}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="seat-mode">May</label>
          <select id="seat-mode" className="select" value={mode} onChange={(e) => setMode(e.target.value as SeatMode)}>
            {(Object.keys(MODE_LABEL) as SeatMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="seat-model">Model <span className="muted">(optional)</span></label>
          <input id="seat-model" className="input mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" autoComplete="off" spellCheck={false} />
        </div>
        <div className="field seat-minutes">
          <label htmlFor="seat-count">How many</label>
          <input id="seat-count" className="input tnum" type="number" min={1} max={10} value={count} onChange={(e) => setCount(Math.min(10, Math.max(1, Number(e.target.value) || 1)))} />
        </div>
        <div className="field seat-minutes">
          <label htmlFor="seat-minutes">Limit (min)</label>
          <input id="seat-minutes" className="input tnum" type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 60)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="seat-prompt">Task</label>
        <textarea id="seat-prompt" className="textarea seat-prompt-input" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the seat do? It starts in a fresh directory; to work on a repo, launch from the CLI with --repo." />
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !machine}>
          <Play size={13} strokeWidth={1.75} aria-hidden="true" />{busy ? "Starting…" : count > 1 ? `Start ${count} seats` : "Start seat"}
        </button>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
    </form>
  );
}

function SeatCard({ seat, onChange }: { seat: SeatView; onChange: () => void }) {
  const opts = useMdOpts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = LIVE.has(seat.state);
  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.seatStop(seat.id);
      onChange();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };
  const launcher = `@${[seat.launcher.handle, seat.launcher.agent ? seat.launcher.hostname : null, seat.launcher.agent].filter(Boolean).join("/")}`;
  return (
    <article className={`seat-card state-${seat.state} rt-${seat.runtime}`} aria-labelledby={`seat-${seat.id}`}>
      <header className="seat-head">
        <h3 className="seat-title" id={`seat-${seat.id}`}>
          {seat.runtime === "claude" ? "Claude Code" : seat.runtime === "codex" ? "Codex" : seat.runtime === "kimi" ? "Kimi" : "Grok"}{seat.model ? <span className="mono muted"> {seat.model}</span> : null}
          <span className="muted"> on </span><span className="mono">{seat.host.hostname}</span>
        </h3>
        <span className={`seat-state is-${seat.state}`}>{STATE_LABEL[seat.state]}</span>
      </header>
      <p className="seat-meta muted">
        by <span className="mono">{launcher}</span> · {MODE_LABEL[seat.permission_mode]} · <RelTime ts={seat.requested_at} long />
        {seat.dir ? <> · <span className="mono">{seat.dir}</span></> : null}
      </p>
      <details className="seat-prompt" open={seat.prompt.length < 400}>
        <summary>Task</summary>
        <p className="seat-prompt-text">{seat.prompt}</p>
      </details>
      {seat.output.length > 0 && (
        <div className="seat-output" aria-live={live ? "polite" : undefined}>
          {seat.output.map((o) => (
            <MessageBoundary key={o.id} text={o.text}>
              <div className="seat-chunk"><RichMarkdown text={o.text} opts={opts} /></div>
            </MessageBoundary>
          ))}
        </div>
      )}
      {(seat.state === "queued" || seat.state === "paused") && (
        <p className="seat-held" role="status">
          {seat.state === "queued" ? "Queued" : "Paused"}: {seat.host.hostname}'s person is using it{seat.until ? ` until ${clockTime(seat.until)}` : ""}.
          {seat.state === "queued" ? " It starts when they're done." : " It continues where it stopped when they're done."}
        </p>
      )}
      {live && !seat.output.length && (seat.state === "requested" || seat.state === "running") && (
        <p className="seat-waiting muted" role="status">{seat.state === "requested" ? "Waiting for the host…" : "Working…"}</p>
      )}
      {LIVE.has(seat.state) && seat.state !== "queued" && seat.state !== "paused" && seat.reason && seat.reason !== "resumed" && (
        // A live seat's control failure ("could not be paused", "could not verify that it resumed"): Codex r7 MEDIUM 6.
        <p className="seat-end is-bad" role="status">{seat.reason}</p>
      )}
      {!LIVE.has(seat.state) && (seat.reason || seat.commits || seat.dirty) && (
        <p className={`seat-end${seat.state === "failed" || seat.state === "refused" || seat.state === "timeout" ? " is-bad" : ""}`}>
          {[seat.reason, seat.exit_code !== undefined && seat.exit_code !== null && seat.state !== "done" ? `exit ${seat.exit_code}` : "", seat.dirty ? (seat.dir?.startsWith("~walkie-s") ? `${seat.dirty} uncommitted file${seat.dirty === 1 ? "" : "s"} discarded with its seat user` : `${seat.dirty} uncommitted file${seat.dirty === 1 ? "" : "s"} left on the host`) : ""].filter(Boolean).join(" · ")}
        </p>
      )}
      <div className="seat-actions">
        {seat.result_bundle && (
          // Fetched with the dashboard session (SEC-COOKIE-2: a plain link carries no credential).
          <button type="button" className="btn btn-sm" onClick={() => { const h = seat.result_bundle as string; void api.download(h, `seat-${seat.id.replace(":", "-")}.bundle`).catch((err: unknown) => setError(friendlyError(err))); }}>
            <Download size={13} strokeWidth={1.75} aria-hidden="true" />{seat.commits ?? 0} commit{seat.commits === 1 ? "" : "s"} (git bundle)
          </button>
        )}
        {live && (
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void stop()}>
            <Square size={12} strokeWidth={2} aria-hidden="true" />{busy ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      {seat.result_bundle && <CopyCommand command={`walkie seat fetch ${seat.id} -o seat.bundle && git fetch seat.bundle HEAD`} />}
      {error && <p className="field-error" role="alert">{error}</p>}
    </article>
  );
}

/** "2 running · 1 paused · 1 queued" (the non-zero held counts only). */
function seatCounts(seats: SeatView[]): string {
  const n = (st: SeatView["state"]) => seats.filter((s) => s.state === st).length;
  const running = n("running") + n("requested");
  return [`${running} running`, n("paused") ? `${n("paused")} paused` : "", n("queued") ? `${n("queued")} queued` : ""].filter(Boolean).join(" · ");
}

export function Seats() {
  const { me } = useStore();
  const { data, error, reload } = useSeats();
  // On my own machine I know its launchers (the owners by default); elsewhere, being in the seats channel says it.
  const launchable = useMemo(() => (data?.hosts ?? []).filter((h) => {
    if (!h.member || !h.allows) return false;
    if (!h.self || !data || !me) return true;
    const list = data.local.launchers.map((l) => l.replace(/^@/, ""));
    if (!list.length) return me.role === "owner";
    return !!me.handle && (list.includes(me.handle) || list.includes(`${me.handle}/${me.node.hostname}`));
  }), [data, me]);
  const others = useMemo(() => (data?.hosts ?? []).filter((h) => !h.self), [data]);
  return (
    <div className="page">
      <PageHeader
        title="Seats"
        meta={<>Agents that run on a teammate's machine, on that machine's own Claude or Codex sign-in, when its person allows it. Everything travels through the machine's private seats channel.</>}
      />
      {error && !data && <ErrorState message={error} onRetry={reload} />}
      {!data && !error && <SkeletonRows rows={3} />}
      {data && (
        <div className="seats-grid">
          <div className="seats-main">
            <Section title="Start a seat" id="seat-launch-h">
              {launchable.length ? <LaunchForm hosts={launchable} onLaunched={reload} /> : (
                <EmptyState icon={<Armchair size={18} strokeWidth={1.75} />} title="No machine takes seats from you yet">
                  <p>A teammate turns seats on for their machine; the team's owners can then start agents there.</p>
                  <CopyCommand command="walkie seats allow" label="On their machine" />
                </EmptyState>
              )}
            </Section>
            <Section title="Seats" meta={data.seats.length ? seatCounts(data.seats) : undefined} id="seat-list-h">
              {data.seats.length ? (
                <div className="seat-list">{data.seats.map((s) => <SeatCard key={s.id} seat={s} onChange={reload} />)}</div>
              ) : <p className="panel-empty">No seats yet.</p>}
            </Section>
          </div>
          <div className="seats-side">
            {data.local.allow && <BusyCard local={data.local} onChange={reload} />}
            <ThisMachine local={data.local} hostname={me?.node.hostname ?? "this machine"} onChange={reload} />
            <AgentAdminCard />
            <Section title="Machines" id="seat-hosts-h">
              {others.length ? (
                <ul className="seat-hosts">
                  {others.map((h) => (
                    <li key={h.node} className="seat-host-row">
                      <span className={`dot ${h.online ? "dot-on" : "dot-off"}`} aria-label={h.online ? "online" : "offline"} />
                      <span className="mono">{h.hostname}</span>
                      <span className="muted">@{h.handle}</span>
                      {h.allows && h.availability?.state === "busy" ? (
                        <span className="seat-host-tag is-busy" title={`${busyCounts(h.availability)} · launches queue until its person is done`}>
                          Busy{h.availability.until ? ` until ${clockTime(h.availability.until)}` : ""}
                        </span>
                      ) : (
                        <span className={`seat-host-tag${h.allows ? "" : " is-off"}`}>{h.allows ? (h.member ? "You can launch" : "Allows seats") : "Seats off"}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : <p className="panel-empty">No other machine takes seats.</p>}
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}
