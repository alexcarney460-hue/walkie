import type { SeatsLocalView } from "../../api/types.ts";

/** Protocol/consent are not native inference health. Snapshot rendering performs no probes. */
export function OssReadiness({ snapshot }: { snapshot: NonNullable<SeatsLocalView["codex_oss"]> }) {
  return <p className="field-hint" role="status">
    Local Codex / Ollama: consent {snapshot.consent}; native validation {snapshot.native} — held.
    Runtime {snapshot.runtime}, configuration {snapshot.config}, service {snapshot.service},
    model {snapshot.model}, resources {snapshot.resources}. Local CLI consent is separate from provider sign-in.
  </p>;
}
