import { useEffect, useState, type FormEvent } from "react";
import { api, friendlyError } from "../../api/client.ts";
import type { Schedule } from "../../api/types.ts";

const TEMPLATES = [
  ["board-refresh", "Board refresh"],
  ["machine-onboarding", "Machine onboarding"],
  ["project-sync", "Project sync"],
  ["capacity-check", "Capacity check"],
  ["data-room-refresh", "Data room refresh"],
  ["project-reports", "Project status reports"],
  ["orchestration-poll", "Orchestration poll"],
  ["card-curation", "Card curation"],
] as const;

export function ScheduleItems({ schedules, onToggle, onRun }: { schedules: Schedule[]; onToggle: (s: Schedule) => void; onRun: (s: Schedule) => void }) {
  if (!schedules.length) return <p className="panel-empty">No schedules yet.</p>;
  return <ul aria-label="WalkieTalkie schedules">{schedules.map((s) => <li key={s.id} className="orch-card">
    <strong>{s.name}</strong> · <code>{s.cron}</code> · {s.enabled ? "Enabled" : "Paused"}
    <div>Next: {s.next_run ? new Date(s.next_run).toLocaleString() : "—"}</div>
    <div>Last: {s.last_run ? new Date(s.last_run).toLocaleString() : "Never"}</div>
    {s.last_result && <p>Result: {s.last_result}</p>}
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onToggle(s)}>{s.enabled ? "Pause" : "Resume"}</button>
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRun(s)}>Run now</button>
  </li>)}</ul>;
}

export function ScheduleLocalStatus({ status }: { status: string | null }) {
  return status ? <p role="status">{status}</p> : null;
}

export function SchedulesPanel() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 * * * *");
  const [template, setTemplate] = useState("board-refresh");
  const [prompt, setPrompt] = useState("");
  const [times, setTimes] = useState<number[]>([]);
  const [cronError, setCronError] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = () => api.schedules().then((r) => { setSchedules(r.schedules); setLocalStatus(r.status); setState("ready"); setError(""); }).catch((err) => { setState("error"); setError(friendlyError(err)); });
  useEffect(() => { void reload(); const timer = setInterval(() => void reload(), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => void api.scheduleNext(cron).then((r) => { if (current) { setTimes(r.times); setCronError(""); } })
      .catch((err) => { if (current) { setTimes([]); setCronError(friendlyError(err)); } }), 250);
    return () => { current = false; clearTimeout(timer); };
  }, [cron]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !times.length || busy) return;
    setBusy(true); setError("");
    try {
      await api.scheduleAdd({ name: name.trim(), cron, task: template === "free-form" ? { prompt: prompt.trim() } : { template: template as typeof TEMPLATES[number][0] } });
      setName(""); setPrompt(""); await reload();
    } catch (err) { setError(friendlyError(err)); }
    finally { setBusy(false); }
  }

  async function toggle(s: Schedule) {
    setBusy(true); setError("");
    try { await api.scheduleEdit(s.id, { enabled: !s.enabled }); await reload(); }
    catch (err) { setError(friendlyError(err)); }
    finally { setBusy(false); }
  }
  async function run(s: Schedule) {
    setBusy(true); setError("");
    try { await api.scheduleRunNow(s.id); await reload(); }
    catch (err) { setError(friendlyError(err)); }
    finally { setBusy(false); }
  }

  return <section className="orch-card" aria-labelledby="talkie-schedules-heading">
    <h2 id="talkie-schedules-heading">Schedules</h2>
    {state === "loading" && <p>Loading schedules…</p>}
    {state === "error" && <button type="button" onClick={() => void reload()}>Retry schedules: {error}</button>}
    {state === "ready" && <ScheduleLocalStatus status={localStatus} />}
    {state === "ready" && <ScheduleItems schedules={schedules} onToggle={(s) => void toggle(s)} onRun={(s) => void run(s)} />}
    {error && state !== "error" && <p role="alert">{error}</p>}
    <form onSubmit={(e) => void add(e)}>
      <h3>Add schedule</h3>
      <label>Name <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Task <select value={template} onChange={(e) => setTemplate(e.target.value)}>
        {TEMPLATES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        <option value="free-form">Free-form instruction</option>
      </select></label>
      {template === "free-form" && <label>Instruction <textarea value={prompt} maxLength={8_000} onChange={(e) => setPrompt(e.target.value)} required /></label>}
      <label>Cron (minute hour day month weekday) <input value={cron} onChange={(e) => setCron(e.target.value)} required /></label>
      {cronError ? <p role="alert">{cronError}</p> : <p>Next three runs: {times.map((t) => new Date(t).toLocaleString()).join(" · ") || "Checking…"}</p>}
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !times.length || (template === "free-form" && !prompt.trim())}>Add schedule</button>
    </form>
  </section>;
}
