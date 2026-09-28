// The saved theme, applied before the stylesheet paints (an external file: pages under a strict CSP allow no inline script).
(function () {
  var d = document.documentElement;
  d.classList.add("js");
  try { var t = localStorage.getItem("theme"); if (t === "light" || t === "dark") d.dataset.theme = t; } catch (e) { /* storage blocked */ }
})();
