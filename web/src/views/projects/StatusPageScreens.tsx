// The screens of a project's status page (PROJECT-PAGES-1): a sticky index of the groups, a grid of screenshots per group
// (each with its title, the page it shows, a status chip, one plain sentence and who added it), and a native dialog to look at
// one larger. Images load as they come near the screen, are judged from their own bytes and are shown as data URLs
// (lib/screen-image.ts). Everything the team wrote is rendered as text, never as HTML or Markdown.
import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, ImageOff, RefreshCw } from "lucide-react";
import type { ScreenGroupView, ScreensView, ScreenView } from "../../api/types.ts";
import { EmptyState, PlainTime } from "../../components/primitives.tsx";
import { hrefFor, navigate } from "../../lib/route.ts";
import { imageKey, loadImage, peekImage, type ScreenImage } from "../../lib/screen-image.ts";
import { aspectOf, chipOf, groupScrollTop, isTall, screenAlt, whoLabel } from "../../lib/status-page.ts";

type Loading = ScreenImage | { status: "idle" } | { status: "loading" };
type Ready = Extract<ScreenImage, { status: "ready" }>;
/** What a click on a thumbnail hands the page: the screen, the element to give focus back to, and the picture the thumbnail shows. */
type OnOpen = (s: ScreenView, from: HTMLElement | null, image: Ready) => void;

/** Whether an element has come within reach of the screen (once true it stays true): images are fetched only then. */
function useNear<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, near];
}

function useScreenImage(channel: string, s: ScreenView, wanted: boolean): { image: Loading; retry: () => void } {
  const key = imageKey(channel, s.id, s.version);
  const [image, setImage] = useState<Loading>(() => peekImage(key) ?? { status: s.available ? "idle" : "missing" });
  const [tries, setTries] = useState(0);
  useEffect(() => {
    const hit = peekImage(key);
    if (hit) { setImage(hit); return; }
    if (!wanted) return;
    if (!s.available) { setImage({ status: "missing" }); return; }
    let live = true;
    setImage({ status: "loading" });
    void loadImage(channel, s.id, s.version).then((r) => { if (live) setImage(r); });
    return () => { live = false; };
  }, [key, wanted, s.available, tries]);
  return { image, retry: () => setTries((n) => n + 1) };
}

/** What stands where a screen's image will be: room kept for its size, and what is going on in plain words. */
function Placeholder({ screen, image, retry }: { screen: ScreenView; image: Loading; retry: () => void }) {
  const failed = image.status === "missing" || image.status === "broken";
  return (
    <div className="spage-ph" style={{ aspectRatio: aspectOf(screen) ?? "16 / 10" }} aria-busy={!failed}>
      {failed ? (
        <>
          <ImageOff size={20} strokeWidth={1.6} aria-hidden="true" />
          <p>{image.status === "missing" ? "Not on any online machine right now" : "This image can't be shown"}</p>
          {screen.available && (
            <button type="button" className="btn btn-sm" onClick={retry}><RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />Try again</button>
          )}
        </>
      ) : <span className="skeleton" aria-hidden="true" />}
    </div>
  );
}

function Figure({ channel, screen, onOpen }: { channel: string; screen: ScreenView; onOpen: OnOpen }) {
  const [ref, near] = useNear<HTMLElement>();
  const { image, retry } = useScreenImage(channel, screen, near);
  const chip = chipOf(screen.status);
  return (
    <li>
      <figure ref={ref} className={isTall(screen) ? "spage-shot is-tall" : "spage-shot"}>
        {image.status === "ready" ? (
          <button type="button" className="spage-zoom" aria-label={`Enlarge ${screen.title}`} onClick={(e) => onOpen(screen, e.currentTarget, image)}>
            <img src={image.url} alt="" width={image.width} height={image.height} loading="lazy" decoding="async" />
          </button>
        ) : <Placeholder screen={screen} image={image} retry={retry} />}
        <figcaption>
          <div className="spage-cap-head">
            <b>{screen.title}</b>
            <span className={`spage-chip is-${chip.tone}`}>{chip.label}</span>
          </div>
          {screen.route && <code className="spage-route">{screen.route}</code>}
          <p className="spage-about">{screen.about}</p>
          {screen.note && <p className="spage-note-line">{screen.note}</p>}
          <p className="spage-by">{whoLabel(screen.by)} · <PlainTime ts={screen.at} /></p>
        </figcaption>
      </figure>
    </li>
  );
}

/**
 * One screen, larger: the native dialog traps focus, closes on Escape and gives focus back to the thumbnail it came from. It shows
 * the picture its thumbnail holds (`image`); with none given it looks in the bounded cache, which may have let it go.
 */
