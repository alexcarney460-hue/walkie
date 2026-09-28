// Walkie on your phone (WALKIE-PWA-1): the phone app. A static page (site/m.html); everything private travels over
// the end-to-end encrypted link to the owner's computer (src/mobile/client.ts). Pairing: the QR code opens
// /m#pair=<room>.<secret> (the pairing code); it is read from the fragment (never sent to a server) and removed from
// the address bar.
import { LinkError, MobileLink } from "../client.ts";
import { hkdfKey, pairingKeys, PAIRING_CODE_RE, unb64u } from "../crypto.ts";
import type { PairInfo } from "../wire.ts";
import { h, isIOS, replace, standalone } from "./dom.ts";
import { Mission } from "./mission.ts";
import { forgetDevice, loadDevice, saveDevice, type StoredDevice } from "./store.ts";

const RELAY = "wss://walkie-relay.fly.dev";
const root = document.getElementById("app") as HTMLElement;

interface Fragment { secret: string | null; relay: string }

/** A development relay is honoured only when this page itself is served from loopback. */
function devRelay(v: string | null): string | null {
  if (!v || !["localhost", "127.0.0.1"].includes(location.hostname)) return null;
  try {
    const u = new URL(v);
    return u.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(u.hostname) ? u.origin : null;
  } catch { return null; }
}

function readFragment(): Fragment {
  const p = new URLSearchParams(location.hash.slice(1));
  const secret = p.get("pair");
  const out = { secret: secret && PAIRING_CODE_RE.test(secret) ? secret : null, relay: devRelay(p.get("relay")) ?? RELAY };
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return out;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Phone";
}

// ---- install ---------------------------------------------------------------------------------------------------

interface InstallPrompt extends Event { prompt(): Promise<void> }
let installPrompt: InstallPrompt | null = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e as InstallPrompt; });

function dismissed(): boolean { try { return localStorage.getItem("walkie.install.dismissed") === "1"; } catch { return false; } }

function installBanner(): HTMLElement | null {
  if (standalone() || dismissed()) return null;
  const close = h("button", { type: "button", class: "btn-ghost small", "aria-label": "Dismiss", onclick: () => {
    try { localStorage.setItem("walkie.install.dismissed", "1"); } catch { /* not kept */ }
    banner.remove();
  } }, "Not now");
  const banner: HTMLElement = isIOS()
    ? h("aside", { class: "banner" }, h("p", {}, "Add Walkie to your Home Screen: tap ", h("strong", {}, "Share"), ", then ", h("strong", {}, "Add to Home Screen"), "."), close)
    : installPrompt
      ? h("aside", { class: "banner" }, h("p", {}, "Install Walkie on this phone."),
        h("button", { type: "button", class: "btn small", onclick: async () => { await installPrompt?.prompt(); installPrompt = null; banner.remove(); } }, "Install"), close)
      : h("aside", { class: "banner" }, h("p", {}, "Install Walkie: open the browser menu and choose ", h("strong", {}, "Install app"), " or ", h("strong", {}, "Add to Home screen"), "."), close);
  return banner;
}

// ---- screens -----------------------------------------------------------------------------------------------------

function screen(title: string, ...body: (Node | string | null)[]): void {
  replace(root, h("main", { class: "screen" }, h("div", { class: "brand" }, h("span", { class: "logo", "aria-hidden": "true" }), "Walkie"), h("h1", {}, title), ...body));
}

function busy(text: string): void {
  screen(text, h("div", { class: "spinner", role: "progressbar", "aria-label": text }));
}

