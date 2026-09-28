// Welcome page after checkout: fetches /api/license?session_id=… and shows the activation code (once)
// with the one command that activates it. States: loading, processing (409, retried), ready, shown
// (410: already revealed, or the link is older than 24 h), unconfigured (503), inactive (402), error.
// No dependencies; the CLI command name comes from the page (data-cli).
(function () {
  "use strict";
  var root = document.querySelector("[data-welcome]");
  if (!root) return;
  var cli = root.getAttribute("data-cli") || "";
  var RETRY_DELAYS_MS = [2000, 3000, 5000, 8000, 13000, 21000];
  var attempt = 0;
  var timer = 0;

  function show(name) {
    root.querySelectorAll("[data-state]").forEach(function (el) {
      el.classList.toggle("is-on", el.getAttribute("data-state") === name);
    });
    var heading = root.querySelector('[data-state="' + name + '"] h1');
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      try { heading.focus({ preventScroll: true }); } catch (e) { heading.focus(); }
    }
  }

  function field(name, text) {
    root.querySelectorAll('[data-field="' + name + '"]').forEach(function (el) { el.textContent = text; });
  }

  function sessionId() {
    try { return new URLSearchParams(window.location.search).get("session_id") || ""; } catch (e) { return ""; }
  }

  function fail(message) {
    field("error", message);
    show("error");
  }

  function formatDate(ms) {
    try {
      return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } catch (e) {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  function ready(data) {
    var plan = data.plan === "business" ? "Business" : "Team";
    var seats = Number(data.seats) || 1;
    field("plan", plan);
    field("seats", String(seats));
    field("seats-label", seats === 1 ? "seat" : "seats");
    field("interval", data.interval === "year" ? "annually" : "monthly");
    field("expires", formatDate(Number(data.expires_at)));
    field("command", cli + " license activate " + data.code);
    show("ready");
  }

  function load() {
    window.clearTimeout(timer);
    var sid = sessionId();
    if (!/^cs_[A-Za-z0-9_]{1,250}$/.test(sid)) {
      fail("This link has no checkout session in it. Open the link from your Stripe receipt, or go back to pricing.");
      return;
    }
    fetch("/api/license?session_id=" + encodeURIComponent(sid), { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body || {} }; });
      })
      .then(function (r) {
        if (r.status === 200 && typeof r.body.code === "string" && r.body.code) { ready(r.body); return; }
        if (r.status === 410) { show("shown"); return; }
        if (r.status === 503) { show("unconfigured"); return; }
        if (r.status === 402) { show("inactive"); return; }
        if (r.status === 409) {
          if (attempt < RETRY_DELAYS_MS.length) {
            var wait = RETRY_DELAYS_MS[attempt++];
            var note = root.querySelector("[data-retry-note]");
            if (note) note.textContent = "Checking again in " + Math.round(wait / 1000) + " seconds (attempt " + attempt + " of " + RETRY_DELAYS_MS.length + ").";
            show("processing");
            timer = window.setTimeout(load, wait);
            return;
          }
          fail("Stripe still hasn't confirmed the payment. It usually settles within a few minutes: try again shortly, and your activation code will be here.");
          return;
        }
        if (r.status === 404) { fail("We couldn't find that checkout session. Open the link from your Stripe receipt, or contact support."); return; }
        if (r.status === 400) { fail("This link's checkout session id isn't valid. Open the link from your Stripe receipt."); return; }
        fail("Something went wrong on our side. Your payment is safe; try again in a moment.");
      })
      .catch(function () {
        fail("We couldn't reach the server. Check your connection and try again.");
      });
  }

  var retry = root.querySelector("[data-retry]");
  if (retry) retry.addEventListener("click", function () { attempt = 0; show("loading"); load(); });
  load();
})();
