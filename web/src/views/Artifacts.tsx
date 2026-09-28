import { useEffect, useMemo, useState } from "react";
import { FileCode2, FileJson, FileText, File as FileIcon, Paperclip } from "lucide-react";
import { api, friendlyError } from "../api/client.ts";
import type { ArtifactBody, Event } from "../api/types.ts";
import { AuthorAvatar } from "../components/Author.tsx";
import { DownloadButton } from "../components/DownloadButton.tsx";
import { PageHeader } from "../components/Shell.tsx";
import { EmptyState, ErrorState, RelTime, SkeletonRows } from "../components/primitives.tsx";
import { bytes, displayName, mimeKind } from "../lib/format.ts";
import { hrefFor } from "../lib/route.ts";
import { fullTime } from "../lib/time.ts";
import { useStore } from "../state/store.tsx";

const ICON = { code: FileCode2, data: FileJson, text: FileText, image: FileIcon, archive: FileIcon, file: FileIcon };

export function Artifacts() {
  const { events: live, team } = useStore();
  const [fetched, setFetched] = useState<Event[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.events({ kinds: "artifact.share", limit: 500 })
      .then((r) => { if (!cancelled) setFetched(r.events); })
      .catch((err) => { if (!cancelled) setError(friendlyError(err)); });
    return () => { cancelled = true; };
  }, [nonce]);

  const files = useMemo(() => {
    if (!fetched) return null;
    const byId = new Map(fetched.map((e) => [e.id, e]));
    for (const e of live) if (e.kind === "artifact.share") byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => b.ts - a.ts);
  }, [fetched, live]);

  const total = files?.reduce((n, e) => n + (e.body as ArtifactBody).size, 0) ?? 0;

  return (
    <div className="page">
      <PageHeader
        title="Artifacts"
        meta={files ? `${files.length} file${files.length === 1 ? "" : "s"} · ${bytes(total)} · content-addressed, fetched from a teammate's machine on first download` : "Files shared by people and agents"}
      />
      {error && !files ? (
        <ErrorState message={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : !files ? (
        <SkeletonRows rows={5} />
      ) : files.length === 0 ? (
        <EmptyState icon={<Paperclip size={18} strokeWidth={1.75} />} title="No files shared yet" command="walkie share ./plan.txt '#ops'">
          <p>Agents share plans, logs and patches with <span className="mono">walkie share</span>. Files stay on the team's machines, up to 25 MB each.</p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table files-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="num">Size</th>
                <th scope="col">Shared by</th>
                <th scope="col">Channel</th>
                <th scope="col" className="num">When</th>
                <th scope="col"><span className="sr-only">Download</span></th>
              </tr>
            </thead>
            <tbody>
              {files.map((e) => {
                const b = e.body as ArtifactBody;
                const Icon = ICON[mimeKind(b.mime, b.name)];
                return (
                  <tr key={e.id}>
                    <td className="file-cell">
                      <span className="file-icon" aria-hidden="true"><Icon size={15} strokeWidth={1.6} /></span>
                      <span className="file-text">
                        <span className="mono file-name">{b.name}</span>
                        {b.note && <span className="file-note">{b.note}</span>}
                      </span>
                    </td>
                    <td className="num tnum muted" data-label="Size">{bytes(b.size)}</td>
                    <td data-label="By">
                      <span className="by-cell">
                        <AuthorAvatar author={e.author} size={18} />
                        {e.author.agent ? <span className="mono">{e.author.agent}</span> : <span>{displayName(team?.members, e.author.handle)}</span>}
                      </span>
                    </td>
                    <td data-label="Channel">{e.channel ? <a className="md-channel" href={hrefFor({ view: "board", channel: e.channel })}>#{e.channel}</a> : <span className="muted">direct</span>}</td>
                    <td className="num muted" data-label="When" title={fullTime(e.ts)}><RelTime ts={e.ts} long /></td>
                    <td className="dl-cell">
                      <DownloadButton hash={b.hash} name={b.name} labelClass="dl-label" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
