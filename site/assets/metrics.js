// First-party loader for Vercel Web Analytics (cookieless, served from this origin) plus a few click events.
// Every URL sent is reduced to origin + path + utm_*/ref query params: no fragment (join links carry a secret
// there), no session_id (the welcome page), nothing typed by the visitor.
(function () {
  "use strict";
  if (window.va) return;
  window.va = function () { (window.vaq = window.vaq || []).push(arguments); };
  var KEEP = /^(utm_(source|medium|campaign|term|content)|ref)$/;
  function clean(raw) {
    try {
      var u = new URL(raw, window.location.href);
      var q = new URLSearchParams();
      u.searchParams.forEach(function (v, k) { if (KEEP.test(k)) q.set(k, v.slice(0, 100)); });
      var s = q.toString();
      return u.origin + u.pathname + (s ? "?" + s : "");
    } catch (e) { return window.location.origin + window.location.pathname; }
  }
  window.va("beforeSend", function (event) { event.url = clean(event.url); return event; });
  function track(name, data) { window.va("event", { name: name, data: data || {} }); }
  var page = window.location.pathname.replace(/\.html$/, "") || "/";

  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("a, button") : null;
    if (!el) return;
    var buy = el.getAttribute("data-buy");
    if (buy) {
      var p = new URL(el.href, window.location.href).searchParams;
      track("buy_click", { plan: buy, interval: p.get("interval") || "month", seats: Number(p.get("seats") || 0) });
      return;
    }
    if (el.hasAttribute("data-copy")) {
      var core = el.closest(".install-core");
      var src = core && core.querySelector("[data-copy-src]");
      var field = (src && src.getAttribute("data-field")) || "install";
      if (field === "agent-prompt") track("copy_agent_prompt", { page: page });
      else track("copy_command", { page: page, field: field });
      return;
    }
    if (el.tagName === "A" && /^https:\/\/github\.com\//.test(el.href || "")) {
      track("github_click", { page: page, where: el.closest("footer") ? "footer" : el.closest("nav, .mobile-menu") ? "nav" : "body" });
    }
  }, true);

  // UTM breakdowns need the paid Web Analytics Plus tier, so campaign tags are also sent as one free custom event.
  var tags = {};
  new URLSearchParams(window.location.search).forEach(function (v, k) {
    var m = /^utm_(source|medium|campaign)$/.exec(k) || (k === "ref" ? [k, "ref"] : null);
    if (m && v) tags[m[1]] = v.slice(0, 60);
  });
  if (Object.keys(tags).length) { tags.page = page; track("utm_landing", tags); }

  // Back from Stripe Checkout: count the return (whether it was paid is read from Stripe, not from here).
  if (page === "/welcome" && /[?&]session_id=/.test(window.location.search)) track("checkout_return", {});
  // Back from a cancelled Checkout (cancel URL /?checkout=cancelled#pricing).
  if (page === "/" && new URLSearchParams(window.location.search).get("checkout") === "cancelled") track("checkout_cancelled", {});

  var s = document.createElement("script");
  s.src = "/_vercel/insights/script.js";
  s.defer = true;
  document.head.appendChild(s);
})();
