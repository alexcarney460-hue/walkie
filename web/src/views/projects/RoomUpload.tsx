// Uploading to a project's Data Room (DATA-ROOM-1), shared by the Data Room tab, the card drawer and a file dropped on
// a card: each file goes up on its own; one the daemon's secret scan flags waits for the person's "Upload anyway"
// (the file is shared as is, never altered) or "Skip".
import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { api, friendlyError, secretFindings } from "../../api/client.ts";
import type { RoomFileView } from "../../api/types.ts";
import { projectsStore } from "../../state/projects.ts";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

interface Flagged { file: File; findings: string[]; card?: string }

const KIND: Record<string, string> = {
  private_key: "a private key", secret: "a password or secret", env_secret: "a secret variable", stripe_key: "a Stripe key",
  openai_key: "an OpenAI key", anthropic_key: "an Anthropic key", aws_access_key: "an AWS key", github_token: "a GitHub token",
  url_credentials: "a password in a URL", auth_header: "an authorization header", bearer: "a bearer token", jwt: "a JWT",
};
export function findingText(kinds: readonly string[]): string {
  const names = [...new Set(kinds.map((k) => KIND[k] ?? k.replace(/_/g, " ")))];
  return names.length ? names.join(", ") : "a secret";
}

export function useRoomUpload(channel: string) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [flagged, setFlagged] = useState<Flagged[]>([]);
  const [done, setDone] = useState<string | null>(null);

  const one = async (file: File, card: string | undefined, allowSecrets: boolean): Promise<RoomFileView | null> => {
    if (file.size > MAX_FILE_BYTES) { setError(`${file.name} is over 25 MB (the most a Data Room file holds).`); return null; }
    if (file.size === 0) { setError(`${file.name} is empty.`); return null; }
    setBusy((n) => n + 1);
    try {
      const res = await api.roomAdd(channel, file, { name: file.name, ...(card ? { card } : {}), ...(allowSecrets ? { allowSecrets: true } : {}) });
      projectsStore.roomFile(res.file);
      setDone(res.unchanged ? `${res.file.name} is unchanged (same as v${res.version})` : res.created ? `Added ${res.file.name}` : `Added v${res.version} of ${res.file.name}`);
      return res.file;
    } catch (err) {
      const findings = secretFindings(err);
      if (findings) setFlagged((xs) => [...xs, { file, findings, ...(card ? { card } : {}) }]);
      else setError(`${file.name}: ${friendlyError(err)}`);
      return null;
    } finally {
      setBusy((n) => n - 1);
    }
  };

  /** Uploads the files one by one (optionally attached to a card id); flagged ones wait for a decision. */
  const upload = async (files: readonly File[], card?: string): Promise<void> => {
    setError(null);
    setDone(null);
    for (const f of files) await one(f, card, false);
    void projectsStore.loadRoom(channel);
  };
  const confirm = async (f: Flagged) => {
    setFlagged((xs) => xs.filter((x) => x !== f));
    await one(f.file, f.card, true);
  };
  const skip = (f: Flagged) => setFlagged((xs) => xs.filter((x) => x !== f));

  const notice = (
    <>
      {flagged.map((f) => (
        <div key={`${f.file.name}-${f.file.lastModified}`} className="room-secret" role="alert">
          <ShieldAlert size={16} strokeWidth={1.9} aria-hidden="true" />
          <p><strong className="mono">{f.file.name}</strong> looks like it contains {findingText(f.findings)}. Everyone on this project (and their agents) would see it.</p>
          <div className="room-secret-actions">
            <button type="button" className="btn btn-sm" onClick={() => skip(f)}>Skip</button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void confirm(f)}>Upload anyway</button>
          </div>
        </div>
      ))}
      {error && <p className="field-error" role="alert">{error}</p>}
      {done && !error && <p className="room-done muted" role="status">{done}</p>}
    </>
  );
  return { upload, busy: busy > 0, notice };
}

/** Files from a drag event, if it carries any (not a card being moved, not text). */
export function draggedFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
}
