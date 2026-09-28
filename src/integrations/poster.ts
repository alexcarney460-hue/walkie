// The only write path of every connector: msg.post and artifact.share through Core.emit, authored as the
// local human handle with author.agent = connector id. Nothing else is ever emitted: connectors never
// create channels (a missing channel is an error the person fixes with the normal channel API).
//
// Final gate: every string field of every emitted body (post text; share name, note, mime; the attached
// bytes) is scrubbed of the configured keys and secret-shaped tokens here, whatever the connector did.
//
// Delivery of an external item is idempotent under retry: the post is emitted in the same transaction
// that records its id against (connector, external_id), and so is the attachment's share; a retry of a
// half-done item completes the missing share instead of posting again.
import type { BodyOf, Event } from "../protocol/schemas.ts";
import { readBlob, writeBlob } from "../daemon/blobs.ts";
import type { Core } from "../daemon/core.ts";
import { mentionsIn } from "../daemon/local-routes.ts";
import { canSeeChannel } from "../daemon/roster.ts";
import type { ConnectorId } from "./config.ts";
import { scrubSecrets } from "./scrub.ts";
import type { IntegrationStore } from "./state.ts";

/** Longest post text (the schema allows 32 000 characters). */
export const MAX_POST_CHARS = 30_000;
/** Largest attached transcript/document artifact. */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export class PostError extends Error {}

export interface Attachment { name: string; mime: string; text: string; note?: string }

/** One external item (a meeting, a transition, an unfurl) delivered at most once. */
export interface DeliverItem {
  connector: ConnectorId;
  channel: string;
  externalId: string;
  text: string;
  attachment?: Attachment;
  /** Post inside this thread (the share then follows in the same thread). */
  thread?: string;
}

export interface Delivered { post: Event; share: Event | null; resumed: boolean }

/** What a connector context sees: generation-checked posting. */
export interface ConnectorPoster {
  post(connector: ConnectorId, channel: string, text: string, opts?: { thread?: string }): Promise<Event>;
  deliver(item: DeliverItem): Promise<Delivered>;
}

export interface PosterDeps { core: Core }

function capText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Truncates UTF-8 text to at most `max` bytes without splitting a character. */
function capBytes(s: string, max: number): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  if (bytes.byteLength <= max) return bytes;
  let end = max - 64;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  const note = new TextEncoder().encode("\n\n[truncated by Walkie: transcript exceeded 5 MB]\n");
  const out = new Uint8Array(end + note.byteLength);
  out.set(bytes.subarray(0, end));
  out.set(note, end);
  return out;
}

const noGuard = (): void => undefined;

interface StoredBlob { hash: string; size: number }

/** Credentials one operation used, added to the final gate of everything it emits (#4). */
export type SecretSource = () => readonly (string | null | undefined)[];
const none: SecretSource = () => [];

export class Poster {
  private secrets: SecretSource = none;

  constructor(private readonly d: PosterDeps) {}

  /** Where the configured keys come from (the integration manager), for the final gate. */
  setSecretSource(fn: SecretSource): void { this.secrets = fn; }

  /**
   * Scrubs one emitted string: the operation's own credentials (`extra`), the configured keys and
   * secret-shaped tokens (always, whatever `redact` says).
   */
  clean(s: string, extra: SecretSource = none): string { return scrubSecrets(s, [...extra(), ...this.secrets()]); }

  /** The channel must exist, be visible to this member and not be archived. Nothing is ever created. */
  ensureChannel(name: string): void {
    const core = this.d.core;
    if (!core.teamId || !core.me()) throw new PostError("this node is not in a team yet");
    const ch = core.roster.channels.get(name);
    if (!ch) throw new PostError(`#${name} doesn't exist; create it with: walkie channel create ${name}`);
    if (!canSeeChannel(core.roster, name, core.myHandle())) throw new PostError(`#${name} is restricted and you are not a member`);
    if (ch.archived) throw new PostError(`#${name} is archived`);
  }

  /**
   * A generation-checked view for one connector context. `secrets` are the credentials that context
   * captured (its key at the time, whatever the key file holds now): every emit through this view
   * scrubs them too (#4).
   */
  bind(guard: () => void, ledger: IntegrationStore, secrets: SecretSource = none): ConnectorPoster {
    return {
      post: async (connector, channel, text, opts = {}) => this.post(connector, channel, text, { ...opts, guard, secrets }),
      deliver: async (item) => this.deliver(item, guard, ledger, secrets),
    };
  }