function pairForm(message?: string, relay = RELAY): void {
  const input = h("input", { class: "input mono", placeholder: "Pairing code", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Pairing code" }) as HTMLInputElement;
  const go = () => {
    // The code alone, or the whole link pasted from the computer.
    const raw = input.value.trim();
    const p = new URLSearchParams(raw.includes("pair=") ? raw.slice(raw.indexOf("pair=")) : `pair=${raw}`);
    const v = p.get("pair") ?? "";
    if (!PAIRING_CODE_RE.test(v)) { input.focus(); input.setAttribute("aria-invalid", "true"); return; }
    void loadDevice().then((current) => pair(v, devRelay(p.get("relay")) ?? relay, current));
  };
  screen("Pair this phone",
    message ? h("p", { class: "alert", role: "alert" }, message) : null,
    h("p", { class: "lede" }, "On your computer, run ", h("code", {}, "walkie mobile pair"), " (or open the dashboard: Team → Devices → Pair a phone), then scan the QR code with this phone's camera."),
    h("p", { class: "lede" }, "Opened Walkie from your Home Screen? Paste the pairing code shown under the QR code:"),
    h("form", { class: "stack", onsubmit: (e: Event) => { e.preventDefault(); go(); } }, input, h("button", { class: "btn", type: "submit" }, "Pair")),
    h("p", { class: "muted small" }, "The code works once, for 10 minutes. The link to your computer is end-to-end encrypted: the relay in between can't read it."),
  );
}

/** iPhone Safari with a fresh QR code: install first (the Home Screen app has its own storage), or pair right here. */
function installFirst(secret: string, relay: string): void {
  const code = h("code", { class: "code mono" }, secret);
  const copy = h("button", { type: "button", class: "btn-ghost", onclick: async () => {
    try { await navigator.clipboard.writeText(secret); copy.textContent = "Copied"; } catch { copy.textContent = "Select and copy the code"; }
  } }, "Copy code");
  screen("Put Walkie on your Home Screen",
    h("ol", { class: "steps" },
      h("li", {}, "Copy this pairing code: ", code, " ", copy),
      h("li", {}, "Tap ", h("strong", {}, "Share"), ", then ", h("strong", {}, "Add to Home Screen"), "."),
      h("li", {}, "Open Walkie from your Home Screen and paste the code."),
    ),
    h("p", { class: "muted small" }, "The code works once, for 10 minutes."),
    h("button", { type: "button", class: "btn-ghost", onclick: () => void loadDevice().then((current) => pair(secret, relay, current)) }, "Use Walkie in Safari instead"),
  );
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

/** After this many failed reconnects with "no computer holds the room", say the phone may have been signed out. */
const UNPAIRED_HINT_AFTER = 5;

function offline(message: string, device: StoredDevice, code: number | null = null): void {
  if (retryTimer) clearTimeout(retryTimer);
  const wait = Math.min(60, 2 ** attempt++ * 2);
  const maybeUnpaired = code === 4404 && attempt >= UNPAIRED_HINT_AFTER;
  screen("Your computer is offline or unreachable",
    h("p", { class: "lede" }, message),
    maybeUnpaired
      ? h("p", { class: "alert", role: "alert" }, "This phone may have been signed out on your computer (a phone signed out while it was away can't be told). If so, tap Unpair and pair it again.")
      : null,
    h("p", { class: "muted small" }, `Trying again in ${wait} s. Walkie on your phone works while your computer is on, awake and online.`),
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn", onclick: () => void connect(device) }, "Try now"),
      h("button", { type: "button", class: "btn-ghost", onclick: () => void unpair(null) }, "Unpair this phone"),
    ),
  );
  retryTimer = setTimeout(() => void connect(device), wait * 1000);
}

// ---- flows -------------------------------------------------------------------------------------------------------

let mission: Mission | null = null;
/** The one device link this page has open (a new pairing or a reconnect closes it first). */
let active: { link: MobileLink; device: StoredDevice } | null = null;
/** A pairing link in progress: owned by the same flow rules (a newer flow closes it). */
let pairingLink: MobileLink | null = null;

/** Bumped by every new flow (connect, pair): a connect that finishes after a newer flow began closes its own link. */
let flow = 0;

function closeActive(): void {
  flow += 1;
  if (retryTimer) clearTimeout(retryTimer);
  mission?.stop();
  mission = null;
  const a = active;
  active = null;
  if (a) { a.link.onClose = null; a.link.close(); }
  const p = pairingLink;
  pairingLink = null;
  p?.close();
}

function who(d: { team?: { name: string }; handle?: string; host?: string }): string {
  return `${d.team?.name ?? "a team"} as @${d.handle ?? "?"} on ${d.host ?? "a computer"}`;
}

/**
 * A pairing link: handshake, ask who is on the other end, and let the person confirm before anything is saved. An
 * existing pairing is replaced only on an explicit "Switch" (a link someone else made would show their team).
 */
async function pair(secret: string, relay: string, current: StoredDevice | null): Promise<void> {
  closeActive(); // "Keep" reconnects afresh; "Switch" must not leave the old device's link open
  const mine = flow;
  const stale = () => mine !== flow; // a newer flow (another pairing link, a reconnect) took over
  busy("Checking the pairing code…");
  let link: MobileLink;
  let info: PairInfo;
  try {
    const k = await pairingKeys(secret);
    if (stale()) return;
    link = await MobileLink.open({ relay, room: k.room, kid: "pair", psk: k.psk });
    if (stale()) { link.close(); return; }
    pairingLink = link;
    info = await link.info();
    if (stale()) return; // closeActive closed the link
  } catch (err) {
    if (stale()) return;
    pairForm(err instanceof LinkError ? err.message : "Pairing failed. Show a new code on your computer and try again.", relay);
    return;
  }
  const confirm = async () => {
    if (stale()) return;
    busy("Pairing with your computer…");
    try {
      const reg = await link.register(deviceLabel());
      if (stale()) return;
      pairingLink = null;
      link.close();
      const device: StoredDevice = {
        id: reg.device.id, name: reg.device.name, room: reg.room, relay, key: await hkdfKey(unb64u(reg.key)), expires_at: reg.expires_at,
        team: reg.team, handle: reg.handle, host: reg.host,
      };
      if (stale()) return;
      const kept = await saveDevice(device);
      if (stale()) return;
      await connect(device, kept ? null : "This browser won't keep the pairing after you close it (private browsing?).");
    } catch (err) {
      if (stale()) return;
      pairForm(err instanceof LinkError ? err.message : "Pairing failed. Show a new code on your computer and try again.", relay);
    }
  };
  const cancel = () => {
    if (stale()) return;
    pairingLink = null;
    link.close();
    if (current) void connect(current); else pairForm("Pairing cancelled. Nothing was saved.", relay);
  };
  screen(current ? "Switch this phone's pairing?" : "Pair this phone?",
    h("p", { class: "lede" }, "Pair with ", h("strong", {}, info.team.name), " as ", h("strong", { class: "mono" }, `@${info.handle}`), " on ", h("strong", { class: "mono" }, info.host), "?"),
    current ? h("p", { class: "alert", role: "alert" }, `This phone is paired with ${who(current)}. Switching replaces that pairing on this phone.`) : null,
    h("p", { class: "muted small" }, "Only continue if you just made this code on your own computer. A code someone sent you would pair this phone with their team instead."),
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn", onclick: () => void confirm() }, current ? "Switch" : "Pair"),
      h("button", { type: "button", class: "btn-ghost", onclick: cancel }, current ? "Keep the current pairing" : "Cancel"),
    ),
  );
}

async function connect(device: StoredDevice, note: string | null = null): Promise<void> {
  closeActive();
  const mine = flow;
  busy("Connecting to your computer…");
  let link: MobileLink;
  try {
    link = await MobileLink.open({ relay: device.relay, room: device.room, kid: `d:${device.id}`, psk: device.key });
  } catch (err) {
    if (mine !== flow) return; // a newer flow owns the screen
    // Only the daemon's encrypted "revoked" message makes the phone forget its key: a close code (4403 included) can
    // come from the relay or a timeout, so it only means "not now".
    const e = err instanceof LinkError ? err : new LinkError("Couldn't connect.", null);
    offline(e.message, device, e.code);
    return;
  }
  if (mine !== flow) { link.close(); return; } // a pairing (or another connect) started meanwhile: don't leak this link
  attempt = 0;
  link.watch();
  active = { link, device };
  link.onClose = (e) => {
    if (active?.link !== link) return; // an older link: its device isn't the one shown
    active = null;
    mission?.stop();
    mission = null;
    if (e.revoked) {
      // Forget only this link's own device (a newer pairing saved meanwhile stays).
      void loadDevice().then(async (stored) => { if (stored?.id === device.id) await forgetDevice(); pairForm(e.message, device.relay); });
      return;
    }
    offline(e.message, device, e.code);
  };
  mission = new Mission(link, { settings: () => settings(link, device) }, installBanner());
  replace(root, mission.element);
  try {
    await mission.start();
  } catch {
    link.close();
    return;
  }
  if (note) mission?.notice(note);
}

function settings(link: MobileLink, device: StoredDevice): void {
  const dialog = h("dialog", { class: "sheet", "aria-label": "Settings" },
    h("h2", {}, "This phone"),
    h("p", {}, h("strong", {}, device.name), h("span", { class: "muted" }, ` · device ${device.id}`)),
    h("p", { class: "muted small" }, `Paired until ${new Date(device.expires_at).toLocaleDateString()} (or 30 days without use). The link is end-to-end encrypted; only your computer can read it.`),
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn-danger", onclick: () => { dialog.close(); void unpair(link); } }, "Unpair this phone"),
      h("button", { type: "button", class: "btn-ghost", onclick: () => dialog.close() }, "Close"),
    ),
  ) as HTMLDialogElement;
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

async function unpair(link: MobileLink | null): Promise<void> {
  if (link) { link.onClose = null; await link.unpair(); }
  closeActive();
  await forgetDevice();
  pairForm("This phone is unpaired.");
}

async function boot(): Promise<void> {
  if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("/m-sw.js", { scope: "/m" }).catch(() => undefined);
  const frag = readFragment();
  if (frag.secret) closeActive();
  const device = await loadDevice();
  if (frag.secret) {
    if (isIOS() && !standalone()) { installFirst(frag.secret, frag.relay); return; }
    await pair(frag.secret, frag.relay, device && device.expires_at > Date.now() ? device : null);
    return;
  }
  if (device && device.expires_at > Date.now()) { await connect(device); return; }
  if (device) await forgetDevice();
  pairForm(undefined, frag.relay);
}

// A pairing link opened while the app is already showing (same page, new fragment) starts over with it.
window.addEventListener("hashchange", () => { if (/[#&]pair=/.test(location.hash)) void boot(); });
void boot();
