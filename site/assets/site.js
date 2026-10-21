// Shared site controls: copy, pricing, refraction highlights, motion. No dependencies.
(function () {
  "use strict";
  var root = document.documentElement;
  var announcer = document.querySelector("[data-announce]");
  root.classList.add("js");
  var motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  var reduced = motionQuery.matches;

  function announce(msg) {
    if (!announcer) return;
    announcer.textContent = "";
    window.setTimeout(function () { announcer.textContent = msg; }, 30);
  }

  var nav = document.querySelector(".nav");
  function updateNav() { if (nav) nav.classList.toggle("is-scrolled", window.scrollY > 24); }
  updateNav();
  window.addEventListener("scroll", updateNav, { passive: true });

  var menuToggle = document.querySelector(".nav-menu-toggle");
  var mobileMenu = document.getElementById("mobile-menu");
  if (menuToggle && mobileMenu) {
    var closeMenu = function (restoreFocus) {
      mobileMenu.hidden = true;
      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.setAttribute("aria-label", "Open menu");
      menuToggle.textContent = "Menu";
      if (restoreFocus) menuToggle.focus();
    };
    menuToggle.addEventListener("click", function () {
      if (!mobileMenu.hidden) { closeMenu(true); return; }
      mobileMenu.hidden = false;
      menuToggle.setAttribute("aria-expanded", "true");
      menuToggle.setAttribute("aria-label", "Close menu");
      menuToggle.textContent = "Close";
      var firstLink = mobileMenu.querySelector("a");
      if (firstLink) firstLink.focus();
    });
    mobileMenu.addEventListener("click", function (event) {
      if (event.target.closest("a")) closeMenu(true);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !mobileMenu.hidden) { event.preventDefault(); closeMenu(true); }
    });
    window.matchMedia("(min-width: 901px)").addEventListener("change", function (event) {
      if (event.matches && !mobileMenu.hidden) closeMenu(false);
    });
  }

  var ticker = document.querySelector(".ticker");
  var tickerToggle = ticker && ticker.querySelector(".ticker-toggle");
  if (tickerToggle) tickerToggle.addEventListener("click", function () {
    var paused = ticker.classList.toggle("is-paused");
    tickerToggle.setAttribute("aria-pressed", paused ? "true" : "false");
    tickerToggle.setAttribute("aria-label", paused ? "Play example activity" : "Pause example activity");
    tickerToggle.textContent = paused ? "Play" : "Pause";
  });

  // Activate refraction only when the browser recognizes the filter form.
  if (window.CSS && CSS.supports("backdrop-filter", "url(#sq-liquid) blur(10px) saturate(1.7)")) root.classList.add("sq-refract");
  var highlightControls = document.getElementById("top") ? document.querySelectorAll(".glass") : [];
  highlightControls.forEach(function (el) {
    el.addEventListener("pointermove", function (e) {
      var r = el.getBoundingClientRect();
      el.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100).toFixed(1) + "%");
      el.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100).toFixed(1) + "%");
    });
  });
  document.querySelectorAll("[data-install-focus]").forEach(function (link) {
    link.addEventListener("click", function () {
      window.setTimeout(function () {
        var box = document.querySelector("#install .copy");
        if (box) box.focus({ preventScroll: true });
      }, reduced ? 0 : 500);
    });
  });

  // ---- copy ----
  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "copy-fallback";
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

  // ---- back from a cancelled Stripe Checkout (its cancel URL is /?checkout=cancelled#pricing) ----
  var cancelledNote = document.querySelector("[data-checkout-cancelled]");
  if (cancelledNote && new URLSearchParams(window.location.search).get("checkout") === "cancelled") cancelledNote.hidden = false;

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

  // Scroll reveals are one shot; browser and no-script views keep content visible.
  if ("IntersectionObserver" in window) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        revealObserver.unobserve(entry.target);
        if (!reduced && entry.boundingClientRect.top > window.innerHeight * 0.55) entry.target.classList.add("in");
        if (entry.target.classList.contains("mission-shot")) entry.target.classList.add("is-settled");
        entry.target.querySelectorAll(".draw-line").forEach(function (line) { line.classList.add("is-drawn"); });
        if (entry.target.classList.contains("draw-line")) entry.target.classList.add("is-drawn");
      });
    }, { threshold: 0.15 });
    document.querySelectorAll(".reveal, .draw-line, .mission-shot").forEach(function (el) { revealObserver.observe(el); });
  } else {
    document.querySelectorAll(".draw-line").forEach(function (line) { line.classList.add("is-drawn"); });
  }

  // The still is the default. The local video only loads when motion and data settings allow it.
  var video = document.querySelector("[data-hero-video]");
  if (video && !reduced && !(navigator.connection && navigator.connection.saveData) && "IntersectionObserver" in window) {
    var videoVisible = false;
    var videoObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        videoVisible = entry.isIntersecting;
        video.autoplay = videoVisible && !motionQuery.matches;
        if (!videoVisible || motionQuery.matches) { video.pause(); return; }
        if (video.dataset.ready === "yes") video.play().catch(function () {});
      });
    });
    videoObserver.observe(video);
    video.addEventListener("loadeddata", function () {
      video.dataset.ready = "yes";
      if (videoVisible && !motionQuery.matches) video.play().then(function () { video.classList.add("is-playing"); }).catch(function () {});
    }, { once: true });
    video.addEventListener("error", function () { video.classList.remove("is-playing"); });
    video.preload = "metadata";
    video.load();
    if (motionQuery.addEventListener) motionQuery.addEventListener("change", function (event) {
      if (event.matches) { video.pause(); video.classList.remove("is-playing"); }
    });
  }
})();