  /** A post authored by the connector. Mentions come from @handles in the (scrubbed) text. */
  async post(connector: ConnectorId, channel: string, text: string, opts: { thread?: string; artifacts?: string[]; guard?: () => void; secrets?: SecretSource } = {}): Promise<Event> {
    this.ensureChannel(channel);
    (opts.guard ?? noGuard)();
    return this.emitPost(connector, channel, text, opts, opts.secrets ?? none);
  }

  private emitPost(connector: ConnectorId, channel: string, text: string, opts: { thread?: string; artifacts?: string[] }, secrets: SecretSource): Event {
    const clean = capText(this.clean(text, secrets), MAX_POST_CHARS);
    const mentions = mentionsIn(clean);
    const body: BodyOf<"msg.post"> = {
      text: clean,
      ...(opts.thread ? { thread: opts.thread } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(opts.artifacts?.length ? { artifacts: opts.artifacts } : {}),
    };
    return this.d.core.emit("msg.post", body, { channel, agent: connector });
  }

  /** Stores the (scrubbed) bytes as a content-addressed blob. */
  private storeBlob(att: Attachment, secrets: SecretSource): StoredBlob {
    const bytes = capBytes(this.clean(att.text, secrets), MAX_ARTIFACT_BYTES);
    const hash = writeBlob(this.d.core.paths.blobs, bytes);
    this.d.core.store.addBlob(hash, bytes.byteLength, this.clean(att.mime, secrets), this.clean(att.name, secrets));
    return { hash, size: bytes.byteLength };
  }

  /** The blob a stored post already names, when this node still holds it (a resumed delivery reuses it). */
  private namedBlob(post: Event): StoredBlob | null {
    const hash = Array.isArray(post.body.artifacts) ? String(post.body.artifacts[0] ?? "") : "";
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const bytes = readBlob(this.d.core.paths.blobs, hash);
    return bytes ? { hash, size: bytes.byteLength } : null;
  }

  /** Announces a stored blob (artifact.share) in `thread`. Every text field goes through the gate. */
  private announce(connector: ConnectorId, channel: string, blob: StoredBlob, att: Attachment, thread: string, secrets: SecretSource): Event {
    const event = this.d.core.emit("artifact.share", {
      hash: blob.hash, name: capText(this.clean(att.name, secrets), 200), size: blob.size, mime: capText(this.clean(att.mime, secrets), 200),
      ...(att.note ? { note: capText(this.clean(att.note, secrets), 2000) } : {}),
      thread,
    }, { channel, agent: connector });
    this.d.core.store.addProvenance(channel, blob.hash); // we hold these bytes for a share in this channel (R5)
    return event;
  }

  private storedEvent(id: string | null): Event | null {
    if (!id) return null;
    const row = this.d.core.store.getRow(id);
    return row && row.status === "ok" && row.redacted === 0 ? (JSON.parse(row.json) as Event) : null;
  }

  /**
   * Delivers one external item: its post (naming the attachment, if any) and the attachment's share in
   * the post's thread, each recorded atomically with its emit. A retry finds what already exists and
   * only emits what is missing. Marks the item posted when both exist.
   */
  async deliver(item: DeliverItem, guard: () => void, ledger: IntegrationStore, secrets: SecretSource = none): Promise<Delivered> {
    this.ensureChannel(item.channel);
    guard();
    const prior = ledger.item(item.connector, item.externalId);
    const existing = this.storedEvent(prior?.event_id ?? null);
    const blob = item.attachment ? (existing ? this.namedBlob(existing) : null) ?? this.storeBlob(item.attachment, secrets) : null;
    let post = existing;
    if (!post) {
      guard();
      post = ledger.atomically(() => {
        const ev = this.emitPost(item.connector, item.channel, item.text, { thread: item.thread, artifacts: blob ? [blob.hash] : undefined }, secrets);
        ledger.setPostEvent(item.connector, item.externalId, ev.id);
        return ev;
      });
    }
    const posted = post;
    let share = this.storedEvent(prior?.share_id ?? null);
    if (item.attachment && blob && !share) {
      const att = item.attachment;
      guard();
      share = ledger.atomically(() => {
        const ev = this.announce(item.connector, item.channel, blob, att, item.thread ?? posted.id, secrets);
        ledger.setShareEvent(item.connector, item.externalId, ev.id);
        ledger.record(item.connector, item.externalId, posted.id, Date.now());
        return ev;
      });
    } else {
      guard();
      ledger.record(item.connector, item.externalId, posted.id, Date.now());
    }
    return { post: posted, share, resumed: existing !== null };
  }
}
