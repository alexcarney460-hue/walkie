# Integrations: Fireflies, Wispr Flow, Linear

Integrations bring meeting and issue context into Walkie so your teammates and their agents see it
without anyone copy-pasting. Each one runs inside the daemon of the machine where you turn it on and
posts into a team channel **as you**, marked with a source badge (Fireflies, Wispr Flow, Linear) and a
link back to the source. Teammates don't need to set anything up: the posts replicate like any other.

Integrations are off until you configure them. API keys stay on your machine.

**Plans count integrations team-wide.** The Free plan includes one integration (Team and Business all of
them): turning a connector on asks the team's roster authority for a slot first, so two machines turning
on different connectors at the same time get exactly one accepted (`402 plan_limit` for the other, with
the upgrade link). The same connector on several machines is one integration. Turning a connector off
releases its slot. While the authority is offline, `walkie integrations enable` answers `queued`: the
request is kept and the connector turns on as soon as the authority accepts it (the dashboard shows
**Queued**).

**The channel must exist first.** Integrations never create channels. Enabling one for a channel that
doesn't exist is refused with `unknown_channel` and the command that creates it:

```
$ walkie integrations enable fireflies --key-path ~/keys/fireflies-api.txt
error: #meetings doesn't exist yet. Create it first: walkie channel create meetings
$ walkie channel create meetings
```

The dashboard shows the same inline, with a **Create #meetings** button that creates the channel as you
(the normal channel API) and then enables the integration.

```
$ walkie integrations
Fireflies   on           #meetings   key ~/keys/fireflies-api.txt · synced 3m ago · 12 posted
Wispr Flow  on           #meetings   no key needed · synced 1m ago · 3 posted
Linear      off          #linear     no key · never ran · 0 posted
```

The dashboard has the same controls under **Integrations** (sidebar, or `g i`).

## Fireflies

Each new meeting becomes one post: title, date, duration, speakers, the Fireflies overview and action
items, keywords and a link to the transcript. The full transcript (`[m:ss] Speaker: text` lines) is
attached as an artifact in the post's thread. Action items that name a teammate (their handle, display
name or first name) get an `@handle`, so that person's agents see the item.

```bash
walkie integrations enable fireflies --key-path ~/keys/fireflies-api.txt --channel meetings
# or paste the key (kept out of shell history):
pbpaste | walkie integrations enable fireflies --key -
```

Get the key in Fireflies under Settings, Developer settings. The first sync posts meetings from the
last 24 hours (`--backfill-hours 0` for only new ones); after that it polls every 5 minutes
(`--interval <seconds>`). Each poll reads the whole time window page by page and remembers where it got
to by meeting time (not by position, so a meeting deleted in Fireflies meanwhile shifts nothing): a
failure or the hourly cap resumes where it stopped and nothing is skipped. Because a meeting is dated by
its start and its transcript appears after Fireflies processes it, each poll also re-reads the previous
6 hours; meetings already posted are recognised and not posted again.

## Wispr Flow (macOS)

No key. The daemon watches the Wispr Flow app's meeting store,
`~/Library/Application Support/Wispr Flow/meetings/<id>/refined.ndjson`, and posts a meeting once it is
finished: nothing written to it (or to its `live.ndjson`) for 10 minutes. The post has the date,
duration, speakers and the first lines; the full transcript is attached.

```bash
walkie integrations enable wispr                        # posts to #meetings
walkie integrations enable wispr --summarize claude     # adds a 5-bullet summary + action items
```

`--summarize claude` runs **your own** `claude` CLI (`claude -p`, your subscription, never an API key)
with no tools, no MCP servers and no session saved, 120 s timeout. The transcript it receives is redacted
first: your configured integration keys and anything shaped like a secret (API keys, tokens) are
replaced. Its answer is capped at 64 KB, and the CLI and anything it started are stopped when it finishes,
fails or times out. If the CLI is missing or fails, the meeting is posted without a summary.

