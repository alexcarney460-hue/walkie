import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AudioLines, ListTodo, NotebookPen, RefreshCw } from "lucide-react";
import { ApiError, api, friendlyError } from "../api/client.ts";
import type { IntegrationView } from "../api/types.ts";
import { PageHeader } from "../components/Shell.tsx";
import { ErrorState, RelTime, SkeletonRows } from "../components/primitives.tsx";
import { useStore } from "../state/store.tsx";

const ABOUT: Record<IntegrationView["id"], { icon: typeof ListTodo; blurb: string; keyHint?: string; keyPlaceholder?: string }> = {
  fireflies: {
    icon: AudioLines,
    blurb: "Each new Fireflies meeting becomes one post: summary, action items (teammates named get an @mention) and the full transcript attached.",
    keyHint: "Fireflies → Settings → Developer settings → API key.",
    keyPlaceholder: "~/keys/fireflies-api.txt",
  },
  wispr: {
    icon: NotebookPen,
    blurb: "Meetings recorded by the Wispr Flow app on this Mac are posted when they finish, with the transcript attached. Shared notes.wisprflow.ai links posted anywhere get an excerpt reply.",
  },
  linear: {
    icon: ListTodo,
    blurb: "Agent task chips show the issue title and state, state changes of the issues your agents work on are posted, and walkie linear create files an issue from any thread.",
    keyHint: "Linear → Settings → Security & access → Personal API keys.",
    keyPlaceholder: "~/keys/linear-api.txt",
  },
};

function StatusLine({ v }: { v: IntegrationView }) {
  // Enabling waits for the roster authority (offline: the request is queued; it turns on when accepted).
  if (!v.enabled && v.settings.pending_enable === true) return <span className="int-status is-off" title="Waiting for the roster authority to accept the integration (it is offline); it turns on once it does.">Queued</span>;
  if (!v.enabled) return <span className="int-status is-off">Off</span>;
  if (v.running) return <span className="int-status is-running">Syncing…</span>;
  if (v.last_error) return <span className="int-status is-error">Error</span>;
  return <span className="int-status is-on">On</span>;
}

function Facts({ v }: { v: IntegrationView }) {
  return (
    <dl className="int-facts">
      <div><dt>Channel</dt><dd className="mono">#{v.channel}</dd></div>
      <div><dt>Last sync</dt><dd>{v.last_ok ? <RelTime ts={v.last_ok} long /> : <span className="muted">never</span>}</dd></div>
      <div><dt>Posted</dt><dd className="tnum">{v.items_posted}</dd></div>
      <div>
        <dt>Key</dt>
        <dd className="truncate">
          {!v.needs_key ? <span className="muted">not needed</span>
            : v.key_source === "key_path" ? <span className="mono" title={v.key_path ?? undefined}>{v.key_path}</span>
            : v.key_source === "secret" ? "stored on this machine"
            : <span className="text-amber">not set</span>}
        </dd>
      </div>
    </dl>
  );
}

