// "Switch from Linear" (LINEAR-IMPORT-1): connect (the Linear integration's key, or a key file), a dry-run plan the
// person edits (projects and issues ticked, relevance flags), the import with live progress, then keeping Walkie in
// sync while the team switches. Every write here is a person's (the dashboard session); the daemon does the work.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, RefreshCw, X } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import type { ImportOptions, ImportPlan, ImportPlanProject, ImportSelection, ImportStatus, JobView, SyncResult } from "../../api/types.ts";
import { hrefFor } from "../../lib/route.ts";
import { projectsStore } from "../../state/projects.ts";

type Step = "connect" | "plan" | "run" | "sync";
const STEPS: Array<[Step, string]> = [["connect", "Connect"], ["plan", "Plan"], ["run", "Import"], ["sync", "Keep in sync"]];
const COLS = [["backlog", "Backlog"], ["todo", "To do"], ["doing", "In progress"], ["review", "In review"], ["done", "Done"], ["canceled", "Canceled"]] as const;

const FLAG_TEXT: Record<string, string> = {
  completed: "completed in Linear", canceled: "canceled in Linear", stale: "no recent updates", exists: "imported before", name_taken: "name in use",
  over_board_cap: "over 2,000 open", empty: "no open issues", no_project: "issues without a project", imported: "imported before",
  adopted: "from an earlier import", linear_duplicate: "duplicate in Linear",
};
function flagText(f: string): string {
  const [k, v] = f.split(":") as [string, string | undefined];
  if (k === "adopt") return `${v} cards from an earlier import`;
  if (k === "duplicate_of") return `looks like ${v}`;
  return FLAG_TEXT[k] ?? k;
}
const WARN = new Set(["completed", "canceled", "stale", "empty", "over_board_cap", "name_taken", "duplicate_of", "linear_duplicate"]);

function running(j: JobView | null | undefined): boolean { return !!j && (j.state === "running" || j.state === "waiting"); }

/** The run's input: the plan's projects with what the person ticked. */
export function selectionOf(plan: ImportPlan, on: ReadonlyMap<string, boolean>, off: ReadonlySet<string>): ImportSelection {
  return {
    v: 1, options: plan.options,
    projects: plan.projects.map((p) => ({
      key: p.key, include: on.get(p.key) ?? p.include, name: p.name, prefix: p.prefix, folder: p.folder, target: p.target?.channel ?? null,
      exclude: p.issues.filter((i) => off.has(i.id)).map((i) => i.id),
    })),
  };
}

function Flags({ flags }: { flags: readonly string[] }) {
  if (!flags.length) return null;
  return <span className="li-flags">{flags.map((f) => <span key={f} className={`chip${WARN.has(f.split(":")[0] as string) ? " chip-amber" : ""}`}>{flagText(f)}</span>)}</span>;
}