export function Enlarged({ channel, screen, image: given, onClose }: { channel: string; screen: ScreenView | null; image?: Ready | undefined; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (screen && !d.open) { if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", ""); } // a browser without <dialog> modals still shows it
    if (!screen && d.open) d.close();
  }, [screen]);
  const image = screen ? given ?? peekImage(imageKey(channel, screen.id, screen.version)) : undefined;
  const chip = screen ? chipOf(screen.status) : null;
  return (
    <dialog ref={ref} className="spage-dialog" aria-labelledby={screen ? "spage-dialog-title" : undefined} onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) ref.current?.close(); }}>
      {screen && chip && (
        <div className="spage-dialog-body">
          <header className="spage-dialog-head">
            <h4 id="spage-dialog-title">{screen.title}</h4>
            <span className={`spage-chip is-${chip.tone}`}>{chip.label}</span>
            <button type="button" className="btn btn-sm" onClick={() => ref.current?.close()}>Close</button>
          </header>
          {image ? <img src={image.url} alt={screenAlt(screen)} width={image.width} height={image.height} /> : <p className="muted">The image is not loaded.</p>}
          <p className="spage-about">{screen.about}</p>
        </div>
      )}
    </dialog>
  );
}

/** Scrolls a group of screens to just below the index that sticks above it (measured, since the index wraps to more rows on a phone). */
function scrollToGroup(id: string): void {
  const el = document.getElementById(`spage-g-${id}`);
  if (!el) return;
  const index = document.querySelector<HTMLElement>(".spage-index");
  const stickyTop = index ? parseFloat(getComputedStyle(index).top) || 0 : 0;
  const top = groupScrollTop({ groupTop: el.getBoundingClientRect().top, scrollY: window.scrollY, stickyTop, indexHeight: index?.offsetHeight ?? 0 });
  const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top, behavior: calm ? "auto" : "smooth" });
}

function Group({ channel, group, onOpen }: { channel: string; group: ScreenGroupView; onOpen: OnOpen }) {
  const n = group.screens.length;
  return (
    <section id={`spage-g-${group.id}`} className="spage-group" aria-labelledby={`spage-h-${group.id}`}>
      <h3 id={`spage-h-${group.id}`}>{group.name}<span className="spage-count">{n}<span className="sr-only"> screen{n === 1 ? "" : "s"}</span></span></h3>
      <ul className="spage-grid">
        {group.screens.map((s) => <Figure key={s.id} channel={channel} screen={s} onOpen={onOpen} />)}
      </ul>
    </section>
  );
}

export function ScreensSection({ channel, prefix, screens, group, note }: { channel: string; prefix: string; screens: ScreensView; group: string | undefined; note: string | undefined }) {
  const [open, setOpen] = useState<{ screen: ScreenView; image: Ready } | null>(null);
  const from = useRef<HTMLElement | null>(null);
  const loaded = screens.groups.length > 0;
  useEffect(() => { if (group && loaded) scrollToGroup(group); }, [group, loaded]);
  const notice = note ? <p className="spage-notice" role="note">{note}</p> : null;
  if (!loaded) {
    return (
      <>
        {notice}
        <EmptyState icon={<ImageIcon size={22} strokeWidth={1.5} />} title="No screens yet" command={`walkie projects screen ${prefix} ./screenshot.png --title "Home" --group "Site" --status works --about "The home page."`}>
          <p>Screens are pictures of what the product looks like today, grouped by who uses them, each with a line about what it shows and whether it works. The team's agents add them from a terminal; they appear here.</p>
        </EmptyState>
      </>
    );
  }
  return (
    <>
      {notice}
      <nav className="spage-index" aria-label="Screens by group">
        {screens.groups.map((g) => (
          <a key={g.id} href={hrefFor({ view: "projects", channel, page: true, group: g.id })} aria-current={group === g.id ? "location" : undefined}
            onClick={(e) => { e.preventDefault(); navigate({ view: "projects", channel, page: true, group: g.id }); scrollToGroup(g.id); }}>
            {g.name}<span className="spage-count">{g.screens.length}<span className="sr-only"> screen{g.screens.length === 1 ? "" : "s"}</span></span>
          </a>
        ))}
      </nav>
      {screens.groups.map((g) => <Group key={g.id} channel={channel} group={g} onOpen={(s, el, image) => { from.current = el; setOpen({ screen: s, image }); }} />)}
      <Enlarged channel={channel} screen={open?.screen ?? null} image={open?.image} onClose={() => { setOpen(null); from.current?.focus(); }} />
    </>
  );
}
