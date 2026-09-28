// "Add a machine" page (/join#<code>): an owner sent a teammate a link whose #fragment holds a one-time invite code
// (and the team's release, "&v=v1.2.3"). Browsers never send the fragment to a server; this page reads it, removes
// it from the address bar and history entry at once, and shows the install command to run on the new machine.
// It makes no network request of any kind (the page's CSP is connect-src 'none'), stores nothing, and never puts
// the code anywhere but the command on screen. The install URL comes from the page (data-install).
// States: ready, expired, invalid (not a code), missing (no fragment: opened without one, or reloaded after reading).
(function (root) {
  "use strict";

  var PREFIX = "wk1";
  var CODE_RE = /^wk1[A-Za-z0-9_-]{38,297}$/; // 41-300 characters, base64url after the prefix
  var TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/; // a release tag the installer accepts
  var HANDLE_RE = /^[a-z][a-z0-9-]{0,23}$/;
  var ROLES = ["owner", "member", "observer"];
  // v(1) team(8) authority(32) issuer(8) secret(16) expiry(4) position(4) role(1) handle-length(1) handle …
  var EXPIRY_AT = 65;
  var ROLE_AT = 73;
  var HANDLE_LEN_AT = 74;

  /**
   * "#<code>", "#<code>&v=<tag>", "…&a=1" → { code, tag, agents } or { error: "missing" | "invalid" }. `a=1`: the team's
   * build asks "may your team start agents here?" during setup (the minting daemon hosts seats). Unknown params are ignored.
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
    for (var i = 1; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (kv[0] === "v" && TAG_RE.test(kv[1] || "")) tag = kv[1];
      if (kv[0] === "a" && kv[1] === "1") agents = true;
    }
    if (!CODE_RE.test(code)) return { error: "invalid" };
    return { code: code, tag: tag, agents: agents };
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

  function command(installUrl, code, tag) {
    return "curl -fsSL " + installUrl + " | " + (tag ? "WALKIE_VERSION=" + tag + " " : "") + "sh -s -- --invite " + code;
  }

  var FIELDS = ["handle", "expires", "command", "version"];

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
    var field = function (name, text) {
      var els = page.querySelectorAll('[data-field="' + name + '"]');
      for (var i = 0; i < els.length; i++) els[i].textContent = text;
    };
    for (var f = 0; f < FIELDS.length; f++) field(FIELDS[f], "");
    var consent = page.querySelectorAll("[data-team-agents]");
    for (var k = 0; k < consent.length; k++) consent[k].hidden = !(state === "ready" && parsed.agents);
    if (info) {
      field("handle", "@" + info.handle);
      field("expires", formatDate(info.expiresAt));
    }
    if (state === "ready") {
      field("command", command(page.getAttribute("data-install") || "", parsed.code, parsed.tag));
      field("version", parsed.tag ? "Installs " + parsed.tag + ", the release your team runs." : "Installs the latest release.");
    }
    var states = page.querySelectorAll("[data-state]");
    for (var i = 0; i < states.length; i++) states[i].classList.toggle("is-on", states[i].getAttribute("data-state") === state);
    return state;
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
    var again = function () { run({ window: win, document: doc, now: clock() }); };
    win.addEventListener("hashchange", function () { if (win.location.hash) again(); });
    win.addEventListener("popstate", again);
    again();
  }

  var api = { parseFragment: parseFragment, describe: describe, command: command, run: run, start: start };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else if (root && root.document) start(root, root.document, Date.now);
})(typeof window !== "undefined" ? window : null);