function IntegrationCard({ v, onChange, readOnly }: { v: IntegrationView; onChange: (next: IntegrationView | null) => void; readOnly: boolean }) {
  const { team } = useStore();
  const about = ABOUT[v.id];
  const Icon = about.icon;
  const [keyMode, setKeyMode] = useState<"path" | "paste">(v.key_source === "secret" ? "paste" : "path");
  const [keyPath, setKeyPath] = useState(v.key_path ?? "");
  const [key, setKey] = useState("");
  const [channel, setChannel] = useState(v.channel);
  const [summarize, setSummarize] = useState(v.settings.summarize === "claude");
  const [unfurl, setUnfurl] = useState(v.settings.unfurl !== false);
  const [teams, setTeams] = useState(Array.isArray(v.settings.teams) ? (v.settings.teams as string[]).join(", ") : "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The target channel doesn't exist (409 unknown_channel): connectors never create channels. */
  const [missing, setMissing] = useState<string | null>(null);
  const existing = new Set((team?.channels ?? []).map((c) => c.name));
  const channels = [...new Set([...(team?.channels ?? []).filter((c) => !c.members && !c.archived).map((c) => c.name), v.channel])].sort();

  const act = async (what: string, fn: () => Promise<{ integration: IntegrationView }>) => {
    setBusy(what);
    setError(null);
    setMissing(null);
    try {
      const res = await fn();
      setKey("");
      onChange(res.integration);
    } catch (err) {
      if (err instanceof ApiError && err.code === "unknown_channel") setMissing(channel);
      else setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const body = saveBody();
    if (body) void act("save", () => api.configureIntegration(v.id, body));
  };

  /** Creates the missing channel as this person (the normal channel API), then saves again. */
  const createChannel = (name: string) => {
    const body = saveBody();
    if (!body) return;
    void act("channel", async () => {
      await api.channel({ name });
      return api.configureIntegration(v.id, body);
    });
  };

  function saveBody(): Record<string, unknown> | null {
    const body: Record<string, unknown> = { enabled: true, channel };
    if (v.needs_key) {
      if (keyMode === "paste" && key.trim()) body.key = key.trim();
      if (keyMode === "path" && keyPath.trim() && keyPath.trim() !== v.key_path) body.key_path = keyPath.trim();
      if (!v.configured && !body.key && !body.key_path) {
        setError(keyMode === "paste" ? "Paste the API key first." : "Enter the path of the key file first.");
        return null;
      }
    }
    if (v.id === "wispr") { body.summarize = summarize ? "claude" : "off"; body.unfurl = unfurl; }
    if (v.id === "linear") {
      const list = teams.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
      body.teams = list;
    }
    return body;
  }

  const formId = `int-${v.id}`;
  return (
    <article className={`int-card ${v.enabled ? "is-enabled" : ""} ${v.last_error ? "has-error" : ""}`} aria-labelledby={`${formId}-title`}>
      <header className="int-head">
        <span className="source-avatar" data-source={v.id} aria-hidden="true"><Icon size={16} strokeWidth={1.75} /></span>
        <h2 className="int-title" id={`${formId}-title`}>{v.name}</h2>
        <StatusLine v={v} />
      </header>
      <p className="int-blurb">{about.blurb}</p>
      <Facts v={v} />
      {v.last_error && <p className="int-error" role="alert">{v.last_error}{v.last_run ? <> · <RelTime ts={v.last_run} long /></> : null}</p>}

      {readOnly ? (
        <p className="panel-empty">Observers can't post, so integrations can't run as you.</p>
      ) : (
        <form className="form int-form" onSubmit={save} noValidate>
          {v.needs_key && (
            <fieldset className="int-key">
              <legend className="field-label">API key</legend>
              <div className="seg" role="radiogroup" aria-label="Key source">
                <button type="button" role="radio" aria-checked={keyMode === "path"} className={keyMode === "path" ? "seg-btn is-on" : "seg-btn"} onClick={() => setKeyMode("path")}>Key file</button>
                <button type="button" role="radio" aria-checked={keyMode === "paste"} className={keyMode === "paste" ? "seg-btn is-on" : "seg-btn"} onClick={() => setKeyMode("paste")}>Paste key</button>
              </div>
              {keyMode === "path" ? (
                <input id={`${formId}-path`} className="input mono" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder={about.keyPlaceholder} aria-label="Key file path" autoComplete="off" spellCheck={false} />
              ) : (
                <input id={`${formId}-key`} className="input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={v.key_source === "secret" ? "Stored. Paste a new key to replace it" : "Paste the API key"} aria-label="API key" autoComplete="off" spellCheck={false} />
              )}
              <span className="field-hint">{about.keyHint} The key stays on this machine (0600) and is never sent to teammates.</span>
            </fieldset>
          )}
          <div className="field">
            <label htmlFor={`${formId}-channel`}>Post to</label>
            <select id={`${formId}-channel`} className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
              {channels.map((c) => <option key={c} value={c}>#{c}{existing.has(c) ? "" : " (doesn't exist yet)"}</option>)}
            </select>
          </div>
          {v.id === "wispr" && (
            <>
              <label className="check">
                <input type="checkbox" checked={summarize} onChange={(e) => setSummarize(e.target.checked)} />
                <span>Summarize with my Claude CLI (<span className="mono">claude -p</span>, your subscription, no tools). Off: post the excerpt only.</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={unfurl} onChange={(e) => setUnfurl(e.target.checked)} />
                <span>Unfurl shared notes.wisprflow.ai links posted in any channel.</span>
              </label>
            </>
          )}
          {v.id === "linear" && (
            <div className="field">
              <label htmlFor={`${formId}-teams`}>Also watch whole teams <span className="muted">(optional)</span></label>
              <input id={`${formId}-teams`} className="input mono" value={teams} onChange={(e) => setTeams(e.target.value)} placeholder="ENG, OPS" autoComplete="off" />
              <span className="field-hint">Without teams, only issues your agents report as their task are watched.</span>
            </div>
          )}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={busy !== null}>{busy === "save" ? "Saving…" : v.enabled ? "Save" : "Enable"}</button>
            {v.enabled && (
              <button type="button" className="btn" disabled={busy !== null} onClick={() => void act("run", () => api.runIntegration(v.id))}>
                <RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />{busy === "run" ? "Syncing…" : "Sync now"}
              </button>
            )}
            {v.enabled && (
              <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void act("off", () => api.configureIntegration(v.id, { enabled: false }))}>Turn off</button>
            )}
            {(v.enabled || v.configured && v.needs_key) && (
              <button type="button" className="btn btn-ghost btn-danger int-remove" disabled={busy !== null} onClick={() => void act("remove", () => api.removeIntegration(v.id))}>Forget</button>
            )}
          </div>
          {missing && (
            <div className="int-missing" role="alert">
              <p><span className="mono">#{missing}</span> doesn't exist yet. Integrations only post to existing channels.</p>
              <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => createChannel(missing)}>
                {busy === "channel" ? "Creating…" : `Create #${missing}`}
              </button>
            </div>
          )}
          {error && <p className="field-error" role="alert">{error}</p>}
        </form>
      )}
    </article>
  );
}

export function Integrations() {
  const { me } = useStore();
  const [items, setItems] = useState<IntegrationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(() => {
    api.integrations()
      .then((r) => { setItems(r.integrations); setError(null); })
      .catch((err) => setError(friendlyError(err)));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load, nonce]);

  const update = (next: IntegrationView | null) => {
    if (next) setItems((list) => (list ?? []).map((v) => (v.id === next.id ? next : v)));
    load();
  };

  return (
    <div className="page">
      <PageHeader
        title="Integrations"
        meta={<>Connectors run in the daemon on <span className="mono">{me?.node.hostname ?? "this machine"}</span> and post to team channels as you. Keys never leave this machine.</>}
      />
      {error && !items && <ErrorState message={error} onRetry={() => setNonce((n) => n + 1)} />}
      {!items && !error && <SkeletonRows rows={3} />}
      {items && (
        <div className="int-grid">
          {items.map((v) => <IntegrationCard key={`${v.id}:${v.enabled}:${v.key_source}`} v={v} onChange={update} readOnly={me?.role === "observer"} />)}
        </div>
      )}
      <p className="int-foot muted">
        Posts from integrations carry a source badge. Agents read meetings with the <span className="mono">walkie_meetings</span> and <span className="mono">walkie_meeting</span> tools; external text always reaches them marked untrusted.
      </p>
    </div>
  );
}
