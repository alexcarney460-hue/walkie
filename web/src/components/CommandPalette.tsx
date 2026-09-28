import { useEffect, useMemo, useRef, useState } from "react";
import { Armchair, Bot, CircleHelp, FileText, FolderKanban, Gauge, Hash, LayoutGrid, Lock, LogOut, MessagesSquare, Moon, Plug, Search, Sparkles, User, Users } from "lucide-react";
import { api } from "../api/client.ts";
import { STATE_LABEL, displayName } from "../lib/format.ts";
import { getRoute, navigate } from "../lib/route.ts";
import { setTheme, toggleTheme } from "../lib/theme.ts";
import { useStore } from "../state/store.tsx";

interface Cmd { id: string; group: string; label: string; hint?: string; icon: typeof Bot; keys?: string; run: () => void }

function score(text: string, q: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 3;
  if (t.includes(` ${q}`) || t.includes(`/${q}`) || t.includes(`-${q}`)) return 2;
  if (t.includes(q)) return 1;
  // loose subsequence match
  let i = 0;
  for (const ch of t) if (ch === q[i]) i += 1;
  return i === q.length ? 0.5 : 0;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { agents, team } = useStore();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    inputRef.current?.focus();
    return () => (returnFocus.current as HTMLElement | null)?.focus?.();
  }, []);

  const commands = useMemo<Cmd[]>(() => {
    const views: Cmd[] = [
      { id: "v-m", group: "Go to", label: "Mission Control", icon: LayoutGrid, keys: "G M", run: () => navigate({ view: "mission" }) },
      { id: "v-p", group: "Go to", label: "Projects", icon: FolderKanban, keys: "G P", run: () => navigate({ view: "projects" }) },
      { id: "v-o", group: "Go to", label: "WalkieTalkie", icon: Sparkles, keys: "G O", run: () => navigate({ view: "orchestrator" }) },
      { id: "v-b", group: "Go to", label: "Channels", icon: MessagesSquare, keys: "G B", run: () => navigate({ view: "board" }) },
      { id: "v-a", group: "Go to", label: "Asks", icon: CircleHelp, keys: "G A", run: () => navigate({ view: "asks" }) },
      { id: "v-f", group: "Go to", label: "Artifacts", icon: FileText, keys: "G F", run: () => navigate({ view: "artifacts" }) },
      { id: "v-t", group: "Go to", label: "Team", icon: Users, keys: "G T", run: () => navigate({ view: "team" }) },
      { id: "v-i", group: "Go to", label: "Integrations", icon: Plug, keys: "G I", run: () => navigate({ view: "integrations" }) },
      { id: "v-u", group: "Go to", label: "Accounts · usage left", icon: Gauge, keys: "G U", run: () => navigate({ view: "accounts" }) },
      { id: "v-s", group: "Go to", label: "Seats", icon: Armchair, keys: "G S", run: () => navigate({ view: "seats" }) },
    ];
    const agentCmds: Cmd[] = agents.map((a) => ({
      id: `a-${a.id}`, group: "Agents", label: `${a.agent} · ${a.hostname}`, hint: `${STATE_LABEL[a.effective_state]}${a.status.title ? ` · ${a.status.title}` : ""}`,
      icon: Bot, run: () => navigate({ ...getRoute(), agent: a.id }),
    }));
    const channels: Cmd[] = (team?.channels ?? []).map((c) => ({
      id: `c-${c.name}`, group: "Channels", label: c.name, hint: c.topic, icon: c.members ? Lock : Hash, run: () => navigate({ view: "board", channel: c.name }),
    }));
    const people: Cmd[] = (team?.members ?? []).map((m) => ({
      id: `p-${m.handle}`, group: "People", label: displayName(team?.members, m.handle), hint: `@${m.handle} · ${agents.filter((a) => a.handle === m.handle).length} agents`,
      icon: User, run: () => navigate({ view: "mission" }),
    }));
    const actions: Cmd[] = [
      { id: "t-toggle", group: "Actions", label: "Toggle light / dark theme", icon: Moon, run: toggleTheme },
      { id: "t-system", group: "Actions", label: "Use system theme", icon: Moon, run: () => setTheme("system") },
      { id: "t-logout", group: "Actions", label: "Sign out of this dashboard", icon: LogOut, run: () => void api.logout().catch(() => undefined).finally(() => window.location.reload()) },
    ];
    return [...views, ...agentCmds, ...channels, ...people, ...actions];
  }, [agents, team]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    const ranked = commands
      .map((c) => ({ c, s: Math.max(score(c.label, query), query && (c.hint ?? "").toLowerCase().includes(query) ? 0.6 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (query ? b.s - a.s : 0))
      .slice(0, query ? 40 : 60);
    // Keep each group contiguous; groups appear in order of their best match.
    const groups = new Map<string, Cmd[]>();
    for (const { c } of ranked) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
    return [...groups.values()].flat();
  }, [commands, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (c: Cmd | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  let lastGroup = "";
  return (
    <div className="palette-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input-row">
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={inputRef}
            className="palette-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to an agent, channel, person or view"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[sel] ? `pal-${results[sel]?.id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(results.length - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); run(results[sel]); }
              else if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {results.length === 0 && <li className="palette-empty">Nothing matches “{q}”.</li>}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            const Icon = c.icon;
            return (
              <li key={c.id} role="presentation">
                {header && <div className="palette-group" role="presentation">{header}</div>}
                <div
                  id={`pal-${c.id}`}
                  role="option"
                  aria-selected={i === sel}
                  data-idx={i}
                  className={i === sel ? "palette-item is-sel" : "palette-item"}
                  onMouseMove={() => setSel(i)}
                  onClick={() => run(c)}
                >
                  <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span className="palette-label truncate">{c.label}</span>
                  {c.hint && <span className="palette-hint truncate">{c.hint}</span>}
                  {c.keys && <span className="palette-keys">{c.keys.split(" ").map((k) => <kbd key={k}>{k}</kbd>)}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