export function ProjectRows({ p, on, off, open, setOn, toggleIssue, setOpen }: {
  p: ImportPlanProject; on: boolean; off: ReadonlySet<string>; open: boolean;
  setOn: (v: boolean) => void; toggleIssue: (id: string, v: boolean) => void; setOpen: (v: boolean) => void;
}) {
  const kept = p.issues.filter((i) => !off.has(i.id));
  const count = (col: string) => kept.filter((i) => i.column === col).length;
  const stale = p.issues.filter((i) => i.flags.includes("stale")).length;
  const dups = p.issues.filter((i) => i.flags.some((f) => f.startsWith("duplicate_of:"))).length;
  const flags = [...p.flags, ...(stale ? [`stale:${stale}`] : []), ...(dups ? [`dups:${dups}`] : [])];
  return (
    <>
      <tr className={on ? "" : "is-off"}>
        <td className="li-check">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} aria-label={`Import ${p.name}`} />
        </td>
        <td className="mono li-prefix">{p.prefix}</td>
        <td className="li-name">
          <button type="button" className="li-expand" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!p.issues.length}>
            {open ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
            <span>{p.name}</span>
          </button>
          {p.target && <span className="muted li-target">into {p.target.prefix} (existing)</span>}
          <span className="li-flags-row">
            {flags.map((f) => {
              const [k, v] = f.split(":");
              const text = k === "stale" && v ? `${v} stale` : k === "dups" ? `${v} possible duplicate${v === "1" ? "" : "s"}` : flagText(f);
              return <span key={f} className={`chip${WARN.has(k as string) || k === "dups" ? " chip-amber" : ""}`}>{text}</span>;
            })}
          </span>
        </td>
        {COLS.map(([id]) => <td key={id} className="num tnum li-col-count">{count(id) || <span className="muted">–</span>}</td>)}
        <td className="num tnum li-col-total">{kept.length}</td>
      </tr>
      {open && (
        <tr className="li-issues-row">
          <td colSpan={COLS.length + 4}>
            <ul className="li-issues">
              {p.issues.slice(0, 300).map((i) => (
                <li key={i.id} className={off.has(i.id) ? "is-off" : ""}>
                  <label className="check">
                    <input type="checkbox" checked={!off.has(i.id)} onChange={(e) => toggleIssue(i.id, e.target.checked)} />
                    <span className="mono muted">{i.identifier}</span>
                    <span className="li-issue-title">{i.title}</span>
                  </label>
                  <span className="chip">{COLS.find(([id]) => id === i.column)?.[1] ?? i.column}</span>
                  <Flags flags={i.flags} />
                </li>
              ))}
              {p.issues.length > 300 && <li className="muted">… {p.issues.length - 300} more (edit them in the plan file: walkie import linear --dry-run)</li>}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

export function LinearImport({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [step, setStep] = useState<Step>("connect");
  const [keyFile, setKeyFile] = useState("");
  const [opts, setOpts] = useState<Partial<ImportOptions>>({ include_closed: false, folder_by: "initiative", skip_stale: false, skip_duplicates: false });
  const [since, setSince] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [on, setOnMap] = useState<Map<string, boolean>>(new Map());
  const [off, setOff] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncResult | null>(null);
  const [twoWay, setTwoWay] = useState(false);
  const [schedule, setSchedule] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.linearImportStatus();
      setStatus(s);
      setTwoWay(s.sync.two_way);
      setSchedule(s.sync.enabled);
      if (running(s.job)) { setJob(s.job); setStep("run"); }
    } catch (err) {
      setError(friendlyError(err));
    }
  }, []);
  useEffect(() => { void load(); closeRef.current?.focus(); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Live progress while the import runs.
  useEffect(() => {
    if (step !== "run" || !running(job)) return;
    const t = setInterval(async () => {
      try {
        const s = await api.linearImportStatus();
        setStatus(s);
        if (s.job) setJob(s.job);
        if (s.job && !running(s.job)) { void projectsStore.refresh(); if (s.job.state === "done") setStep("sync"); }
      } catch { /* the next tick retries */ }
    }, 1_000);
    return () => clearInterval(t);
  }, [step, job]);

  const keyOk = !!status?.integration || keyFile.trim().length > 0;
  const buildPlan = async () => {
    setBusy(true);
    setError(null);
    try {
      const { plan: p } = await api.linearImportPlan({ ...opts, ...(since ? { since } : {}) }, status?.integration ? undefined : keyFile.trim());
      setPlan(p);
      setOnMap(new Map(p.projects.map((x) => [x.key, x.include])));
      setOff(new Set(p.projects.flatMap((x) => x.issues.filter((i) => !i.include).map((i) => i.id))));
      setStep("plan");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const chosen = useMemo(() => {
    if (!plan) return { projects: 0, cards: 0, updates: 0 };
    let projects = 0; let cards = 0; let updates = 0;
    for (const p of plan.projects) {
      if (!(on.get(p.key) ?? p.include)) continue;
      projects++;
      for (const i of p.issues) if (!off.has(i.id)) { if (i.existing) updates++; else cards++; }
    }
    return { projects, cards, updates };
  }, [plan, on, off]);

  const start = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const { job: j } = await api.linearImportRun(selectionOf(plan, on, off), status?.integration ? undefined : keyFile.trim());
      setJob(j);
      setStep("run");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const { result } = await api.linearSync(twoWay, status?.integration || status?.sync.key_file ? undefined : keyFile.trim() || undefined);
      setSync(result);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const saveSchedule = async (enabled: boolean, two: boolean) => {
    setError(null);
    try {
      const { sync: s } = await api.linearSyncSettings({ enabled, two_way: two, ...(enabled && !status?.integration && keyFile.trim() ? { key_file: keyFile.trim() } : {}) });
      setSchedule(s.enabled);
      setTwoWay(s.two_way);
      setStatus((x) => (x ? { ...x, sync: s } : x));
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const pct = job && job.projects_total ? Math.round((job.projects_done / job.projects_total) * 100) : 0;
  const folders = plan ? [...new Set(plan.projects.map((p) => p.folder))] : [];

  return (
    <div className="palette-layer" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="palette dialog li-dialog" role="dialog" aria-modal="true" aria-labelledby="li-title">
        <header className="dialog-head">
          <h2 id="li-title" className="dialog-title">Switch from Linear</h2>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close"><X size={15} strokeWidth={1.75} /></button>
        </header>
        <ol className="li-steps" aria-label="Steps">
          {STEPS.map(([id, label], n) => (
            <li key={id} className={id === step ? "is-on" : STEPS.findIndex(([x]) => x === step) > n ? "is-done" : ""} aria-current={id === step ? "step" : undefined}>
              <span className="li-step-n">{STEPS.findIndex(([x]) => x === step) > n ? <Check size={11} strokeWidth={2.5} /> : n + 1}</span>{label}
            </li>
          ))}
        </ol>
        <div className="dialog-body li-body">
          {step === "connect" && (
            <>
              <p className="muted">Every Linear project becomes a Walkie project with its issues as cards: columns, labels, assignees, estimates, due dates, parents, and each issue's history and comments. Nothing is written until you review the plan.</p>
              {status?.integration ? (
                <p className="li-ok"><Check size={14} strokeWidth={2} /> Using the Linear integration's key.</p>
              ) : (
                <div className="field">
                  <label htmlFor="li-key">Linear API key file</label>
                  <input id="li-key" className="input mono" value={keyFile} onChange={(e) => setKeyFile(e.target.value)} placeholder="~/keys/linear.txt" autoComplete="off" spellCheck={false} />
                  <span className="field-hint">A file holding your personal API key, readable by you only (chmod 600). Or turn the Linear integration on under Integrations.</span>
                </div>
              )}
              <div className="dialog-row">
                <div className="field">
                  <label htmlFor="li-since">Issues updated in</label>
                  <select id="li-since" className="input" value={since} onChange={(e) => setSince(e.target.value)}>
                    <option value="">Any time</option><option value="30d">The last 30 days</option><option value="45d">The last 45 days</option>
                    <option value="90d">The last 90 days</option><option value="180d">The last 180 days</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="li-folder">Folders from</label>
                  <select id="li-folder" className="input" value={opts.folder_by} onChange={(e) => setOpts({ ...opts, folder_by: e.target.value as "initiative" | "team" })}>
                    <option value="initiative">Linear initiatives (else the team)</option><option value="team">Linear teams</option>
                  </select>
                </div>
              </div>
              <label className="check"><input type="checkbox" checked={!!opts.include_closed} onChange={(e) => setOpts({ ...opts, include_closed: e.target.checked })} /><span>Include done and canceled issues (canceled ones arrive archived)</span></label>
              <label className="check"><input type="checkbox" checked={!!opts.skip_stale} onChange={(e) => setOpts({ ...opts, skip_stale: e.target.checked })} /><span>Leave out backlog items nobody touched in 60 days</span></label>
              <label className="check"><input type="checkbox" checked={!!opts.skip_duplicates} onChange={(e) => setOpts({ ...opts, skip_duplicates: e.target.checked })} /><span>Leave out likely duplicates (same or nearly the same title)</span></label>
            </>
          )}

          {step === "plan" && plan && (
            <>
              <p className="li-summary">
                <strong>{chosen.projects}</strong> of {plan.projects.length} projects · <strong>{chosen.cards}</strong> new cards{chosen.updates ? <> · <strong>{chosen.updates}</strong> updates</> : null}
                {plan.unmapped_users.length > 0 && <span className="muted"> · {plan.unmapped_users.length} Linear assignee{plan.unmapped_users.length === 1 ? "" : "s"} not on the team (kept in the card text)</span>}
              </p>
              <div className="table-wrap li-table-wrap">
                <table className="table li-table">
                  <thead>
                    <tr>
                      <th scope="col" className="li-check"><span className="sr-only">Import</span></th>
                      <th scope="col">Key</th><th scope="col">Project</th>
                      {COLS.map(([id, label]) => <th key={id} scope="col" className="num li-col-count">{label}</th>)}
                      <th scope="col" className="num li-col-total">Cards</th>
                    </tr>
                  </thead>
                  {folders.map((f) => (
                    <tbody key={f}>
                      <tr className="li-folder"><th colSpan={COLS.length + 4} scope="colgroup">{f || "No folder"}</th></tr>
                      {plan.projects.filter((p) => p.folder === f).map((p) => (
                        <ProjectRows key={p.key} p={p} on={on.get(p.key) ?? p.include} off={off} open={open === p.key}
                          setOn={(v) => setOnMap(new Map(on).set(p.key, v))} setOpen={(v) => setOpen(v ? p.key : null)}
                          toggleIssue={(id, v) => { const next = new Set(off); if (v) next.delete(id); else next.add(id); setOff(next); }} />
                      ))}
                    </tbody>
                  ))}
                </table>
              </div>
            </>
          )}

          {step === "run" && job && (
            <div className="li-progress" aria-live="polite">
              <div className="li-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Import progress"><span style={{ width: `${pct}%` }} /></div>
              <p><strong>{job.projects_done}</strong> of {job.projects_total} projects · <strong>{job.created}</strong> cards created · {job.updated} updated · {job.comments} history comments</p>
              <p className="muted">{job.state === "waiting" && job.waiting_until ? "Waiting for the import budget to refill…" : job.current ? `Now: ${job.current}` : job.state}</p>
              {job.errors.length > 0 && <ul className="li-errors">{job.errors.slice(0, 8).map((e, i) => <li key={i} className="field-error">{e.project ? `${e.project}: ` : ""}{e.message}</li>)}</ul>}
            </div>
          )}

          {step === "sync" && (
            <>
              {job && (
                <p className="li-ok"><Check size={14} strokeWidth={2} /> Imported {job.created} cards into {job.projects.length} project{job.projects.length === 1 ? "" : "s"} in {Math.max(1, Math.round(((job.finished_at ?? Date.now()) - job.started_at) / 1000))} s ({job.events} signed posts).</p>
              )}
              {job && job.projects.length > 0 && (
                <ul className="li-done-list">
                  {job.projects.slice(0, 12).map((p) => <li key={p.channel}><a href={hrefFor({ view: "projects", channel: p.channel })} onClick={onClose}><span className="mono">{p.prefix}</span> {p.name}</a>{!p.created && <span className="muted"> (existing)</span>}</li>)}
                  {job.projects.length > 12 && <li className="muted">… and {job.projects.length - 12} more</li>}
                </ul>
              )}
              <p className="muted">While your team switches, keep Walkie current: new Linear issues become cards, and moves and renames in Linear reach the cards. When both sides changed, the latest change wins and the card gets a note.</p>
              <label className="check"><input type="checkbox" checked={schedule} onChange={(e) => void saveSchedule(e.target.checked, twoWay)} /><span>Sync every 10 minutes {status?.integration ? "(with the Linear integration's key)" : "(needs the key file above, or the Linear integration)"}</span></label>
              <label className="check"><input type="checkbox" checked={twoWay} onChange={(e) => { setTwoWay(e.target.checked); if (schedule) void saveSchedule(true, e.target.checked); }} /><span>Two-way: moving an imported card in Walkie sets the Linear issue's state (only the state; titles and the rest stay one-way)</span></label>
              {sync && <p className="li-ok"><Check size={14} strokeWidth={2} /> Synced: {sync.read} issues read, {sync.created} new cards, {sync.updated} updated, {sync.conflicts} conflict{sync.conflicts === 1 ? "" : "s"} noted{sync.two_way ? `, ${sync.to_linear} Linear state${sync.to_linear === 1 ? "" : "s"} set` : ""}.</p>}
              {status?.sync.last_error && !sync && <p className="field-error">Last sync: {status.sync.last_error}</p>}
            </>
          )}
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
        <footer className="dialog-foot">
          {step === "connect" && <><button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary btn-sm" disabled={busy || !keyOk} onClick={() => void buildPlan()}>{busy ? "Reading Linear…" : "Build the plan"}</button></>}
          {step === "plan" && <><button type="button" className="btn btn-sm" onClick={() => setStep("connect")} disabled={busy}>Back</button><button type="button" className="btn btn-primary btn-sm" disabled={busy || !chosen.projects} onClick={() => void start()}>{busy ? "Starting…" : `Import ${chosen.projects} project${chosen.projects === 1 ? "" : "s"}`}</button></>}
          {step === "run" && <button type="button" className="btn btn-sm" disabled={!running(job)} onClick={() => void api.linearImportCancel().then((r) => r.job && setJob(r.job))}>Stop</button>}
          {step === "sync" && <><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void syncNow()}><RefreshCw size={13} strokeWidth={2} />{busy ? "Syncing…" : "Sync now"}</button><button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Done</button></>}
        </footer>
      </section>
    </div>
  );
}
