// Landing page behaviour: theme toggle, copy buttons, pricing controls, scroll reveals. No dependencies.
(function () {
  "use strict";
  var root = document.documentElement;
  var announcer = document.querySelector("[data-announce]");
  var lightQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

  function announce(msg) {
    if (!announcer) return;
    announcer.textContent = "";
    window.setTimeout(function () { announcer.textContent = msg; }, 30);
  }

  // ---- theme ----
  function currentTheme() {
    var set = root.dataset.theme;
    if (set === "light" || set === "dark") return set;
    return lightQuery && lightQuery.matches ? "light" : "dark";
  }
  function syncThemeButtons() {
    var next = currentTheme() === "dark" ? "light" : "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
      btn.setAttribute("aria-label", "Switch to " + next + " theme");
    });
  }
  document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem("theme", next); } catch (e) { /* storage blocked: theme lasts for this page view */ }
      if (window.themePictures) window.themePictures();
      syncThemeButtons();
      announce(next === "dark" ? "Dark theme" : "Light theme");
    });
  });
  if (lightQuery && lightQuery.addEventListener) lightQuery.addEventListener("change", syncThemeButtons);
  syncThemeButtons();

  // ---- copy ----
  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
  }
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    var core = btn.closest(".install-core");
    var src = core && core.querySelector("[data-copy-src]");
    var label = btn.querySelector("[data-copy-label]");
    var timer = 0;
    btn.addEventListener("click", function () {
      if (!src) return;
      var text = src.textContent.trim();
      var attempt = navigator.clipboard && window.isSecureContext
        ? navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); })
        : fallbackCopy(text);
      attempt.then(function () {
        btn.classList.add("is-done");
        if (label) label.textContent = "Copied";
        announce(btn.getAttribute("data-copy") || "Install command copied");
      }, function () {
        if (label) label.textContent = "Select and copy";
        announce("Copy failed. Select the command and copy it manually.");
      }).then(function () {
        window.clearTimeout(timer);
        timer = window.setTimeout(function () {
          btn.classList.remove("is-done");
          if (label) label.textContent = "Copy";
        }, 2200);
      });
    });
  });

  // ---- pricing: monthly/annual toggle, seat stepper, live checkout links ----
  var pricing = document.querySelector("[data-pricing]");
  if (pricing) {
    var PRICES = { team: { month: 12, year: 10 }, business: { month: 24, year: 20 } };
    var TEAM_MAX = 50;
    var SEATS_MAX = 10000;
    var interval = "month";
    var seatsInput = pricing.querySelector("[data-seats]");

    var clampSeats = function (raw) {
      var n = parseInt(raw, 10);
      if (!isFinite(n) || n < 1) return 1;
      return n > SEATS_MAX ? SEATS_MAX : n;
    };
    var money = function (n) { return "$" + n.toLocaleString("en-US"); };
    var people = function (n) { return n === 1 ? "1 person" : n.toLocaleString("en-US") + " people"; };

    var render = function () {
      var n = clampSeats(seatsInput ? seatsInput.value : "5");
      pricing.querySelectorAll("[data-interval]").forEach(function (b) {
        var on = b.getAttribute("data-interval") === interval;
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.setAttribute("tabindex", on ? "0" : "-1"); // radio group: one tab stop, arrows move within it
      });
      pricing.querySelectorAll("[data-price]").forEach(function (el) {
        el.textContent = "$" + el.getAttribute("data-" + interval);
      });
      pricing.querySelectorAll("[data-billed]").forEach(function (el) {
        el.textContent = el.getAttribute("data-" + interval + "-text");
      });
      ["team", "business"].forEach(function (plan) {
        var link = pricing.querySelector('[data-buy="' + plan + '"]');
        var total = pricing.querySelector('[data-total="' + plan + '"]');
        var unit = PRICES[plan][interval];
        var over = plan === "team" && n > TEAM_MAX;
        if (link) {
          link.href = "/api/checkout?plan=" + plan + "&interval=" + interval + "&seats=" + n;
          if (over) { link.setAttribute("aria-disabled", "true"); link.setAttribute("tabindex", "-1"); }
          else { link.removeAttribute("aria-disabled"); link.removeAttribute("tabindex"); }
        }
        if (!total) return;
        total.classList.toggle("warn", over);
        if (over) total.textContent = "Team covers up to 50 people. For more, choose Business.";
        else if (interval === "month") total.textContent = people(n) + " × " + money(unit) + " = " + money(n * unit) + " / month";
        else total.textContent = people(n) + " × " + money(unit * 12) + " = " + money(n * unit * 12) + " / year";
      });
    };

    var radios = Array.prototype.slice.call(pricing.querySelectorAll("[data-interval]"));
    var choose = function (b) {
      interval = b.getAttribute("data-interval") === "year" ? "year" : "month";
      render();
      announce(interval === "year" ? "Showing annual prices" : "Showing monthly prices");
    };
    radios.forEach(function (b, i) {
      b.addEventListener("click", function () { choose(b); });
      b.addEventListener("keydown", function (e) {
        var step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        var next = radios[(i + step + radios.length) % radios.length];
        choose(next);
        next.focus();
      });
    });
    pricing.querySelectorAll("[data-seat-step]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!seatsInput) return;
        seatsInput.value = String(clampSeats(clampSeats(seatsInput.value) + Number(b.getAttribute("data-seat-step"))));
        render();
      });
    });
    if (seatsInput) {
      seatsInput.addEventListener("input", render);
      seatsInput.addEventListener("change", function () { seatsInput.value = String(clampSeats(seatsInput.value)); render(); });
    }
    render();
  }

  // ---- reveals ----
  // Content is visible from the start. An element that is still below the fold gets .in just before it scrolls
  // into view and rises in once; anything already on screen, or scrolled past quickly, is left as it is.
  var items = document.querySelectorAll(".reveal");
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !("IntersectionObserver" in window)) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      io.unobserve(entry.target);
      if (entry.boundingClientRect.top >= window.innerHeight) entry.target.classList.add("in");
    });
  }, { rootMargin: "0px 0px 20% 0px", threshold: 0 });
  items.forEach(function (el) { io.observe(el); });
})();
