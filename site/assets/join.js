// "Add a machine" page (/join#<code>): an owner sent a teammate a link whose #fragment holds a one-time invite code
// (and the team's release, "&v=v1.2.3"). Browsers never send the fragment to a server; this page reads it, removes
// it from the address bar and history entry at once, and offers the macOS package plus a terminal fallback.
// It makes no network request of any kind (the page's CSP is connect-src 'none'), stores nothing, and never puts
// the code anywhere but the local deep link and the fallback command on screen. The install URL comes from the page.
// An owner's SSH authorization rides in the same fragment ("&ssh=<packet>"): it is held in memory only, goes only into
// that same local deep link (when seats are allowed) and the fallback command's `--owner-ssh`, and leaves with the fragment.
// States: ready, expired, invalid (not a code), missing (no fragment: opened without one, or reloaded after reading).
(function (root) {
  "use strict";

  var PREFIX = "wk1";
  var CODE_RE = /^wk1[A-Za-z0-9_-]{38,297}$/; // 41-300 characters, base64url after the prefix
  var TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/; // a release tag the installer accepts
  var HANDLE_RE = /^[a-z][a-z0-9-]{0,23}$/;
  var SSH_RE = /^[A-Za-z0-9_-]{1,1200}$/; // an owner SSH authorization: base64url, bounded as the installers bound it
  var ROLES = ["owner", "member", "observer"];
  // v(1) team(8) authority(32) issuer(8) secret(16) expiry(4) position(4) role(1) handle-length(1) handle …
  var EXPIRY_AT = 65;
  var ROLE_AT = 73;
  var HANDLE_LEN_AT = 74;

  /**
   * "#<code>", "#<code>&v=<tag>", "…&a=1", "…&ssh=<packet>" → { code, tag, agents[, ssh | sshDamaged] } or
   * { error: "missing" | "invalid" }. `a=1`: the team's build asks "may your team start agents here?" during setup (the
   * minting daemon hosts seats). `ssh`: the owner's SSH authorization, kept only if it is well-formed base64url of a
   * bounded length; a malformed or repeated one is dropped and flagged `sshDamaged`. Other unknown params are ignored.
   */
  function parseFragment(hash) {
    var raw = String(hash || "").replace(/^#/, "");
    try { raw = decodeURIComponent(raw); } catch (e) { return { error: "invalid" }; }
    raw = raw.replace(/\s+/g, ""); // a link wrapped by a mail client
    if (!raw) return { error: "missing" };
    var parts = raw.split("&");
    var code = parts[0];
    var tag = null;
    var agents = false;
    var ssh = null;
    var sshDamaged = false;
    for (var i = 1; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (kv[0] === "v" && TAG_RE.test(kv[1] || "")) tag = kv[1];
      if (kv[0] === "a" && kv[1] === "1") agents = true;
      if (kv[0] === "ssh") {
        if (ssh !== null || sshDamaged || kv.length !== 2 || !SSH_RE.test(kv[1])) { ssh = null; sshDamaged = true; }
        else ssh = kv[1];
      }
    }
    if (!CODE_RE.test(code)) return { error: "invalid" };
    var parsed = { code: code, tag: tag, agents: agents };
    if (ssh !== null) parsed.ssh = ssh;
    if (sshDamaged) parsed.sshDamaged = true;
    return parsed;
  }

  function bytesOf(b64url) {
    var b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var bin = atob(b64);
    var out = [];
    for (var i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
    return out;
  }

  /** What the code says about itself (unverified: only the team's roster authority can check it). Null if malformed. */
  function describe(code) {
    var b;
    try { b = bytesOf(code.slice(PREFIX.length)); } catch (e) { return null; }
    if (b.length < HANDLE_LEN_AT + 1 + 64 || b[0] !== 1) return null;
    var expiry = ((b[EXPIRY_AT] << 24) >>> 0) + (b[EXPIRY_AT + 1] << 16) + (b[EXPIRY_AT + 2] << 8) + b[EXPIRY_AT + 3];
    var role = ROLES[b[ROLE_AT]];
    var len = b[HANDLE_LEN_AT];
    if (!role || b.length < HANDLE_LEN_AT + 1 + len + 1 + 64) return null;
    var handle = "";
    for (var i = 0; i < len; i++) handle += String.fromCharCode(b[HANDLE_LEN_AT + 1 + i]);
    if (!HANDLE_RE.test(handle)) return null;
    return { handle: handle, role: role, expiresAt: expiry * 1000 };
  }

  function command(installUrl, code, tag, ssh) {
    return "curl -fsSL " + installUrl + " | " + (tag ? "WALKIE_MIN_VERSION=" + tag + " " : "") + "sh -s -- --invite " + code + " --company-machine"
      + (ssh && SSH_RE.test(ssh) ? " --owner-ssh " + ssh : "");
  }

  // ---- local seat consent ---------------------------------------------------------------------
  // The signed package has no invite. The selected choice travels only through the local app handoff.

  var SEAT_MAX_DEFAULT = 4;
  var SEAT_MAX_MIN = 1;
  var SEAT_MAX_MAX = 64; // the CLI's "seats allow --max" ceiling (protocol/seats.ts MAX_CONCURRENT_LIMIT)

  /** A typed seat maximum, clamped to what the CLI's `seats allow --max` accepts; empty or non-numeric is the default. */
  function clampSeatMax(raw) {
    var s = String(raw === undefined || raw === null ? "" : raw).trim();
    var n = Math.trunc(Number(s));
    if (s === "" || !isFinite(n)) return SEAT_MAX_DEFAULT;
    return Math.min(SEAT_MAX_MAX, Math.max(SEAT_MAX_MIN, n));
  }

  /**
   * Wires the consent controls once, at start: choosing "yes" reveals the seat maximum, and an out-of-range or
   * non-numeric maximum is clamped back on change (not on every keystroke, so the card's aria-live region stays
   * quiet while typing).
   */
  function bindConsent(page) {
    var choices = page.querySelectorAll("[data-consent-choice]");
    var maxBlock = page.querySelector("[data-consent-max]");
    var maxInput = page.querySelector("[data-consent-max-input]");
    if (!choices.length || !maxBlock || !maxInput) return;
    var cap = page.querySelector('[data-field="seat-cap"]');
    var sync = function () {
      var yes = false;
      for (var i = 0; i < choices.length; i++) {
        if (choices[i].checked && choices[i].getAttribute("data-consent-choice") === "yes") yes = true;
      }
      maxBlock.hidden = !yes;
      if (cap) cap.textContent = yes ? String(clampSeatMax(maxInput.value)) : "0";
    };
    for (var i = 0; i < choices.length; i++) choices[i].addEventListener("change", sync);
    maxInput.addEventListener("change", function () { maxInput.value = String(clampSeatMax(maxInput.value)); sync(); });
  }

  /** A previous link's answer never survives into this one. */
  function resetConsent(page) {
    var choices = page.querySelectorAll("[data-consent-choice]");
    for (var i = 0; i < choices.length; i++) choices[i].checked = false;
    var maxInput = page.querySelector("[data-consent-max-input]");
    if (maxInput) maxInput.value = String(SEAT_MAX_DEFAULT);
    var maxBlock = page.querySelector("[data-consent-max]");
    if (maxBlock) maxBlock.hidden = true;
  }

  function consentChosen(page) {
    var choices = page.querySelectorAll("[data-consent-choice]");
    for (var i = 0; i < choices.length; i++) if (choices[i].checked && !choices[i].disabled) return true;
    return false;
  }

  /** The local deep link: the invite, the seat choice, the release and, only when seats are allowed, the owner's SSH authorization. */
  function handoff(code, yes, max, tag, ssh) {
    if (!CODE_RE.test(code)) throw new Error("invalid invite");
    return "wal" + "kie-join://join#" + code + "&seats=" + (yes ? "yes&max=" + clampSeatMax(max) : "no&max=0") + (tag && TAG_RE.test(tag) ? "&v=" + tag : "")
      + (yes && ssh && SSH_RE.test(ssh) ? "&ssh=" + ssh : "");
  }

  var FIELDS = ["handle", "expires", "command", "version", "seat-cap"];
  var pendingCode = null;
  var pendingTag = null;
  var pendingSsh = null; // memory only: never in a URL query, storage, a log or history
  var downloadStarted = 0;

  function bindInstall(page, win) {
    var button = page.querySelector("[data-join-package]");
    var open = page.querySelector("[data-join-open]");
    if (!button || !open) return;
    var available = page.getAttribute("data-package-available") === "true";
    button.hidden = !available;
    var instructions = page.querySelector("[data-package-instructions]");
    if (instructions) instructions.hidden = !available;
    var fallback = page.querySelector("[data-terminal-fallback]");
    if (fallback && !available) fallback.open = true;
    var openApp = function () {
      if (!pendingCode || !consentChosen(page)) return;
      var yes = page.querySelector('[data-consent-choice="yes"]');
      var max = page.querySelector("[data-consent-max-input]");
      win.location.assign(handoff(pendingCode, !!(yes && yes.checked), max && max.value, pendingTag, pendingSsh));
    };
    button.addEventListener("click", function () {
      if (!pendingCode || !available || !consentChosen(page)) return;
      // The package URL is fixed; the bearer code is never appended to a request.
      var link = page.querySelector("[data-package-url]");
      if (link) link.click();
      downloadStarted = Date.now();
      open.hidden = false;
    });
    open.addEventListener("click", openApp);
    win.addEventListener("focus", function () {
      // Returning from the package installer is the browser's only local signal that the app may be ready.
      if (downloadStarted && Date.now() - downloadStarted > 1000) {
        downloadStarted = 0;
        openApp();
      }
    });
  }

  /**
   * Reads and strips the fragment, then shows the matching state; every field is cleared first, so nothing of a
   * previous link survives into this one. `env` = { window, document, now }. Runs at load and again on every
   * hashchange/popstate (a second link opened in the same tab, back/forward).
   */
  function run(env) {
    var win = env.window;
    var doc = env.document;
    var page = doc.querySelector("[data-join]");
    if (!page) return null;
    var hash = win.location.hash;
    if (hash) {
      // Out of the address bar and this history entry before anything else runs (a screen share, a bookmark).
      try { win.history.replaceState(null, "", win.location.pathname + win.location.search); } catch (e) { win.location.hash = ""; }
    }
    var parsed = parseFragment(hash);
    var info = parsed.code ? describe(parsed.code) : null;
    var state = parsed.error || (!info ? "invalid" : info.expiresAt <= env.now ? "expired" : "ready");
    pendingCode = state === "ready" ? parsed.code : null;
    pendingTag = state === "ready" ? parsed.tag : null;
    pendingSsh = state === "ready" && parsed.ssh ? parsed.ssh : null;
    downloadStarted = 0;
    var open = page.querySelector("[data-join-open]");
    if (open) open.hidden = true;
    var field = function (name, text) {
      var els = page.querySelectorAll('[data-field="' + name + '"]');
      for (var i = 0; i < els.length; i++) els[i].textContent = text;
    };
    for (var f = 0; f < FIELDS.length; f++) field(FIELDS[f], "");
    var consent = page.querySelectorAll("[data-team-agents]");
    for (var k = 0; k < consent.length; k++) consent[k].hidden = state !== "ready";
    // Owner SSH: described when the link carries a usable authorization, said plainly when it carried a damaged one.
    setHidden(page, "[data-ssh-consent]", !pendingSsh);
    setHidden(page, "[data-ssh-command-note]", !pendingSsh);
    setHidden(page, "[data-ssh-damaged]", !(state === "ready" && parsed.sshDamaged));
    resetConsent(page);
    var yesChoice = page.querySelector('[data-consent-choice="yes"]');
    var noChoice = page.querySelector('[data-consent-choice="no"]');
    if (yesChoice) yesChoice.disabled = !!(info && info.role === "observer");
    if (info && info.role === "observer" && noChoice && yesChoice) {
      yesChoice.checked = false;
      noChoice.checked = false;
      var maxForObserver = page.querySelector("[data-consent-max]");
      if (maxForObserver) maxForObserver.hidden = true;
    }
    if (info) {
      field("handle", "@" + info.handle);
      field("expires", formatDate(info.expiresAt));
    }
    if (state === "ready") {
      field("command", command(page.getAttribute("data-install") || "", parsed.code, parsed.tag, pendingSsh));
      field("seat-cap", "0");
      field("version", parsed.tag ? "Installs the newest compatible release, at least " + parsed.tag + "." : "Installs the default release.");
    }
    var states = page.querySelectorAll("[data-state]");
    for (var i = 0; i < states.length; i++) states[i].classList.toggle("is-on", states[i].getAttribute("data-state") === state);
    return state;
  }

  function setHidden(page, selector, hidden) {
    var els = page.querySelectorAll(selector);
    for (var i = 0; i < els.length; i++) els[i].hidden = hidden;
  }

  function formatDate(ms) {
    try {
      return new Date(ms).toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) {
      return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
    }
  }

  /**
   * Runs now, and again whenever the fragment changes within this document (another link, back/forward). Browsers
   * fire popstate then hashchange for one fragment navigation: the first reads and strips the code, so a hashchange
   * that finds no fragment left is that same navigation and is ignored. A popstate with no fragment (back/forward
   * between stripped entries) shows "missing", so no earlier link's command stays on screen.
   */
  function start(win, doc, clock) {
    var page = doc.querySelector("[data-join]");
    if (page) { bindConsent(page); bindInstall(page, win); }
    var again = function () { run({ window: win, document: doc, now: clock() }); };
    win.addEventListener("hashchange", function () { if (win.location.hash) again(); });
    win.addEventListener("popstate", again);
    again();
  }

  var api = {
    parseFragment: parseFragment, describe: describe, command: command, handoff: handoff, run: run, start: start,
    clampSeatMax: clampSeatMax, bindConsent: bindConsent, SEAT_MAX_DEFAULT: SEAT_MAX_DEFAULT, SEAT_MAX_MIN: SEAT_MAX_MIN, SEAT_MAX_MAX: SEAT_MAX_MAX,
  };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else if (root && root.document) start(root, root.document, Date.now);
})(typeof window !== "undefined" ? window : null);