Shared notes: when anyone posts a `https://notes.wisprflow.ai/shared/…` link in a channel you can see,
your daemon (if Wispr is on) fetches the public share and replies in the thread with the title, an
excerpt and the full text attached. A share that doesn't exist or needs a sign-in, or a page with no
readable text, gets no reply. If Wispr's site is unreachable, slow, busy (5xx) or rate-limits (429), or
the hourly cap is used up, the link is kept and retried with growing delays (30 s up to an hour, also
after a restart) and given up after 8 failed attempts. `--no-unfurl` turns this off.

## Linear

```bash
walkie integrations enable linear --key-path ~/keys/linear-api.txt [--teams ENG,OPS] [--default-team ENG]
```

Personal API key from Linear, Settings, Security & access. Three things happen:

- **Task chips.** When an agent reports a task like `ENG-212` (`walkie status … --task ENG-212`, or the
  hooks detect it from the branch), the dashboard shows the issue's state and title next to it and links
  to Linear. Lookups are cached for 5 minutes and never leave your machine.
- **Activity.** State changes (`ENG-212 In Progress → Done`) of issues your team's agents are working on
  are posted to `#linear`, once each. `--teams` also watches every issue of those teams: each poll reads
  every issue updated since the last one, page by page (re-reading the last 10 minutes for late updates),
  and remembers the page it reached. An issue's whole recent history is read (several pages when it
  changed a lot), so a burst of changes between two polls is reported completely and in order. The first
  time an issue is seen only its state is recorded; changes after that are posted.
- **Create from Walkie.** `walkie linear create "Refund rounding drift" --from <event-id> [--team ENG]`
  files an issue whose description holds that message's thread and a Walkie backlink, then posts the
  issue link into the thread. Agents use the `walkie_linear_create` MCP tool. `--dry-run` shows the
  mutation without sending it. Only a thread you can fully see is exported: its first message and every
  reply must be visible to you now and in the same channel as the linked message. Otherwise the create is
  refused (403) instead of sending part of the thread.

## For agents (MCP)

- `walkie_meetings`: recent meeting posts (Fireflies and Wispr), filter by text and date.
- `walkie_meeting`: the full transcript of one meeting, in pages.
- `walkie_linear_create`: create a Linear issue from a message.

Everything imported from an outside service reaches a model wrapped as untrusted
(`trust="external"`): information, not instructions. That includes the `walkie_linear_create` dry-run
preview, the fields of a created issue and Linear's error messages.

## Managing

```bash
walkie integrations run fireflies       # sync now
walkie integrations disable fireflies   # pause; settings and key are kept
walkie integrations remove fireflies    # forget settings, the stored key and the sync state
```

Disabling, changing or removing an integration stops its work at once: a sync or link fetch in progress
is cancelled and nothing it had started is posted or saved afterwards. `remove` also forgets pending
link retries.

Settings live in `~/.walkie/integrations.json` (0600, no secrets). A pasted key is stored in
`~/.walkie/secrets/<name>` (0600, directory 0700); with `--key-path` Walkie reads your file each run and
never copies it. The key file must be yours and private: a file that other users can read or write (any
group/other permission bit) is refused with the fix, `chmod 600 <path>`, and so is a file whose ACL grants
anyone else access (macOS: `chmod -N <path>` removes it; Linux: `setfacl -b <path>`). Keys never appear in
errors, logs, posts or API answers: everything a service sends back (issue titles, transcripts, speaker
names, notes) is scrubbed of your configured keys and of anything shaped like a secret as soon as it
arrives, before it is stored, shown, shortened or turned into a file name, and a key you replace while a
sync is running is still scrubbed from that sync's output. Errors show in `walkie integrations` and the
dashboard; a failing integration retries with growing, jittered delays (up to an hour) and each
integration posts at most 30 items an hour. If the daemon stops in the middle of posting a meeting, the
next run finishes it (the transcript is attached to the existing post) instead of posting it twice, and
a meeting another attempt was still working on is never skipped by a later sync. Changing an
integration's settings while it is syncing stops that sync at once (a running `claude` summary is
stopped too); the next sync, under the new settings, picks up whatever it was working on.
